import { describe, it, expect } from 'vitest';
import { MAX_INSIGHTS, insightsFor } from '../src/core/Insights';
import { DIFFICULTY_CONFIGS } from '../src/core/Config';
import { Board } from '../src/core/Board';
import { RunSummary } from '../src/core/types';
import { emptyReplay } from './helpers';

/**
 * The recap lines. Every rule is checked twice — once on a run that should
 * fire it and once on a run just short of its threshold — because a rule that
 * fires on everything is worth less than no rule at all.
 */

const CLASSIC = DIFFICULTY_CONFIGS.classic;
const DAILY = DIFFICULTY_CONFIGS.daily;

/**
 * A run that fires nothing: a quiet, unremarkable classic game. Every test
 * overrides only the fields its rule reads, so a line that appears is one the
 * override earned.
 */
function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    score: 5000,
    difficulty: 'classic',
    seed: 1,
    endCause: 'timeout',
    totalTurns: 8,
    claims: 2,
    cellsClaimed: 8,
    roomsClaimed: 2,
    biggestRoom: 4,
    roomSizes: { 4: 2 },
    doubleCloses: 0,
    maxStreak: 2,
    holds: 1,
    surveys: 0,
    litCells: 8,
    litMap: Board.createUnlitMap(),
    closingAtEnd: 0,
    piecesLeft: 0,
    gameElapsed: 60,
    scoreTimeline: [],
    previousBest: 0,
    isNewBest: false,
    replay: emptyReplay(),
    ...over,
  };
}

describe('the quiet run', () => {
  it('says nothing when there is nothing to say', () => {
    expect(insightsFor(summary(), CLASSIC)).toEqual([]);
  });
});

describe('single-cell rooms', () => {
  it('fires when half the rooms or more were single cells', () => {
    const lines = insightsFor(summary({ roomsClaimed: 6, roomSizes: { 1: 4, 4: 2 }, claims: 6 }), CLASSIC);
    expect(lines).toContain('4 of 6 rooms were single cells. A 2×2 pays sixteen times more.');
  });

  it('fires exactly at half', () => {
    const lines = insightsFor(summary({ roomsClaimed: 6, roomSizes: { 1: 3, 4: 3 } }), CLASSIC);
    expect(lines).toContain('3 of 6 rooms were single cells. A 2×2 pays sixteen times more.');
  });

  it('stays quiet below half, and on a run that claimed nothing', () => {
    expect(insightsFor(summary({ roomsClaimed: 6, roomSizes: { 1: 2, 4: 4 } }), CLASSIC)).toEqual([]);
    expect(insightsFor(summary({ roomsClaimed: 0, roomSizes: {}, claims: 0 }), CLASSIC)).toEqual([]);
  });
});

describe('rooms left open', () => {
  it('fires on two closing cells or more', () => {
    expect(insightsFor(summary({ closingAtEnd: 3 }), CLASSIC))
      .toEqual(['3 rooms were one block from closing when the run ended.']);
  });

  it('stays quiet on one', () => {
    expect(insightsFor(summary({ closingAtEnd: 1 }), CLASSIC)).toEqual([]);
  });
});

describe('unused mechanics', () => {
  it('names HOLD after ten placements without it', () => {
    expect(insightsFor(summary({ holds: 0, totalTurns: 10 }), CLASSIC))
      .toEqual(['HOLD never used. Park a piece to finish the fence first.']);
  });

  it('stays quiet on a short run, or when hold was used', () => {
    expect(insightsFor(summary({ holds: 0, totalTurns: 9 }), CLASSIC)).toEqual([]);
    expect(insightsFor(summary({ holds: 2, totalTurns: 30 }), CLASSIC)).toEqual([]);
  });

  it('names the streak after three claims without one', () => {
    expect(insightsFor(summary({ maxStreak: 1, claims: 3 }), CLASSIC))
      .toEqual(['No streak. Claims on consecutive placements multiply.']);
  });

  it('stays quiet under three claims, or when a streak happened', () => {
    expect(insightsFor(summary({ maxStreak: 1, claims: 2 }), CLASSIC)).toEqual([]);
    expect(insightsFor(summary({ maxStreak: 2, claims: 8 }), CLASSIC)).toEqual([]);
  });
});

describe('big rooms', () => {
  it('calls nine cells a big room and sixteen massive', () => {
    const nine = summary({ biggestRoom: 9, roomsClaimed: 2, roomSizes: { 9: 1, 4: 1 } });
    expect(insightsFor(nine, CLASSIC)).toEqual(['Biggest room 9 cells. Big room.']);

    const sixteen = summary({ biggestRoom: 16, roomsClaimed: 2, roomSizes: { 16: 1, 4: 1 } });
    expect(insightsFor(sixteen, CLASSIC)).toEqual(['Biggest room 16 cells. Massive.']);
  });

  it('stays quiet under nine', () => {
    expect(insightsFor(summary({ biggestRoom: 8 }), CLASSIC)).toEqual([]);
  });

  it('drops the praise when the same claim also made the single cells', () => {
    const oneClaim = summary({
      claims: 1, roomsClaimed: 4, roomSizes: { 1: 3, 9: 1 }, biggestRoom: 9,
    });
    expect(insightsFor(oneClaim, CLASSIC))
      .toEqual(['3 of 4 rooms were single cells. A 2×2 pays sixteen times more.']);
  });

  it('keeps the praise when the big room was a claim of its own', () => {
    const twoClaims = summary({
      claims: 2, roomsClaimed: 4, roomSizes: { 1: 3, 9: 1 }, biggestRoom: 9,
    });
    expect(insightsFor(twoClaims, CLASSIC)).toEqual([
      '3 of 4 rooms were single cells. A 2×2 pays sixteen times more.',
      'Biggest room 9 cells. Big room.',
    ]);
  });
});

describe('the survey', () => {
  it('fires when the floor was most of the way lit and no survey landed', () => {
    expect(insightsFor(summary({ litCells: 30 }), CLASSIC))
      .toEqual(['30/49 floor lit. The survey was close.']);
  });

  it('stays quiet below the threshold, and when a survey did land', () => {
    expect(insightsFor(summary({ litCells: 29 }), CLASSIC)).toEqual([]);
    expect(insightsFor(summary({ litCells: 40, surveys: 1 }), CLASSIC)).toEqual([]);
  });
});

describe('a run that ended fast', () => {
  it('fires on a timeout under 25 seconds', () => {
    expect(insightsFor(summary({ endCause: 'timeout', gameElapsed: 18 }), CLASSIC))
      .toEqual(['Time ran out fast. Every placement adds time; place before you plan.']);
  });

  it('stays quiet at 25 seconds, and when the clock was not what ended it', () => {
    expect(insightsFor(summary({ endCause: 'timeout', gameElapsed: 25 }), CLASSIC)).toEqual([]);
    expect(insightsFor(summary({ endCause: 'quit', gameElapsed: 8 }), CLASSIC)).toEqual([]);
  });
});

describe('the daily', () => {
  it('marks a finished puzzle', () => {
    const done = summary({ difficulty: 'daily', endCause: 'complete', totalTurns: 30, holds: 1 });
    expect(insightsFor(done, DAILY)).toEqual(['All 30 pieces placed.']);
  });

  it('says what a lock cost, and counts one piece as one', () => {
    const locked = summary({ difficulty: 'daily', endCause: 'board_lock', piecesLeft: 7 });
    expect(insightsFor(locked, DAILY)).toEqual(['Ran out of space with 7 pieces left.']);

    const nearly = summary({ difficulty: 'daily', endCause: 'board_lock', piecesLeft: 1 });
    expect(insightsFor(nearly, DAILY)).toEqual(['Ran out of space with 1 piece left.']);
  });

  it('keeps the daily lines out of a timed run', () => {
    expect(insightsFor(summary({ endCause: 'complete' }), CLASSIC)).toEqual([]);
    expect(insightsFor(summary({ endCause: 'board_lock', piecesLeft: 7 }), CLASSIC)).toEqual([]);
  });
});

describe('order and cap', () => {
  it('offers advice before description', () => {
    const both = summary({ roomsClaimed: 4, roomSizes: { 1: 3, 2: 1 }, biggestRoom: 2, closingAtEnd: 4 });
    expect(insightsFor(both, CLASSIC)).toEqual([
      '3 of 4 rooms were single cells. A 2×2 pays sixteen times more.',
      '4 rooms were one block from closing when the run ended.',
    ]);
  });

  it('takes the top three when six rules fire', () => {
    const messy = summary({
      endCause: 'timeout',
      gameElapsed: 12,
      totalTurns: 12,
      holds: 0,
      claims: 4,
      maxStreak: 1,
      roomsClaimed: 6,
      roomSizes: { 1: 4, 2: 2 },
      biggestRoom: 2,
      closingAtEnd: 3,
      litCells: 40,
    });
    const lines = insightsFor(messy, CLASSIC);
    expect(lines).toHaveLength(MAX_INSIGHTS);
    expect(lines).toEqual([
      'Time ran out fast. Every placement adds time; place before you plan.',
      '4 of 6 rooms were single cells. A 2×2 pays sixteen times more.',
      '3 rooms were one block from closing when the run ended.',
    ]);
  });

  it('caps at three', () => {
    expect(MAX_INSIGHTS).toBe(3);
  });
});
