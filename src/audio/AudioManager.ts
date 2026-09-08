import { loadSettings, updateSettings } from '../core/Settings';

/**
 * AudioManager — everything the player hears, synthesized with the Web Audio API.
 *
 * No audio files are shipped. Every sound is generated from oscillators and
 * filtered noise, which keeps the bundle tiny and lets the sounds react to
 * game state (pitch climbs with the streak, music speeds up with the clock).
 *
 * Signal chain:
 *   SFX  → sfxBus  ─┐
 *                    ├→ compressor → master → speakers
 *   Music→ musicBus → lowpass ─┘
 *
 * The music engine is a step sequencer scheduled ahead of time on the audio
 * clock (the "two clocks" pattern): a JS timer wakes every 25ms and books
 * every note that falls inside the next 200ms, so timing stays sample-accurate
 * even when the render loop hitches.
 */

// ── Musical material ──

/** Semitone offsets of the A minor pentatonic scale within one octave */
const PENTATONIC = [0, 3, 5, 7, 10];

/** Frequency for a semitone offset from A3 (220 Hz) */
function noteHz(semitonesFromA3: number): number {
  return 220 * Math.pow(2, semitonesFromA3 / 12);
}

/** Pentatonic scale degree (can exceed 5 → next octave) to semitone offset */
function degreeToSemitone(degree: number): number {
  const octave = Math.floor(degree / PENTATONIC.length);
  const idx = ((degree % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length;
  return PENTATONIC[idx] + octave * 12;
}

interface Chord {
  /** Bass root, semitones from A2 (110 Hz) */
  bassRoot: number;
  /** Arpeggio pool, semitones from A3 */
  arp: number[];
  /** Pad voicing, semitones from A3 */
  pad: number[];
}

/** Four-bar loop: Am – F – C – G */
const PROGRESSION: Chord[] = [
  { bassRoot: 0,  arp: [0, 3, 7, 12, 7, 3, 15, 12],  pad: [0, 3, 7] },
  { bassRoot: -4, arp: [-4, 0, 3, 8, 3, 0, 12, 8],   pad: [-4, 0, 3] },
  { bassRoot: 3,  arp: [3, 7, 10, 15, 10, 7, 19, 15], pad: [3, 7, 10] },
  { bassRoot: -2, arp: [-2, 2, 5, 10, 5, 2, 14, 10],  pad: [-2, 2, 5] },
];

const STEPS_PER_BAR = 16; // 16th notes
const BARS = PROGRESSION.length;

// ── Timing constants ──
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
  private noiseBuffer: AudioBuffer | null = null;

  // Music layer gains (smoothly faded in/out with intensity)
  private layerKick: GainNode | null = null;
  private layerBass: GainNode | null = null;
  private layerHat: GainNode | null = null;
  private layerArp: GainNode | null = null;
  private layerPad: GainNode | null = null;
  private layerSnare: GainNode | null = null;
  private arpDelay: DelayNode | null = null;

  // Sequencer state
  private musicActive = false;
  private schedulerTimer: number | null = null;
  private nextStepTime = 0;
  private step = 0;
  private bpm = 100;
  private intensity = 0;
  private tension = 0;

  constructor() {
    const s = loadSettings();
    this.sfxEnabled = s.sfx;
    this.musicEnabled = s.music;
  }

  // ── Context / graph ──

  /**
   * Browsers only allow audio to start after a user gesture. Call this from
   * a pointer/keyboard handler so the context is created and resumed in time.
   */
  unlock(): void {
    const ctx = this.getContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => { /* ignored */ });
    }
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
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => { /* ignored */ });
    }
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
    this.sfxBus.gain.value = 1;

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.7;

    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 9000;
    this.musicFilter.Q.value = 0.7;

    this.sfxBus.connect(this.compressor);
    this.musicBus.connect(this.musicFilter);
    this.musicFilter.connect(this.compressor);
    this.compressor.connect(this.master);
    this.master.connect(ctx.destination);

    // Music layers
    const mk = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(this.musicBus!);
      return g;
    };
    this.layerKick = mk(0);
    this.layerBass = mk(0);
    this.layerHat = mk(0);
    this.layerArp = mk(0);
    this.layerPad = mk(0);
    this.layerSnare = mk(0);

    // Dotted-eighth echo for the arpeggio: gives the plucks space
    this.arpDelay = ctx.createDelay(1.0);
    this.arpDelay.delayTime.value = this.dottedEighth();
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const delayTone = ctx.createBiquadFilter();
    delayTone.type = 'lowpass';
    delayTone.frequency.value = 3200;
    this.layerArp.connect(this.arpDelay);
    this.arpDelay.connect(delayTone);
    delayTone.connect(feedback);
    feedback.connect(this.arpDelay);
    delayTone.connect(this.musicBus);

    // One second of white noise, reused for hats and snares
    const len = ctx.sampleRate;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
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
    if (!on) {
      this.stopMusic();
    } else if (this.wantsMusic) {
      this.startMusic();
    }
  }

  toggleSfx(): boolean {
    this.setSfxEnabled(!this.sfxEnabled);
    return this.sfxEnabled;
  }

  toggleMusic(): boolean {
    this.setMusicEnabled(!this.musicEnabled);
    return this.musicEnabled;
  }

  // ── Generic voice helpers ──

  private sfxReady(): AudioContext | null {
    if (!this.sfxEnabled) return null;
    return this.getContext();
  }

  /** Simple enveloped oscillator voice into a bus */
  private tone(
    bus: AudioNode,
    type: OscillatorType,
    freqStart: number,
    freqEnd: number | null,
    t0: number,
    duration: number,
    peak: number,
    attack = 0.005,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t0);
    if (freqEnd !== null && freqEnd > 0) {
      osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + duration);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(bus);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  /** Filtered noise burst */
  private noise(
    bus: AudioNode,
    filterType: BiquadFilterType,
    filterFreq: number,
    q: number,
    t0: number,
    duration: number,
    peak: number,
  ): void {
    const ctx = this.ctx!;
    if (!this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = this.noiseBuffer.duration;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(bus);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + duration + 0.02);
  }

  /** Briefly lower the music so a big sound effect reads clearly */
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

  /**
   * Piece placement: a soft pluck whose pitch walks up the pentatonic scale
   * with the streak, so a hot streak literally sounds like a rising melody.
   */
  playPlace(streak: number = 0, speedFraction: number = 1): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    const degree = Math.min(streak, 9);
    const hz = noteHz(degreeToSemitone(degree) + 12);
    const bright = 0.5 + speedFraction * 0.5;
    this.tone(this.sfxBus!, 'triangle', hz, null, t, 0.12, 0.16 * bright, 0.003);
    this.tone(this.sfxBus!, 'sine', hz * 2, null, t, 0.08, 0.06 * bright, 0.002);
    // Tactile thud underneath
    this.tone(this.sfxBus!, 'sine', 180, 70, t, 0.07, 0.14, 0.002);
  }

  /**
   * Line clear: a chord stab in the current streak's key. More lines add
   * higher voices; a longer streak moves the whole chord up the scale.
   */
  playClear(lines: number = 1, streak: number = 1): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    const base = Math.min(streak, 10);
    const voices = Math.min(2 + lines, 5);
    for (let i = 0; i < voices; i++) {
      const hz = noteHz(degreeToSemitone(base + i * 2));
      const type: OscillatorType = i % 2 === 0 ? 'triangle' : 'sine';
      this.tone(this.sfxBus!, type, hz, hz * 1.01, t + i * 0.015, 0.32 + i * 0.03, 0.13, 0.004);
    }
    // Sweep of air for the "whoosh" of blocks vanishing
    this.noise(this.sfxBus!, 'bandpass', 1400 + lines * 400, 1.2, t, 0.22, 0.12);
    this.playSubBass();
    this.duckMusic(0.35, 0.3);
  }

  /** Multi-line clear: bigger chord plus a quick sparkle arpeggio on top */
  playCombo(lines: number, streak: number): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.playClear(lines, streak);
    const t = ctx.currentTime + 0.06;
    const base = Math.min(streak, 10) + 5;
    const count = 4 + Math.min(lines, 3);
    for (let i = 0; i < count; i++) {
      const hz = noteHz(degreeToSemitone(base + i) + 12);
      this.tone(this.sfxBus!, 'sine', hz, null, t + i * 0.045, 0.18, 0.09, 0.003);
    }
    this.duckMusic(0.5, 0.45);
  }

  /** Sub-bass thump for all combos/clears */
  playSubBass(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.tone(this.sfxBus!, 'sine', 70, 38, ctx.currentTime, 0.2, 0.32, 0.003);
  }

  /** Echo tail on long streaks */
  playComboReverb(streak: number): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    const hz = noteHz(degreeToSemitone(Math.min(streak, 10) + 4) + 12);
    for (let i = 1; i <= 3; i++) {
      this.tone(this.sfxBus!, 'sine', hz, hz * 0.8, t + i * 0.09, 0.16, 0.05 / i, 0.003);
    }
  }

  /** Whoosh: bandpass-filtered noise burst on fast placement */
  playWhoosh(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.noise(this.sfxBus!, 'bandpass', 2200, 1, ctx.currentTime, 0.06, 0.12);
  }

  /** Countdown tick sound */
  playTick(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.tone(this.sfxBus!, 'square', 1100, 800, ctx.currentTime, 0.045, 0.06, 0.002);
  }

  /** Urgent clock tick for the final seconds — pitch rises as time runs out */
  playUrgentTick(secondsLeft: number): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    const hz = 700 + (6 - Math.min(secondsLeft, 6)) * 90;
    this.tone(this.sfxBus!, 'square', hz, hz * 0.8, t, 0.05, 0.07, 0.002);
    this.tone(this.sfxBus!, 'sine', 90, 50, t, 0.09, 0.2, 0.002);
  }

  /** GO! chime sound */
  playGoChime(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    [0, 4, 7, 12].forEach((semi, i) => {
      this.tone(this.sfxBus!, 'triangle', noteHz(semi + 12), null, t + i * 0.03, 0.4, 0.1, 0.005);
    });
    this.noise(this.sfxBus!, 'highpass', 4000, 0.7, t, 0.25, 0.08);
  }

  /** Alert chime for critical time warnings */
  playAlertChime(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(this.sfxBus!, 'square', 880, null, t, 0.1, 0.07, 0.003);
    this.tone(this.sfxBus!, 'square', 1175, null, t + 0.11, 0.14, 0.07, 0.003);
  }

  /** Short rejected-action cue */
  playInvalid(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.tone(this.sfxBus!, 'square', 220, 110, ctx.currentTime, 0.1, 0.07, 0.003);
  }

  /** Neutral UI tap */
  playUiClick(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.tone(this.sfxBus!, 'sine', 900, 600, ctx.currentTime, 0.06, 0.08, 0.002);
  }

  /** Bright tier-up flourish */
  playTierUp(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    [0, 3, 7, 12, 15].forEach((semi, i) => {
      this.tone(this.sfxBus!, 'triangle', noteHz(semi + 12), null, t + i * 0.06, 0.3, 0.09, 0.004);
    });
    this.duckMusic(0.3, 0.4);
  }

  /** Personal best beaten: rising fanfare */
  playNewBest(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    const seq = [0, 7, 12, 19, 24];
    seq.forEach((semi, i) => {
      const hz = noteHz(semi);
      this.tone(this.sfxBus!, 'triangle', hz, null, t + i * 0.08, 0.45, 0.1, 0.005);
      this.tone(this.sfxBus!, 'sine', hz * 2, null, t + i * 0.08, 0.3, 0.05, 0.005);
    });
    this.noise(this.sfxBus!, 'highpass', 5000, 0.7, t + 0.3, 0.4, 0.07);
    this.duckMusic(0.5, 0.6);
  }

  /** Richer board-clear celebration */
  playBoardClear(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    const seq = [0, 3, 7, 10, 12, 15, 19, 24];
    seq.forEach((semi, i) => {
      const hz = noteHz(semi + 12);
      this.tone(this.sfxBus!, i % 2 === 0 ? 'triangle' : 'sine', hz, hz * 1.02, t + i * 0.05, 0.5, 0.09, 0.005);
    });
    this.noise(this.sfxBus!, 'highpass', 3000, 0.7, t, 0.6, 0.1);
    this.tone(this.sfxBus!, 'sine', 80, 40, t, 0.4, 0.3, 0.005);
    this.duckMusic(0.6, 0.8);
  }

  /** Streak break: descending sawtooth */
  playStreakBreak(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    this.tone(this.sfxBus!, 'sawtooth', 600, 180, ctx.currentTime, 0.22, 0.08, 0.003);
  }

  /** Game over sting */
  playGameOver(): void {
    const ctx = this.sfxReady();
    if (!ctx) return;
    const t = ctx.currentTime;
    const notes = [0, -2, -4, -9];
    notes.forEach((semi, i) => {
      const hz = noteHz(semi);
      this.tone(this.sfxBus!, 'triangle', hz, hz * 0.97, t + i * 0.17, 0.32, 0.13, 0.01);
      this.tone(this.sfxBus!, 'sine', hz / 2, hz / 2 * 0.97, t + i * 0.17, 0.32, 0.1, 0.01);
    });
    this.noise(this.sfxBus!, 'lowpass', 600, 0.7, t, 0.7, 0.15);
    this.duckMusic(1, 1.5);
  }

  // ── Music engine ──

  /** Whether gameplay currently wants music playing (set by start/stop) */
  private wantsMusic = false;

  /** Start the generative loop (no-op if music is disabled) */
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

  /** Stop the loop with a short fade */
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

  /**
   * Feed game state into the music every frame.
   *  - drainRate drives tempo (faster clock → faster beat)
   *  - streak and flow drive which layers are audible
   *  - timeFraction (0..1 of max) drives tension: the mix gets muffled and
   *    hurried as the clock runs down.
   */
  updateMusic(drainRate: number, streak: number, timeFraction: number, flow: number): void {
    if (!this.musicActive || !this.ctx) return;

    // Tempo: 100 BPM at a calm clock, up to ~138 when the drain is fierce
    const drainT = Math.max(0, Math.min(1, (drainRate - 0.7) / 0.9));
    const targetBpm = 100 + drainT * 30 + this.tension * 8;
    this.bpm += (targetBpm - this.bpm) * 0.05;
    if (this.arpDelay) {
      this.arpDelay.delayTime.setTargetAtTime(this.dottedEighth(), this.ctx.currentTime, 0.2);
    }

    // Intensity: streak + flow, smoothed
    const streakT = Math.min(streak / 8, 1);
    const target = Math.max(streakT, flow * 0.9, drainT * 0.45);
    this.intensity += (target - this.intensity) * (target > this.intensity ? 0.08 : 0.02);

    // Tension from low time
    const targetTension = timeFraction <= 0.3 ? 1 - timeFraction / 0.3 : 0;
    this.tension += (targetTension - this.tension) * 0.08;

    this.applyIntensity(false);
  }

  private applyIntensity(instant: boolean): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const tc = instant ? 0.01 : 0.35;
    const set = (g: GainNode | null, v: number) => {
      if (!g) return;
      g.gain.setTargetAtTime(v, now, tc);
    };
    const i = this.intensity;
    set(this.layerKick, 0.9);
    set(this.layerBass, 0.55 + i * 0.25);
    set(this.layerHat, i >= 0.2 ? 0.35 + i * 0.35 : 0);
    set(this.layerSnare, i >= 0.45 ? 0.5 : 0);
    set(this.layerArp, i >= 0.3 ? 0.35 + i * 0.4 : 0);
    set(this.layerPad, 0.3 + i * 0.45);

    if (this.musicFilter) {
      // Tension closes the filter: the world narrows as the clock runs out
      const f = 9000 - this.tension * 6500;
      this.musicFilter.frequency.setTargetAtTime(f, now, tc);
    }
  }

  private scheduleAhead(): void {
    if (!this.musicActive || !this.ctx) return;
    const ctx = this.ctx;
    while (this.nextStepTime < ctx.currentTime + SCHEDULE_AHEAD_SEC) {
      this.scheduleStep(this.step, this.nextStepTime);
      const sixteenth = 60 / this.bpm / 4;
      this.nextStepTime += sixteenth;
      this.step = (this.step + 1) % (STEPS_PER_BAR * BARS);
    }
  }

  private scheduleStep(globalStep: number, t: number): void {
    const bar = Math.floor(globalStep / STEPS_PER_BAR);
    const s = globalStep % STEPS_PER_BAR;
    const chord = PROGRESSION[bar];
    const i = this.intensity;
    const tense = this.tension > 0.4;

    // Kick: two-on-the-floor when calm, four when intense, gallop when tense
    const kickSteps = tense ? [0, 3, 6, 8, 11, 14] : i >= 0.35 ? [0, 4, 8, 12] : [0, 8];
    if (kickSteps.includes(s)) this.kick(t, s === 0 ? 1 : 0.85);

    // Snare / clap on the backbeat
    if (s === 4 || s === 12) this.snare(t);

    // Hats: 8ths, with 16ths sneaking in as intensity rises
    const offbeat = s % 4 === 2;
    const sixteenth = s % 2 === 1;
    if (offbeat || (sixteenth && i >= 0.6)) this.hat(t, offbeat ? 0.6 : 0.3);

    // Bass: syncopated root pattern
    const bassSteps = i >= 0.5 ? [0, 3, 6, 8, 11, 14] : [0, 6, 8, 14];
    if (bassSteps.includes(s)) {
      const octaveUp = (s === 6 || s === 14) && i >= 0.5;
      this.bass(t, 110 * Math.pow(2, (chord.bassRoot + (octaveUp ? 12 : 0)) / 12));
    }

    // Arpeggio: 8th notes walking through the chord pool
    if (s % 2 === 0) {
      const idx = Math.floor(s / 2) % chord.arp.length;
      const semi = chord.arp[idx] + 12;
      this.pluck(t, noteHz(semi));
    }

    // Pad: one chord per bar
    if (s === 0) this.pad(t, chord.pad, (60 / this.bpm) * 4);
  }

  // ── Instrument voices (music bus) ──

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
    // Click transient
    this.noise(this.layerKick!, 'highpass', 2500, 0.7, t, 0.015, 0.25 * vel);
  }

  private snare(t: number): void {
    this.noise(this.layerSnare!, 'bandpass', 1900, 0.8, t, 0.16, 0.5);
    this.tone(this.layerSnare!, 'triangle', 200, 120, t, 0.09, 0.3, 0.002);
  }

  private hat(t: number, vel: number): void {
    this.noise(this.layerHat!, 'highpass', 7500, 0.8, t, 0.045, 0.28 * vel);
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
    filter.frequency.setValueAtTime(900 + this.intensity * 600, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.22);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.42, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.layerBass!);
    osc.start(t);
    osc.stop(t + 0.3);
    // Sub layer for weight
    this.tone(this.layerBass!, 'sine', hz / 2, null, t, 0.2, 0.35, 0.004);
  }

  private pluck(t: number, hz: number): void {
    this.tone(this.layerArp!, 'triangle', hz, null, t, 0.22, 0.28, 0.003);
    this.tone(this.layerArp!, 'sine', hz * 2, null, t, 0.12, 0.08, 0.002);
  }

  private pad(t: number, semis: number[], duration: number): void {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1100;
    filter.Q.value = 0.5;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.09, t + 0.35);
    env.gain.setValueAtTime(0.09, t + duration - 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.1);
    filter.connect(env);
    env.connect(this.layerPad!);
    for (const semi of semis) {
      const hz = noteHz(semi);
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = hz;
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(t);
        osc.stop(t + duration + 0.15);
      }
    }
  }
}
