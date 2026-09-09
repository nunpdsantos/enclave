import { Redis } from '@upstash/redis';
import type { Difficulty } from '../src/core/Config';
import { dailyNumber } from '../src/core/Daily';
import { readBody } from '../src/core/RequestBody';
import { RULES_VERSION } from '../src/core/Rules';
import { dailySeedFor, signTicket, TICKET_VERSION, verifyTicket } from '../src/core/Ticket';
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
 * is issued normally and *stored*, under a key naming that id and that date;
 * a later ask is answered with the ticket already stored, so the attempt is
 * not re-spent by a reload, a second tab or a retried request. The old
 * arrangement counted the attempt at submission time, which meant a player
 * could take the deal, play it as many times as they liked and post only the
 * best of them.
 *
 * The record it kept was an `SADD` into a per-day set, and the answer came
 * from whether that write said "new". The REST client re-sends a request
 * whose response was lost, and the re-sent `SADD` says "already there" — so a
 * player's very first daily ticket could come back as practice because the
 * network dropped a reply. Storing the ticket instead makes the ask
 * idempotent: the same id asking twice gets back the same token, the same
 * seed and the same `issuedAt`, and a lost response costs nothing.
 *
 * A practice ticket — the real puzzle, playable, but unable to post a score —
 * is issued only when a ticket is already stored AND the client asks for a
 * new run outright (`{ practice: true }`, which is what the game sends once
 * it knows this browser has submitted today) or the stored one has outlived
 * the 24 hours a ticket is good for.
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

/** A stored ticket outlives its board, and both go eight days after the date */
const DAILY_TTL_SECONDS = 8 * 24 * 60 * 60;

/**
 * How long a ticket is good for. The same 24 hours `api/leaderboard.ts`
 * enforces on the way back in — a stored ticket past it cannot post a score
 * any more, so handing it back would be handing back nothing.
 */
const MAX_TICKET_AGE_MS = 24 * 60 * 60 * 1000;

/** A database that has stopped answering costs five seconds, not the request */
const REDIS_TIMEOUT_MS = 5000;

function secret(): string | null {
  return process.env.ENCLAVE_SECRET || process.env.KV_REST_API_TOKEN || null;
}

/** The client, or null when this deployment has no database configured. */
function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  // A factory, not a signal: the SDK calls it once per command, so each
  // command gets its own deadline rather than sharing one.
  return new Redis({ url, token, signal: () => AbortSignal.timeout(REDIS_TIMEOUT_MS) });
}

/**
 * The ticket this id was issued for this date, kept so the same ask gets the
 * same answer. Beside the board it belongs to, and versioned with it: a rules
 * bump starts the boards empty, and yesterday's attempts have no bearing.
 *
 * One key per id rather than one set per day, because the value matters: the
 * set could only say *that* an id had asked, which is not enough to answer a
 * second ask with the ticket the first one got.
 */
function dailyTicketKey(date: string, id: string): string {
  return `leaderboard:enclave:v${RULES_VERSION}:daily:${date}:ticket:${id}`;
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

  /** A ticket for this run, signed here and now. */
  const mint = async (practice: boolean): Promise<TicketPayload & { token: string }> => {
    const payload: TicketPayload = {
      v: TICKET_VERSION,
      id,
      mode: mode as Difficulty,
      seed,
      ...(dailyKey ? { dailyKey } : {}),
      ...(practice ? { practice: true as const } : {}),
      issuedAt: Date.now(),
    };
    return { ...payload, token: await signTicket(key, payload) };
  };

  const answer = (ticket: { seed: number; token: string; issuedAt: number }): Response =>
    new Response(JSON.stringify({
      seed: ticket.seed,
      token: ticket.token,
      issuedAt: ticket.issuedAt,
      ...(dailyKey ? { dailyKey } : {}),
    }), { headers });

  // Free play spends no attempt and keeps no record: the seed is drawn per
  // ticket, so two asks are two different runs and neither is the other's.
  if (!dailyKey) return answer(await mint(false));

  const candidate = await mint(false);
  const ticketKey = dailyTicketKey(dailyKey, id);
  try {
    // Constructed inside the guard: `new Redis` validates its own
    // configuration and throws on a malformed `KV_REST_API_URL`. Built above
    // this line, that throw walked past the catch below and rejected the
    // handler's promise — a 500 instead of the practice-free fallback ticket
    // every other unreachable-database path here answers with.
    const redis = getRedis();
    if (!redis) return answer(candidate);

    // NX and the TTL in one command. It used to be a write followed by an
    // EXPIRE, where a failed EXPIRE left the code deciding what to do about a
    // record that had already been written.
    const claimed = await redis.set(ticketKey, candidate.token, {
      nx: true, ex: DAILY_TTL_SECONDS,
    });
    // Nothing was stored for this id today: this ask is the attempt.
    if (claimed !== null) return answer(candidate);

    // Read once: the token that goes back has to be the one that was verified.
    const held = await redis.get<string>(ticketKey);
    const stored = await verifyTicket(key, held);
    // A stored value this secret did not sign, or one for another id or
    // another date, is not a ticket anybody can spend. Replace it rather than
    // charging the player an attempt for it.
    if (!held || !stored || stored.id !== id || stored.dailyKey !== dailyKey) {
      await redis.set(ticketKey, candidate.token, { ex: DAILY_TTL_SECONDS });
      return answer(candidate);
    }

    // The attempt is already spent, so a *new* run on today's deal is
    // practice: the real puzzle, played for real, and refused a score. Only
    // when the client says it wants one — or when the stored ticket has aged
    // past the 24 hours the leaderboard will accept, which leaves the player
    // nothing else to play.
    const wantsNewRun = body.practice === true
      || Date.now() - stored.issuedAt > MAX_TICKET_AGE_MS;
    if (wantsNewRun) return answer(await mint(true));

    // The same ask, answered the same way: same seed, same issue time, same
    // token. A reload, a second tab or a retried request costs nothing.
    return answer({ seed: stored.seed, token: held, issuedAt: stored.issuedAt });
  } catch {
    // Fails **open** — a normal ticket — when Redis does not answer. Refusing
    // to deal would take the daily away from every player for the duration of
    // an outage, and there is a second line of defence on the same database:
    // `api/leaderboard.ts` still refuses a second submission from an id that
    // has already posted today. An outage costs an extra *attempt*, never an
    // extra score.
    return answer(candidate);
  }
}
