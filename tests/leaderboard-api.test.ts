import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createServer, Server } from 'node:http';
import { Redis } from '@upstash/redis';
import { Difficulty, DIFFICULTY_CONFIGS } from '../src/core/Config';
import { dailyNumber, dailySeed } from '../src/core/Daily';
import { drainIntegral, simulateRun } from '../src/core/Replay';
import { readBody } from '../src/core/RequestBody';
import { RULES_VERSION } from '../src/core/Rules';
import { dailySeedFor, readTicketPayload, replayFingerprint, signTicket, TICKET_VERSION } from '../src/core/Ticket';
import { GRID_SIZE, Move, PlacedPiece, Replay } from '../src/core/types';
import { BotRun, playBotRun } from './helpers';

/**
 * The leaderboard endpoint end to end.
 *
 * `api/` sits outside tsconfig's `include`, so the build never type-checks it
 * — this is what stands between a validation mistake and production. Redis is
 * a local in-memory stub speaking the Upstash REST protocol, so the test needs
 * no credentials and no network.
 *
 * Three things matter here. That the daily's rules (a board per UTC date, a
 * TTL, no back-filling, first submission wins) did not disturb Classic or
 * Blitz. That no score gets on any board without a replay the server can
 * re-play to exactly that number. And that no replay gets on a board without
 * a run ticket: a signed statement that this player was dealt this seed at a
 * moment far enough in the past for the run to have been played.
 */

// ── The stub: an in-memory Redis speaking Upstash's REST protocol ──

type StubValue =
  | { kind: 'string'; value: string }
  | { kind: 'zset'; members: Map<string, number> }
  | { kind: 'hash'; fields: Map<string, string> }
  | { kind: 'set'; members: Set<string> };

const store = new Map<string, StubValue>();
/** Every TTL the handler set, in order, by EXPIRE or by SET ... EX */
const expires: [string, number][] = [];
/** Every command the handler issued, in order, by name */
const commands: string[] = [];
/**
 * The name of one command whose response is to be thrown away.
 *
 * The command still runs — this is a *lost response*, not a lost write, which
 * is the failure the REST client's own retry turns into a second execution of
 * a command that has already happened. Cleared once it has fired.
 */
let dropResponseFor: string | null = null;
/** While true the server accepts requests and never answers them */
let hangForever = false;
/**
 * When set, every command is answered with this Redis error, in the shape the
 * REST API sends one: HTTP 500 and `{ error }`, which the SDK turns into a
 * thrown `UpstashError`.
 */
let failWith: string | null = null;
/** Responses being held open by `hangForever`, so they can be torn down */
const hung: { destroy: () => void }[] = [];
let server: Server;
let base = '';

/**
 * Redis holds one type per key and refuses any other command against it. The
 * stub used to quietly overwrite instead, so no test could ever see the
 * failure `SUBMIT_SCRIPT`'s type gate exists for — a wrong-typed key simply
 * became the right type, and a broken database looked like a working one.
 */
function requireType(key: string, kind: StubValue['kind']): void {
  const existing = store.get(key);
  if (existing && existing.kind !== kind) {
    throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
  }
}

// Reads never create the key — Redis has no empty collections, and a stub
// that conjured one would put keys in `store` that the handler never wrote.
function readZset(key: string): Map<string, number> {
  requireType(key, 'zset');
  const existing = store.get(key);
  return existing?.kind === 'zset' ? existing.members : new Map();
}

function readHash(key: string): Map<string, string> {
  requireType(key, 'hash');
  const existing = store.get(key);
  return existing?.kind === 'hash' ? existing.fields : new Map();
}

function readSet(key: string): Set<string> {
  requireType(key, 'set');
  const existing = store.get(key);
  return existing?.kind === 'set' ? existing.members : new Set();
}

function zsetAt(key: string): Map<string, number> {
  requireType(key, 'zset');
  const existing = store.get(key);
  if (existing?.kind === 'zset') return existing.members;
  const members = new Map<string, number>();
  store.set(key, { kind: 'zset', members });
  return members;
}

function hashAt(key: string): Map<string, string> {
  requireType(key, 'hash');
  const existing = store.get(key);
  if (existing?.kind === 'hash') return existing.fields;
  const fields = new Map<string, string>();
  store.set(key, { kind: 'hash', fields });
  return fields;
}

function setAt(key: string): Set<string> {
  requireType(key, 'set');
  const existing = store.get(key);
  if (existing?.kind === 'set') return existing.members;
  const members = new Set<string>();
  store.set(key, { kind: 'set', members });
  return members;
}

/**
 * A sorted set in ZRANGE ... REV order: score descending, and members of
 * equal score in reverse lexicographic order, exactly as Redis orders them.
 */
function revOrder(key: string): [string, number][] {
  return [...readZset(key).entries()].sort(
    (a, b) => (b[1] - a[1]) || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0),
  );
}

/** ZADD, with the NX / GT / CH flags the handler actually uses. */
function zadd(cmd: unknown[]): number {
  const key = String(cmd[1]);
  const flags = new Set<string>();
  let i = 2;
  for (; i < cmd.length; i++) {
    const token = String(cmd[i]).toLowerCase();
    if (!['nx', 'xx', 'ch', 'incr', 'lt', 'gt'].includes(token)) break;
    flags.add(token);
  }
  const members = zsetAt(key);
  let added = 0;
  let changed = 0;
  for (; i + 1 < cmd.length; i += 2) {
    const score = Number(cmd[i]);
    const member = String(cmd[i + 1]);
    const current = members.get(member);
    if (current === undefined) {
      if (flags.has('xx')) continue;
      members.set(member, score);
      added++;
      changed++;
      continue;
    }
    if (flags.has('nx')) continue;
    if (flags.has('gt') && !(score > current)) continue;
    if (flags.has('lt') && !(score < current)) continue;
    if (current !== score) {
      members.set(member, score);
      changed++;
    }
  }
  return flags.has('ch') ? changed : added;
}

function zrange(cmd: unknown[]): string[] {
  const key = String(cmd[1]);
  const start = Number(cmd[2]);
  const stop = Number(cmd[3]);
  const opts = cmd.slice(4).map(o => String(o).toLowerCase());
  const ordered = opts.includes('rev')
    ? revOrder(key)
    : revOrder(key).reverse();
  const end = stop < 0 ? ordered.length + stop + 1 : stop + 1;
  const slice = ordered.slice(start, end);
  // The REST API answers in strings; the SDK is what turns a score back into
  // a number, so a stub that returned numbers would be testing less than the
  // real thing does.
  return opts.includes('withscores')
    ? slice.flatMap(([member, score]) => [member, String(score)])
    : slice.map(([member]) => member);
}

/**
 * The REST API answers bulk strings base64-encoded, because the SDK asks it
 * to with an `Upstash-Encoding: base64` header and decodes every string it
 * gets back. A stub that answered in plain text would be relying on the
 * SDK's decoder throwing and falling through — which it does for JSON, and
 * does not for a short member name like `p1`, which is valid base64 and
 * comes back as two bytes of noise. Numbers and the simple-string OK go as
 * they are, exactly as the real service sends them.
 */
function encodeResult(value: unknown): unknown {
  if (typeof value === 'string') {
    return value === 'OK' ? 'OK' : Buffer.from(value, 'utf8').toString('base64');
  }
  if (Array.isArray(value)) return value.map(encodeResult);
  return value;
}

/** One Redis command, as the REST protocol delivers it. */
function execute(cmd: unknown[]): unknown {
  const name = String(cmd[0]).toLowerCase();
  const key = String(cmd[1]);
  switch (name) {
    case 'get': {
      requireType(key, 'string');
      const value = store.get(key);
      return value?.kind === 'string' ? value.value : null;
    }
    // The four kinds this stub holds are named exactly as Redis names them,
    // and a key that is not there is 'none' rather than an error.
    case 'type':
      return store.get(key)?.kind ?? 'none';
    // SET with the flags the ticket store uses: NX answers null rather than
    // OK when the key is already there, and EX is the TTL in the same command
    // — which is the whole point of it, there being no second command whose
    // failure could leave a stored ticket with no expiry.
    case 'set': {
      const opts = cmd.slice(3).map(o => String(o).toLowerCase());
      if (opts.includes('nx') && store.has(key)) return null;
      if (opts.includes('xx') && !store.has(key)) return null;
      const ex = opts.indexOf('ex');
      if (ex !== -1) expires.push([key, Number(opts[ex + 1])]);
      store.set(key, { kind: 'string', value: String(cmd[2]) });
      return 'OK';
    }
    case 'expire':
      expires.push([key, Number(cmd[2])]);
      return store.has(key) ? 1 : 0;
    case 'zadd':
      return zadd(cmd);
    case 'zrange':
      return zrange(cmd);
    case 'zscore': {
      const score = readZset(key).get(String(cmd[2]));
      return score === undefined ? null : String(score);
    }
    case 'zrevrank': {
      const index = revOrder(key).findIndex(([m]) => m === String(cmd[2]));
      return index === -1 ? null : index;
    }
    case 'hset': {
      const fields = hashAt(key);
      let added = 0;
      for (let i = 2; i + 1 < cmd.length; i += 2) {
        if (!fields.has(String(cmd[i]))) added++;
        fields.set(String(cmd[i]), String(cmd[i + 1]));
      }
      return added;
    }
    case 'hget':
      return readHash(key).get(String(cmd[2])) ?? null;
    case 'hmget': {
      const fields = readHash(key);
      return cmd.slice(2).map(f => fields.get(String(f)) ?? null);
    }
    case 'eval': {
      // Two scripts run against this stub. Dispatch on what the script says
      // about itself rather than on the shape of its arguments, so a third
      // one cannot quietly be answered by the wrong transcription.
      const script = String(cmd[1]);
      return script.includes('enclave:claim-ticket') ? evalClaimTicket(cmd) : evalSubmit(cmd);
    }
    case 'sadd': {
      const members = setAt(key);
      let added = 0;
      for (const m of cmd.slice(2)) {
        if (!members.has(String(m))) {
          members.add(String(m));
          added++;
        }
      }
      return added;
    }
    case 'sismember':
      return readSet(key).has(String(cmd[2])) ? 1 : 0;
    default:
      return 'OK';
  }
}

/**
 * `SUBMIT_SCRIPT`, in TypeScript.
 *
 * A line-for-line transcription of the Lua in `api/leaderboard.ts`: the same
 * commands, in the same order, with the same branches and the same return.
 * Every step goes back through `execute`, so the script and the plain
 * commands share one implementation of SADD, ZADD, HSET and EXPIRE rather
 * than agreeing by coincidence — and `the script the stub mirrors` below
 * checks the Lua still calls exactly these and nothing more, so a command
 * added to the script and not to this function fails the build.
 *
 * Redis runs a script to completion before anything else runs, and the stub
 * is single-threaded, so the atomicity is faithful too.
 */
function evalSubmit(cmd: unknown[]): unknown[] {
  const keyCount = Number(cmd[2]);
  const keys = cmd.slice(3, 3 + keyCount).map(String);
  const argv = cmd.slice(3 + keyCount).map(String);
  const [spentKey, replaysKey, idsKey, boardKey, metaKey] = keys;
  const [tokenId, fingerprint, id, score, meta, isDaily, tokenTtl, replayTtl, boardTtl] = argv;

  // The type gate, before a single write, exactly as the Lua does it: a
  // script is atomic but it is not a transaction, so a WRONGTYPE raised
  // halfway through would leave the writes before it standing.
  const wrongType = (key: string, want: StubValue['kind']): boolean => {
    const kind = String(execute(['type', key]));
    return kind !== 'none' && kind !== want;
  };
  if (wrongType(spentKey, 'hash') || wrongType(boardKey, 'zset') || wrongType(metaKey, 'hash')
    || (fingerprint !== '' && wrongType(replaysKey, 'set'))
    || (isDaily === '1' && wrongType(idsKey, 'set'))) {
    return ['storage', 0];
  }

  const identity = `${score}|${fingerprint}|${boardKey}|${id}`;
  const spent = execute(['hget', spentKey, tokenId]);
  if (typeof spent === 'string') {
    const cut = spent.indexOf('|');
    if (cut !== -1 && spent.slice(cut + 1) === identity) return [spent.slice(0, cut), 0];
    return ['token', 0];
  }

  let status = 'ok';
  let changed = 0;

  if (fingerprint !== '') {
    if (execute(['sadd', replaysKey, fingerprint]) === 0) status = 'replay';
    else if (Number(replayTtl) > 0) execute(['expire', replaysKey, replayTtl]);
  }

  if (status === 'ok') {
    if (isDaily === '1') {
      const first = execute(['sadd', idsKey, id]);
      execute(['expire', idsKey, boardTtl]);
      if (first === 0) {
        status = 'already';
      } else {
        changed = Number(execute(['zadd', boardKey, 'NX', 'CH', score, id]));
        if (changed === 1) execute(['hset', metaKey, id, meta]);
        execute(['expire', boardKey, boardTtl]);
        execute(['expire', metaKey, boardTtl]);
      }
    } else {
      changed = Number(execute(['zadd', boardKey, 'GT', 'CH', score, id]));
      if (changed === 1) execute(['hset', metaKey, id, meta]);
    }
  }

  execute(['hset', spentKey, tokenId, `${status}|${identity}`]);
  execute(['expire', spentKey, tokenTtl]);
  return [status, changed];
}

/**
 * `CLAIM_TICKET_SCRIPT`, in TypeScript.
 *
 * Same discipline as `evalSubmit`: every step goes back through `execute`, so
 * the script and the plain commands share one implementation of GET and SET.
 */
function evalClaimTicket(cmd: unknown[]): string {
  const keyCount = Number(cmd[2]);
  const [key] = cmd.slice(3, 3 + keyCount).map(String);
  const [read, replacement, ttl] = cmd.slice(3 + keyCount).map(String);
  const current = execute(['get', key]);
  if (current === null || current === read) {
    execute(['set', key, replacement, 'ex', ttl]);
    return replacement;
  }
  return String(current);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const parsed = JSON.parse(raw) as unknown[];
      // The SDK auto-pipelines, so a body may be one command or a list of them.
      const pipelined = Array.isArray(parsed[0]);
      const cmds = (pipelined ? parsed : [parsed]) as unknown[][];
      // A database that has stopped answering: the request is accepted, the
      // commands never run, and the client is left on its own deadline.
      if (hangForever) {
        hung.push(res);
        return;
      }
      if (failWith) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: failWith }));
        return;
      }
      for (const cmd of cmds) commands.push(String(cmd[0]).toLowerCase());
      let results;
      try {
        results = cmds.map(cmd => ({ result: encodeResult(execute(cmd)) }));
      } catch (e) {
        // A command against a key of the wrong type, as the REST API answers
        // one: HTTP 500 and `{ error }`, which the SDK throws as UpstashError.
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        return;
      }
      // The command has run and its effects stand; only the answer is lost.
      // This is what makes the SDK re-send, and re-sending is what the
      // handler has to survive.
      if (dropResponseFor && cmds.some(c => String(c[0]).toLowerCase() === dropResponseFor)) {
        dropResponseFor = null;
        res.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pipelined ? results : results[0]));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.KV_REST_API_URL = base;
  process.env.KV_REST_API_TOKEN = SECRET;
  delete process.env.ENCLAVE_SECRET;
});

afterAll(() => {
  // A response left hanging holds its socket open, and an open socket keeps
  // `close` waiting for a connection that is never going to end.
  for (const res of hung.splice(0)) res.destroy();
  server.close();
});

beforeEach(() => {
  store.clear();
  expires.length = 0;
  commands.length = 0;
  dropResponseFor = null;
  hangForever = false;
  failWith = null;
  for (const res of hung.splice(0)) res.destroy();
});

async function handler() {
  return (await import('../api/leaderboard')).default;
}

async function runStartHandler() {
  return (await import('../api/run-start')).default;
}

const URL_BASE = 'https://x/api/leaderboard';

function get(difficulty: string, id?: string): Request {
  const asker = id ? `&id=${encodeURIComponent(id)}` : '';
  return new Request(`${URL_BASE}?difficulty=${encodeURIComponent(difficulty)}${asker}`);
}

function post(difficulty: string, body: unknown): Request {
  return new Request(`${URL_BASE}?difficulty=${encodeURIComponent(difficulty)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function startRun(body: unknown): Request {
  return new Request('https://x/api/run-start', { method: 'POST', body: JSON.stringify(body) });
}

/** A UTC date `days` before today, in the form the API expects */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// ── Tickets ──

/**
 * The secret the handler signs with. With no ENCLAVE_SECRET set it falls
 * back to KV_REST_API_TOKEN, which is the deployment this test simulates:
 * an existing project that got tickets without configuring anything new.
 */
const SECRET = 'fake';

/**
 * How long before "now" a test's ticket was issued.
 *
 * A run cannot be played faster than real time, so the ticket has to predate
 * the last move of the run it vouches for. Ten minutes is past every run
 * these tests play and well inside the ticket's own 24-hour life.
 */
const TICKET_AGE_MS = 10 * 60 * 1000;

interface TicketOverrides {
  id?: string;
  mode?: Difficulty;
  seed?: number;
  dailyKey?: string;
  issuedAt?: number;
}

/** A ticket the server would have signed for this run. */
async function ticketFor(r: BotRun, id: string, over: TicketOverrides = {}): Promise<string> {
  const dailyKey = over.dailyKey ?? r.replay.dailyKey;
  return signTicket(SECRET, {
    v: TICKET_VERSION,
    id: over.id ?? id,
    mode: over.mode ?? r.replay.mode,
    seed: over.seed ?? r.replay.seed,
    ...(dailyKey ? { dailyKey } : {}),
    issuedAt: over.issuedAt ?? Date.now() - TICKET_AGE_MS,
  });
}

// ── Runs, so every submission is one that could really have happened ──

const played = new Map<string, BotRun>();

/**
 * A run of `moves` inputs, played once and remembered. Longer runs always
 * score more — every placement pays at least its blocks — so the move count
 * is how these tests order two scores without inventing either of them.
 */
function run(mode: Difficulty, moves: number, seed: number = 12_345): BotRun {
  const key = `${mode}:${seed}:${moves}`;
  const existing = played.get(key);
  if (existing) return existing;
  const fresh = playBotRun(mode, seed, moves);
  played.set(key, fresh);
  return fresh;
}

/**
 * A run of a particular daily. The deal belongs to the date, so the replay
 * carries both and the ticket the server signed names both — which is also
 * how a run that crossed midnight still posts to the board it was dealt from.
 *
 * The seed here is the public date hash, which is no longer the deal a live
 * daily is played from (that one is derived from the server's secret). It
 * does not have to be: what the server checks is that the replay's seed is
 * the seed its own ticket issued, and these tickets say so.
 */
function dailyRun(date: string, moves: number): BotRun {
  const key = `daily:${date}:${moves}`;
  const existing = played.get(key);
  if (existing) return existing;
  const fresh = playBotRun('daily', dailySeed(date), moves);
  const dated: BotRun = { ...fresh, replay: { ...fresh.replay, dailyKey: date } };
  played.set(key, dated);
  return dated;
}

/** The body a current client sends: a score, the log that proves it, the ticket. */
async function body(
  r: BotRun, id: string, name: string, over: TicketOverrides = {},
): Promise<Record<string, unknown>> {
  return { id, name, score: r.score, replay: r.replay, token: await ticketFor(r, id, over) };
}

const CLASSIC_KEY = `leaderboard:enclave:v${RULES_VERSION}:classic`;
const BLITZ_KEY = `leaderboard:enclave:v${RULES_VERSION}:blitz`;
const DAILY_TTL = 8 * 24 * 60 * 60;

function dailyKeyFor(date: string): string {
  return `leaderboard:enclave:v${RULES_VERSION}:daily:${date}`;
}

/** The board as stored: id → score, in board order. */
function storedBoard(key: string): [string, number][] {
  return revOrder(key);
}

/** The name and date stored beside an id. */
function storedMeta(key: string, id: string): { name?: string; date?: string } {
  const raw = readHash(`${key}:meta`).get(id);
  return raw ? JSON.parse(raw) : {};
}

/** A plain string value, or null where there is none. */
function storedString(key: string): string | null {
  const value = store.get(key);
  return value?.kind === 'string' ? value.value : null;
}

function expiresFor(key: string): number[] {
  return expires.filter(([k]) => k === key).map(([, ttl]) => ttl);
}

describe('api/leaderboard — classic and blitz are untouched', () => {
  it('takes a first score, then lets the same id beat itself', async () => {
    const h = await handler();
    const modest = run('classic', 8);
    const better = run('classic', 16);
    const worse = run('classic', 4);
    expect(worse.score).toBeLessThan(modest.score);
    expect(better.score).toBeGreaterThan(modest.score);

    const first = await h(post('classic', await body(modest, 'p1', 'Ann')));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ rank: 1 });

    const up = await h(post('classic', await body(better, 'p1', 'Ann')));
    const upBody = await up.json();
    expect(upBody.rank).toBe(1);
    expect(upBody.entries).toHaveLength(1);
    expect(upBody.entries[0].score).toBe(better.score);

    // A worse run leaves the entry alone and reports where they already stand
    const down = await h(post('classic', await body(worse, 'p1', 'Ann')));
    const downBody = await down.json();
    expect(downBody.rank).toBe(1);
    expect(downBody.entries[0].score).toBe(better.score);
  });

  it('orders entries and reads them back on GET', async () => {
    const h = await handler();
    await h(post('classic', await body(run('classic', 6), 'p1', 'Ann')));
    await h(post('classic', await body(run('classic', 18), 'p2', 'Bo')));

    const res = await h(get('classic'));
    expect(res.status).toBe(200);
    const entries = await res.json();
    expect(entries.map((e: { name: string }) => e.name)).toEqual(['Bo', 'Ann']);
  });

  it('never sets a TTL on a permanent board', async () => {
    const h = await handler();
    await h(post('classic', await body(run('classic', 8), 'p1', 'Ann')));
    await h(post('blitz', await body(run('blitz', 8), 'p1', 'Ann')));

    expect(storedBoard(CLASSIC_KEY)).toHaveLength(1);
    expect(storedBoard(BLITZ_KEY)).toHaveLength(1);
    for (const key of [CLASSIC_KEY, BLITZ_KEY, `${CLASSIC_KEY}:meta`, `${BLITZ_KEY}:meta`]) {
      expect(`${key}:${expiresFor(key).length}`).toBe(`${key}:0`);
    }
  });

  it('still falls back to classic for an unrecognised mode', async () => {
    const h = await handler();
    const res = await h(post('zen', await body(run('classic', 8), 'p1', 'Ann')));
    expect(res.status).toBe(200);
    expect(storedBoard(CLASSIC_KEY)).toHaveLength(1);
  });

  it('rejects other methods with 405', async () => {
    const h = await handler();
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      expect((await h(new Request(URL_BASE, { method }))).status).toBe(405);
    }
  });
});

describe('api/leaderboard — the score has to be provable', () => {
  it('stores a score its replay re-plays to', async () => {
    const h = await handler();
    const played = run('classic', 12);
    const res = await h(post('classic', await body(played, 'p1', 'Ann')));

    expect(res.status).toBe(200);
    expect(storedBoard(CLASSIC_KEY)).toEqual([['p1', played.score]]);
    expect(storedMeta(CLASSIC_KEY, 'p1').name).toBe('Ann');
  });

  it('tells a client with no replay to update, and stores nothing', async () => {
    const h = await handler();
    const played = run('classic', 12);
    const res = await h(post('classic', { id: 'p1', name: 'Ann', score: played.score }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Update required' });
    expect(store.size).toBe(0);
  });

  it('tells a client with a replay but no ticket to update', async () => {
    const h = await handler();
    const played = run('classic', 12);
    const res = await h(post('classic', {
      id: 'p1', name: 'Ann', score: played.score, replay: played.replay,
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Update required' });
    expect(store.size).toBe(0);
  });

  it('refuses a score the replay does not produce', async () => {
    const h = await handler();
    const played = run('classic', 12);
    for (const score of [played.score + 1, played.score * 10, 1]) {
      const res = await h(post('classic', { ...await body(played, 'p1', 'Ann'), score }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'score' });
    }
    expect(store.size).toBe(0);
  });

  it('refuses an oversized body while it is arriving, not after', async () => {
    const h = await handler();
    const played = run('classic', 12);
    const res = await h(post('classic', {
      ...await body(played, 'p1', 'Ann'), pad: 'x'.repeat(200_000),
    }));

    // 413, and nothing was parsed: the reader is cancelled at the first byte
    // past the cap rather than buffering the whole body to measure it.
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Body too large' });
    expect(store.size).toBe(0);
  });

  it('refuses another rules version, a mismatched board, and a truncated log', async () => {
    const h = await handler();
    const classic = run('classic', 12);

    const stale = {
      ...await body(classic, 'p1', 'Ann'),
      replay: { ...classic.replay, rules: RULES_VERSION + 1 },
    };
    expect(await (await h(post('classic', stale))).json())
      .toEqual({ error: 'Score could not be verified', reason: 'rules' });

    // A Blitz run is not a Classic score, whatever board it is posted to
    const blitz = run('blitz', 12);
    const wrongBoard = { ...await body(blitz, 'p1', 'Ann'), replay: blitz.replay };
    expect(await (await h(post('classic', wrongBoard))).json())
      .toEqual({ error: 'Score could not be verified', reason: 'shape' });

    const cut = {
      ...await body(classic, 'p1', 'Ann'),
      replay: { ...classic.replay, truncated: true },
    };
    expect(await (await h(post('classic', cut))).json())
      .toEqual({ error: 'Score could not be verified', reason: 'shape' });

    // A move off the board never reaches the simulation
    const offBoard = {
      ...await body(classic, 'p1', 'Ann'),
      replay: { ...classic.replay, moves: [{ t: 'p', row: 9, col: 0, rot: 0, at: 0.1 }] },
    };
    expect(await (await h(post('classic', offBoard))).json())
      .toEqual({ error: 'Score could not be verified', reason: 'shape' });

    expect(store.size).toBe(0);
  });

  it('refuses a run that sat out the clock', async () => {
    const h = await handler();
    const played = run('classic', 12);
    // The same inputs, resumed long after a Classic bank could have lasted
    const stalled = played.replay.moves.map((m, i) => (i < 6 ? m : { ...m, at: m.at + 180 }));
    const res = await h(post('classic', {
      ...await body(played, 'p1', 'Ann'),
      replay: { ...played.replay, moves: stalled },
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'clock' });
  });
});

describe('api/leaderboard — the daily', () => {
  it('accepts today, stores it under a dated key, and expires it', async () => {
    const h = await handler();
    const today = daysAgo(0);

    const res = await h(post(`daily-${today}`, await body(dailyRun(today, 12), 'p1', 'Ann')));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rank: 1 });

    const key = dailyKeyFor(today);
    expect(storedBoard(key)).toEqual([['p1', dailyRun(today, 12).score]]);
    expect(expiresFor(key)).toEqual([DAILY_TTL]);
    expect(expiresFor(`${key}:meta`)).toEqual([DAILY_TTL]);
    expect(expiresFor(`${key}:ids`)).toEqual([DAILY_TTL]);
  });

  it('keeps the first submission even when a later one is higher', async () => {
    const h = await handler();
    const today = daysAgo(0);
    const early = dailyRun(today, 8);
    const late = dailyRun(today, 28);
    expect(late.score).toBeGreaterThan(early.score);

    await h(post(`daily-${today}`, await body(early, 'p1', 'Ann')));
    const second = await h(post(`daily-${today}`, await body(late, 'p1', 'Ann')));

    const secondBody = await second.json();
    expect(secondBody.rank).toBe(1);
    expect(secondBody.entries).toHaveLength(1);
    expect(secondBody.entries[0].score).toBe(early.score);
    expect(storedBoard(dailyKeyFor(today))).toEqual([['p1', early.score]]);
  });

  it('still ranks a different player behind the first', async () => {
    const h = await handler();
    const today = daysAgo(0);
    await h(post(`daily-${today}`, await body(dailyRun(today, 8), 'p1', 'Ann')));
    const res = await h(post(`daily-${today}`, await body(dailyRun(today, 20), 'p2', 'Bo')));

    const resBody = await res.json();
    expect(resBody.rank).toBe(1);
    expect(resBody.entries.map((e: { name: string }) => e.name)).toEqual(['Bo', 'Ann']);
  });

  it('accepts yesterday, for a run that crossed midnight', async () => {
    const h = await handler();
    const yesterday = daysAgo(1);

    const posted = await h(post(`daily-${yesterday}`, await body(dailyRun(yesterday, 10), 'p1', 'Ann')));
    expect(posted.status).toBe(200);

    const res = await h(get(`daily-${yesterday}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it('refuses a daily replay dealt from another day', async () => {
    const h = await handler();
    const today = daysAgo(0);
    // Yesterday's deal, posted to today's board: the seed and the key agree
    // with each other but not with the board, and the board is the one that
    // says which puzzle everybody played.
    const res = await h(post(`daily-${today}`, await body(dailyRun(daysAgo(1), 10), 'p1', 'Ann')));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'shape' });
    expect(store.size).toBe(0);
  });

  it('refuses to back-fill an older day', async () => {
    const h = await handler();
    for (const days of [2, 3, 30]) {
      const res = await h(post(`daily-${daysAgo(days)}`, { id: 'p1', name: 'Ann', score: 900 }));
      expect(`${days}:${res.status}`).toBe(`${days}:400`);
      expect(await res.json()).toEqual({ error: 'Daily closed' });
    }
    expect(store.size).toBe(0);
  });

  it('refuses to post to a day that has not happened', async () => {
    const h = await handler();
    const res = await h(post(`daily-${daysAgo(-2)}`, { id: 'p1', name: 'Ann', score: 900 }));
    expect(res.status).toBe(400);
  });

  it('reads any of the last seven days, and nothing older', async () => {
    const h = await handler();
    for (const days of [0, 1, 3, 7]) {
      expect(`${days}:${(await h(get(`daily-${daysAgo(days)}`))).status}`).toBe(`${days}:200`);
    }
    for (const days of [8, 60]) {
      const res = await h(get(`daily-${daysAgo(days)}`));
      expect(`${days}:${res.status}`).toBe(`${days}:400`);
      expect(await res.json()).toEqual({ error: 'Date out of range' });
    }
  });

  it('rejects a malformed daily key with 400', async () => {
    const h = await handler();
    const bad = ['daily', 'daily-', 'daily-2026-9-9', 'daily-2026-02-30', 'daily-tomorrow', 'daily-20260909'];
    for (const key of bad) {
      const res = await h(get(key));
      expect(`${key}:${res.status}`).toBe(`${key}:400`);
      expect(await res.json()).toEqual({ error: 'Invalid difficulty' });
    }
    // And on the way in, before any body is read
    const posted = await h(post('daily-2026-9-9', { id: 'p1', name: 'Ann', score: 900 }));
    expect(posted.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it('rejects a bad body on a valid daily key', async () => {
    const h = await handler();
    const today = daysAgo(0);
    for (const bad of [{ id: 'p1', name: 'Ann' }, { id: 'p1', name: 'Ann', score: 0 }, { name: 'Ann', score: 5 }]) {
      expect((await h(post(`daily-${today}`, bad))).status).toBe(400);
    }
    expect(store.size).toBe(0);
  });

  it('keeps each day on its own board', async () => {
    const h = await handler();
    await h(post(`daily-${daysAgo(0)}`, await body(dailyRun(daysAgo(0), 6), 'p1', 'Ann')));
    await h(post(`daily-${daysAgo(1)}`, await body(dailyRun(daysAgo(1), 6), 'p1', 'Ann')));

    expect(storedBoard(dailyKeyFor(daysAgo(0)))).toHaveLength(1);
    expect(storedBoard(dailyKeyFor(daysAgo(1)))).toHaveLength(1);
    expect(store.has(CLASSIC_KEY)).toBe(false);
  });
});

// ── One regression test per finding of the adversarial review ──

describe('api/run-start — the ticket that starts a run', () => {
  it('issues a signed ticket the leaderboard accepts', async () => {
    const start = await runStartHandler();
    const h = await handler();

    const issued = await start(startRun({ id: 'p1', mode: 'classic' }));
    expect(issued.status).toBe(200);
    const ticket = await issued.json();
    expect(typeof ticket.token).toBe('string');
    expect(Number.isInteger(ticket.seed)).toBe(true);

    // Play the deal the server chose, then post it with the server's ticket.
    // The ticket was minted a moment ago, so the run has to be short enough
    // to have happened in the time since — which it is: the check allows two
    // seconds of slack and this run's last move is inside that.
    const played = playBotRun('classic', ticket.seed, 4);
    const res = await h(post('classic', {
      id: 'p1', name: 'Ann', score: played.score, replay: played.replay, token: ticket.token,
    }));
    expect(await res.json()).toMatchObject({ rank: 1 });
  });

  it('refuses a mode it does not deal and a body that is not a request', async () => {
    const start = await runStartHandler();
    for (const bad of [{ id: 'p1', mode: 'zen' }, { id: '', mode: 'classic' }, { mode: 'classic' }, null, [], 'x']) {
      expect(`${JSON.stringify(bad)}:${(await start(startRun(bad))).status}`)
        .toBe(`${JSON.stringify(bad)}:400`);
    }
    expect((await start(new Request('https://x/api/run-start', { method: 'PUT' }))).status).toBe(405);
  });

  it('says which day it is without a ticket, and never the deal', async () => {
    const start = await runStartHandler();
    const today = daysAgo(0);
    const res = await start(new Request('https://x/api/run-start?mode=daily'));
    const data = await res.json();

    // The date and the number a player compares, and nothing else. The seed
    // used to come back here, which handed the shared puzzle to anybody who
    // asked: solve it at leisure, then post it from an id that had never
    // spent an attempt on it.
    expect(Object.keys(data).sort()).toEqual(['dailyKey', 'mode', 'number']);
    expect(data.dailyKey).toBe(today);
    expect(data.number).toBe(dailyNumber(today));
    expect(data.seed).toBeUndefined();
    expect(data.token).toBeUndefined();
    // Not under another name either
    expect(JSON.stringify(data)).not.toContain(String(await dailySeedFor(SECRET, today)));

    expect((await start(new Request('https://x/api/run-start?mode=classic'))).status).toBe(400);
  });

  it('stores the daily ticket, hands the same one back, and only makes practice on request', async () => {
    const start = await runStartHandler();
    const h = await handler();
    const today = daysAgo(0);
    const ticketKey = `${dailyKeyFor(today)}:ticket:p1`;

    const first = await (await start(startRun({ id: 'p1', mode: 'daily' }))).json();
    const again = await (await start(startRun({ id: 'p1', mode: 'daily' }))).json();
    // Asking twice is not playing twice. A reload, a second tab or a retried
    // request gets the ticket the attempt was issued on, to the byte.
    expect(again).toEqual(first);
    expect(readTicketPayload(first.token)?.practice).toBeUndefined();

    // The attempt is recorded where the board is, and expires with it — in
    // the same command that stored it, so there is no window in which a
    // ticket is stored without a TTL.
    expect(storedString(ticketKey)).toBe(first.token);
    expect(expiresFor(ticketKey)).toEqual([DAILY_TTL]);

    // Asking for a *new* run is the only thing that spends a practice ticket:
    // the real puzzle, played for real, and unable to post a score.
    const practice = await (await start(startRun({ id: 'p1', mode: 'daily', practice: true }))).json();
    expect(practice.seed).toBe(first.seed);
    expect(readTicketPayload(practice.token)?.practice).toBe(true);
    // And it does not overwrite the ticket the attempt belongs to
    expect(storedString(ticketKey)).toBe(first.token);

    // Another player's first ticket is a first ticket, practice asked for or not
    const other = await (await start(startRun({ id: 'p2', mode: 'daily', practice: true }))).json();
    expect(readTicketPayload(other.token)?.practice).toBeUndefined();

    // Short enough to have been played in the moment since the tickets were
    // minted, which is what the real-time check asks
    const played = playBotRun('daily', first.seed, 4);
    const replay = { ...played.replay, dailyKey: today };
    const submission = (token: string): Record<string, unknown> =>
      ({ id: 'p1', name: 'Ann', score: played.score, replay, token });

    const refused = await h(post(`daily-${today}`, submission(practice.token)));
    expect(refused.status).toBe(400);
    expect(await refused.json())
      .toEqual({ error: 'Score could not be verified', reason: 'practice' });
    expect(store.has(dailyKeyFor(today))).toBe(false);

    // And the refusal cost nothing: the ticket that did spend the attempt
    // still posts the run it was issued for.
    expect((await h(post(`daily-${today}`, submission(first.token)))).status).toBe(200);
    expect(storedBoard(dailyKeyFor(today))).toEqual([['p1', played.score]]);
  });
});

describe('finding 1 — a replay cannot be played faster than real time', () => {
  it('refuses a run whose last move is later than the ticket is old', async () => {
    const h = await handler();
    const played = run('classic', 12);
    const lastAt = played.replay.moves[played.replay.moves.length - 1].at;
    expect(lastAt).toBeGreaterThan(3);

    // The ticket was issued a moment ago, so this run claims several seconds
    // of play that have not happened yet. The log itself is impeccable: the
    // moves are real, the spacing is human, the score is exactly right.
    const fresh = await body(played, 'p1', 'Ann', { issuedAt: Date.now() });
    const res = await h(post('classic', fresh));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'time' });
    expect(store.size).toBe(0);

    // The same run, with a ticket old enough to have covered it, is fine
    const aged = await body(played, 'p1', 'Ann', { issuedAt: Date.now() - lastAt * 1000 - 500 });
    expect((await h(post('classic', aged))).status).toBe(200);
  });

  it('refuses a ticket older than a day, and one dated in the future', async () => {
    const h = await handler();
    const played = run('classic', 10);
    for (const issuedAt of [Date.now() - 25 * 60 * 60 * 1000, Date.now() + 10 * 60 * 1000]) {
      const res = await h(post('classic', await body(played, 'p1', 'Ann', { issuedAt })));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'token' });
    }
    expect(store.size).toBe(0);
  });

  it('refuses a ticket signed with the wrong secret, or altered after signing', async () => {
    const h = await handler();
    const played = run('classic', 10);
    const forged = await signTicket('not-the-secret', {
      v: TICKET_VERSION, id: 'p1', mode: 'classic', seed: played.replay.seed, issuedAt: Date.now() - 60_000,
    });
    const honest = await ticketFor(played, 'p1');
    const tampered = `${honest.split('.')[0]}x.${honest.split('.')[1]}`;

    for (const token of [forged, tampered, 'not-a-token', '', 'a.b.c', 42]) {
      const res = await h(post('classic', {
        id: 'p1', name: 'Ann', score: played.score, replay: played.replay, token,
      }));
      expect(res.status).toBe(400);
      expect(await res.json())
        .toEqual({ error: 'Score could not be verified', reason: 'token' });
    }
    expect(store.size).toBe(0);
  });

  it('takes a fast run the live engine accepted, and still refuses compressed time', async () => {
    const h = await handler();
    // A real run, played through the engine at 79 ms an input: under the
    // cadence floor that used to live in the simulation, and something the
    // live game accepts and pays for without a murmur. A rule the game does
    // not enforce while you play cannot be a rule the server enforces after.
    const brisk = playBotRun('classic', 4242, 14, { step: () => 0.079 });
    const gaps = brisk.replay.moves.map((m, i) => m.at - (brisk.replay.moves[i - 1]?.at ?? m.at));
    expect(Math.max(...gaps.slice(1))).toBeLessThan(0.08);

    const last = brisk.replay.moves[brisk.replay.moves.length - 1].at;
    const ok = await h(post('classic', {
      ...await body(brisk, 'p1', 'Ann', { issuedAt: Date.now() - last * 1000 - 500 }),
    }));
    expect(ok.status).toBe(200);
    expect(storedBoard(CLASSIC_KEY)).toEqual([['p1', brisk.score]]);

    // The same run with a ticket minted a moment ago is refused, and for the
    // reason that is actually true of it: it claims more seconds of play than
    // have happened. That is the check a fabricated log cannot beat, and it
    // is the one the cadence floor was standing in for.
    const compressed = playBotRun('classic', 4242, 200, { step: () => 0.079 });
    expect(compressed.replay.moves[compressed.replay.moves.length - 1].at).toBeGreaterThan(5);
    const rushed = await h(post('classic', {
      ...await body(compressed, 'p2', 'Bo', { issuedAt: Date.now() }),
    }));
    expect(rushed.status).toBe(400);
    expect(await rushed.json()).toEqual({ error: 'Score could not be verified', reason: 'time' });
  });

  it('refuses a run a fifth of a second past its bank, which the old slack allowed', async () => {
    const h = await handler();
    const played = run('classic', 12);
    const timer = DIFFICULTY_CONFIGS.classic.timer;

    // The moment the reconstructed bank stands at exactly −0.18 s: a run that
    // sat out 18 hundredths of a second more clock than it ever had. The old
    // one-second slack waved this through.
    let lo = 0;
    let hi = 600;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (drainIntegral(timer, 0, mid) < timer.startSeconds + 0.18) lo = mid; else hi = mid;
    }
    expect(timer.startSeconds - drainIntegral(timer, 0, lo)).toBeCloseTo(-0.18, 4);

    const shift = lo - played.replay.moves[0].at;
    const stalled = played.replay.moves.map(m => ({ ...m, at: m.at + shift }));
    const res = await h(post('classic', {
      ...await body(played, 'p1', 'Ann'),
      replay: { ...played.replay, moves: stalled },
    }));
    expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'clock' });
  });
});

describe('finding 2 — a replay is worth one score, and ids stay on the server', () => {
  it('refuses the same daily replay posted under a second id', async () => {
    const h = await handler();
    const today = daysAgo(0);
    const played = dailyRun(today, 14);

    // Everybody on a daily is dealt the same seed, so a good run is a
    // document worth passing around: two players, two honest tickets, one
    // replay. The first banks it; the second is refused.
    expect((await h(post(`daily-${today}`, await body(played, 'p1', 'Ann')))).status).toBe(200);
    const second = await h(post(`daily-${today}`, await body(played, 'p2', 'Bo')));

    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'Score could not be verified', reason: 'replay' });
    expect(storedBoard(dailyKeyFor(today)).map(([id]) => id)).toEqual(['p1']);
  });

  it('refuses a ticket issued to somebody else', async () => {
    const h = await handler();
    const played = run('classic', 10);
    const res = await h(post('classic', {
      ...await body(played, 'p2', 'Bo', { id: 'p1' }),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'token' });
  });

  it('refuses a ticket spent twice', async () => {
    const h = await handler();
    const first = run('classic', 10);
    const second = run('classic', 20);
    const token = await ticketFor(first, 'p1');

    expect((await h(post('classic', {
      id: 'p1', name: 'Ann', score: first.score, replay: first.replay, token,
    }))).status).toBe(200);

    // A different, better run — but the same ticket, which was issued for one
    // run and has already been spent on it.
    const reused = await h(post('classic', {
      id: 'p1', name: 'Ann', score: second.score, replay: second.replay, token,
    }));
    expect(reused.status).toBe(400);
    expect(await reused.json()).toEqual({ error: 'Score could not be verified', reason: 'token' });
    expect(storedBoard(CLASSIC_KEY)).toEqual([['p1', first.score]]);
  });

  it('never returns a player id, and marks the asker\'s own row instead', async () => {
    const h = await handler();
    await h(post('classic', await body(run('classic', 8), 'p1', 'Ann')));
    await h(post('classic', await body(run('classic', 18), 'p2', 'Bo')));

    const anonymous = await (await h(get('classic'))).json();
    expect(anonymous).toHaveLength(2);
    for (const entry of anonymous) {
      expect(Object.keys(entry).sort()).toEqual(['date', 'name', 'score']);
    }

    const asAnn = await (await h(get('classic', 'p1'))).json();
    expect(asAnn.map((e: { mine?: boolean }) => e.mine === true)).toEqual([false, true]);
    expect(asAnn.every((e: Record<string, unknown>) => e.id === undefined)).toBe(true);
  });
});

describe('finding 3 — the board is versioned by the rules it was proved under', () => {
  it('writes under the current version and never reads an older one', async () => {
    const h = await handler();
    const played = run('classic', 10);
    // What a previous rules version left behind, in the shape it left it
    store.set('leaderboard:enclave:classic', {
      kind: 'string',
      value: JSON.stringify([{ id: 'ghost', name: 'Old', score: 999_999, date: '2026-01-01' }]),
    });

    await h(post('classic', await body(played, 'p1', 'Ann')));

    expect(CLASSIC_KEY).toBe('leaderboard:enclave:v2:classic');
    expect(storedBoard(CLASSIC_KEY)).toEqual([['p1', played.score]]);
    // The old key is still there, untouched, and invisible
    expect(store.has('leaderboard:enclave:classic')).toBe(true);
    const entries = await (await h(get('classic'))).json();
    expect(entries.map((e: { name: string }) => e.name)).toEqual(['Ann']);
  });
});

describe('finding 4 — a first daily score counts even when it does not rank', () => {
  it('closes the day for a player whose first run missed the top ten', async () => {
    const h = await handler();
    const today = daysAgo(0);

    // Ten better players fill the board
    for (let i = 0; i < 10; i++) {
      const res = await h(post(`daily-${today}`, await body(dailyRun(today, 10 + i), `top${i}`, `T${i}`)));
      expect(res.status).toBe(200);
    }

    // An eleventh player posts a poor run: no place in the ten anybody reads,
    // but they have played today, and the board measures the puzzle.
    const poor = dailyRun(today, 4);
    const first = await h(post(`daily-${today}`, await body(poor, 'p11', 'Zed')));
    const firstBody = await first.json();
    expect(firstBody.rank).toBeNull();
    expect(firstBody.entries.some((e: { name: string }) => e.name === 'Zed')).toBe(false);

    // Their second attempt is a good one, and would have topped the board.
    // It does not count: it never did for a player already in the top ten,
    // and now it does not for one who was outside it either.
    const good = dailyRun(today, 28);
    expect(good.score).toBeGreaterThan(dailyRun(today, 19).score);
    const second = await h(post(`daily-${today}`, await body(good, 'p11', 'Zed')));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ rank: null });
    expect(storedBoard(dailyKeyFor(today)).find(([id]) => id === 'p11')?.[1]).toBe(poor.score);
  });
});

describe('finding 5 — two submissions at once cannot both land', () => {
  it('gives one id one daily entry however the two requests interleave', async () => {
    const h = await handler();
    const today = daysAgo(0);
    const early = dailyRun(today, 9);
    const late = dailyRun(today, 21);

    // Two tickets, minted a second apart, so they are two tickets: a payload
    // is only its fields, and two issued in the same millisecond for the same
    // id and deal would be the same token — which the single-use check would
    // rightly refuse.
    const now = Date.now();
    const [a, b] = await Promise.all([
      h(post(`daily-${today}`, await body(early, 'p1', 'Ann', { issuedAt: now - 60_000 }))),
      h(post(`daily-${today}`, await body(late, 'p1', 'Ann', { issuedAt: now - 61_000 }))),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const board = storedBoard(dailyKeyFor(today));
    expect(board).toHaveLength(1);
    expect(board[0][0]).toBe('p1');
    // Whichever won, it is one of the two runs and not a merge of them
    expect([early.score, late.score]).toContain(board[0][1]);
  });

  it('keeps the higher of two concurrent classic scores', async () => {
    const h = await handler();
    const lower = run('classic', 8);
    const higher = run('classic', 24);

    // Two tickets, minted a second apart, for the same reason the daily case
    // above does it: a payload is only its fields, and both of these runs are
    // the same id on the same seed, so two issued in the same millisecond
    // would be the same token — one ticket, and the second submission rightly
    // refused for spending it twice. Which of the two arrived first used to
    // decide this test; it should be `GT` that decides it.
    const now = Date.now();
    const [a, b] = await Promise.all([
      h(post('classic', await body(higher, 'p1', 'Ann', { issuedAt: now - 60_000 }))),
      h(post('classic', await body(lower, 'p1', 'Ann', { issuedAt: now - 61_000 }))),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    expect(storedBoard(CLASSIC_KEY)).toEqual([['p1', higher.score]]);
  });
});

describe('finding 6 — the seed is the server\'s, not the client\'s', () => {
  it('refuses a replay dealt from a seed the ticket did not issue', async () => {
    const h = await handler();
    const chosen = run('classic', 12, 777);
    // A real run, honestly played and correctly scored — from a deal the
    // player picked. The ticket names a different one.
    const res = await h(post('classic', {
      ...await body(chosen, 'p1', 'Ann', { seed: chosen.replay.seed + 1 }),
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'token' });
    expect(store.size).toBe(0);
  });

  it('deals free play a fresh seed and the daily one nobody can compute', async () => {
    const start = await runStartHandler();
    const seeds = new Set<number>();
    for (let i = 0; i < 4; i++) {
      seeds.add((await (await start(startRun({ id: 'p1', mode: 'classic' }))).json()).seed);
    }
    expect(seeds.size).toBeGreaterThan(1);

    const one = await (await start(startRun({ id: 'p1', mode: 'daily' }))).json();
    const two = await (await start(startRun({ id: 'p2', mode: 'daily' }))).json();
    // The same puzzle for everyone, and not the one the public date hash
    // would have dealt — that one could be played a week early.
    expect(one.seed).toBe(two.seed);
    expect(one.dailyKey).toBe(daysAgo(0));
    expect(one.seed).not.toBe(dailySeed(one.dailyKey));
  });
});

describe('finding 7 — a claim decided at the edge of an echo window', () => {
  it('posts a run whose move times are not round milliseconds', async () => {
    const h = await handler();
    const edge = playBotRun('classic', 5, 40, { step: () => 1 / 3 });
    const offGrid = edge.replay.moves.filter(
      m => Math.abs(m.at * 1000 - Math.round(m.at * 1000)) > 1e-9,
    );
    expect(offGrid.length).toBeGreaterThan(0);

    const res = await h(post('classic', {
      id: 'p1',
      name: 'Ann',
      score: edge.score,
      replay: edge.replay,
      token: await ticketFor(edge, 'p1'),
    }));
    expect(res.status).toBe(200);
    expect(storedBoard(CLASSIC_KEY)).toEqual([['p1', edge.score]]);
  });
});

describe('finding 8 — a held piece is not a lost piece', () => {
  it('posts a daily that parked its first piece and still placed all thirty', async () => {
    const h = await handler();
    const today = daysAgo(0);
    const parked = playBotRun('daily', dailySeed(today), 40, { holdAt: 0 });
    const dated: BotRun = { ...parked, replay: { ...parked.replay, dailyKey: today } };

    expect(dated.replay.moves.filter(m => m.t === 'p')).toHaveLength(30);
    expect(parked.gs.deathCause).toBe('complete');

    const res = await h(post(`daily-${today}`, await body(dated, 'p1', 'Ann')));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rank: 1 });
  });
});

describe('finding 9 — a daily has no clock, so it has no hurry', () => {
  it('accepts a daily left open for three hours and still refuses a stalled classic', async () => {
    const h = await handler();
    const today = daysAgo(0);
    const played = dailyRun(today, 12);
    const gap = 3 * 60 * 60;

    // Lunch, in the middle of a run with no clock to run out
    const paused = played.replay.moves.map((m, i) => (i < 5 ? m : { ...m, at: m.at + gap }));
    const res = await h(post(`daily-${today}`, {
      ...await body(played, 'p1', 'Ann', { issuedAt: Date.now() - (gap + 60) * 1000 }),
      replay: { ...played.replay, moves: paused },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rank: 1 });

    // The same pause in a timed mode is still refused: the half-hour gap
    // limit is what a tab left open looks like when there is a clock running.
    const classic = run('classic', 12);
    const stalled = classic.replay.moves.map((m, i) => (i < 5 ? m : { ...m, at: m.at + gap }));
    const timed = await h(post('classic', {
      ...await body(classic, 'p2', 'Bo', { issuedAt: Date.now() - (gap + 60) * 1000 }),
      replay: { ...classic.replay, moves: stalled },
    }));
    expect(timed.status).toBe(400);
    expect(await timed.json()).toEqual({ error: 'Score could not be verified', reason: 'move' });

    // And a shorter pause there is refused for the reason it deserves: the
    // bank a Classic run has cannot fund ten minutes of thinking.
    const shorter = classic.replay.moves.map((m, i) => (i < 5 ? m : { ...m, at: m.at + 600 }));
    const drained = await h(post('classic', {
      ...await body(classic, 'p3', 'Cy', { issuedAt: Date.now() - 700 * 1000 }),
      replay: { ...classic.replay, moves: shorter },
    }));
    expect(await drained.json()).toEqual({ error: 'Score could not be verified', reason: 'clock' });
  });
});

describe('finding 11 — a daily solution is one solution however it is timed', () => {
  it('refuses a copied daily replay with one timestamp nudged, under a second id', async () => {
    const h = await handler();
    const today = daysAgo(0);
    const played = dailyRun(today, 14);

    expect((await h(post(`daily-${today}`, await body(played, 'p1', 'Ann')))).status).toBe(200);

    // The whole attack, as the review ran it. The log is passed to a second
    // player, one `at` is moved by a microsecond — invisible, and in a mode
    // with no clock and no echo window it cannot change a single point — and
    // it goes back up under a fresh id with that id's own honest ticket.
    const nudged = played.replay.moves.map(
      (m, i) => (i === 6 ? { ...m, at: m.at + 1e-6 } : m),
    );
    expect(nudged).not.toEqual(played.replay.moves);
    // It is refused as a copy, not as a bad score: the rules still pay the
    // re-timed log exactly what they paid the original.
    expect(simulateRun({ ...played.replay, moves: nudged }))
      .toMatchObject({ valid: true, score: played.score });
    const res = await h(post(`daily-${today}`, {
      ...await body(played, 'p2', 'Bo'),
      replay: { ...played.replay, moves: nudged },
    }));

    // The fingerprint is over the deal and the placements, so the two logs
    // are one run and the second one is refused as the copy it is.
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'replay' });
    expect(storedBoard(dailyKeyFor(today)).map(([id]) => id)).toEqual(['p1']);
  });

  it('still lets two different solutions of the same daily onto the board', async () => {
    const h = await handler();
    const today = daysAgo(0);
    // Same seed, same date, different placements: two players who both
    // played it, which is the case the dedupe must never touch.
    const ann = dailyRun(today, 14);
    const bo = dailyRun(today, 15);

    expect((await h(post(`daily-${today}`, await body(ann, 'p1', 'Ann')))).status).toBe(200);
    expect((await h(post(`daily-${today}`, await body(bo, 'p2', 'Bo')))).status).toBe(200);
    expect(storedBoard(dailyKeyFor(today)).map(([id]) => id).sort()).toEqual(['p1', 'p2']);
  });

  it('refuses a Classic run re-timed and posted again by the player who banked it', async () => {
    const h = await handler();
    const played = run('classic', 12);
    expect((await h(post('classic', await body(played, 'p1', 'Ann')))).status).toBe(200);

    // Timing is out of the fingerprint in every mode, not only the daily.
    // The same placements, every gap stretched by a hundredth of a second.
    const retimed = played.replay.moves.map(m => ({ ...m, at: m.at * 1.01 }));
    expect(simulateRun({ ...played.replay, moves: retimed }))
      .toMatchObject({ valid: true, score: played.score });
    const res = await h(post('classic', {
      ...await body(played, 'p1', 'Ann'),
      replay: { ...played.replay, moves: retimed },
    }));
    expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'replay' });
  });
});

describe('finding 10 — a malformed body is a 400, not a crash', () => {
  it('refuses JSON that is not an object, and a name that is not a string', async () => {
    const h = await handler();
    for (const bad of [null, [], 'x', 42, true]) {
      const res = await h(post('classic', bad));
      expect(`${JSON.stringify(bad)}:${res.status}`).toBe(`${JSON.stringify(bad)}:400`);
      expect(await res.json()).toEqual({ error: 'Invalid data' });
    }

    // A numeric name used to reach `.trim()` and answer a 500
    const played = run('classic', 8);
    for (const name of [7, null, ['Ann'], { first: 'Ann' }]) {
      const res = await h(post('classic', { ...await body(played, 'p1', 'Ann'), name }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid data' });
    }

    // And a body that is not JSON at all
    const raw = await h(new Request(`${URL_BASE}?difficulty=classic`, { method: 'POST', body: '{' }));
    expect(raw.status).toBe(400);
    expect(await raw.json()).toEqual({ error: 'Invalid JSON' });

    expect(store.size).toBe(0);
  });
});

// ── One regression test per finding of the second review ──

describe('review 2, finding 1 — a submission is one indivisible step', () => {
  it('does the whole write in the script, and nothing outside it', async () => {
    const h = await handler();
    await h(post('classic', await body(run('classic', 12), 'p1', 'Ann')));

    // The writes all live in the script now. A bare SADD, ZADD or HSET on
    // this path would be a step that can commit while the rest does not.
    expect(commands).toContain('eval');
    expect(commands.filter(c => ['sadd', 'zadd', 'hset', 'expire'].includes(c))).toEqual([]);
  });

  it('is mirrored by the stub, command for command', async () => {
    // Everything else in this file exercises the *stub's* transcription of
    // the script, because that is what runs: the Lua never executes here.
    // This is the alarm for the two drifting apart — the commands the script
    // issues and the decisions it turns on, read out of the script itself.
    const { SUBMIT_SCRIPT } = await import('../api/leaderboard');
    const called = [...SUBMIT_SCRIPT.matchAll(/redis\.call\('([A-Z]+)'/g)].map(m => m[1]);
    expect([...new Set(called)].sort())
      .toEqual(['EXPIRE', 'HGET', 'HSET', 'SADD', 'TYPE', 'ZADD']);

    // The idempotent branch: a spent ticket whose stored identity matches is
    // answered with the outcome it was spent on, not refused.
    expect(SUBMIT_SCRIPT).toContain(`string.sub(spent, cut + 1) == identity`);
    expect(SUBMIT_SCRIPT).toContain(`return { string.sub(spent, 1, cut - 1), 0 }`);
    // The flags that decide each board, and the guard that keeps the name
    // beside a score from being written by a submission that did not move it.
    expect(SUBMIT_SCRIPT).toContain(`'NX', 'CH'`);
    expect(SUBMIT_SCRIPT).toContain(`'GT', 'CH'`);
    expect(SUBMIT_SCRIPT.match(/if changed == 1 then redis\.call\('HSET'/g)).toHaveLength(2);
  });

  it('keeps the score when the submission\'s response is lost and the client re-sends it', async () => {
    const h = await handler();
    const today = daysAgo(0);
    const played = dailyRun(today, 14);
    const submission = await body(played, 'p1', 'Ann');

    // The script runs, its writes stand, and the answer never gets back. The
    // REST client re-sends, so the script runs a second time on state its own
    // first run left behind — which is exactly the case that used to consume
    // the ticket, the fingerprint and the daily id and store no score,
    // answering 200 with `rank: null` and an empty board.
    dropResponseFor = 'eval';
    const first = await h(post(`daily-${today}`, submission));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.rank).toBe(1);
    expect(firstBody.entries).toHaveLength(1);
    expect(storedBoard(dailyKeyFor(today))).toEqual([['p1', played.score]]);
    expect(commands.filter(c => c === 'eval')).toHaveLength(2);

    // And the client re-sending the whole submission — a retry one level up,
    // where the network dropped the HTTP response rather than the Redis one —
    // gets the same answer again rather than a refusal.
    const again = await h(post(`daily-${today}`, submission));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(firstBody);
    expect(storedBoard(dailyKeyFor(today))).toEqual([['p1', played.score]]);
  });

  it('still refuses a ticket re-spent on a different run', async () => {
    const h = await handler();
    const first = run('classic', 10);
    const second = run('classic', 20);
    const token = await ticketFor(first, 'p1');

    expect((await h(post('classic', {
      id: 'p1', name: 'Ann', score: first.score, replay: first.replay, token,
    }))).status).toBe(200);

    // Idempotency is for the *same* submission. A different run under the
    // same ticket is the reuse the single-use check exists for.
    const reused = await h(post('classic', {
      id: 'p1', name: 'Ann', score: second.score, replay: second.replay, token,
    }));
    expect(await reused.json()).toEqual({ error: 'Score could not be verified', reason: 'token' });
    expect(storedBoard(CLASSIC_KEY)).toEqual([['p1', first.score]]);
  });

  it('answers a retried refusal the same way it answered the first one', async () => {
    const h = await handler();
    const today = daysAgo(0);
    const played = dailyRun(today, 14);

    expect((await h(post(`daily-${today}`, await body(played, 'p1', 'Ann')))).status).toBe(200);
    // p2 posts p1's solution: refused as a copy, and the ticket is spent on
    // that refusal. Re-sending it must give the same refusal, not a new one.
    const copy = await body(played, 'p2', 'Bo');
    const refused = await h(post(`daily-${today}`, copy));
    expect(await refused.json()).toEqual({ error: 'Score could not be verified', reason: 'replay' });
    const retried = await h(post(`daily-${today}`, copy));
    expect(await retried.json()).toEqual({ error: 'Score could not be verified', reason: 'replay' });
  });
});

describe('review 2, finding 2 — the first daily ticket is not lost to a dropped reply', () => {
  it('issues a real ticket, not a practice one, when the store\'s reply goes missing', async () => {
    const start = await runStartHandler();
    const today = daysAgo(0);
    const ticketKey = `${dailyKeyFor(today)}:ticket:p1`;

    // The SET commits and its answer is lost. The client re-sends; the SET
    // now says the key exists. Under the old per-day set that answer was the
    // whole decision, so a player's very first daily ticket came back marked
    // practice because a packet went missing.
    dropResponseFor = 'set';
    const issued = await (await start(startRun({ id: 'p1', mode: 'daily' }))).json();
    expect(readTicketPayload(issued.token)?.practice).toBeUndefined();
    expect(storedString(ticketKey)).toBe(issued.token);

    // The re-sent SET found the key already there, so the ticket that comes
    // back is the stored one — the same seed, the same issue time, the same
    // token — rather than a second attempt or a practice run.
    const again = await (await start(startRun({ id: 'p1', mode: 'daily' }))).json();
    expect(again).toEqual(issued);
  });

  it('hands back a normal ticket for a stored value it did not sign', async () => {
    const start = await runStartHandler();
    const today = daysAgo(0);
    const ticketKey = `${dailyKeyFor(today)}:ticket:p1`;
    store.set(ticketKey, { kind: 'string', value: 'not-a-ticket' });

    // Nothing there can be spent, so charging the player an attempt for it
    // would be charging them for our own bad data.
    const issued = await (await start(startRun({ id: 'p1', mode: 'daily' }))).json();
    expect(readTicketPayload(issued.token)?.practice).toBeUndefined();
    expect(storedString(ticketKey)).toBe(issued.token);
  });

  it('deals free play without storing anything', async () => {
    const start = await runStartHandler();
    await start(startRun({ id: 'p1', mode: 'classic' }));
    expect(store.size).toBe(0);
  });
});

describe('review 2, finding 4 — a solution turned round the board is the same solution', () => {
  /**
   * The same run with the board turned `quarter` times clockwise.
   *
   * A cell at `(r, c)` lands at `(c, 8 - r)`, so a piece with its top-left at
   * `(row, col)` and a `rows x cols` box comes out at `(col, 9 - rows - row)`
   * with the box on its side, one rotation further round its own cycle. This
   * is written out here rather than imported so the test is a second opinion
   * on the transform in `Ticket.ts` and not an echo of it.
   */
  function turnRun(replay: Replay, quarter: number): Replay {
    let moves = replay.moves;
    let placed = simulateRun(replay).placed;
    for (let turn = 0; turn < quarter; turn++) {
      const nextMoves: Move[] = [];
      const nextPlaced: PlacedPiece[] = [];
      let i = 0;
      for (const m of moves) {
        if (m.t !== 'p') {
          nextMoves.push(m);
          continue;
        }
        const p = placed[i++];
        nextMoves.push({
          ...m,
          row: m.col,
          col: GRID_SIZE - p.rows - m.row,
          rot: (m.rot + 1) % p.turns,
        });
        nextPlaced.push({ rows: p.cols, cols: p.rows, turns: p.turns });
      }
      moves = nextMoves;
      placed = nextPlaced;
    }
    return { ...replay, moves };
  }

  it('scores every quarter turn of a run exactly the same', () => {
    // The premise. The board is a square with no gravity and no privileged
    // corner, the deal is the same pieces in the same order, and rooms,
    // fences, the lit map and the survey are all rotation-invariant. If this
    // ever stops being true, the dedupe below is refusing honest runs.
    const played = dailyRun(daysAgo(0), 14);
    for (const quarter of [1, 2, 3]) {
      const turned = turnRun(played.replay, quarter);
      expect(turned.moves).not.toEqual(played.replay.moves);
      const result = simulateRun(turned);
      // One assertion carrying the turn, so a red build says which one broke
      expect(`${quarter}: ${result.reason ?? 'valid'} ${result.score}`)
        .toBe(`${quarter}: valid ${played.score}`);
    }
  });

  it('hashes all four turns to one fingerprint', async () => {
    const played = dailyRun(daysAgo(0), 14);
    const prints = new Set<string>();
    for (const quarter of [0, 1, 2, 3]) {
      const turned = turnRun(played.replay, quarter);
      prints.add(await replayFingerprint(turned, simulateRun(turned).placed));
    }
    expect(prints.size).toBe(1);

    // And a genuinely different solution is still a different fingerprint:
    // the canonical form collapses the four turns and nothing else.
    const other = dailyRun(daysAgo(0), 15);
    prints.add(await replayFingerprint(other.replay, simulateRun(other.replay).placed));
    expect(prints.size).toBe(2);
  });

  it('refuses a copied daily posted at any of the other three turns', async () => {
    const today = daysAgo(0);
    const played = dailyRun(today, 14);

    for (const quarter of [1, 2, 3]) {
      store.clear();
      expires.length = 0;
      const h = await handler();
      expect((await h(post(`daily-${today}`, await body(played, 'p1', 'Ann')))).status).toBe(200);

      // The whole attack: take the banked run, turn the board, post it under
      // a fresh id with that id's own honest ticket. Legal, identical in
      // score, and a different fingerprint until the fingerprint was made to
      // look at all four turns.
      const turned = turnRun(played.replay, quarter);
      const res = await h(post(`daily-${today}`, {
        ...await body(played, 'p2', 'Bo'),
        replay: turned,
      }));
      expect(`${quarter}: ${res.status}`).toBe(`${quarter}: 400`);
      expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'replay' });
      expect(storedBoard(dailyKeyFor(today)).map(([id]) => id)).toEqual(['p1']);
    }
  });

  it('takes the rotated run when it is the one that gets there first', async () => {
    const h = await handler();
    const today = daysAgo(0);
    const played = dailyRun(today, 14);
    const turned = turnRun(played.replay, 2);

    // The canonical form has no preferred orientation: whichever of the four
    // arrives first is the run, and the other three are its copies.
    const first = await h(post(`daily-${today}`, {
      ...await body(played, 'p1', 'Ann'), replay: turned,
    }));
    expect(first.status).toBe(200);
    const second = await h(post(`daily-${today}`, await body(played, 'p2', 'Bo')));
    expect(await second.json()).toEqual({ error: 'Score could not be verified', reason: 'replay' });
  });

  it('does not call two short runs copies of each other', async () => {
    const h = await handler();
    const today = daysAgo(0);
    // Two players who each place one piece and quit write byte-identical
    // solutions without ever having met. Calling the second a copy told an
    // honest player their score could not be verified.
    const stub = playBotRun('daily', dailySeed(today), 1, { holdAt: -1 });
    const dated: BotRun = { ...stub, replay: { ...stub.replay, dailyKey: today } };
    expect(dated.replay.moves).toHaveLength(1);
    expect(dated.score).toBeGreaterThan(0);

    expect((await h(post(`daily-${today}`, await body(dated, 'p1', 'Ann')))).status).toBe(200);
    const second = await h(post(`daily-${today}`, await body(dated, 'p2', 'Bo')));
    expect(second.status).toBe(200);
    expect(storedBoard(dailyKeyFor(today)).map(([id]) => id).sort()).toEqual(['p1', 'p2']);
  });

  it('starts calling them copies at eight placements', async () => {
    const today = daysAgo(0);
    for (const [placements, expected] of [[7, 200], [8, 400]] as const) {
      store.clear();
      const h = await handler();
      const shared = playBotRun('daily', dailySeed(today), placements, { holdAt: -1 });
      const dated: BotRun = { ...shared, replay: { ...shared.replay, dailyKey: today } };
      expect(dated.replay.moves.filter(m => m.t === 'p')).toHaveLength(placements);

      expect((await h(post(`daily-${today}`, await body(dated, 'p1', 'Ann')))).status).toBe(200);
      const second = await h(post(`daily-${today}`, await body(dated, 'p2', 'Bo')));
      expect(`${placements}: ${second.status}`).toBe(`${placements}: ${expected}`);
    }
  });
});

describe('review 2, finding 8 — an unanswering database is a 503, not a hang', () => {
  it('gives up on a read and a write that never come back', async () => {
    const h = await handler();
    hangForever = true;

    // Both deadlines run at once, so this costs one timeout rather than two.
    const [read, write] = await Promise.all([
      h(get('classic')),
      h(post('classic', await body(run('classic', 8), 'p1', 'Ann'))),
    ]);
    expect([read.status, write.status]).toEqual([503, 503]);
    expect(await write.json()).toEqual({ error: 'Leaderboard unavailable' });
  }, 20_000);

  it('turns a database error into a 503 rather than a rejected promise', async () => {
    const h = await handler();
    const played = run('classic', 8);
    // A store that answers, and answers with an error — a WRONGTYPE, a quota,
    // an expired credential. The SDK throws on these, and an unhandled throw
    // here rejects the handler's own promise: a 500 with whatever body the
    // platform writes on it, and a client that cannot tell a refused score
    // from a database that is simply down.
    failWith = 'WRONGTYPE Operation against a key holding the wrong kind of value';

    const read = await h(get('classic'));
    expect(read.status).toBe(503);
    expect(await read.json()).toEqual({ error: 'Leaderboard unavailable' });
    const write = await h(post('classic', await body(played, 'p1', 'Ann')));
    expect(write.status).toBe(503);
    expect(await write.json()).toEqual({ error: 'Leaderboard unavailable' });
  });

  it('cancels an oversized body instead of reading it to the end', async () => {
    const h = await handler();
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    // A body with no end to it. `request.text()` would read this forever.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    });

    const res = await h(new Request(`${URL_BASE}?difficulty=classic`, {
      method: 'POST',
      body: endless,
      // Node requires this for a streaming request body
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Body too large' });
    expect(cancelled).toBe(true);
    // Three 64 KB chunks is over the 128 KB cap; anything near a gigabyte
    // would mean the limit is being applied after the fact again.
    expect(pulled).toBeLessThan(8);
    expect(store.size).toBe(0);
  });
});

describe('review 2, finding 9 — the name beside a score is that score\'s name', () => {
  it('leaves a higher score under its own name when a lower one follows', async () => {
    const h = await handler();
    const higher = run('classic', 24);
    const lower = run('classic', 8);
    const now = Date.now();

    expect((await h(post('classic', {
      ...await body(higher, 'p1', 'Ann', { issuedAt: now - 60_000 }),
    }))).status).toBe(200);
    expect((await h(post('classic', {
      ...await body(lower, 'p1', 'Bo', { issuedAt: now - 61_000 }),
    }))).status).toBe(200);

    // The `HSET` used to be a separate command that did not know whether its
    // `ZADD` had won, so the slower, lower submission relabelled the faster,
    // higher one. The script writes the name only when the score moved.
    expect(storedBoard(CLASSIC_KEY)).toEqual([['p1', higher.score]]);
    expect(storedMeta(CLASSIC_KEY, 'p1').name).toBe('Ann');
  });

  it('follows the name up when the score does move', async () => {
    const h = await handler();
    const now = Date.now();
    await h(post('classic', await body(run('classic', 8), 'p1', 'Ann', { issuedAt: now - 60_000 })));
    await h(post('classic', await body(run('classic', 24), 'p1', 'Bo', { issuedAt: now - 61_000 })));
    expect(storedMeta(CLASSIC_KEY, 'p1').name).toBe('Bo');
  });
});

describe('review 2, finding 10 — a long run is a run, not a forgery', () => {
  it('verifies a 601-input run the old cap cut off', async () => {
    const h = await handler();
    const long = playBotRun('classic', 9, 601);
    expect(long.replay.moves).toHaveLength(601);
    expect(long.replay.truncated).toBeUndefined();

    const last = long.replay.moves[long.replay.moves.length - 1].at;
    const res = await h(post('classic', {
      ...await body(long, 'p1', 'Ann', { issuedAt: Date.now() - last * 1000 - 2000 }),
    }));
    expect(res.status).toBe(200);
    expect(storedBoard(CLASSIC_KEY)).toEqual([['p1', long.score]]);
  }, 30_000);
});

describe('review 4, finding 5 — refusing a body does not wait on the sender', () => {
  /**
   * `readBody` takes a `Request`, but the only thing it touches on one is
   * `body` — and what is under test here is what the *stream* does when it is
   * cancelled, which a real `Request` gives a test no way to choose. So the
   * request is that one field, and the stream is the subject.
   */
  function oversized(cancel: () => Promise<void>): Request {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    return {
      body: new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(chunk); },
        cancel,
      }),
    } as unknown as Request;
  }

  it('answers too-large when the cancellation never settles', async () => {
    // The size is known the moment the chunk that crosses the cap arrives.
    // Awaiting the cancel made the answer wait on the sender's own code, and
    // a `cancel()` that never resolves held the refusal open with it.
    const answered = await Promise.race([
      readBody(oversized(() => new Promise<void>(() => { /* never settles */ })), 128 * 1024),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'hung' }), 1000)),
    ]);
    expect(answered).toEqual({ ok: false, reason: 'too-large' });
  });

  it('answers too-large when the cancellation rejects', async () => {
    // A refused cancellation says nothing about the body, which was over the
    // cap before the cancel was attempted. It used to come back 'unreadable'
    // — a 400 for a sender who has earned a 413.
    const read = await readBody(oversized(() => Promise.reject(new Error('refused'))), 128 * 1024);
    expect(read).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('review 4, finding 3 — a client that cannot be built is still a 503', () => {
  /** Run `fn` with a store URL no client can be constructed from. */
  async function withBadUrl<T>(fn: () => Promise<T>): Promise<T> {
    const real = process.env.KV_REST_API_URL;
    // The SDK validates this in its constructor and throws `UrlError`, which
    // is a synchronous throw on the way *in* rather than a failed command.
    process.env.KV_REST_API_URL = 'invalid-url';
    try {
      return await fn();
    } finally {
      process.env.KV_REST_API_URL = real;
    }
  }

  it('answers 503 to a POST instead of throwing out of the handler', async () => {
    const h = await handler();
    const submission = await body(run('classic', 8), 'p1', 'Ann');

    // The read already built its client inside the guard; the write did not,
    // so a valid submission rejected the handler's own promise — a 500 with
    // whatever body the platform writes, on a deployment whose only fault is
    // a mistyped variable.
    expect((await withBadUrl(() => h(get('classic')))).status).toBe(503);
    const res = await withBadUrl(() => h(post('classic', submission)));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Leaderboard unavailable' });

    // And nothing was consumed by it: the same ticket, the same replay, and
    // the same score still land once the URL is right. That is what makes
    // this a 503 and not a refusal.
    const retried = await h(post('classic', submission));
    expect(retried.status).toBe(200);
    expect(storedBoard(CLASSIC_KEY)).toHaveLength(1);
  });

  it('deals a daily ticket instead of throwing when run-start cannot build one', async () => {
    const start = await runStartHandler();
    const res = await withBadUrl(() => start(startRun({ id: 'p1', mode: 'daily' })));

    // The documented fallback for a store that does not answer: a real
    // ticket, never a practice one, so an outage costs an extra attempt and
    // never a score.
    expect(res.status).toBe(200);
    expect(readTicketPayload((await res.json()).token)?.practice).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe('review 4, finding 4 — replacing an unusable daily ticket is still one attempt', () => {
  it('writes one replacement and hands both callers the same ticket', async () => {
    const start = await runStartHandler();
    const today = daysAgo(0);
    const ticketKey = `${dailyKeyFor(today)}:ticket:p1`;
    // A stored value this secret never signed: nobody can spend it, so it is
    // replaced rather than charged to the player as their attempt.
    store.set(ticketKey, { kind: 'string', value: 'not-a-ticket' });

    // Two tabs, or a client and its own retry, reading that value at once.
    const [one, two] = await Promise.all([
      start(startRun({ id: 'p1', mode: 'daily' })).then(r => r.json()),
      start(startRun({ id: 'p1', mode: 'daily' })).then(r => r.json()),
    ]);

    // The replacement used to be unconditional, so both wrote — two live
    // tickets for one id on one date, only the later of them stored, and a
    // reload handing back a ticket neither caller had been playing.
    expect(one).toEqual(two);
    expect(storedString(ticketKey)).toBe(one.token);
    expect(expiresFor(ticketKey)).toEqual([DAILY_TTL]);
    // And it is a real attempt for both of them, not a practice run
    expect(readTicketPayload(one.token)?.practice).toBeUndefined();
    expect(readTicketPayload(one.token)?.dailyKey).toBe(today);
  });

  it('answers a losing replacement with the value that beat it', async () => {
    // The race above is only as sharp as its timing: both requests minted in
    // the same millisecond there, so their tickets were byte-identical and
    // only the double write gave the bug away. This pins the branch that
    // decides it, with two callers that cannot be confused for each other.
    const { CLAIM_TICKET_SCRIPT } = await import('../api/run-start');
    const redis = new Redis({ url: base, token: SECRET });
    const key = 'leaderboard:enclave:test:claim';
    await redis.set(key, 'not-a-ticket');

    // The winner replaces the value both callers read...
    expect(await redis.eval(CLAIM_TICKET_SCRIPT, [key], ['not-a-ticket', 'winner', '60']))
      .toBe('winner');
    // ...and the loser, still holding what it read, is handed the winner's
    // ticket rather than overwriting it with its own.
    expect(await redis.eval(CLAIM_TICKET_SCRIPT, [key], ['not-a-ticket', 'loser', '60']))
      .toBe('winner');
    expect(storedString(key)).toBe('winner');
    // A key that has since vanished is claimed rather than left empty
    store.delete(key);
    expect(await redis.eval(CLAIM_TICKET_SCRIPT, [key], ['not-a-ticket', 'fresh', '60']))
      .toBe('fresh');
  });

  it('leaves a valid stored ticket alone', async () => {
    const start = await runStartHandler();
    const ticketKey = `${dailyKeyFor(daysAgo(0))}:ticket:p1`;

    // The ordinary second ask: the stored ticket verifies, so the
    // compare-and-set is never reached and nothing is written at all.
    const first = await (await start(startRun({ id: 'p1', mode: 'daily' }))).json();
    const again = await (await start(startRun({ id: 'p1', mode: 'daily' }))).json();
    expect(again).toEqual(first);
    expect(storedString(ticketKey)).toBe(first.token);
    expect(expiresFor(ticketKey)).toEqual([DAILY_TTL]);
  });
});

describe('review 4, finding 2 — a key of the wrong type consumes nothing', () => {
  it('answers 503 and leaves the ticket, the fingerprint and the day unspent', async () => {
    const h = await handler();
    const today = daysAgo(0);
    const played = dailyRun(today, 14);
    const submission = await body(played, 'p1', 'Ann');
    // A plain string where the daily board's sorted set belongs. However it
    // got there, it is the shape of failure the script has to survive.
    store.set(dailyKeyFor(today), { kind: 'string', value: 'not a board' });

    const res = await h(post(`daily-${today}`, submission));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Leaderboard unavailable' });

    // The writes used to run in order: the fingerprint reserved, the daily id
    // recorded, and then `ZADD` raising WRONGTYPE with the ticket's outcome —
    // the last write of all — never reached. A script is atomic but it is not
    // a transaction, so those two stood. Repairing the key and resubmitting
    // was then answered `replay`: the run was banked and the score was not.
    expect([...store.keys()]).toEqual([dailyKeyFor(today)]);

    // Repair it, and the same ticket and the same replay still land.
    store.delete(dailyKeyFor(today));
    const retried = await h(post(`daily-${today}`, submission));
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ rank: 1 });
    expect(storedBoard(dailyKeyFor(today))).toEqual([['p1', played.score]]);
  });

  it('checks only the keys the submission would write', async () => {
    const h = await handler();
    // Classic never touches the daily-id set, so junk parked there is not
    // this submission's problem and must not take the board down with it.
    store.set(`${CLASSIC_KEY}:ids`, { kind: 'string', value: 'not a set' });

    const res = await h(post('classic', await body(run('classic', 12), 'p1', 'Ann')));
    expect(res.status).toBe(200);
    expect(storedBoard(CLASSIC_KEY)).toHaveLength(1);
  });

  it('surfaces a wrong-typed board on a read as well', async () => {
    const h = await handler();
    store.set(CLASSIC_KEY, { kind: 'string', value: 'not a board' });

    // The stub used to answer a ZRANGE against a string with an empty list,
    // so a broken board read back as an empty one — a 200 saying nobody has
    // ever scored. Redis raises WRONGTYPE, and the handler's guard is what
    // turns that into the 503 it documents.
    const res = await h(get('classic'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Leaderboard unavailable' });
  });
});
