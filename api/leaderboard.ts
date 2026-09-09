import { Redis } from '@upstash/redis';
import type { Difficulty } from '../src/core/Config';
import { readBody } from '../src/core/RequestBody';
import { verifyScore } from '../src/core/Replay';
import type { SimFailure } from '../src/core/Replay';
import { RULES_VERSION } from '../src/core/Rules';
import { GRID_SIZE, MAX_REPLAY_MOVES } from '../src/core/types';
import type { Move, Replay } from '../src/core/types';
import { replayFingerprint, verifyTicket } from '../src/core/Ticket';
import type { TicketPayload } from '../src/core/Ticket';

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
 * A score has to get past three separate things, and each of them answers a
 * question the others cannot:
 *
 *  - the **replay** proves the rules produce that number. `simulateRun`
 *    drives the same GameState the browser drives, from the same seed, so a
 *    typed-in score has nowhere to hide.
 *  - the **run ticket** proves somebody actually played it. The server chose
 *    the seed, signed it against one player id and one clock reading, and
 *    will not take a submission whose replay claims more play than the wall
 *    clock has allowed since — nor take the same ticket twice.
 *  - the **replay fingerprint** — the deal and the placements, never their
 *    timing and never their orientation — and, on a daily, the per-day id set
 *    stop the same proven run from being banked more than once.
 *
 * The state all three of those consume is written by ONE Lua script, so a
 * submission either happens or does not: see `SUBMIT_SCRIPT`.
 *
 * What is still open is written down in the README: a bot that scripts legal
 * moves through the real rules, at human speed, produces a run that is real
 * in every sense this file can test.
 *
 * Everything the simulation pulls in is DOM-free: it reaches localStorage for
 * personal bests, but every access there is wrapped and a server reads zero.
 */

const VALID_DIFFICULTIES = ['classic', 'blitz'];
const MAX_ENTRIES = 10;

/**
 * A move serialises to 57 bytes, measured — `at` is a full double and most of
 * it — so the 1,500-input cap puts a full-length log at about 86 KB. 128 KB
 * leaves room for the name, the id and the ticket with 40 KB to spare, and
 * still refuses anything that is not a run. Enforced while the body is being
 * read rather than after it has all been held, so a client that sends a
 * gigabyte is cut off at the first byte past the cap.
 */
const MAX_BODY_BYTES = 128 * 1024;
/** The modes a replay may name — the daily included, unlike the board ids */
const VALID_REPLAY_MODES = ['classic', 'blitz', 'daily'];
/** No piece has more than four distinct rotations */
const MAX_ROTATIONS = 4;
const U32_MAX = 0xffffffff;
/** An id is an opaque client-minted string; it becomes a Redis member */
const MAX_ID_LENGTH = 64;

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

/** A ticket is good for a day. Long enough for a daily left open overnight. */
const MAX_TICKET_AGE_MS = 24 * 60 * 60 * 1000;
/** Two edge regions do not share a clock to the millisecond */
const TICKET_FUTURE_SKEW_MS = 60 * 1000;
/**
 * How much less wall-clock time than the run claims we will accept.
 *
 * A run cannot be played faster than real time, so `now - issuedAt` has to
 * cover the last recorded move. The two seconds are for the gap between the
 * ticket being minted and the run actually starting to count — the countdown,
 * the first render — plus clock skew. Anything beyond that is a log written
 * rather than played.
 */
const REALTIME_SLACK_SECONDS = 2;
/** A spent-ticket bucket covers one day of issued tickets, and outlives them */
const USED_TOKEN_TTL_SECONDS = 2 * 24 * 60 * 60;
/** A daily's replay fingerprints only have to outlive its board */
const REPLAY_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * How few placements make a solution too ordinary to be anybody's in
 * particular.
 *
 * The fingerprint says "this run has already been banked", which is only true
 * of a run somebody could have copied. Two players who each place one piece
 * and quit produce byte-identical solutions without ever meeting, and the
 * second of them was being told their score could not be verified. Below
 * eight placements the dedupe is switched off: the seed is shared, the space
 * of short openings is small, and a collision there is coincidence rather
 * than a copy. A run that short cannot rank on any board anyway.
 */
const MIN_FINGERPRINT_PLACEMENTS = 8;

/**
 * How long any one Redis command may take before the request gives up.
 *
 * The SDK is given a fresh `AbortSignal.timeout` per command (its `signal`
 * option accepts a factory for exactly this), so a database that has stopped
 * answering costs five seconds and a 503 rather than the whole edge
 * function's budget. The signal covers the SDK's own retries, so this is a
 * deadline on the command and not on one attempt at it.
 */
const REDIS_TIMEOUT_MS = 5000;

const MS_PER_DAY = 86_400_000;

/** Why a submission was refused, beyond what the simulation can say. */
type Refusal = SimFailure | 'token' | 'time' | 'replay' | 'practice';

interface Entry {
  id: string;
  name: string;
  score: number;
  date: string;
}

/** An entry as the world sees it: no ids, and 'mine' only for the asker. */
interface PublicEntry {
  name: string;
  score: number;
  date: string;
  mine?: boolean;
}

/** Which board a request is talking about; `dailyDate` set only for dailies. */
interface Board {
  id: string;
  mode: Difficulty;
  dailyDate: string | null;
}

/**
 * Keys are versioned by RULES_VERSION.
 *
 * Every score on a board was proved against one version of the rules, and a
 * bump means the older proofs can no longer be checked — so they stop being
 * scores and become numbers somebody once sent us. Reading a fresh key is
 * the only honest answer to that. The old keys are left in Redis untouched;
 * whether to migrate, publish or drop them is the owner's decision, not this
 * handler's.
 */
function boardSuffix(board: Board): string {
  return board.dailyDate
    ? `v${RULES_VERSION}:daily:${board.dailyDate}`
    : `v${RULES_VERSION}:${board.id}`;
}

/** The sorted set: member = player id, score = score. */
function boardKey(board: Board): string {
  return `leaderboard:enclave:${boardSuffix(board)}`;
}

/** The hash beside it: player id → JSON { name, date }. */
function metaKey(board: Board): string {
  return `${boardKey(board)}:meta`;
}

/** Every id that has submitted this daily, ranked or not. */
function dailyIdsKey(board: Board): string {
  return `${boardKey(board)}:ids`;
}

/** Fingerprints of the runs already banked on this board. */
function replaysKey(board: Board): string {
  return `leaderboard:enclave:replays:${boardSuffix(board)}`;
}

/**
 * Spent tickets, bucketed by the day the ticket was *issued* rather than the
 * day it was spent. A ticket lives at most 24 hours, so its bucket is fixed
 * the moment it is minted and one lookup can never miss a token that landed
 * in yesterday's bucket.
 *
 * A hash rather than the set it used to be, because a spent ticket has to
 * remember *what it was spent on*. The REST client retries a request whose
 * response was lost, and a retry that could only learn "this ticket is spent"
 * had to refuse the submission it had itself just accepted. The field holds
 * the outcome and the submission it belongs to, so a retry is answered with
 * the answer the first attempt gave. The key is new — the old set is left to
 * expire on its own, which it does within two days.
 */
function spentTicketsKey(issuedAt: number): string {
  return `leaderboard:enclave:spent-tickets:${new Date(issuedAt).toISOString().slice(0, 10)}`;
}

function getRedis(): Redis {
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
    // A factory, not a signal: the SDK calls it once per command, so every
    // command gets its own five seconds instead of sharing one deadline
    // across the whole handler.
    signal: () => AbortSignal.timeout(REDIS_TIMEOUT_MS),
  });
}

/**
 * The ticket-signing secret.
 *
 * `ENCLAVE_SECRET` when it is set, so signing can be rotated on its own;
 * otherwise `KV_REST_API_TOKEN`, which is already a server-only secret that
 * must be configured for any of this to work, so an existing deployment gets
 * tickets without a new environment variable. Never sent to a client.
 */
function ticketSecret(): string | null {
  return process.env.ENCLAVE_SECRET || process.env.KV_REST_API_TOKEN || null;
}

// ── Reading a board ──

/** The top ten, with the names and dates their meta hash carries. */
async function readTop(redis: Redis, board: Board): Promise<Entry[]> {
  const flat = await redis.zrange<(string | number)[]>(
    boardKey(board), 0, MAX_ENTRIES - 1, { rev: true, withScores: true },
  );
  if (!Array.isArray(flat) || flat.length < 2) return [];

  const ids: string[] = [];
  const scores: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    ids.push(String(flat[i]));
    scores.push(Number(flat[i + 1]));
  }

  const meta = await redis.hmget<Record<string, unknown>>(metaKey(board), ...ids);
  return ids.map((id, i) => {
    const raw = meta?.[id];
    const record = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    return {
      id,
      name: typeof record.name === 'string' ? record.name : 'Player',
      score: scores[i],
      date: typeof record.date === 'string' ? record.date : '',
    };
  });
}

/**
 * The board as a response body: ids stripped.
 *
 * They used to go out with every row, which handed anybody who read the
 * board the identity every score is posted under. The only thing the client
 * needed them for was "which of these is me", and that is a flag the server
 * can set for the one id the asker already knows.
 */
function publicEntries(entries: Entry[], id: string | null): PublicEntry[] {
  return entries.map(e => ({
    name: e.name,
    score: e.score,
    date: e.date,
    ...(id !== null && e.id === id ? { mine: true } : {}),
  }));
}

/** 1-based place on the board, or null for anywhere outside the top ten. */
async function rankOf(redis: Redis, board: Board, id: string): Promise<number | null> {
  const rank = await redis.zrevrank(boardKey(board), id);
  return typeof rank === 'number' && rank >= 0 && rank < MAX_ENTRIES ? rank + 1 : null;
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
  if (VALID_DIFFICULTIES.includes(d)) return { id: d, mode: d as Difficulty, dailyDate: null };
  if (d.startsWith('daily')) {
    const m = DAILY_KEY_RE.exec(d);
    if (!m || !isRealDate(m[1])) return null;
    return { id: d, mode: 'daily', dailyDate: m[1] };
  }
  return { id: 'classic', mode: 'classic', dailyDate: null };
}

/** The asker's own id, when they sent one. Only ever compared, never stored. */
function askerId(url: string): string | null {
  const id = new URL(url).searchParams.get('id');
  return id && id.length <= MAX_ID_LENGTH ? id : null;
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

/** The second of the run its last input landed on; 0 for an empty log. */
function lastAt(moves: readonly Move[]): number {
  return moves.length === 0 ? 0 : moves[moves.length - 1].at;
}

// ── The write, as one indivisible step ──

/**
 * What the script decided. 'ok' and 'already' are the board answering; 'token'
 * and 'replay' are 400s; 'storage' is a 503, and the only one of the five that
 * is not about this submission at all.
 */
type SubmitStatus = 'ok' | 'token' | 'replay' | 'already' | 'storage';

/** Exported so a test can hold the Lua's own vocabulary against this list. */
export const SUBMIT_STATUSES: SubmitStatus[] = ['ok', 'token', 'replay', 'already', 'storage'];

/**
 * Everything a submission changes, in one script.
 *
 * These used to be four commands — spend the ticket, reserve the fingerprint,
 * record the daily id, write the score — and the gap between any two of them
 * was a place a submission could die half-done. The worst of it was not a
 * crash but a *retry*: the REST client re-sends a request whose response was
 * lost, so the daily-id write could commit, the retry find the id already
 * there, and the handler answer "you have already submitted today" — 200, no
 * rank, no board, and no score anywhere, with the ticket and the fingerprint
 * spent. One `EVAL` closes every one of those gaps at once, because Redis
 * runs a script to completion before anything else runs at all.
 *
 * It is also **idempotent**, which is what makes the retry safe rather than
 * merely atomic. The first thing it does is look the ticket up in the
 * spent-ticket hash: a field holds the outcome and an identity — the score,
 * the fingerprint, the board and the player — of the submission that spent
 * it. A retry of the same submission matches that identity and is handed back
 * the same outcome; a different run under the same ticket does not, and is
 * refused as the reused ticket it is.
 *
 * `ZADD` decides the write, not a read followed by a write: `GT` on a
 * permanent board (the entry moves only for a higher score), `NX` on a daily
 * (whatever lands first stands), and `CH` on both so the name and date beside
 * it are written **only when the score itself moved**. Two submissions racing
 * used to be able to leave the faster player's score under the slower
 * player's name, because the `HSET` was a separate command that did not know
 * whether its `ZADD` had won.
 *
 * What it is **not** is transactional. A script runs alone, but a command
 * that raises inside one does not undo the commands before it: if the board
 * key held a plain string, the fingerprint and the daily id were already
 * banked by the time `ZADD` raised WRONGTYPE, and the ticket's outcome — the
 * last write of all — never happened. Repairing the key and resubmitting then
 * answered `replay`, because the fingerprint was there and nothing recorded
 * why. So every key the script is about to write is type-checked first, while
 * refusing still costs nothing, and a mistyped key comes back as 'storage':
 * a 503, a database that cannot be used rather than a score refused.
 *
 * KEYS: 1 spent tickets, 2 fingerprints, 3 daily ids, 4 board, 5 meta.
 * ARGV: 1 token id, 2 fingerprint ('' skips the check), 3 player id,
 *       4 score, 5 meta JSON, 6 '1' on a daily, 7 spent-ticket TTL,
 *       8 fingerprint TTL (0 for none), 9 board TTL (0 for none).
 * Returns `{ status, changed }`.
 */
export const SUBMIT_SCRIPT = `
local function badtype(key, want)
  -- TYPE answers with a status reply, and a status reply reaches Lua as a
  -- table carrying one 'ok' field. A key that is not there answers 'none',
  -- which is not a wrong type: it is the key this submission will create.
  local kind = redis.call('TYPE', key)['ok']
  return kind ~= 'none' and kind ~= want
end

if badtype(KEYS[1], 'hash') or badtype(KEYS[4], 'zset') or badtype(KEYS[5], 'hash')
  or (ARGV[2] ~= '' and badtype(KEYS[2], 'set'))
  or (ARGV[6] == '1' and badtype(KEYS[3], 'set')) then
  return { 'storage', 0 }
end

local identity = ARGV[4] .. '|' .. ARGV[2] .. '|' .. KEYS[4] .. '|' .. ARGV[3]
local spent = redis.call('HGET', KEYS[1], ARGV[1])
if spent then
  local cut = string.find(spent, '|', 1, true)
  if cut and string.sub(spent, cut + 1) == identity then
    return { string.sub(spent, 1, cut - 1), 0 }
  end
  return { 'token', 0 }
end

local status = 'ok'
local changed = 0

if ARGV[2] ~= '' then
  if redis.call('SADD', KEYS[2], ARGV[2]) == 0 then
    status = 'replay'
  elseif tonumber(ARGV[8]) > 0 then
    redis.call('EXPIRE', KEYS[2], ARGV[8])
  end
end

if status == 'ok' then
  if ARGV[6] == '1' then
    local first = redis.call('SADD', KEYS[3], ARGV[3])
    redis.call('EXPIRE', KEYS[3], ARGV[9])
    if first == 0 then
      status = 'already'
    else
      changed = redis.call('ZADD', KEYS[4], 'NX', 'CH', ARGV[4], ARGV[3])
      if changed == 1 then redis.call('HSET', KEYS[5], ARGV[3], ARGV[5]) end
      redis.call('EXPIRE', KEYS[4], ARGV[9])
      redis.call('EXPIRE', KEYS[5], ARGV[9])
    end
  else
    changed = redis.call('ZADD', KEYS[4], 'GT', 'CH', ARGV[4], ARGV[3])
    if changed == 1 then redis.call('HSET', KEYS[5], ARGV[3], ARGV[5]) end
  end
end

redis.call('HSET', KEYS[1], ARGV[1], status .. '|' .. identity)
redis.call('EXPIRE', KEYS[1], ARGV[7])
return { status, changed }
`;

/**
 * The script's two-element answer, defensively: anything else is a failure.
 *
 * `changed` — whether the board actually moved — is part of the script's
 * contract and nothing in the response needs it yet; it is what decided
 * whether the name was written, and it is here so a caller can be told.
 */
function readVerdict(raw: unknown): { status: SubmitStatus; changed: boolean } | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const status = String(raw[0]) as SubmitStatus;
  if (!SUBMIT_STATUSES.includes(status)) return null;
  return { status, changed: Number(raw[1]) === 1 };
}

/**
 * Does this ticket vouch for this submission?
 *
 * The MAC is checked by `verifyTicket`; what is left is whether the thing it
 * vouches for is the thing that arrived. Every field is compared, because a
 * ticket that binds the seed but not the id would let one run be posted
 * under any number of names, and one that binds the id but not the seed
 * would let a player pick their own deal again.
 */
function ticketMatches(
  ticket: TicketPayload, board: Board, id: string, replay: Replay, now: number,
): Refusal | null {
  // A practice ticket is a daily attempt this id had already spent when the
  // deal was handed over. Its own reason, because it is not a forgery and
  // the screen has something honest to say about it.
  if (ticket.practice) return 'practice';
  if (ticket.id !== id) return 'token';
  if (ticket.mode !== replay.mode || ticket.mode !== board.mode) return 'token';
  if (ticket.seed !== replay.seed) return 'token';
  if ((ticket.dailyKey ?? null) !== (replay.dailyKey ?? null)) return 'token';
  if (board.dailyDate !== null && ticket.dailyKey !== board.dailyDate) return 'token';

  const age = now - ticket.issuedAt;
  if (age > MAX_TICKET_AGE_MS || age < -TICKET_FUTURE_SKEW_MS) return 'token';

  // A run cannot be played faster than real time. This is the check the
  // replay itself can never make: the log's own timestamps are the
  // attacker's to write, and this compares them against a clock reading the
  // attacker did not choose.
  if (age / 1000 < lastAt(replay.moves) - REALTIME_SLACK_SECONDS) return 'time';

  return null;
}

export default async function handler(request: Request): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  /**
   * Redis did not answer — it timed out, it refused, it is not there. The
   * player has done nothing wrong and the score is not refused, so this is a
   * 503 and not a 400: the client keeps it locally and says so, which is a
   * true sentence, rather than telling a player their run was not verified.
   */
  const unavailable = (): Response => new Response(
    JSON.stringify({ error: 'Leaderboard unavailable' }), { status: 503, headers },
  );

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
    try {
      const entries = await readTop(getRedis(), board);
      return new Response(JSON.stringify(publicEntries(entries, askerId(request.url))), { headers });
    } catch {
      // A read that throws used to reject the handler's own promise, which is
      // a 500 with whatever body the platform writes on it.
      return unavailable();
    }
  }

  if (request.method === 'POST') {
    if (board.dailyDate) {
      const age = ageInDays(board.dailyDate);
      if (age < 0 || age > MAX_POST_AGE_DAYS) {
        return new Response(JSON.stringify({ error: 'Daily closed' }), { status: 400, headers });
      }
    }

    const read = await readBody(request, MAX_BODY_BYTES);
    if (!read.ok) {
      return read.reason === 'too-large'
        ? new Response(JSON.stringify({ error: 'Body too large' }), { status: 413, headers })
        : new Response(JSON.stringify({ error: 'Unreadable body' }), { status: 400, headers });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
    }
    // `null`, `[1,2]` and `"x"` are all valid JSON and none of them is a
    // submission. Screened here so nothing below has to wonder whether the
    // property it is reading exists on something that has properties.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Response(JSON.stringify({ error: 'Invalid data' }), { status: 400, headers });
    }
    const body = parsed as Record<string, unknown>;

    const id = body.id;
    const name = body.name;
    const score = body.score;
    // Types before use: `name` reaches `.trim()` below, and a numeric one
    // used to throw there and answer a 500 to what is plainly a 400.
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
      return new Response(JSON.stringify({ error: 'Invalid data' }), { status: 400, headers });
    }
    if (typeof name !== 'string' || name.length === 0) {
      return new Response(JSON.stringify({ error: 'Invalid data' }), { status: 400, headers });
    }
    if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid data' }), { status: 400, headers });
    }

    // A submission with no replay is a client from before validation existed.
    // It is not a cheat and should not be told it is: the service worker
    // picks the new build up on the next load. A client that records a
    // replay but knows nothing about run tickets is the same kind of stale.
    if (body.replay === undefined || body.replay === null) {
      return new Response(JSON.stringify({ error: 'Update required' }), { status: 400, headers });
    }
    if (body.token === undefined || body.token === null) {
      return new Response(JSON.stringify({ error: 'Update required' }), { status: 400, headers });
    }

    const unverified = (reason: Refusal): Response => new Response(
      JSON.stringify({ error: 'Score could not be verified', reason }), { status: 400, headers },
    );

    const secret = ticketSecret();
    if (!secret) return unavailable();

    const shapeFailure = checkReplayShape(body.replay, board);
    if (shapeFailure) return unverified(shapeFailure);
    const replay = body.replay as Replay;

    // The ticket, before the simulation: it is a hash and a few comparisons,
    // and there is no point re-playing six hundred moves for a submission
    // that has nothing vouching for it.
    const ticket = await verifyTicket(secret, body.token);
    if (!ticket) return unverified('token');
    const mismatch = ticketMatches(ticket, board, id, replay, Date.now());
    if (mismatch) return unverified(mismatch);

    // The check that matters most: re-play the run and see if it scores this.
    const verdict = verifyScore(replay, score);
    if (!verdict.valid) return unverified(verdict.reason ?? 'move');

    // One run per solution. A replay is a document: it verifies as well the
    // tenth time as the first, and on a daily — where every player is dealt
    // the same seed — a good one would otherwise be worth passing around.
    // The fingerprint is over the placements and not their timing or their
    // orientation, so neither re-timing a solution nor turning it round the
    // board makes a second run out of it. `verdict.placed` is the simulation's
    // record of which piece each move put down, which is what the four turns
    // of the board are computed from.
    //
    // An empty fingerprint switches the check off, for a run too short to be
    // anybody's in particular: two players who place one piece and quit write
    // the same solution without ever having met.
    const placements = replay.moves.filter(m => m.t === 'p').length;
    const fingerprint = placements >= MIN_FINGERPRINT_PLACEMENTS
      ? await replayFingerprint(replay, verdict.placed)
      : '';

    const cleanName = name.trim().slice(0, 12) || 'Player';
    const today = new Date().toISOString().split('T')[0];
    // Everything above is a pure function of the request, so a submission
    // that fails any of it has spent nothing and can be corrected. From here
    // on the submission consumes state — all of it, in one step.
    const tokenId = String(body.token).split('.')[1] ?? String(body.token);

    let entries: Entry[];
    let rank: number | null;
    try {
      // Inside the guard: `new Redis` validates its own configuration and
      // throws on a malformed `KV_REST_API_URL`. Constructed above this line,
      // that throw walked straight past the catch and rejected the handler's
      // promise — a 500 on a deployment whose only fault is a bad variable,
      // where every other unreachable-database path answers 503.
      const redis = getRedis();
      const outcome = readVerdict(await redis.eval(SUBMIT_SCRIPT, [
        spentTicketsKey(ticket.issuedAt),
        replaysKey(board),
        dailyIdsKey(board),
        boardKey(board),
        metaKey(board),
      ], [
        tokenId,
        fingerprint,
        id,
        String(score),
        JSON.stringify({ name: cleanName, date: today }),
        board.dailyDate ? '1' : '0',
        String(USED_TOKEN_TTL_SECONDS),
        String(board.dailyDate ? REPLAY_TTL_SECONDS : 0),
        String(DAILY_TTL_SECONDS),
      ]));
      if (!outcome) return unavailable();
      // A key this submission would have written holds another type. The
      // script checks before it writes, so nothing has been consumed: the
      // ticket, the fingerprint and the daily id are all still unspent and
      // the same submission lands once the key is repaired. That makes it a
      // database that cannot be used, not a score that was refused.
      if (outcome.status === 'storage') return unavailable();
      if (outcome.status === 'token' || outcome.status === 'replay') {
        return unverified(outcome.status);
      }
      entries = await readTop(redis, board);
      rank = await rankOf(redis, board, id);
    } catch {
      return unavailable();
    }

    // 'already' is a daily's second submission: the first one is the one that
    // counts, ranked or not, so this answers where the player stands rather
    // than refusing them.
    return new Response(JSON.stringify({
      rank,
      entries: publicEntries(entries, id),
    }), { headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
