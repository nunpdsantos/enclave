import { Board } from './Board';
import { Rng } from './Random';
import { GridPos, Raider } from './types';

/**
 * Hold the Keep: the second force.
 *
 * Everything here is pure and deterministic — a board, a config and a seeded
 * RNG in, the enemy's next state out — because a replay has to reproduce the
 * siege exactly from the placements. Nothing reads a clock, the DOM or
 * storage, and nothing here knows how big a board is: every function takes
 * one and reads `board.size`.
 *
 * The one idea underneath is a **weighted distance field**: a Dijkstra from
 * the Keep where open floor costs 1, a player wall costs `wallCost` and a ruin
 * is impassable. A raider steps to the neighbour with the lowest distance.
 * Weighting a wall at 4 rather than infinity is what makes a wall a *delay*
 * rather than a door: it will be walked through when going round costs more
 * than four cells, which is the decision the player is actually making when
 * they build one.
 */

/** Cost of entering open floor. The wall's cost is a config knob. */
export const FLOOR_COST = 1;
/** The default `wallCost`; the live value comes from SiegeConfig. */
export const DEFAULT_WALL_COST = 4;

/**
 * The order neighbours are considered in: up, down, left, right. Fixed, so a
 * tie between two equal steps is resolved the same way on every machine — the
 * seeded draw below only ever chooses *among* a list built in this order.
 */
const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** Unreachable. Kept finite so comparisons never have to special-case it. */
export const UNREACHABLE = Number.POSITIVE_INFINITY;

export function inBounds(row: number, col: number, size: number): boolean {
  return row >= 0 && col >= 0 && row < size && col < size;
}

export function keyOf(p: GridPos): string {
  return `${p.row},${p.col}`;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * What it costs to enter a cell, or null when nothing can.
 *
 * Ruins are the only impassable terrain. The Keep and the gates cost what
 * floor costs — the Keep is the destination, and a gate the enemy came
 * through is not a wall behind it.
 */
export function enterCost(
  board: Board, row: number, col: number, wallCost: number = DEFAULT_WALL_COST,
): number | null {
  if (board.terrain[row][col] === 'ruin') return null;
  return board.grid[row][col] !== null ? wallCost : FLOOR_COST;
}

/**
 * Weighted distance from every cell to the Keep.
 *
 * Dijkstra outward from the Keep, so `dist[r][c]` is the cost of the cheapest
 * route from (r, c) *to* the Keep. Costs attach to the cell being entered,
 * and the Keep itself is 0. A 121-cell grid with integer weights, so a plain
 * O(n²) scan is quicker than a heap and has no ordering ambiguity in it.
 *
 * **This is a cost, not a countdown.** A distance of 8 is not eight turns
 * away: a wall on the route contributes `wallCost` to the number but takes
 * the raider exactly one turn to break, so a route through two walls reads as
 * 10 and arrives in 4. Anything the player is shown as "steps to the Keep"
 * has to be counted in steps — see `stepsToKeep`.
 */
export function distanceToKeep(
  board: Board, keep: GridPos, wallCost: number = DEFAULT_WALL_COST,
): number[][] {
  const size = board.size;
  const dist: number[][] = Array.from({ length: size }, () =>
    Array(size).fill(UNREACHABLE),
  );
  const done: boolean[][] = Array.from({ length: size }, () =>
    Array(size).fill(false),
  );
  dist[keep.row][keep.col] = 0;

  for (let n = 0; n < size * size; n++) {
    // Cheapest unsettled cell. Ties fall to reading order, which is fixed.
    let best: GridPos | null = null;
    let bestDist = UNREACHABLE;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (done[r][c] || dist[r][c] >= bestDist) continue;
        best = { row: r, col: c };
        bestDist = dist[r][c];
      }
    }
    if (!best) break;
    done[best.row][best.col] = true;

    for (const [dr, dc] of DIRS) {
      const nr = best.row + dr, nc = best.col + dc;
      if (!inBounds(nr, nc, size) || done[nr][nc]) continue;
      // The cost is the neighbour's own: stepping *out of* a cell is free,
      // stepping *into* a wall is what costs `wallCost`.
      const cost = enterCost(board, nr, nc, wallCost);
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
 * the turn alone: same turn, same moves, same choice, on any device. A single
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
  wallCost: number = DEFAULT_WALL_COST,
): GridPos | null {
  let bestDist = UNREACHABLE;
  let best: GridPos[] = [];
  for (const [dr, dc] of DIRS) {
    const nr = raider.row + dr, nc = raider.col + dc;
    if (!inBounds(nr, nc, board.size)) continue;
    if (enterCost(board, nr, nc, wallCost) === null) continue;
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
 * One enemy phase for the raiders.
 *
 * Two passes, and the split is the whole point:
 *
 *  1. **Plan**, from one snapshot of the board. Every raider's intent is read
 *     against the same walls and the same occupancy, in id order, so no
 *     raider's plan depends on what an earlier one has already done. This is
 *     the snapshot the intent preview showed the player, which is what makes
 *     the preview a promise rather than a guess.
 *  2. **Resolve**, in id order, against the live board. A raider whose target
 *     turned out to be occupied by then waits where it is; one whose target
 *     wall has already been knocked down by a neighbour walks into the gap if
 *     it is free, and otherwise waits.
 *
 * Only the board's walls are mutated here. The positions come back for the
 * caller to apply, so the caller still owns the entity list.
 */
export function stepRaiders(
  board: Board,
  raiders: Raider[],
  keep: GridPos,
  rng: Rng,
  wallCost: number = DEFAULT_WALL_COST,
): RaiderStep[] {
  const plans = planRaiders(board, raiders, keep, rng, wallCost);
  return resolveRaiders(board, raiders, plans);
}

/** Pass one: every raider's intended target, read off a single snapshot. */
export function planRaiders(
  board: Board,
  raiders: Raider[],
  keep: GridPos,
  rng: Rng,
  wallCost: number = DEFAULT_WALL_COST,
): Map<number, GridPos> {
  const dist = distanceToKeep(board, keep, wallCost);
  const occupied = new Set(raiders.map(keyOf));
  const plans = new Map<number, GridPos>();
  for (const raider of raiders) {
    // Its own cell is not an obstacle to itself, but every other raider's is
    occupied.delete(keyOf(raider));
    const target = raiderTarget(board, raider, dist, occupied, rng, wallCost);
    occupied.add(keyOf(raider));
    if (target) plans.set(raider.id, target);
  }
  return plans;
}

/** Pass two: apply the plans in id order against the live board. */
export function resolveRaiders(
  board: Board, raiders: Raider[], plans: ReadonlyMap<number, GridPos>,
): RaiderStep[] {
  const positions = new Map(raiders.map(r => [r.id, { row: r.row, col: r.col }]));
  const held = new Set([...positions.values()].map(keyOf));
  const steps: RaiderStep[] = [];

  const stay = (r: Raider): RaiderStep =>
    ({ id: r.id, to: { row: r.row, col: r.col }, brokeWall: null });

  for (const raider of raiders) {
    const target = plans.get(raider.id);
    if (!target) { steps.push(stay(raider)); continue; }

    if (board.grid[target.row][target.col] !== null) {
      // A wall in the way is knocked down and the turn is spent doing it: the
      // cost of a wall is a turn of the raider's, and that is the whole reason
      // building one is worth a placement.
      board.grid[target.row][target.col] = null;
      steps.push({ id: raider.id, to: { row: raider.row, col: raider.col }, brokeWall: target });
      continue;
    }

    // Either the plan was a move, or the wall it aimed at has already come
    // down this phase — in both cases it walks in, if the cell is free.
    if (held.has(keyOf(target))) { steps.push(stay(raider)); continue; }
    held.delete(keyOf(raider));
    held.add(keyOf(target));
    steps.push({ id: raider.id, to: target, brokeWall: null });
  }
  return steps;
}

// ── Intent: what the enemy will do next, for the player to read ──

export interface SiegeIntent {
  /** Where each raider will step, by raider id */
  steps: Map<number, GridPos>;
  /** Player blocks that will be attacked next */
  threatenedWalls: GridPos[];
  /** Weighted route length from each raider to the Keep, by raider id */
  routeLengths: Map<number, number>;
}

/**
 * What the enemy is about to do, computed against the board as it stands.
 *
 * Recomputed after every placement as well as after every enemy phase,
 * because a wall the player just built may have moved the whole route — which
 * is exactly the feedback the intent layer exists to give.
 */
export function readIntent(
  board: Board,
  raiders: Raider[],
  keep: GridPos,
  rng: Rng,
  wallCost: number = DEFAULT_WALL_COST,
): SiegeIntent {
  const dist = distanceToKeep(board, keep, wallCost);
  // The same plan pass the phase itself runs, from the same snapshot and the
  // same seeded draw — so the arrow the player is shown is the step that
  // happens, not an approximation of it.
  const steps = planRaiders(board, raiders, keep, rng, wallCost);
  const routeLengths = new Map<number, number>();
  const threatenedWalls: GridPos[] = [];

  for (const raider of raiders) {
    routeLengths.set(raider.id, dist[raider.row][raider.col]);
    const target = steps.get(raider.id);
    if (target && board.grid[target.row][target.col] !== null) threatenedWalls.push(target);
  }

  return { steps, threatenedWalls, routeLengths };
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

// ── The tide: kept, not wired ──

/**
 * The second enemy the `enemy` flag still names.
 *
 * It is **not** driven by the run loop in this build. The tide expands on
 * game time, and Hold the Keep is now eighteen turns with no clock in it at
 * all, so there is no tempo for it to run on: wiring it back means deciding
 * what a tide tick *is* in a turn-based siege, which is a design question and
 * not a plumbing one. What survives here is the half that is pure — where the
 * flood would go, and what it would cost it — so the flag has something to
 * point at and the answer is still tested rather than rotting.
 */

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
 * Eligible: every cell orthogonally touching the front that the tide does not
 * already hold and a ruin does not block — open ground, the gates, the Keep,
 * and player walls, since eroding one is how the tide gets through it.
 *
 * Ranked by **what it costs the tide to be standing in that cell and then
 * reach the Keep from it**: the distance from the candidate's cheapest
 * neighbour, plus the candidate's own entry cost (1 for floor, `wallCost` for
 * a wall). Written that way rather than as `dist[candidate]` — which is the
 * same number — because the two terms are the thing being traded off, and a
 * ranking that left the second one out would let the tide eat walls for free.
 *
 * Scanned in reading order so the tie list is fixed before the seeded draw.
 */
export function tideTarget(
  board: Board,
  tide: ReadonlySet<string>,
  keep: GridPos,
  rng: Rng,
  wallCost: number = DEFAULT_WALL_COST,
  cooling: ReadonlySet<string> = EMPTY_SET,
): GridPos | null {
  const size = board.size;
  const dist = distanceToKeep(board, keep, wallCost);
  let bestDist = UNREACHABLE;
  let best: GridPos[] = [];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (tide.has(`${r},${c}`)) continue;
      // Ground a claim just took is off limits for one tick: a courtyard
      // sealed and immediately re-flooded would read as the capture not
      // having happened, which is the one thing the player must be able to see.
      if (cooling.has(`${r},${c}`)) continue;
      const entry = enterCost(board, r, c, wallCost);
      if (entry === null) continue;
      let touches = false;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (inBounds(nr, nc, size) && tide.has(`${nr},${nc}`)) { touches = true; break; }
      }
      if (!touches) continue;
      // The cheapest way onward from this candidate, plus what it costs to be
      // in it. `neighbourDist` excludes the candidate's own cost by
      // construction, so the two terms never double up.
      let neighbourDist = UNREACHABLE;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (!inBounds(nr, nc, size)) continue;
        if (dist[nr][nc] < neighbourDist) neighbourDist = dist[nr][nc];
      }
      if (r === keep.row && c === keep.col) neighbourDist = 0;
      if (neighbourDist === UNREACHABLE) continue;
      const d = neighbourDist + entry;
      if (d > bestDist) continue;
      if (d < bestDist) { bestDist = d; best = []; }
      best.push({ row: r, col: c });
    }
  }
  if (bestDist === UNREACHABLE) return null;
  return pickTied(best, rng);
}

/**
 * One tick of the tide: one cell taken, or one wall damaged, never both and
 * never more than one of either.
 *
 * `tide` is a snapshot of the front — the cell taken here cannot itself grow
 * until the next tick, because the caller adds it after this returns. Mutates
 * the board where a wall is eroded; the caller applies the claimed cell to
 * its own set.
 */
export function stepTide(
  board: Board,
  tide: ReadonlySet<string>,
  keep: GridPos,
  rng: Rng,
  wallCost: number = DEFAULT_WALL_COST,
  cooling: ReadonlySet<string> = EMPTY_SET,
): TideStep {
  const target = tideTarget(board, tide, keep, rng, wallCost, cooling);
  if (!target) return { claimed: null, erodedWall: null };
  if (board.grid[target.row][target.col] !== null) {
    board.grid[target.row][target.col] = null;
    return { claimed: null, erodedWall: target };
  }
  return { claimed: target, erodedWall: null };
}
