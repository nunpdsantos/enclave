import { Board } from './Board';
import { SiegeConfig } from './Config';
import { Rng } from './Random';
import { GRID_SIZE, GridPos, Raider } from './types';

/**
 * Hold the Keep: the second force.
 *
 * Everything here is pure and deterministic — a board, a config and a seeded
 * RNG in, the enemy's next state out — because a replay has to reproduce the
 * siege exactly from the seed and the placements. Nothing reads a clock, the
 * DOM or storage.
 *
 * The one idea underneath both enemies is a **weighted distance field**: a
 * Dijkstra from the Keep where open floor costs 1, a player wall costs 4 and a
 * ruin is impassable. A raider steps to the neighbour with the lowest distance;
 * the tide expands into the frontier cell with the lowest distance. Weighting a
 * wall at 4 rather than infinity is what makes a wall a *delay* rather than a
 * door: it will be walked through when going round costs more than four cells,
 * which is the decision the player is actually making when they build one.
 */

/** Cost of entering a cell, by what is in it */
export const FLOOR_COST = 1;
export const WALL_COST = 4;

/**
 * The order neighbours are considered in: up, down, left, right. Fixed, so a
 * tie between two equal steps is resolved the same way on every machine — the
 * seeded draw below only ever chooses *among* a list built in this order.
 */
const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** Unreachable. Kept finite so comparisons never have to special-case it. */
export const UNREACHABLE = Number.POSITIVE_INFINITY;

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && col >= 0 && row < GRID_SIZE && col < GRID_SIZE;
}

export function keyOf(p: GridPos): string {
  return `${p.row},${p.col}`;
}

/**
 * What it costs to enter a cell, or null when nothing can.
 *
 * Ruins are the only impassable terrain. The Keep and the gates cost what
 * floor costs — the Keep is the destination, and a gate the enemy came
 * through is not a wall behind it.
 */
export function enterCost(board: Board, row: number, col: number): number | null {
  if (board.terrain[row][col] === 'ruin') return null;
  return board.grid[row][col] !== null ? WALL_COST : FLOOR_COST;
}

/**
 * Weighted distance from every cell to the Keep.
 *
 * Dijkstra outward from the Keep, so `dist[r][c]` is the cost of the cheapest
 * route from (r, c) *to* the Keep. Costs attach to the cell being entered,
 * and the Keep itself is 0. An 81-cell grid with integer weights, so a plain
 * O(n²) scan is quicker than a heap and has no ordering ambiguity in it.
 */
export function distanceToKeep(board: Board, keep: GridPos): number[][] {
  const dist: number[][] = Array.from({ length: GRID_SIZE }, () =>
    Array(GRID_SIZE).fill(UNREACHABLE),
  );
  const done: boolean[][] = Array.from({ length: GRID_SIZE }, () =>
    Array(GRID_SIZE).fill(false),
  );
  dist[keep.row][keep.col] = 0;

  for (let n = 0; n < GRID_SIZE * GRID_SIZE; n++) {
    // Cheapest unsettled cell. Ties fall to reading order, which is fixed.
    let best: GridPos | null = null;
    let bestDist = UNREACHABLE;
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        if (done[r][c] || dist[r][c] >= bestDist) continue;
        best = { row: r, col: c };
        bestDist = dist[r][c];
      }
    }
    if (!best) break;
    done[best.row][best.col] = true;

    for (const [dr, dc] of DIRS) {
      const nr = best.row + dr, nc = best.col + dc;
      if (!inBounds(nr, nc) || done[nr][nc]) continue;
      // The cost is the neighbour's own: stepping *out of* a cell is free,
      // stepping *into* a wall is what costs four.
      const cost = enterCost(board, nr, nc);
      if (cost === null) continue;
      const next = bestDist + cost;
      if (next < dist[nr][nc]) dist[nr][nc] = next;
    }
  }
  return dist;
}

/**
 * Pick one of several equally good cells.
 *
 * The list is always built in a fixed order, so the draw is reproducible from
 * the seed alone: same seed, same moves, same choice, on any device. A single
 * candidate takes no draw at all, which keeps the RNG stream stable across the
 * overwhelming majority of turns where there is nothing to break.
 */
export function pickTied<T>(candidates: T[], rng: Rng): T | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const i = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length));
  return candidates[i];
}

// ── Raiders ──

/** What one raider does this turn */
export interface RaiderStep {
  id: number;
  /** Where it ends up. Unchanged when it stopped to break a wall. */
  to: GridPos;
  /** The player block it destroyed instead of moving, if any */
  brokeWall: GridPos | null;
}

/**
 * Where a raider would go next, before anything is applied.
 *
 * `blocked` is the cells other raiders hold: a raider cannot enter one this
 * turn. It is *this turn's* occupancy, deliberately — a queue of raiders in a
 * corridor shuffles forward one cell a turn rather than teleporting through
 * each other, and it is the behaviour the intent arrows have to be able to
 * draw before the player commits.
 */
export function raiderTarget(
  board: Board,
  raider: GridPos,
  dist: number[][],
  blocked: ReadonlySet<string>,
  rng: Rng,
): GridPos | null {
  let bestDist = UNREACHABLE;
  let best: GridPos[] = [];
  for (const [dr, dc] of DIRS) {
    const nr = raider.row + dr, nc = raider.col + dc;
    if (!inBounds(nr, nc)) continue;
    if (enterCost(board, nr, nc) === null) continue;
    if (blocked.has(`${nr},${nc}`)) continue;
    const d = dist[nr][nc];
    if (d > bestDist) continue;
    if (d < bestDist) { bestDist = d; best = []; }
    best.push({ row: nr, col: nc });
  }
  // A raider walled in on every side, or with no route left, simply holds
  if (bestDist === UNREACHABLE) return null;
  return pickTied(best, rng);
}

/**
 * One enemy phase for the raiders: every raider takes a step, or breaks the
 * wall in its way and stays where it is.
 *
 * Raiders move in id order, oldest first, and the occupancy set is updated as
 * they go, so the one in front moves before the one behind it and the queue
 * does not deadlock on itself. The board is mutated only where a wall comes
 * down; the raider positions come back for the caller to apply, so the caller
 * still owns the entity list.
 */
export function stepRaiders(
  board: Board, raiders: Raider[], keep: GridPos, rng: Rng,
): RaiderStep[] {
  const dist = distanceToKeep(board, keep);
  const held = new Set(raiders.map(keyOf));
  const steps: RaiderStep[] = [];

  for (const raider of raiders) {
    held.delete(keyOf(raider));
    const target = raiderTarget(board, raider, dist, held, rng);
    if (!target) {
      held.add(keyOf(raider));
      steps.push({ id: raider.id, to: { row: raider.row, col: raider.col }, brokeWall: null });
      continue;
    }
    if (board.grid[target.row][target.col] !== null) {
      // A wall in the way is knocked down and the turn is spent doing it:
      // the cost of a wall is a turn of the raider's, and that is the whole
      // reason building one is worth a placement.
      board.grid[target.row][target.col] = null;
      held.add(keyOf(raider));
      steps.push({ id: raider.id, to: { row: raider.row, col: raider.col }, brokeWall: target });
      continue;
    }
    held.add(keyOf(target));
    steps.push({ id: raider.id, to: target, brokeWall: null });
  }
  return steps;
}

// ── Tide ──

/** What the tide does on one tick of its tempo */
export interface TideStep {
  /** The cell it took, or null when it spent the tick eroding */
  claimed: GridPos | null;
  /** The player block it destroyed instead of expanding, if any */
  erodedWall: GridPos | null;
}

/**
 * The cell the tide would take next.
 *
 * Every cell orthogonally touching the tide that the tide does not already
 * hold and a ruin does not block — player walls included, since eroding one
 * is how the tide gets through it — ranked by weighted distance to the Keep.
 * Scanned in reading order so the tie list is fixed before the seeded draw.
 */
export function tideTarget(
  board: Board, tide: ReadonlySet<string>, keep: GridPos, rng: Rng,
): GridPos | null {
  const dist = distanceToKeep(board, keep);
  let bestDist = UNREACHABLE;
  let best: GridPos[] = [];

  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (tide.has(`${r},${c}`)) continue;
      if (enterCost(board, r, c) === null) continue;
      let touches = false;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (inBounds(nr, nc) && tide.has(`${nr},${nc}`)) { touches = true; break; }
      }
      if (!touches) continue;
      const d = dist[r][c];
      if (d > bestDist) continue;
      if (d < bestDist) { bestDist = d; best = []; }
      best.push({ row: r, col: c });
    }
  }
  if (bestDist === UNREACHABLE) return null;
  return pickTied(best, rng);
}

/**
 * One tick of the tide. Mutates the board where a wall is eroded; the caller
 * applies the claimed cell to its own set.
 */
export function stepTide(
  board: Board, tide: ReadonlySet<string>, keep: GridPos, rng: Rng,
): TideStep {
  const target = tideTarget(board, tide, keep, rng);
  if (!target) return { claimed: null, erodedWall: null };
  if (board.grid[target.row][target.col] !== null) {
    board.grid[target.row][target.col] = null;
    return { claimed: null, erodedWall: target };
  }
  return { claimed: target, erodedWall: null };
}

// ── Intent: what the enemy will do next, for the player to read ──

export interface SiegeIntent {
  /** Where each raider will step, by raider id */
  steps: Map<number, GridPos>;
  /** Player blocks that will be attacked next: raider targets and tide erosion */
  threatenedWalls: GridPos[];
  /** The tide's next cell, or the wall it will erode */
  tideTarget: GridPos | null;
  /** Weighted route length from each enemy to the Keep, by raider id */
  routeLengths: Map<number, number>;
}

/**
 * What the enemy is about to do, computed against the board as it stands.
 *
 * Recomputed after every placement as well as after every enemy phase,
 * because a wall the player just built may have moved the whole route — which
 * is exactly the feedback the arrows exist to give.
 */
export function readIntent(
  board: Board, raiders: Raider[], tide: ReadonlySet<string>, keep: GridPos, rng: Rng,
): SiegeIntent {
  const dist = distanceToKeep(board, keep);
  const steps = new Map<number, GridPos>();
  const routeLengths = new Map<number, number>();
  const threatenedWalls: GridPos[] = [];

  const held = new Set(raiders.map(keyOf));
  for (const raider of raiders) {
    routeLengths.set(raider.id, dist[raider.row][raider.col]);
    held.delete(keyOf(raider));
    const target = raiderTarget(board, raider, dist, held, rng);
    held.add(keyOf(raider));
    if (!target) continue;
    steps.set(raider.id, target);
    if (board.grid[target.row][target.col] !== null) threatenedWalls.push(target);
  }

  let nextTide: GridPos | null = null;
  if (tide.size > 0) {
    nextTide = tideTarget(board, tide, keep, rng);
    if (nextTide && board.grid[nextTide.row][nextTide.col] !== null) {
      threatenedWalls.push(nextTide);
    }
  }

  return { steps, threatenedWalls, tideTarget: nextTide, routeLengths };
}

/**
 * How far the enemy is from the Keep, in *steps* rather than weighted cost —
 * the number a BREACH warning has to be honest about. Walls count as one step
 * each, because a raider that has to break one is still only one cell away.
 */
export function stepsToKeep(enemies: GridPos[], keep: GridPos): number {
  let best = UNREACHABLE;
  for (const e of enemies) {
    const d = Math.abs(e.row - keep.row) + Math.abs(e.col - keep.col);
    if (d < best) best = d;
  }
  return best;
}

/** The tempo of the nth tide expansion: it tightens, down to a floor. */
export function tideIntervalAt(config: SiegeConfig, tick: number): number {
  return Math.max(
    config.tideMinSeconds,
    config.tideSeconds - config.tideRampPerTick * tick,
  );
}
