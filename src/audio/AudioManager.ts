import {
  DEFAULT_MUSIC_VOLUME, DEFAULT_SFX_VOLUME, loadSettings, updateSettings,
} from '../core/Settings';
import {
  BARS_PER_SECTION, Chord, LOOP_STEPS, MUSIC_BASE_GAIN, SFX_BASE_GAIN, STEPS_PER_BAR,
  StingerLoad, STINGER_WINDOW_SEC, TIER_MOTIF, busFullScale, chordAt, chordTones,
  degreeToSemitone, nextGridTime, noteHz, panForColumn, stingerScale, volumeToGain,
} from './Music';

/**
 * AudioManager — everything the player hears, synthesized with the Web Audio API.
 *
 * Signal chain:
 *   SFX voices ─┬→ sfxBus ─────────────┐
 *               └→ reverbSend ─┐       ├→ compressor → limiter → master → speakers
 *   Music layers ┬→ musicBus → lowpass ┤
 *                └→ reverbSend → convolver ┘
 *
 * The reverb is a ConvolverNode fed with a synthetic impulse response
 * (two seconds of decaying stereo noise), which is what gives the sounds
 * space and a "produced" feel without shipping any audio files.
 *
 * The music is a 16th-note step sequencer scheduled ahead on the audio clock.
 * It has an A section (Am F C G) and a B section (Am C G F) and reacts to the
 * game: tempo follows the timer drain, layers fade in with the streak, the
 * kick "pumps" the pads (sidechain), and a low-pass filter closes as time
 * runs out.
 *
 * The stingers play *with* that loop rather than over it: while the music is
 * running they are scheduled on the next sixteenth and pitched from the chord
 * sounding at that moment (see Music.ts, which owns all of that arithmetic).
 * Placement is the exception — it fires immediately, because a pluck that
 * arrives 80 ms after the finger does not feel like a placement.
 */

const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULE_AHEAD_SEC = 0.2;

/** A 3 dB dip, as the fraction of gain a duck removes */
const DUCK_3DB = 1 - Math.pow(10, -3 / 20);
/** How long a claim holds the music down. Long enough to hear, short enough not to sag. */
const CLAIM_DUCK_SECONDS = 0.2;
/** How far behind the claim its echo answers */
const ECHO_DELAY_SEC = 0.15;
/** How much quieter that answer is */
const ECHO_LEVEL = 0.4;

/**
 * Roughly what each stinger asks of the output, so simultaneous ones can be
 * shared out (see stingerScale). These are peak-sum estimates, not measured
 * levels: the cap only has to get the ordering and the scale right.
 */
const STINGER_WEIGHT = {
  claim: 0.55,
  survey: 0.45,
  tierUp: 0.4,
  newBest: 0.45,
  logo: 0.4,
} as const;

export class AudioManager {
  private sfxEnabled: boolean;
  private musicEnabled: boolean;
  private sfxVolume: number;
  private musicVolume: number;

  private ctx: AudioContext | null = null;
  /** The Web Audio API is missing or refused to build a graph: stay silent for good */
  private audioFailed = false;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private reverbSend: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  // Music layers
  private layerKick: GainNode | null = null;
  private layerBass: GainNode | null = null;
  private layerHat: GainNode | null = null;
  private layerArp: GainNode | null = null;
  private layerPad: GainNode | null = null;
  private layerSnare: GainNode | null = null;
  private sidechain: GainNode | null = null;
  private arpDelay: DelayNode | null = null;

  // Sequencer state
  private musicActive = false;
  private schedulerTimer: number | null = null;
  private nextStepTime = 0;
  private step = 0;
  private bpm = 100;
  private intensity = 0;
  private tension = 0;
  private wantsMusic = false;

  /** Stinger gains already booked, so a pile-up on one frame can be shared out */
  private stingerLoad: StingerLoad[] = [];
  /** The menu signature plays once a page load, on the gesture that unlocks audio */
  private logoJinglePlayed = false;
  /** Audio-clock time of the last volume-slider blip, for throttling */
  private lastPreviewTime = -1;

  constructor() {
    const s = loadSettings();
    this.sfxEnabled = s.sfx;
    this.musicEnabled = s.music;
    this.sfxVolume = s.sfxVolume;
    this.musicVolume = s.musicVolume;
  }

  // ── Context / graph ──

  unlock(): void {
    const ctx = this.getContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => { /* ignored */ });
  }

  private getContext(): AudioContext | null {
    if (this.audioFailed) return null;
    if (!this.ctx) {
      try {
        const ctx = new AudioContext();
        this.buildGraph(ctx);
        // Assigned only once the graph stands: a context whose buses are half
        // built is worse than no context, because every voice then connects
        // into nothing. One failure gives up for the page rather than opening
        // a new context on every sound.
        this.ctx = ctx;
      } catch {
        this.audioFailed = true;
        this.ctx = null;
        return null;
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => { /* ignored */ });
    return this.ctx;
  }

  private buildGraph(ctx: AudioContext): void {
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.18;

    // The compressor shapes the mix; the limiter is the wall behind it. A hard
    // knee at -3 dB with a 1 ms attack catches whatever a triple stinger, a
    // slider at 100% and a long reverb tail manage to stack up.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxGain();
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicGain();

    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 9000;
    this.musicFilter.Q.value = 0.7;

    // Reverb: convolver fed by a synthetic impulse response
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.9;
    const convolver = ctx.createConvolver();
    convolver.buffer = this.makeImpulseResponse(ctx, 2.2, 2.6);
    const reverbTone = ctx.createBiquadFilter();
    reverbTone.type = 'lowpass';
    reverbTone.frequency.value = 5000;
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.32;
    this.reverbSend.connect(convolver);
    convolver.connect(reverbTone);
    reverbTone.connect(reverbReturn);
    reverbReturn.connect(this.compressor);

    this.sfxBus.connect(this.compressor);
    this.musicBus.connect(this.musicFilter);
    this.musicFilter.connect(this.compressor);
    this.compressor.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);

    // Sidechain: pads + arp run through a gain the kick briefly dips
    this.sidechain = ctx.createGain();
    this.sidechain.gain.value = 1;
    this.sidechain.connect(this.musicBus);

    const mk = (v: number, into: AudioNode) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(into);
      return g;
    };
    this.layerKick = mk(0, this.musicBus);
    this.layerBass = mk(0, this.musicBus);
    this.layerHat = mk(0, this.musicBus);
    this.layerSnare = mk(0, this.musicBus);
    this.layerArp = mk(0, this.sidechain);
    this.layerPad = mk(0, this.sidechain);

    // Arp echo (dotted eighth) with a little reverb on the wet path
    this.arpDelay = ctx.createDelay(1.0);
    this.arpDelay.delayTime.value = this.dottedEighth();
    const feedback = ctx.createGain();
    feedback.gain.value = 0.3;
    const delayTone = ctx.createBiquadFilter();
    delayTone.type = 'lowpass';
    delayTone.frequency.value = 3000;
    this.layerArp.connect(this.arpDelay);
    this.arpDelay.connect(delayTone);
    delayTone.connect(feedback);
    feedback.connect(this.arpDelay);
    delayTone.connect(this.sidechain);
    const arpVerb = ctx.createGain();
    arpVerb.gain.value = 0.35;
    this.layerArp.connect(arpVerb);
    arpVerb.connect(this.reverbSend);
    const padVerb = ctx.createGain();
    padVerb.gain.value = 0.5;
    this.layerPad.connect(padVerb);
    padVerb.connect(this.reverbSend);
    const snareVerb = ctx.createGain();
    snareVerb.gain.value = 0.25;
    this.layerSnare.connect(snareVerb);
    snareVerb.connect(this.reverbSend);

    // Noise source for hats / snares / sweeps
    const len = ctx.sampleRate;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  /** Stereo decaying-noise impulse response: a believable medium hall */
  private makeImpulseResponse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.pow(1 - t, decay) * (i < rate * 0.02 ? 0.6 : 1);
        data[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buffer;
  }

  private dottedEighth(): number {
    return (60 / this.bpm) * 0.75;
  }

  // ── Settings ──

  get isSfxEnabled(): boolean { return this.sfxEnabled; }
  get isMusicEnabled(): boolean { return this.musicEnabled; }
  get sfxLevel(): number { return this.sfxVolume; }
  get musicLevel(): number { return this.musicVolume; }

  /** Bus gain for the current slider position. Full scale is above 1: see busFullScale. */
  private sfxGain(): number {
    return volumeToGain(this.sfxVolume, busFullScale(SFX_BASE_GAIN, DEFAULT_SFX_VOLUME));
  }

  private musicGain(): number {
    return volumeToGain(this.musicVolume, busFullScale(MUSIC_BASE_GAIN, DEFAULT_MUSIC_VOLUME));
  }

  setSfxVolume(volume: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, volume));
    updateSettings({ sfxVolume: this.sfxVolume });
    // Ramped, not assigned: a drag writes a new value every frame and a step
    // change in a gain node is a click.
    if (this.ctx && this.sfxBus) {
      this.sfxBus.gain.setTargetAtTime(this.sfxGain(), this.ctx.currentTime, 0.02);
    }
  }

  setMusicVolume(volume: number): void {
    this.musicVolume = Math.max(0, Math.min(1, volume));
    updateSettings({ musicVolume: this.musicVolume });
    // Only while the music is running: between runs the bus is faded to
    // silence and raising it here would bring the tails back up.
    if (this.ctx && this.musicBus && this.musicActive) {
      this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
      this.musicBus.gain.setTargetAtTime(this.musicGain(), this.ctx.currentTime, 0.05);
    }
  }

  setSfxEnabled(on: boolean): void {
    this.sfxEnabled = on;
    updateSettings({ sfx: on });
  }

  setMusicEnabled(on: boolean): void {
    this.musicEnabled = on;
    updateSettings({ music: on });
    if (!on) this.stopMusic();
    else if (this.wantsMusic) this.startMusic();
  }

  toggleSfx(): boolean { this.setSfxEnabled(!this.sfxEnabled); return this.sfxEnabled; }
  toggleMusic(): boolean { this.setMusicEnabled(!this.musicEnabled); return this.musicEnabled; }

  // ── Voice helpers ──

  private sfxReady(): AudioContext | null {
    if (!this.sfxEnabled) return null;
    return this.getContext();
  }

  /** Enveloped oscillator. `pan` -1..1, `verb` 0..1 send amount. */
  private tone(
    bus: AudioNode,
    type: OscillatorType,
    freqStart: number,
    freqEnd: number | null,
    t0: number,
    duration: number,
    peak: number,
    attack = 0.005,
    pan = 0,
    verb = 0,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t0);
    if (freqEnd !== null && freqEnd > 0) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + duration);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    let out: AudioNode = gain;
    if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      gain.connect(p);
      out = p;
    }
    out.connect(bus);
    if (verb > 0 && this.reverbSend) {
      const send = ctx.createGain();
      send.gain.value = verb;
      out.connect(send);
      send.connect(this.reverbSend);
    }
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  private noise(
    bus: AudioNode,
    filterType: BiquadFilterType,
    filterFreq: number,
    q: number,
    t0: number,
    duration: number,
    peak: number,
    verb = 0,
    sweepTo: number | null = null,
  ): void {
    const ctx = this.ctx!;
    if (!this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(filterFreq, t0);
    if (sweepTo !== null) filter.frequency.exponentialRampToValueAtTime(sweepTo, t0 + duration);
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(bus);
    if (verb > 0 && this.reverbSend) {
      const send = ctx.createGain();
      send.gain.value = verb;
      gain.connect(send);
      send.connect(this.reverbSend);
    }
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + duration + 0.05);
  }

  /**
   * Slow, wide chord swell: the tail on a big claim, a survey, and the logo.
   * Detuned saws behind a filter that opens and closes over the note, with a
   * heavy reverb send — the sound of a room being filled rather than hit.
   */
  private padSwell(
    t: number, semis: number[], peak: number, duration: number,
    openTo: number, attack: number, verb: number,
  ): void {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(600, t);
    filter.frequency.exponentialRampToValueAtTime(openTo, t + duration * 0.25);
    filter.frequency.exponentialRampToValueAtTime(500, t + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.1);
    filter.connect(env);
    env.connect(this.sfxBus!);
    if (verb > 0 && this.reverbSend) {
      const send = ctx.createGain();
      send.gain.value = verb;
      env.connect(send);
      send.connect(this.reverbSend);
    }
    semis.forEach((semi, i) => {
      const hz = noteHz(semi);
      for (const detune of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = hz;
        osc.detune.value = detune + (i - 1) * 2;
        osc.connect(filter);
        osc.start(t);
        osc.stop(t + duration + 0.2);
      }
    });
  }

  private duckMusic(amount: number, seconds: number): void {
    // Nothing to duck when the loop is not running, and touching the bus then
    // would drag a faded-out tail back up.
    if (!this.musicBus || !this.ctx || !this.musicActive) return;
    const now = this.ctx.currentTime;
    const level = this.musicGain();
    const g = this.musicBus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(level * (1 - amount), now + 0.02);
    g.setTargetAtTime(level, now + 0.05, seconds / 3);
  }

  // ── Timing and harmony ──

  /** One sixteenth at the current tempo */
  private stepSeconds(): number {
    return 60 / this.bpm / 4;
  }

  /**
   * When a stinger should start. On the grid while the music runs, so claims
   * land with the beat instead of across it; immediately when it does not.
   */
  private stingerTime(ctx: AudioContext): number {
    if (!this.musicActive) return ctx.currentTime;
    return nextGridTime(ctx.currentTime, this.nextStepTime, this.stepSeconds());
  }

  /**
   * The chord sounding at audio time `t`. `step` is the next step to be
   * scheduled and `nextStepTime` is when it plays, so the step covering `t` is
   * that many steps either side. With the music off, everything is pitched
   * from the home chord, which is where the loop would have started.
   */
  private chordAtTime(t: number): Chord {
    if (!this.musicActive) return chordAt(0);
    return chordAt(this.step + Math.floor((t - this.nextStepTime) / this.stepSeconds()));
  }

  /**
   * Book a stinger's share of the output and say how far to turn it down. A
   * double close that completes a survey and crosses a tier fires three of
   * these on one frame.
   */
  private reserveStinger(t: number, weight: number): number {
    this.stingerLoad = this.stingerLoad.filter(s => s.time >= t - STINGER_WINDOW_SEC);
    const scale = stingerScale(this.stingerLoad, t, weight);
    this.stingerLoad.push({ time: t, gain: weight * scale });
    return scale;
  }

  // ── Sound effects ──

  /**
   * Placement pluck: a tone of the chord that is sounding, climbing with the
   * streak, panned to the column it was dropped on.
   *
   * Not quantised. Everything else waits for the grid, but a placement has to
   * answer the finger — even 60 ms of latency reads as a dropped frame.
   */
  playPlace(streak: number = 0, speedFraction: number = 1, col: number = 4, columns?: number): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    // With the ninth the ladder is four tones an octave, which is exactly the
    // range a streak walks up before it caps.
    const tones = chordTones(this.chordAtTime(t), 2, true);
    const hz = tones[Math.min(Math.max(streak, 0), tones.length - 1)];
    const bright = 0.5 + speedFraction * 0.5;
    const pan = panForColumn(col, columns);
    this.tone(this.sfxBus!, 'triangle', hz, null, t, 0.14, 0.16 * bright, 0.003, pan, 0.25);
    this.tone(this.sfxBus!, 'sine', hz * 2, null, t, 0.09, 0.06 * bright, 0.002, pan);
    // The thump stays centred: panned low end is what makes a mix feel lopsided
    this.tone(this.sfxBus!, 'sine', 170, 60, t, 0.08, 0.16, 0.002);
    this.noise(this.sfxBus!, 'highpass', 4000, 0.7, t, 0.03, 0.06);
  }

  /**
   * Room claimed. Small rooms: a short bright run. Bigger rooms: a longer
   * rising harp run, a low boom, and a shimmering pad hit with a long
   * reverb tail. Multiple rooms add a second, higher run.
   *
   * `col` is the claimed rooms' centre column, so the claim comes from where
   * it happened on the board, and `columns` is how wide that board is — the
   * siege plays on eleven, and the two rightmost columns would otherwise pan
   * as if they were the ninth.
   */
  playClaim(area: number, rooms: number, streak: number, col: number = 4, columns?: number): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = this.stingerTime(ctx);
    this.claimBody(t, area, rooms, streak, panForColumn(col, columns));
    this.duckMusic(DUCK_3DB, CLAIM_DUCK_SECONDS);
  }

  /**
   * A claim that a ghost wall helped seal: the claim, then the same run again
   * an octave up, quieter, from the other side, 150 ms behind. The wall that
   * was not there any more, answering.
   */
  playEchoClaim(area: number, rooms: number, streak: number, col: number = 4): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = this.stingerTime(ctx);
    const pan = panForColumn(col);
    const scale = this.claimBody(t, area, rooms, streak, pan);
    const tones = chordTones(this.chordAtTime(t), 2, area >= 9);
    this.claimRun(t + ECHO_DELAY_SEC, tones, Math.min(area, 25), streak, -pan, ECHO_LEVEL * scale, 2);
    this.duckMusic(DUCK_3DB, CLAIM_DUCK_SECONDS);
  }

  /**
   * Everything a claim sounds, at a given time. Returns the gain scale it was
   * given, so an echo repeat rides at the same level as the claim it answers.
   */
  private claimBody(t: number, area: number, rooms: number, streak: number, pan: number): number {
    const size = Math.min(area, 25);
    const scale = this.reserveStinger(t, STINGER_WEIGHT.claim);
    const chord = this.chordAtTime(t);
    // A room of nine or more earns the ninth: one more colour in the run, and
    // the only thing that tells a 3×3 from a 2×2 by ear.
    const tones = chordTones(chord, 2, size >= 9);

    // Boom scaled by size, centred like all the low end
    const boomGain = (0.2 + Math.min(size, 16) * 0.02) * scale;
    this.tone(this.sfxBus!, 'sine', 90, 34, t, 0.35 + size * 0.02, boomGain, 0.004, 0, 0.3);

    this.claimRun(t, tones, size, streak, pan, scale, 1);

    // Second run an octave up for double closes, answering across the stereo
    if (rooms >= 2) {
      for (let i = 0; i < 6; i++) {
        const hz = tones[(i + 2) % tones.length] * 2;
        this.tone(this.sfxBus!, 'sine', hz, null, t + 0.12 + i * 0.05, 0.3, 0.07 * scale, 0.003, (i % 2 ? 0.5 : -0.5), 0.5);
      }
    }

    // Pad hit for big rooms, on the chord that is actually sounding
    if (size >= 4) {
      this.padSwell(
        t, chord.pad.map(s => s + 12), (0.05 + Math.min(size, 16) * 0.005) * scale,
        1.2, 2400 + size * 80, 0.12, 0.8,
      );
    }

    // Air sweep
    this.noise(this.sfxBus!, 'bandpass', 900, 1.2, t, 0.35 + size * 0.02, 0.12 * scale, 0.4, 4000);
    return scale;
  }

  /**
   * The rising harp run at the heart of a claim: 3 notes for a tiny room, up
   * to 10 for a big one, climbing the chord's own tones and wrapping an octave
   * up when it runs off the top. The streak picks the rung it starts on.
   */
  private claimRun(
    t: number, tones: number[], size: number, streak: number,
    pan: number, level: number, octaveMul: number,
  ): void {
    const notes = Math.min(10, 3 + Math.floor(Math.sqrt(size) * 1.6));
    const stepDt = Math.max(0.03, 0.07 - size * 0.002);
    const start = Math.min(Math.max(streak, 0), 4);
    for (let i = 0; i < notes; i++) {
      const idx = start + i;
      const hz = tones[idx % tones.length] * Math.pow(2, Math.floor(idx / tones.length)) * octaveMul;
      const spread = pan + (-0.25 + (i / Math.max(1, notes - 1)) * 0.5);
      const p = Math.max(-1, Math.min(1, spread));
      this.tone(this.sfxBus!, 'triangle', hz, null, t + i * stepDt, 0.35, 0.11 * level, 0.003, p, 0.45);
      // The shimmer octave only on the run itself: on a repeat already an
      // octave up it would land at 7 kHz, which is an ice pick, not a sparkle.
      if (octaveMul === 1) {
        this.tone(this.sfxBus!, 'sine', hz * 2, null, t + i * stepDt, 0.2, 0.05 * level, 0.002, p, 0.3);
      }
    }
  }

  /**
   * Survey complete: a rising four-note arpeggio on the current chord over a
   * pad swell, about 1.2 s. The one moment in a run that gets a whole chord to
   * itself rather than a run of notes.
   */
  playSurvey(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = this.stingerTime(ctx);
    const chord = this.chordAtTime(t);
    const tones = chordTones(chord, 2);
    const scale = this.reserveStinger(t, STINGER_WEIGHT.survey);
    const dt = Math.min(0.3, this.stepSeconds() * 2);
    for (let i = 0; i < 4; i++) {
      const hz = tones[Math.min(i, tones.length - 1)];
      this.tone(this.sfxBus!, 'triangle', hz, null, t + i * dt, 0.55, 0.1 * scale, 0.005, (i - 1.5) * 0.28, 0.6);
      this.tone(this.sfxBus!, 'sine', hz * 2, null, t + i * dt, 0.3, 0.04 * scale, 0.004, 0, 0.4);
    }
    this.padSwell(t, chord.pad.map(s => s + 12), 0.09 * scale, 1.2, 2600, 0.35, 0.9);
    this.noise(this.sfxBus!, 'highpass', 5000, 0.7, t + 0.2, 0.7, 0.05 * scale, 0.5);
    this.duckMusic(DUCK_3DB, 0.6);
  }

  playSubBass(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.tone(this.sfxBus!, 'sine', 70, 38, ctx.currentTime, 0.2, 0.32, 0.003);
  }

  /**
   * The shimmer tail on a streaked claim. Quantised with the claim it decorates
   * — unquantised it would arrive *before* the claim it is meant to follow.
   * Stays on the pentatonic, which is safe against all four chords, because it
   * is a wash rather than a melody.
   */
  playComboReverb(streak: number): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = this.stingerTime(ctx);
    const hz = noteHz(degreeToSemitone(Math.min(streak, 10) + 4) + 12);
    for (let i = 1; i <= 3; i++) {
      this.tone(this.sfxBus!, 'sine', hz, hz * 0.8, t + i * 0.09, 0.16, 0.05 / i, 0.003, i % 2 ? 0.4 : -0.4, 0.5);
    }
  }

  playWhoosh(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.noise(this.sfxBus!, 'bandpass', 2200, 1, ctx.currentTime, 0.06, 0.12);
  }

  playTick(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.tone(this.sfxBus!, 'square', 1100, 800, ctx.currentTime, 0.045, 0.06, 0.002, 0, 0.2);
  }

  playUrgentTick(secondsLeft: number): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    const hz = 700 + (6 - Math.min(secondsLeft, 6)) * 90;
    this.tone(this.sfxBus!, 'square', hz, hz * 0.8, t, 0.05, 0.07, 0.002, 0, 0.2);
    this.tone(this.sfxBus!, 'sine', 90, 50, t, 0.09, 0.2, 0.002);
  }

  playGoChime(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    [0, 4, 7, 12].forEach((semi, i) => {
      this.tone(this.sfxBus!, 'triangle', noteHz(semi + 12), null, t + i * 0.03, 0.5, 0.1, 0.005, (i - 1.5) * 0.3, 0.5);
    });
    this.noise(this.sfxBus!, 'highpass', 4000, 0.7, t, 0.3, 0.08, 0.4);
  }

  playAlertChime(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(this.sfxBus!, 'square', 880, null, t, 0.1, 0.07, 0.003);
    this.tone(this.sfxBus!, 'square', 1175, null, t + 0.11, 0.14, 0.07, 0.003, 0, 0.3);
  }

  playInvalid(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.tone(this.sfxBus!, 'square', 220, 110, ctx.currentTime, 0.1, 0.07, 0.003);
  }

  playUiClick(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.tone(this.sfxBus!, 'sine', 900, 600, ctx.currentTime, 0.06, 0.08, 0.002, 0, 0.15);
  }

  /**
   * Tier up: the leitmotif. Seven fixed notes over two bars, transposed into
   * whatever chord is sounding — the same phrase every time, so a tier stops
   * being a noise and becomes a thing the player knows by its tune. Timed off
   * the sixteenth grid, so it is also in tempo.
   */
  playTierUp(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t0 = this.stingerTime(ctx);
    const tones = chordTones(this.chordAtTime(t0), 3);
    const step = this.stepSeconds();
    const scale = this.reserveStinger(t0, STINGER_WEIGHT.tierUp);
    for (const note of TIER_MOTIF) {
      const hz = tones[Math.min(note.tone, tones.length - 1)];
      const t = t0 + note.at * step;
      const duration = Math.max(0.2, note.len * step);
      const pan = (note.tone / (tones.length - 1) - 0.5) * 0.6;
      this.tone(this.sfxBus!, 'triangle', hz, null, t, duration, 0.1 * scale, 0.004, pan, 0.5);
      this.tone(this.sfxBus!, 'sine', hz * 2, null, t, duration * 0.6, 0.035 * scale, 0.003, pan, 0.35);
    }
    this.duckMusic(DUCK_3DB, 0.5);
  }

  playNewBest(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    const scale = this.reserveStinger(t, STINGER_WEIGHT.newBest);
    [0, 7, 12, 19, 24].forEach((semi, i) => {
      const hz = noteHz(semi);
      this.tone(this.sfxBus!, 'triangle', hz, null, t + i * 0.08, 0.6, 0.1 * scale, 0.005, (i - 2) * 0.2, 0.6);
      this.tone(this.sfxBus!, 'sine', hz * 2, null, t + i * 0.08, 0.35, 0.05 * scale, 0.005, 0, 0.4);
    });
    this.noise(this.sfxBus!, 'highpass', 5000, 0.7, t + 0.3, 0.5, 0.07 * scale, 0.5);
    this.duckMusic(0.5, 0.6);
  }

  /**
   * The menu signature: two seconds of the game's own chord, once per page
   * load, on the gesture that unlocks the audio context. Respects the SFX
   * toggle like everything else, and never plays twice.
   */
  playLogoJingle(): void {
    if (this.logoJinglePlayed) return;
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.logoJinglePlayed = true;
    // resume() settles a tick after the gesture: scheduling into a suspended
    // context would swallow the jingle, so it waits for the clock to run.
    if (ctx.state === 'running') this.logoJingle(ctx);
    else ctx.resume().then(() => this.logoJingle(ctx)).catch(() => { /* stays silent */ });
  }

  private logoJingle(ctx: AudioContext): void {
    if (!this.sfxBus) return;
    const t = ctx.currentTime + 0.05;
    const chord = chordAt(0);
    const tones = chordTones(chord, 2);
    const scale = this.reserveStinger(t, STINGER_WEIGHT.logo);
    // Four blocks going up, then the room closing behind them
    for (let i = 0; i < 4; i++) {
      const hz = tones[Math.min(i, tones.length - 1)];
      this.tone(this.sfxBus, 'triangle', hz, null, t + i * 0.12, 0.5, 0.11 * scale, 0.004, (i - 1.5) * 0.3, 0.5);
      this.tone(this.sfxBus, 'sine', hz * 2, null, t + i * 0.12, 0.25, 0.04 * scale, 0.003, 0, 0.3);
    }
    this.tone(this.sfxBus, 'sine', 100, 45, t + 0.48, 0.4, 0.22 * scale, 0.004, 0, 0.3);
    this.padSwell(t + 0.4, chord.pad.map(s => s + 12), 0.08 * scale, 1.4, 2200, 0.3, 0.9);
    this.noise(this.sfxBus, 'highpass', 4500, 0.7, t + 0.45, 0.9, 0.05 * scale, 0.5);
  }

  /**
   * A blip at the level being dragged, so a volume slider is something you
   * hear rather than something you read. Throttled: a drag fires a change a
   * frame, and every one of these is a voice.
   */
  playVolumePreview(bus: 'sfx' | 'music'): void {
    const ctx = bus === 'sfx' ? this.sfxReady() : (this.musicEnabled ? this.getContext() : null);
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - this.lastPreviewTime < 0.12) return;
    this.lastPreviewTime = t;
    if (bus === 'sfx') {
      this.tone(this.sfxBus!, 'triangle', 880, null, t, 0.1, 0.12, 0.003, 0, 0.2);
      return;
    }
    if (!this.musicBus) return;
    // Between runs the music bus is faded to silence, so a preview would be
    // inaudible. Nothing is playing on it, so putting it back is silent.
    if (!this.musicActive) {
      this.musicBus.gain.cancelScheduledValues(t);
      this.musicBus.gain.setValueAtTime(this.musicGain(), t);
    }
    chordAt(0).pad.forEach((semi, i) => {
      this.tone(this.musicBus!, 'triangle', noteHz(semi + 12), null, t + i * 0.02, 0.4, 0.12, 0.01);
    });
  }

  playStreakBreak(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.tone(this.sfxBus!, 'sawtooth', 600, 180, ctx.currentTime, 0.22, 0.08, 0.003, 0, 0.2);
  }

  playGameOver(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    [0, -2, -4, -9].forEach((semi, i) => {
      const hz = noteHz(semi);
      this.tone(this.sfxBus!, 'triangle', hz, hz * 0.97, t + i * 0.17, 0.4, 0.13, 0.01, 0, 0.6);
      this.tone(this.sfxBus!, 'sine', hz / 2, hz / 2 * 0.97, t + i * 0.17, 0.4, 0.1, 0.01);
    });
    this.noise(this.sfxBus!, 'lowpass', 600, 0.7, t, 0.8, 0.15, 0.5);
    this.duckMusic(1, 1.5);
  }

  // ── Music engine ──

  startMusic(): void {
    this.wantsMusic = true;
    if (!this.musicEnabled || this.musicActive) return;
    const ctx = this.getContext();
    if (!ctx || !this.musicBus) return;
    this.musicActive = true;
    this.step = 0;
    this.nextStepTime = ctx.currentTime + 0.05;
    this.musicBus.gain.cancelScheduledValues(ctx.currentTime);
    this.musicBus.gain.setValueAtTime(0.0001, ctx.currentTime);
    this.musicBus.gain.exponentialRampToValueAtTime(Math.max(0.0002, this.musicGain()), ctx.currentTime + 0.6);
    this.applyIntensity(true);
    this.schedulerTimer = window.setInterval(() => this.scheduleAhead(), SCHEDULER_INTERVAL_MS);
  }

  stopMusic(): void {
    this.wantsMusic = false;
    if (!this.musicActive) return;
    this.musicActive = false;
    if (this.schedulerTimer !== null) {
      window.clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.ctx && this.musicBus) {
      const now = this.ctx.currentTime;
      this.musicBus.gain.cancelScheduledValues(now);
      this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, now);
      this.musicBus.gain.linearRampToValueAtTime(0.0001, now + 0.25);
    }
  }

  updateMusic(drainRate: number, streak: number, timeFraction: number, flow: number): void {
    if (!this.musicActive || !this.ctx) return;
    const drainT = Math.max(0, Math.min(1, (drainRate - 0.8) / 0.9));
    const targetBpm = 104 + drainT * 28 + this.tension * 8;
    this.bpm += (targetBpm - this.bpm) * 0.05;
    if (this.arpDelay) this.arpDelay.delayTime.setTargetAtTime(this.dottedEighth(), this.ctx.currentTime, 0.2);

    const streakT = Math.min(streak / 6, 1);
    const target = Math.max(streakT, flow * 0.9, drainT * 0.45);
    this.intensity += (target - this.intensity) * (target > this.intensity ? 0.08 : 0.02);

    const targetTension = timeFraction <= 0.3 ? 1 - timeFraction / 0.3 : 0;
    this.tension += (targetTension - this.tension) * 0.08;
    this.applyIntensity(false);
  }

  private applyIntensity(instant: boolean): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const tc = instant ? 0.01 : 0.35;
    const set = (g: GainNode | null, v: number) => { if (g) g.gain.setTargetAtTime(v, now, tc); };
    const i = this.intensity;
    set(this.layerKick, 0.9);
    set(this.layerBass, 0.5 + i * 0.3);
    set(this.layerHat, i >= 0.15 ? 0.3 + i * 0.35 : 0);
    set(this.layerSnare, i >= 0.4 ? 0.5 : 0);
    set(this.layerArp, i >= 0.25 ? 0.3 + i * 0.4 : 0.12);
    set(this.layerPad, 0.35 + i * 0.4);
    if (this.musicFilter) this.musicFilter.frequency.setTargetAtTime(9000 - this.tension * 6500, now, tc);
  }

  private scheduleAhead(): void {
    if (!this.musicActive || !this.ctx) return;
    while (this.nextStepTime < this.ctx.currentTime + SCHEDULE_AHEAD_SEC) {
      this.scheduleStep(this.step, this.nextStepTime);
      this.nextStepTime += 60 / this.bpm / 4;
      this.step = (this.step + 1) % LOOP_STEPS;
    }
  }

  private scheduleStep(globalStep: number, t: number): void {
    const sectionB = globalStep >= STEPS_PER_BAR * BARS_PER_SECTION;
    const bar = Math.floor(globalStep / STEPS_PER_BAR) % BARS_PER_SECTION;
    const s = globalStep % STEPS_PER_BAR;
    // One lookup for the whole engine: the stingers ask the same question
    const chord = chordAt(globalStep);
    const i = this.intensity;
    const tense = this.tension > 0.4;
    const lastBar = bar === BARS_PER_SECTION - 1;

    // Kick + sidechain pump
    const kickSteps = tense ? [0, 3, 6, 8, 11, 14] : i >= 0.35 ? [0, 4, 8, 12] : [0, 8];
    if (kickSteps.includes(s)) {
      this.kick(t, s === 0 ? 1 : 0.85);
      this.pump(t);
    }

    if (s === 4 || s === 12) this.snare(t);
    // Fill: snare roll at the end of the B section when intense
    if (sectionB && lastBar && i >= 0.5 && s >= 12) this.snare(t, 0.5 + (s - 12) * 0.15);

    const offbeat = s % 4 === 2;
    const sixteenth = s % 2 === 1;
    if (offbeat || (sixteenth && i >= 0.6)) this.hat(t, offbeat ? 0.6 : 0.3, sixteenth ? 0.35 : -0.2);

    const bassSteps = i >= 0.5 ? [0, 3, 6, 8, 11, 14] : [0, 6, 8, 14];
    if (bassSteps.includes(s)) {
      const octaveUp = (s === 6 || s === 14) && i >= 0.5;
      this.bass(t, 110 * Math.pow(2, (chord.bassRoot + (octaveUp ? 12 : 0)) / 12));
    }

    if (s % 2 === 0) {
      const idx = Math.floor(s / 2) % chord.arp.length;
      const lift = sectionB && i >= 0.7 ? 12 : 0;
      this.pluck(t, noteHz(chord.arp[idx] + 12 + lift), idx % 2 ? 0.4 : -0.4);
    }

    if (s === 0) this.pad(t, chord.pad, (60 / this.bpm) * 4);

    // Riser into the loop restart when the run is hot
    if (sectionB && lastBar && s === 0 && i >= 0.6) this.riser(t, (60 / this.bpm) * 4);
  }

  // ── Instruments ──

  private pump(t: number): void {
    if (!this.sidechain) return;
    const g = this.sidechain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(0.45, t + 0.01);
    g.setTargetAtTime(1, t + 0.02, 0.09);
  }

  private kick(t: number, vel: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    gain.gain.setValueAtTime(0.9 * vel, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(gain);
    gain.connect(this.layerKick!);
    osc.start(t);
    osc.stop(t + 0.3);
    this.noise(this.layerKick!, 'highpass', 2500, 0.7, t, 0.015, 0.25 * vel);
  }

  private snare(t: number, vel: number = 1): void {
    this.noise(this.layerSnare!, 'bandpass', 1900, 0.8, t, 0.16, 0.5 * vel);
    this.tone(this.layerSnare!, 'triangle', 200, 120, t, 0.09, 0.3 * vel, 0.002);
  }

  private hat(t: number, vel: number, pan: number): void {
    const ctx = this.ctx!;
    if (!this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 7500;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.28 * vel, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    src.connect(filter);
    filter.connect(gain);
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      gain.connect(p);
      p.connect(this.layerHat!);
    } else {
      gain.connect(this.layerHat!);
    }
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.08);
  }

  private bass(t: number, hz: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(hz, t);
    filter.type = 'lowpass';
    filter.Q.value = 5;
    filter.frequency.setValueAtTime(900 + this.intensity * 700, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.22);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.42, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.layerBass!);
    osc.start(t);
    osc.stop(t + 0.3);
    this.tone(this.layerBass!, 'sine', hz / 2, null, t, 0.2, 0.35, 0.004);
  }

  private pluck(t: number, hz: number, pan: number): void {
    this.tone(this.layerArp!, 'triangle', hz, null, t, 0.22, 0.28, 0.003, pan);
    this.tone(this.layerArp!, 'sine', hz * 2, null, t, 0.12, 0.08, 0.002, pan);
  }

  private pad(t: number, semis: number[], duration: number): void {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.6;
    filter.frequency.setValueAtTime(700, t);
    filter.frequency.linearRampToValueAtTime(1500 + this.intensity * 900, t + duration * 0.5);
    filter.frequency.linearRampToValueAtTime(800, t + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.085, t + 0.4);
    env.gain.setValueAtTime(0.085, t + duration - 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.1);
    filter.connect(env);
    env.connect(this.layerPad!);
    semis.forEach((semi, i) => {
      const hz = noteHz(semi);
      for (const detune of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = hz;
        osc.detune.value = detune + (i - 1) * 2;
        osc.connect(filter);
        osc.start(t);
        osc.stop(t + duration + 0.15);
      }
    });
  }

  private riser(t: number, duration: number): void {
    this.noise(this.layerSnare!, 'bandpass', 400, 1.5, t, duration, 0.12, 0.6, 6000);
  }
}
