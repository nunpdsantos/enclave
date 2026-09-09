export type Difficulty = 'classic' | 'blitz' | 'daily';

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  classic: 'CLASSIC',
  blitz: 'BLITZ',
  daily: 'DAILY',
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
}

export interface TimerConfig {
  startSeconds: number;
  maxSeconds: number;
  /** Time added per placement (scaled by speed) */
  placeBonus: number;
  /** Time added per claim: base + perCell × area, capped */
  claimBaseBonus: number;
  claimPerCellBonus: number;
  claimBonusCap: number;
  /** Placing within this window after the last placement earns the full bonus */
  speedWindowSeconds: number;
  /** Slowest placements still earn this fraction of the bonus */
  minSpeedFraction: number;
  /** Drain rate grows by this much per minute played */
  drainAccelPerMinute: number;
  drainCap: number;
}

export interface TerritoryConfig {
  /** Off restores the pre-territory game exactly: no lit floor, no survey */
  enabled: boolean;
  /** What a room built entirely on already-lit floor pays, as a fraction */
  relitFloorFactor: number;
  /** Flat score for lighting all 49 inner cells — multiplied by nothing */
  surveyBonus: number;
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

export interface GameConfig {
  scoring: ScoringConfig;
  timer: TimerConfig;
  territory: TerritoryConfig;
  clock: ClockConfig;
  echo: EchoConfig;
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
};

export const DIFFICULTY_CONFIGS: Record<Difficulty, GameConfig> = {
  classic: {
    scoring: SHARED_SCORING,
    // A survey takes far longer than a 35 s Blitz run, so Blitz pays less for
    // one: the reward has to stay in scale with the clock that funds it.
    territory: { enabled: true, relitFloorFactor: 0.5, surveyBonus: 5000 },
    timer: {
      startSeconds: 60,
      maxSeconds: 90,
      placeBonus: 1.8,
      claimBaseBonus: 2.0,
      claimPerCellBonus: 0.8,
      claimBonusCap: 16,
      speedWindowSeconds: 8,
      minSpeedFraction: 0.45,
      drainAccelPerMinute: 0.16,
      drainCap: 1.7,
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
    territory: { enabled: true, relitFloorFactor: 0.5, surveyBonus: 2500 },
    timer: {
      startSeconds: 35,
      maxSeconds: 50,
      placeBonus: 1.2,
      claimBaseBonus: 1.5,
      claimPerCellBonus: 0.6,
      claimBonusCap: 10,
      speedWindowSeconds: 5,
      minSpeedFraction: 0.3,
      drainAccelPerMinute: 0.3,
      drainCap: 2.0,
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
    territory: { enabled: true, relitFloorFactor: 0.5, surveyBonus: 2000 },
    // Inert: kept so the shape of a GameConfig stays uniform and nothing has
    // to branch on whether a timer block exists.
    timer: {
      startSeconds: 60,
      maxSeconds: 90,
      placeBonus: 0,
      claimBaseBonus: 0,
      claimPerCellBonus: 0,
      claimBonusCap: 0,
      speedWindowSeconds: 8,
      minSpeedFraction: 1,
      drainAccelPerMinute: 0,
      drainCap: 1,
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
};

export const DEFAULT_CONFIG = DIFFICULTY_CONFIGS.classic;
