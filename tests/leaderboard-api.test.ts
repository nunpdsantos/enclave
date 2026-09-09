import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { Difficulty, DIFFICULTY_CONFIGS } from '../src/core/Config';
import { dailyNumber, dailySeed } from '../src/core/Daily';
import { drainIntegral, simulateRun } from '../src/core/Replay';
import { RULES_VERSION } from '../src/core/Rules';
import { dailySeedFor, readTicketPayload, signTicket, TICKET_VERSION } from '../src/core/Ticket';
import { Move } from '../src/core/types';
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
/** Every EXPIRE the handler issued, in order */
const expires: [string, number][] = [];
let server: Server;
let base = '';

// Reads never create the key — Redis has no empty collections, and a stub
// that conjured one would put keys in `store` that the handler never wrote.
function readZset(key: string): Map<string, number> {
  const existing = store.get(key);
  return existing?.kind === 'zset' ? existing.members : new Map();
}

function readHash(key: string): Map<string, string> {
  const existing = store.get(key);
  return existing?.kind === 'hash' ? existing.fields : new Map();
}

function readSet(key: string): Set<string> {
  const existing = store.get(key);
  return existing?.kind === 'set' ? existing.members : new Set();
}

function zsetAt(key: string): Map<string, number> {
  const existing = store.get(key);
  if (existing?.kind === 'zset') return existing.members;
  const members = new Map<string, number>();
  store.set(key, { kind: 'zset', members });
  return members;
}

function hashAt(key: string): Map<string, string> {
  const existing = store.get(key);
  if (existing?.kind === 'hash') return existing.fields;
  const fields = new Map<string, string>();
  store.set(key, { kind: 'hash', fields });
  return fields;
}

function setAt(key: string): Set<string> {
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
      const value = store.get(key);
      return value?.kind === 'string' ? value.value : null;
    }
    case 'set':
      store.set(key, { kind: 'string', value: String(cmd[2]) });
      return 'OK';
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
    case 'hmget': {
      const fields = readHash(key);
      return cmd.slice(2).map(f => fields.get(String(f)) ?? null);
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

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const parsed = JSON.parse(raw) as unknown[];
      // The SDK auto-pipelines, so a body may be one command or a list of them.
      const pipelined = Array.isArray(parsed[0]);
      const cmds = (pipelined ? parsed : [parsed]) as unknown[][];
      const results = cmds.map(cmd => ({ result: encodeResult(execute(cmd)) }));
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

afterAll(() => { server.close(); });

beforeEach(() => {
  store.clear();
  expires.length = 0;
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

  it('refuses a body over 64 KB before it parses it', async () => {
    const h = await handler();
    const played = run('classic', 12);
    const res = await h(post('classic', {
      ...await body(played, 'p1', 'Ann'), pad: 'x'.repeat(70_000),
    }));

    expect(res.status).toBe(400);
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

  it('spends the daily attempt on the first ticket and marks every later one practice', async () => {
    const start = await runStartHandler();
    const h = await handler();
    const today = daysAgo(0);
    const ticketsKey = `${dailyKeyFor(today)}:tickets`;

    const first = await (await start(startRun({ id: 'p1', mode: 'daily' }))).json();
    const second = await (await start(startRun({ id: 'p1', mode: 'daily' }))).json();
    // A second go gets the real puzzle — replaying the day is allowed — and a
    // ticket that says it cannot be posted.
    expect(second.seed).toBe(first.seed);
    expect(readTicketPayload(first.token)?.practice).toBeUndefined();
    expect(readTicketPayload(second.token)?.practice).toBe(true);

    // The attempt is recorded where the board is, and expires with it
    expect([...readSet(ticketsKey)]).toEqual(['p1']);
    expect(expiresFor(ticketsKey)).toContain(DAILY_TTL);

    // Another player's first ticket is a first ticket
    const other = await (await start(startRun({ id: 'p2', mode: 'daily' }))).json();
    expect(readTicketPayload(other.token)?.practice).toBeUndefined();

    // Short enough to have been played in the moment since the tickets were
    // minted, which is what the real-time check asks
    const played = playBotRun('daily', first.seed, 4);
    const replay = { ...played.replay, dailyKey: today };
    const submission = (token: string): Record<string, unknown> =>
      ({ id: 'p1', name: 'Ann', score: played.score, replay, token });

    const refused = await h(post(`daily-${today}`, submission(second.token)));
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

  it('refuses placements closer together than any hand could manage', async () => {
    const h = await handler();
    const played = run('classic', 12);
    // The same inputs, fired off forty times a second. Every move is legal
    // and the score is exactly what the rules produce for them.
    const rushed: Move[] = played.replay.moves.map((m, i) => ({ ...m, at: 0.5 + i * 0.025 }));
    const res = await h(post('classic', {
      ...await body(played, 'p1', 'Ann'),
      replay: { ...played.replay, moves: rushed },
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'cadence' });
    expect(store.size).toBe(0);
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

    await Promise.all([
      h(post('classic', await body(higher, 'p1', 'Ann'))),
      h(post('classic', await body(lower, 'p1', 'Ann'))),
    ]);

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
