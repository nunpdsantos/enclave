import { GRID_SIZE, GridPos, Terrain, TerrainGrid } from './types';

/**
 * The three test missions of Hold the Keep.
 *
 * They differ by *geometry and schedule*, never by enemy statistics — that is
 * the whole point of the set. A raider is a raider on all three; what changes
 * is how many doors it can come through, how much of the board is already
 * wall, and how fast the next one arrives.
 *
 * Maps are rows of strings so the board is readable in the source:
 *   '.' floor   'K' keep   'G' gate   '#' ruin
 * Anything shorter than nine columns is padded with floor, and the Keep sits
 * at the centre of every map.
 */

export type SiegeMissionId = 'm1' | 'm2' | 'm3';

/**
 * What each terrain does, in one table, because four kinds times four
 * questions is exactly the sort of thing that drifts between modules:
 *
 *   terrain | takes a piece | holds the flood back | counts in a room's area | survives a claim
 *   --------|---------------|----------------------|-------------------------|-----------------
 *   floor   | yes           | no                   | yes                     | (nothing there)
 *   keep    | no            | no                   | yes                     | yes
 *   gate    | no            | no                   | yes                     | yes
 *   ruin    | no            | YES (boundary)       | no                      | yes
 *
 * The enemy walks over floor, gates and the Keep alike, and never through a
 * ruin. A raider with no route to the Keep at all waits where it stands.
 * Enemies are floor occupants: they block a placement, never the flood fill,
 * and the cell they stand on counts in the area of a room that encloses them.
 */

/** One scheduled arrival: a raider on `gate` after placement `turn`. */
export interface SpawnEvent {
  turn: number;
  /** Index into the mission's `gates`, in map reading order */
  gate: number;
}

/**
 * How arrivals are paced. `interval` until `rampTurn`, `rampInterval` after —
 * one ramp is all a graybox needs, and it is the knob the playtest turns.
 */
export interface SpawnPlan {
  firstTurn: number;
  interval: number;
  /** Infinity when the mission never tightens on its own */
  rampTurn: number;
  rampInterval: number;
}

export interface SiegeMission {
  id: SiegeMissionId;
  name: string;
  map: string[];
  spawn: SpawnPlan;
  /** Seconds between tide expansions at the start of the mission */
  tideSeconds: number;
  /**
   * How long a finite tide mission has to be *survived* before its eighteen
   * pieces count as a win.
   *
   * The tide runs on the clock, not on placements, so without this the fastest
   * way to "hold the Keep" is to dump eighteen pieces anywhere in twenty
   * seconds and never meet the siege at all. The raiders need no equivalent:
   * every placement is a raider step, so there is no clock to outrun.
   */
  minSurvivalSeconds: number;
}

// ── Map characters ──

const TERRAIN_BY_CHAR: Record<string, Terrain> = {
  '.': 'floor',
  K: 'keep',
  G: 'gate',
  '#': 'ruin',
};

export const MISSIONS: Record<SiegeMissionId, SiegeMission> = {
  // One door, no cover, a raider every other placement. The mission that
  // teaches what a raider does and what a claim costs.
  m1: {
    id: 'm1',
    name: 'THE GATEHOUSE',
    map: [
      '....G....',
      '.........',
      '.........',
      '.........',
      '....K....',
      '.........',
      '.........',
      '.........',
      '.........',
    ],
    spawn: { firstTurn: 1, interval: 2, rampTurn: Infinity, rampInterval: 2 },
    tideSeconds: 3.0,
    minSurvivalSeconds: 60,
  },

  // Two fronts at the same tempo: the same arrivals, but a wall that answers
  // one door leaves the other open, so every claim has a side to it.
  m2: {
    id: 'm2',
    name: 'THE BORDER MARCH',
    map: [
      '.........',
      '.........',
      '.........',
      '.........',
      'G...K...G',
      '.........',
      '.........',
      '.........',
      '.........',
    ],
    spawn: { firstTurn: 1, interval: 2, rampTurn: Infinity, rampInterval: 2 },
    tideSeconds: 2.6,
    minSurvivalSeconds: 60,
  },

  // Ruins: six cells of old wall with one gap in the middle of them. Free
  // boundary the player did not have to build and cannot lose — and a funnel
  // the enemy has to walk round, or through the gap the player is defending.
  m3: {
    id: 'm3',
    name: 'THE OLD CITY',
    map: [
      '....G....',
      '.........',
      '.........',
      '.###.###.',
      '....K....',
      '.........',
      '.........',
      '.........',
      '....G....',
    ],
    spawn: { firstTurn: 1, interval: 2, rampTurn: 11, rampInterval: 1 },
    tideSeconds: 2.6,
    minSurvivalSeconds: 60,
  },
};

export const MISSION_ORDER: SiegeMissionId[] = ['m1', 'm2', 'm3'];

/** 'M1' — what the picker chip says */
export function missionLabel(id: SiegeMissionId): string {
  return id.toUpperCase();
}

export function isMissionId(value: unknown): value is SiegeMissionId {
  return value === 'm1' || value === 'm2' || value === 'm3';
}

// ── Reading a map ──

/** The terrain grid of a mission map, padded to 9×9 with floor. */
export function terrainOf(map: string[]): TerrainGrid {
  return Array.from({ length: GRID_SIZE }, (_, r) =>
    Array.from({ length: GRID_SIZE }, (_, c) => {
      const ch = map[r]?.[c] ?? '.';
      return TERRAIN_BY_CHAR[ch] ?? 'floor';
    }),
  );
}

/** Every cell of a given terrain, in reading order — which fixes gate indices. */
export function cellsOfTerrain(terrain: TerrainGrid, kind: Terrain): GridPos[] {
  const out: GridPos[] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (terrain[r][c] === kind) out.push({ row: r, col: c });
    }
  }
  return out;
}

// ── Schedules ──

/**
 * The turn an unopposed raider from the last wave should reach the Keep on.
 *
 * Sixteen of eighteen, so a finite mission has a climax two placements before
 * it ends rather than a queue of arrivals with nothing left to answer them.
 * The last scheduled wave is therefore this minus the walk from the nearest
 * gate, and a raider does not move on the phase it arrives in.
 */
export const FINITE_ARRIVAL_TURN = 16;

/**
 * Steps from the nearest gate to the Keep on an empty board.
 *
 * A plain BFS over floor: no player walls exist yet, ruins are impassable, and
 * the Keep and the gates are walkable. Local to this module rather than shared
 * with Siege.ts, because Siege.ts reads a SiegeConfig and this is what builds
 * one — the import would be a cycle for a nine-line flood fill.
 */
export function stepsFromNearestGate(map: string[]): number {
  const terrain = terrainOf(map);
  const keeps = cellsOfTerrain(terrain, 'keep');
  const gates = cellsOfTerrain(terrain, 'gate');
  if (keeps.length === 0 || gates.length === 0) return 0;
  const dist: number[][] = Array.from({ length: GRID_SIZE }, () =>
    Array(GRID_SIZE).fill(Infinity),
  );
  const start = keeps[0];
  dist[start.row][start.col] = 0;
  const queue: GridPos[] = [start];
  const dirs: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    for (const [dr, dc] of dirs) {
      const nr = p.row + dr, nc = p.col + dc;
      if (nr < 0 || nc < 0 || nr >= GRID_SIZE || nc >= GRID_SIZE) continue;
      if (terrain[nr][nc] === 'ruin' || dist[nr][nc] !== Infinity) continue;
      dist[nr][nc] = dist[p.row][p.col] + 1;
      queue.push({ row: nr, col: nc });
    }
  }
  let best = Infinity;
  for (const g of gates) best = Math.min(best, dist[g.row][g.col]);
  return Number.isFinite(best) ? best : 0;
}

/**
 * The last turn a finite mission schedules a wave on, so that an unopposed
 * raider from it walks into the Keep on FINITE_ARRIVAL_TURN.
 */
export function finiteSpawnHorizon(mission: SiegeMission): number {
  return Math.max(1, FINITE_ARRIVAL_TURN - stepsFromNearestGate(mission.map));
}

/**
 * How long an endless siege goes on being scheduled for. One arrival per
 * placement past turn 20 and MAX_REPLAY_MOVES placements in a recordable run,
 * so nothing beyond this can ever be reached.
 */
const ENDLESS_HORIZON = 600;

/** Where the endless ramp lands, whatever the mission's own plan says */
const ENDLESS_RAMP_TURN = 20;
const ENDLESS_RAMP_INTERVAL = 1;

/**
 * The arrivals of one mission, as a list.
 *
 * A list rather than a function because it is the thing a playtest argues
 * about: it can be printed, counted and edited, and a test can assert the
 * exact turns rather than re-deriving the rule it is checking.
 *
 * `endless` tightens the ramp to one raider per placement by turn 20 — every
 * mission, so the pressure curve of the endless variant is the mission's
 * geometry and nothing else.
 */
export function buildSpawnSchedule(
  mission: SiegeMission, endless: boolean, horizon: number,
): SpawnEvent[] {
  const gateCount = Math.max(1, cellsOfTerrain(terrainOf(mission.map), 'gate').length);
  const plan = mission.spawn;
  const rampTurn = endless ? Math.min(plan.rampTurn, ENDLESS_RAMP_TURN) : plan.rampTurn;
  const rampInterval = endless ? ENDLESS_RAMP_INTERVAL : plan.rampInterval;
  const limit = Math.min(horizon, endless ? ENDLESS_HORIZON : horizon);

  const out: SpawnEvent[] = [];
  let turn = plan.firstTurn;
  while (turn <= limit) {
    // Gates take turns in map order, so two fronts alternate without the
    // schedule having to name them.
    out.push({ turn, gate: out.length % gateCount });
    turn += turn >= rampTurn ? rampInterval : plan.interval;
  }
  return out;
}
