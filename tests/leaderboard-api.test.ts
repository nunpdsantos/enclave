import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { Difficulty } from '../src/core/Config';
import { dailySeed } from '../src/core/Daily';
import { RULES_VERSION } from '../src/core/Rules';
import { BotRun, playBotRun } from './helpers';

/**
 * The leaderboard endpoint end to end.
 *
 * `api/` sits outside tsconfig's `include`, so the build never type-checks it
 * — this is what stands between a validation mistake and production. Redis is
 * a local in-memory stub speaking the Upstash REST protocol, so the test needs
 * no credentials and no network.
 *
 * Two things matter here. That the daily's rules (a board per UTC date, a
 * TTL, no back-filling, first submission wins) did not disturb Classic or
 * Blitz. And that no score gets on any board without a replay the server can
 * re-play to exactly that number — so every POST below carries a run that was
 * actually played, because a made-up one is now refused.
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
 * carries both and the server checks they agree — which is also how a run
 * that crossed midnight still posts to the board it was dealt from.
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

/** The body a current client sends: a score, and the log that proves it. */
function body(r: BotRun, id: string, name: string): Record<string, unknown> {
  return { id, name, score: r.score, replay: r.replay };
}

const CLASSIC_KEY = 'leaderboard:enclave:classic';
const DAILY_TTL = 8 * 24 * 60 * 60;

describe('api/leaderboard — classic and blitz are untouched', () => {
  it('takes a first score, then lets the same id beat itself', async () => {
    const h = await handler();
    const modest = run('classic', 8);
    const better = run('classic', 16);
    const worse = run('classic', 4);
    expect(worse.score).toBeLessThan(modest.score);
    expect(better.score).toBeGreaterThan(modest.score);

    const first = await h(post('classic', body(modest, 'p1', 'Ann')));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ rank: 1 });

    const up = await h(post('classic', body(better, 'p1', 'Ann')));
    const upBody = await up.json();
    expect(upBody.rank).toBe(1);
    expect(upBody.entries).toHaveLength(1);
    expect(upBody.entries[0].score).toBe(better.score);

    // A worse run leaves the entry alone and reports where they already stand
    const down = await h(post('classic', body(worse, 'p1', 'Ann')));
    const downBody = await down.json();
    expect(downBody.rank).toBe(1);
    expect(downBody.entries[0].score).toBe(better.score);
  });

  it('orders entries and reads them back on GET', async () => {
    const h = await handler();
    await h(post('classic', body(run('classic', 6), 'p1', 'Ann')));
    await h(post('classic', body(run('classic', 18), 'p2', 'Bo')));

    const res = await h(get('classic'));
    expect(res.status).toBe(200);
    const entries = await res.json();
    expect(entries.map((e: { name: string }) => e.name)).toEqual(['Bo', 'Ann']);
  });

  it('never sets a TTL on a permanent board', async () => {
    const h = await handler();
    await h(post('classic', body(run('classic', 8), 'p1', 'Ann')));
    await h(post('blitz', body(run('blitz', 8), 'p1', 'Ann')));

    expect([...store.keys()].sort()).toEqual([
      'leaderboard:enclave:blitz',
      'leaderboard:enclave:classic',
    ]);
    expect(expires).toEqual([]);
  });

  it('still falls back to classic for an unrecognised mode', async () => {
    const h = await handler();
    const res = await h(post('zen', body(run('classic', 8), 'p1', 'Ann')));
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

describe('api/leaderboard — the score has to be provable', () => {
  it('stores a score its replay re-plays to', async () => {
    const h = await handler();
    const played = run('classic', 12);
    const res = await h(post('classic', body(played, 'p1', 'Ann')));

    expect(res.status).toBe(200);
    const stored = JSON.parse(store.get(CLASSIC_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: 'p1', name: 'Ann', score: played.score });
  });

  it('tells a client with no replay to update, and stores nothing', async () => {
    const h = await handler();
    const played = run('classic', 12);
    const res = await h(post('classic', { id: 'p1', name: 'Ann', score: played.score }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Update required' });
    expect(store.size).toBe(0);
  });

  it('refuses a score the replay does not produce', async () => {
    const h = await handler();
    const played = run('classic', 12);
    for (const score of [played.score + 1, played.score * 10, 1]) {
      const res = await h(post('classic', { ...body(played, 'p1', 'Ann'), score }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Score could not be verified', reason: 'score' });
    }
    expect(store.size).toBe(0);
  });

  it('refuses a body over 64 KB before it parses it', async () => {
    const h = await handler();
    const played = run('classic', 12);
    const res = await h(post('classic', { ...body(played, 'p1', 'Ann'), pad: 'x'.repeat(70_000) }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Body too large' });
    expect(store.size).toBe(0);
  });

  it('refuses another rules version, a mismatched board, and a truncated log', async () => {
    const h = await handler();
    const classic = run('classic', 12);

    const stale = { ...body(classic, 'p1', 'Ann'), replay: { ...classic.replay, rules: RULES_VERSION + 1 } };
    expect(await (await h(post('classic', stale))).json())
      .toEqual({ error: 'Score could not be verified', reason: 'rules' });

    // A Blitz run is not a Classic score, whatever board it is posted to
    const blitz = run('blitz', 12);
    const wrongBoard = { ...body(blitz, 'p1', 'Ann'), replay: blitz.replay };
    expect(await (await h(post('classic', wrongBoard))).json())
      .toEqual({ error: 'Score could not be verified', reason: 'shape' });

    const cut = { ...body(classic, 'p1', 'Ann'), replay: { ...classic.replay, truncated: true } };
    expect(await (await h(post('classic', cut))).json())
      .toEqual({ error: 'Score could not be verified', reason: 'shape' });

    // A move off the board never reaches the simulation
    const offBoard = {
      ...body(classic, 'p1', 'Ann'),
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
      ...body(played, 'p1', 'Ann'),
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

    const res = await h(post(`daily-${today}`, body(dailyRun(today, 12), 'p1', 'Ann')));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rank: 1 });

    const key = `leaderboard:enclave:daily:${today}`;
    expect(store.has(key)).toBe(true);
    expect(expires).toEqual([[key, DAILY_TTL]]);
  });

  it('keeps the first submission even when a later one is higher', async () => {
    const h = await handler();
    const today = daysAgo(0);
    const early = dailyRun(today, 8);
    const late = dailyRun(today, 28);
    expect(late.score).toBeGreaterThan(early.score);

    await h(post(`daily-${today}`, body(early, 'p1', 'Ann')));
    const second = await h(post(`daily-${today}`, body(late, 'p1', 'Ann')));

    const secondBody = await second.json();
    expect(secondBody.rank).toBe(1);
    expect(secondBody.entries).toHaveLength(1);
    expect(secondBody.entries[0].score).toBe(early.score);

    // The refusal is a read, not a write: no second TTL refresh
    expect(expires).toHaveLength(1);
  });

  it('still ranks a different player behind the first', async () => {
    const h = await handler();
    const today = daysAgo(0);
    await h(post(`daily-${today}`, body(dailyRun(today, 8), 'p1', 'Ann')));
    const res = await h(post(`daily-${today}`, body(dailyRun(today, 20), 'p2', 'Bo')));

    const resBody = await res.json();
    expect(resBody.rank).toBe(1);
    expect(resBody.entries.map((e: { name: string }) => e.name)).toEqual(['Bo', 'Ann']);
  });

  it('accepts yesterday, for a run that crossed midnight', async () => {
    const h = await handler();
    const yesterday = daysAgo(1);

    const posted = await h(post(`daily-${yesterday}`, body(dailyRun(yesterday, 10), 'p1', 'Ann')));
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
    const res = await h(post(`daily-${today}`, body(dailyRun(daysAgo(1), 10), 'p1', 'Ann')));

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
    await h(post(`daily-${daysAgo(0)}`, body(dailyRun(daysAgo(0), 6), 'p1', 'Ann')));
    await h(post(`daily-${daysAgo(1)}`, body(dailyRun(daysAgo(1), 6), 'p1', 'Ann')));

    expect([...store.keys()].sort()).toEqual([
      `leaderboard:enclave:daily:${daysAgo(1)}`,
      `leaderboard:enclave:daily:${daysAgo(0)}`,
    ].sort());
    expect(store.has(CLASSIC_KEY)).toBe(false);
  });
});
