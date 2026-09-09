import { Board } from '../src/core/Board';
import { GameState } from '../src/core/GameState';
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

/**
 * Let the echo walls of the last claim fade.
 *
 * Tests script one situation after another by overwriting `board.grid` with
 * no time passing, which no real run does. A claim leaves its fence standing
 * as echo walls and the floor it took solid until they fade, so back-to-back
 * scripted placements would be judged against the previous board's ghosts.
 * The piece clock is put back afterwards: the next scripted placement is a
 * fresh situation, not a player who sat on the piece for two seconds.
 */
export function jumpPastEcho(gs: GameState): void {
  const pieceElapsed = gs.pieceElapsed;
  gs.tick(gs.config.echo.windowSeconds + 0.01);
  gs.pieceElapsed = pieceElapsed;
}
