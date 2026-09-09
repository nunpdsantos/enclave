import type { Difficulty } from './Config';
import { isDailyKey } from './Daily';
import type { Move } from './types';

/**
 * Run tickets: the server's signed record that a particular player was dealt
 * a particular seed at a particular moment.
 *
 * A replay proves that the *rules* produce a score. It cannot prove that
 * anybody played it, that the person submitting it is the person who played
 * it, or that it took as long as it says: a log of six hundred placements at
 * a quarter of a second apart re-plays perfectly whether it was played over
 * two minutes or generated in two milliseconds. The ticket is what closes
 * that: the server picks the seed, signs it against one player id and one
 * clock reading, and refuses a submission whose replay claims more play than
 * the wall clock has allowed since.
 *
 * Everything here is pure: the secret is a parameter, never read from the
 * environment, so this module can be imported by both edge functions without
 * either of them deciding where a secret comes from — and so it can never be
 * bundled into the client carrying one.
 */

/** The one payload version this build issues and accepts. */
export const TICKET_VERSION = 1;

/** Longest token we will even look at, so a huge string cannot cost us work. */
const MAX_TOKEN_LENGTH = 1024;

const U32_MAX = 0xffffffff;

/**
 * What a ticket says. Signed as a whole: change any field and the MAC no
 * longer matches, so the seed, the id, the mode and the issue time are one
 * indivisible claim rather than four hints.
 */
export interface TicketPayload {
  /** TICKET_VERSION at issue */
  v: number;
  /** The anonymous player id the run — and its submission — is bound to */
  id: string;
  mode: Difficulty;
  /** The deal the server chose. The replay's seed has to be this number. */
  seed: number;
  /** 'YYYY-MM-DD' for a daily ticket; absent for free play */
  dailyKey?: string;
  /** ms since the epoch, from the server's clock at issue */
  issuedAt: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── base64url, on bytes and on text ──

function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function base64urlFromText(text: string): string {
  return base64urlFromBytes(encoder.encode(text));
}

function textFromBase64url(text: string): string | null {
  const bytes = bytesFromBase64url(text);
  return bytes === null ? null : decoder.decode(bytes);
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// ── HMAC-SHA-256 ──

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

/** HMAC-SHA-256 of `message` under `secret`, as raw bytes. */
export async function hmacBytes(secret: string, message: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message));
  return new Uint8Array(signature);
}

/**
 * Compare two MACs without leaking where they first differ. Cheap, and the
 * habit is worth more than the microseconds: a comparison that returns early
 * is the classic way a signature check becomes a signature oracle.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── The ticket itself ──

/**
 * `base64url(JSON payload) + '.' + base64url(HMAC-SHA-256(secret, that same
 * base64url text))`.
 *
 * The MAC covers the encoded segment rather than the JSON behind it, so
 * verification never has to re-encode anything to check a signature: the
 * bytes that were signed are exactly the bytes that arrived.
 */
export async function signTicket(secret: string, payload: TicketPayload): Promise<string> {
  const body = base64urlFromText(JSON.stringify(payload));
  return `${body}.${base64urlFromBytes(await hmacBytes(secret, body))}`;
}

/**
 * The payload of a token this secret really signed, or null.
 *
 * Null covers every way a token can be wrong — not a string, not two
 * segments, a MAC that does not match, a body that is not JSON, a payload
 * that is not a ticket — because a caller has nothing useful to do with the
 * difference and an attacker should not be told it.
 */
export async function verifyTicket(secret: string, token: unknown): Promise<TicketPayload | null> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;

  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!timingSafeEqual(mac, base64urlFromBytes(await hmacBytes(secret, body)))) return null;

  const json = textFromBase64url(body);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;

  if (p.v !== TICKET_VERSION) return null;
  if (typeof p.id !== 'string' || p.id.length === 0) return null;
  if (p.mode !== 'classic' && p.mode !== 'blitz' && p.mode !== 'daily') return null;
  if (typeof p.seed !== 'number' || !Number.isInteger(p.seed) || p.seed < 0 || p.seed > U32_MAX) {
    return null;
  }
  if (typeof p.issuedAt !== 'number' || !Number.isFinite(p.issuedAt) || p.issuedAt <= 0) return null;
  if (p.dailyKey !== undefined && (typeof p.dailyKey !== 'string' || !isDailyKey(p.dailyKey))) {
    return null;
  }
  // The daily's whole promise is one deal per date, so a daily ticket without
  // a date — or a free-play ticket carrying one — is not a ticket we issued.
  if ((p.mode === 'daily') !== (p.dailyKey !== undefined)) return null;

  return {
    v: p.v,
    id: p.id,
    mode: p.mode,
    seed: p.seed,
    ...(typeof p.dailyKey === 'string' ? { dailyKey: p.dailyKey } : {}),
    issuedAt: p.issuedAt,
  };
}

/**
 * The daily's deal, derived from the secret rather than from the date.
 *
 * `Daily.dailySeed` hashes the date with FNV-1a, which anyone can compute —
 * so anyone could deal themselves tomorrow's puzzle, solve it overnight and
 * post a studied run the moment it opens. Taking the first 32 bits of an
 * HMAC under the server's secret makes a future deal unknowable until the
 * server hands out a ticket for it, and still gives every player of that day
 * the same 32 bits.
 */
export async function dailySeedFor(secret: string, key: string): Promise<number> {
  const mac = await hmacBytes(secret, `enclave-daily-${key}`);
  return ((mac[0] << 24) | (mac[1] << 16) | (mac[2] << 8) | mac[3]) >>> 0;
}

/**
 * A stable fingerprint of "this exact run", for the replay dedupe.
 *
 * The moves are re-serialised into fixed tuples rather than hashed as they
 * arrived: JSON.stringify preserves whatever key order the sender used, so
 * hashing the raw text would let `{"t":"p","at":1}` and `{"at":1,"t":"p"}`
 * bank the same run twice.
 */
export async function replayFingerprint(seed: number, moves: readonly Move[]): Promise<string> {
  const canonical = moves.map(m => (m.t === 'p' ? ['p', m.row, m.col, m.rot, m.at] : ['h', m.at]));
  const digest = await crypto.subtle.digest(
    'SHA-256', encoder.encode(`${seed}:${JSON.stringify(canonical)}`),
  );
  return hex(new Uint8Array(digest));
}
