import { Difficulty } from './Config';
import { RunSummary } from './types';

/**
 * Lifetime stats, one record per mode.
 *
 * A personal best answers "did I beat myself today". This answers "what have
 * I actually done in here": how many runs, how much time, and which rooms the
 * player really builds when nobody is watching a single score.
 *
 * Every run folds in exactly once, quits included, so the counts match what
 * was played rather than what finished well. Storage is localStorage and is
 * wrapped like everything in Settings, because it can simply be unavailable.
 */

export interface LifetimeStats {
  runs: number;
  bestScore: number;
  biggestRoom: number;
  /** Rooms sealed across every run */
  roomsTotal: number;
  surveysTotal: number;
  /** Room area → how many rooms of that area have ever been sealed */
  roomSizes: Record<number, number>;
  playSeconds: number;
  /** ISO timestamp of the last run in this mode; '' before the first */
  lastPlayed: string;
}

const STATS_PREFIX = 'enclave_stats_';

export function emptyStats(): LifetimeStats {
  return {
    runs: 0,
    bestScore: 0,
    biggestRoom: 0,
    roomsTotal: 0,
    surveysTotal: 0,
    roomSizes: {},
    playSeconds: 0,
    lastPlayed: '',
  };
}

/** Add one finished run. Pure: the clock is an argument so a test can fix it. */
export function foldRun(stats: LifetimeStats, summary: RunSummary, now: Date = new Date()): LifetimeStats {
  const roomSizes: Record<number, number> = { ...stats.roomSizes };
  for (const [area, count] of Object.entries(summary.roomSizes)) {
    const size = Number(area);
    roomSizes[size] = (roomSizes[size] ?? 0) + count;
  }
  return {
    runs: stats.runs + 1,
    bestScore: Math.max(stats.bestScore, Math.floor(summary.score)),
    biggestRoom: Math.max(stats.biggestRoom, summary.biggestRoom),
    roomsTotal: stats.roomsTotal + summary.roomsClaimed,
    surveysTotal: stats.surveysTotal + summary.surveys,
    roomSizes,
    playSeconds: stats.playSeconds + summary.gameElapsed,
    lastPlayed: now.toISOString(),
  };
}

// ── Derived readouts ──

/**
 * The room size the player builds most often, 0 when they have built none.
 * A tie goes to the bigger room: it is the more telling half of the answer.
 */
export function mostCommonRoomSize(stats: LifetimeStats): number {
  let best = 0;
  let bestCount = 0;
  for (const [area, count] of Object.entries(stats.roomSizes)) {
    const size = Number(area);
    if (!Number.isFinite(size) || count <= 0) continue;
    if (count > bestCount || (count === bestCount && size > best)) {
      best = size;
      bestCount = count;
    }
  }
  return best;
}

/** '3×3' for a room that is square, '6 cells' for one that is not */
export function formatRoomSize(area: number): string {
  if (area <= 0) return '—';
  const side = Math.round(Math.sqrt(area));
  return side * side === area ? `${side}×${side}` : `${area} cells`;
}

/** 'h:mm' — the scale a lifetime is measured on, not a single run's seconds */
export function formatPlayTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

// ── Storage ──

function statsKey(difficulty: Difficulty): string {
  return `${STATS_PREFIX}${difficulty}`;
}

/** A stored number, or 0 for anything that is not one */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function histogram(value: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  // An array would read as a histogram keyed by its indices, which it is not
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [area, n] of Object.entries(value as Record<string, unknown>)) {
    const size = Number(area);
    const c = count(n);
    if (Number.isFinite(size) && size > 0 && c > 0) out[size] = c;
  }
  return out;
}

export function loadStats(difficulty: Difficulty): LifetimeStats {
  try {
    const raw = localStorage.getItem(statsKey(difficulty));
    if (!raw) return emptyStats();
    // Read field by field rather than spreading: this blob may have been
    // written by an older build, or by nothing at all.
    const parsed = JSON.parse(raw) as Partial<LifetimeStats>;
    return {
      runs: count(parsed.runs),
      bestScore: count(parsed.bestScore),
      biggestRoom: count(parsed.biggestRoom),
      roomsTotal: count(parsed.roomsTotal),
      surveysTotal: count(parsed.surveysTotal),
      roomSizes: histogram(parsed.roomSizes),
      playSeconds: count(parsed.playSeconds),
      lastPlayed: typeof parsed.lastPlayed === 'string' ? parsed.lastPlayed : '',
    };
  } catch {
    return emptyStats();
  }
}

export function saveStats(difficulty: Difficulty, stats: LifetimeStats): void {
  try {
    localStorage.setItem(statsKey(difficulty), JSON.stringify(stats));
  } catch { /* storage unavailable */ }
}
