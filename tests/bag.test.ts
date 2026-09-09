import { describe, it, expect } from 'vitest';
import { GameState } from '../src/core/GameState';
import { PieceBag, PIECE_TYPES, TIER_BAGS, bagSizeForTier, makePiece } from '../src/core/Pieces';
import { Difficulty, DIFFICULTY_CONFIGS, GameConfig } from '../src/core/Config';
import { getProgressStatus } from '../src/core/Progression';
import { mulberry32 } from '../src/core/Random';
import { grid, jumpPastEcho } from './helpers';

/**
 * Bag by tier: the mix gets stingier with fence material as the player climbs,
 * but only at a refill, only where the mode asks for it, and never in a way
 * that makes the same seed deal two different runs.
 */

const WHITE = 0xffffff;

/** A 4×4 room one block short of closing, at (2,3): 16² = 2,560 a claim */
const ROOM_4X4_OPEN = [
  '.........',
  '.........',
  '....###..',
  '..#....#.',
  '..#....#.',
  '..#....#.',
  '..#....#.',
  '...####..',
];

/** The base bag as PIECE_TYPES declares it, which tier 0 must still be */
const BASE_COMPOSITION: Record<string, number> = {
  single: 1, domino: 3, tri_line: 3, corner: 3, tet_line: 2, l: 2, j: 2,
  t: 1, s: 1, z: 1, square: 1, pent_line: 1, big_l: 1, u: 1,
};

function tally(ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = (out[id] ?? 0) + 1;
  return out;
}

function deal(bag: PieceBag, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const piece = bag.next();
    if (!piece) break;
    out.push(piece.typeId);
  }
  return out;
}

interface ScriptedRun {
  /** The piece the bag handed over for each move, in order */
  deals: string[];
  score: number;
  tierIndex: number;
}

/**
 * Drive a run for `moves` placements, the first `claims` of which seal a 4×4
 * room and the rest of which drop a lone block on an empty board. Every move
 * takes exactly one piece from the bag, so two runs of the same length ask the
 * bag the same questions and can be compared deal for deal.
 */
function scriptedRun(config: GameConfig, difficulty: Difficulty, claims: number, moves: number): ScriptedRun {
  const gs = new GameState(config, difficulty);
  gs.start();
  const deals: string[] = [];
  for (let i = 0; i < moves; i++) {
    if (!gs.current || gs.isGameOver) break;
    deals.push(gs.current.typeId);
    const claiming = i < claims;
    gs.board.grid = grid(claiming ? ROOM_4X4_OPEN : []);
    gs.current = makePiece('single', 0, WHITE);
    gs.tryPlace(claiming ? 2 : 0, claiming ? 3 : 0);
    jumpPastEcho(gs);
  }
  return { deals, score: gs.score, tierIndex: getProgressStatus(difficulty, gs.score).tierIndex };
}

const SEEDED_CLASSIC: GameConfig = { ...DIFFICULTY_CONFIGS.classic, seed: 20260909 };
const BASE_SIZE = bagSizeForTier(0);

describe('the tier bag table', () => {
  it('has one bag per tier and every one of them holds 23–25 pieces', () => {
    expect(TIER_BAGS).toHaveLength(6);
    for (let tier = 0; tier < TIER_BAGS.length; tier++) {
      const size = bagSizeForTier(tier);
      expect(size).toBeGreaterThanOrEqual(23);
      expect(size).toBeLessThanOrEqual(25);
    }
  });

  it('starts on exactly the bag PIECE_TYPES declares', () => {
    expect(TIER_BAGS[0]).toEqual(BASE_COMPOSITION);
    expect(TIER_BAGS[0]).toEqual(Object.fromEntries(PIECE_TYPES.map(t => [t.id, t.bagCount])));
    // SETTLER and BUILDER share it: the ramp starts once the player can close
    expect(TIER_BAGS[1]).toEqual(TIER_BAGS[0]);
  });

  it('takes the cheap fence material out, tier by tier', () => {
    expect(TIER_BAGS[2]).toEqual({ ...BASE_COMPOSITION, tri_line: 2, tet_line: 1, s: 2, z: 2 });
    expect(TIER_BAGS[3]).toEqual({ ...TIER_BAGS[2], corner: 2, t: 2, u: 2 });
    // BAR 5 is gone completely by SOVEREIGN, and LEGEND is dealt the same
    const sovereign = { ...TIER_BAGS[3], domino: 2, square: 2 };
    delete (sovereign as Record<string, number>).pent_line;
    expect(TIER_BAGS[4]).toEqual(sovereign);
    expect(TIER_BAGS[5]).toEqual(TIER_BAGS[4]);
  });

  it('clamps a tier index that is off the end of the table', () => {
    expect(bagSizeForTier(-3)).toBe(bagSizeForTier(0));
    expect(bagSizeForTier(99)).toBe(bagSizeForTier(TIER_BAGS.length - 1));
  });
});

describe('PieceBag.setTier', () => {
  it('changes the mix at the next refill and never mid-bag', () => {
    const bag = new PieceBag(mulberry32(7));
    const opening = deal(bag, 5);
    bag.setTier(5);                                       // LEGEND, five pieces in
    const restOfBag = deal(bag, BASE_SIZE - 5);

    // The bag the player was already counting on finishes as it was dealt
    expect(tally([...opening, ...restOfBag])).toEqual(TIER_BAGS[0]);
    expect(tally(deal(bag, bagSizeForTier(5)))).toEqual(TIER_BAGS[5]);
  });

  it('keeps dealing the base bag until it is told otherwise', () => {
    const bag = new PieceBag(mulberry32(11));
    expect(tally(deal(bag, BASE_SIZE))).toEqual(TIER_BAGS[0]);
    expect(tally(deal(bag, BASE_SIZE))).toEqual(TIER_BAGS[0]);
  });
});

describe('bag by tier in a run', () => {
  it('is deterministic: the same seed and the same moves deal the same pieces', () => {
    const a = scriptedRun(SEEDED_CLASSIC, 'classic', 8, 30);
    const b = scriptedRun(SEEDED_CLASSIC, 'classic', 8, 30);

    // The tier follows the score, the score follows the play and the play is
    // identical, so the deal has nothing left to differ on.
    expect(a.tierIndex).toBeGreaterThanOrEqual(4);
    expect(a.score).toBe(b.score);
    expect(a.deals).toEqual(b.deals);
  });

  it('reaches the bag only at the refill, and then really does change it', () => {
    const scored = scriptedRun(SEEDED_CLASSIC, 'classic', 8, 30);
    const quiet = scriptedRun(SEEDED_CLASSIC, 'classic', 0, 30);

    expect(scored.tierIndex).toBeGreaterThanOrEqual(4);   // SOVEREIGN or better
    expect(quiet.tierIndex).toBe(0);
    // Three tiers were crossed inside the first bag and it was dealt anyway
    expect(scored.deals.slice(0, BASE_SIZE)).toEqual(quiet.deals.slice(0, BASE_SIZE));
    // SOVEREIGN's bag has no BAR 5 in it at all; the base bag has exactly one
    expect(quiet.deals.slice(0, BASE_SIZE)).toContain('pent_line');
    expect(scored.deals.slice(BASE_SIZE)).not.toContain('pent_line');
  });

  it('leaves the daily on the base bag whatever the player scores', () => {
    expect(DIFFICULTY_CONFIGS.daily.bagByTier).toBe(false);
    const scored = scriptedRun(DIFFICULTY_CONFIGS.daily, 'daily', 8, 26);
    const quiet = scriptedRun(DIFFICULTY_CONFIGS.daily, 'daily', 0, 26);

    expect(scored.tierIndex).toBeGreaterThanOrEqual(2);   // well past ARCHITECT
    expect(quiet.tierIndex).toBe(0);
    // One puzzle a day for everyone means one mix for everyone, deal for deal
    expect(scored.deals).toEqual(quiet.deals);
  });

  it('is on for the modes that race', () => {
    expect(DIFFICULTY_CONFIGS.classic.bagByTier).toBe(true);
    expect(DIFFICULTY_CONFIGS.blitz.bagByTier).toBe(true);
  });
});
