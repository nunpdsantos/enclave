import { Difficulty } from './Config';
import { dailyKey, getDailyBest, recordDailyBest } from './Daily';

/**
 * Persisted player preferences and personal bests.
 *
 * Everything lives in localStorage and is wrapped in try/catch because
 * storage can be unavailable (private mode, embedded webviews, quota).
 * Nothing here is sensitive — it's only local convenience state.
 */

/** How much motion the player wants. 'system' follows prefers-reduced-motion. */
export type MotionSetting = 'full' | 'reduced' | 'system';

/** Which eight-colour piece palette is in use */
export type PaletteSetting = 'standard' | 'highContrast';

export interface GameSettings {
  /** Sound effects on/off */
  sfx: boolean;
  /** Background music on/off */
  music: boolean;
  /** Sound-effect level, 0–1. The bus applies it through a perceptual curve. */
  sfxVolume: number;
  /** Music level, 0–1 */
  musicVolume: number;
  /** Vibration feedback on supported devices */
  haptics: boolean;
  /** Whether the first-run tutorial has been dismissed */
  tutorialSeen: boolean;
  /** Send anonymous end-of-run stats. On by default; no UI toggle yet. */
  telemetry: boolean;
  /** Screen shake, flashes, zoom pulses and slow-motion */
  motion: MotionSetting;
  /** High contrast swaps in a palette that survives colour-vision deficiency */
  palette: PaletteSetting;
  /** Mirror the HOLD slot and NEXT column for left-thumb play */
  leftHanded: boolean;
}

const SETTINGS_KEY = 'enclave_settings_v1';

/**
 * The default slider positions. They are not 1: the mix the game shipped with
 * is the middle of the knob, so a player who wants it louder has somewhere to
 * go. AudioManager scales its buses so these two reproduce that mix exactly.
 */
export const DEFAULT_SFX_VOLUME = 0.8;
export const DEFAULT_MUSIC_VOLUME = 0.7;

const DEFAULT_SETTINGS: GameSettings = {
  sfx: true,
  music: true,
  sfxVolume: DEFAULT_SFX_VOLUME,
  musicVolume: DEFAULT_MUSIC_VOLUME,
  haptics: true,
  tutorialSeen: false,
  telemetry: true,
  motion: 'system',
  palette: 'standard',
  leftHanded: false,
};

function bestKey(difficulty: Difficulty): string {
  return `enclave_${difficulty}_personal_best`;
}

function gamesKey(difficulty: Difficulty): string {
  return `enclave_${difficulty}_games_played`;
}

let cached: GameSettings | null = null;

/** Stored volumes go straight into a gain node, so a bad one must not survive */
function clampVolume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function sanitise(settings: GameSettings): GameSettings {
  settings.sfxVolume = clampVolume(settings.sfxVolume, DEFAULT_SFX_VOLUME);
  settings.musicVolume = clampVolume(settings.musicVolume, DEFAULT_MUSIC_VOLUME);
  return settings;
}

export function loadSettings(): GameSettings {
  if (cached) return cached;
  let loaded: GameSettings = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GameSettings>;
      loaded = { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch { /* storage unavailable */ }
  cached = sanitise(loaded);
  return cached;
}

export function updateSettings(partial: Partial<GameSettings>): GameSettings {
  const next = sanitise({ ...loadSettings(), ...partial });
  cached = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch { /* storage unavailable */ }
  return next;
}

/**
 * The best worth beating.
 *
 * For the daily that is the best on *that date*, not a lifetime figure: every
 * day is a different puzzle, so a lifetime daily best would only ever say
 * "you once had a good seed". `dailyDate` defaults to today.
 */
export function getPersonalBest(difficulty: Difficulty, dailyDate: string = dailyKey()): number {
  if (difficulty === 'daily') return getDailyBest(dailyDate);
  try {
    const raw = localStorage.getItem(bestKey(difficulty));
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Store a new personal best if it beats the stored one. Returns true if it did. */
export function recordPersonalBest(
  difficulty: Difficulty, score: number, dailyDate: string = dailyKey(),
): boolean {
  if (difficulty === 'daily') return recordDailyBest(dailyDate, score);
  const current = getPersonalBest(difficulty);
  if (score <= current) return false;
  try {
    localStorage.setItem(bestKey(difficulty), String(Math.floor(score)));
  } catch { /* storage unavailable */ }
  return true;
}

export function getGamesPlayed(difficulty: Difficulty): number {
  try {
    const raw = localStorage.getItem(gamesKey(difficulty));
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function incrementGamesPlayed(difficulty: Difficulty): number {
  const next = getGamesPlayed(difficulty) + 1;
  try {
    localStorage.setItem(gamesKey(difficulty), String(next));
  } catch { /* storage unavailable */ }
  return next;
}
