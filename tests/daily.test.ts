import { describe, it, expect } from 'vitest';
import { GameState } from '../src/core/GameState';
import { makePiece } from '../src/core/Pieces';
import { DIFFICULTY_CONFIGS, GameConfig } from '../src/core/Config';
import { dailyKey, dailyNumber, dailySeed, isDailyKey, msUntilNextDaily, formatCountdown } from '../src/core/Daily';
import { PieceInstance } from '../src/core/types';
import { grid } from './helpers';

/**
 * The Rationed Daily: same pieces for everyone, thirty of them, no clock.
 *
 * The GameState tests drive the rules directly the way tests/scoring.test.ts
 * does — the board and the hand are overwritten before each placement, so the
 * run is deterministic regardless of what the bag dealt.
 */

const WHITE = 0xffffff;
const DAILY = DIFFICULTY_CONFIGS.daily;
const BUDGET = DAILY.pieceBudget!;

function newDaily(): GameState {
  const gs = new GameState(DAILY, 'daily');
  gs.start();
  return gs;
}

/**
 * Place one block on an otherwise empty board. Nothing is ever enclosed, so
 * only the piece budget moves. Returns whether the run is still going.
 */
function placeOne(gs: GameState): boolean {
  gs.board.grid = grid([]);
  gs.current = makePiece('single', 0, WHITE);
  gs.tryPlace(0, 0);
  return !gs.isGameOver;
}

function fingerprint(p: PieceInstance | null): string {
  return p ? `${p.typeId}:${p.rotation}:${p.color}` : 'none';
}

describe('daily identity', () => {
  it('keys a day by its UTC date', () => {
    expect(dailyKey(new Date('2026-09-09T00:00:00.000Z'))).toBe('2026-09-09');
    expect(dailyKey(new Date('2026-09-09T23:59:59.999Z'))).toBe('2026-09-09');
    // 23:30 in Lisbon on the 9th is already the 10th in UTC — deliberately,
    // because everyone has to be on the same puzzle at the same instant
    expect(dailyKey(new Date('2026-09-10T00:30:00.000Z'))).toBe('2026-09-10');
  });

  it('numbers days from the epoch, so 2026-09-09 is Daily #9', () => {
    expect(dailyNumber('2026-09-01')).toBe(1);
    expect(dailyNumber('2026-09-09')).toBe(9);
    expect(dailyNumber('2026-10-01')).toBe(31);
  });

  it('derives the seed from the date and nothing else', () => {
    expect(dailySeed('2026-09-09')).toBe(1702173874);
    expect(dailySeed('2026-09-09')).toBe(dailySeed('2026-09-09'));
    expect(dailySeed('2026-09-10')).not.toBe(dailySeed('2026-09-09'));
  });

  it('validates keys', () => {
    expect(isDailyKey('2026-09-09')).toBe(true);
    expect(isDailyKey('2026-9-9')).toBe(false);
    expect(isDailyKey('2026-02-30')).toBe(false);
    expect(isDailyKey('not-a-date')).toBe(false);
  });

  it('counts down to the next UTC midnight', () => {
    expect(msUntilNextDaily(new Date('2026-09-09T23:00:00.000Z'))).toBe(3_600_000);
    expect(msUntilNextDaily(new Date('2026-09-09T18:48:00.000Z'))).toBe(5 * 3_600_000 + 12 * 60_000);
    // Exactly midnight is a full day away from the *next* one
    expect(msUntilNextDaily(new Date('2026-09-09T00:00:00.000Z'))).toBe(86_400_000);
  });

  it('formats the countdown as hh:mm', () => {
    expect(formatCountdown(5 * 3_600_000 + 12 * 60_000)).toBe('05:12');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(86_399_000)).toBe('23:59');
  });
});

describe('the daily run', () => {
  it('has no clock: ticking drains nothing and never times out', () => {
    const gs = newDaily();
    const before = gs.timeRemaining;

    for (let i = 0; i < 100; i++) expect(gs.tick(1)).toBe(false);

    expect(gs.timeRemaining).toBe(before);
    expect(gs.gameElapsed).toBe(100);
    expect(gs.drainRate).toBe(1);
    expect(gs.isGameOver).toBe(false);
    // Nothing downstream may see a NaN or an Infinity
    expect(gs.currentSpeedFraction).toBe(1);
    expect(Number.isFinite(gs.timeRemaining / gs.maxTime)).toBe(true);
  });

  it('pays no time bonus, because there is no clock to pay it into', () => {
    const gs = newDaily();
    gs.board.grid = grid([]);
    gs.current = makePiece('single', 0, WHITE);
    const events = gs.tryPlace(0, 0);

    expect(events[0].timeBonus).toBe(0);
    expect(gs.timeRemaining).toBe(DAILY.timer.startSeconds);
  });

  it('deals exactly the budget and then ends with "complete"', () => {
    const gs = newDaily();
    expect(gs.piecesRemaining).toBe(BUDGET);

    let placed = 0;
    while (placeOne(gs)) {
      placed++;
      expect(gs.piecesRemaining).toBe(BUDGET - placed);
      if (placed > BUDGET + 5) throw new Error('budget never ran out');
    }
    placed++; // the placement that ended the run

    expect(placed).toBe(BUDGET);
    expect(gs.isGameOver).toBe(true);
    expect(gs.deathCause).toBe('complete');
    expect(gs.deathCause).not.toBe('board_lock');
    expect(gs.piecesRemaining).toBe(0);
    expect(gs.totalTurns).toBe(BUDGET);
    expect(gs.current).toBeNull();
  });

  it('reports "complete" on the summary, and the score counts', () => {
    const gs = newDaily();
    while (placeOne(gs)) { /* spend the ration */ }

    const summary = gs.buildRunSummary();
    expect(summary.endCause).toBe('complete');
    expect(summary.difficulty).toBe('daily');
    expect(summary.score).toBe(BUDGET);            // 30 blocks × 1 point
    expect(summary.seed).toBe(dailySeed(dailyKey()));
    expect(summary.dailyKey).toBe(dailyKey());
  });

  it('shows empty queue slots rather than dealing past the budget', () => {
    const gs = newDaily();
    while (placeOne(gs)) { /* spend the ration */ }
    expect(gs.queue).toHaveLength(0);
  });

  it('lets the queue run dry without ever calling it a board lock', () => {
    const gs = newDaily();
    // Every placement is on a cleared board, so nothing can ever fail to fit:
    // a board_lock here could only come from the empty hand
    while (placeOne(gs)) { /* spend the ration */ }
    expect(gs.deathCause).toBe('complete');
  });

  it('refuses the last hold rather than parking the final piece', () => {
    const gs = newDaily();
    while (gs.queue.length > 0 && placeOne(gs)) { /* down to the last piece */ }

    expect(gs.isGameOver).toBe(false);
    expect(gs.held).toBeNull();
    expect(gs.queue).toHaveLength(0);
    expect(gs.hold()).toEqual([]);
    expect(gs.current).not.toBeNull();
  });

  it('does not spend budget on a hold swap', () => {
    const gs = newDaily();
    const before = gs.piecesRemaining;
    gs.hold();
    expect(gs.holds).toBe(1);
    expect(gs.piecesRemaining).toBe(before);
  });
});

describe('seeded dealing', () => {
  it('gives two runs of the same daily the same hand and queue', () => {
    const a = newDaily();
    const b = newDaily();

    expect(a.seed).toBe(b.seed);
    expect(fingerprint(a.current)).toBe(fingerprint(b.current));
    expect(a.queue.map(fingerprint)).toEqual(b.queue.map(fingerprint));
  });

  it('gives two runs of the same explicit seed the same deal', () => {
    const seeded: GameConfig = { ...DIFFICULTY_CONFIGS.classic, seed: 424_242 };
    const a = new GameState(seeded, 'classic');
    const b = new GameState(seeded, 'classic');
    a.start();
    b.start();

    expect(a.seed).toBe(424_242);
    expect(b.seed).toBe(424_242);
    expect(fingerprint(a.current)).toBe(fingerprint(b.current));
    expect(a.queue.map(fingerprint)).toEqual(b.queue.map(fingerprint));
  });

  it('gives free play a fresh seed each run', () => {
    const gs = new GameState(DIFFICULTY_CONFIGS.classic, 'classic');
    const seeds = new Set<number>();
    for (let i = 0; i < 20; i++) {
      gs.start();
      seeds.add(gs.seed);
    }
    // Twenty draws from 2^32 colliding would be a broken generator
    expect(seeds.size).toBe(20);
  });
});
