import { Board } from '../src/core/Board';
import { Difficulty, DIFFICULTY_CONFIGS } from '../src/core/Config';
import { GameState } from '../src/core/GameState';
import { rotatePiece, rotationCount } from '../src/core/Pieces';
import { RULES_VERSION } from '../src/core/Rules';
import { FeedbackEvent, Grid, GridPos, GRID_SIZE, PieceInstance, Replay } from '../src/core/types';

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

/**
 * The replay field of a hand-built RunSummary fixture: the right shape, with
 * no run in it. The tests that use one are asserting on what a summary says
 * about a run, not on whether the run can be proved.
 */
export function emptyReplay(mode: Difficulty = 'classic'): Replay {
  return { rules: RULES_VERSION, mode, seed: 1, moves: [] };
}

// ── A player, for the tests that need a real run rather than a scripted board ──

/**
 * Everything else in `tests/` sets `board.grid` and `current` by hand, which
 * no replay can reproduce: a replay only carries inputs, and the pieces come
 * from the seed. So the replay tests need a run that was actually *played* —
 * pieces as dealt, placements the board accepted — and this is the player.
 *
 * It is a one-ply greedy bot: try every rotation in every legal position,
 * take whatever claims most, and break ties toward cells that leave the board
 * closer to a close. Deterministic, so a seed names one exact run.
 */
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** How close a board is to a claim: cells with three walls around them count most */
function pressure(b: Board): number {
  let n = 0;
  for (let r = 1; r < GRID_SIZE - 1; r++) {
    for (let c = 1; c < GRID_SIZE - 1; c++) {
      if (b.grid[r][c] !== null) continue;
      let walls = 0;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= GRID_SIZE || nc >= GRID_SIZE) continue;
        if (b.grid[nr][nc] !== null) walls++;
      }
      if (walls >= 3) n += 3;
      else if (walls === 2) n += 1;
    }
  }
  return n;
}

interface BotMove { rot: number; row: number; col: number; value: number }

function bestPlacement(gs: GameState): BotMove | null {
  const piece = gs.current;
  if (!piece) return null;
  let best: BotMove | null = null;
  let p: PieceInstance = piece;
  for (let turn = 0; turn < rotationCount(piece); turn++) {
    for (let row = 0; row + p.rows <= GRID_SIZE; row++) {
      for (let col = 0; col + p.cols <= GRID_SIZE; col++) {
        if (!gs.board.canPlace(p.shape, row, col)) continue;
        const after = gs.board.clone();
        after.place(p.shape, row, col, p.color);
        const regions = gs.claimableRegions(after);
        const claim = regions.length > 0 ? gs.claimPoints(regions).turnScore : 0;
        // Claims dominate; then board pressure; then keep the board sparse
        const value = claim * 1000 + pressure(after) * 10 - after.occupiedCount();
        if (!best || value > best.value) best = { rot: p.rotation, row, col, value };
      }
    }
    p = rotatePiece(p);
  }
  return best;
}

export interface BotRun {
  gs: GameState;
  /** The events of each placement, in order, for asserting what the run contained */
  events: FeedbackEvent[][];
  replay: Replay;
  score: number;
}

export interface BotOptions {
  /** Move index at which to park a piece instead of placing one. -1 for never. */
  holdAt?: number;
  /**
   * Seconds between moves. The default varies with the move index, which
   * keeps the gaps off exact multiples of an echo window: a move landing on
   * the millisecond a ghost expires is the one thing a 3-decimal timestamp
   * cannot reproduce, and a test should not be sitting on that edge.
   */
  step?: (i: number) => number;
}

const DEFAULT_STEP = (i: number): number => 0.25 + 0.11 * (i % 4);

/** Play `moves` inputs of a real run and hand back the recorded replay. */
export function playBotRun(
  mode: Difficulty, seed: number, moves: number, opts: BotOptions = {},
): BotRun {
  const holdAt = opts.holdAt ?? 5;
  const step = opts.step ?? DEFAULT_STEP;
  const gs = new GameState({ ...DIFFICULTY_CONFIGS[mode], seed }, mode);
  gs.start();
  const events: FeedbackEvent[][] = [];
  for (let i = 0; i < moves && !gs.isGameOver; i++) {
    if (gs.tick(step(i))) break;
    if (i === holdAt && !gs.holdUsed && (gs.held !== null || gs.queue.length > 0)) {
      gs.hold();
      continue;
    }
    const move = bestPlacement(gs);
    if (!move) break;
    // Turn the piece the way the bot wants it, exactly as a player would
    for (let n = 0; n < 4 && gs.current !== null && gs.current.rotation !== move.rot; n++) {
      gs.rotate();
    }
    const ev = gs.tryPlace(move.row, move.col);
    if (ev.length === 0) break;
    events.push(ev);
  }
  return { gs, events, replay: gs.buildReplay(), score: gs.score };
}
