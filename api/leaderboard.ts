import { Redis } from '@upstash/redis';
import { SimFailure, verifyScore } from '../src/core/Replay';
import { RULES_VERSION } from '../src/core/Rules';
import { GRID_SIZE, MAX_REPLAY_MOVES } from '../src/core/types';
import type { Replay } from '../src/core/types';

export const config = { runtime: 'edge' };

/**
 * The shared leaderboard.
 *
 * Two kinds of board live here. Classic and Blitz are permanent ladders,
 * one entry per player, replaced when they beat themselves. A daily is a
 * board per UTC date: it expires, it only accepts scores while the day is
 * still fresh, and the FIRST submission is the one that counts — otherwise
 * the daily would just measure who replayed it most.
 *
 * No score is taken on the client's word. Every submission carries a replay
 * — the seed it was dealt from and every input that followed — and the score
 * only lands if re-playing that log with the game's own rules (`simulateRun`,
 * which drives the same GameState the browser drives) arrives at exactly the
 * number being claimed. The modules it pulls in are DOM-free: they reach
 * localStorage for personal bests, but every access there is wrapped and a
 * server simply reads zero.
 */

const VALID_DIFFICULTIES = ['classic', 'blitz'];
const MAX_ENTRIES = 10;

/**
 * A six-hundred-move replay serialises to about 27 KB, so 64 KB leaves room
 * for the name and the id and still refuses anything that is not a run.
 */
const MAX_BODY_BYTES = 64 * 1024;
/** The modes a replay may name — the daily included, unlike the board ids */
const VALID_REPLAY_MODES = ['classic', 'blitz', 'daily'];
/** No piece has more than four distinct rotations */
const MAX_ROTATIONS = 4;
const U32_MAX = 0xffffffff;

/** 'daily-YYYY-MM-DD'. Anything else beginning with 'daily' is a 400. */
const DAILY_KEY_RE = /^daily-(\d{4}-\d{2}-\d{2})$/;
/** A daily board outlives its 7-day GET window by a day, then evaporates */
const DAILY_TTL_SECONDS = 8 * 24 * 60 * 60;
/** Scores may only be posted to today's or yesterday's daily: no back-filling */
const MAX_POST_AGE_DAYS = 1;
/** The menu can look back a week */
const MAX_GET_AGE_DAYS = 7;
/** One day of tolerance for a device clock running ahead of the server's */
const MAX_FUTURE_DAYS = 1;

const MS_PER_DAY = 86_400_000;

interface Entry {
  id: string;
  name: string;
  score: number;
  date: string;
}

/** Which board a request is talking about; `dailyDate` set only for dailies. */
interface Board {
  id: string;
  dailyDate: string | null;
}

function kvKey(board: Board): string {
  return board.dailyDate
    ? `leaderboard:enclave:daily:${board.dailyDate}`
    : `leaderboard:enclave:${board.id}`;
}

function getRedis(): Redis {
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  });
}

async function getEntries(board: Board): Promise<Entry[]> {
  const redis = getRedis();
  return (await redis.get<Entry[]>(kvKey(board))) || [];
}

async function saveEntries(board: Board, entries: Entry[]): Promise<void> {
  const redis = getRedis();
  const key = kvKey(board);
  await redis.set(key, entries);
  // Refreshed on every write rather than set once, so a board stays alive
  // for eight days from its last score and never outlives its usefulness.
  if (board.dailyDate) await redis.expire(key, DAILY_TTL_SECONDS);
}

/** True for a well-formed, real calendar date in 'YYYY-MM-DD' form */
function isRealDate(date: string): boolean {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

/** Whole UTC days between that date and today: 0 today, 1 yesterday, -1 tomorrow */
function ageInDays(date: string, now: Date = new Date()): number {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return Math.round((today - Date.parse(`${date}T00:00:00.000Z`)) / MS_PER_DAY);
}

/**
 * The board a request names, or null if it named one that cannot exist.
 *
 * An unrecognised non-daily value still falls back to Classic, which is what
 * this endpoint has always done and what old clients rely on.
 */
function parseBoard(url: string): Board | null {
  const d = new URL(url).searchParams.get('difficulty') || 'classic';
  if (VALID_DIFFICULTIES.includes(d)) return { id: d, dailyDate: null };
  if (d.startsWith('daily')) {
    const m = DAILY_KEY_RE.exec(d);
    if (!m || !isRealDate(m[1])) return null;
    return { id: d, dailyDate: m[1] };
  }
  return { id: 'classic', dailyDate: null };
}

// ── Replay validation ──

/** A board coordinate: 0–8 on a 9×9 grid */
function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < GRID_SIZE;
}

/**
 * Everything about the replay that can be judged without playing it.
 *
 * Strict on purpose: the simulation is the expensive step, and it should
 * never be handed a log whose shape could make it do something surprising.
 * Returns the reason it failed, or null when the log is worth simulating.
 */
function checkReplayShape(raw: unknown, board: Board): SimFailure | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'shape';
  const r = raw as Record<string, unknown>;

  // Version first: a stale client is a different answer from a bad one
  if (r.rules !== RULES_VERSION) return 'rules';
  if (typeof r.mode !== 'string' || !VALID_REPLAY_MODES.includes(r.mode)) return 'shape';
  if (typeof r.seed !== 'number' || !Number.isInteger(r.seed) || r.seed < 0 || r.seed > U32_MAX) {
    return 'shape';
  }
  // A truncated log stops short of the score, so it can never prove one
  if (r.truncated !== undefined && r.truncated !== false) return 'shape';

  // The board a score is posted to and the run that was played must be the
  // same thing, or a Blitz run could be posted to the Classic ladder.
  if (board.dailyDate !== null) {
    if (r.mode !== 'daily' || r.dailyKey !== board.dailyDate) return 'shape';
  } else if (r.mode !== board.id) {
    return 'shape';
  }

  if (!Array.isArray(r.moves) || r.moves.length > MAX_REPLAY_MOVES) return 'shape';
  let previousAt = 0;
  for (const entry of r.moves) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'shape';
    const move = entry as Record<string, unknown>;
    const at = move.at;
    // Time runs one way, and it starts at the start of the run
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at < previousAt) return 'shape';
    previousAt = at;
    if (move.t === 'h') continue;
    if (move.t !== 'p') return 'shape';
    if (!isIndex(move.row) || !isIndex(move.col)) return 'shape';
    if (typeof move.rot !== 'number' || !Number.isInteger(move.rot)
      || move.rot < 0 || move.rot >= MAX_ROTATIONS) return 'shape';
  }
  return null;
}

export default async function handler(request: Request): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  const board = parseBoard(request.url);
  if (!board) {
    return new Response(JSON.stringify({ error: 'Invalid difficulty' }), { status: 400, headers });
  }

  if (request.method === 'GET') {
    if (board.dailyDate) {
      const age = ageInDays(board.dailyDate);
      if (age > MAX_GET_AGE_DAYS || age < -MAX_FUTURE_DAYS) {
        return new Response(JSON.stringify({ error: 'Date out of range' }), { status: 400, headers });
      }
    }
    const entries = await getEntries(board);
    return new Response(JSON.stringify(entries), { headers });
  }

  if (request.method === 'POST') {
    if (board.dailyDate) {
      const age = ageInDays(board.dailyDate);
      if (age < 0 || age > MAX_POST_AGE_DAYS) {
        return new Response(JSON.stringify({ error: 'Daily closed' }), { status: 400, headers });
      }
    }

    let text: string;
    try {
      text = await request.text();
    } catch {
      return new Response(JSON.stringify({ error: 'Unreadable body' }), { status: 400, headers });
    }
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: 'Body too large' }), { status: 400, headers });
    }

    let body: { id?: string; name?: string; score?: number; replay?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
    }

    const { id, name, score } = body;
    if (!id || !name || typeof score !== 'number' || score <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid data' }), { status: 400, headers });
    }

    // A submission with no replay is a client from before validation existed.
    // It is not a cheat and should not be told it is: the service worker
    // picks the new build up on the next load.
    if (body.replay === undefined || body.replay === null) {
      return new Response(JSON.stringify({ error: 'Update required' }), { status: 400, headers });
    }

    const unverified = (reason: SimFailure): Response => new Response(
      JSON.stringify({ error: 'Score could not be verified', reason }), { status: 400, headers },
    );

    const shapeFailure = checkReplayShape(body.replay, board);
    if (shapeFailure) return unverified(shapeFailure);

    // The one check that matters: re-play the run and see if it scores this.
    const verdict = verifyScore(body.replay as Replay, score);
    if (!verdict.valid) return unverified(verdict.reason ?? 'move');

    const entries = await getEntries(board);

    const existingIdx = entries.findIndex(e => e.id === id);
    if (existingIdx >= 0) {
      // A daily is one attempt per player: whatever they posted first stands,
      // higher or not, so nobody can grind the same 30 pieces for a better run
      if (board.dailyDate) {
        return new Response(JSON.stringify({ rank: existingIdx + 1, entries }), { headers });
      }
      if (entries[existingIdx].score > score) {
        // New score is strictly lower — keep old entry, return its rank
        return new Response(JSON.stringify({ rank: existingIdx + 1, entries }), { headers });
      }
      if (entries[existingIdx].score === score) {
        // Same score — update name in place, persist, return rank
        entries[existingIdx].name = name.trim().slice(0, 12) || 'Player';
        await saveEntries(board, entries);
        return new Response(JSON.stringify({ rank: existingIdx + 1, entries }), { headers });
      }
      // New score is higher — remove old entry to re-insert at correct position
      entries.splice(existingIdx, 1);
    }

    const entry: Entry = {
      id,
      name: name.trim().slice(0, 12) || 'Player',
      score,
      date: new Date().toISOString().split('T')[0],
    };

    let rank = entries.findIndex(e => score > e.score);
    if (rank === -1) rank = entries.length;
    entries.splice(rank, 0, entry);

    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;

    await saveEntries(board, entries);

    const finalRank = rank < MAX_ENTRIES ? rank + 1 : null;
    return new Response(JSON.stringify({ rank: finalRank, entries }), { headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
