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
