import { Redis } from '@upstash/redis';
import type { Difficulty } from '../src/core/Config';
import { dailyNumber } from '../src/core/Daily';
import { RULES_VERSION } from '../src/core/Rules';
import { dailySeedFor, signTicket, TICKET_VERSION } from '../src/core/Ticket';
import type { TicketPayload } from '../src/core/Ticket';

export const config = { runtime: 'edge' };

/**
 * The start of a run.
 *
 * `POST { id, mode }` hands back the deal the run will be played from and a
 * signed ticket that says so. The seed is not the client's to choose any
 * more: for Classic and Blitz the server draws 32 random bits, and for the
 * Daily it derives them from its own secret, so nobody can deal themselves
 * next Tuesday's puzzle and spend the week on it.
 *
 * The ticket is what `api/leaderboard.ts` checks on the way back in. It binds
 * the seed to one player id and one clock reading, which is how a submission
 * can be refused for claiming more play than has actually happened.
 *
 * **A daily ticket is the attempt.** The first one an id asks for on a date
 * is issued normally and the id goes into that day's ticket set; every later
 * one is issued `practice: true`, plays the real puzzle, and cannot post a
 * score. The old arrangement counted the attempt at submission time, which
 * meant a player could take the deal, play it as many times as they liked
 * and post only the best of them.
 *
 * `GET ?mode=daily` answers which day it is and nothing else. It used to
 * answer the seed too, without a ticket — which handed the shared deal to
 * anybody who asked, so a solved daily could be posted from a fresh id that
 * had never spent an attempt on it. The deal now comes out of the POST, with
 * the ticket that spends the attempt, like every other mode.
 *
 * The secret is `ENCLAVE_SECRET`, falling back to `KV_REST_API_TOKEN` — which
 * is already a server-only secret that has to be set for the leaderboard to
 * work at all, so the fallback means tickets work on an existing deployment
 * with nothing new configured. Set `ENCLAVE_SECRET` to rotate ticket signing
 * without rotating the database credential; note that changing either one
 * changes every daily seed, so rotate at a UTC midnight.
 */

const VALID_MODES: Difficulty[] = ['classic', 'blitz', 'daily'];

/**
 * An id is a client-minted opaque string (a UUID in practice). Bounded and
 * free of whitespace, because it becomes a Redis sorted-set member and a set
 * member, and an unbounded one would be a way to write junk into both.
 */
const MAX_ID_LENGTH = 64;
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Small enough that a body this endpoint has no use for is refused early */
const MAX_BODY_BYTES = 2048;

/** The ticket set outlives its board, and both go eight days after the date */
const DAILY_TTL_SECONDS = 8 * 24 * 60 * 60;

function secret(): string | null {
  return process.env.ENCLAVE_SECRET || process.env.KV_REST_API_TOKEN || null;
}

/**
 * Every id handed a daily deal on that date, whether or not a score came
 * back. Beside the board it belongs to, and versioned with it: a rules bump
 * starts the boards empty, and yesterday's attempts have no bearing on them.
 */
function dailyTicketsKey(date: string): string {
  return `leaderboard:enclave:v${RULES_VERSION}:daily:${date}:tickets`;
}

/**
 * Record that this id has been dealt this date, and answer whether it had
 * already been recorded — so the answer is "no" exactly once per id per day.
 *
 * Fails **open** — a normal ticket — when Redis is not configured or does not
 * answer. Refusing to deal would take the daily away from every player for
 * the duration of an outage, and there is a second line of defence that runs
 * on the same database: `api/leaderboard.ts` still refuses a second
 * submission from an id that has already posted today. What an outage can
 * cost is an extra *attempt*, not an extra score.
 */
async function dailyAttemptAlreadySpent(date: string, id: string): Promise<boolean> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  try {
    const redis = new Redis({ url, token });
    const key = dailyTicketsKey(date);
    const fresh = await redis.sadd(key, id);
    await redis.expire(key, DAILY_TTL_SECONDS);
    return fresh === 0;
  } catch {
    return false;
  }
}

/** 'YYYY-MM-DD' in UTC — the puzzle everybody is on right now */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A fresh 32-bit deal for free play, from the platform's CSPRNG. */
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
}

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_ID_LENGTH && ID_RE.test(id);
}

export default async function handler(request: Request): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  const key = secret();
  if (!key) {
    return new Response(JSON.stringify({ error: 'Tickets unavailable' }), { status: 503, headers });
  }

  if (request.method === 'GET') {
    const mode = new URL(request.url).searchParams.get('mode') || 'daily';
    // Free play has nothing to read: its seed is drawn per ticket, and a seed
    // with no ticket behind it cannot be posted anywhere.
    if (mode !== 'daily') {
      return new Response(JSON.stringify({ error: 'Ticket required' }), { status: 400, headers });
    }
    // Which day it is, and no deal. The seed used to come back here, which
    // meant the shared puzzle could be taken, solved at leisure and posted
    // from an id that had never asked for a ticket on it. Anything that wants
    // to play today's daily asks for a ticket like everybody else.
    const dailyKey = todayKey();
    return new Response(
      JSON.stringify({ mode: 'daily', dailyKey, number: dailyNumber(dailyKey) }),
      { headers },
    );
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
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
  // null, an array and a primitive all parse: none of them is a request
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new Response(JSON.stringify({ error: 'Invalid data' }), { status: 400, headers });
  }
  const body = parsed as Record<string, unknown>;

  const id = body.id;
  const mode = body.mode;
  if (!isValidId(id) || typeof mode !== 'string' || !VALID_MODES.includes(mode as Difficulty)) {
    return new Response(JSON.stringify({ error: 'Invalid data' }), { status: 400, headers });
  }

  const dailyKey = mode === 'daily' ? todayKey() : undefined;
  const seed = dailyKey ? await dailySeedFor(key, dailyKey) : randomSeed();
  // Asking for the deal is what spends the attempt. A second ask still gets
  // today's real puzzle — replaying it is allowed and always was — but its
  // ticket says practice, and the leaderboard will not take a score from it.
  const practice = dailyKey ? await dailyAttemptAlreadySpent(dailyKey, id) : false;
  const payload: TicketPayload = {
    v: TICKET_VERSION,
    id,
    mode: mode as Difficulty,
    seed,
    ...(dailyKey ? { dailyKey } : {}),
    ...(practice ? { practice: true as const } : {}),
    issuedAt: Date.now(),
  };

  return new Response(JSON.stringify({
    seed,
    token: await signTicket(key, payload),
    issuedAt: payload.issuedAt,
    ...(dailyKey ? { dailyKey } : {}),
  }), { headers });
}
