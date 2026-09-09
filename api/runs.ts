import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

/**
 * Anonymous run telemetry.
 *
 * POST stores one finished run; GET returns aggregates only. Raw runs and
 * player ids never leave this function, so the endpoint can stay public
 * without turning into a way to read other people's play history.
 */

const KEY = 'telemetry:enclave:runs';
/** Keep the newest 5,000 runs — enough to tune the clock, small enough to scan */
const MAX_RUNS = 5000;

const VALID_MODES = ['classic', 'blitz', 'daily', 'siege'] as const;
type Mode = (typeof VALID_MODES)[number];

// ── Limits. Anything outside these is a bug or an attack, not a real run. ──
const MAX_BODY_BYTES = 2048;
const MAX_STRING = 32;
/** Player ids are the leaderboard's UUIDs, which are 36 chars — hence the wider cap */
const MAX_PID = 64;
const MAX_COUNT = 100_000;
const MAX_SCORE = 100_000_000;
const MAX_DURATION_S = 21_600;
const MAX_ROOM_SIZE_KEYS = 100;

/** The siege's scalar counters, validated and stored as one list */
const SIEGE_COUNTS = ['enemiesCaptured', 'wallsLost', 'breachTurn', 'routeChanging'] as const;

interface RunRecord {
  v: string;
  mode: Mode;
  seed?: number;
  durationS: number;
  endCause: string;
  score: number;
  rooms: number;
  biggest: number;
  maxStreak: number;
  holds: number;
  placements: number;
  surveys: number;
  litCells: number;
  tier: string;
  roomSizes: Record<string, number>;
  pid?: string;
  /**
   * Which siege, as 'm1-raiders-finite'. The 2×2 is the whole question this
   * prototype is asking, so a siege run that cannot be told apart from the
   * other three is a run that measures nothing.
   */
  variant?: string;
  enemiesCaptured?: number;
  wallsLost?: number;
  breachTurn?: number;
  routeChanging?: number;
  /** Server clock, so runs can be bucketed by day without trusting the client */
  ts: string;
}

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function json(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function fail(message: string, status: number): Response {
  return json({ error: message }, status);
}

// ── Redis ──

/**
 * Missing or blank credentials would otherwise surface as an opaque fetch
 * failure deep inside the SDK, so check first and answer 503 instead.
 */
function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch {
    return null;
  }
}

// ── Validation ──

function isString(v: unknown, max: number = MAX_STRING): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/** Non-negative, finite, and within a sane ceiling */
function isNumber(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
}

function isCount(v: unknown): v is number {
  return isNumber(v, MAX_COUNT) && Number.isInteger(v);
}

function isRoomSizes(v: unknown): v is Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_ROOM_SIZE_KEYS) return false;
  for (const [area, count] of entries) {
    const n = Number(area);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_COUNT) return false;
    if (!isCount(count)) return false;
  }
  return true;
}

/** Returns the record to store, or null if anything about the body is off. */
function parseRun(raw: unknown): RunRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;

  if (!isString(b.v)) return null;
  if (typeof b.mode !== 'string' || !VALID_MODES.includes(b.mode as Mode)) return null;
  if (!isString(b.endCause)) return null;
  if (!isString(b.tier)) return null;
  if (!isNumber(b.durationS, MAX_DURATION_S)) return null;
  if (!isNumber(b.score, MAX_SCORE)) return null;
  if (!isCount(b.rooms)) return null;
  if (!isCount(b.biggest)) return null;
  if (!isCount(b.maxStreak)) return null;
  if (!isCount(b.holds)) return null;
  if (!isCount(b.placements)) return null;
  if (!isCount(b.surveys)) return null;
  if (!isCount(b.litCells)) return null;
  if (!isRoomSizes(b.roomSizes)) return null;
  if (b.seed !== undefined && !isNumber(b.seed, Number.MAX_SAFE_INTEGER)) return null;
  if (b.pid !== undefined && !isString(b.pid, MAX_PID)) return null;
  if (b.variant !== undefined && !isString(b.variant, MAX_STRING)) return null;
  for (const key of SIEGE_COUNTS) {
    if (b[key] !== undefined && !isCount(b[key])) return null;
  }

  const record: RunRecord = {
    v: b.v,
    mode: b.mode as Mode,
    durationS: b.durationS,
    endCause: b.endCause,
    score: b.score,
    rooms: b.rooms,
    biggest: b.biggest,
    maxStreak: b.maxStreak,
    holds: b.holds,
    placements: b.placements,
    surveys: b.surveys,
    litCells: b.litCells,
    tier: b.tier,
    roomSizes: b.roomSizes,
    ts: new Date().toISOString(),
  };
  if (typeof b.seed === 'number') record.seed = b.seed;
  if (typeof b.pid === 'string') record.pid = b.pid;
  if (typeof b.variant === 'string') record.variant = b.variant;
  for (const key of SIEGE_COUNTS) {
    const value = b[key];
    if (typeof value === 'number') record[key] = value;
  }
  return record;
}

// ── Aggregation ──

interface ModeStats {
  count: number;
  medianDurationS: number;
  medianScore: number;
  meanRooms: number;
  /** Territory: surveys finished per run, and floor still lit when it ended */
  meanSurveys: number;
  meanLitCells: number;
  endCauses: Record<string, number>;
  /** Share of runs that used hold at least once, 0–1 */
  holdUsageRate: number;
  roomSizes: Record<string, number>;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function summarise(runs: RunRecord[]): ModeStats {
  const durations = runs.map(r => r.durationS).sort((a, b) => a - b);
  const scores = runs.map(r => r.score).sort((a, b) => a - b);
  const endCauses: Record<string, number> = {};
  const roomSizes: Record<string, number> = {};
  let roomTotal = 0;
  let withHolds = 0;
  let surveyTotal = 0;
  let litTotal = 0;

  for (const r of runs) {
    endCauses[r.endCause] = (endCauses[r.endCause] ?? 0) + 1;
    roomTotal += r.rooms;
    // Runs stored before territory shipped carry neither field
    surveyTotal += r.surveys ?? 0;
    litTotal += r.litCells ?? 0;
    if (r.holds > 0) withHolds++;
    for (const [area, count] of Object.entries(r.roomSizes)) {
      roomSizes[area] = (roomSizes[area] ?? 0) + count;
    }
  }

  return {
    count: runs.length,
    medianDurationS: round(median(durations), 1),
    medianScore: round(median(scores), 1),
    meanRooms: runs.length ? round(roomTotal / runs.length, 2) : 0,
    meanSurveys: runs.length ? round(surveyTotal / runs.length, 2) : 0,
    meanLitCells: runs.length ? round(litTotal / runs.length, 2) : 0,
    endCauses,
    holdUsageRate: runs.length ? round(withHolds / runs.length, 3) : 0,
    roomSizes,
  };
}

/**
 * Stored entries come back already JSON-parsed by the Upstash client, but a
 * hand-written or legacy entry may still be a string — accept both, skip junk.
 */
function toRecord(raw: unknown): RunRecord | null {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as RunRecord;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as RunRecord;
  return null;
}

function isUsable(r: RunRecord | null): r is RunRecord {
  return !!r
    && VALID_MODES.includes(r.mode)
    && typeof r.durationS === 'number'
    && typeof r.score === 'number'
    && typeof r.rooms === 'number'
    && typeof r.holds === 'number'
    && typeof r.endCause === 'string'
    && typeof r.v === 'string'
    && !!r.roomSizes && typeof r.roomSizes === 'object';
}

// ── Handler ──

export default async function handler(request: Request): Promise<Response> {
  const redis = getRedis();
  if (!redis) return fail('Telemetry storage not configured', 503);

  if (request.method === 'GET') {
    let raw: unknown[];
    try {
      raw = await redis.lrange<unknown>(KEY, 0, MAX_RUNS - 1);
    } catch {
      return fail('Telemetry storage unavailable', 503);
    }

    const runs = raw.map(toRecord).filter(isUsable);
    const versions: Record<string, number> = {};
    for (const r of runs) versions[r.v] = (versions[r.v] ?? 0) + 1;

    const modes: Record<string, ModeStats> = {};
    for (const mode of VALID_MODES) {
      modes[mode] = summarise(runs.filter(r => r.mode === mode));
    }

    // The four sieges get their own rows: the point of the 2×2 is comparing
    // them, and an aggregate over all four would answer nothing.
    const variants: Record<string, ModeStats> = {};
    for (const run of runs) {
      if (run.mode !== 'siege' || !run.variant || variants[run.variant]) continue;
      variants[run.variant] = summarise(runs.filter(r => r.variant === run.variant));
    }

    return json({ total: runs.length, versions, modes, variants });
  }

  if (request.method === 'POST') {
    let text: string;
    try {
      text = await request.text();
    } catch {
      return fail('Unreadable body', 400);
    }
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return fail('Body too large', 400);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail('Invalid JSON', 400);
    }

    const record = parseRun(body);
    if (!record) return fail('Invalid data', 400);

    try {
      await redis.lpush(KEY, JSON.stringify(record));
      await redis.ltrim(KEY, 0, MAX_RUNS - 1);
    } catch {
      return fail('Telemetry storage unavailable', 503);
    }

    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }

  return fail('Method not allowed', 405);
}
