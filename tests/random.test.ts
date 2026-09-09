import { describe, it, expect } from 'vitest';
import { hashString, mulberry32, randomSeed } from '../src/core/Random';
import { PIECE_TYPES, PieceBag } from '../src/core/Pieces';
import { PieceInstance } from '../src/core/types';

/**
 * The seeded dealer.
 *
 * Two people playing the same daily have to see the same thirty pieces, in
 * the same rotations, in the same colours — so all three come out of the
 * seeded stream, and this is what pins that down.
 */

/** Everything about a dealt piece that a player can see */
function fingerprint(p: PieceInstance): string {
  return `${p.typeId}:${p.rotation}:${p.color.toString(16)}`;
}

function deal(bag: PieceBag, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const piece = bag.next();
    if (!piece) break;
    out.push(fingerprint(piece));
  }
  return out;
}

describe('mulberry32', () => {
  it('gives the same stream for the same seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const first = Array.from({ length: 10 }, () => a());
    const second = Array.from({ length: 10 }, () => b());
    expect(second).toEqual(first);
  });

  it('gives a different stream for a different seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12346);
    const first = Array.from({ length: 10 }, () => a());
    const second = Array.from({ length: 10 }, () => b());
    expect(second).not.toEqual(first);
  });

  it('stays in [0, 1)', () => {
    // A seed of 0 is the one that a weaker generator degenerates on
    for (const seed of [0, 1, 12345, 0xffffffff, -7]) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 500; i++) {
        const v = rng();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });
});

describe('hashString', () => {
  it('is FNV-1a 32-bit, unsigned, and stable', () => {
    // The value the whole daily hangs off: change this and every player's
    // Daily #9 changes with it.
    expect(hashString('enclave-daily-2026-09-09')).toBe(1702173874);
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('a')).toBe(0xe40c292c);
  });

  it('separates neighbouring days', () => {
    expect(hashString('enclave-daily-2026-09-09'))
      .not.toBe(hashString('enclave-daily-2026-09-08'));
  });

  it('never returns a negative number', () => {
    for (const s of ['enclave-daily-2026-09-09', 'zzz', 'ÿþ', 'the quick brown fox']) {
      expect(hashString(s)).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(hashString(s))).toBe(true);
    }
  });
});

describe('randomSeed', () => {
  it('is a 32-bit unsigned integer', () => {
    for (let i = 0; i < 100; i++) {
      const s = randomSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('PieceBag', () => {
  it('deals an identical 30-piece sequence from the same seed', () => {
    const first = deal(new PieceBag(mulberry32(1702173874)), 30);
    const second = deal(new PieceBag(mulberry32(1702173874)), 30);

    expect(first).toHaveLength(30);
    expect(second).toEqual(first);
    // The fingerprint carries rotation and colour, so this is not just the
    // shape order matching
    expect(first[0]).toMatch(/^[a-z_0-9]+:\d+:[0-9a-f]+$/);
  });

  it('deals a different sequence from a different seed', () => {
    const a = deal(new PieceBag(mulberry32(1)), 30);
    const b = deal(new PieceBag(mulberry32(2)), 30);
    expect(b).not.toEqual(a);
  });

  it('deals exactly `limit` pieces, then null forever', () => {
    const bag = new PieceBag(mulberry32(99), 30);
    expect(bag.remaining).toBe(30);
    for (let i = 0; i < 30; i++) {
      expect(bag.next()).not.toBeNull();
      expect(bag.remaining).toBe(29 - i);
    }
    expect(bag.next()).toBeNull();
    expect(bag.next()).toBeNull();
    expect(bag.remaining).toBe(0);
  });

  it('is unlimited with no limit, and unseeded by default', () => {
    const bag = new PieceBag();
    expect(bag.remaining).toBe(Infinity);
    // Well past one bag's worth, so this covers a refill
    for (let i = 0; i < 60; i++) expect(bag.next()).not.toBeNull();
  });

  it('covers the whole bag before repeating a shape', () => {
    // The bag guarantee has to survive seeding: one full bag is every type
    // repeated bagCount times, and nothing else
    const bagSize = PIECE_TYPES.reduce((n, t) => n + t.bagCount, 0);
    const bag = new PieceBag(mulberry32(7));
    const ids: string[] = [];
    for (let i = 0; i < bagSize; i++) ids.push(bag.next()!.typeId);
    for (const t of PIECE_TYPES) {
      expect(`${t.id}:${ids.filter(id => id === t.id).length}`).toBe(`${t.id}:${t.bagCount}`);
    }
  });
});
