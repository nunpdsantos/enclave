import { Difficulty } from './Config';

const NAME_KEY = 'enclave_lastname';
const PLAYER_ID_KEY = 'enclave_playerid';
const MAX_ENTRIES = 10;
const API_URL = '/api/leaderboard';

function storageKey(difficulty: Difficulty): string {
  return `enclave_${difficulty}_top10`;
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

  constructor(difficulty: Difficulty = 'classic') {
    this.difficulty = difficulty;
    this.loadLocal();
    this.fetchPromise = this.fetchRemote();
  }

  getDifficulty(): Difficulty {
    return this.difficulty;
  }

  /** Switch to a different difficulty's leaderboard */
  async switchDifficulty(difficulty: Difficulty): Promise<void> {
    if (difficulty === this.difficulty) return;
    this.difficulty = difficulty;
    this.loadLocal();
    await this.fetchRemote();
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
      const res = await fetch(`${API_URL}?difficulty=${this.difficulty}`, {
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
      const res = await fetch(`${API_URL}?difficulty=${this.difficulty}`);
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
      const raw = localStorage.getItem(storageKey(this.difficulty));
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
      localStorage.setItem(storageKey(this.difficulty), JSON.stringify(this.entries));
    } catch { /* */ }
  }
}
