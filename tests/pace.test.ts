import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { GameState } from '../src/core/GameState';
import { DIFFICULTY_CONFIGS } from '../src/core/Config';
import { getPbTimeline, pbPaceAt, recordPbTimeline } from '../src/core/Settings';

/**
 * Ghost pace: the score curve a run leaves behind, and what a later run is
 * shown of it.
 *
 * Three things can go wrong and each is checked here. The curve can drift off
 * the seconds it claims to be indexed by, which would make every comparison a
 * lie. The storage can fail to survive a round trip. And the lookup can fall
 * off the end of a shorter best run, which is the ordinary case once a player
 * outlives their record.
 *
 * There is no DOM, so localStorage is a Map behind the methods Settings
 * actually calls, as in tests/stats.test.ts.
 */

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
  has(key: string): boolean { return this.data.has(key); }
  /** What is actually on disk, so a test can plant a bad blob */
  raw(key: string, value: string): void { this.data.set(key, value); }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});

afterAll(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

function newClassic(): GameState {
  const gs = new GameState(DIFFICULTY_CONFIGS.classic, 'classic');
  gs.start();
  return gs;
}

function newDaily(): GameState {
  const gs = new GameState(DIFFICULTY_CONFIGS.daily, 'daily');
  gs.start();
  return gs;
}

describe('the score timeline', () => {
  it('samples once per second, whatever size the frames are', () => {
    const gs = newClassic();
    expect(gs.scoreTimeline).toEqual([]);

    // Quarter-seconds, because a real frame is never a whole one. The first
    // tick lands second 0; the next three are still inside it.
    gs.tick(0.25);
    expect(gs.scoreTimeline).toEqual([0]);
    gs.tick(0.25);
    gs.tick(0.25);
    expect(gs.scoreTimeline).toEqual([0]);

    gs.score = 400;
    gs.tick(0.25);
    expect(gs.gameElapsed).toBeCloseTo(1, 10);
    expect(gs.scoreTimeline).toEqual([0, 400]);
  });

  it('holds the score the run had at each second', () => {
    const gs = newClassic();
    gs.tick(0.5);
    gs.score = 160;
    for (let i = 0; i < 2; i++) gs.tick(0.25); // 1.0 s
    gs.score = 520;
    for (let i = 0; i < 4; i++) gs.tick(0.25); // 2.0 s
    gs.score = 1240;
    for (let i = 0; i < 4; i++) gs.tick(0.25); // 3.0 s

    expect(gs.scoreTimeline).toEqual([0, 160, 520, 1240]);
    expect(gs.scoreTimeline[2]).toBe(520);
  });

  it('fills the seconds a long frame stepped over, so index i stays second i', () => {
    const gs = newClassic();
    gs.tick(0.25);
    gs.score = 900;
    // A backgrounded tab comes back with one huge dt. The curve must not
    // shift left, or every later lookup reads the wrong second.
    gs.tick(4);
    expect(gs.scoreTimeline).toEqual([0, 900, 900, 900, 900]);
  });

  it('stops at the 900-second cap', () => {
    // The daily has no clock, so it can be ticked past any horizon without
    // the run timing out underneath the assertion.
    const gs = newDaily();
    gs.tick(2000);
    expect(gs.scoreTimeline.length).toBe(900);
  });

  it('starts empty again on the next run', () => {
    const gs = newClassic();
    gs.tick(2);
    expect(gs.scoreTimeline.length).toBeGreaterThan(0);
    gs.start();
    expect(gs.scoreTimeline).toEqual([]);
  });

  it('travels on the run summary', () => {
    const gs = newClassic();
    gs.score = 75;
    gs.tick(1);
    const summary = gs.buildRunSummary('quit');
    expect(summary.scoreTimeline).toEqual([75, 75]);
    // A copy, so a summary held by the game-over screen cannot be rewritten
    // by a run that is somehow still ticking.
    expect(summary.scoreTimeline).not.toBe(gs.scoreTimeline);
  });
});

describe('the stored curve', () => {
  it('round-trips through localStorage, per mode', () => {
    recordPbTimeline('classic', [0, 40, 200, 1240]);
    expect(getPbTimeline('classic')).toEqual([0, 40, 200, 1240]);
    // Modes do not share a curve: a Blitz pace against a Classic run is noise
    expect(getPbTimeline('blitz')).toEqual([]);
    expect(storage.has('enclave_classic_pb_timeline')).toBe(true);
  });

  it('is empty when there is nothing stored', () => {
    expect(getPbTimeline('classic')).toEqual([]);
  });

  it('survives a blob that is not a curve', () => {
    storage.raw('enclave_classic_pb_timeline', '{"nope":1}');
    expect(getPbTimeline('classic')).toEqual([]);
    storage.raw('enclave_blitz_pb_timeline', '[0,"x",null,120]');
    expect(getPbTimeline('blitz')).toEqual([0, 120]);
  });

  it('is written when a run takes the personal best', () => {
    const gs = newClassic();
    gs.score = 3200;
    gs.tick(1);
    gs.finalizeBest();
    expect(getPbTimeline('classic')).toEqual(gs.scoreTimeline);
  });

  it('is left alone by a run that did not beat it', () => {
    recordPbTimeline('classic', [0, 5000]);
    // The gate is the stored best, not the field the HUD reads, so plant it
    // where recordPersonalBest will actually look.
    storage.raw('enclave_classic_personal_best', '9000');
    const gs = newClassic();
    gs.score = 100;
    gs.tick(1);
    gs.finalizeBest();
    expect(getPbTimeline('classic')).toEqual([0, 5000]);
  });

  it('is not written for the daily, which has no clock to race', () => {
    const gs = newDaily();
    gs.score = 3200;
    gs.tick(1);
    gs.finalizeBest();
    expect(storage.has('enclave_daily_pb_timeline')).toBe(false);
  });
});

describe('the pace lookup', () => {
  const curve = [0, 100, 250];

  it('reads the second it is given', () => {
    expect(pbPaceAt(curve, 0)).toBe(0);
    expect(pbPaceAt(curve, 1)).toBe(100);
    expect(pbPaceAt(curve, 2)).toBe(250);
  });

  it('returns the last value past the end of the curve', () => {
    // The best run finished at second 2. A longer run is ahead of it, not
    // racing a pace that suddenly falls back to nothing.
    expect(pbPaceAt(curve, 3)).toBe(250);
    expect(pbPaceAt(curve, 900)).toBe(250);
  });

  it('is null when there is no curve at all', () => {
    expect(pbPaceAt([], 0)).toBeNull();
    expect(pbPaceAt([], 12)).toBeNull();
  });
});
