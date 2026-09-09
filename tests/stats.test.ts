import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  LifetimeStats,
  emptyStats,
  foldRun,
  formatPlayTime,
  formatRoomSize,
  loadStats,
  mostCommonRoomSize,
  saveStats,
} from '../src/core/Stats';
import { Board } from '../src/core/Board';
import { RunSummary } from '../src/core/types';
import { emptyReplay } from './helpers';

/**
 * Lifetime stats: the fold and the storage round trip.
 *
 * There is no DOM here, so localStorage is a Map behind the three methods
 * Stats actually calls. The last block deletes it again, which is also the
 * test that the try/catch does its job.
 */

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
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

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    score: 1000,
    difficulty: 'classic',
    seed: 1,
    endCause: 'timeout',
    totalTurns: 10,
    claims: 2,
    cellsClaimed: 5,
    roomsClaimed: 2,
    biggestRoom: 4,
    roomSizes: { 1: 1, 4: 1 },
    doubleCloses: 0,
    maxStreak: 2,
    holds: 1,
    surveys: 0,
    litCells: 5,
    litMap: Board.createUnlitMap(),
    closingAtEnd: 0,
    piecesLeft: 0,
    gameElapsed: 42.5,
    scoreTimeline: [],
    previousBest: 0,
    isNewBest: true,
    replay: emptyReplay(),
    ...over,
  };
}

const AT = new Date('2026-09-09T18:48:00.000Z');

describe('foldRun', () => {
  it('counts the first run', () => {
    const stats = foldRun(emptyStats(), summary(), AT);
    expect(stats.runs).toBe(1);
    expect(stats.bestScore).toBe(1000);
    expect(stats.biggestRoom).toBe(4);
    expect(stats.roomsTotal).toBe(2);
    expect(stats.surveysTotal).toBe(0);
    expect(stats.roomSizes).toEqual({ 1: 1, 4: 1 });
    expect(stats.playSeconds).toBe(42.5);
    expect(stats.lastPlayed).toBe(AT.toISOString());
  });

  it('accumulates counts, sums histograms and seconds', () => {
    let stats = foldRun(emptyStats(), summary(), AT);
    stats = foldRun(stats, summary({
      score: 2500,
      roomsClaimed: 3,
      biggestRoom: 9,
      roomSizes: { 4: 2, 9: 1 },
      surveys: 1,
      gameElapsed: 57.5,
    }), AT);

    expect(stats.runs).toBe(2);
    expect(stats.roomsTotal).toBe(5);
    expect(stats.surveysTotal).toBe(1);
    expect(stats.roomSizes).toEqual({ 1: 1, 4: 3, 9: 1 });
    expect(stats.playSeconds).toBe(100);
  });

  it('keeps the maximum for the best score and the biggest room', () => {
    let stats = foldRun(emptyStats(), summary({ score: 9000, biggestRoom: 16 }), AT);
    stats = foldRun(stats, summary({ score: 120, biggestRoom: 1 }), AT);
    expect(stats.bestScore).toBe(9000);
    expect(stats.biggestRoom).toBe(16);
    expect(stats.runs).toBe(2);
  });

  it('counts a quit as a run that was played', () => {
    const stats = foldRun(emptyStats(), summary({ endCause: 'quit', score: 40 }), AT);
    expect(stats.runs).toBe(1);
    expect(stats.bestScore).toBe(40);
  });

  it('leaves the record it was given alone', () => {
    const before = emptyStats();
    foldRun(before, summary(), AT);
    expect(before).toEqual(emptyStats());
  });
});

describe('derived readouts', () => {
  it('picks the most common room size, biggest wins a tie', () => {
    expect(mostCommonRoomSize(emptyStats())).toBe(0);
    expect(mostCommonRoomSize({ ...emptyStats(), roomSizes: { 1: 9, 4: 2 } })).toBe(1);
    expect(mostCommonRoomSize({ ...emptyStats(), roomSizes: { 1: 3, 9: 3 } })).toBe(9);
  });

  it('names a square room by its sides', () => {
    expect(formatRoomSize(9)).toBe('3×3');
    expect(formatRoomSize(4)).toBe('2×2');
    expect(formatRoomSize(1)).toBe('1×1');
    expect(formatRoomSize(6)).toBe('6 cells');
    expect(formatRoomSize(0)).toBe('—');
  });

  it('reads play time as h:mm', () => {
    expect(formatPlayTime(0)).toBe('0:00');
    expect(formatPlayTime(59)).toBe('0:00');
    expect(formatPlayTime(600)).toBe('0:10');
    expect(formatPlayTime(3600 * 2 + 60 * 7)).toBe('2:07');
  });
});

describe('storage', () => {
  it('round-trips a record', () => {
    const stats = foldRun(emptyStats(), summary(), AT);
    saveStats('classic', stats);
    expect(loadStats('classic')).toEqual(stats);
  });

  it('keeps a record per mode', () => {
    saveStats('classic', foldRun(emptyStats(), summary({ score: 1000 }), AT));
    saveStats('blitz', foldRun(emptyStats(), summary({ score: 300 }), AT));
    expect(loadStats('classic').bestScore).toBe(1000);
    expect(loadStats('blitz').bestScore).toBe(300);
    expect(loadStats('daily')).toEqual(emptyStats());
  });

  it('starts empty and survives a blob it cannot read', () => {
    expect(loadStats('classic')).toEqual(emptyStats());
    storage.raw('enclave_stats_classic', 'not json');
    expect(loadStats('classic')).toEqual(emptyStats());
    storage.raw('enclave_stats_classic', '{"runs":"seven","roomSizes":[1,2]}');
    expect(loadStats('classic')).toEqual(emptyStats());
  });

  it('survives storage being unavailable at all', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => saveStats('classic', emptyStats())).not.toThrow();
    expect(loadStats('classic')).toEqual(emptyStats());
  });
});

describe('the shape on disk', () => {
  it('is the shape that comes back', () => {
    const written: LifetimeStats = foldRun(emptyStats(), summary({ surveys: 2 }), AT);
    saveStats('daily', written);
    const read = loadStats('daily');
    expect(Object.keys(read).sort()).toEqual(Object.keys(written).sort());
    expect(read.surveysTotal).toBe(2);
    expect(read.lastPlayed).toBe(AT.toISOString());
  });
});
