import { describe, it, expect } from 'vitest';
import {
  BARS_PER_SECTION, GRID_LATENCY, LOOP_STEPS, MUSIC_BASE_GAIN, PAN_WIDTH, SECTION_A, SECTION_B,
  SFX_BASE_GAIN, STEPS_PER_BAR, STINGER_GAIN_CAP, StingerLoad, TIER_MOTIF, busFullScale, chordAt,
  chordIntervals, chordTones, nextGridTime, noteHz, panForColumn, stingerScale, volumeToGain,
} from '../src/audio/Music';
import { DEFAULT_MUSIC_VOLUME, DEFAULT_SFX_VOLUME } from '../src/core/Settings';

/**
 * The music maths, on its own. None of this touches an AudioContext, which is
 * the point of the module: what a stinger plays and when it plays is decided
 * here, and can be checked here.
 */

describe('nextGridTime', () => {
  const STEP = 0.15; // a sixteenth at 100 BPM

  it('returns the next boundary at or after now + latency', () => {
    const t = nextGridTime(1.0, 1.05, STEP);
    expect(t).toBe(1.05);
    expect(t).toBeGreaterThanOrEqual(1.0 + GRID_LATENCY);
  });

  it('never returns a boundary the latency has already passed', () => {
    // 1.05 is a boundary but it is inside the latency window, so the grid moves on
    const t = nextGridTime(1.045, 1.05, STEP, 0.01);
    expect(t).toBeCloseTo(1.2, 10);
  });

  it('returns the boundary itself when now lands exactly on one', () => {
    expect(nextGridTime(1.05, 1.05, STEP, 0)).toBeCloseTo(1.05, 10);
    // and on a boundary reached by stepping forward from nextStepTime
    expect(nextGridTime(1.65, 1.05, STEP, 0)).toBeCloseTo(1.65, 10);
  });

  it('extends the grid backwards when nextStepTime is still ahead', () => {
    // The sequencer's next step is 1.2; a stinger at 0.9 must not wait for it
    expect(nextGridTime(0.88, 1.2, STEP)).toBeCloseTo(0.9, 10);
  });

  it('handles a nextStepTime in the past', () => {
    const t = nextGridTime(5.0, 1.05, STEP);
    expect(t).toBeGreaterThanOrEqual(5.0 + GRID_LATENCY);
    expect(t - STEP).toBeLessThan(5.0 + GRID_LATENCY);
    // Still on the grid the sequencer is running
    expect(((t - 1.05) / STEP) % 1).toBeCloseTo(0, 6);
  });

  it('stays on the grid for a run of calls at 140 BPM', () => {
    const step = 60 / 140 / 4;
    for (let i = 0; i < 50; i++) {
      const now = 0.37 + i * 0.031;
      const t = nextGridTime(now, 1.05, step);
      expect(t).toBeGreaterThanOrEqual(now + GRID_LATENCY);
      expect(t - now).toBeLessThanOrEqual(step + GRID_LATENCY + 1e-9);
    }
  });

  it('falls back to now + latency without a usable step length', () => {
    expect(nextGridTime(2, 1, 0)).toBeCloseTo(2 + GRID_LATENCY, 10);
    expect(nextGridTime(2, Number.NaN, 0.15)).toBeCloseTo(2 + GRID_LATENCY, 10);
  });
});

describe('chordAt', () => {
  it('walks section A then section B, a bar at a time', () => {
    expect(chordAt(0)).toBe(SECTION_A[0]);
    expect(chordAt(STEPS_PER_BAR)).toBe(SECTION_A[1]);
    expect(chordAt(STEPS_PER_BAR * BARS_PER_SECTION)).toBe(SECTION_B[0]);
    expect(chordAt(STEPS_PER_BAR * (BARS_PER_SECTION + 2))).toBe(SECTION_B[2]);
  });

  it('wraps the loop and accepts steps before it', () => {
    expect(chordAt(LOOP_STEPS)).toBe(SECTION_A[0]);
    expect(chordAt(-1)).toBe(SECTION_B[BARS_PER_SECTION - 1]);
  });
});

describe('chordTones', () => {
  const ALL = [...SECTION_A, ...SECTION_B];

  it('returns only tones of the chord, in every chord of both sections', () => {
    for (const chord of ALL) {
      const allowed = chordIntervals(chord);
      const root = noteHz(chord.bassRoot + 12);
      for (const hz of chordTones(chord, 2)) {
        const semis = Math.round(Math.log2(hz / root) * 12);
        expect(allowed).toContain(((semis % 12) + 12) % 12);
      }
    }
  });

  it('stays inside the octaves it was asked for, and climbs', () => {
    for (const chord of ALL) {
      for (const octaves of [1, 2, 3]) {
        const root = noteHz(chord.bassRoot + 12);
        const tones = chordTones(chord, octaves);
        expect(tones[0]).toBeCloseTo(root, 6);
        expect(tones[tones.length - 1]).toBeCloseTo(root * Math.pow(2, octaves), 6);
        for (const hz of tones) {
          expect(hz).toBeGreaterThanOrEqual(root - 1e-9);
          expect(hz).toBeLessThanOrEqual(root * Math.pow(2, octaves) + 1e-9);
        }
        for (let i = 1; i < tones.length; i++) expect(tones[i]).toBeGreaterThan(tones[i - 1]);
      }
    }
  });

  it('adds the ninth only when it is asked for', () => {
    for (const chord of ALL) {
      expect(chordIntervals(chord, false)).not.toContain(2);
      expect(chordIntervals(chord, true)).toContain(2);
      const plain = chordTones(chord, 2);
      const ninth = chordTones(chord, 2, true);
      // One extra rung per octave, and every plain tone is still there
      expect(ninth.length).toBe(plain.length + 2);
      for (const hz of plain) {
        expect(ninth.some(h => Math.abs(h - hz) < 1e-9)).toBe(true);
      }
    }
  });

  it('reads the third off the pad voicing rather than assuming minor', () => {
    // Am is the only minor chord in the tables; F, C and G are major
    expect(chordIntervals(SECTION_A[0])).toEqual([0, 3, 7]);
    expect(chordIntervals(SECTION_A[1])).toEqual([0, 4, 7]);
    expect(chordIntervals(SECTION_B[2])).toEqual([0, 4, 7]);
  });

  it('gives the leitmotif every rung it reaches for', () => {
    const highest = Math.max(...TIER_MOTIF.map(n => n.tone));
    for (const chord of [...SECTION_A, ...SECTION_B]) {
      expect(chordTones(chord, 3).length).toBeGreaterThan(highest);
    }
  });
});

describe('panForColumn', () => {
  it('spreads the board across the stereo field', () => {
    expect(panForColumn(0)).toBeCloseTo(-PAN_WIDTH, 10);
    expect(panForColumn(4)).toBeCloseTo(0, 10);
    expect(panForColumn(8)).toBeCloseTo(PAN_WIDTH, 10);
  });

  it('clamps a column off the board', () => {
    expect(panForColumn(-3)).toBeCloseTo(-PAN_WIDTH, 10);
    expect(panForColumn(99)).toBeCloseTo(PAN_WIDTH, 10);
  });
});

describe('volumeToGain', () => {
  it('is silent at 0 and unity at 1', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBe(1);
  });

  it('is monotonic across the range', () => {
    let previous = -1;
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const gain = volumeToGain(v);
      expect(gain).toBeGreaterThan(previous);
      previous = gain;
    }
  });

  it('clamps out-of-range values instead of inverting or exploding', () => {
    expect(volumeToGain(-1)).toBe(0);
    expect(volumeToGain(4)).toBe(1);
  });

  it('reproduces the bus gains the game shipped with at the default volumes', () => {
    // Before the sliders existed the SFX bus ran at 1 and the music bus at 0.7
    expect(volumeToGain(DEFAULT_SFX_VOLUME, busFullScale(SFX_BASE_GAIN, DEFAULT_SFX_VOLUME)))
      .toBeCloseTo(SFX_BASE_GAIN, 10);
    expect(volumeToGain(DEFAULT_MUSIC_VOLUME, busFullScale(MUSIC_BASE_GAIN, DEFAULT_MUSIC_VOLUME)))
      .toBeCloseTo(MUSIC_BASE_GAIN, 10);
  });

  it('leaves headroom above the default and can still be turned off', () => {
    const full = busFullScale(SFX_BASE_GAIN, DEFAULT_SFX_VOLUME);
    expect(volumeToGain(1, full)).toBeGreaterThan(SFX_BASE_GAIN);
    expect(volumeToGain(0, full)).toBe(0);
  });
});

describe('stingerScale', () => {
  /** Book stingers one after another the way AudioManager does */
  function bookAll(gains: number[], time: number = 10): number[] {
    const booked: StingerLoad[] = [];
    return gains.map(gain => {
      const scale = stingerScale(booked, time, gain);
      booked.push({ time, gain: gain * scale });
      return scale;
    });
  }

  it('leaves a stinger under the cap alone', () => {
    expect(stingerScale([], 10, 0.55)).toBe(1);
    expect(stingerScale([{ time: 10, gain: 0.3 }], 10, 0.5)).toBe(1);
  });

  it('turns down three overlapping stingers, each further than the last', () => {
    const gains = [0.55, 0.55, 0.55];
    const scales = bookAll(gains);
    expect(scales[0]).toBe(1);
    expect(scales[1]).toBeLessThan(scales[0]);
    expect(scales[2]).toBeLessThan(scales[1]);
    // Each one on its own is well below the cap...
    scales.forEach((scale, i) => expect(scale * gains[i]).toBeLessThan(STINGER_GAIN_CAP));
    // ...and together they play much quieter than they asked to
    const asked = gains.reduce((a, b) => a + b, 0);
    const played = scales.reduce((sum, scale, i) => sum + scale * gains[i], 0);
    expect(played).toBeLessThan(asked);
    expect(played).toBeLessThan(STINGER_GAIN_CAP * 1.5);
  });

  it('holds the real triple-stinger frame near the cap', () => {
    // A double close that completes a survey and crosses a tier, on one frame
    const gains = [0.55, 0.45, 0.4];
    const scales = bookAll(gains);
    scales.forEach((scale, i) => expect(scale).toBeLessThanOrEqual(scales[Math.max(0, i - 1)]));
    expect(scales[2]).toBeLessThan(1);
    const played = scales.reduce((sum, scale, i) => sum + scale * gains[i], 0);
    expect(played).toBeLessThan(gains.reduce((a, b) => a + b, 0));
    expect(played).toBeLessThan(STINGER_GAIN_CAP * 1.5);
  });

  it('never scales up or goes negative', () => {
    for (const scale of bookAll([0.9, 0.9, 0.9, 0.9])) {
      expect(scale).toBeGreaterThan(0);
      expect(scale).toBeLessThanOrEqual(1);
    }
  });

  it('ignores stingers outside the window', () => {
    const old: StingerLoad[] = [{ time: 9.0, gain: 0.9 }];
    expect(stingerScale(old, 10, 0.9)).toBe(1);
  });
});
