import { describe, it, expect } from 'vitest';
import { DIFFICULTY_CONFIGS } from '../src/core/Config';
import { dailyKey, dailySeed } from '../src/core/Daily';
import { drainIntegral, simulateRun, verifyScore } from '../src/core/Replay';
import { PROGRESS_TIERS } from '../src/core/Progression';
import { RULES_VERSION } from '../src/core/Rules';
import { GRID_SIZE, MAX_REPLAY_MOVES, Move, Replay } from '../src/core/types';
import { playBotRun } from './helpers';

/**
 * Server-side score validation: a run is re-played from its seed and its
 * inputs, with the game's own rules, and only a score that comes out the same
 * is real.
 *
 * Unlike the rest of `tests/`, nothing here sets the board by hand. A replay
 * carries inputs, not positions, so the only run it can prove is one that was
 * actually played — `playBotRun` is that player.
 */

const CLASSIC_ARCHITECT = PROGRESS_TIERS.classic[2].minScore;

function round3(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** Move `at` from `index` onward by `delta` seconds: the same run, sat on */
function shiftFrom(moves: Move[], index: number, delta: number): Move[] {
  return moves.map((m, i) => (i < index ? m : { ...m, at: round3(m.at + delta) }));
}

describe('a real run re-plays to the same score', () => {
  const run = playBotRun('classic', 1, 120);

  it('was a run worth verifying: rotations, a hold, echoes, relit floor, a tier crossed', () => {
    const placements = run.replay.moves.filter(m => m.t === 'p');
    expect(placements.length).toBeGreaterThan(100);

    // A hold, recorded as its own input
    expect(run.replay.moves.some(m => m.t === 'h')).toBe(true);
    expect(run.gs.holds).toBe(1);

    // Pieces were turned before they were dropped: the rotation index the
    // move carries is what the simulation has to reproduce
    expect(new Set(placements.map(m => (m.t === 'p' ? m.rot : -1))).size).toBeGreaterThan(1);

    // A claim closed against a ghost wall, inside the echo window
    const echoed = run.events.filter(ev =>
      ev.some(e => e.type === 'claim' && (e.scoreBreakdown?.echoMultiplier ?? 1) > 1));
    expect(echoed.length).toBeGreaterThan(0);

    // A claim paid less because it was built back over lit floor
    const relit = run.events.filter(ev =>
      ev.some(e => e.type === 'claim' && (e.scoreBreakdown?.territoryFactor ?? 1) < 1));
    expect(relit.length).toBeGreaterThan(0);

    // And the score crossed into ARCHITECT — the first tier that deals a
    // different bag — with well over a bag's worth of run still to come, so
    // the tighter mix was actually dealt and has to be reproduced
    const crossed = run.events.findIndex(ev =>
      (ev.find(e => e.type === 'claim')?.scoreBreakdown?.totalScore ?? 0) >= CLASSIC_ARCHITECT);
    expect(crossed).toBeGreaterThan(-1);
    expect(run.events.length - crossed).toBeGreaterThan(24);
  });

  it('re-plays from seed and moves to exactly the score that was played', () => {
    const result = simulateRun(run.replay);
    expect(result.reason).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(result.score).toBe(run.score);
    expect(result.moves).toBe(run.replay.moves.length);
  });

  it('re-plays a Blitz run and a finished Daily too', () => {
    const blitz = playBotRun('blitz', 2, 90);
    expect(simulateRun(blitz.replay)).toMatchObject({ valid: true, score: blitz.score });

    // The Daily runs out of pieces rather than time, and ends 'complete'
    const daily = playBotRun('daily', dailySeed(dailyKey()), 40);
    expect(daily.gs.deathCause).toBe('complete');
    expect(simulateRun(daily.replay)).toMatchObject({
      valid: true, score: daily.score, endCause: 'complete',
    });
  });
});

describe('what the simulation refuses', () => {
  const run = playBotRun('classic', 3, 20);

  it('refuses a score that is not the one the rules produce', () => {
    expect(verifyScore(run.replay, run.score)).toMatchObject({ valid: true });
    for (const claimed of [run.score + 1, run.score - 1, run.score * 10]) {
      const result = verifyScore(run.replay, claimed);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('score');
      // The real score still comes back, which is what makes the log useful
      expect(result.score).toBe(run.score);
    }
  });

  it('refuses a placement on an occupied cell', () => {
    // Whatever is in hand at the end of the run, dropped somewhere it cannot go
    const piece = run.gs.current;
    expect(piece).not.toBeNull();
    let clash: { row: number; col: number } | null = null;
    for (let row = 0; row + piece!.rows <= GRID_SIZE && !clash; row++) {
      for (let col = 0; col + piece!.cols <= GRID_SIZE && !clash; col++) {
        if (!run.gs.board.canPlace(piece!.shape, row, col)) clash = { row, col };
      }
    }
    expect(clash).not.toBeNull();

    const last = run.replay.moves[run.replay.moves.length - 1];
    const moves: Move[] = [
      ...run.replay.moves,
      { t: 'p', row: clash!.row, col: clash!.col, rot: piece!.rotation, at: round3(last.at + 0.4) },
    ];
    const result = simulateRun({ ...run.replay, moves });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('move');
    // It got all the way to the forged move before refusing it
    expect(result.moves).toBe(run.replay.moves.length);
  });

  it('refuses a rotation no piece has, and a move that goes backwards', () => {
    const moves = [...run.replay.moves];
    const i = moves.findIndex(m => m.t === 'p');
    const target = moves[i];
    if (target.t !== 'p') throw new Error('expected a placement');

    // No piece has more than four rotations, so this one can never be turned
    // to match: the loop is bounded and gives up rather than spinning.
    moves[i] = { ...target, rot: 7 };
    expect(simulateRun({ ...run.replay, moves }).reason).toBe('move');

    // Time cannot run backwards
    const rewound = [...run.replay.moves];
    const lastIndex = rewound.length - 1;
    rewound[lastIndex] = { ...rewound[lastIndex], at: 0 };
    expect(simulateRun({ ...run.replay, moves: rewound }).reason).toBe('move');

    // And a coordinate that is not a cell is refused rather than indexed:
    // the board would throw on a fractional row rather than say no.
    for (const bad of [{ row: 0.5 }, { row: -1 }, { col: 9 }, { col: Number.NaN }]) {
      const hostile = [...run.replay.moves];
      hostile[i] = { ...target, ...bad };
      expect(simulateRun({ ...run.replay, moves: hostile }).reason).toBe('move');
    }
  });

  it('refuses a run that sat still until the clock must have been gone', () => {
    // The same moves, spaced as they were played: fine
    expect(simulateRun(run.replay)).toMatchObject({ valid: true, score: run.score });

    // Twenty seconds of thinking before the first piece is affordable out of
    // a sixty-second bank. Every gap after it is untouched, so the run plays
    // out identically — which is what says the clock rule has a threshold
    // rather than a distaste for slow players.
    expect(simulateRun({ ...run.replay, moves: shiftFrom(run.replay.moves, 0, 20) }))
      .toMatchObject({ valid: true, score: run.score });

    // Classic banks at most 90 s. Resume 90 s past even a full bank and the
    // run was over long before the next piece landed.
    const dead = DIFFICULTY_CONFIGS.classic.timer.maxSeconds + 90;
    const stalled = simulateRun({ ...run.replay, moves: shiftFrom(run.replay.moves, 10, dead) });
    expect(stalled.valid).toBe(false);
    expect(stalled.reason).toBe('clock');
    // It ran the first ten moves and only then found the bank gone
    expect(stalled.moves).toBe(10);

    // The same gap before the very first move is just as dead
    expect(simulateRun({ ...run.replay, moves: shiftFrom(run.replay.moves, 0, dead) }))
      .toMatchObject({ valid: false, reason: 'clock', moves: 0 });
  });

  it('refuses a daily whose seed is not its date', () => {
    const key = dailyKey();
    const daily = playBotRun('daily', dailySeed(key), 10);
    expect(simulateRun(daily.replay)).toMatchObject({ valid: true });

    expect(simulateRun({ ...daily.replay, seed: dailySeed(key) + 1 }).reason).toBe('seed');
    expect(simulateRun({ ...daily.replay, dailyKey: '2020-01-01' }).reason).toBe('seed');
    expect(simulateRun({ ...daily.replay, dailyKey: undefined }).reason).toBe('seed');
    expect(simulateRun({ ...daily.replay, dailyKey: 'yesterday' }).reason).toBe('seed');
  });

  it('refuses another rules version outright', () => {
    for (const rules of [RULES_VERSION - 1, RULES_VERSION + 1, 0]) {
      const result = simulateRun({ ...run.replay, rules });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('rules');
    }
  });

  it('refuses a mode that does not exist and a log longer than the cap', () => {
    const bogus = { ...run.replay, mode: 'zen' } as unknown as Replay;
    expect(simulateRun(bogus).reason).toBe('shape');

    const tooMany = { ...run.replay, moves: new Array(MAX_REPLAY_MOVES + 1).fill(run.replay.moves[0]) };
    expect(simulateRun(tooMany).reason).toBe('shape');
  });
});

describe('the reconstructed clock', () => {
  /**
   * The drain rate is a straight line into a cap, so the bank between two
   * moves is a trapezoid plus a rectangle. If the closed form and a fine
   * numeric integration ever disagree, every timed run is being judged
   * against the wrong number.
   */
  function numericIntegral(timer: typeof DIFFICULTY_CONFIGS.classic.timer, t0: number, t1: number): number {
    const h = 0.001;
    const steps = Math.round((t1 - t0) / h);
    const rate = (t: number) => Math.min(timer.drainCap, 1 + (t / 60) * timer.drainAccelPerMinute);
    let sum = 0;
    for (let i = 0; i < steps; i++) {
      const a = t0 + i * h;
      sum += ((rate(a) + rate(a + h)) / 2) * h;
    }
    return sum;
  }

  it('matches a fine numeric integration for Classic and Blitz, cap included', () => {
    for (const mode of ['classic', 'blitz'] as const) {
      const timer = DIFFICULTY_CONFIGS[mode].timer;
      const capAt = ((timer.drainCap - 1) / timer.drainAccelPerMinute) * 60;
      const spans: [number, number][] = [
        [0, 10],
        [0, 60],
        [12.5, 47.25],
        // Entirely below the cap, straddling it, and entirely above it
        [0, capAt - 20],
        [capAt - 30, capAt + 30],
        [capAt + 10, capAt + 100],
        [0, 400],
      ];
      for (const [t0, t1] of spans) {
        const analytic = drainIntegral(timer, t0, t1);
        const numeric = numericIntegral(timer, t0, t1);
        expect(Math.abs(analytic - numeric)).toBeLessThan(1e-6);
      }
    }
  });

  it('is zero for an empty or backwards span, and flat when nothing accelerates', () => {
    const timer = DIFFICULTY_CONFIGS.classic.timer;
    expect(drainIntegral(timer, 5, 5)).toBe(0);
    expect(drainIntegral(timer, 9, 4)).toBe(0);
    // The Daily's timer never accelerates. Its clock is off, so nothing reads
    // this, but a rate of exactly 1 is the only answer that is not a surprise.
    expect(drainIntegral(DIFFICULTY_CONFIGS.daily.timer, 0, 30)).toBeCloseTo(30, 10);
  });
});

describe('the six-hundred move cap', () => {
  // One long run, used twice: the cap, and what a full-length replay costs.
  const run = playBotRun('classic', 9, MAX_REPLAY_MOVES + 1);

  it('records up to the cap, marks the run, and refuses to validate it', () => {
    expect(run.replay.moves.length).toBe(MAX_REPLAY_MOVES);
    expect(run.replay.truncated).toBe(true);
    expect(simulateRun(run.replay).reason).toBe('shape');
  });

  it('simulates a full-length replay fast enough for an edge function', () => {
    // The same six hundred moves without the mark: a real prefix of the run,
    // which is what makes this an honest measurement rather than an early exit
    const full: Replay = { ...run.replay, truncated: undefined };
    const started = performance.now();
    const result = simulateRun(full);
    const elapsed = performance.now() - started;

    expect(result.valid).toBe(true);
    expect(result.moves).toBe(MAX_REPLAY_MOVES);
    // Measured at 8–12 ms on a laptop; the bound is loose so a slow CI box
    // does not fail the build, but a hundredfold regression will.
    expect(elapsed).toBeLessThan(500);
  });
});
