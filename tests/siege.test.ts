import { describe, it, expect } from 'vitest';
import { Board } from '../src/core/Board';
import {
  DIFFICULTY_CONFIGS, SIEGE_ENEMY_BONUS, SIEGE_GROUND_INCOME, SIEGE_RELIEF_TURNS,
  siegeConfig,
} from '../src/core/Config';
import { GameState } from '../src/core/GameState';
import { MISSIONS, PICKER_MISSIONS, cellsOfTerrain, terrainOf } from '../src/core/Missions';
import { PIECE_TYPES, cellCount, makePiece, rotatePiece, rotationCount } from '../src/core/Pieces';
import { mulberry32 } from '../src/core/Random';
import { simulateRun } from '../src/core/Replay';
import {
  distanceToKeep, raiderTarget, readIntent, resolveRaiders, stepRaiders, stepTide,
} from '../src/core/Siege';
import { computeLayout } from '../src/rendering/LayoutManager';
import {
  GRID_SIZE, GridPos, Raider, SIEGE_GRID_SIZE, Terrain, TerrainGrid, siegeVariantKey,
} from '../src/core/types';
import { grid } from './helpers';

/**
 * Hold the Keep: eighteen turns, an authored supply, and one force walking at
 * the Keep.
 *
 * Two kinds of test here, deliberately. The pathfinding is exercised against
 * `Siege.ts` directly, because it is a pure function of a board and a test
 * that has to play a run to reach it is a test that will one day fail for a
 * reason it is not about. Everything the player experiences — captures, held
 * ground, income, relief, skips — is driven through GameState, because that
 * is where those rules actually live.
 */

const WHITE = 0xffffff;
/** The Keep is the centre of an eleven-cell board */
const KEEP: GridPos = { row: 5, col: 5 };
/** M1's one gate, on the top border */
const GATE: GridPos = { row: 0, col: 5 };
const N = SIEGE_GRID_SIZE;

function siegeGame(missionId: 'm1' | 'm2' | 'm3' = 'm1'): GameState {
  const gs = new GameState(siegeConfig(missionId), 'siege');
  gs.start();
  return gs;
}

/** An 11×11 board with M1's terrain and whatever walls the rows describe */
function siegeBoard(rows: string[], map: string[] = MISSIONS.m1.map): Board {
  const b = new Board(N);
  b.setTerrain(terrainOf(map, N));
  b.grid = grid(rows, N);
  return b;
}

/** Paint walls onto a live run's board without going through the supply */
function setWalls(gs: GameState, rows: string[]): void {
  gs.board.grid = grid(rows, gs.board.size);
}

/** Place a single block at (row, col), whatever the supply happened to deal */
function placeDot(gs: GameState, row: number, col: number) {
  gs.current = makePiece('single', 0, WHITE);
  return gs.tryPlace(row, col);
}

function sortedCells(cells: GridPos[]): string[] {
  return cells.map(c => `${c.row},${c.col}`).sort();
}

function heldKeys(gs: GameState): string[] {
  return [...gs.heldGround].sort();
}

describe('the board', () => {
  it('is eleven cells a side in the siege and nine everywhere else', () => {
    expect(siegeConfig('m1').boardSize).toBe(SIEGE_GRID_SIZE);
    expect(siegeGame().board.size).toBe(11);
    for (const mode of ['classic', 'blitz', 'daily'] as const) {
      expect(DIFFICULTY_CONFIGS[mode].boardSize).toBe(GRID_SIZE);
      const gs = new GameState(DIFFICULTY_CONFIGS[mode], mode);
      gs.start();
      expect(gs.board.size).toBe(9);
      expect(gs.board.grid).toHaveLength(9);
      expect(gs.board.grid[0]).toHaveLength(9);
    }
  });

  it('puts a single-cell Keep at the centre and one gate at the top', () => {
    const gs = siegeGame();
    const terrain = terrainOf(MISSIONS.m1.map, N);
    expect(cellsOfTerrain(terrain, 'keep')).toEqual([KEEP]);
    expect(cellsOfTerrain(terrain, 'gate')).toEqual([GATE]);
    expect(cellsOfTerrain(terrain, 'ruin')).toEqual([]);
    expect(gs.keep).toEqual(KEEP);
    expect(gs.gates).toEqual([GATE]);
  });

  it('refuses a piece on the Keep, a gate, a ruin or a raider', () => {
    const gs = siegeGame('m3');
    const dot = makePiece('single', 0, WHITE).shape;
    expect(gs.board.canPlace(dot, 5, 5)).toBe(false); // keep
    expect(gs.board.canPlace(dot, 0, 5)).toBe(false); // gate
    expect(gs.board.canPlace(dot, 3, 1)).toBe(false); // ruin
    expect(gs.board.canPlace(dot, 6, 6)).toBe(true);
    gs.placeEnemies([{ row: 6, col: 6 }]);
    expect(gs.board.canPlace(dot, 6, 6)).toBe(false); // raider
    // ...and never on a wall it already built
    setWalls(gs, ['..........#']);
    expect(gs.board.canPlace(dot, 0, 10)).toBe(false);
  });
});

describe('the authored supply', () => {
  it('deals the same eighteen pieces, in the same order, on every run', () => {
    const first = siegeGame();
    const second = siegeGame();
    const dealt = (gs: GameState): string[] => {
      const out: string[] = [];
      while (gs.current) {
        out.push(`${gs.current.typeId}:${gs.current.rotation}`);
        gs.skipPiece();
        if (gs.isGameOver) break;
      }
      return out;
    };
    const a = dealt(first);
    const b = dealt(second);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    // ...and it is the list in Missions.ts, not a shuffle that happened to match
    expect(a[0]).toBe(`${MISSIONS.m1.supply[0].id}:${MISSIONS.m1.supply[0].rot}`);
  });

  it('is eight straights of 2–4, eight corners and Ls of 3–4, and two dots', () => {
    const supply = MISSIONS.m1.supply;
    expect(supply).toHaveLength(18);
    expect(SIEGE_RELIEF_TURNS).toBe(18);

    const straights = ['domino', 'tri_line', 'tet_line'];
    const corners = ['corner', 'l', 'j'];
    const count = (ids: string[]): number => supply.filter(p => ids.includes(p.id)).length;
    expect(count(straights)).toBe(8);
    expect(count(corners)).toBe(8);
    expect(count(['single'])).toBe(2);

    // Every entry is a real piece at a rotation that piece actually has, and
    // the cell counts are the ones the mission promises
    for (const entry of supply) {
      const type = PIECE_TYPES.find(t => t.id === entry.id);
      expect(type, entry.id).toBeDefined();
      expect(entry.rot).toBeLessThan(type!.rotations.length);
      const cells = cellCount(type!.rotations[entry.rot]);
      if (straights.includes(entry.id)) expect(cells).toBeGreaterThanOrEqual(2);
      if (straights.includes(entry.id)) expect(cells).toBeLessThanOrEqual(4);
      if (corners.includes(entry.id)) expect(cells).toBeGreaterThanOrEqual(3);
      if (corners.includes(entry.id)) expect(cells).toBeLessThanOrEqual(4);
      if (entry.id === 'single') expect(cells).toBe(1);
    }
  });

  it('shows four upcoming pieces', () => {
    const gs = siegeGame();
    expect(gs.config.previewCount).toBe(4);
    expect(gs.queue).toHaveLength(4);
    expect(gs.queue.map(p => p.typeId))
      .toEqual(MISSIONS.m1.supply.slice(1, 5).map(p => p.id));
  });
});

describe('a turn', () => {
  it('is spent by a placement and by a skip, and by nothing else', () => {
    const gs = siegeGame();
    gs.rotate();
    gs.hold();
    expect(gs.totalTurns).toBe(0);
    expect(gs.raiders).toHaveLength(0);

    placeDot(gs, 10, 0);
    expect(gs.totalTurns).toBe(1);
    // Turn 1 is M1's first arrival, so the gate is manned
    expect(gs.raiders).toHaveLength(1);
    expect(gs.raiders[0]).toMatchObject(GATE);
  });

  it('spends a piece on a skip and advances the enemy by one phase', () => {
    const gs = siegeGame();
    const supply = MISSIONS.m1.supply;
    const before = gs.piecesRemaining;
    placeDot(gs, 10, 0); // turn 1: a raider lands on the gate and idles

    const events = gs.skipPiece();
    expect(events.some(e => e.type === 'skip')).toBe(true);
    expect(gs.totalTurns).toBe(2);
    expect(gs.skips).toBe(1);
    // One piece gone: the hand is the next entry of the supply
    expect(gs.piecesRemaining).toBe(before - 2);
    expect(gs.current!.typeId).toBe(supply[2].id);
    // ...and the raider that was idling on the gate has stepped
    expect(gs.raiders[0]).toMatchObject({ row: 1, col: 5 });
    expect(gs.buildRunSummary().siege!.skipsUsed).toBe(1);
  });

  it('records a skip in the replay log', () => {
    const gs = siegeGame();
    gs.skipPiece();
    const moves = gs.buildReplay().moves;
    expect(moves).toHaveLength(1);
    expect(moves[0].t).toBe('s');
  });
});

describe('walls and courtyards', () => {
  // A 2×2 courtyard at rows 1–2 / cols 1–2, one block short of sealed at (0,1)
  const ROOM_2X2 = [
    '..#........',
    '#..#.......',
    '#..#.......',
    '.##........',
  ];

  it('leaves the walls standing when a courtyard is sealed and a raider caught', () => {
    const gs = siegeGame();
    setWalls(gs, ROOM_2X2);
    gs.placeEnemies([{ row: 1, col: 1 }]);
    const events = placeDot(gs, 0, 1);

    expect(events.find(e => e.type === 'capture')!.enemiesCaptured).toBe(1);
    // Every wall of the courtyard is exactly where it was, including the one
    // just placed. A claim used to eat them, and that was the sacrifice this
    // mode no longer asks for.
    for (const [r, c] of [[0, 1], [0, 2], [1, 0], [1, 3], [2, 0], [2, 3], [3, 1], [3, 2]]) {
      expect(gs.board.grid[r][c], `${r},${c}`).not.toBeNull();
    }
  });

  it('makes the sealed floor held, and pays one a turn for it', () => {
    const gs = siegeGame();
    setWalls(gs, ROOM_2X2);
    placeDot(gs, 0, 1);
    expect(heldKeys(gs)).toEqual(['1,1', '1,2', '2,1', '2,2']);
    // Four cells, one point each, for the phase just survived
    expect(gs.score).toBe(4 * SIEGE_GROUND_INCOME);
    expect(gs.heldCount).toBe(4);

    // ...and again next turn, for the same ground, with nothing new built
    gs.skipPiece();
    expect(gs.score).toBe(8 * SIEGE_GROUND_INCOME);
  });

  it('pays 75 a capture on top of the ground', () => {
    const gs = siegeGame();
    setWalls(gs, ROOM_2X2);
    gs.placeEnemies([{ row: 1, col: 1 }, { row: 2, col: 2 }]);
    placeDot(gs, 0, 1);
    expect(gs.capturedCount).toBe(2);
    expect(gs.score).toBe(2 * SIEGE_ENEMY_BONUS + 4 * SIEGE_GROUND_INCOME);
  });

  it('captures only what the turn newly enclosed', () => {
    const gs = siegeGame();
    setWalls(gs, ROOM_2X2);
    // One inside the courtyard about to close, one out on the open board
    gs.placeEnemies([{ row: 1, col: 1 }, { row: 8, col: 8 }]);
    placeDot(gs, 0, 1);
    expect(gs.capturedCount).toBe(1);
    // Two left: the one out on the open board, which survived and stepped
    // toward the Keep, and turn one's arrival on the gate.
    expect(gs.raiders).toHaveLength(2);
    const cells = sortedCells(gs.enemyCells());
    expect(cells).toContain('0,5');
    expect(cells).not.toContain('1,1');
    expect(cells).not.toContain('8,8');
  });

  it('lets a piece land on held floor, which stops being held', () => {
    const gs = siegeGame();
    setWalls(gs, ROOM_2X2);
    placeDot(gs, 0, 1);
    expect(gs.heldGround.has('1,1')).toBe(true);
    // Building on your own courtyard is legal; the cell is a wall now, so it
    // is not floor and it does not pay.
    expect(gs.board.canPlace(makePiece('single', 0, WHITE).shape, 1, 1)).toBe(true);
    placeDot(gs, 1, 1);
    expect(gs.heldGround.has('1,1')).toBe(false);
    expect(gs.heldCount).toBe(3);
  });

  it('never counts a courtyard the ruins had already closed', () => {
    const gs = siegeGame();
    const t: TerrainGrid = Board.createFloorTerrain(N);
    t[5][5] = 'keep';
    // A closed box of old wall around (1,1)–(1,3), built by nobody
    for (const [r, c] of [
      [0, 0], [0, 1], [0, 2], [0, 3], [0, 4],
      [1, 0], [1, 4],
      [2, 0], [2, 1], [2, 2], [2, 3], [2, 4],
    ]) t[r][c] = 'ruin';
    gs.board.setTerrain(t);

    // The flood fill sees the pocket; the rules refuse it, because the player
    // built nothing and there is nothing there they could lose.
    const pocket = gs.board.findEnclosures()
      .find(r => r.cells.some(c => c.row === 1 && c.col === 1));
    expect(pocket).toBeDefined();
    expect(pocket!.fence).toHaveLength(0);
    expect(pocket!.ruinCells.length).toBeGreaterThan(0);

    // Dropping a block inside it splits it in two, and neither half is new
    placeDot(gs, 1, 2);
    expect(gs.heldCount).toBe(0);
    expect(gs.score).toBe(0);
  });

  it('counts a courtyard the ruins only helped to close', () => {
    const gs = siegeGame();
    const t: TerrainGrid = Board.createFloorTerrain(N);
    t[5][5] = 'keep';
    t[0][1] = 'ruin';
    t[0][2] = 'ruin';
    gs.board.setTerrain(t);
    // Ruins along the top; the player builds the other three sides bar one
    setWalls(gs, [
      '...........',
      '#..#.......',
      '#..#.......',
      '.#.........',
    ]);
    placeDot(gs, 3, 2);
    expect(heldKeys(gs)).toEqual(['1,1', '1,2', '2,1', '2,2']);
    // The old wall is untouched: ruins are not destructible and never removed
    expect(gs.board.terrainAt(0, 1)).toBe('ruin');
    expect(gs.board.terrainAt(0, 2)).toBe('ruin');
  });

  it('gives up the ground a broken wall opened, and keeps the rest', () => {
    const gs = siegeGame();
    // Two 1×1 courtyards, at (1,1) and (1,9), each one wall short along the
    // top. A raider stands ready to knock a wall out of the left one.
    setWalls(gs, [
      '...........',
      '#.#.....#.#',
      '.#.......#.',
    ]);
    gs.current = makePiece('domino', 0, WHITE);
    gs.tryPlace(0, 1);
    gs.current = makePiece('domino', 0, WHITE);
    gs.tryPlace(0, 9);
    expect(heldKeys(gs)).toEqual(['1,1', '1,9']);
    const earned = gs.score;

    // Knock the left courtyard's floor open by hand: the same thing a raider
    // does, and the recompute is what this test is about.
    gs.board.grid[1][0] = null;
    gs.skipPiece();
    expect(gs.heldGround.has('1,1')).toBe(false);
    expect(gs.heldGround.has('1,9')).toBe(true);
    // Income has fallen to the one courtyard that is still sealed
    expect(gs.score - earned).toBe(1 * SIEGE_GROUND_INCOME);
  });

  it('counts a raider on held floor as ground that still pays', () => {
    const gs = siegeGame();
    setWalls(gs, ROOM_2X2);
    gs.placeEnemies([{ row: 1, col: 1 }]);
    placeDot(gs, 0, 1);
    // The cell it was standing on is floor, so it is part of the courtyard
    expect(gs.heldCount).toBe(4);
  });
});

describe('the raiders', () => {
  it('walk the eleven-cell board toward the Keep', () => {
    const b = siegeBoard(['...........']);
    const dist = distanceToKeep(b, KEEP);
    expect(dist[5][5]).toBe(0);
    expect(dist[0][5]).toBe(5);
    expect(dist[0][0]).toBe(10);
    expect(dist[10][10]).toBe(10);
  });

  it('costs floor 1 and a player wall 4, so a wall is a detour worth taking', () => {
    const open = siegeBoard(['...........']);
    expect(distanceToKeep(open, KEEP)[4][5]).toBe(1);
    expect(distanceToKeep(open, KEEP)[3][5]).toBe(2);

    // One wall directly above the Keep
    const walled = siegeBoard([
      '...........',
      '...........',
      '...........',
      '...........',
      '.....#.....',
    ]);
    const dist = distanceToKeep(walled, KEEP);
    // Standing in the wall costs 4 rather than 1
    expect(dist[4][5]).toBe(4);
    // ...and from the cell above it, going round now costs the same as going
    // through: three cells of detour against a wall's four, plus the step in
    expect(dist[3][5]).toBe(4);
    expect(dist[5][1]).toBe(4);
  });

  it('refuses a ruin outright', () => {
    const terrain: TerrainGrid = Board.createFloorTerrain(N);
    terrain[5][5] = 'keep';
    for (const [r, c] of [[0, 1], [1, 0], [1, 2], [2, 1]]) terrain[r][c] = 'ruin';
    const b = new Board(N);
    b.setTerrain(terrain);
    expect(distanceToKeep(b, KEEP)[1][1]).toBe(Infinity);
  });

  it('breaks a tie in a fixed direction order — up, down, left, right', () => {
    const b = siegeBoard(['...........']);
    const dist = distanceToKeep(b, KEEP);
    // (3,3) is equidistant by going down or by going right
    const first = raiderTarget(b, { row: 3, col: 3 }, dist, new Set(), () => 0);
    expect(first).toEqual({ row: 4, col: 3 });
    const last = raiderTarget(b, { row: 3, col: 3 }, dist, new Set(), () => 0.999);
    expect(last).toEqual({ row: 3, col: 4 });
  });

  it('breaks the same tie the same way on every attempt of a mission', () => {
    // The draw is keyed to the turn, not to a run seed, so a mission is a
    // puzzle: the same plan meets the same raiders doing the same thing.
    const play = (): string[] => {
      const gs = siegeGame();
      const trace: string[] = [];
      for (let i = 0; i < 8 && !gs.isGameOver; i++) {
        gs.skipPiece();
        trace.push(sortedCells(gs.enemyCells()).join('|'));
      }
      return trace;
    };
    expect(play()).toEqual(play());
  });

  it('destroys the wall in its way and spends the turn on it', () => {
    const b = siegeBoard([
      '...........',
      '...........',
      '...........',
      '..#........',
      '.#.#.......',
      '..#........',
    ]);
    const steps = stepRaiders(b, [{ id: 1, row: 4, col: 2 }], KEEP, mulberry32(1));
    expect(steps[0].to).toEqual({ row: 4, col: 2 });
    expect(steps[0].brokeWall).toEqual({ row: 4, col: 3 });
    expect(b.grid[4][3]).toBeNull();
    // One wall per raider per turn: the other three still stand
    expect(b.grid[3][2]).not.toBeNull();
    expect(b.grid[5][2]).not.toBeNull();
    expect(b.grid[4][1]).not.toBeNull();
  });

  it('plans against one snapshot and resolves in id order', () => {
    const b = siegeBoard(['...........']);
    // Both plan into (5,2): id 1 from the left, id 2 from above
    const raiders: Raider[] = [{ id: 1, row: 5, col: 1 }, { id: 2, row: 4, col: 2 }];
    const plans = new Map<number, GridPos>([
      [1, { row: 5, col: 2 }], [2, { row: 5, col: 2 }],
    ]);
    const steps = resolveRaiders(b, raiders, plans);
    expect(steps[0].to).toEqual({ row: 5, col: 2 });
    expect(steps[1].to).toEqual({ row: 4, col: 2 });
  });

  it('walks into the gap when another raider broke the wall it aimed at', () => {
    const b = siegeBoard([
      '...........',
      '...........',
      '...........',
      '...........',
      '..#........',
    ]);
    const raiders: Raider[] = [{ id: 1, row: 3, col: 2 }, { id: 2, row: 4, col: 1 }];
    const plans = new Map<number, GridPos>([
      [1, { row: 4, col: 2 }], [2, { row: 4, col: 2 }],
    ]);
    const steps = resolveRaiders(b, raiders, plans);
    expect(steps[0].brokeWall).toEqual({ row: 4, col: 2 });
    expect(steps[1].to).toEqual({ row: 4, col: 2 });
    expect(steps[1].brokeWall).toBeNull();
  });

  it('previews exactly the step the phase will take', () => {
    const board = siegeBoard([
      '...........',
      '..#........',
      '...........',
      '......#....',
    ]);
    const raiders: Raider[] = [
      { id: 1, row: 2, col: 2 }, { id: 2, row: 7, col: 7 }, { id: 3, row: 0, col: 5 },
    ];
    const intent = readIntent(board, raiders, KEEP, mulberry32(0));
    const steps = stepRaiders(
      board.clone(), raiders.map(r => ({ ...r })), KEEP, mulberry32(0),
    );
    expect(steps).toHaveLength(3);
    for (const step of steps) {
      expect(intent.steps.get(step.id)).toEqual(step.brokeWall ?? step.to);
    }
    for (const wall of intent.threatenedWalls) {
      expect(board.grid[wall.row][wall.col]).not.toBeNull();
    }
  });

  it('counts a turn that changed a route, and one that did not', () => {
    const idle = siegeGame();
    idle.placeEnemies([GATE]);
    placeDot(idle, 10, 0); // far corner: the route is five cells either way
    expect(idle.buildRunSummary().siege!.routeChangingPlacements).toBe(0);

    const blocking = siegeGame();
    blocking.placeEnemies([GATE]);
    placeDot(blocking, 1, 5); // straight in front of the gate
    expect(blocking.buildRunSummary().siege!.routeChangingPlacements).toBe(1);
  });
});

describe('the arrivals', () => {
  it('land after turns 1, 3, 5, 7, 9 and 11', () => {
    expect(MISSIONS.m1.spawns.map(s => s.turn)).toEqual([1, 3, 5, 7, 9, 11]);
    expect(MISSIONS.m1.spawns.every(s => s.gate === 0)).toBe(true);

    const gs = siegeGame();
    const counts: number[] = [];
    for (let turn = 1; turn <= 12 && !gs.isGameOver; turn++) {
      // Keep the gate clear so a blocked spawn never confuses the count
      gs.raiders = [];
      gs.board.setOccupied([]);
      gs.skipPiece();
      counts.push(gs.raiders.length);
    }
    expect(counts).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
  });

  it('idles on the phase it arrives in, then walks', () => {
    const gs = siegeGame();
    gs.skipPiece();
    expect(gs.raiders[0]).toMatchObject(GATE);
    gs.skipPiece();
    expect(gs.raiders[0]).toMatchObject({ row: 1, col: 5 });
  });

  it('waits for a blocked gate rather than being cancelled', () => {
    const gs = siegeGame();
    // A raider parked on the gate cell: turn 1's arrival has nowhere to land
    gs.placeEnemies([GATE]);
    // A wall right below it, so the sitting raider spends its turn breaking
    // through instead of stepping off the gate
    setWalls(gs, ['...........', '.....#.....']);
    gs.skipPiece();
    expect(gs.raiders).toHaveLength(1);
    // The debt is owed, not forgotten: the next free phase lands it
    gs.raiders = [];
    gs.board.setOccupied([]);
    gs.skipPiece();
    expect(gs.raiders).toHaveLength(1);
    expect(gs.raiders[0]).toMatchObject(GATE);
  });

  it('says which turn the next wave lands on', () => {
    const gs = siegeGame();
    expect(gs.nextSpawnTurn()).toBe(1);
    gs.skipPiece();
    expect(gs.nextSpawnTurn()).toBe(3);
    gs.skipPiece();
    expect(gs.nextSpawnTurn()).toBe(3);
  });
});

describe('the two endings', () => {
  it('loses the moment a raider stands on the Keep', () => {
    const gs = siegeGame();
    gs.placeEnemies([{ row: 4, col: 5 }]);
    const events = placeDot(gs, 10, 0);
    expect(gs.isGameOver).toBe(true);
    expect(gs.deathCause).toBe('breach');
    expect(events.some(e => e.type === 'breach')).toBe(true);
    expect(gs.buildRunSummary().siege!.breachTurn).toBe(1);
    // A run that ends in a breach earns nothing for the phase that lost it
    expect(events.some(e => e.type === 'income')).toBe(false);
  });

  it('loses on turn eighteen too, relief or no relief', () => {
    const gs = siegeGame();
    for (let i = 0; i < 17; i++) {
      gs.raiders = [];
      gs.board.setOccupied([]);
      gs.skipPiece();
    }
    expect(gs.totalTurns).toBe(17);
    expect(gs.isGameOver).toBe(false);
    // One step from the Keep on the last turn of all
    gs.placeEnemies([{ row: 4, col: 5 }]);
    gs.skipPiece();
    expect(gs.totalTurns).toBe(SIEGE_RELIEF_TURNS);
    expect(gs.deathCause).toBe('breach');
  });

  it('wins on surviving the eighteenth phase, raiders still standing', () => {
    const gs = siegeGame();
    for (let i = 0; i < 18 && !gs.isGameOver; i++) {
      // Keep them away from the Keep, but never off the board: winning is
      // holding out, not clearing the field.
      gs.raiders = gs.raiders.map(r => ({ ...r, row: 10, col: 0 }));
      gs.board.setOccupied(gs.enemyCells());
      gs.skipPiece();
    }
    expect(gs.totalTurns).toBe(SIEGE_RELIEF_TURNS);
    expect(gs.deathCause).toBe('victory');
    expect(gs.buildRunSummary().endCause).toBe('victory');
    expect(gs.raiders.length).toBeGreaterThan(0);
  });

  it('never ends for want of somewhere to put a piece', () => {
    const gs = siegeGame();
    // Every buildable cell taken: SKIP is the answer, not a board lock
    const rows = Array.from({ length: N }, () => '#'.repeat(N));
    setWalls(gs, rows);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (gs.board.terrainAt(r, c) !== 'floor') gs.board.grid[r][c] = null;
      }
    }
    expect(gs.canPlaceCurrentAnywhere()).toBe(false);
    gs.skipPiece();
    expect(gs.deathCause).not.toBe('board_lock');
  });
});

describe('the preview promises the resolution', () => {
  it('shows the capture, the ground, the walls hit and where the raiders end up', () => {
    const gs = siegeGame();
    setWalls(gs, [
      '..#........',
      '#..#.......',
      '#..#.......',
      '.##........',
    ]);
    gs.placeEnemies([{ row: 1, col: 1 }, { row: 7, col: 5 }]);
    const preview = gs.previewPlacement(makePiece('single', 0, WHITE), 0, 1)!;

    expect(preview.regions).toHaveLength(1);
    expect(preview.captured).toEqual([{ row: 1, col: 1 }]);
    expect(sortedCells(preview.held)).toEqual(['1,1', '1,2', '2,1', '2,2']);
    expect(preview.points).toBe(SIEGE_ENEMY_BONUS + 4 * SIEGE_GROUND_INCOME);
    expect(preview.breach).toBe(false);
    // Nothing was committed
    expect(gs.score).toBe(0);
    expect(gs.raiders).toHaveLength(2);
    expect(gs.board.grid[0][1]).toBeNull();

    // And the real turn agrees with it, cell for cell
    const events = placeDot(gs, 0, 1);
    expect(events.find(e => e.type === 'capture')!.capturedCells).toEqual(preview.captured);
    expect(heldKeys(gs)).toEqual(sortedCells(preview.held));
    expect(gs.score).toBe(preview.points);
    // The survivor stepped, and turn one's arrival landed on the gate — both
    // of which the preview's intent had already accounted for
    expect(sortedCells(gs.enemyCells())).toEqual(['0,5', '6,5']);
    expect(preview.intent.routeLengths.size).toBe(2);
  });

  it('names the wall a raider is about to knock down', () => {
    const gs = siegeGame();
    setWalls(gs, Array(N).fill('....#......'));
    gs.placeEnemies([{ row: 5, col: 3 }]);
    const preview = gs.previewPlacement(makePiece('single', 0, WHITE), 10, 0)!;
    expect(preview.wallsBroken).toEqual([{ row: 5, col: 4 }]);

    placeDot(gs, 10, 0);
    expect(gs.board.grid[5][4]).toBeNull();
    expect(gs.buildRunSummary().siege!.wallsLost).toBe(1);
  });

  it('keeps its promise on every turn of a whole run', () => {
    // The single case above proves the wiring; this proves the invariant. For
    // every turn of a real run, the preview of the drop that is about to be
    // made has to match what the turn then does — captures, held ground,
    // points and the walls the raiders take down. The mode is unplayable if
    // this is ever false, and it is exactly the sort of thing that goes
    // quietly false when the resolution order is edited.
    const gs = siegeGame();
    let turns = 0;
    while (!gs.isGameOver && gs.current) {
      // A player who reads the preview: never lose, then take the points,
      // then keep the raiders as far from the Keep as the piece allows. It is
      // what makes this run touch captures, courtyards and broken walls
      // rather than stacking blocks in a corner.
      let target: { row: number; col: number; rot: number } | null = null;
      let bestValue = -Infinity;
      let piece = gs.current;
      for (let t = 0; t < rotationCount(gs.current); t++) {
        for (let r = 0; r + piece.rows <= N; r++) {
          for (let c = 0; c + piece.cols <= N; c++) {
            if (!gs.board.canPlace(piece.shape, r, c)) continue;
            const pv = gs.previewPlacement(piece, r, c);
            if (!pv) continue;
            const routes = [...pv.intent.routeLengths.values()];
            const nearest = routes.length > 0 ? Math.min(...routes) : 99;
            const value = (pv.breach ? -1e6 : 0) + pv.points * 10 + nearest;
            if (value > bestValue) {
              bestValue = value;
              target = { row: r, col: c, rot: piece.rotation };
            }
          }
        }
        piece = rotatePiece(piece);
      }
      if (!target) { gs.skipPiece(); continue; }
      for (let n = 0; n < 4 && gs.current && gs.current.rotation !== target.rot; n++) gs.rotate();

      const scoreBefore = gs.score;
      const preview = gs.previewPlacement(gs.current!, target.row, target.col)!;
      const events = gs.tryPlace(target.row, target.col);
      turns++;

      const capture = events.find(e => e.type === 'capture');
      expect(capture?.capturedCells ?? [], `turn ${turns} captures`)
        .toEqual(preview.captured);
      if (preview.breach) {
        expect(gs.deathCause, `turn ${turns} breach`).toBe('breach');
        break;
      }
      expect(heldKeys(gs), `turn ${turns} held`).toEqual(sortedCells(preview.held));
      expect(gs.score - scoreBefore, `turn ${turns} points`).toBe(preview.points);
      const broken = events.find(e => e.type === 'enemy')?.wallsBroken ?? [];
      expect(sortedCells(broken), `turn ${turns} walls`)
        .toEqual(sortedCells(preview.wallsBroken));
    }
    // ...and the run it walked through was a real one, not an empty board
    expect(turns).toBeGreaterThan(8);
    expect(gs.capturedCount).toBeGreaterThan(0);
    expect(gs.buildRunSummary().siege!.wallsLost).toBeGreaterThan(0);
  });

  it('says so when a drop would lose the run', () => {
    const gs = siegeGame();
    gs.placeEnemies([{ row: 4, col: 5 }]);
    expect(gs.previewPlacement(makePiece('single', 0, WHITE), 10, 0)!.breach).toBe(true);
  });
});

describe('the meta-systems are gone', () => {
  it('pays nothing for a block, an area, a streak, an echo or a survey', () => {
    const cfg = siegeConfig('m1');
    expect(cfg.scoring.pointsPerBlockPlaced).toBe(0);
    expect(cfg.scoring.pointsPerAreaSquared).toBe(0);
    expect(cfg.scoring.multiCloseBonusPerRoom).toBe(0);
    expect(cfg.scoring.streakEnabled).toBe(false);
    expect(cfg.echo.enabled).toBe(false);
    expect(cfg.territory.enabled).toBe(false);
    expect(cfg.territory.surveyEnabled).toBe(false);
    expect(cfg.clock.enabled).toBe(false);
    expect(cfg.bagByTier).toBe(false);
    expect(cfg.siege!.clockMode).toBe('off');
    expect(cfg.siege!.fenceSurvivesEnemyPhase).toBe(true);
    expect(cfg.siege!.wallCost).toBe(4);
    expect(cfg.siege!.enemyBonus).toBe(75);
    expect(cfg.siege!.groundIncome).toBe(1);
  });

  it('banks no time and runs no clock', () => {
    const gs = siegeGame();
    const events = placeDot(gs, 10, 0);
    expect(events[0].timeBonus).toBe(0);
    expect(gs.streakCount).toBe(0);
    expect(gs.streakMultiplier).toBe(1);
    expect(gs.echoWalls()).toHaveLength(0);
    expect(gs.surveys).toBe(0);
    // Sitting there does not kill you any more
    for (let t = 0; t < 200; t++) gs.tick(0.5);
    expect(gs.isGameOver).toBe(false);
  });
});

describe('the log', () => {
  /** A run of placements and skips, played by rule so a test can repeat it */
  function playMixedRun(): GameState {
    const gs = siegeGame();
    for (let i = 0; !gs.isGameOver && i < 40; i++) {
      gs.tick(0.2);
      if (!gs.current) break;
      if (i % 3 === 0) { gs.skipPiece(); continue; }
      let placed = false;
      for (let r = 0; r < N && !placed; r++) {
        for (let c = 0; c < N && !placed; c++) {
          if (!gs.current || !gs.board.canPlace(gs.current.shape, r, c)) continue;
          placed = gs.tryPlace(r, c).length > 0;
        }
      }
      if (!placed) gs.skipPiece();
    }
    return gs;
  }

  it('re-simulates a run with skips to exactly the same score', () => {
    const gs = playMixedRun();
    const replay = gs.buildReplay();
    expect(replay.moves.some(m => m.t === 's')).toBe(true);
    expect(replay.siege).toEqual({ missionId: 'm1', enemy: 'raiders', reliefTurns: 18 });

    const result = simulateRun(replay);
    expect(result.valid).toBe(true);
    expect(result.score).toBe(gs.score);
    expect(result.endCause).toBe(gs.deathCause);
  });

  it('refuses a siege log that does not say which siege it was', () => {
    const replay = { ...playMixedRun().buildReplay(), siege: undefined };
    expect(simulateRun(replay).valid).toBe(false);
  });

  it('is measured on captures, ground, turns and skips', () => {
    const gs = playMixedRun();
    const m = gs.buildRunSummary().siege!;
    expect(m.turnsSurvived).toBe(gs.totalTurns);
    expect(m.skipsUsed).toBe(gs.skips);
    expect(m.heldAtEnd).toBe(gs.heldCount);
    expect(m.enemiesCaptured).toBe(gs.capturedCount);
    expect(m.enemiesAtEnd).toBe(gs.raiders.length);
    // The telemetry token the playtest is filed under
    expect(siegeVariantKey(m.variant)).toBe('m1-raiders-relief18');
  });

  it('leaves the siege block off a summary from any other mode', () => {
    const gs = new GameState(undefined, 'classic');
    gs.start();
    expect(gs.buildRunSummary('quit').siege).toBeUndefined();
  });
});

describe('the layout', () => {
  it('gives the siege at least 31 px cells at 360 and 34 px at 390', () => {
    const small = computeLayout(360, 640, SIEGE_GRID_SIZE, false);
    expect(small.gridCells).toBe(11);
    expect(small.cellSize).toBeGreaterThanOrEqual(31);
    // 8 px gutters, not 16
    expect(small.gridOriginX).toBeGreaterThanOrEqual(8);
    expect(small.gridOriginX).toBeLessThan(16);

    const big = computeLayout(390, 844, SIEGE_GRID_SIZE, false);
    expect(big.cellSize).toBeGreaterThanOrEqual(34);
  });

  it('keeps the board, the hand and the buttons on the screen', () => {
    for (const [w, h] of [[360, 640], [390, 844], [414, 896]] as [number, number][]) {
      const l = computeLayout(w, h, SIEGE_GRID_SIZE, false);
      expect(l.gridOriginY + l.gridSize).toBeLessThan(h);
      expect(l.rotateRect.y + l.rotateRect.h, `${w}x${h}`).toBeLessThanOrEqual(h);
      // Buttons are finger targets first
      expect(l.rotateRect.h).toBeGreaterThanOrEqual(44);
      expect(l.skipRect.h).toBeGreaterThanOrEqual(44);
      expect(l.skipRect.w).toBeGreaterThan(60);
      // SKIP sits beside ROTATE, not on top of it
      expect(l.skipRect.x).toBeGreaterThanOrEqual(l.rotateRect.x + l.rotateRect.w);
    }
  });

  it('leaves the nine-cell modes where they were, and gives them no SKIP', () => {
    const l = computeLayout(360, 640, GRID_SIZE, false);
    expect(l.gridCells).toBe(9);
    expect(l.cellSize).toBe(Math.floor(Math.min(360 - 32, 640 * 0.5) / 9));
    expect(l.skipRect.w).toBe(0);
    expect(l.rotateRect.w).toBe(128);
  });
});

describe('the picker offers one mission', () => {
  it('shows M1 and keeps the other two as data', () => {
    expect(PICKER_MISSIONS).toEqual(['m1']);
    for (const id of ['m1', 'm2', 'm3'] as const) {
      const mission = MISSIONS[id];
      expect(mission.size).toBe(SIEGE_GRID_SIZE);
      expect(mission.supply).toHaveLength(18);
      const terrain = terrainOf(mission.map, mission.size);
      expect(cellsOfTerrain(terrain, 'keep' as Terrain)).toEqual([KEEP]);
      expect(cellsOfTerrain(terrain, 'gate').length).toBeGreaterThan(0);
    }
    expect(cellsOfTerrain(terrainOf(MISSIONS.m3.map, N), 'ruin').length).toBeGreaterThan(0);
  });
});

describe('the tide is kept but not wired', () => {
  it('still answers where a flood would go, on the bigger board', () => {
    // Nothing in GameState drives this: Hold the Keep has no clock for a tide
    // to expand on. It is here so the `enemy` flag points at something real.
    const b = siegeBoard(['...........']);
    const step = stepTide(b, new Set(['0,5']), KEEP, mulberry32(1));
    expect(step.claimed).toEqual({ row: 1, col: 5 });

    const gs = siegeGame();
    expect(gs.config.siege!.enemy).toBe('raiders');
    expect(gs.enemyCells()).toEqual([]);
  });
});
