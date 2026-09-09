import {
  MISSIONS, SiegeMission, SiegeMissionId, SpawnEvent, buildSpawnSchedule, finiteSpawnHorizon,
} from './Missions';

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
 * Hold the Keep. Present only on a siege config, and its presence is what the
 * engine reads to know a siege is being played at all.
 */
/**
 * How the command clock behaves.
 *
 *  - 'off'                     no clock at all; nothing drains
 *  - 'bank'                    drains whenever the run is running
 *  - 'bankPausedInEnemyPhase'  drains except while the enemy is answering
 *
 * Game time is *not* the bank: the tide runs on game time and keeps running
 * through the pause, which is why the two are different words here.
 */
export type SiegeClockMode = 'off' | 'bank' | 'bankPausedInEnemyPhase';

/**
 * How a capture is paid.
 *
 *  - 'flat'     area² × 10 for the room, plus `enemyBonus` per unit caught
 *  - 'squared'  (area + captured)² × 10 and no flat bonus, so a capture is
 *               worth more inside a big room than a small one
 */
export type SiegeCaptureScoring = 'flat' | 'squared';

export interface SiegeConfig {
  /** Which enemy is besieging: discrete raiders, or a spreading tide */
  enemy: 'raiders' | 'tide';
  /** 18 fixed pieces and a win state, or pieces until something ends it */
  mission: 'finite' | 'endless';
  missionId: SiegeMissionId;
  /** Rows of strings: '.' floor, 'K' keep, 'G' gate, '#' ruin */
  map: string[];
  /** When raiders arrive, and at which gate */
  spawns: SpawnEvent[];
  /**
   * What entering a player wall costs the enemy, in the weighted distance
   * field. Four means a wall is worth about four cells of detour before it
   * gets broken through instead of walked around. The knob the playtest turns
   * first: at 2 a wall barely diverts anything, at 8 it is nearly a fence.
   */
  wallCost: number;
  /** What one captured enemy pays, flat and outside every multiplier */
  enemyBonus: number;
  /** How a capture is paid. See SiegeCaptureScoring. */
  captureScoring: SiegeCaptureScoring;
  clockMode: SiegeClockMode;
  /**
   * On, a claim leaves the player's fence standing — the "gatehouse" question
   * from the direction document. Off (the default) is total removal, which is
   * what makes a claim a sacrifice rather than pure upside.
   */
  fenceSurvivesEnemyPhase: boolean;
  /** Seconds between the tide's first expansions */
  tideSeconds: number;
  /**
   * Seconds a finite tide mission must be survived before its pieces can win
   * it. Zero for the raiders, whose pace is the placement.
   */
  tideMinSurvivalSeconds: number;
  /** Each expansion comes this much sooner than the last... */
  tideRampPerTick: number;
  /** ...down to here, and no faster */
  tideMinSeconds: number;
}

export interface GameConfig {
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

/** What one captured enemy pays. Flat, so it is one number to tune. */
export const SIEGE_ENEMY_BONUS = 75;

/** What entering a player wall costs the enemy. See SiegeConfig.wallCost. */
export const SIEGE_WALL_COST = 4;

/** The command clock: it starts here and it caps here */
export const SIEGE_CLOCK_SECONDS = 40;

/** A finite mission is exactly this many pieces */
export const SIEGE_FINITE_PIECES = 18;

/** The tide's tempo tightens by this much per expansion, down to the floor */
const TIDE_RAMP_PER_TICK = 0.05;
const TIDE_MIN_SECONDS = 1.2;

/** One variant's map and schedule, resolved from the mission table */
function siegeVariant(
  missionId: SiegeMissionId,
  enemy: 'raiders' | 'tide',
  mission: 'finite' | 'endless',
): SiegeConfig {
  const m: SiegeMission = MISSIONS[missionId];
  const endless = mission === 'endless';
  return {
    enemy,
    mission,
    missionId,
    map: m.map,
    wallCost: SIEGE_WALL_COST,
    enemyBonus: SIEGE_ENEMY_BONUS,
    captureScoring: 'flat',
    clockMode: 'bankPausedInEnemyPhase',
    fenceSurvivesEnemyPhase: false,
    spawns: buildSpawnSchedule(m, endless, endless ? Infinity : finiteSpawnHorizon(m)),
    tideSeconds: m.tideSeconds,
    tideRampPerTick: TIDE_RAMP_PER_TICK,
    tideMinSeconds: TIDE_MIN_SECONDS,
    // Only the tide can be outrun by dumping pieces, so only the tide has a
    // survival floor to meet before eighteen placements are a win
    tideMinSurvivalSeconds: enemy === 'tide' ? m.minSurvivalSeconds : 0,
  };
}

export const DIFFICULTY_CONFIGS: Record<Difficulty, GameConfig> = {
  classic: {
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
  // Hold the Keep. The base config the four variants are cut from — the map,
  // the enemy and the goal are filled in by `siegeConfig` — and the one place
  // the meta-systems are switched off: no streak, no echo, no survey, no tier
  // bags, no speed scaling. They all modify the efficiency of the same action,
  // and the point of this prototype is to find out whether the *action* is
  // worth doing while something is walking at your Keep.
  siege: {
    scoring: {
      ...SHARED_SCORING,
      // Nothing for laying a block: the siege has to make a claim the reward
      // and a wall the cost, not pay a little for every move either way.
      pointsPerBlockPlaced: 0,
      // Nor for closing two rooms at once: a multiplier on top of area² is a
      // second thing to optimise, and the siege already has one.
      multiCloseBonusPerRoom: 0,
      streakEnabled: false,
    },
    // Off for now. Freshness pricing is a real answer to camping one small
    // room round the Keep, but it is a second pressure on top of a new one,
    // and the first playtest has to be able to say what the siege alone does.
    // The flag is the whole switch — turn it on and relit floor pays half.
    territory: { enabled: false, relitFloorFactor: 0.5, surveyBonus: 0, surveyEnabled: false },
    timer: {
      // A command clock, not a metronome: it starts full, caps where it
      // starts, drains at a flat rate, and only a claim refills it.
      startSeconds: SIEGE_CLOCK_SECONDS,
      maxSeconds: SIEGE_CLOCK_SECONDS,
      placeBonus: 0,
      claimBaseBonus: 1,
      claimPerCellBonus: 0.6,
      claimPerEnemyBonus: 1.5,
      claimBonusCap: 8,
      claimRefundNeedsCapture: true,
      speedWindowSeconds: 8,
      minSpeedFraction: 1,
      drainAccelPerMinute: 0,
      drainCap: 1,
      speedScaling: false,
    },
    clock: { enabled: true },
    echo: { enabled: false, windowSeconds: 0, multiplier: 1 },
    bagByTier: false,
    // `queuePreview` in the playtest notes: how many pieces ahead the player
    // can plan. Two today, worth trying at four once the siege is legible.
    previewCount: 2,
    siege: siegeVariant('m1', 'raiders', 'finite'),
    pieceBudget: SIEGE_FINITE_PIECES,
  },
};

export const DEFAULT_CONFIG = DIFFICULTY_CONFIGS.classic;

/**
 * The config for one of the four sieges.
 *
 * The 2×2 is deliberately a config switch and not four code paths: a playtest
 * that cannot flip enemy and goal independently cannot tell which of the two
 * is doing the work.
 */
export function siegeConfig(
  missionId: SiegeMissionId,
  enemy: 'raiders' | 'tide',
  mission: 'finite' | 'endless',
  seed?: number,
): GameConfig {
  const base = DIFFICULTY_CONFIGS.siege;
  const finite = mission === 'finite';
  const siege = siegeVariant(missionId, enemy, mission);
  return {
    ...base,
    siege,
    // 'off' is the one clock mode the engine itself has to know about; the
    // other two differ only in whether the scene pauses the drain
    clock: { enabled: siege.clockMode !== 'off' },
    // Eighteen pieces and a win, or a bag that never runs out
    ...(finite ? { pieceBudget: SIEGE_FINITE_PIECES } : { pieceBudget: undefined }),
    ...(seed !== undefined ? { seed } : {}),
  };
}
