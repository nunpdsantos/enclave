import { Redis } from '@upstash/redis';
import type { Difficulty } from '../src/core/Config';
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
 *    timing — and, on a daily, the per-day id set stop the same proven run
 *    from being banked more than once.
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
 * A six-hundred-move replay serialises to about 35 KB now that move times
 * are recorded unrounded, so 64 KB leaves room for the name, the id and the
 * ticket and still refuses anything that is not a run.
 */
const MAX_BODY_BYTES = 64 * 1024;
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
/** A used-token set covers one day of issued tickets, and outlives them */
const USED_TOKEN_TTL_SECONDS = 2 * 24 * 60 * 60;
/** A daily's replay fingerprints only have to outlive its board */
const REPLAY_TTL_SECONDS = 30 * 24 * 60 * 60;

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
 */
function usedTokensKey(issuedAt: number): string {
  return `leaderboard:enclave:used-tokens:${new Date(issuedAt).toISOString().slice(0, 10)}`;
}

function getRedis(): Redis {
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
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
    const entries = await readTop(getRedis(), board);
    return new Response(JSON.stringify(publicEntries(entries, askerId(request.url))), { headers });
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
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
    if (!secret) {
      return new Response(
        JSON.stringify({ error: 'Leaderboard unavailable' }), { status: 503, headers },
      );
    }

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

    const redis = getRedis();

    // One run per ticket. Everything above is a pure function of the request,
    // so a submission that fails any of it has spent nothing and can be
    // corrected; from here on the submission consumes state.
    const tokenId = String(body.token).split('.')[1] ?? String(body.token);
    const tokensKey = usedTokensKey(ticket.issuedAt);
    const tokenFresh = await redis.sadd(tokensKey, tokenId);
    if (tokenFresh === 0) return unverified('token');
    await redis.expire(tokensKey, USED_TOKEN_TTL_SECONDS);

    // One run per solution. A replay is a document: it verifies as well the
    // tenth time as the first, and on a daily — where every player is dealt
    // the same seed — a good one would otherwise be worth passing around.
    // The fingerprint is over the placements and not their timing, so the
    // same solution re-timed is still the same solution.
    const fingerprint = await replayFingerprint(replay);
    const seenKey = replaysKey(board);
    const replayFresh = await redis.sadd(seenKey, fingerprint);
    if (replayFresh === 0) return unverified('replay');
    if (board.dailyDate) await redis.expire(seenKey, REPLAY_TTL_SECONDS);

    const cleanName = name.trim().slice(0, 12) || 'Player';
    const today = new Date().toISOString().split('T')[0];

    if (board.dailyDate) {
      // First submission wins, and "first" means the first submission — not
      // the first one good enough to rank. The set is the record of who has
      // played today, so a score outside the top ten still closes the day for
      // that player instead of leaving them free to grind for a better one.
      //
      // The day is really closed a step earlier now, when `api/run-start.ts`
      // hands over the deal: a second daily ticket for the same id and date
      // is a practice ticket and is refused above. This set is the second
      // line of defence, and the one that still works if that write did not.
      const idsKey = dailyIdsKey(board);
      const firstToday = await redis.sadd(idsKey, id);
      await redis.expire(idsKey, DAILY_TTL_SECONDS);
      if (firstToday === 0) {
        const standing = await readTop(redis, board);
        return new Response(JSON.stringify({
          rank: await rankOf(redis, board, id),
          entries: publicEntries(standing, id),
        }), { headers });
      }

      // NX: whatever lands first stands, decided by Redis rather than by
      // which of two concurrent submissions read the board last.
      await redis.zadd(boardKey(board), { nx: true }, { score, member: id });
      await redis.hset(metaKey(board), { [id]: JSON.stringify({ name: cleanName, date: today }) });
      // Refreshed on every write rather than set once, so a board stays alive
      // for eight days from its last score and never outlives its usefulness.
      await redis.expire(boardKey(board), DAILY_TTL_SECONDS);
      await redis.expire(metaKey(board), DAILY_TTL_SECONDS);
    } else {
      // GT: the entry moves only if this score beats the one already there,
      // in one atomic step. CH tells us whether it moved, which is what
      // decides if the name and date beside it should follow.
      const changed = await redis.zadd(
        boardKey(board), { gt: true, ch: true }, { score, member: id },
      );
      if (changed) {
        await redis.hset(metaKey(board), { [id]: JSON.stringify({ name: cleanName, date: today }) });
      }
    }

    const entries = await readTop(redis, board);
    return new Response(JSON.stringify({
      rank: await rankOf(redis, board, id),
      entries: publicEntries(entries, id),
    }), { headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
