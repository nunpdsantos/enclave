import { describe, it, expect } from 'vitest';
import { Board, INNER_CELLS } from '../src/core/Board';
import { siegeConfig, SIEGE_ENEMY_BONUS } from '../src/core/Config';
import { GameState } from '../src/core/GameState';
import {
  FINITE_ARRIVAL_TURN, MISSIONS, MISSION_ORDER, buildSpawnSchedule, cellsOfTerrain,
  finiteSpawnHorizon, stepsFromNearestGate, terrainOf,
} from '../src/core/Missions';
import { makePiece } from '../src/core/Pieces';
import { mulberry32 } from '../src/core/Random';
import { simulateRun } from '../src/core/Replay';
import {
  distanceToKeep, planRaiders, raiderTarget, readIntent, resolveRaiders, stepRaiders,
  stepTide, tideIntervalAt,
} from '../src/core/Siege';
import { GRID_SIZE, GridPos, Raider, Terrain, TerrainGrid } from '../src/core/types';
import { grid, playFastDump } from './helpers';

/**
 * Hold the Keep.
 *
 * Two kinds of test here, deliberately. The pathfinding and the two enemies
 * are exercised against `Siege.ts` directly, because they are pure functions
 * of a board and a seed and a test that has to play a run to reach them is a
 * test that will one day fail for a reason it is not about. Everything the
 * player experiences — captures, refunds, victory, the metrics — is driven
 * through GameState, because that is where those rules actually live.
 */

const WHITE = 0xffffff;
const KEEP: GridPos = { row: 4, col: 4 };

type Enemy = 'raiders' | 'tide';
type Goal = 'finite' | 'endless';

function siegeGame(
  enemy: Enemy, goal: Goal, missionId: 'm1' | 'm2' | 'm3' = 'm1', seed = 1,
): GameState {
  const gs = new GameState(siegeConfig(missionId, enemy, goal, seed), 'siege');
  gs.start();
  return gs;
}

/** A board with M1's terrain and whatever blocks the rows describe */
function siegeBoard(rows: string[], map: string[] = MISSIONS.m1.map): Board {
  const b = new Board();
  b.setTerrain(terrainOf(map));
  b.grid = grid(rows);
  return b;
}

/** Put raiders on the board through the engine, so ids and intent stay honest */
function setRaiders(gs: GameState, cells: GridPos[]): Raider[] {
  gs.placeEnemies(cells);
  return gs.raiders;
}

/** Place a single block at (row, col), whatever the bag happened to deal */
function placeDot(gs: GameState, row: number, col: number) {
  gs.current = makePiece('single', 0, WHITE);
  return gs.tryPlace(row, col);
}

function sortedCells(cells: GridPos[]): string[] {
  return cells.map(c => `${c.row},${c.col}`).sort();
}

/** Run the clock forward in small steps, stopping the moment the run ends */
function runClock(gs: GameState, seconds: number, step = 0.05): void {
  for (let t = 0; t < seconds && !gs.isGameOver; t += step) gs.tick(step);
}

describe('the distance field', () => {
  it('costs floor 1, a player wall 4, and refuses a ruin', () => {
    const b = siegeBoard([
      '.........',
      '.........',
      '.........',
      '....#....',
      '.........',
    ]);
    const dist = distanceToKeep(b, KEEP);
    expect(dist[4][4]).toBe(0);
    // Three open cells to the Keep's left
    expect(dist[4][1]).toBe(3);
    // Straight down through the wall costs 4 + 1; round it costs 1 + 1 + 1
    expect(dist[3][4]).toBe(4);
    expect(dist[2][4]).toBe(4);
  });

  it('leaves a cell walled off by ruins unreachable', () => {
    const terrain: TerrainGrid = Board.createFloorTerrain();
    terrain[4][4] = 'keep';
    for (const [r, c] of [[0, 1], [1, 0], [1, 2], [2, 1]]) terrain[r][c] = 'ruin';
    const b = new Board();
    b.setTerrain(terrain);
    expect(distanceToKeep(b, KEEP)[1][1]).toBe(Infinity);
  });
});

describe('raider movement', () => {
  it('is identical for the same board and the same seed', () => {
    const cells = [{ row: 2, col: 2 }, { row: 6, col: 7 }, { row: 1, col: 5 }];
    const runOnce = () => {
      const b = siegeBoard(['.........']);
      const raiders: Raider[] = cells.map((c, i) => ({ id: i + 1, ...c }));
      return stepRaiders(b, raiders, KEEP, mulberry32(99))
        .map(s => `${s.id}:${s.to.row},${s.to.col}`);
    };
    expect(runOnce()).toEqual(runOnce());
  });

  it('breaks a tie in a fixed direction order — up, down, left, right', () => {
    // (2,2) is equidistant by going down or by going right
    const b = siegeBoard(['.........']);
    const dist = distanceToKeep(b, KEEP);
    // A draw that always takes the first candidate must take the earlier
    // direction, which is 'down' before 'right'
    const first = raiderTarget(b, { row: 2, col: 2 }, dist, new Set(), () => 0);
    expect(first).toEqual({ row: 3, col: 2 });
    // ...and one that always takes the last must take the other of the pair
    const last = raiderTarget(b, { row: 2, col: 2 }, dist, new Set(), () => 0.999);
    expect(last).toEqual({ row: 2, col: 3 });
  });

  it('destroys the wall in its way and holds position', () => {
    // Boxed in by four player walls: every route out costs a wall, and the
    // cheapest of them is the one facing the Keep
    const b = siegeBoard([
      '.........',
      '.........',
      '.........',
      '..#......',
      '.#.#.....',
      '..#......',
    ]);
    const raiders: Raider[] = [{ id: 1, row: 4, col: 2 }];
    const steps = stepRaiders(b, raiders, KEEP, mulberry32(1));
    expect(steps[0].to).toEqual({ row: 4, col: 2 });
    expect(steps[0].brokeWall).toEqual({ row: 4, col: 3 });
    expect(b.grid[4][3]).toBeNull();
    // The other three walls are untouched: one wall per raider per turn
    expect(b.grid[3][2]).not.toBeNull();
    expect(b.grid[5][2]).not.toBeNull();
    expect(b.grid[4][1]).not.toBeNull();
  });

  it('will not plan into a cell another raider holds at the start of the phase', () => {
    // Two raiders in a column, both heading down. Every plan is read off one
    // snapshot, so the one behind cannot aim at a cell that is occupied in it
    // — it goes round rather than following into a gap that has not opened yet.
    const b = siegeBoard(['.........']);
    const raiders: Raider[] = [{ id: 1, row: 2, col: 4 }, { id: 2, row: 1, col: 4 }];
    const steps = stepRaiders(b, raiders, KEEP, mulberry32(3));
    expect(steps[0].to).toEqual({ row: 3, col: 4 });
    expect(steps[1].to).not.toEqual({ row: 2, col: 4 });
    expect(steps[1].to).not.toEqual({ row: 1, col: 4 });
  });

  it('waits when the cell it planned for was taken before its turn came', () => {
    // Both plan into (4,2): id 1 from the left, id 2 from above. Resolution is
    // in id order, so id 1 gets there and id 2 finds it occupied.
    const b = siegeBoard(['.........']);
    const raiders: Raider[] = [{ id: 1, row: 4, col: 1 }, { id: 2, row: 3, col: 2 }];
    const plans = new Map<number, GridPos>([
      [1, { row: 4, col: 2 }], [2, { row: 4, col: 2 }],
    ]);
    const steps = resolveRaiders(b, raiders, plans);
    expect(steps[0].to).toEqual({ row: 4, col: 2 });
    expect(steps[1].to).toEqual({ row: 3, col: 2 });
    expect(steps[1].brokeWall).toBeNull();
  });

  it('walks into the gap when another raider broke the wall it aimed at', () => {
    const b = siegeBoard([
      '.........',
      '.........',
      '.........',
      '.........',
      '..#......',
    ]);
    const raiders: Raider[] = [{ id: 1, row: 3, col: 2 }, { id: 2, row: 4, col: 1 }];
    const plans = new Map<number, GridPos>([
      [1, { row: 4, col: 2 }], [2, { row: 4, col: 2 }],
    ]);
    const steps = resolveRaiders(b, raiders, plans);
    expect(steps[0].brokeWall).toEqual({ row: 4, col: 2 });
    expect(steps[0].to).toEqual({ row: 3, col: 2 });
    // The wall is down by the time id 2 resolves, so its attack becomes a move
    expect(steps[1].to).toEqual({ row: 4, col: 2 });
    expect(steps[1].brokeWall).toBeNull();
  });

  it('walks onto the Keep when it is next to it', () => {
    const b = siegeBoard(['.........']);
    const steps = stepRaiders(b, [{ id: 1, row: 3, col: 4 }], KEEP, mulberry32(1));
    expect(steps[0].to).toEqual(KEEP);
  });
});

describe('the spawn schedule', () => {
  it('lands a raider every two placements from turn one', () => {
    const schedule = buildSpawnSchedule(MISSIONS.m1, false, finiteSpawnHorizon(MISSIONS.m1));
    expect(schedule.map(s => s.turn)).toEqual([1, 3, 5, 7, 9, 11, 12]);
    expect(schedule.every(s => s.gate === 0)).toBe(true);
  });

  it('alternates gates when the mission has two', () => {
    const schedule = buildSpawnSchedule(MISSIONS.m2, false, finiteSpawnHorizon(MISSIONS.m2));
    expect(schedule.slice(0, 4).map(s => s.gate)).toEqual([0, 1, 0, 1]);
  });

  it('tightens to one a turn after turn ten on the Old City', () => {
    const turns = buildSpawnSchedule(MISSIONS.m3, false, finiteSpawnHorizon(MISSIONS.m3))
      .map(s => s.turn);
    expect(turns).toEqual([1, 3, 5, 7, 9, 11, 12]);
  });

  it('lands its last finite wave so an unopposed raider arrives on turn 16', () => {
    for (const id of MISSION_ORDER) {
      const mission = MISSIONS[id];
      const walk = stepsFromNearestGate(mission.map);
      const schedule = buildSpawnSchedule(mission, false, finiteSpawnHorizon(mission));
      const last = schedule[schedule.length - 1].turn;
      // A raider does not move on the phase it arrives in, so it lands `walk`
      // placements after the wave that brought it
      expect(last + walk).toBe(FINITE_ARRIVAL_TURN);
      expect(last).toBeLessThan(18);
    }
  });

  it('ramps to one a turn by turn twenty when the mission is endless', () => {
    const turns = buildSpawnSchedule(MISSIONS.m1, true, Infinity).map(s => s.turn);
    expect(turns.slice(0, 11)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21]);
    // Past the ramp every placement brings one
    const late = turns.slice(11, 20);
    expect(late).toEqual([22, 23, 24, 25, 26, 27, 28, 29, 30]);
  });

  it('puts the raider on the gate cell during the run', () => {
    const gs = siegeGame('raiders', 'finite');
    expect(gs.raiders).toHaveLength(0);
    placeDot(gs, 8, 0);
    expect(gs.raiders).toHaveLength(1);
    expect(gs.raiders[0]).toMatchObject({ row: 0, col: 4 });
  });
});

describe('breach', () => {
  it('ends a raider run when one reaches the Keep', () => {
    const gs = siegeGame('raiders', 'finite');
    setRaiders(gs, [{ row: 3, col: 4 }]);
    const events = placeDot(gs, 8, 0);
    expect(gs.isGameOver).toBe(true);
    expect(gs.deathCause).toBe('breach');
    expect(events.some(e => e.type === 'breach')).toBe(true);
    expect(gs.buildRunSummary().siege?.breachTurn).toBe(1);
  });

  it('ends a tide run when the flood reaches the Keep', () => {
    const gs = siegeGame('tide', 'endless');
    // The tide starts in the doorway and walks the straight line down
    expect([...gs.tide]).toEqual(['0,4']);
    runClock(gs, 20);
    expect(gs.deathCause).toBe('breach');
    expect(gs.tide.has('4,4')).toBe(true);
  });
});

describe('the tide', () => {
  it('takes the frontier cell closest to the Keep', () => {
    const gs = siegeGame('tide', 'endless');
    runClock(gs, 3.1);
    // (0,3) and (0,5) are adjacent too, and both are further away
    expect(sortedCells(gs.enemyCells())).toEqual(['0,4', '1,4']);
  });

  it('erodes a wall rather than expanding when the wall is the cheapest way through', () => {
    const b = siegeBoard([
      '...#.#...',
      '....#....',
    ]);
    const step = stepTide(b, new Set(['0,4']), KEEP, mulberry32(5));
    expect(step.claimed).toBeNull();
    expect(step.erodedWall).toEqual({ row: 1, col: 4 });
    expect(b.grid[1][4]).toBeNull();
    // The two walls flanking the gate stand: one erosion per tick
    expect(b.grid[0][3]).not.toBeNull();
    expect(b.grid[0][5]).not.toBeNull();
  });

  it('counts an eroded wall against the run and leaves the tide where it was', () => {
    const gs = siegeGame('tide', 'endless');
    gs.board.grid = grid([
      '...#.#...',
      '....#....',
    ]);
    runClock(gs, 3.1);
    expect(gs.tide.size).toBe(1);
    expect(gs.board.grid[1][4]).toBeNull();
    expect(gs.buildRunSummary().siege?.wallsLost).toBe(1);
  });

  it('tightens its tempo to a floor of 1.2 s', () => {
    const cfg = siegeConfig('m1', 'tide', 'endless').siege!;
    expect(tideIntervalAt(cfg, 0)).toBeCloseTo(3.0, 5);
    expect(tideIntervalAt(cfg, 1)).toBeCloseTo(2.95, 5);
    expect(tideIntervalAt(cfg, 200)).toBeCloseTo(1.2, 5);
  });
});

describe('claiming under siege', () => {
  // A 2×2 room at rows 1–2 / cols 1–2, one block short of closed at (0,1)
  const ROOM_2X2 = [
    '..#......',
    '#..#.....',
    '#..#.....',
    '.##......',
  ];

  // A 3×3 room at rows 1–3 / cols 1–3, one block short of closed at (0,1)
  const ROOM_3X3 = [
    '..##.....',
    '#...#....',
    '#...#....',
    '#...#....',
    '.###.....',
  ];

  it('destroys the enemies inside the room and pays 75 for each', () => {
    const gs = siegeGame('raiders', 'endless');
    gs.board.grid = grid(ROOM_2X2);
    setRaiders(gs, [{ row: 1, col: 1 }, { row: 1, col: 2 }, { row: 7, col: 7 }]);
    const events = placeDot(gs, 0, 1);

    const claim = events.find(e => e.type === 'claim');
    expect(claim?.enemiesCaptured).toBe(2);
    // A 2×2 pays 4² × 10; two captures are 150 flat on top of it
    expect(claim!.scoreBreakdown!.turnScore).toBe(160);
    expect(gs.score).toBe(160 + 2 * SIEGE_ENEMY_BONUS);
    // Nothing is left standing in the room that was just sealed
    const held = sortedCells(gs.enemyCells());
    expect(held).not.toContain('1,1');
    expect(held).not.toContain('1,2');
    // The one outside it survives and has taken its step toward the Keep
    expect(held).not.toContain('7,7');
    expect(held).toContain('6,7');
  });

  it('refunds min(1 + 0.6 × area + 1.5 × captures, 8) seconds and nothing for the placement', () => {
    const gs = siegeGame('raiders', 'endless');
    gs.tick(10);
    expect(gs.timeRemaining).toBeCloseTo(30, 5);

    // An ordinary placement is worth no time at all
    gs.board.grid = grid(['.........']);
    const plain = placeDot(gs, 8, 0);
    expect(plain[0].timeBonus).toBe(0);
    expect(gs.timeRemaining).toBeCloseTo(30, 5);

    // 1 + 0.6 × 4 + 1.5 × 2 = 6.4
    gs.board.grid = grid(ROOM_2X2);
    setRaiders(gs, [{ row: 1, col: 1 }, { row: 2, col: 2 }]);
    const claim = placeDot(gs, 0, 1);
    expect(claim[0].timeBonus).toBeCloseTo(6.4, 5);
    expect(gs.timeRemaining).toBeCloseTo(36.4, 5);
  });

  it('caps the refund at eight seconds', () => {
    const gs = siegeGame('raiders', 'endless');
    gs.tick(20);
    gs.board.grid = grid(ROOM_3X3);
    setRaiders(gs, [{ row: 1, col: 1 }, { row: 2, col: 2 }, { row: 3, col: 3 }]);
    // 1 + 0.6 × 9 + 1.5 × 3 = 10.9, which the cap cuts to 8
    const events = placeDot(gs, 0, 1);
    expect(events[0].timeBonus).toBe(8);
    expect(gs.timeRemaining).toBeCloseTo(28, 5);
  });

  it('scores an empty room but refunds nothing for it', () => {
    const gs = siegeGame('raiders', 'endless');
    gs.tick(10);
    gs.board.grid = grid(ROOM_3X3);
    const events = placeDot(gs, 0, 1);
    // 3×3 pays 9² × 10 with territory off
    expect(events.find(e => e.type === 'claim')!.scoreBreakdown!.turnScore).toBe(810);
    expect(events[0].timeBonus).toBe(0);
    expect(gs.timeRemaining).toBeCloseTo(30, 5);
  });

  it('never lets the clock past its 40-second cap', () => {
    const gs = siegeGame('raiders', 'endless');
    gs.tick(2);
    gs.board.grid = grid(ROOM_3X3);
    setRaiders(gs, [{ row: 1, col: 1 }, { row: 2, col: 2 }, { row: 3, col: 3 }]);
    placeDot(gs, 0, 1);
    expect(gs.timeRemaining).toBe(40);
  });

  it('ends the run when the command clock runs out', () => {
    const gs = siegeGame('raiders', 'endless');
    runClock(gs, 45);
    expect(gs.deathCause).toBe('timeout');
  });
});

describe('ruins', () => {
  /** A pocket sealed by ruins alone, plus a room with a mixed boundary */
  function ruinTerrain(): TerrainGrid {
    const t: TerrainGrid = Board.createFloorTerrain();
    t[4][4] = 'keep';
    const ruins: [number, number][] = [
      // A closed box round (1,1)–(1,3)
      [0, 0], [0, 1], [0, 2], [0, 3], [0, 4],
      [1, 0], [1, 4],
      [2, 0], [2, 1], [2, 2], [2, 3], [2, 4],
    ];
    for (const [r, c] of ruins) t[r][c] = 'ruin';
    return t;
  }

  it('bound a room but never score one on their own', () => {
    const gs = siegeGame('raiders', 'endless');
    gs.board.setTerrain(ruinTerrain());
    // The flood fill sees the pocket; the claim rules refuse it, because the
    // player built nothing and there is nothing to knock down
    const enclosed = gs.board.findEnclosures();
    const pocket = enclosed.find(r => r.cells.some(c => c.row === 1 && c.col === 1));
    expect(pocket).toBeDefined();
    expect(pocket!.fence).toHaveLength(0);
    expect(pocket!.ruinCells.length).toBeGreaterThan(0);
    expect(gs.claimableRegions(gs.board)).toHaveLength(0);
    expect(gs.score).toBe(0);
  });

  it('survive a claim they helped to bound', () => {
    const gs = siegeGame('raiders', 'endless');
    const t: TerrainGrid = Board.createFloorTerrain();
    t[4][4] = 'keep';
    t[0][1] = 'ruin';
    t[0][2] = 'ruin';
    gs.board.setTerrain(t);
    // The room's top is ruin; the player builds the other three sides bar one
    gs.board.grid = grid([
      '.........',
      '#..#.....',
      '#..#.....',
      '.#.......',
    ]);
    const events = placeDot(gs, 3, 2);

    const claim = events.find(e => e.type === 'claim');
    expect(claim).toBeDefined();
    expect(claim!.claim!.totalArea).toBe(4);
    // The player's fence is gone, the old wall is exactly where it was
    expect(gs.board.grid[1][0]).toBeNull();
    expect(gs.board.grid[3][1]).toBeNull();
    expect(gs.board.terrainAt(0, 1)).toBe('ruin');
    expect(gs.board.terrainAt(0, 2)).toBe('ruin');
  });

  it('refuse a piece, as do the Keep, the gates and the enemies', () => {
    const gs = siegeGame('raiders', 'endless', 'm3');
    const dot = makePiece('single', 0, WHITE).shape;
    expect(gs.board.canPlace(dot, 3, 1)).toBe(false); // ruin
    expect(gs.board.canPlace(dot, 4, 4)).toBe(false); // keep
    expect(gs.board.canPlace(dot, 0, 4)).toBe(false); // gate
    expect(gs.board.canPlace(dot, 5, 5)).toBe(true);
    setRaiders(gs, [{ row: 5, col: 5 }]);
    expect(gs.board.canPlace(dot, 5, 5)).toBe(false); // raider
  });
});

describe('the meta-systems are off', () => {
  it('keeps the streak multiplier at 1 and records no echo or survey', () => {
    const gs = siegeGame('raiders', 'endless');
    // Every inner cell already lit: a survey would fire here if one could
    for (let r = 1; r < GRID_SIZE - 1; r++) {
      for (let c = 1; c < GRID_SIZE - 1; c++) gs.board.lit[r][c] = true;
    }
    gs.board.grid = grid([
      '..#......',
      '#..#.....',
      '#..#.....',
      '.##......',
    ]);
    const events = placeDot(gs, 0, 1);

    const claim = events.find(e => e.type === 'claim');
    expect(claim!.scoreBreakdown!.streakMultiplier).toBe(1);
    expect(claim!.scoreBreakdown!.echoMultiplier).toBe(1);
    expect(gs.streakCount).toBe(0);
    expect(gs.streakMultiplier).toBe(1);
    expect(gs.maxStreak).toBe(0);
    expect(gs.echoWalls()).toHaveLength(0);
    expect(gs.activeEchoKeys().size).toBe(0);
    expect(events.some(e => e.type === 'survey')).toBe(false);
    expect(gs.surveys).toBe(0);
    // A full map and no survey to spend it on: it simply stays full
    expect(gs.board.litCount()).toBe(INNER_CELLS);
  });

  it('pays nothing for laying a block, and does not tighten the bag', () => {
    const gs = siegeGame('raiders', 'endless');
    placeDot(gs, 8, 0);
    expect(gs.score).toBe(0);
    expect(gs.config.bagByTier).toBe(false);
    expect(gs.currentSpeedFraction).toBe(1);
  });
});

describe('the mission variants', () => {
  it('produce the right config for each square of the 2×2', () => {
    for (const enemy of ['raiders', 'tide'] as Enemy[]) {
      for (const goal of ['finite', 'endless'] as Goal[]) {
        const cfg = siegeConfig('m2', enemy, goal);
        expect(cfg.siege?.enemy).toBe(enemy);
        expect(cfg.siege?.mission).toBe(goal);
        expect(cfg.siege?.missionId).toBe('m2');
        expect(cfg.pieceBudget).toBe(goal === 'finite' ? 18 : undefined);
        expect(cfg.timer.startSeconds).toBe(40);
        expect(cfg.timer.placeBonus).toBe(0);
        expect(cfg.scoring.streakEnabled).toBe(false);
        expect(cfg.echo.enabled).toBe(false);
        // Off by default, and the flag is the whole switch
        expect(cfg.territory.enabled).toBe(false);
        expect(cfg.territory.surveyEnabled).toBe(false);
        expect(cfg.scoring.multiCloseBonusPerRoom).toBe(0);
        expect(cfg.timer.claimRefundNeedsCapture).toBe(true);
        expect(cfg.siege?.wallCost).toBe(4);
        expect(cfg.siege?.enemyBonus).toBe(75);
      }
    }
  });

  it('lay out the three maps as their names promise', () => {
    const gates = (id: 'm1' | 'm2' | 'm3'): GridPos[] =>
      cellsOfTerrain(terrainOf(MISSIONS[id].map), 'gate');
    expect(gates('m1')).toEqual([{ row: 0, col: 4 }]);
    expect(gates('m2')).toEqual([{ row: 4, col: 0 }, { row: 4, col: 8 }]);
    expect(gates('m3')).toHaveLength(2);

    const ruinCount = (id: 'm1' | 'm2' | 'm3'): number =>
      cellsOfTerrain(terrainOf(MISSIONS[id].map), 'ruin').length;
    expect(ruinCount('m1')).toBe(0);
    expect(ruinCount('m2')).toBe(0);
    expect(ruinCount('m3')).toBeGreaterThanOrEqual(4);
    expect(ruinCount('m3')).toBeLessThanOrEqual(6);

    for (const id of ['m1', 'm2', 'm3'] as const) {
      const keeps = cellsOfTerrain(terrainOf(MISSIONS[id].map), 'keep' as Terrain);
      expect(keeps).toEqual([KEEP]);
    }
  });

  it('wins a finite mission when all eighteen pieces have been survived', () => {
    const gs = siegeGame('raiders', 'finite');
    for (let i = 0; i < 18; i++) {
      expect(gs.isGameOver).toBe(false);
      // Keep the board clear and the gate empty: this test is about the
      // ending, not about surviving a siege
      gs.board.grid = grid(['.........']);
      setRaiders(gs, []);
      placeDot(gs, 8, 0);
    }
    expect(gs.isGameOver).toBe(true);
    expect(gs.deathCause).toBe('victory');
    expect(gs.buildRunSummary().endCause).toBe('victory');
    expect(gs.totalTurns).toBe(18);
  });

  it('never runs out of pieces when the mission is endless', () => {
    const gs = siegeGame('raiders', 'endless');
    expect(gs.piecesRemaining).toBe(Infinity);
    for (let i = 0; i < 25; i++) {
      gs.board.grid = grid(['.........']);
      setRaiders(gs, []);
      placeDot(gs, 8, 0);
    }
    expect(gs.isGameOver).toBe(false);
    expect(gs.current).not.toBeNull();
  });
});

describe('determinism', () => {
  /**
   * A run played by rule: the first legal placement in scan order, over the
   * pieces the seed actually dealt. Not clever, but reproducible — which is
   * the only property being tested.
   */
  function playRun(enemy: Enemy, seed: number, moves: number): GameState {
    const gs = siegeGame(enemy, 'finite', 'm2', seed);
    for (let i = 0; i < moves && !gs.isGameOver; i++) {
      gs.tick(0.3);
      if (gs.isGameOver || !gs.current) break;
      let placed = false;
      for (let r = 0; r < GRID_SIZE && !placed; r++) {
        for (let c = 0; c < GRID_SIZE && !placed; c++) {
          if (!gs.current || !gs.board.canPlace(gs.current.shape, r, c)) continue;
          placed = gs.tryPlace(r, c).length > 0;
        }
      }
      if (!placed) break;
    }
    return gs;
  }

  for (const enemy of ['raiders', 'tide'] as Enemy[]) {
    it(`replays the same ${enemy} run from the same seed and moves`, () => {
      const a = playRun(enemy, 424242, 14);
      const b = playRun(enemy, 424242, 14);
      expect(b.score).toBe(a.score);
      expect(b.gameElapsed).toBeCloseTo(a.gameElapsed, 10);
      expect(sortedCells(b.enemyCells())).toEqual(sortedCells(a.enemyCells()));
      expect(b.board.grid).toEqual(a.board.grid);
      expect(b.deathCause).toBe(a.deathCause);
    });

    it(`re-plays a ${enemy} log to the same score through simulateRun`, () => {
      const gs = playRun(enemy, 8675309, 14);
      const replay = gs.buildReplay();
      expect(replay.siege).toEqual({
        missionId: 'm2', enemy, mission: 'finite',
      });
      const result = simulateRun(replay);
      expect(result.valid).toBe(true);
      expect(result.score).toBe(gs.score);
    });
  }

  it('refuses a siege log that does not say which siege it was', () => {
    const gs = playRun('raiders', 11, 4);
    const replay = { ...gs.buildReplay(), siege: undefined };
    expect(simulateRun(replay).valid).toBe(false);
  });

  it('previews exactly the step the enemy phase will take', () => {
    // The make-or-break promise of the mode: the arrow the player is shown
    // has to be the cell the raider actually steps into. Both sides read the
    // same seeded draw, so a tie cannot resolve one way on screen and the
    // other on the board.
    const board = siegeBoard([
      '.........',
      '..#......',
      '.........',
      '.....#...',
    ]);
    const raiders: Raider[] = [
      { id: 1, row: 2, col: 2 }, { id: 2, row: 6, col: 6 }, { id: 3, row: 0, col: 4 },
    ];
    const intent = readIntent(board, raiders, new Set(), KEEP, mulberry32(0));
    const steps = stepRaiders(
      board.clone(), raiders.map(r => ({ ...r })), KEEP, mulberry32(0),
    );
    expect(steps).toHaveLength(3);
    for (const step of steps) {
      // A raider that stopped to break a wall was previewed as walking into it
      expect(intent.steps.get(step.id)).toEqual(step.brokeWall ?? step.to);
    }
    for (const wall of intent.threatenedWalls) {
      expect(board.grid[wall.row][wall.col]).not.toBeNull();
    }
  });

  it('keeps a live intent as the run goes on', () => {
    const gs = siegeGame('raiders', 'endless');
    placeDot(gs, 8, 0);
    // One raider has arrived at the gate, four weighted cells from the Keep
    expect(gs.raiders).toHaveLength(1);
    expect(gs.intent!.routeLengths.get(gs.raiders[0].id)).toBe(4);
    expect(gs.intent!.steps.get(gs.raiders[0].id)).toEqual({ row: 1, col: 4 });
  });
});

describe('the playtest metrics', () => {
  it('counts only the placements that changed a route', () => {
    const idle = siegeGame('raiders', 'endless');
    setRaiders(idle, [{ row: 0, col: 4 }]);
    // A block in the far corner: the raider's route is four cells, before
    // and after
    placeDot(idle, 8, 0);
    expect(idle.buildRunSummary().siege?.routeChangingPlacements).toBe(0);

    const blocking = siegeGame('raiders', 'endless');
    setRaiders(blocking, [{ row: 0, col: 4 }]);
    // A block straight in front of the gate: the route now costs six
    placeDot(blocking, 1, 4);
    expect(blocking.buildRunSummary().siege?.routeChangingPlacements).toBe(1);
  });

  it('counts a placement that moved where the tide will go next', () => {
    const idle = siegeGame('tide', 'endless');
    expect(idle.intent!.tideTarget).toEqual({ row: 1, col: 4 });
    // A block in the far corner leaves the flood's plan exactly as it was
    placeDot(idle, 8, 0);
    expect(idle.intent!.tideTarget).toEqual({ row: 1, col: 4 });
    expect(idle.buildRunSummary().siege?.routeChangingPlacements).toBe(0);

    const diverted = siegeGame('tide', 'endless');
    // Walling the cell in front of the gate is cheaper to walk round than to
    // erode, so the tide goes sideways instead — a changed plan
    placeDot(diverted, 1, 4);
    expect(diverted.intent!.tideTarget).not.toEqual({ row: 1, col: 4 });
    expect(diverted.buildRunSummary().siege?.routeChangingPlacements).toBe(1);
  });

  it('records room areas, captures per claim and decision times', () => {
    const gs = siegeGame('raiders', 'endless');
    gs.tick(1.5);
    gs.board.grid = grid([
      '..#......',
      '#..#.....',
      '#..#.....',
      '.##......',
    ]);
    setRaiders(gs, [{ row: 1, col: 1 }]);
    placeDot(gs, 0, 1);

    const m = gs.buildRunSummary().siege!;
    expect(m.roomAreas).toEqual([4]);
    expect(m.capturesPerClaim).toEqual({ 1: 1 });
    expect(m.enemiesCaptured).toBe(1);
    expect(m.decisionTimes).toHaveLength(1);
    expect(m.decisionTimes[0]).toBeCloseTo(1.5, 5);
    expect(m.variant).toEqual({ missionId: 'm1', enemy: 'raiders', mission: 'endless' });
  });

  it('counts every wall the enemy takes down', () => {
    const gs = siegeGame('raiders', 'endless');
    // A full-height wall down column 3. Nothing is enclosed — both sides of
    // it reach the board edge — so there is no claim to confuse the count,
    // and the only route to the Keep is straight through.
    gs.board.grid = grid(Array(GRID_SIZE).fill('...#.....'));
    setRaiders(gs, [{ row: 4, col: 2 }]);
    placeDot(gs, 8, 0);
    expect(gs.board.grid[4][3]).toBeNull();
    expect(gs.raiders.some(r => r.row === 4 && r.col === 2)).toBe(true);
    expect(gs.buildRunSummary().siege?.wallsLost).toBe(1);
  });

  it('leaves the siege block off a summary from any other mode', () => {
    const gs = new GameState(undefined, 'classic');
    gs.start();
    expect(gs.buildRunSummary('quit').siege).toBeUndefined();
  });
});

describe('what a placement is allowed to claim', () => {
  /** A courtyard the ruins had already closed, before anybody built anything */
  function courtyard(): TerrainGrid {
    const t: TerrainGrid = Board.createFloorTerrain();
    t[4][4] = 'keep';
    for (const [r, c] of [
      [0, 0], [0, 1], [0, 2], [0, 3], [0, 4],
      [1, 0], [1, 4],
      [2, 0], [2, 1], [2, 2], [2, 3], [2, 4],
    ]) t[r][c] = 'ruin';
    return t;
  }

  it('pays for a room this placement closed, never for one that was standing', () => {
    const gs = siegeGame('raiders', 'endless');
    gs.board.setTerrain(courtyard());
    // A block dropped inside a courtyard the old walls had already sealed
    // splits it in two. Neither half is new, so neither is worth anything.
    const events = placeDot(gs, 1, 2);
    expect(events.some(e => e.type === 'claim')).toBe(false);
    expect(gs.score).toBe(0);
  });

  it('still pays when the placement is what closed it', () => {
    const gs = siegeGame('raiders', 'endless');
    const t: TerrainGrid = Board.createFloorTerrain();
    t[4][4] = 'keep';
    // Ruins along the top only: the player has to build the rest
    t[0][1] = 'ruin';
    t[0][2] = 'ruin';
    gs.board.setTerrain(t);
    gs.board.grid = grid([
      '.........',
      '#..#.....',
      '#..#.....',
      '.#.......',
    ]);
    const events = placeDot(gs, 3, 2);
    expect(events.find(e => e.type === 'claim')!.claim!.totalArea).toBe(4);
  });

  it('counts an enemy cell in the area of the room that encloses it', () => {
    const gs = siegeGame('raiders', 'endless');
    gs.board.grid = grid([
      '..#......',
      '#..#.....',
      '#..#.....',
      '.##......',
    ]);
    setRaiders(gs, [{ row: 1, col: 1 }, { row: 2, col: 2 }]);
    const claim = placeDot(gs, 0, 1).find(e => e.type === 'claim');
    // Four cells, two of them with a raider standing on them
    expect(claim!.claim!.totalArea).toBe(4);
    expect(claim!.enemiesCaptured).toBe(2);
  });
});

describe('one snapshot per placement', () => {
  it('captures every room\'s occupants, then removes the union of their fences', () => {
    const gs = siegeGame('raiders', 'endless');
    // Two 1-cell rooms at (1,1) and (1,3), both a wall short along the top.
    // One BAR 3 laid across row 0 closes them together.
    gs.board.grid = grid([
      '.........',
      '#.#.#....',
      '.#.#.....',
    ]);
    setRaiders(gs, [{ row: 1, col: 1 }, { row: 1, col: 3 }]);
    gs.current = makePiece('tri_line', 0, WHITE);
    const events = gs.tryPlace(0, 1);

    const claim = events.find(e => e.type === 'claim')!;
    expect(claim.claim!.regions).toHaveLength(2);
    expect(claim.enemiesCaptured).toBe(2);
    // Both fences went in one go — the union, not one room's worth
    for (const [r, c] of [[1, 0], [1, 2], [1, 4], [2, 1], [2, 3], [0, 1], [0, 3]]) {
      expect(gs.board.grid[r][c]).toBeNull();
    }
    const m = gs.buildRunSummary().siege!;
    expect(m.enemiesCaptured).toBe(2);
    expect(m.capturesPerClaim).toEqual({ 2: 1 });
    expect(m.roomAreas).toEqual([1, 1]);
  });

  it('turns an attack on a wall the claim removed into a step into the gap', () => {
    const gs = siegeGame('raiders', 'endless');
    // A raider boxed against a wall it means to break, where that wall is
    // also the fence of the room the next placement seals
    gs.board.grid = grid(Array(GRID_SIZE).fill('...#.....'));
    setRaiders(gs, [{ row: 4, col: 2 }]);
    const before = gs.intent!;
    expect(before.threatenedWalls).toContainEqual({ row: 4, col: 3 });

    // The same board with (4,3) gone: the plan becomes a move, not an attack
    const probe = gs.board.clone();
    probe.grid[4][3] = null;
    const after = readIntent(probe, gs.raiders, new Set(), KEEP, mulberry32(0));
    expect(after.threatenedWalls).not.toContainEqual({ row: 4, col: 3 });
    expect([...after.steps.values()]).toContainEqual({ row: 4, col: 3 });
  });

  it('previews the whole resolution of a candidate placement', () => {
    const gs = siegeGame('raiders', 'endless');
    gs.board.grid = grid([
      '..#......',
      '#..#.....',
      '#..#.....',
      '.##......',
    ]);
    setRaiders(gs, [{ row: 1, col: 1 }, { row: 6, col: 4 }]);
    const preview = gs.previewPlacement(makePiece('single', 0, WHITE), 0, 1)!;

    expect(preview.regions).toHaveLength(1);
    expect(preview.captured).toEqual([{ row: 1, col: 1 }]);
    // The fence the claim would spend, and nothing that is not fence
    expect(sortedCells(preview.fenceCleared)).toContain('0,1');
    expect(sortedCells(preview.fenceCleared)).toContain('3,2');
    // 4² × 10 for the room plus 75 for the capture
    expect(preview.points).toBe(160 + 75);
    // The survivor's intent, read off the board the claim would leave
    expect(preview.intent.steps.size).toBe(1);
    // ...and nothing was actually committed
    expect(gs.score).toBe(0);
    expect(gs.raiders).toHaveLength(2);
    expect(gs.board.grid[0][1]).toBeNull();
  });
});

describe('the tide chooses by cost, not by proximity', () => {
  it('walks round a single wall and through one it cannot go round', () => {
    // One wall in the way: five cells of detour beats four of wall
    const roundIt = siegeBoard(['....#....']);
    roundIt.grid[1][4] = 0x111111;
    const detour = stepTide(roundIt, new Set(['0,4']), KEEP, mulberry32(5));
    expect(detour.erodedWall).toBeNull();
    expect(detour.claimed).not.toBeNull();

    // Walled in on every side: the wall is now the cheapest thing there is
    const throughIt = siegeBoard(['...#.#...', '....#....']);
    const erode = stepTide(throughIt, new Set(['0,4']), KEEP, mulberry32(5));
    expect(erode.erodedWall).toEqual({ row: 1, col: 4 });
  });

  it('prefers the wall once walls are cheap enough', () => {
    // The same board at wallCost 2: through the wall is 2 + 2 = 4 against a
    // detour of 5, so the knob really is the decision
    const b = siegeBoard(['....#....']);
    b.grid[1][4] = 0x111111;
    expect(stepTide(b, new Set(['0,4']), KEEP, mulberry32(5), 2).erodedWall)
      .toEqual({ row: 1, col: 4 });
  });

  it('damages at most one wall a tick', () => {
    const b = siegeBoard(['...#.#...', '....#....']);
    stepTide(b, new Set(['0,4']), KEEP, mulberry32(5));
    const standing = [b.grid[0][3], b.grid[0][5], b.grid[1][4]].filter(c => c !== null);
    expect(standing).toHaveLength(2);
  });

  it('will take the Keep itself when it is on the front', () => {
    const b = siegeBoard(['.........']);
    const step = stepTide(b, new Set(['3,4']), KEEP, mulberry32(1));
    expect(step.claimed).toEqual(KEEP);
  });

  it('leaves ground a claim just took alone for one tick', () => {
    const b = siegeBoard(['.........']);
    const front = new Set(['0,4']);
    // (1,4) is the cell it would take, so cooling it forces a sidestep
    const cooled = stepTide(b, front, KEEP, mulberry32(1), 4, new Set(['1,4']));
    expect(cooled.claimed).not.toEqual({ row: 1, col: 4 });
    expect(cooled.claimed).not.toBeNull();
  });
});

describe('nowhere to place', () => {
  /** Fill every buildable cell except the ones named */
  function fillBoardExcept(gs: GameState, free: string[]): void {
    const rows: string[][] = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill('#'));
    for (const key of free) {
      const [r, c] = key.split(',').map(Number);
      rows[r][c] = '.';
    }
    gs.board.grid = grid(rows.map(r => r.join('')));
    // The map's own cells never hold a block
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        if (gs.board.terrainAt(r, c) !== 'floor') gs.board.grid[r][c] = null;
      }
    }
  }

  it('ends a raider run as board_lock when nothing fits after the enemy phase', () => {
    const gs = siegeGame('raiders', 'endless');
    // One free cell, and a BAR 3 in hand that cannot use it
    fillBoardExcept(gs, ['8,8']);
    gs.current = makePiece('single', 0, WHITE);
    gs.held = makePiece('tri_line', 0, WHITE);
    gs.holdUsed = true;
    gs.tryPlace(8, 8);
    expect(gs.isGameOver).toBe(true);
    expect(gs.deathCause).toBe('board_lock');
  });

  it('lets a tide run wait, because erosion can open the board back up', () => {
    const gs = siegeGame('tide', 'endless');
    fillBoardExcept(gs, ['8,8']);
    gs.current = makePiece('single', 0, WHITE);
    gs.held = makePiece('tri_line', 0, WHITE);
    gs.holdUsed = true;
    gs.tryPlace(8, 8);
    // Nothing fits, but the flood is chewing through the board: the clock is
    // what ends this run, not the lock
    expect(gs.canPlaceCurrentAnywhere()).toBe(false);
    expect(gs.isGameOver).toBe(false);
    expect(gs.deathCause).toBeNull();
  });

  it('calls a clockless tide run locked after three ticks of nothing', () => {
    const cfg = siegeConfig('m1', 'tide', 'endless', 1);
    const gs = new GameState({ ...cfg, clock: { enabled: false } }, 'siege');
    gs.start();
    // Ruins everywhere: the flood is sealed in its doorway and can neither
    // reach the Keep nor chew anything open, and the two cells of floor that
    // are left already hold blocks
    const t: TerrainGrid = Board.createFloorTerrain();
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) t[r][c] = 'ruin';
    }
    t[4][4] = 'keep';
    t[0][4] = 'gate';
    t[8][0] = 'floor';
    t[8][1] = 'floor';
    gs.board.setTerrain(t);
    gs.board.grid = grid(['', '', '', '', '', '', '', '', '##.......']);
    expect(gs.canPlaceCurrentAnywhere()).toBe(false);
    runClock(gs, 40);
    expect(gs.deathCause).toBe('board_lock');
  });
});

describe('a finite tide mission cannot be skipped', () => {
  it('does not end when the pieces run out before the survival floor', () => {
    const gs = siegeGame('tide', 'finite');
    const placed = playFastDump(gs, 40);
    expect(placed).toBe(18);
    // Eighteen placements at a tenth of a second each is under two seconds,
    // and the mission asks for sixty
    expect(gs.gameElapsed).toBeLessThan(gs.config.siege!.tideMinSurvivalSeconds);
    expect(gs.isGameOver).toBe(false);
    expect(gs.isAwaitingSurvival).toBe(true);
    expect(gs.current).toBeNull();
  });

  it('is won by outlasting the flood, or lost to it', () => {
    const gs = siegeGame('tide', 'finite');
    playFastDump(gs, 40);
    runClock(gs, 90);
    expect(gs.isGameOver).toBe(true);
    // Whichever way it went, it was decided by the siege and not by the bag
    expect(['victory', 'breach', 'timeout']).toContain(gs.deathCause);
    if (gs.deathCause === 'victory') {
      expect(gs.gameElapsed).toBeGreaterThanOrEqual(
        gs.config.siege!.tideMinSurvivalSeconds,
      );
    }
  });

  it('wins a finite raider mission on the eighteenth placement, with no floor to meet', () => {
    const gs = siegeGame('raiders', 'finite');
    expect(gs.config.siege!.tideMinSurvivalSeconds).toBe(0);
    for (let i = 0; i < 18; i++) {
      gs.board.grid = grid(['.........']);
      gs.raiders = [];
      gs.board.setOccupied([]);
      placeDot(gs, 8, 0);
    }
    expect(gs.deathCause).toBe('victory');
  });
});

describe('the tunable knobs', () => {
  it('pays a capture flat by default and by area when told to', () => {
    const room = [
      '..#......',
      '#..#.....',
      '#..#.....',
      '.##......',
    ];
    const flat = siegeGame('raiders', 'endless');
    flat.board.grid = grid(room);
    setRaiders(flat, [{ row: 1, col: 1 }, { row: 1, col: 2 }]);
    placeDot(flat, 0, 1);
    expect(flat.score).toBe(160 + 2 * SIEGE_ENEMY_BONUS);

    const base = siegeConfig('m1', 'raiders', 'endless', 1);
    const squared = new GameState(
      { ...base, siege: { ...base.siege!, captureScoring: 'squared' } }, 'siege',
    );
    squared.start();
    squared.board.grid = grid(room);
    setRaiders(squared, [{ row: 1, col: 1 }, { row: 1, col: 2 }]);
    placeDot(squared, 0, 1);
    // (4 + 2)² × 10 rather than 4² × 10 + 150
    expect(squared.score).toBe(360);
  });

  it('lets a fence survive its claim when the gatehouse flag is on', () => {
    const base = siegeConfig('m1', 'raiders', 'endless', 1);
    const gs = new GameState(
      { ...base, siege: { ...base.siege!, fenceSurvivesEnemyPhase: true } }, 'siege',
    );
    gs.start();
    gs.board.grid = grid([
      '..#......',
      '#..#.....',
      '#..#.....',
      '.##......',
    ]);
    const events = placeDot(gs, 0, 1);
    expect(events.some(e => e.type === 'claim')).toBe(true);
    // The room was paid for and the walls are still standing
    expect(gs.board.grid[1][0]).not.toBeNull();
    expect(gs.board.grid[3][2]).not.toBeNull();
  });

  it('changes what a raider does when the wall gets cheap', () => {
    const b = siegeBoard(['....#....']);
    b.grid[1][4] = 0x111111;
    const raider = { id: 1, row: 0, col: 4 };
    // At 4 the raider goes round; at 2 it comes straight through
    const expensive = stepRaiders(b.clone(), [{ ...raider }], KEEP, mulberry32(0), 4);
    expect(expensive[0].brokeWall).toBeNull();
    const cheap = stepRaiders(b.clone(), [{ ...raider }], KEEP, mulberry32(0), 2);
    expect(cheap[0].brokeWall).toEqual({ row: 1, col: 4 });
  });
});

describe('every square of the matrix plays', () => {
  it('reaches an ending on all three maps, both enemies, both goals', () => {
    for (const id of MISSION_ORDER) {
      for (const enemy of ['raiders', 'tide'] as Enemy[]) {
        for (const goal of ['finite', 'endless'] as Goal[]) {
          const gs = new GameState(siegeConfig(id, enemy, goal, 12345), 'siege');
          gs.start();
          // A player who does not look at the board: the fastest legal
          // placement, every time, ignoring the siege entirely
          playFastDump(gs, 60);
          runClock(gs, 100);
          const summary = gs.buildRunSummary();
          expect(gs.isGameOver).toBe(true);
          expect(summary.siege?.variant).toEqual({ missionId: id, enemy, mission: goal });
          // And it loses, on every one of them. A mode a bot can win by
          // dumping pieces is a mode with no second force in it.
          expect(summary.endCause).toBe('breach');
        }
      }
    }
  });
});
