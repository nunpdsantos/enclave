import { loadSettings, updateSettings } from '../core/Settings';

/**
 * AudioManager — everything the player hears, synthesized with the Web Audio API.
 *
 * Signal chain:
 *   SFX voices ─┬→ sfxBus ─────────────┐
 *               └→ reverbSend ─┐       ├→ compressor → master → speakers
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
 */

// ── Musical material ──

const PENTATONIC = [0, 3, 5, 7, 10];

function noteHz(semitonesFromA3: number): number {
  return 220 * Math.pow(2, semitonesFromA3 / 12);
}

function degreeToSemitone(degree: number): number {
  const octave = Math.floor(degree / PENTATONIC.length);
  const idx = ((degree % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length;
  return PENTATONIC[idx] + octave * 12;
}

interface Chord {
  bassRoot: number;   // semitones from A2 (110 Hz)
  arp: number[];      // semitones from A3
  pad: number[];      // semitones from A3
}

const SECTION_A: Chord[] = [
  { bassRoot: 0,  arp: [0, 3, 7, 12, 7, 3, 15, 12],  pad: [0, 3, 7] },
  { bassRoot: -4, arp: [-4, 0, 3, 8, 3, 0, 12, 8],   pad: [-4, 0, 3] },
  { bassRoot: 3,  arp: [3, 7, 10, 15, 10, 7, 19, 15], pad: [3, 7, 10] },
  { bassRoot: -2, arp: [-2, 2, 5, 10, 5, 2, 14, 10],  pad: [-2, 2, 5] },
];
const SECTION_B: Chord[] = [
  { bassRoot: 0,  arp: [12, 7, 3, 0, 3, 7, 12, 15],   pad: [0, 3, 7, 12] },
  { bassRoot: 3,  arp: [15, 10, 7, 3, 7, 10, 15, 19], pad: [3, 7, 10, 15] },
  { bassRoot: -2, arp: [14, 10, 5, 2, 5, 10, 14, 17], pad: [-2, 2, 5, 10] },
  { bassRoot: -4, arp: [12, 8, 3, 0, 3, 8, 12, 15],   pad: [-4, 0, 3, 8] },
];

const STEPS_PER_BAR = 16;
const BARS_PER_SECTION = 4;
const LOOP_STEPS = STEPS_PER_BAR * BARS_PER_SECTION * 2;

const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULE_AHEAD_SEC = 0.2;

export class AudioManager {
  private sfxEnabled: boolean;
  private musicEnabled: boolean;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
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

  constructor() {
    const s = loadSettings();
    this.sfxEnabled = s.sfx;
    this.musicEnabled = s.music;
  }

  // ── Context / graph ──

  unlock(): void {
    const ctx = this.getContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => { /* ignored */ });
  }

  private getContext(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.buildGraph(this.ctx);
      } catch {
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

    this.sfxBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.7;

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
    this.compressor.connect(this.master);
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

  private duckMusic(amount: number, seconds: number): void {
    if (!this.musicBus || !this.ctx) return;
    const now = this.ctx.currentTime;
    const g = this.musicBus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0.7 * (1 - amount), now + 0.02);
    g.setTargetAtTime(0.7, now + 0.05, seconds / 3);
  }

  // ── Sound effects ──

  /** Placement pluck: pitch walks up the scale with the streak */
  playPlace(streak: number = 0, speedFraction: number = 1): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    const hz = noteHz(degreeToSemitone(Math.min(streak, 9)) + 12);
    const bright = 0.5 + speedFraction * 0.5;
    this.tone(this.sfxBus!, 'triangle', hz, null, t, 0.14, 0.16 * bright, 0.003, 0, 0.25);
    this.tone(this.sfxBus!, 'sine', hz * 2, null, t, 0.09, 0.06 * bright, 0.002);
    this.tone(this.sfxBus!, 'sine', 170, 60, t, 0.08, 0.16, 0.002);
    this.noise(this.sfxBus!, 'highpass', 4000, 0.7, t, 0.03, 0.06);
  }

  /**
   * Room claimed. Small rooms: a short bright run. Bigger rooms: a longer
   * rising harp run, a low boom, and a shimmering pad hit with a long
   * reverb tail. Multiple rooms add a second, higher run.
   */
  playClaim(area: number, rooms: number, streak: number): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    const base = Math.min(streak, 8);
    const size = Math.min(area, 25);

    // Boom scaled by size
    const boomGain = 0.2 + Math.min(size, 16) * 0.02;
    this.tone(this.sfxBus!, 'sine', 90, 34, t, 0.35 + size * 0.02, boomGain, 0.004, 0, 0.3);

    // Harp run: 3 notes for tiny rooms, up to 10 for big ones
    const notes = Math.min(10, 3 + Math.floor(Math.sqrt(size) * 1.6));
    const stepDt = Math.max(0.03, 0.07 - size * 0.002);
    for (let i = 0; i < notes; i++) {
      const hz = noteHz(degreeToSemitone(base + i) + 12);
      const pan = -0.5 + (i / Math.max(1, notes - 1));
      this.tone(this.sfxBus!, 'triangle', hz, null, t + i * stepDt, 0.35, 0.11, 0.003, pan, 0.45);
      this.tone(this.sfxBus!, 'sine', hz * 2, null, t + i * stepDt, 0.2, 0.05, 0.002, pan, 0.3);
    }

    // Second run an octave up for double closes
    if (rooms >= 2) {
      for (let i = 0; i < 6; i++) {
        const hz = noteHz(degreeToSemitone(base + 5 + i) + 24);
        this.tone(this.sfxBus!, 'sine', hz, null, t + 0.12 + i * 0.05, 0.3, 0.07, 0.003, (i % 2 ? 0.5 : -0.5), 0.5);
      }
    }

    // Pad hit for big rooms: detuned saws, slow attack, long tail
    if (size >= 4) {
      const chord = [0, 3, 7, 12].map(s => noteHz(degreeToSemitone(base) + s));
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(600, t);
      filter.frequency.exponentialRampToValueAtTime(2400 + size * 80, t + 0.25);
      filter.frequency.exponentialRampToValueAtTime(500, t + 1.2);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.05 + Math.min(size, 16) * 0.005, t + 0.12);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      filter.connect(env);
      env.connect(this.sfxBus!);
      const send = ctx.createGain();
      send.gain.value = 0.8;
      env.connect(send);
      send.connect(this.reverbSend!);
      for (const hz of chord) {
        for (const detune of [-7, 7]) {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = hz;
          osc.detune.value = detune;
          osc.connect(filter);
          osc.start(t);
          osc.stop(t + 1.4);
        }
      }
    }

    // Air sweep
    this.noise(this.sfxBus!, 'bandpass', 900, 1.2, t, 0.35 + size * 0.02, 0.12, 0.4, 4000);
    this.duckMusic(Math.min(0.7, 0.3 + size * 0.03), 0.4 + size * 0.03);
  }

  playSubBass(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.tone(this.sfxBus!, 'sine', 70, 38, ctx.currentTime, 0.2, 0.32, 0.003);
  }

  playComboReverb(streak: number): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
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

  playTierUp(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    [0, 3, 7, 12, 15].forEach((semi, i) => {
      this.tone(this.sfxBus!, 'triangle', noteHz(semi + 12), null, t + i * 0.06, 0.4, 0.09, 0.004, (i - 2) * 0.25, 0.5);
    });
    this.duckMusic(0.3, 0.4);
  }

  playNewBest(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    [0, 7, 12, 19, 24].forEach((semi, i) => {
      const hz = noteHz(semi);
      this.tone(this.sfxBus!, 'triangle', hz, null, t + i * 0.08, 0.6, 0.1, 0.005, (i - 2) * 0.2, 0.6);
      this.tone(this.sfxBus!, 'sine', hz * 2, null, t + i * 0.08, 0.35, 0.05, 0.005, 0, 0.4);
    });
    this.noise(this.sfxBus!, 'highpass', 5000, 0.7, t + 0.3, 0.5, 0.07, 0.5);
    this.duckMusic(0.5, 0.6);
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
    this.musicBus.gain.exponentialRampToValueAtTime(0.7, ctx.currentTime + 0.6);
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
    const section = sectionB ? SECTION_B : SECTION_A;
    const bar = Math.floor(globalStep / STEPS_PER_BAR) % BARS_PER_SECTION;
    const s = globalStep % STEPS_PER_BAR;
    const chord = section[bar];
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
