import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

const VALID_DIFFICULTIES = ['classic', 'blitz'];
const MAX_ENTRIES = 10;

interface Entry {
  id: string;
  name: string;
  score: number;
  date: string;
}

function kvKey(difficulty: string): string {
  return `leaderboard:enclave:${difficulty}`;
}

function getRedis(): Redis {
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  });
}

async function getEntries(difficulty: string): Promise<Entry[]> {
  const redis = getRedis();
  return (await redis.get<Entry[]>(kvKey(difficulty))) || [];
}

async function saveEntries(difficulty: string, entries: Entry[]): Promise<void> {
  const redis = getRedis();
  await redis.set(kvKey(difficulty), entries);
}

function parseDifficulty(url: string): string {
  const u = new URL(url);
  const d = u.searchParams.get('difficulty') || 'classic';
  return VALID_DIFFICULTIES.includes(d) ? d : 'classic';
}

export default async function handler(request: Request): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  const difficulty = parseDifficulty(request.url);

  if (request.method === 'GET') {
    const entries = await getEntries(difficulty);
    return new Response(JSON.stringify(entries), { headers });
  }

  if (request.method === 'POST') {
    let body: { id?: string; name?: string; score?: number };
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
    }

    const { id, name, score } = body;
    if (!id || !name || typeof score !== 'number' || score <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid data' }), { status: 400, headers });
    }

    const entries = await getEntries(difficulty);

    const existingIdx = entries.findIndex(e => e.id === id);
    if (existingIdx >= 0) {
      if (entries[existingIdx].score > score) {
        // New score is strictly lower — keep old entry, return its rank
        return new Response(JSON.stringify({ rank: existingIdx + 1, entries }), { headers });
      }
      if (entries[existingIdx].score === score) {
        // Same score — update name in place, persist, return rank
        entries[existingIdx].name = name.trim().slice(0, 12) || 'Player';
        await saveEntries(difficulty, entries);
        return new Response(JSON.stringify({ rank: existingIdx + 1, entries }), { headers });
      }
      // New score is higher — remove old entry to re-insert at correct position
      entries.splice(existingIdx, 1);
    }

    const entry: Entry = {
      id,
      name: name.trim().slice(0, 12) || 'Player',
      score,
      date: new Date().toISOString().split('T')[0],
    };

    let rank = entries.findIndex(e => score > e.score);
    if (rank === -1) rank = entries.length;
    entries.splice(rank, 0, entry);

    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;

    await saveEntries(difficulty, entries);

    const finalRank = rank < MAX_ENTRIES ? rank + 1 : null;
    return new Response(JSON.stringify({ rank: finalRank, entries }), { headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
