import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  MOTION_ORDER,
  getPiecePalette,
  remapColor,
  resolveReducedMotion,
} from '../src/core/Accessibility';
import { HIGH_CONTRAST_PIECE_COLORS, PIECE_COLORS } from '../src/core/types';
import { updateSettings } from '../src/core/Settings';
import { Layout, LayoutManager } from '../src/rendering/LayoutManager';

// LayoutManager measures the window in its constructor. There is no DOM in
// this environment, so give it the one thing it reads.
const FAKE_WINDOW = { innerWidth: 360, innerHeight: 780 };

beforeEach(() => {
  (globalThis as { window?: unknown }).window = FAKE_WINDOW;
  updateSettings({ motion: 'system', palette: 'standard', leftHanded: false });
});

afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
  updateSettings({ motion: 'system', palette: 'standard', leftHanded: false });
});

describe('resolveReducedMotion', () => {
  it('REDUCED wins whatever the system says', () => {
    expect(resolveReducedMotion('reduced', false)).toBe(true);
    expect(resolveReducedMotion('reduced', true)).toBe(true);
  });

  it('FULL wins whatever the system says', () => {
    expect(resolveReducedMotion('full', false)).toBe(false);
    expect(resolveReducedMotion('full', true)).toBe(false);
  });

  it('SYSTEM follows the OS preference', () => {
    expect(resolveReducedMotion('system', true)).toBe(true);
    expect(resolveReducedMotion('system', false)).toBe(false);
  });

  it('the cycle order starts on the default', () => {
    expect(MOTION_ORDER[0]).toBe('system');
    expect([...MOTION_ORDER].sort()).toEqual(['full', 'reduced', 'system']);
  });
});

describe('piece palettes', () => {
  it('both hold exactly eight distinct colours', () => {
    for (const palette of [PIECE_COLORS, HIGH_CONTRAST_PIECE_COLORS]) {
      expect(palette).toHaveLength(8);
      expect(new Set(palette).size).toBe(8);
    }
  });

  it('the two palettes share no colour, so a remap always moves', () => {
    const overlap = PIECE_COLORS.filter(c => HIGH_CONTRAST_PIECE_COLORS.includes(c));
    expect(overlap).toEqual([]);
  });

  it('the standard setting deals from PIECE_COLORS itself', () => {
    expect(getPiecePalette()).toBe(PIECE_COLORS);
  });

  it('high contrast deals from the Okabe–Ito set', () => {
    updateSettings({ palette: 'highContrast' });
    expect(getPiecePalette()).toBe(HIGH_CONTRAST_PIECE_COLORS);
  });
});

describe('remapColor', () => {
  it('maps index to index, both directions', () => {
    for (let i = 0; i < PIECE_COLORS.length; i++) {
      expect(remapColor(PIECE_COLORS[i], PIECE_COLORS, HIGH_CONTRAST_PIECE_COLORS))
        .toBe(HIGH_CONTRAST_PIECE_COLORS[i]);
      expect(remapColor(HIGH_CONTRAST_PIECE_COLORS[i], HIGH_CONTRAST_PIECE_COLORS, PIECE_COLORS))
        .toBe(PIECE_COLORS[i]);
    }
  });

  it('round-trips back to the original colour', () => {
    for (const color of PIECE_COLORS) {
      const swapped = remapColor(color, PIECE_COLORS, HIGH_CONTRAST_PIECE_COLORS);
      expect(remapColor(swapped, HIGH_CONTRAST_PIECE_COLORS, PIECE_COLORS)).toBe(color);
    }
  });

  it('leaves a colour from neither palette alone', () => {
    // THEME.gold, and a colour that is nobody's
    expect(remapColor(0xfbbf24, PIECE_COLORS, HIGH_CONTRAST_PIECE_COLORS)).toBe(0xfbbf24);
    expect(remapColor(0x123456, HIGH_CONTRAST_PIECE_COLORS, PIECE_COLORS)).toBe(0x123456);
  });
});

describe('left-handed layout', () => {
  function layoutFor(leftHanded: boolean): Layout {
    updateSettings({ leftHanded });
    return new LayoutManager().recalculate(FAKE_WINDOW.innerWidth, FAKE_WINDOW.innerHeight);
  }

  it('swaps the HOLD and NEXT x positions', () => {
    const right = layoutFor(false);
    const left = layoutFor(true);
    expect(left.holdRect.x).toBe(right.nextRect.x);
    expect(left.nextRect.x).toBe(right.holdRect.x);
    expect(left.holdRect.x).not.toBe(right.holdRect.x);
  });

  it('changes nothing else in the layout', () => {
    const right = layoutFor(false);
    const left = layoutFor(true);
    for (const key of Object.keys(right) as (keyof Layout)[]) {
      if (key === 'holdRect' || key === 'nextRect') continue;
      expect(left[key]).toEqual(right[key]);
    }
    // The two slots keep their own size and vertical position: only x moved
    for (const field of ['y', 'w', 'h'] as const) {
      expect(left.holdRect[field]).toBe(right.holdRect[field]);
      expect(left.nextRect[field]).toBe(right.nextRect[field]);
    }
  });
});
