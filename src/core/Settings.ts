import { Difficulty } from './Config';

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

const DEFAULT_SETTINGS: GameSettings = {
  sfx: true,
  music: true,
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
  cached = loaded;
  return loaded;
}

export function updateSettings(partial: Partial<GameSettings>): GameSettings {
  const next = { ...loadSettings(), ...partial };
  cached = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch { /* storage unavailable */ }
  return next;
}

export function getPersonalBest(difficulty: Difficulty): number {
  try {
    const raw = localStorage.getItem(bestKey(difficulty));
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Store a new personal best if it beats the stored one. Returns true if it did. */
export function recordPersonalBest(difficulty: Difficulty, score: number): boolean {
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
