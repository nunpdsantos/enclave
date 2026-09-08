import { Board } from '../src/core/Board';
import { Grid, GridPos, GRID_SIZE } from '../src/core/types';

/**
 * Boards as ASCII so a test reads like the thing it is asserting:
 * '.' is empty, anything else is a block.
 */
export const EMPTY = '.';
export const BLOCK = '#';

const TEST_COLOR = 0x4b7bec;

/** Build a 9×9 grid from rows of strings. Missing rows/cols are empty. */
export function grid(rows: string[]): Grid {
  if (rows.length > GRID_SIZE) {
    throw new Error(`Too many rows: ${rows.length} > ${GRID_SIZE}`);
  }
  return Array.from({ length: GRID_SIZE }, (_, r) =>
    Array.from({ length: GRID_SIZE }, (_, c) => {
      const ch = rows[r]?.[c] ?? EMPTY;
      return ch === EMPTY ? null : TEST_COLOR;
    }),
  );
}

export function board(rows: string[]): Board {
  const b = new Board();
  b.grid = grid(rows);
  return b;
}

/** 'row,col' strings, sorted — the readable form for set comparisons. */
export function keys(cells: GridPos[]): string[] {
  return cells.map(p => `${p.row},${p.col}`).sort();
}

export function hasCell(cells: GridPos[], row: number, col: number): boolean {
  return cells.some(p => p.row === row && p.col === col);
}
