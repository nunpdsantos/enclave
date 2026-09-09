import {
  MISSIONS, SIEGE_SUPPLY_SIZE, SiegeMission, SiegeMissionId, SpawnEvent, SupplyPiece,
} from './Missions';
import { GRID_SIZE, SIEGE_GRID_SIZE } from './types';

export type Difficulty = 'classic' | 'blitz' | 'daily' | 'siege';

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  classic: 'CLASSIC',
  blitz: 'BLITZ',
  daily: 'DAILY',
  siege: 'SIEGE',
};

export interface ScoringConfig {
  /** Points per block placed (so every move scores something) */
  pointsPerBlockPlaced: number;
  /** A claim scores area² × this */
  pointsPerAreaSquared: number;
  /** Extra multiplier per additional room closed by the same piece */
  multiCloseBonusPerRoom: number;
  /** Streak multiplier: 1 + streak × increment, capped */
  streakIncrement: number;
  streakCap: number;
  /** How many non-claiming placements a streak survives */
  streakWindow: number;
  /**
   * Off pins the streak multiplier at 1 and stops counting. The siege has a
   * second force to think about; a bonus for claiming *fast* would only pull
   * against it, and it would hide whether the siege itself is the fun part.
   */
  streakEnabled: boolean;
}

export interface TimerConfig {
  startSeconds: number;
  maxSeconds: number;
  /** Time added per placement (scaled by speed) */
  placeBonus: number;
  /** Time added per claim: base + perCell × area + perEnemy × captures, capped */
  claimBaseBonus: number;
  claimPerCellBonus: number;
  /** Seconds a captured enemy is worth on top of the floor it stood on */
  claimPerEnemyBonus: number;
  claimBonusCap: number;
  /**
   * On, a claim that captured nothing refunds no time at all.
   *
   * The siege's clock is meant to be bought with captures, not with rooms: an
   * empty room still scores, but if fencing empty ground bought time too then
   * the safe play — build a little box in the corner, away from everything —
   * would also be the play that keeps the run alive.
   */
  claimRefundNeedsCapture: boolean;
  /** Placing within this window after the last placement earns the full bonus */
  speedWindowSeconds: number;
  /** Slowest placements still earn this fraction of the bonus */
  minSpeedFraction: number;
  /** Drain rate grows by this much per minute played */
  drainAccelPerMinute: number;
  drainCap: number;
  /**
   * Off makes every bonus pay in full however long the player took. The siege
   * clock is a command budget, not a metronome: hurrying is already punished
   * by walking a raider into a wall you had not finished.
   */
  speedScaling: boolean;
}

export interface TerritoryConfig {
  /** Off restores the pre-territory game exactly: no lit floor, no survey */
  enabled: boolean;
  /** What a room built entirely on already-lit floor pays, as a fraction */
  relitFloorFactor: number;
  /** Flat score for lighting all 49 inner cells — multiplied by nothing */
  surveyBonus: number;
  /**
   * Off keeps the freshness pricing but removes the objective: no bonus, no
   * map wipe, no readout. The siege wants relit floor to be worth less; it
   * does not want a second thing to be winning.
   */
  surveyEnabled: boolean;
}

export interface ClockConfig {
  /**
   * Off means the run is not timed at all: `tick` does not drain, `addTime`
   * is a no-op and `timeRemaining` is meaningless. The timer numbers below
   * stay in the config but nothing reads them.
   */
  enabled: boolean;
}

export interface EchoConfig {
  /**
   * Off removes the mechanic completely: no echo walls are recorded, nothing
   * is drawn, and a claim's multiplier stays 1.
   */
  enabled: boolean;
  /** How long a removed fence goes on counting as a wall */
  windowSeconds: number;
  /** What a claim pays when an echo wall bounded any of its rooms */
  multiplier: number;
}

/**
 * How the command clock behaves.
 *
 *  - 'off'                     no clock at all; nothing drains
 *  - 'bank'                    drains whenever the run is running
 *  - 'bankPausedInEnemyPhase'  drains except while the enemy is answering
 *
 * Hold the Keep runs on 'off': the run is eighteen turns long and a turn is a
 * piece, so a second clock would only be a second way to lose. The other two
 * are kept because the flag is what a later test would flip.
 */
export type SiegeClockMode = 'off' | 'bank' | 'bankPausedInEnemyPhase';

/**
 * Hold the Keep. Present only on a siege config, and its presence is what the
 * engine reads to know a siege is being played at all.
 */
export interface SiegeConfig {
  /**
   * Which force is besieging. Only 'raiders' is wired into the turn loop:
   * the tide expands on game time and this siege has no clock. Kept as a flag
   * — with its pathing still in `Siege.ts` — because it is a switch we may
   * want back, not a decision to be deleted.
   */
  enemy: 'raiders' | 'tide';
  /** A fixed supply and a relief turn, or pieces until something ends it */
  mission: 'finite' | 'endless';
  missionId: SiegeMissionId;
  /** Cells on a side */
  boardSize: number;
  /** Rows of strings: '.' floor, 'K' keep, 'G' gate, '#' ruin */
  map: string[];
  /** When raiders arrive, and at which gate */
  spawns: SpawnEvent[];
  /** The run's pieces, in order, identical on every attempt */
  supply: SupplyPiece[];
  /**
   * Turns to hold before relief arrives. Survive this many enemy phases
   * without a breach and the run is won.
   */
  reliefTurns: number;
  /**
   * What entering a player wall costs a raider, in the weighted distance
   * field. Four means a wall is worth about four cells of detour before it
   * gets broken through instead of walked around. The knob the playtest turns
   * first: at 2 a wall barely diverts anything, at 8 it is nearly a fence.
   */
  wallCost: number;
  /** What one captured raider pays */
  enemyBonus: number;
  /** What one held floor cell pays, every enemy phase the run survives */
  groundIncome: number;
  clockMode: SiegeClockMode;
  /**
   * On, a courtyard leaves the player's walls standing — which is now the
   * rule rather than a flag, because walls that vanished on being paid for
   * were the whole reason the siege played as two games at once. Kept so the
   * old behaviour is one boolean away if the playtest asks for it.
   */
  fenceSurvivesEnemyPhase: boolean;
}

export interface GameConfig {
  /**
   * Cells on a side. Nine for Classic, Blitz and the Daily; eleven for the
   * siege, which needs the room. Everything that measures a board — the
   * layout, the renderers, the hints, the drag preview and the replay
   * simulator — reads it from here rather than from the old global constant.
   */
  boardSize: number;
  scoring: ScoringConfig;
  timer: TimerConfig;
  territory: TerritoryConfig;
  clock: ClockConfig;
  echo: EchoConfig;
  /** Set only in the siege; everything siege-specific hangs off it */
  siege?: SiegeConfig;
  /**
   * Whether the bag composition tightens as the player climbs the tiers. Off
   * keeps the base bag for the whole run.
   */
  bagByTier: boolean;
  /** Number of upcoming pieces shown */
  previewCount: number;
  /** Total pieces the run will ever be dealt. Undefined means unlimited. */
  pieceBudget?: number;
  /**
   * Fixed deal seed. Undefined mints a fresh one per run (free play).
   *
   * Live play fills this in from the run ticket the server issues at the
   * start of a run — the seed is the server's choice, not the client's — and
   * the replay simulation fills it in from the log it is re-playing.
   */
  seed?: number;
  /**
   * Which daily this run is dealt from, 'YYYY-MM-DD'. Set from the run
   * ticket so the run belongs to the server's UTC date rather than to the
   * device's idea of it. Undefined falls back to this browser's date.
   */
  dailyDate?: string;
}

const SHARED_SCORING: ScoringConfig = {
  pointsPerBlockPlaced: 1,
  pointsPerAreaSquared: 10,
  multiCloseBonusPerRoom: 0.5,
  streakIncrement: 0.25,
  streakCap: 3,
  streakWindow: 3,
  streakEnabled: true,
};

/** What one captured raider pays. Flat, so it is one number to tune. */
export const SIEGE_ENEMY_BONUS = 75;

/** What one held floor cell pays, every enemy phase the run survives */
export const SIEGE_GROUND_INCOME = 1;

/** What entering a player wall costs a raider. See SiegeConfig.wallCost. */
export const SIEGE_WALL_COST = 4;

/**
 * How long the Keep has to be held. Eighteen turns, which is also exactly the
 * mission's supply: every piece is a turn, so running out of pieces and being
 * relieved are the same moment.
 */
export const SIEGE_RELIEF_TURNS = SIEGE_SUPPLY_SIZE;

/** How many pieces a siege run is dealt, in one authored order */
export const SIEGE_FINITE_PIECES = SIEGE_SUPPLY_SIZE;

/**
 * How far ahead the supply is visible.
 *
 * Four, not two. The supply is authored and identical on every attempt, so
 * what the queue shows is not luck to be hedged against but a plan to be
 * made — and a plan needs more than the next piece.
 */
export const SIEGE_PREVIEW_COUNT = 4;

/** One mission's map, schedule and supply, resolved from the mission table */
function siegeVariant(missionId: SiegeMissionId): SiegeConfig {
  const m: SiegeMission = MISSIONS[missionId];
  return {
    enemy: 'raiders',
    mission: 'finite',
    missionId,
    boardSize: m.size,
    map: m.map,
    spawns: m.spawns,
    supply: m.supply,
    reliefTurns: SIEGE_RELIEF_TURNS,
    wallCost: SIEGE_WALL_COST,
    enemyBonus: SIEGE_ENEMY_BONUS,
    groundIncome: SIEGE_GROUND_INCOME,
    clockMode: 'off',
    fenceSurvivesEnemyPhase: true,
  };
}

export const DIFFICULTY_CONFIGS: Record<Difficulty, GameConfig> = {
  classic: {
    boardSize: GRID_SIZE,
    scoring: SHARED_SCORING,
    // A survey takes far longer than a 35 s Blitz run, so Blitz pays less for
    // one: the reward has to stay in scale with the clock that funds it.
    territory: { enabled: true, relitFloorFactor: 0.5, surveyBonus: 5000, surveyEnabled: true },
    timer: {
      startSeconds: 60,
      maxSeconds: 90,
      placeBonus: 1.8,
      claimBaseBonus: 2.0,
      claimPerCellBonus: 0.8,
      claimPerEnemyBonus: 0,
      claimBonusCap: 16,
      claimRefundNeedsCapture: false,
      speedWindowSeconds: 8,
      minSpeedFraction: 0.45,
      drainAccelPerMinute: 0.16,
      drainCap: 1.7,
      speedScaling: true,
    },
    clock: { enabled: true },
    // Two seconds is about one considered placement: long enough to plan the
    // second room, short enough that it stays a combo and not a safety net.
    echo: { enabled: true, windowSeconds: 2.0, multiplier: 1.25 },
    bagByTier: true,
    previewCount: 2,
  },
  blitz: {
    boardSize: GRID_SIZE,
    scoring: { ...SHARED_SCORING, streakWindow: 2 },
    territory: { enabled: true, relitFloorFactor: 0.5, surveyBonus: 2500, surveyEnabled: true },
    timer: {
      startSeconds: 35,
      maxSeconds: 50,
      placeBonus: 1.2,
      claimBaseBonus: 1.5,
      claimPerCellBonus: 0.6,
      claimPerEnemyBonus: 0,
      claimBonusCap: 10,
      claimRefundNeedsCapture: false,
      speedWindowSeconds: 5,
      minSpeedFraction: 0.3,
      drainAccelPerMinute: 0.3,
      drainCap: 2.0,
      speedScaling: true,
    },
    clock: { enabled: true },
    // Shorter, because everything in Blitz is: the window has to stay inside
    // the rhythm of a 35 s run rather than spanning several placements.
    echo: { enabled: true, windowSeconds: 1.5, multiplier: 1.25 },
    bagByTier: true,
    previewCount: 2,
  },
  // The Rationed Daily: 30 pieces, no clock, the same deal for everyone.
  // Scarcity replaces time as the pressure, so the streak window matches
  // Classic and the survey pays less than Classic's 5,000 — 30 pieces is a
  // short run, and a survey inside one should not dwarf everything else.
  daily: {
    boardSize: GRID_SIZE,
    scoring: SHARED_SCORING,
    territory: { enabled: true, relitFloorFactor: 0.5, surveyBonus: 2000, surveyEnabled: true },
    // Inert: kept so the shape of a GameConfig stays uniform and nothing has
    // to branch on whether a timer block exists.
    timer: {
      startSeconds: 60,
      maxSeconds: 90,
      placeBonus: 0,
      claimBaseBonus: 0,
      claimPerCellBonus: 0,
      claimPerEnemyBonus: 0,
      claimBonusCap: 0,
      claimRefundNeedsCapture: false,
      speedWindowSeconds: 8,
      minSpeedFraction: 1,
      drainAccelPerMinute: 0,
      drainCap: 1,
      speedScaling: true,
    },
    clock: { enabled: false },
    // No clock, so a window measured in seconds would reward whoever happens
    // to play fast — the one thing this mode is not about. And the bag stays
    // the base bag: the daily is only comparable if everyone is dealt from
    // the same mix, whatever score they are on.
    echo: { enabled: false, windowSeconds: 0, multiplier: 1 },
    bagByTier: false,
    previewCount: 2,
    pieceBudget: 30,
  },
  // Hold the Keep. Eighteen turns, an authored supply and one force walking
  // at the Keep — and the one place every meta-system is switched off: no
  // streak, no echo, no survey, no territory, no tier bags, no clock, no
  // points for area. They all modify the efficiency of an action this mode
  // does not have. What is left is capture and ground, which is the game.
  siege: {
    boardSize: SIEGE_GRID_SIZE,
    scoring: {
      ...SHARED_SCORING,
      // Nothing for laying a block, nothing for the area of what you seal:
      // a courtyard is paid for by the turn, in `groundIncome`, so that
      // holding it is the thing being rewarded rather than closing it.
      pointsPerBlockPlaced: 0,
      pointsPerAreaSquared: 0,
      multiCloseBonusPerRoom: 0,
      streakEnabled: false,
    },
    // Off, and nothing reads it: ground pays by the turn, so freshness would
    // be a second, quieter answer to the same question.
    territory: { enabled: false, relitFloorFactor: 0.5, surveyBonus: 0, surveyEnabled: false },
    // Inert: kept so the shape of a GameConfig stays uniform and nothing has
    // to branch on whether a timer block exists.
    timer: {
      startSeconds: 0,
      maxSeconds: 0,
      placeBonus: 0,
      claimBaseBonus: 0,
      claimPerCellBonus: 0,
      claimPerEnemyBonus: 0,
      claimBonusCap: 0,
      claimRefundNeedsCapture: false,
      speedWindowSeconds: 8,
      minSpeedFraction: 1,
      drainAccelPerMinute: 0,
      drainCap: 1,
      speedScaling: false,
    },
    clock: { enabled: false },
    echo: { enabled: false, windowSeconds: 0, multiplier: 1 },
    bagByTier: false,
    previewCount: SIEGE_PREVIEW_COUNT,
    siege: siegeVariant('m1'),
    pieceBudget: SIEGE_FINITE_PIECES,
  },
};

export const DEFAULT_CONFIG = DIFFICULTY_CONFIGS.classic;

/**
 * The config for one siege.
 *
 * `seed` is still accepted and still recorded, because a replay carries one
 * and the colours of the supply are dealt from the palette rather than from
 * it — but no rule reads it: the pieces, their order and the arrivals are all
 * authored, so two attempts at a mission are the same puzzle.
 */
export function siegeConfig(missionId: SiegeMissionId, seed?: number): GameConfig {
  const base = DIFFICULTY_CONFIGS.siege;
  const siege = siegeVariant(missionId);
  return {
    ...base,
    boardSize: siege.boardSize,
    siege,
    clock: { enabled: siege.clockMode !== 'off' },
    pieceBudget: siege.supply.length,
    ...(seed !== undefined ? { seed } : {}),
  };
}
