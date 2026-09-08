import { describe, it, expect, beforeEach } from 'vitest';
import { GameState } from '../src/core/GameState';
import { makePiece } from '../src/core/Pieces';
import { DIFFICULTY_CONFIGS } from '../src/core/Config';
import { FeedbackEvent } from '../src/core/types';
import { grid } from './helpers';

/**
 * These drive GameState directly rather than through a scene. The bag is
 * random, so every test overwrites `board.grid` and `current` — both public —
 * immediately before each placement. No production code is touched.
 */

const WHITE = 0xffffff;

/** A 2×2 room needing one more block at (2,3) to close */
const ROOM_2X2_OPEN = [
  '.........',
  '.........',
  '....#....',
  '..#..#...',
  '..#..#...',
  '...##....',
];

/** Two 1-cell rooms that a single block at (4,4) seals at the same time */
const TWO_ROOMS_OPEN = [
  '.........',
  '.........',
  '.........',
  '...#.#...',
  '..#...#..',
  '...#.#...',
];

function newGame(difficulty: 'classic' | 'blitz' = 'classic'): GameState {
  const gs = new GameState(DIFFICULTY_CONFIGS[difficulty], difficulty);
  gs.start();
  return gs;
}

/** Set the board and hand, then place a single block at (row, col). */
function placeSingle(gs: GameState, rows: string[], row: number, col: number): FeedbackEvent[] {
  gs.board.grid = grid(rows);
  gs.current = makePiece('single', 0, WHITE);
  return gs.tryPlace(row, col);
}

function claimEvent(events: FeedbackEvent[]): FeedbackEvent {
  const e = events.find(x => x.type === 'claim');
  if (!e) throw new Error('expected a claim event');
  return e;
}

describe('scoring order', () => {
  let gs: GameState;

  beforeEach(() => {
    gs = newGame();
  });

  it('adds the placed block, then area² × 10 for the room', () => {
    const events = placeSingle(gs, ROOM_2X2_OPEN, 2, 3);
    const claim = claimEvent(events);

    expect(claim.claim!.regions).toHaveLength(1);
    expect(claim.claim!.totalArea).toBe(4);
    expect(claim.scoreBreakdown!.basePoints).toBe(160);   // 4² × 10
    expect(claim.scoreBreakdown!.turnScore).toBe(160);
    expect(gs.score).toBe(161);                           // 1 block + 160
  });

  it('uses the streak count from before the claim, so the second pays ×1.25', () => {
    placeSingle(gs, ROOM_2X2_OPEN, 2, 3);
    expect(gs.streakCount).toBe(1);
    expect(gs.score).toBe(161);

    const claim = claimEvent(placeSingle(gs, ROOM_2X2_OPEN, 2, 3));
    expect(claim.scoreBreakdown!.streakMultiplier).toBe(1.25);
    expect(claim.scoreBreakdown!.turnScore).toBe(200);    // floor(160 × 1.25)
    expect(gs.score).toBe(362);                           // 161 + 1 + 200
    expect(gs.streakCount).toBe(2);
    expect(gs.maxStreak).toBe(2);
  });

  it('applies ×1.5 when one placement closes two rooms', () => {
    const claim = claimEvent(placeSingle(gs, TWO_ROOMS_OPEN, 4, 4));

    expect(claim.claim!.regions).toHaveLength(2);
    expect(claim.scoreBreakdown!.basePoints).toBe(20);            // two 1-cell rooms
    expect(claim.scoreBreakdown!.multiCloseMultiplier).toBe(1.5);
    expect(claim.scoreBreakdown!.streakMultiplier).toBe(1);       // first claim of the run
    expect(claim.scoreBreakdown!.turnScore).toBe(30);             // floor(20 × 1.5)
    expect(gs.score).toBe(31);
    expect(gs.doubleCloses).toBe(1);
  });

  it('counts rooms, not claims, and records the size histogram', () => {
    placeSingle(gs, TWO_ROOMS_OPEN, 4, 4);
    placeSingle(gs, ROOM_2X2_OPEN, 2, 3);

    expect(gs.claims).toBe(2);
    expect(gs.roomsClaimed).toBe(3);
    expect(gs.biggestRoom).toBe(4);
    expect(gs.roomSizes).toEqual({ 1: 2, 4: 1 });
  });
});

describe('time bonus', () => {
  it('adds placeBonus × speedFraction for a placement with no claim', () => {
    const gs = newGame();
    const before = gs.timeRemaining;

    // No claim: an isolated block on an open board encloses nothing.
    const events = placeSingle(gs, [], 0, 0);

    expect(events.some(e => e.type === 'claim')).toBe(false);
    expect(gs.currentSpeedFraction).toBe(1);
    expect(events[0].timeBonus).toBe(1.8);                // placeBonus × 1.0
    expect(gs.timeRemaining).toBeCloseTo(before + 1.8, 5);
  });

  it('adds placeBonus + claim base + perCell × area for a 4-cell claim', () => {
    const gs = newGame();
    const before = gs.timeRemaining;

    const events = placeSingle(gs, ROOM_2X2_OPEN, 2, 3);

    expect(events[0].timeBonus).toBe(7);                  // 1.8 + (2.0 + 0.8 × 4)
    expect(claimEvent(events).timeBonus).toBe(7);
    expect(gs.timeRemaining).toBeCloseTo(before + 7, 5);
  });

  it('scales the bonus down as the piece sits in hand', () => {
    const gs = newGame();
    const { speedWindowSeconds, minSpeedFraction } = gs.config.timer;

    gs.pieceElapsed = speedWindowSeconds;                 // fully decayed
    expect(gs.currentSpeedFraction).toBeCloseTo(minSpeedFraction, 10);

    const events = placeSingle(gs, [], 0, 0);
    expect(events[0].timeBonus).toBe(0.8);                // round(1.8 × 0.45) to 1dp
  });
});
