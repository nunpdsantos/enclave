import { describe, it, expect } from 'vitest';
import { GameState } from '../src/core/GameState';
import { INNER_CELLS } from '../src/core/Board';
import { makePiece } from '../src/core/Pieces';
import { DIFFICULTY_CONFIGS, GameConfig } from '../src/core/Config';
import { FeedbackEvent, GridPos } from '../src/core/types';
import { grid, jumpPastEcho } from './helpers';

/**
 * Territory: the board's memory. Claimed floor stays lit, relit floor pays
 * half, and lighting all 49 inner cells banks the survey bonus and wipes the
 * map. Same style as scoring.test.ts — GameState is driven directly, with the
 * board and the hand set immediately before each placement.
 */

const WHITE = 0xffffff;

/** A 2×2 room at rows 3–4 / cols 3–4, needing one more block at (2,3) */
const ROOM_2X2_OPEN = [
  '.........',
  '.........',
  '....#....',
  '..#..#...',
  '..#..#...',
  '...##....',
];

const ROOM_2X2_CELLS: GridPos[] = [
  { row: 3, col: 3 }, { row: 3, col: 4 }, { row: 4, col: 3 }, { row: 4, col: 4 },
];

/** A 1-cell room at (4,4), needing one more block at (4,5) */
const ROOM_1X1_OPEN = [
  '.........',
  '.........',
  '.........',
  '....#....',
  '...#.....',
  '....#....',
];

function newGame(territory?: Partial<GameConfig['territory']>): GameState {
  const base = DIFFICULTY_CONFIGS.classic;
  const config: GameConfig = { ...base, territory: { ...base.territory, ...territory } };
  const gs = new GameState(config, 'classic');
  gs.start();
  return gs;
}

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

/** Every inner cell, optionally minus one, for driving the survey */
function innerCells(except?: GridPos): GridPos[] {
  const cells: GridPos[] = [];
  for (let r = 1; r <= 7; r++) {
    for (let c = 1; c <= 7; c++) {
      if (except && except.row === r && except.col === c) continue;
      cells.push({ row: r, col: c });
    }
  }
  return cells;
}

describe('territory factor', () => {
  it('pays full price on floor that has never been claimed', () => {
    const gs = newGame();
    const claim = claimEvent(placeSingle(gs, ROOM_2X2_OPEN, 2, 3));

    expect(claim.scoreBreakdown!.territoryFactor).toBe(1);
    expect(claim.scoreBreakdown!.basePoints).toBe(160);
    expect(claim.scoreBreakdown!.turnScore).toBe(160);
  });

  it('pays half for the same room rebuilt on fully lit floor', () => {
    const gs = newGame();
    gs.board.markLit(ROOM_2X2_CELLS);

    const claim = claimEvent(placeSingle(gs, ROOM_2X2_OPEN, 2, 3));
    expect(claim.scoreBreakdown!.territoryFactor).toBe(0.5);
    expect(claim.scoreBreakdown!.turnScore).toBe(80);       // 160 × 0.5
    expect(gs.score).toBe(81);                              // 1 block + 80
  });

  it('pays three quarters when half the floor is fresh', () => {
    const gs = newGame();
    gs.board.markLit([ROOM_2X2_CELLS[0], ROOM_2X2_CELLS[1]]);

    const claim = claimEvent(placeSingle(gs, ROOM_2X2_OPEN, 2, 3));
    expect(claim.scoreBreakdown!.territoryFactor).toBe(0.75);
    expect(claim.scoreBreakdown!.turnScore).toBe(120);      // 160 × 0.75
  });

  it('prices a seventh exactly, with no floating-point point lost', () => {
    // 7² × 10 × (0.5 + 0.5 × 2/7) is exactly 315, but computing it in that
    // order gives 314.99999999999994 and floor() would pay 314.
    const gs = newGame();
    const cells: GridPos[] = Array.from({ length: 7 }, (_, i) => ({ row: 3, col: i + 1 }));
    gs.board.markLit(cells.slice(0, 5));

    const points = gs.claimPoints([{ cells, fence: [], echoCells: [], ruinCells: [], area: 7 }]);
    expect(points.basePoints).toBe(315);
    expect(points.turnScore).toBe(315);
  });
});

describe('lighting the floor', () => {
  it('lights the room cells and nothing else', () => {
    const gs = newGame();
    placeSingle(gs, ROOM_2X2_OPEN, 2, 3);

    for (const cell of ROOM_2X2_CELLS) {
      expect(gs.board.lit[cell.row][cell.col]).toBe(true);
    }
    // Fence blocks, the placed block, and open floor outside the room
    for (const [row, col] of [[2, 3], [2, 4], [3, 2], [3, 5], [5, 3], [1, 1], [6, 6]]) {
      expect(`${row},${col}:${gs.board.lit[row][col]}`).toBe(`${row},${col}:false`);
    }
    expect(gs.board.litCount()).toBe(4);
  });

  it('never lights an edge cell, because no room can reach one', () => {
    const gs = newGame();
    gs.board.markLit([{ row: 0, col: 0 }, { row: 0, col: 4 }, { row: 4, col: 0 }, { row: 8, col: 8 }]);

    expect(gs.board.litCount()).toBe(0);
    expect(gs.board.isInner(0, 4)).toBe(false);
    expect(gs.board.isInner(1, 1)).toBe(true);
    expect(gs.board.isInner(7, 7)).toBe(true);
    expect(gs.board.isInner(8, 7)).toBe(false);
  });

  it('carries the lit map into a clone, so a preview prices the same floor', () => {
    const gs = newGame();
    gs.board.markLit(ROOM_2X2_CELLS);
    const clone = gs.board.clone();

    expect(clone.litCount()).toBe(4);
    clone.clearLit();
    expect(gs.board.litCount()).toBe(4);                    // and the copy is deep
  });
});

describe('preview parity on mixed floor', () => {
  it('quotes exactly what the placement then pays', () => {
    const gs = newGame();
    gs.board.grid = grid(ROOM_2X2_OPEN);
    gs.board.markLit([ROOM_2X2_CELLS[0], ROOM_2X2_CELLS[1], ROOM_2X2_CELLS[2]]);

    // What GhostRenderer is fed: a clone, placed, flood-filled, priced
    const probe = gs.board.clone();
    const piece = makePiece('single', 0, WHITE);
    probe.place(piece.shape, 2, 3, piece.color);
    const quoted = gs.claimPoints(probe.findEnclosures());

    gs.current = makePiece('single', 0, WHITE);
    const paid = claimEvent(gs.tryPlace(2, 3)).scoreBreakdown!;

    expect(quoted.territoryFactor).toBe(0.625);             // 1 of 4 cells fresh
    expect(quoted.turnScore).toBe(100);                     // floor(160 × 0.625)
    expect(paid.turnScore).toBe(quoted.turnScore);
    expect(paid.basePoints).toBe(quoted.basePoints);
  });
});

describe('the survey', () => {
  it('pays the flat bonus and wipes the map when the last cell lights', () => {
    const gs = newGame();
    gs.board.markLit(innerCells({ row: 4, col: 4 }));
    expect(gs.board.litCount()).toBe(INNER_CELLS - 1);

    const events = placeSingle(gs, ROOM_1X1_OPEN, 4, 5);
    const claim = claimEvent(events);
    const survey = events.find(e => e.type === 'survey');

    expect(claim.claim!.totalArea).toBe(1);
    expect(claim.scoreBreakdown!.turnScore).toBe(10);       // fresh cell, full price
    expect(survey).toBeDefined();
    expect(survey!.surveyBonus).toBe(5000);
    expect(survey!.surveys).toBe(1);
    expect(gs.surveys).toBe(1);
    expect(gs.score).toBe(5011);                            // 1 block + 10 + 5000
    expect(gs.board.litCount()).toBe(0);
  });

  it('is flat: the streak multiplier never touches it', () => {
    const gs = newGame();
    gs.streakCount = 4;                                     // ×2 on the claim
    gs.board.markLit(innerCells({ row: 4, col: 4 }));

    placeSingle(gs, ROOM_1X1_OPEN, 4, 5);
    expect(gs.score).toBe(5021);                            // 1 + floor(10 × 2) + 5000
  });

  it('uses the mode bonus, so Blitz pays 2,500', () => {
    const gs = new GameState(DIFFICULTY_CONFIGS.blitz, 'blitz');
    gs.start();
    gs.board.markLit(innerCells({ row: 4, col: 4 }));

    const events = placeSingle(gs, ROOM_1X1_OPEN, 4, 5);
    expect(events.find(e => e.type === 'survey')!.surveyBonus).toBe(2500);
    expect(gs.score).toBe(2511);
  });

  it('reports the survey in the run summary', () => {
    const gs = newGame();
    gs.board.markLit(innerCells({ row: 4, col: 4 }));
    placeSingle(gs, ROOM_1X1_OPEN, 4, 5);
    jumpPastEcho(gs);
    placeSingle(gs, ROOM_2X2_OPEN, 2, 3);                   // 4 cells lit again

    const summary = gs.buildRunSummary('quit');
    expect(summary.surveys).toBe(1);
    expect(summary.litCells).toBe(4);
  });
});

describe('territory disabled', () => {
  it('leaves scoring exactly where it was, lit floor or not', () => {
    const gs = newGame({ enabled: false });
    gs.board.markLit(ROOM_2X2_CELLS);

    const claim = claimEvent(placeSingle(gs, ROOM_2X2_OPEN, 2, 3));
    expect(claim.scoreBreakdown!.territoryFactor).toBe(1);
    expect(claim.scoreBreakdown!.turnScore).toBe(160);
    expect(gs.score).toBe(161);
  });

  it('lights nothing and never surveys', () => {
    const gs = newGame({ enabled: false });
    gs.board.markLit(innerCells({ row: 4, col: 4 }));

    const events = placeSingle(gs, ROOM_1X1_OPEN, 4, 5);
    expect(events.some(e => e.type === 'survey')).toBe(false);
    expect(gs.surveys).toBe(0);
    expect(gs.score).toBe(11);                              // 1 block + 10, no bonus
    expect(gs.board.litCount()).toBe(INNER_CELLS - 1);      // untouched by the claim
  });
});
