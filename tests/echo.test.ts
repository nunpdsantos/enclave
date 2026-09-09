import { describe, it, expect } from 'vitest';
import { GameState } from '../src/core/GameState';
import { makePiece } from '../src/core/Pieces';
import { DIFFICULTY_CONFIGS, GameConfig } from '../src/core/Config';
import { FeedbackEvent } from '../src/core/types';
import { board, hasCell, keys } from './helpers';

/**
 * Echo walls: a claim's fence goes on holding the flood back for a moment
 * after it is removed, so the room next door can still be closed against it —
 * for a bonus — instead of falling open the way a shared wall used to leave it.
 */

const WHITE = 0xffffff;

/**
 * Two one-cell rooms, (4,3) and (4,5), sharing the wall at (4,4).
 *
 * Room A closes with a block at (3,3). That claim takes the shared wall with
 * it, and room B — which needs a block at (3,5) — can only be closed at all
 * while the ghost of (4,4) is still standing.
 */
const SHARED_WALL = [
  '.........',
  '.........',
  '.........',
  '.........',
  '..#.#.#..',
  '...#.#...',
];

/**
 * The same two rooms, but boxed in above and below, so that once room B has
 * eaten the ghost of the shared wall the gap at (4,4) is itself walled in on
 * every side: two real blocks, and the floor the two claims took.
 */
const SHARED_WALL_BOXED = [
  '.........',
  '.........',
  '.........',
  '....#....',
  '..#.#.#..',
  '...###...',
];

/** What SHARED_WALL looks like once room A has been claimed and its fence gone */
const AFTER_CLAIM_A = [
  '.........',
  '.........',
  '.........',
  '.........',
  '......#..',
  '.....#...',
];

function newGame(config: GameConfig = DIFFICULTY_CONFIGS.classic, difficulty: 'classic' | 'daily' = 'classic'): GameState {
  const gs = new GameState(config, difficulty);
  gs.start();
  gs.board.grid = board(SHARED_WALL).grid;
  return gs;
}

/** Drop a single block at (row, col) with whatever board is already there */
function dropBlock(gs: GameState, row: number, col: number): FeedbackEvent[] {
  gs.current = makePiece('single', 0, WHITE);
  return gs.tryPlace(row, col);
}

function claimEvent(events: FeedbackEvent[]): FeedbackEvent {
  const e = events.find(x => x.type === 'claim');
  if (!e) throw new Error('expected a claim event');
  return e;
}

describe('Board.findEnclosures with echo walls', () => {
  it('closes a room against an echo cell and says which cell it was', () => {
    const b = board([...AFTER_CLAIM_A.slice(0, 3), '.....#...', ...AFTER_CLAIM_A.slice(4)]);

    // Without the ghost the room leaks out through (4,4) and away to the edge
    expect(b.findEnclosures()).toEqual([]);

    const regions = b.findEnclosures(new Set(['4,4']));
    expect(regions).toHaveLength(1);
    expect(keys(regions[0].cells)).toEqual(['4,5']);
    expect(keys(regions[0].fence)).toEqual(['3,5', '4,6', '5,5']);
    // The ghost bounds the room but is not fence: there is no block to remove
    expect(keys(regions[0].echoCells)).toEqual(['4,4']);
  });

  it('reports no echo cells when there are none, as it always did', () => {
    const b = board([
      '.........',
      '.........',
      '..####...',
      '..#..#...',
      '..#..#...',
      '..####...',
    ]);
    const regions = b.findEnclosures();
    expect(regions).toHaveLength(1);
    expect(regions[0].echoCells).toEqual([]);
    expect(regions[0].fence).toHaveLength(8);
  });
});

describe('Board.findClosingCells with echo walls', () => {
  it('marks the cell that completes a room against a ghost wall', () => {
    const b = board(AFTER_CLAIM_A);

    // Nothing is one block from closing while (4,4) is a hole
    expect(hasCell(b.findClosingCells(), 3, 5)).toBe(false);
    expect(hasCell(b.findClosingCells(new Set(['4,4'])), 3, 5)).toBe(true);
  });
});

describe('an echo close', () => {
  it('pays the multiplier and eats the ghost that made it possible', () => {
    const gs = newGame();

    const first = claimEvent(dropBlock(gs, 3, 3));
    expect(first.scoreBreakdown!.echoMultiplier).toBe(1);   // nothing to echo yet
    expect(gs.score).toBe(11);                              // 1 block + 1² × 10
    // The whole fence lingers, the floor it took with it
    expect(gs.activeEchoKeys().has('4,4')).toBe(true);
    expect(gs.echoWalls().map(w => `${w.row},${w.col}`).sort())
      .toEqual(['3,3', '4,2', '4,4', '5,3']);

    const second = claimEvent(dropBlock(gs, 3, 5));
    expect(keys(second.claim!.regions[0].echoCells)).toEqual(['4,4']);
    expect(second.scoreBreakdown!.echoMultiplier).toBe(1.25);
    // floor(10 × 1 room × 1.25 streak × 1.25 echo)
    expect(second.scoreBreakdown!.turnScore).toBe(15);
    expect(gs.score).toBe(27);                              // 11 + 1 block + 15

    // Spent: the ghost that bounded the claim is gone, the rest still stand
    expect(gs.activeEchoKeys().has('4,4')).toBe(false);
    expect(gs.activeEchoKeys().has('4,2')).toBe(true);
  });

  it('quotes the drag preview exactly what it then pays', () => {
    const gs = newGame();
    dropBlock(gs, 3, 3);

    // Precisely what GameScene.closePreview does: a clone, the piece on it,
    // and the live echo set standing
    const probe = gs.board.clone();
    const piece = makePiece('single', 0, WHITE);
    probe.place(piece.shape, 3, 5, WHITE);
    const regions = gs.claimableRegions(probe);
    expect(regions).toHaveLength(1);
    const quoted = gs.claimPoints(regions);
    expect(quoted.echoMultiplier).toBe(1.25);

    expect(claimEvent(dropBlock(gs, 3, 5)).scoreBreakdown!.turnScore).toBe(quoted.turnScore);
  });

  it('is gone once the window closes, and so is the close', () => {
    const gs = newGame();
    dropBlock(gs, 3, 3);
    const versionWithEcho = gs.echoVersion;

    gs.tick(gs.config.echo.windowSeconds + 0.01);
    expect(gs.activeEchoKeys().size).toBe(0);
    expect(gs.echoVersion).toBeGreaterThan(versionWithEcho);

    // The same block on the same board now encloses nothing at all
    const events = dropBlock(gs, 3, 5);
    expect(events.some(e => e.type === 'claim')).toBe(false);
    expect(gs.score).toBe(12);                              // 11 + the block
  });

  it('holds the window open until it is up', () => {
    const gs = newGame();
    dropBlock(gs, 3, 3);

    gs.tick(gs.config.echo.windowSeconds - 0.1);
    expect(gs.activeEchoKeys().has('4,4')).toBe(true);
    expect(claimEvent(dropBlock(gs, 3, 5)).scoreBreakdown!.echoMultiplier).toBe(1.25);
  });

  it('lets a piece land on a ghost, which then stops being one', () => {
    const gs = newGame();
    dropBlock(gs, 3, 3);
    expect(gs.activeEchoKeys().has('4,2')).toBe(true);

    dropBlock(gs, 4, 2);                                    // straight onto the ghost
    expect(gs.board.getCell(4, 2)).toBe(WHITE);
    expect(gs.activeEchoKeys().has('4,2')).toBe(false);
  });

  it('never pays twice for the floor it just took', () => {
    const gs = newGame();
    dropBlock(gs, 3, 3);
    const scoreAfterClaim = gs.score;

    // Room A's floor is ringed by its own ghosts, but it is not a new room:
    // dropping a block anywhere must not re-close it, and neither must a
    // block put back into one of its own fence positions.
    expect(dropBlock(gs, 0, 0).some(e => e.type === 'claim')).toBe(false);
    expect(dropBlock(gs, 3, 3).some(e => e.type === 'claim')).toBe(false);
    expect(gs.score).toBe(scoreAfterClaim + 2);             // the two blocks, nothing else
  });

  it('does not pay for the gap two claims leave between them', () => {
    const gs = newGame();
    gs.board.grid = board(SHARED_WALL_BOXED).grid;
    dropBlock(gs, 3, 3);                                    // claim A
    dropBlock(gs, 3, 5);                                    // claim B, off the ghost
    const scoreAfterClaims = gs.score;

    // (4,4) really is enclosed now: two blocks, and on the other two sides the
    // floor the claims took. That floor is invisible, so a claim there would
    // be a room closing against nothing the player can see.
    const enclosed = gs.board.findEnclosures(gs.activeEchoKeys());
    expect(keys(enclosed.flatMap(r => r.cells))).toEqual(['4,4']);
    expect(gs.claimableRegions(gs.board)).toEqual([]);

    expect(dropBlock(gs, 0, 0).some(e => e.type === 'claim')).toBe(false);
    expect(gs.score).toBe(scoreAfterClaims + 1);            // the block, nothing else
  });

  it('bumps the version whenever the set moves, so views can poll it', () => {
    const gs = newGame();
    const start = gs.echoVersion;
    dropBlock(gs, 3, 3);                                    // added
    const added = gs.echoVersion;
    expect(added).toBeGreaterThan(start);

    dropBlock(gs, 3, 5);                                    // consumed one, added more
    expect(gs.echoVersion).toBeGreaterThan(added);
    const consumed = gs.echoVersion;

    gs.tick(gs.config.echo.windowSeconds + 0.01);           // expired
    expect(gs.echoVersion).toBeGreaterThan(consumed);
    // Nothing left to prune: a quiet tick must not keep bumping it
    const settled = gs.echoVersion;
    gs.tick(1);
    expect(gs.echoVersion).toBe(settled);
  });
});

describe('echo disabled', () => {
  it('records nothing and pays nothing extra in the daily', () => {
    const gs = newGame(DIFFICULTY_CONFIGS.daily, 'daily');
    expect(gs.config.echo.enabled).toBe(false);

    const first = claimEvent(dropBlock(gs, 3, 3));
    expect(first.scoreBreakdown!.echoMultiplier).toBe(1);
    expect(gs.activeEchoKeys().size).toBe(0);
    expect(gs.echoWalls()).toEqual([]);

    // With no ghost holding (4,4), the shared wall is the old pitfall again
    expect(dropBlock(gs, 3, 5).some(e => e.type === 'claim')).toBe(false);
  });
});
