import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';

/**
 * The telemetry endpoint end to end.
 *
 * `api/` sits outside tsconfig's `include`, so the build never even
 * type-checks it — this is the only thing standing between a validation
 * mistake and production. Redis is a local in-memory stub speaking the
 * Upstash REST protocol, so the test needs no credentials and no network.
 */

/** Minimal in-memory Upstash REST stub: LPUSH / LTRIM / LRANGE only. */
const store = new Map<string, string[]>();
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
        const list = store.get(key) ?? [];
        if (name === 'lpush') {
          for (const v of cmd.slice(2)) list.unshift(String(v));
          store.set(key, list);
          return { result: list.length };
        }
        if (name === 'ltrim') {
          store.set(key, list.slice(Number(cmd[2]), Number(cmd[3]) + 1));
          return { result: 'OK' };
        }
        if (name === 'lrange') return { result: list.slice(Number(cmd[2]), Number(cmd[3]) + 1) };
        return { result: 'OK' };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pipelined ? results : results[0]));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => { server.close(); });

const VALID = {
  v: '0.1.0',
  mode: 'classic',
  durationS: 40,
  endCause: 'timeout',
  score: 1000,
  rooms: 4,
  biggest: 4,
  maxStreak: 3,
  holds: 1,
  placements: 20,
  tier: 'BUILDER',
  roomSizes: { '1': 2, '4': 2 },
  pid: '2a1f0b4c-9d3e-4f5a-8b7c-1e2d3f4a5b6c',
};

async function handler(configured: boolean = true) {
  if (configured) {
    process.env.KV_REST_API_URL = base;
    process.env.KV_REST_API_TOKEN = 'fake';
  } else {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
  return (await import('../api/runs')).default;
}

function post(body: unknown) {
  return new Request('https://x/api/runs', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('api/runs', () => {
  it('rejects bad bodies with 400', async () => {
    const h = await handler();
    const cases: [string, unknown][] = [
      ['not json', 'nope{'],
      ['unknown mode', { ...VALID, mode: 'zen' }],
      ['negative score', { ...VALID, score: -1 }],
      ['negative duration', { ...VALID, durationS: -0.1 }],
      ['duration beyond cap', { ...VALID, durationS: 99999 }],
      ['long string', { ...VALID, tier: 'x'.repeat(33) }],
      ['long pid', { ...VALID, pid: 'x'.repeat(65) }],
      ['missing field', { ...VALID, tier: undefined }],
      ['non-integer count', { ...VALID, rooms: 1.5 }],
      ['NaN', { ...VALID, score: 'NaN' }],
      ['bad roomSizes key', { ...VALID, roomSizes: { abc: 1 } }],
      ['array body', [1, 2, 3]],
      ['too many roomSizes', {
        ...VALID,
        roomSizes: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i + 1), 1])),
      }],
      ['oversized body', { ...VALID, pad: 'z'.repeat(2100) }],
    ];
    for (const [name, body] of cases) {
      const res = await h(post(body));
      expect(`${name}:${res.status}`).toBe(`${name}:400`);
    }
  });

  it('stores valid runs and returns 204', async () => {
    const h = await handler();
    store.clear();

    expect((await h(post(VALID))).status).toBe(204);
    expect((await h(post({ ...VALID, durationS: 20, score: 500, holds: 0, rooms: 2 }))).status).toBe(204);
    expect((await h(post({
      ...VALID, v: '0.2.0', mode: 'blitz', endCause: 'board_lock',
      durationS: 10, score: 100, holds: 0, rooms: 1, roomSizes: { '1': 1 },
    }))).status).toBe(204);

    expect(store.get('telemetry:enclave:runs')).toHaveLength(3);
  });

  it('aggregates on GET without echoing runs or pids', async () => {
    const h = await handler();
    const res = await h(new Request('https://x/api/runs?summary=1'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(JSON.stringify(body)).not.toContain(VALID.pid);
    expect(body.total).toBe(3);
    expect(body.versions).toEqual({ '0.1.0': 2, '0.2.0': 1 });
    expect(body.modes.classic.count).toBe(2);
    expect(body.modes.classic.medianDurationS).toBe(30);   // (40 + 20) / 2
    expect(body.modes.classic.medianScore).toBe(750);
    expect(body.modes.classic.meanRooms).toBe(3);
    expect(body.modes.classic.endCauses).toEqual({ timeout: 2 });
    expect(body.modes.classic.holdUsageRate).toBe(0.5);
    expect(body.modes.classic.roomSizes).toEqual({ '1': 4, '4': 4 });
    expect(body.modes.blitz.count).toBe(1);
    expect(body.modes.blitz.medianDurationS).toBe(10);
    expect(body.modes.blitz.holdUsageRate).toBe(0);
  });

  it('rejects other methods with 405', async () => {
    const h = await handler();
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      expect((await h(new Request('https://x/api/runs', { method }))).status).toBe(405);
    }
  });

  it('answers 503 when KV is not configured', async () => {
    const h = await handler(false);
    for (const method of ['GET', 'POST', 'PUT']) {
      const res = await h(new Request('https://x/api/runs', {
        method,
        body: method === 'POST' ? JSON.stringify(VALID) : undefined,
      }));
      expect(`${method}:${res.status}`).toBe(`${method}:503`);
      expect(await res.json()).toEqual({ error: 'Telemetry storage not configured' });
    }
  });
});
