import { Difficulty } from './Config';
import { dailyKey } from './Daily';
import { Replay } from './types';

const NAME_KEY = 'enclave_lastname';
const PLAYER_ID_KEY = 'enclave_playerid';
const MAX_ENTRIES = 10;
const API_URL = '/api/leaderboard';
const RUN_START_URL = '/api/run-start';

/**
 * How long a run waits for its ticket before starting without one.
 *
 * The ticket has to be in hand before the first piece is dealt — it carries
 * the seed — so this is time the player spends looking at nothing. Two and a
 * half seconds is past any healthy request and short enough that a dead
 * network costs a pause rather than a hang; the run then plays as practice.
 */
const TICKET_TIMEOUT_MS = 2500;

/**
 * What the server calls this board. Every daily date is its own board, so the
 * id carries the date: 'daily-2026-09-09'. Classic and Blitz are unchanged.
 */
function boardId(difficulty: Difficulty, dailyDate: string): string {
  return difficulty === 'daily' ? `daily-${dailyDate}` : difficulty;
}

function storageKey(board: string): string {
  return `enclave_${board}_top10`;
}

/**
 * The `reason` field of a 400, when the body has one. A refusal with no
 * readable body is still a refusal — the caller only loses the detail.
 */
async function refusalReason(res: Response): Promise<string | undefined> {
  try {
    const data = await res.json();
    return typeof data?.reason === 'string' ? data.reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The anonymous id already stored for this browser, or null.
 *
 * Read-only on purpose: telemetry must never be the thing that mints an id,
 * so a player who has never started a run stays unidentified.
 */
export function getStoredPlayerId(): string | null {
  try {
    return localStorage.getItem(PLAYER_ID_KEY);
  } catch {
    return null;
  }
}

/**
 * This browser's anonymous id, minted on first use.
 *
 * Cached in the module as well as in storage, because a run ticket is signed
 * against the id that asked for it: a browser with storage blocked would
 * otherwise mint a different id at the start of the run and at the end of it,
 * and the server would rightly refuse the submission.
 */
let cachedPlayerId: string | null = null;

export function playerId(): string {
  if (cachedPlayerId !== null) return cachedPlayerId;
  try {
    const stored = localStorage.getItem(PLAYER_ID_KEY);
    if (stored) {
      cachedPlayerId = stored;
      return stored;
    }
  } catch { /* storage unavailable */ }
  const minted = crypto.randomUUID();
  cachedPlayerId = minted;
  try { localStorage.setItem(PLAYER_ID_KEY, minted); } catch { /* */ }
  return minted;
}

/** The deal a run is to be played from, and the ticket that vouches for it. */
export interface RunTicket {
  seed: number;
  /** Opaque; carried to the game-over screen and posted back with the score. */
  token: string;
  /** The server's UTC date, on a daily ticket */
  dailyKey?: string;
}

/**
 * Ask the server to start a run: it picks the deal and signs a ticket for it.
 *
 * Null means the run is unverifiable before it has begun — offline, the API
 * down, a request that took too long. That is not a failure the player can
 * do anything about, so the run simply starts on a local seed and is kept
 * local at the end of it, rather than being played and then refused.
 */
export async function requestRunTicket(mode: Difficulty): Promise<RunTicket | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TICKET_TIMEOUT_MS);
  try {
    const res = await fetch(RUN_START_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: playerId(), mode }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.token !== 'string' || typeof data?.seed !== 'number') return null;
    if (!Number.isInteger(data.seed) || data.seed < 0 || data.seed > 0xffffffff) return null;
    return {
      seed: data.seed,
      token: data.token,
      ...(typeof data.dailyKey === 'string' ? { dailyKey: data.dailyKey } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface LeaderboardEntry {
  name: string;
  score: number;
  date: string;
  /**
   * This row is the asking player's, as decided by the server against the id
   * the request carried. The id itself no longer comes back — a board that
   * published one per row published the identity every score is posted
   * under, and this flag is the only thing the client ever read it for.
   */
  mine?: boolean;
}

/** One row of a server response, defensively. */
function toEntry(raw: unknown): LeaderboardEntry {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    name: typeof e.name === 'string' && e.name ? e.name : 'Player',
    score: typeof e.score === 'number' ? e.score : 0,
    date: typeof e.date === 'string' ? e.date : '',
    ...(e.mine === true ? { mine: true as const } : {}),
  };
}

/**
 * What became of a submission.
 *
 * `verified` is the only honest signal the screen has: the server re-played
 * the run and the score stood. Anything else — a refusal, a blocked request,
 * a device offline — leaves the score in the local board only, and the screen
 * says so rather than implying it went out to the world.
 */
export interface SubmitResult {
  rank: number | null;
  verified: boolean;
  /**
   * The server's reason, when it gave one. 'rules' means this build is
   * stale; 'unticketed' is the client's own, for a run that never got a
   * ticket and so was never sent.
   */
  reason?: string;
}

export class Leaderboard {
  private entries: LeaderboardEntry[] = [];
  private fetchPromise: Promise<void> | null = null;
  private difficulty: Difficulty;
  /** Which day's daily board this is. Ignored outside the daily. */
  private dailyDate: string;

  constructor(difficulty: Difficulty = 'classic', dailyDate: string = dailyKey()) {
    this.difficulty = difficulty;
    this.dailyDate = dailyDate;
    this.loadLocal();
    this.fetchPromise = this.fetchRemote();
  }

  getDifficulty(): Difficulty {
    return this.difficulty;
  }

  /** The server's name for the board currently loaded */
  getBoardId(): string {
    return boardId(this.difficulty, this.dailyDate);
  }

  /**
   * Switch boards. The daily takes a date as well, because a run that started
   * before UTC midnight still belongs to the day it was dealt from.
   */
  async switchDifficulty(difficulty: Difficulty, dailyDate: string = dailyKey()): Promise<void> {
    if (boardId(difficulty, dailyDate) === this.getBoardId()) return;
    this.difficulty = difficulty;
    this.dailyDate = dailyDate;
    this.loadLocal();
    this.fetchPromise = this.fetchRemote();
    await this.fetchPromise;
  }

  getEntries(): LeaderboardEntry[] {
    return this.entries;
  }

  async waitForRemote(): Promise<void> {
    if (this.fetchPromise) await this.fetchPromise;
  }

  getTopScore(): number {
    return this.entries.length > 0 ? this.entries[0].score : 0;
  }

  getLastName(): string {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
  }

  saveLastName(name: string): void {
    try { localStorage.setItem(NAME_KEY, name); } catch { /* */ }
  }

  /**
   * Post a score with the replay that proves it and the ticket that says it
   * was played.
   *
   * Neither is optional. A run that never got a ticket cannot be posted at
   * all — the server would refuse it, and asking it to is a round trip spent
   * to be told what this client already knows — so the score goes to the
   * local board and the screen says it stayed there.
   */
  async submit(
    score: number, name: string, replay: Replay, token: string | null,
  ): Promise<SubmitResult> {
    if (score <= 0) return { rank: null, verified: false };
    const cleanName = name.trim() || 'Player';
    this.saveLastName(cleanName);
    if (!token) {
      return { rank: this.submitLocal(score, cleanName), verified: false, reason: 'unticketed' };
    }

    try {
      const res = await fetch(`${API_URL}?difficulty=${this.getBoardId()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: playerId(),
          name: cleanName,
          score,
          replay,
          token,
        }),
      });

      // A refusal is an answer, not a failure: the score stays in the local
      // board, and the reason is what the screen tells the player.
      if (res.status === 400) {
        return {
          rank: this.submitLocal(score, cleanName),
          verified: false,
          reason: await refusalReason(res),
        };
      }
      if (!res.ok) throw new Error('API error');
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) throw new Error('Not JSON');

      const data = await res.json();
      if (data.entries && Array.isArray(data.entries)) {
        this.entries = data.entries.map(toEntry);
        this.saveLocal();
      }
      return { rank: data.rank || null, verified: true };
    } catch {
      return { rank: this.submitLocal(score, cleanName), verified: false };
    }
  }

  wouldRank(score: number): boolean {
    if (score <= 0) return false;
    // Which row is the player's is the server's answer, not a comparison of
    // ids the client is no longer given.
    const existingIdx = this.entries.findIndex(e => e.mine);

    if (existingIdx >= 0) {
      // On a daily board the first submission is the one that counts, so a
      // second run cannot rank however good it was
      if (this.difficulty === 'daily') return false;
      // Player already on board — server rejects scores <= existing
      if (score <= this.entries[existingIdx].score) return false;
      // Beating own score replaces the entry — always ranks
      return true;
    }

    // No existing entry — standard check
    if (this.entries.length < MAX_ENTRIES) return true;
    return score > this.entries[this.entries.length - 1].score;
  }

  private async fetchRemote(): Promise<void> {
    try {
      // The id goes out so the server can mark the player's own row, and it
      // is only ever the one this browser already has: reading a board must
      // not be what gives an anonymous visitor an identity.
      const stored = getStoredPlayerId();
      const url = `${API_URL}?difficulty=${this.getBoardId()}`
        + (stored ? `&id=${encodeURIComponent(stored)}` : '');
      const res = await fetch(url);
      if (!res.ok) throw new Error('API error');
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) throw new Error('Not JSON');
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Invalid data');
      this.entries = data.map(toEntry);
      this.saveLocal();
    } catch {
      // Offline or invalid response — keep local data
    }
    this.fetchPromise = null;
  }

  private submitLocal(score: number, name: string): number | null {
    const entry: LeaderboardEntry = { name, score, date: new Date().toISOString(), mine: true };

    let rank = this.entries.findIndex(e => score > e.score);
    if (rank === -1) rank = this.entries.length;
    if (rank >= MAX_ENTRIES) return null;

    this.entries.splice(rank, 0, entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.saveLocal();
    return rank + 1;
  }

  private loadLocal(): void {
    try {
      const raw = localStorage.getItem(storageKey(this.getBoardId()));
      if (raw) {
        this.entries = JSON.parse(raw);
      } else {
        this.entries = [];
      }
    } catch {
      this.entries = [];
    }
  }

  private saveLocal(): void {
    try {
      localStorage.setItem(storageKey(this.getBoardId()), JSON.stringify(this.entries));
    } catch { /* */ }
  }
}
