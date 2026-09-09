/**
 * Seeded randomness.
 *
 * Every run now deals from a seed instead of `Math.random()` directly, which
 * is what lets two devices play the same pieces: the Rationed Daily derives
 * its seed from the UTC date, and free play mints a throwaway one. The
 * generator is mulberry32 — 32 bits of state, a handful of integer ops, and
 * a period long enough that a 30-piece hand never sees it.
 *
 * Nothing here is cryptographic. It is a dealer, not a lottery.
 */

/** A [0, 1) generator. Same shape as `Math.random`, so it drops straight in. */
export type Rng = () => number;

/**
 * mulberry32: one 32-bit word of state, uniform enough for shuffling.
 * The reference implementation, kept intact so a seed means the same thing
 * here as it does in any other mulberry32.
 */
export function mulberry32(seed: number): Rng {
  let a = seed | 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a, 32-bit, returned unsigned.
 *
 * Chosen because it is short enough to re-implement anywhere (a server, a
 * spreadsheet, another language) and get the same number, which matters when
 * the seed is the contract between every player of a daily.
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A fresh 32-bit seed for free play, where nothing has to be reproducible. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}
