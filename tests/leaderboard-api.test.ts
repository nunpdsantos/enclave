import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';

/**
 * The leaderboard endpoint end to end.
 *
 * `api/` sits outside tsconfig's `include`, so the build never type-checks it
 * — this is what stands between a validation mistake and production. Redis is
 * a local in-memory stub speaking the Upstash REST protocol, so the test needs
 * no credentials and no network.
 *
 * What matters here is that the daily's rules (a board per UTC date, a TTL,
 * no back-filling, first submission wins) did not disturb Classic or Blitz.
 */

/** Minimal in-memory Upstash REST stub: GET / SET / EXPIRE only. */
const store = new Map<string, string>();
const expires: [string, number][] = [];
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const parsed = JSON.parse(raw) as unknown[];
      // The SDK auto-pipelines, so a body may be one command or a list of them.
      const pipelined = Array.isArray(parsed[0]);
      const cmds = (pipelined ? parsed : [parsed]) as unknown[][];
      const results = cmds.map(cmd => {
        const name = String(cmd[0]).toLowerCase();
        const key = String(cmd[1]);
        if (name === 'get') return { result: store.get(key) ?? null };
        if (name === 'set') {
          store.set(key, String(cmd[2]));
          return { result: 'OK' };
        }
        if (name === 'expire') {
          expires.push([key, Number(cmd[2])]);
          return { result: 1 };
        }
        return { result: 'OK' };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pipelined ? results : results[0]));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.KV_REST_API_URL = base;
  process.env.KV_REST_API_TOKEN = 'fake';
});

afterAll(() => { server.close(); });

beforeEach(() => {
  store.clear();
  expires.length = 0;
});

async function handler() {
  return (await import('../api/leaderboard')).default;
}

const URL_BASE = 'https://x/api/leaderboard';

function get(difficulty: string): Request {
  return new Request(`${URL_BASE}?difficulty=${encodeURIComponent(difficulty)}`);
}

function post(difficulty: string, body: unknown): Request {
  return new Request(`${URL_BASE}?difficulty=${encodeURIComponent(difficulty)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** A UTC date `days` before today, in the form the API expects */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

const CLASSIC_KEY = 'leaderboard:enclave:classic';
const DAILY_TTL = 8 * 24 * 60 * 60;

describe('api/leaderboard — classic and blitz are untouched', () => {
  it('takes a first score, then lets the same id beat itself', async () => {
    const h = await handler();

    const first = await h(post('classic', { id: 'p1', name: 'Ann', score: 100 }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ rank: 1 });

    const better = await h(post('classic', { id: 'p1', name: 'Ann', score: 250 }));
    const body = await better.json();
    expect(body.rank).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].score).toBe(250);

    // A worse run leaves the entry alone and reports where they already stand
    const worse = await h(post('classic', { id: 'p1', name: 'Ann', score: 10 }));
    const worseBody = await worse.json();
    expect(worseBody.rank).toBe(1);
    expect(worseBody.entries[0].score).toBe(250);
  });

  it('orders entries and reads them back on GET', async () => {
    const h = await handler();
    await h(post('classic', { id: 'p1', name: 'Ann', score: 100 }));
    await h(post('classic', { id: 'p2', name: 'Bo', score: 500 }));

    const res = await h(get('classic'));
    expect(res.status).toBe(200);
    const entries = await res.json();
    expect(entries.map((e: { name: string }) => e.name)).toEqual(['Bo', 'Ann']);
  });

  it('never sets a TTL on a permanent board', async () => {
    const h = await handler();
    await h(post('classic', { id: 'p1', name: 'Ann', score: 100 }));
    await h(post('blitz', { id: 'p1', name: 'Ann', score: 100 }));

    expect([...store.keys()].sort()).toEqual([
      'leaderboard:enclave:blitz',
      'leaderboard:enclave:classic',
    ]);
    expect(expires).toEqual([]);
  });

  it('still falls back to classic for an unrecognised mode', async () => {
    const h = await handler();
    const res = await h(post('zen', { id: 'p1', name: 'Ann', score: 100 }));
    expect(res.status).toBe(200);
    expect(store.has(CLASSIC_KEY)).toBe(true);
  });

  it('rejects other methods with 405', async () => {
    const h = await handler();
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      expect((await h(new Request(URL_BASE, { method }))).status).toBe(405);
    }
  });
});

describe('api/leaderboard — the daily', () => {
  it('accepts today, stores it under a dated key, and expires it', async () => {
    const h = await handler();
    const today = daysAgo(0);

    const res = await h(post(`daily-${today}`, { id: 'p1', name: 'Ann', score: 900 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rank: 1 });

    const key = `leaderboard:enclave:daily:${today}`;
    expect(store.has(key)).toBe(true);
    expect(expires).toEqual([[key, DAILY_TTL]]);
  });

  it('keeps the first submission even when a later one is higher', async () => {
    const h = await handler();
    const today = daysAgo(0);

    await h(post(`daily-${today}`, { id: 'p1', name: 'Ann', score: 900 }));
    const second = await h(post(`daily-${today}`, { id: 'p1', name: 'Ann', score: 99_000 }));

    const body = await second.json();
    expect(body.rank).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].score).toBe(900);

    // The refusal is a read, not a write: no second TTL refresh
    expect(expires).toHaveLength(1);
  });

  it('still ranks a different player behind the first', async () => {
    const h = await handler();
    const today = daysAgo(0);
    await h(post(`daily-${today}`, { id: 'p1', name: 'Ann', score: 900 }));
    const res = await h(post(`daily-${today}`, { id: 'p2', name: 'Bo', score: 1200 }));

    const body = await res.json();
    expect(body.rank).toBe(1);
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['Bo', 'Ann']);
  });

  it('accepts yesterday, for a run that crossed midnight', async () => {
    const h = await handler();
    const yesterday = daysAgo(1);

    const posted = await h(post(`daily-${yesterday}`, { id: 'p1', name: 'Ann', score: 700 }));
    expect(posted.status).toBe(200);

    const res = await h(get(`daily-${yesterday}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
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
    for (const body of [{ id: 'p1', name: 'Ann' }, { id: 'p1', name: 'Ann', score: 0 }, { name: 'Ann', score: 5 }]) {
      expect((await h(post(`daily-${today}`, body))).status).toBe(400);
    }
    expect(store.size).toBe(0);
  });

  it('keeps each day on its own board', async () => {
    const h = await handler();
    await h(post(`daily-${daysAgo(0)}`, { id: 'p1', name: 'Ann', score: 900 }));
    await h(post(`daily-${daysAgo(1)}`, { id: 'p1', name: 'Ann', score: 100 }));

    expect([...store.keys()].sort()).toEqual([
      `leaderboard:enclave:daily:${daysAgo(1)}`,
      `leaderboard:enclave:daily:${daysAgo(0)}`,
    ].sort());
    expect(store.has(CLASSIC_KEY)).toBe(false);
  });
});
