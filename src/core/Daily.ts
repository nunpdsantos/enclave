import { hashString } from './Random';

/**
 * The Rationed Daily's identity: which day it is, what it deals, and what
 * this browser has already done with it.
 *
 * Everything is UTC. A daily that rolled over at local midnight would deal
 * different pieces to two people playing at the same moment, which is the one
 * thing the mode cannot do.
 *
 * Storage is localStorage and every access is wrapped, because the game has
 * to keep working in private mode and embedded webviews. Losing the "already
 * submitted" flag there only costs the player a re-submission the server
 * will refuse anyway — first submission wins is enforced server-side.
 */

const MS_PER_DAY = 86_400_000;

/** Day one. Daily #1 was 2026-09-01; the number is what players compare. */
export const DAILY_EPOCH = '2026-09-01';

const SUBMITTED_PREFIX = 'enclave_daily_submitted_';
const BEST_PREFIX = 'enclave_daily_best_';

/** 'YYYY-MM-DD' in UTC — the id of today's puzzle. */
export function dailyKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** True for a well-formed, real calendar date in 'YYYY-MM-DD' form. */
export function isDailyKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const d = new Date(`${key}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === key;
}

/** Midnight UTC of a daily key, in ms. NaN for a key that is not a date. */
function keyToMs(key: string): number {
  return Date.parse(`${key}T00:00:00.000Z`);
}

/**
 * The public seed for a date. **Not the deal for shared play.**
 *
 * Anyone can compute this, which is the problem: it means tomorrow's puzzle
 * can be dealt tonight, solved at leisure and posted as a first attempt the
 * moment the day opens. The deal a score can be posted from now comes from
 * the server, as the first 32 bits of an HMAC under its secret, handed out
 * with the run ticket (`Ticket.dailySeedFor`, `api/run-start.ts`).
 *
 * This is kept for the two places where reproducibility matters more than
 * secrecy: the tests, and the offline practice run a browser falls back to
 * when it cannot get a ticket. A run dealt from here has no ticket, so it is
 * never submitted — it is a different puzzle from the one on the board.
 */
export function dailySeed(key: string): number {
  return hashString(`enclave-daily-${key}`);
}

/** Days since the epoch, plus one — so 2026-09-09 is Daily #9. */
export function dailyNumber(key: string): number {
  return Math.round((keyToMs(key) - keyToMs(DAILY_EPOCH)) / MS_PER_DAY) + 1;
}

/** Milliseconds until the next UTC midnight, when the puzzle changes. */
export function msUntilNextDaily(now: Date = new Date()): number {
  const t = now.getTime();
  return MS_PER_DAY - ((t % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
}

/** 'HH:MM', for the RESETS IN readout. Hours are not capped at 24 by design. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// ── Per-day local state ──

export function hasSubmittedDaily(key: string): boolean {
  try {
    return localStorage.getItem(SUBMITTED_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

export function markDailySubmitted(key: string): void {
  try {
    localStorage.setItem(SUBMITTED_PREFIX + key, '1');
  } catch { /* storage unavailable */ }
}

/** Best score on that specific day — a daily best is not a lifetime best. */
export function getDailyBest(key: string): number {
  try {
    const raw = localStorage.getItem(BEST_PREFIX + key);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Store a new best for that day if it beats the stored one. */
export function recordDailyBest(key: string, score: number): boolean {
  if (score <= getDailyBest(key)) return false;
  try {
    localStorage.setItem(BEST_PREFIX + key, String(Math.floor(score)));
  } catch { /* storage unavailable */ }
  return true;
}
