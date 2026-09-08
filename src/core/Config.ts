export type Difficulty = 'classic' | 'blitz';

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  classic: 'CLASSIC',
  blitz: 'BLITZ',
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

export interface GameConfig {
  scoring: ScoringConfig;
  timer: TimerConfig;
  /** Number of upcoming pieces shown */
  previewCount: number;
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
    previewCount: 2,
  },
  blitz: {
    scoring: { ...SHARED_SCORING, streakWindow: 2 },
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
    previewCount: 2,
  },
};

export const DEFAULT_CONFIG = DIFFICULTY_CONFIGS.classic;
