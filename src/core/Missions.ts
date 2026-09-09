import { GridPos, SIEGE_GRID_SIZE, Terrain, TerrainGrid } from './types';

/**
 * The missions of Hold the Keep.
 *
 * They differ by *geometry and schedule*, never by raider statistics — that is
 * the whole point of the set. A raider is a raider on all three; what changes
 * is how many doors it can come through, how much of the board is already
 * wall, and how fast the next one arrives.
 *
 * Maps are rows of strings so the board is readable in the source:
 *   '.' floor   'K' keep   'G' gate   '#' ruin
 * Anything shorter than the board is padded with floor, and the Keep sits at
 * the centre of every map.
 *
 * **Only M1 is offered.** M2 and M3 are kept here as data — the geometry is
 * worth having written down and the tests still read them — but the picker
 * shows one mission, because one relief-in-eighteen playtest has one variable
 * in it and this is not the one.
 */

export type SiegeMissionId = 'm1' | 'm2' | 'm3';

/**
 * What each terrain does, in one table, because four kinds times four
 * questions is exactly the sort of thing that drifts between modules:
 *
 *   terrain | takes a piece | holds the flood back | counts as held ground | destructible
 *   --------|---------------|----------------------|-----------------------|-------------
 *   floor   | yes           | no                   | yes, once enclosed    | (nothing there)
 *   keep    | no            | no                   | no                    | —
 *   gate    | no            | no                   | no                    | —
 *   ruin    | no            | YES (boundary)       | no                    | no
 *
 * A raider walks over floor, gates and the Keep alike, and never through a
 * ruin. A raider with no route to the Keep at all waits where it stands.
 * Raiders are floor occupants: they block a placement, never the flood fill,
 * and the cell one stands on counts in a courtyard that encloses it.
 */

/** One scheduled arrival: a raider on `gate` after turn `turn`. */
export interface SpawnEvent {
  turn: number;
  /** Index into the mission's `gates`, in map reading order */
  gate: number;
}

/**
 * One piece of the authored supply: a piece id and the rotation it is dealt
 * turned to. No seed, no bag — see `SiegeMission.supply`.
 */
export interface SupplyPiece {
  id: string;
  rot: number;
}

export interface SiegeMission {
  id: SiegeMissionId;
  name: string;
  /** Cells on a side. Every siege map is square and this is its width. */
  size: number;
  map: string[];
  /** Every arrival of the mission, in turn order. Authored, not derived. */
  spawns: SpawnEvent[];
  /**
   * The whole run's pieces, in order.
   *
   * A list rather than a seeded bag, because a mission is a puzzle: the same
   * eighteen pieces in the same order on every attempt is what makes the
   * second attempt a better plan rather than a better draw. It is also the
   * thing a playtest argues about, and a list can be printed and edited.
   */
  supply: SupplyPiece[];
}

// ── Map characters ──

const TERRAIN_BY_CHAR: Record<string, Terrain> = {
  '.': 'floor',
  K: 'keep',
  G: 'gate',
  '#': 'ruin',
};

/**
 * M1's supply: eight straight sections of 2–4 cells, eight corners and Ls of
 * 3–4 cells, two single-cell patches.
 *
 * The order is authored rather than shuffled, and it alternates: a straight,
 * then something that turns a corner, so no stretch of the run is all one
 * kind of material. The two DOTs sit late, where a one-cell gap in a
 * courtyard is the thing most likely to be standing open.
 */
const M1_SUPPLY: SupplyPiece[] = [
  { id: 'tet_line', rot: 1 }, // BAR 4, vertical
  { id: 'corner', rot: 0 },
  { id: 'tri_line', rot: 0 }, // BAR 3, horizontal
  { id: 'l', rot: 0 },
  { id: 'domino', rot: 1 },
  { id: 'corner', rot: 1 },
  { id: 'tet_line', rot: 0 },
  { id: 'j', rot: 0 },
  { id: 'tri_line', rot: 1 },
  { id: 'corner', rot: 2 },
  { id: 'single', rot: 0 },
  { id: 'l', rot: 2 },
  { id: 'domino', rot: 0 },
  { id: 'tet_line', rot: 1 },
  { id: 'corner', rot: 3 },
  { id: 'j', rot: 2 },
  { id: 'tri_line', rot: 0 },
  { id: 'single', rot: 0 },
];

/** How many pieces a mission's supply holds, which is also its turn count */
export const SIEGE_SUPPLY_SIZE = M1_SUPPLY.length;

export const MISSIONS: Record<SiegeMissionId, SiegeMission> = {
  // One door, no cover, a raider every other turn for the first half of the
  // run. The mission that teaches what a raider does and what a courtyard is
  // worth.
  m1: {
    id: 'm1',
    name: 'THE GATEHOUSE',
    size: SIEGE_GRID_SIZE,
    map: [
      '.....G.....',
      '...........',
      '...........',
      '...........',
      '...........',
      '.....K.....',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
    ],
    spawns: [1, 3, 5, 7, 9, 11].map(turn => ({ turn, gate: 0 })),
    supply: M1_SUPPLY,
  },

  // Two fronts at the same tempo: the same arrivals, but a wall that answers
  // one door leaves the other open, so every courtyard has a side to it.
  m2: {
    id: 'm2',
    name: 'THE BORDER MARCH',
    size: SIEGE_GRID_SIZE,
    map: [
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      'G....K....G',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
    ],
    spawns: [1, 3, 5, 7, 9, 11].map((turn, i) => ({ turn, gate: i % 2 })),
    supply: M1_SUPPLY,
  },

  // Ruins: two stubs of old wall with a gap between them. Free boundary the
  // player did not have to build and cannot lose — and a funnel the raiders
  // have to walk round, or through the gap the player is defending.
  m3: {
    id: 'm3',
    name: 'THE OLD CITY',
    size: SIEGE_GRID_SIZE,
    map: [
      '.....G.....',
      '...........',
      '...........',
      '.###...###.',
      '...........',
      '.....K.....',
      '...........',
      '.###...###.',
      '...........',
      '...........',
      '.....G.....',
    ],
    spawns: [1, 3, 5, 7, 9, 11].map((turn, i) => ({ turn, gate: i % 2 })),
    supply: M1_SUPPLY,
  },
};

/** Every mission there is data for */
export const MISSION_ORDER: SiegeMissionId[] = ['m1', 'm2', 'm3'];

/**
 * What the picker offers. One mission, deliberately: the question this build
 * asks is whether relief-in-eighteen is a game, and three maps would be three
 * answers to it.
 */
export const PICKER_MISSIONS: SiegeMissionId[] = ['m1'];

/** 'M1' — what a chip or a label says */
export function missionLabel(id: SiegeMissionId): string {
  return id.toUpperCase();
}

export function isMissionId(value: unknown): value is SiegeMissionId {
  return value === 'm1' || value === 'm2' || value === 'm3';
}

// ── Reading a map ──

/** The terrain grid of a mission map, padded to `size` with floor. */
export function terrainOf(map: string[], size: number = SIEGE_GRID_SIZE): TerrainGrid {
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => {
      const ch = map[r]?.[c] ?? '.';
      return TERRAIN_BY_CHAR[ch] ?? 'floor';
    }),
  );
}

/** Every cell of a given terrain, in reading order — which fixes gate indices. */
export function cellsOfTerrain(terrain: TerrainGrid, kind: Terrain): GridPos[] {
  const out: GridPos[] = [];
  for (let r = 0; r < terrain.length; r++) {
    for (let c = 0; c < terrain[r].length; c++) {
      if (terrain[r][c] === kind) out.push({ row: r, col: c });
    }
  }
  return out;
}
