import { GRID_SIZE } from '../core/types';

/**
 * Music — the arithmetic behind what the game plays.
 *
 * The chord tables, the grid maths that lands a stinger on the beat, the
 * chord-tone ladders the stingers climb, the leitmotif, and the two curves the
 * mixer needs. Pure on purpose: no AudioContext, no DOM, no state, so every
 * decision here can be tested without a browser. AudioManager owns the graph,
 * the clock and the voices; this file owns the notes.
 */

// ── Scale and chords ──

/** A minor pentatonic, in semitones from the root */
export const PENTATONIC = [0, 3, 5, 7, 10];

/** Hz of the note `semitonesFromA3` above A3 (220 Hz) */
export function noteHz(semitonesFromA3: number): number {
  return 220 * Math.pow(2, semitonesFromA3 / 12);
}

/** Pentatonic degree → semitones. Degrees run past the octave and go negative. */
export function degreeToSemitone(degree: number): number {
  const octave = Math.floor(degree / PENTATONIC.length);
  const idx = ((degree % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length;
  return PENTATONIC[idx] + octave * 12;
}

export interface Chord {
  bassRoot: number;   // semitones from A2 (110 Hz)
  arp: number[];      // semitones from A3
  pad: number[];      // semitones from A3
}

export const SECTION_A: Chord[] = [
  { bassRoot: 0,  arp: [0, 3, 7, 12, 7, 3, 15, 12],  pad: [0, 3, 7] },
  { bassRoot: -4, arp: [-4, 0, 3, 8, 3, 0, 12, 8],   pad: [-4, 0, 3] },
  { bassRoot: 3,  arp: [3, 7, 10, 15, 10, 7, 19, 15], pad: [3, 7, 10] },
  { bassRoot: -2, arp: [-2, 2, 5, 10, 5, 2, 14, 10],  pad: [-2, 2, 5] },
];
export const SECTION_B: Chord[] = [
  { bassRoot: 0,  arp: [12, 7, 3, 0, 3, 7, 12, 15],   pad: [0, 3, 7, 12] },
  { bassRoot: 3,  arp: [15, 10, 7, 3, 7, 10, 15, 19], pad: [3, 7, 10, 15] },
  { bassRoot: -2, arp: [14, 10, 5, 2, 5, 10, 14, 17], pad: [-2, 2, 5, 10] },
  { bassRoot: -4, arp: [12, 8, 3, 0, 3, 8, 12, 15],   pad: [-4, 0, 3, 8] },
];

export const STEPS_PER_BAR = 16;
export const BARS_PER_SECTION = 4;
export const LOOP_STEPS = STEPS_PER_BAR * BARS_PER_SECTION * 2;

/**
 * Which chord is sounding on a given step of the loop — the one thing a
 * stinger has to know to stay in key. Wraps, and takes negative steps, so a
 * caller can ask about a moment just before the sequencer's next step.
 */
export function chordAt(globalStep: number): Chord {
  const step = ((Math.floor(globalStep) % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS;
  const section = step >= STEPS_PER_BAR * BARS_PER_SECTION ? SECTION_B : SECTION_A;
  const bar = Math.floor(step / STEPS_PER_BAR) % BARS_PER_SECTION;
  return section[bar];
}

/**
 * The semitone offsets a chord's tones sit at, relative to its root: root,
 * third and fifth, read off the pad voicing so the tables stay the single
 * source of the harmony. The ninth is folded down to a second, which is where
 * a run actually wants it — between the root and the third, not above the
 * octave.
 */
export function chordIntervals(chord: Chord, withNinth: boolean = false): number[] {
  const set = new Set<number>();
  for (const semi of chord.pad) set.add((((semi - chord.bassRoot) % 12) + 12) % 12);
  if (withNinth) set.add(2);
  return [...set].sort((a, b) => a - b);
}

/** The A3-relative semitone the runs are voiced from: an octave above the pad */
const RUN_OCTAVE = 12;

/**
 * A ladder of the chord's own tones in Hz, ascending, spanning `octaves` and
 * closed by the octave above the top one — what a claim run climbs instead of
 * a fixed scale, so the run is in the harmony it lands on.
 */
export function chordTones(chord: Chord, octaves: number, withNinth: boolean = false): number[] {
  const intervals = chordIntervals(chord, withNinth);
  const root = chord.bassRoot + RUN_OCTAVE;
  const span = Math.max(1, Math.floor(octaves));
  const out: number[] = [];
  for (let o = 0; o < span; o++) {
    for (const i of intervals) out.push(noteHz(root + i + o * 12));
  }
  out.push(noteHz(root + span * 12));
  return out;
}

// ── Quantisation ──

/**
 * How far ahead of `now` a stinger has to be scheduled. Anything closer is a
 * race with the audio thread, and a note scheduled in the past plays late and
 * out of time.
 */
export const GRID_LATENCY = 0.01;

/**
 * The next sixteenth-note boundary at or after `now + latency`.
 *
 * The sequencer only knows when its *next* step falls, and that can be up to a
 * step away in either direction from the moment a claim lands, so the grid is
 * extended backwards from `nextStepTime` as well as forwards: a stinger fired
 * just after a step waits for the following one, not the one after that.
 */
export function nextGridTime(
  now: number,
  nextStepTime: number,
  stepSeconds: number,
  latency: number = GRID_LATENCY,
): number {
  const target = now + latency;
  if (!Number.isFinite(nextStepTime) || !(stepSeconds > 0)) return target;
  // The epsilon keeps a boundary the caller has landed exactly on from being
  // pushed a whole step by floating-point dust.
  const steps = Math.ceil((target - nextStepTime) / stepSeconds - 1e-9);
  return nextStepTime + steps * stepSeconds;
}

// ── Stereo image ──

/** How far off centre the edges of the board are placed */
export const PAN_WIDTH = 0.5;

/** Board column → pan, -PAN_WIDTH at the left edge and +PAN_WIDTH at the right */
export function panForColumn(col: number, columns: number = GRID_SIZE): number {
  const last = Math.max(1, columns - 1);
  const t = Math.max(0, Math.min(1, col / last));
  return (t - 0.5) * 2 * PAN_WIDTH;
}

// ── Mixer curves ──

/** What the SFX bus ran at before there were sliders */
export const SFX_BASE_GAIN = 1;
/** What the music bus ran at before there were sliders */
export const MUSIC_BASE_GAIN = 0.7;

/**
 * Slider position → bus gain. Squared, because loudness is not linear in
 * amplitude: a linear knob spends its whole top half barely changing anything
 * and its bottom quarter going from quiet to off.
 */
export function volumeToGain(volume: number, fullScale: number = 1): number {
  const v = Math.max(0, Math.min(1, volume));
  return v * v * fullScale;
}

/**
 * The gain a bus runs at with the slider all the way up, chosen so the
 * *default* slider position reproduces exactly what the bus used to run at.
 * The mix the game shipped with is the middle of the knob, not the ceiling.
 */
export function busFullScale(baseGain: number, defaultVolume: number): number {
  return defaultVolume > 0 ? baseGain / (defaultVolume * defaultVolume) : baseGain;
}

// ── Stinger headroom ──

/** Summed stinger gain the mix will take before it starts turning things down */
export const STINGER_GAIN_CAP = 1;
/** Stingers this close together are heard as one hit, so they share the cap */
export const STINGER_WINDOW_SEC = 0.05;

/** A stinger's claim on the output: when it starts and how loud it asked to be */
export interface StingerLoad {
  time: number;
  gain: number;
}

/**
 * How much to turn down a stinger about to be scheduled, given what is already
 * booked around it. A double close that completes a survey and crosses a tier
 * fires three stingers on one frame; unchecked they sum straight into the
 * limiter and the whole mix pumps. Each new one gets quieter as the frame
 * fills up. The limiter is still the hard backstop — this is what keeps it
 * from having to work.
 */
export function stingerScale(
  booked: readonly StingerLoad[],
  time: number,
  gain: number,
  cap: number = STINGER_GAIN_CAP,
  window: number = STINGER_WINDOW_SEC,
): number {
  let sum = 0;
  for (const b of booked) {
    if (Math.abs(b.time - time) < window) sum += b.gain;
  }
  const total = sum + gain;
  return total > cap ? cap / total : 1;
}

// ── Leitmotif ──

/** One note of a motif: when it starts and how long it lasts, in sixteenths */
export interface MotifNote {
  at: number;
  /** Index into chordTones(chord, 3) */
  tone: number;
  len: number;
}

/**
 * The tier-up leitmotif: the same seven notes every time, transposed into
 * whichever chord is sounding. Root, fifth, octave, fifth, tenth, twelfth,
 * then the double octave held through the second bar — a phrase rather than a
 * flourish, so that crossing a tier becomes something a player recognises
 * before they have read the card.
 */
export const TIER_MOTIF: readonly MotifNote[] = [
  { at: 0,  tone: 0, len: 2 },
  { at: 2,  tone: 2, len: 2 },
  { at: 4,  tone: 3, len: 3 },
  { at: 8,  tone: 2, len: 2 },
  { at: 10, tone: 4, len: 2 },
  { at: 12, tone: 5, len: 3 },
  { at: 16, tone: 6, len: 8 },
];
