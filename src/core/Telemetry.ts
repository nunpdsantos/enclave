import { RunSummary } from './types';
import { Difficulty } from './Config';
import { getProgressStatus } from './Progression';
import { loadSettings } from './Settings';
import { getStoredPlayerId } from './Leaderboard';

/**
 * Anonymous end-of-run stats.
 *
 * The point is to tune the clock on numbers instead of feel: how long runs
 * actually last, what kills them, which room sizes players really build. It
 * mints no identifier of its own — the only id sent is the leaderboard's, and
 * only if the player already has one — and it is fire-and-forget, so a failing
 * or blocked endpoint can never delay the game-over screen.
 */

const API_URL = '/api/runs';

/** Mirrors the body `api/runs.ts` validates. Keep the two in step. */
export interface RunReport {
  v: string;
  mode: Difficulty;
  durationS: number;
  endCause: string;
  score: number;
  rooms: number;
  biggest: number;
  maxStreak: number;
  holds: number;
  placements: number;
  surveys: number;
  /** Inner cells still lit at the end, which says how far into a survey the run got */
  litCells: number;
  tier: string;
  roomSizes: Record<string, number>;
  pid?: string;
}

/** One decimal is plenty for a duration, and keeps the payload small. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function buildRunReport(summary: RunSummary): RunReport {
  const roomSizes: Record<string, number> = {};
  for (const [area, count] of Object.entries(summary.roomSizes)) {
    roomSizes[area] = count;
  }

  const report: RunReport = {
    v: __APP_VERSION__,
    mode: summary.difficulty,
    durationS: round1(summary.gameElapsed),
    endCause: summary.endCause,
    score: Math.round(summary.score),
    rooms: summary.roomsClaimed,
    biggest: summary.biggestRoom,
    maxStreak: summary.maxStreak,
    holds: summary.holds,
    placements: summary.totalTurns,
    surveys: summary.surveys,
    litCells: summary.litCells,
    tier: getProgressStatus(summary.difficulty, summary.score).current.label,
    roomSizes,
  };

  const pid = getStoredPlayerId();
  if (pid) report.pid = pid;

  return report;
}

/**
 * Report one finished run. Never throws, never awaits anything the caller
 * depends on. Call exactly once per run — GameScene guards that.
 */
export function reportRun(summary: RunSummary): void {
  try {
    if (!loadSettings().telemetry) return;

    const body = JSON.stringify(buildRunReport(summary));

    // sendBeacon survives the page going away, which matters on mobile where
    // the player may close the tab straight off the game-over screen.
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(API_URL, blob)) return;
    }

    void fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => { /* telemetry is best-effort */ });
  } catch {
    /* never let measurement break the game */
  }
}
