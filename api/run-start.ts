import type { Difficulty } from '../src/core/Config';
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
 * `GET ?mode=daily` answers the same seed and date without a ticket, for
 * anything that wants to know today's deal without identifying itself. A
 * score cannot be posted from it: only the POST issues a token, and only a
 * token gets a run on the board.
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

function secret(): string | null {
  return process.env.ENCLAVE_SECRET || process.env.KV_REST_API_TOKEN || null;
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
    const dailyKey = todayKey();
    return new Response(
      JSON.stringify({ mode: 'daily', dailyKey, seed: await dailySeedFor(key, dailyKey) }),
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
  const payload: TicketPayload = {
    v: TICKET_VERSION,
    id,
    mode: mode as Difficulty,
    seed,
    ...(dailyKey ? { dailyKey } : {}),
    issuedAt: Date.now(),
  };

  return new Response(JSON.stringify({
    seed,
    token: await signTicket(key, payload),
    issuedAt: payload.issuedAt,
    ...(dailyKey ? { dailyKey } : {}),
  }), { headers });
}
