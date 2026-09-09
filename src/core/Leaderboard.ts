import { Difficulty } from './Config';
import { dailyKey } from './Daily';
import { readTicketPayload } from './Ticket';
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
  /**
   * The mode the *ticket* says it is for, read out of its own payload rather
   * than assumed from what was asked. It is what the server will check the
   * submission against, so a ticket whose mode is not the run's mode is a
   * ticket this run cannot use — see `RunStarter`.
   */
  mode: string | null;
  /** The server's UTC date, on a daily ticket */
  dailyKey?: string;
}

/**
 * Ask the server to start a run: it picks the deal and signs a ticket for it.
 *
 * `practice` asks for a run that cannot post a score, which is what the game
 * wants when it already knows this browser has spent today's daily attempt:
 * without it the server hands back the ticket that attempt was issued on,
 * which has already been spent and would be refused at the end of the run.
 *
 * Null means the run is unverifiable before it has begun — offline, the API
 * down, a request that took too long. That is not a failure the player can
 * do anything about, so the run simply starts on a local seed and is kept
 * local at the end of it, rather than being played and then refused.
 */
export async function requestRunTicket(
  mode: Difficulty, practice: boolean = false,
): Promise<RunTicket | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TICKET_TIMEOUT_MS);
  try {
    const res = await fetch(RUN_START_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: playerId(), mode, ...(practice ? { practice: true } : {}) }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.token !== 'string' || typeof data?.seed !== 'number') return null;
    if (!Number.isInteger(data.seed) || data.seed < 0 || data.seed > 0xffffffff) return null;
    const claimed = readTicketPayload(data.token)?.mode;
    return {
      seed: data.seed,
      token: data.token,
      mode: typeof claimed === 'string' ? claimed : null,
      ...(typeof data.dailyKey === 'string' ? { dailyKey: data.dailyKey } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A run that is starting: the mode it is in, and the ticket it got, if any. */
export interface StartedRun {
  mode: Difficulty;
  ticket: RunTicket | null;
}

/**
 * Starting a run, without letting two starts overlap.
 *
 * A ticket has to be in hand before the first piece is dealt, so the start is
 * a network round trip with the menu still on screen and still taking taps.
 * Two things went wrong there, and both of them shipped:
 *
 *  - **Two Plays, two runs.** A double-tap on the Daily started one run,
 *    then started a second that replaced it — and on the old server the
 *    second ticket was a practice one, so a double-tap turned a real daily
 *    attempt into a practice run. A start in flight now swallows the second
 *    press: `start` answers null and the caller does nothing.
 *  - **A Blitz game on a Classic ticket.** The mode was read again *after*
 *    the await, so switching modes while the ticket was in the air paired a
 *    game of one mode with a ticket for another; the run then played to the
 *    end and was refused. The mode is captured before the request and is what
 *    the run is built from, and a ticket that comes back naming a different
 *    mode is dropped rather than used.
 *
 * The fetch is injected so this can be tested without a network: everything
 * here is timing, and timing is exactly what a test has to be able to hold.
 */
export class RunStarter {
  private busy = false;

  constructor(
    private readonly fetchTicket: (
      mode: Difficulty, practice: boolean,
    ) => Promise<RunTicket | null> = requestRunTicket,
  ) {}

  /** True while a start is waiting for its ticket. */
  get inFlight(): boolean {
    return this.busy;
  }

  /**
   * Null when a start is already in flight — the press is ignored, not
   * queued. Otherwise the run to build, with a ticket only if that ticket
   * belongs to this run.
   */
  async start(mode: Difficulty, practice: boolean = false): Promise<StartedRun | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const ticket = await this.fetchTicket(mode, practice);
      // A ticket the server signed for another mode cannot vouch for this
      // run: posting it would spend the ticket to be told `token`.
      return { mode, ticket: ticket && ticket.mode === mode ? ticket : null };
    } finally {
      this.busy = false;
    }
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
  /** Which read is the newest: an older one's answer is never applied. */
  private sequence = 0;
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
   * Point the client at a board, without reading it.
   *
   * Synchronous, and that is the whole point of it: `getBoardId()` and
   * `getEntries()` answer for the new board before this returns, so a screen
   * can be drawn from it at once and be right. The rows are whatever was last
   * cached for that board; `refresh` is what replaces them with the server's.
   *
   * The daily takes a date as well, because a run that started before UTC
   * midnight still belongs to the day it was dealt from.
   *
   * True when the board actually changed, so a caller can tell a read it has
   * to start from one that is already in flight.
   */
  selectBoard(difficulty: Difficulty, dailyDate: string = dailyKey()): boolean {
    if (boardId(difficulty, dailyDate) === this.getBoardId()) return false;
    this.difficulty = difficulty;
    this.dailyDate = dailyDate;
    this.loadLocal();
    return true;
  }

  /** Read the selected board. Resolves when the answer lands, or fails to. */
  refresh(): Promise<void> {
    this.fetchPromise = this.fetchRemote();
    return this.fetchPromise;
  }

  /**
   * Select a board now and read it in the background — the ordinary way to
   * change boards, and the only one.
   *
   * The half a screen needs is done before this returns; the promise only
   * says when there is something newer to draw. Awaiting it *before* drawing
   * is what left the game-over screen blank on a stalled read — no score, no
   * buttons — so there is deliberately no method here that does the waiting
   * on a caller's behalf.
   */
  showBoard(difficulty: Difficulty, dailyDate: string = dailyKey()): Promise<void> {
    return this.selectBoard(difficulty, dailyDate) ? this.refresh() : this.waitForRemote();
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

    // The board a score is posted to is the board its run was played in, not
    // whichever one this shared client is currently showing. The two come
    // apart whenever the menu is switched while a ticket is in the air: the
    // run keeps the mode Play was pressed on, the client follows the menu,
    // and a Classic replay went to `?difficulty=blitz` to be refused as
    // `shape`. The replay names its own mode and daily date, and it is that
    // same pair the server checks the query against — so reading the board
    // out of the replay is the one way the two cannot disagree.
    //
    // Captured here, before anything is awaited, and used for the request and
    // for its answer. Reading it back off `this` afterwards was reading state
    // that anything else holding this shared client can change while the
    // corrective read and then the POST are in the air — which put the run
    // back on the board the *menu* had moved to, the very failure this
    // paragraph exists to close.
    const dailyDate = replay.mode === 'daily'
      ? replay.dailyKey ?? this.dailyDate
      : this.dailyDate;
    const board = boardId(replay.mode, dailyDate);
    // Point the shared client at it too, so the panel under the name entry is
    // the board the score is going to. A no-op when it is already there,
    // which is the ordinary case — and never waited on: a read that stalls
    // must not hold up the score it has nothing to do with.
    void this.showBoard(replay.mode, dailyDate);

    if (!token) {
      return {
        rank: this.submitLocal(score, cleanName, board),
        verified: false,
        reason: 'unticketed',
      };
    }

    try {
      const res = await fetch(`${API_URL}?difficulty=${board}`, {
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
          rank: this.submitLocal(score, cleanName, board),
          verified: false,
          reason: await refusalReason(res),
        };
      }
      if (!res.ok) throw new Error('API error');
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) throw new Error('Not JSON');

      const data = await res.json();
      if (data.entries && Array.isArray(data.entries)) {
        // The board this answer belongs to, which is not necessarily the one
        // on screen by now — see the capture above.
        this.writeLocal(board, data.entries.map(toEntry));
      }
      return { rank: data.rank || null, verified: true };
    } catch {
      return { rank: this.submitLocal(score, cleanName, board), verified: false };
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

  /**
   * Read the board, and apply the answer only to the board it was asked for.
   *
   * The response used to be applied to whichever board was current when it
   * arrived, so switching from the Daily to Classic while the Daily's request
   * was in the air drew the Daily's ten under Classic's heading — and then
   * wrote them into Classic's local cache, where they stayed. The board id is
   * read before the request goes out, and a response that comes back to a
   * different board is dropped; `sequence` does the same for two requests for
   * the same board, so the older of them can never land last.
   */
  private async fetchRemote(): Promise<void> {
    const board = this.getBoardId();
    const seq = ++this.sequence;
    let fetched: LeaderboardEntry[] | null = null;
    try {
      // The id goes out so the server can mark the player's own row, and it
      // is only ever the one this browser already has: reading a board must
      // not be what gives an anonymous visitor an identity.
      const stored = getStoredPlayerId();
      const url = `${API_URL}?difficulty=${board}`
        + (stored ? `&id=${encodeURIComponent(stored)}` : '');
      const res = await fetch(url);
      if (!res.ok) throw new Error('API error');
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) throw new Error('Not JSON');
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Invalid data');
      fetched = data.map(toEntry);
    } catch {
      // Offline or invalid response — keep local data
    }
    // Superseded, or answering for a board that is no longer loaded
    if (seq !== this.sequence || this.getBoardId() !== board) return;
    if (fetched) this.writeLocal(board, fetched);
    this.fetchPromise = null;
  }

  /** Rank a score into a named board's rows, and keep them. */
  private submitLocal(score: number, name: string, board: string): number | null {
    const entries = board === this.getBoardId() ? this.entries : this.readLocal(board);
    const entry: LeaderboardEntry = { name, score, date: new Date().toISOString(), mine: true };

    let rank = entries.findIndex(e => score > e.score);
    if (rank === -1) rank = entries.length;
    if (rank >= MAX_ENTRIES) return null;

    entries.splice(rank, 0, entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    this.writeLocal(board, entries);
    return rank + 1;
  }

  private loadLocal(): void {
    this.entries = this.readLocal(this.getBoardId());
  }

  /** A board's cached rows, whether or not it is the board on screen. */
  private readLocal(board: string): LeaderboardEntry[] {
    try {
      const raw = localStorage.getItem(storageKey(board));
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Keep a board's rows, and show them only if that board is the one loaded.
   *
   * The board is named rather than taken from `this`, because rows arrive
   * from requests that were sent for a board the client may since have
   * switched away from: a submission's answer belongs to the run's board, and
   * drawing it over whatever is on screen is how the Daily's ten ended up
   * under Classic's heading — and in Classic's cache, where they stayed.
   */
  private writeLocal(board: string, entries: LeaderboardEntry[]): void {
    if (board === this.getBoardId()) this.entries = entries;
    try {
      localStorage.setItem(storageKey(board), JSON.stringify(entries));
    } catch { /* */ }
  }
}
