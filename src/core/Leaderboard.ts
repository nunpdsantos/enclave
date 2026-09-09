import { Difficulty } from './Config';
import { dailyKey } from './Daily';

const NAME_KEY = 'enclave_lastname';
const PLAYER_ID_KEY = 'enclave_playerid';
const MAX_ENTRIES = 10;
const API_URL = '/api/leaderboard';

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
 * The anonymous id already stored for this browser, or null.
 *
 * Read-only on purpose: telemetry must never be the thing that mints an id,
 * so a player who has never submitted a score stays unidentified.
 */
export function getStoredPlayerId(): string | null {
  try {
    return localStorage.getItem(PLAYER_ID_KEY);
  } catch {
    return null;
  }
}

export interface LeaderboardEntry {
  id?: string;
  name: string;
  score: number;
  date: string;
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

  private getPlayerId(): string {
    try {
      let id = localStorage.getItem(PLAYER_ID_KEY);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(PLAYER_ID_KEY, id);
      }
      return id;
    } catch {
      return crypto.randomUUID();
    }
  }

  async submit(score: number, name: string): Promise<number | null> {
    if (score <= 0) return null;
    const cleanName = name.trim() || 'Player';
    this.saveLastName(cleanName);

    try {
      const res = await fetch(`${API_URL}?difficulty=${this.getBoardId()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: this.getPlayerId(),
          name: cleanName,
          score,
        }),
      });

      if (!res.ok) throw new Error('API error');
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) throw new Error('Not JSON');

      const data = await res.json();
      if (data.entries && Array.isArray(data.entries)) {
        this.entries = data.entries.map((e: Record<string, unknown>) => ({
          id: (e.id as string) || undefined,
          name: (e.name as string) || 'Player',
          score: e.score as number,
          date: (e.date as string) || '',
        }));
        this.saveLocal();
      }
      return data.rank || null;
    } catch {
      return this.submitLocal(score, cleanName);
    }
  }

  wouldRank(score: number): boolean {
    if (score <= 0) return false;
    const playerId = this.getPlayerId();
    const existingIdx = this.entries.findIndex(e => e.id === playerId);

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
      const res = await fetch(`${API_URL}?difficulty=${this.getBoardId()}`);
      if (!res.ok) throw new Error('API error');
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) throw new Error('Not JSON');
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Invalid data');
      this.entries = data.map((e: Record<string, unknown>) => ({
        id: (e.id as string) || undefined,
        name: (e.name as string) || 'Player',
        score: e.score as number,
        date: (e.date as string) || '',
      }));
      this.saveLocal();
    } catch {
      // Offline or invalid response — keep local data
    }
    this.fetchPromise = null;
  }

  private submitLocal(score: number, name: string): number | null {
    const entry: LeaderboardEntry = { name, score, date: new Date().toISOString() };

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
