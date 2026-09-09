import { describe, it, expect } from 'vitest';
import { Difficulty, DIFFICULTY_CONFIGS } from '../src/core/Config';
import { dailyKey, dailySeed } from '../src/core/Daily';
import { GameState } from '../src/core/GameState';
import { drainIntegral, simulateRun, verifyScore } from '../src/core/Replay';
import { PROGRESS_TIERS } from '../src/core/Progression';
import { mulberry32 } from '../src/core/Random';
import { RULES_VERSION } from '../src/core/Rules';
import { GRID_SIZE, MAX_REPLAY_MOVES, Move, Replay } from '../src/core/types';
import { playBestMove, playBotRun } from './helpers';

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

  it('refuses a daily that does not say which day it is', () => {
    const key = dailyKey();
    const daily = playBotRun('daily', dailySeed(key), 10);
    expect(simulateRun(daily.replay)).toMatchObject({ valid: true });

    expect(simulateRun({ ...daily.replay, dailyKey: undefined }).reason).toBe('seed');
    expect(simulateRun({ ...daily.replay, dailyKey: 'yesterday' }).reason).toBe('seed');
    expect(simulateRun({ ...daily.replay, dailyKey: '2026-02-30' }).reason).toBe('seed');

    // What is deliberately NOT refused here any more: a seed that is not the
    // one the date hashes to. The daily's deal comes from an HMAC under the
    // server's secret now, so that a future puzzle cannot be dealt and
    // studied offline — and a module with no secret cannot check it. The
    // seed is bound to the day by the run ticket, in api/leaderboard.ts,
    // and there is a test there for exactly that.
    const otherSeed = simulateRun({ ...daily.replay, seed: dailySeed(key) + 1 });
    expect(otherSeed.reason).not.toBe('seed');
    // A different deal deals different pieces, so the log stops making sense
    // at the first placement that no longer fits.
    expect(otherSeed.valid).toBe(false);

    // Another day's key, with this day's deal, is likewise the ticket's
    // business: the simulation only insists the key is a real date.
    expect(simulateRun({ ...daily.replay, dailyKey: '2020-01-01' }))
      .toMatchObject({ valid: true, score: daily.score });
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

describe('a claim taken at the edge of an echo window', () => {
  /**
   * The run this needs cannot be found by playing normally: it has to be
   * aimed. Each move waits until the tightest ghost wall standing has fifty
   * microseconds of life left and then places, so every claim in it is
   * decided a hair inside an expiry — the one comparison where a client and
   * a server can disagree about what the board even looked like.
   */
  const EDGE_MARGIN = 0.00005;
  let edgeLandings = 0;

  const edge = playBotRun('classic', 5, 60, {
    step: (_i, gs) => {
      const live = gs.echoWalls().map(w => w.remaining).filter(r => r > EDGE_MARGIN * 2);
      if (live.length === 0) return 0.3;
      edgeLandings++;
      return Math.min(...live) - EDGE_MARGIN;
    },
  });

  it('was a run worth verifying: claims decided inside the last millisecond', () => {
    expect(edgeLandings).toBeGreaterThan(5);
    expect(edge.replay.moves.length).toBe(60);
    // Move times are recorded as they were, not rounded to the millisecond
    const offGrid = edge.replay.moves.filter(
      m => Math.abs(m.at * 1000 - Math.round(m.at * 1000)) > 1e-9);
    expect(offGrid.length).toBeGreaterThan(40);
    // And the ghosts were doing work: claims closed against them and paid
    const echoed = edge.events.filter(ev =>
      ev.some(e => e.type === 'claim' && (e.scoreBreakdown?.echoMultiplier ?? 1) > 1));
    expect(echoed.length).toBeGreaterThan(0);
  });

  it('re-simulates to exactly the score it was played for', () => {
    expect(simulateRun(edge.replay)).toMatchObject({ valid: true, score: edge.score });
  });

  it('would not survive the millisecond rounding the log used to carry', () => {
    // What the old recording did to those times. A ghost with fifty
    // microseconds left is rounded either side of its own expiry, the claim
    // it was holding up goes a different way, and the run stops matching the
    // board a few moves later.
    const rounded = edge.replay.moves.map(m => ({ ...m, at: round3(m.at) }));
    const result = simulateRun({ ...edge.replay, moves: rounded });
    expect(result.valid && result.score === edge.score).toBe(false);
  });
});

describe('a run the browser ticked a frame at a time', () => {
  /**
   * The case the fix is really for. A browser reaches a move's time by adding
   * up sixty frames a second; a simulation adding up the gaps between moves
   * lands on a different double. Here the run is played frame by frame AND
   * aimed at the edge of each echo window, so both halves of the
   * disagreement are in play at once.
   */
  const framed = playBotRun('classic', 13, 60, {
    frameSeconds: 1 / 60,
    step: (_i, gs) => {
      const live = gs.echoWalls().map(w => w.remaining).filter(r => r > 0.0002);
      return live.length > 0 ? Math.min(...live) - 0.0001 : 0.3;
    },
  });

  it('lands moves inside the last millisecond of a ghost wall', () => {
    // The frame loop cannot land exactly where it aimed, which is the point:
    // these are the margins a real client produces.
    expect(framed.replay.moves.length).toBeGreaterThan(40);
    const claims = framed.events.filter(ev => ev.some(e => e.type === 'claim'));
    expect(claims.length).toBeGreaterThan(3);
  });

  it('re-plays to exactly the score the frames produced', () => {
    expect(simulateRun(framed.replay)).toMatchObject({ valid: true, score: framed.score });

    // And would not have, on the millisecond grid the log used to be
    // recorded on: 45 claims, and the ghosts holding them up land either
    // side of their own expiry once the times are rounded.
    const rounded = framed.replay.moves.map(m => ({ ...m, at: round3(m.at) }));
    const result = simulateRun({ ...framed.replay, moves: rounded });
    expect(result.valid && result.score === framed.score).toBe(false);
  });
});

/**
 * The bonus the simulation credits at each placement.
 *
 * `simulateRun` folds these into the reconstructed bank and never reports
 * them, so this drives the same GameState the same way it does —
 * `advanceClockTo` the recorded time, turn the piece, place it — and reads
 * the awards off the events. It is the simulation's own arithmetic rather
 * than a second implementation of it.
 */
function replayedBonuses(replay: Replay): number[] {
  const gs = new GameState({ ...DIFFICULTY_CONFIGS[replay.mode], seed: replay.seed }, replay.mode);
  gs.start();
  const bonuses: number[] = [];
  for (const move of replay.moves) {
    gs.advanceClockTo(move.at);
    if (move.t === 'h') {
      gs.hold();
      continue;
    }
    // Skips belong to the siege, and no Classic bot ever records one
    if (move.t !== 'p') continue;
    for (let n = 0; n < 4 && gs.current !== null && gs.current.rotation !== move.rot; n++) {
      gs.rotate();
    }
    bonuses.push(gs.tryPlace(move.row, move.col)[0]?.timeBonus ?? Number.NaN);
  }
  return bonuses;
}

describe('the piece clock both sides read', () => {
  /**
   * The run the adversarial review found, reproduced frame for frame.
   *
   * `pieceElapsed` used to be accumulated in `tick`, while the simulation
   * reached the same instant by assigning the recorded `at`. The two landed a
   * few bits apart, and the time bonus is rounded to a tenth of a second, so
   * the rounding could flip: 1.8 s banked in the browser against 1.7 s
   * credited by the server. That is not a rounding nuisance — it breaks the
   * invariant the 0.05 s clock slack rests on (reconstructed bank ≥ real
   * bank), and a run the browser survived with 0.035 s left reconstructed to
   * −0.065 s and was refused as `'clock'`.
   *
   * The frame pattern is the reviewer's: 38 frames of a sixtieth, a
   * placement, then 16 more and one of 0.13737373737373737 s, and another.
   * It lands the second piece on 0.404 s of thinking, which is exactly where
   * `round(1.8 × speedFraction × 10)` sits on the 17.5 boundary.
   */
  const FRAME = 1 / 60;
  const SAT_ON = 0.13737373737373737;

  function reviewersRun(): { gs: GameState; bonuses: number[]; bankBeforeLast: number } {
    const gs = new GameState({ ...DIFFICULTY_CONFIGS.classic, seed: 12_345 }, 'classic');
    gs.start();
    const bonuses: number[] = [];
    const place = (): void => { bonuses.push(playBestMove(gs)[0].timeBonus ?? Number.NaN); };

    for (let i = 0; i < 38; i++) gs.tick(FRAME);
    place();
    for (let i = 0; i < 16; i++) gs.tick(FRAME);
    gs.tick(SAT_ON);
    place();

    // Sit on the third piece until the bank is down to 35 ms, draining a
    // frame at a time as a browser does, and then place. The run is alive:
    // this is an honest player finishing on the edge, not a forged log.
    while (gs.timeRemaining > 0.06 && !gs.isGameOver) gs.tick(FRAME);
    gs.tick((gs.timeRemaining - 0.035) / gs.drainRate);
    const bankBeforeLast = gs.timeRemaining;
    place();
    return { gs, bonuses, bankBeforeLast };
  }

  const run = reviewersRun();

  it('lands the second piece on the rounding boundary that used to split the two', () => {
    const timer = DIFFICULTY_CONFIGS.classic.timer;
    const bonusFor = (pieceElapsed: number): number => {
      const t = Math.min(pieceElapsed / timer.speedWindowSeconds, 1);
      return Math.round(timer.placeBonus * (1 - (1 - timer.minSpeedFraction) * t) * 10) / 10;
    };

    // What `tick` used to add up for the second piece, a frame at a time
    let accumulated = 0;
    for (let i = 0; i < 16; i++) accumulated += FRAME;
    accumulated += SAT_ON;
    expect(accumulated).toBe(0.40404040404040403);

    // And what both sides compute now: one subtraction of two recorded times
    const moves = run.gs.buildReplay().moves;
    expect(moves[1].at - moves[0].at).toBe(0.404040404040405);
    expect(run.gs.pieceElapsed).not.toBe(accumulated);

    // Three bits apart, and a tenth of a second of bank apart
    expect(bonusFor(accumulated)).toBe(1.8);
    expect(bonusFor(moves[1].at - moves[0].at)).toBe(1.7);
  });

  it('re-plays valid, on a bank the browser survived by 35 milliseconds', () => {
    expect(run.gs.isGameOver).toBe(false);
    expect(run.bankBeforeLast).toBeCloseTo(0.035, 4);

    // The refusal that used to happen: bank the browser's 1.8 s, credit the
    // server's 1.7 s, and the third move stands on 0.035 − 0.1 = −0.065 s,
    // past the 0.05 s the clock check allows.
    expect(run.bankBeforeLast - 0.1).toBeLessThan(-0.05);

    expect(simulateRun(run.gs.buildReplay()))
      .toMatchObject({ valid: true, score: run.gs.score });
  });

  it('credits every placement the bonus the browser actually paid', () => {
    expect(replayedBonuses(run.gs.buildReplay())).toEqual(run.bonuses);

    // And on a long frame-driven run, where the speed fraction really moves:
    // every placement, not just the one that happened to sit on a boundary.
    const rnd = mulberry32(4242);
    const framed = playBotRun('classic', 21, 80, {
      frameSeconds: FRAME,
      step: () => 0.12 + rnd() * 1.4,
    });
    const live = framed.events.map(ev => ev[0].timeBonus);
    expect(live.length).toBeGreaterThan(40);
    expect(new Set(live).size).toBeGreaterThan(3);
    expect(replayedBonuses(framed.replay)).toEqual(live);
  });
});

describe('two hundred runs a browser could have played', () => {
  /**
   * The property the clock check needs: every honest frame-driven run
   * re-simulates, and to the same score. Seeded, so a failure names one run
   * that can be replayed rather than a mood.
   */
  it('all re-simulate valid, with the score the frames produced', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const mode: Difficulty = seed % 2 === 0 ? 'blitz' : 'classic';
      const rnd = mulberry32(seed * 7919);
      const played = playBotRun(mode, seed, 14, {
        frameSeconds: 1 / 60,
        step: () => 0.12 + rnd() * 1.1,
      });
      const result = simulateRun(played.replay);
      // One assertion carrying the seed, so a red build says which run broke
      expect(`${mode}/${seed}: ${result.reason ?? 'valid'} ${result.score}`)
        .toBe(`${mode}/${seed}: valid ${played.score}`);
    }
    // Two hundred runs is the point of it, and the bot's placement search is
    // what they cost. Well past the default 5 s, nowhere near a hang.
  }, 30_000);
});

describe('the cadence floor', () => {
  const run = playBotRun('classic', 11, 20);

  it('refuses placements a human hand could not have made', () => {
    // Every move legal, every score honest, the whole run typed out at forty
    // placements a second.
    const rushed: Move[] = run.replay.moves.map((m, i) => ({ ...m, at: 0.5 + i * 0.025 }));
    expect(simulateRun({ ...run.replay, moves: rushed })).toMatchObject({ reason: 'cadence' });

    // The floor is 0.08 s between placements: a hair under it fails, a hair
    // over it is a fast player and nothing more.
    const at = (gap: number): Move[] => run.replay.moves.map((m, i) => ({ ...m, at: 0.5 + i * gap }));
    expect(simulateRun({ ...run.replay, moves: at(0.0799) }).reason).toBe('cadence');
    expect(simulateRun({ ...run.replay, moves: at(0.0801) }).reason).not.toBe('cadence');

    // A hold does not reset it: the floor is between one piece landing and
    // the next, whatever happened in between.
    expect(run.replay.moves.some(m => m.t === 'h')).toBe(true);
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
