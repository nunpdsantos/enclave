import type { Graphics } from 'pixi.js';
import { Difficulty } from '../core/Config';

// ── Visual Identity ──

export const FONT_DISPLAY = '"Oxanium", sans-serif';
export const FONT_MONO = '"Share Tech Mono", monospace';

// Deep night-blue page, near-black board plate, saturated glossy blocks
export const THEME = {
  bg: 0x2b3a86,
  bgDeep: 0x171d4a,
  gridBg: 0x121633,
  cellWell: 0x1b2047,
  cellWellBorder: 0x2a3260,
  panel: 0x0f1330,

  textPrimary: 0xffffff,
  textSecondary: 0xb8c0e0,
  textMuted: 0x7882aa,

  accent: 0x4a7af7,
  accentGlow: 0x6b9aff,
  gold: 0xfbbf24,
  goldGlow: 0xfde047,
  danger: 0xef4444,
  warning: 0xf59e0b,
  success: 0x22c55e,
  cyan: 0x22d3ee,
  magenta: 0xd946ef,

  btnPrimary: 0x4a7af7,
  btnHighlight: 0x6b9aff,
  btnSecondary: 0x3a3f66,
  overlay: 0x0a0e20,
};

export const DIFFICULTY_COLORS: Record<Difficulty, number> = {
  classic: THEME.accent,
  blitz: 0xf97316,
};

// ── Color utilities ──

export function darken(color: number, amount: number): number {
  const r = Math.max(0, ((color >> 16) & 0xff) * (1 - amount));
  const g = Math.max(0, ((color >> 8) & 0xff) * (1 - amount));
  const b = Math.max(0, (color & 0xff) * (1 - amount));
  return (Math.floor(r) << 16) | (Math.floor(g) << 8) | Math.floor(b);
}

export function lighten(color: number, amount: number): number {
  const r = Math.min(255, ((color >> 16) & 0xff) + (255 - ((color >> 16) & 0xff)) * amount);
  const g = Math.min(255, ((color >> 8) & 0xff) + (255 - ((color >> 8) & 0xff)) * amount);
  const b = Math.min(255, (color & 0xff) + (255 - (color & 0xff)) * amount);
  return (Math.floor(r) << 16) | (Math.floor(g) << 8) | Math.floor(b);
}

/** Perceived brightness 0–255, for picking the darker of two piece colours */
export function luminance(color: number): number {
  return 0.299 * ((color >> 16) & 0xff) + 0.587 * ((color >> 8) & 0xff) + 0.114 * (color & 0xff);
}

export function lerpColor(a: number, b: number, t: number): number {
  const clamp = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * clamp);
  const g = Math.round(ag + (bg - ag) * clamp);
  const bv = Math.round(ab + (bb - ab) * clamp);
  return (r << 16) | (g << 8) | bv;
}

export function easeOutCubic(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - c, 3);
}

export function easeOutBack(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  const s = 1.70158;
  return 1 + (s + 1) * Math.pow(c - 1, 3) + s * Math.pow(c - 1, 2);
}

export function easeInOutSine(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return -(Math.cos(Math.PI * c) - 1) / 2;
}

/**
 * Glossy block tile.
 *
 * Built from flat layers that fake a vertical gradient and a glass surface:
 *   1. dark base (reads as the bottom/right shadow edge)
 *   2. face, drawn as three horizontal bands from bright to deep
 *   3. glossy top highlight
 *   4. inner bottom shadow so the tile looks thick
 *   5. specular dot in the top-left corner
 * No gradient textures are needed, which keeps every draw cheap on phones.
 */
export function drawBeveledBlock(
  g: Graphics,
  x: number,
  y: number,
  size: number,
  color: number,
  radius: number = 5,
  alpha: number = 1,
): void {
  const bevel = Math.max(Math.floor(size * 0.08), 2);
  const face = size - bevel;
  const r = Math.max(2, Math.min(radius, face / 2));

  // 1. Base / shadow edge
  g.roundRect(x, y, size, size, radius);
  g.fill({ color: darken(color, 0.45), alpha });

  // 2. Face bands (bright → deep)
  g.roundRect(x, y, face, face, r);
  g.fill({ color: darken(color, 0.12), alpha });
  g.roundRect(x, y, face, face * 0.66, r);
  g.fill({ color, alpha });
  g.roundRect(x, y, face, face * 0.4, r);
  g.fill({ color: lighten(color, 0.14), alpha });

  // 3. Glossy top highlight
  g.roundRect(x + 1, y + 1, face - 2, Math.max(face * 0.3, 4), Math.max(r - 1, 1));
  g.fill({ color: lighten(color, 0.45), alpha: 0.5 * alpha });

  // 4. Inner bottom shadow (thickness)
  const shadowH = Math.max(face * 0.14, 2);
  g.roundRect(x + 1, y + face - shadowH, face - 2, shadowH, Math.max(r - 1, 1));
  g.fill({ color: darken(color, 0.5), alpha: 0.35 * alpha });

  // 5. Specular dot
  const dot = Math.max(size * 0.13, 2);
  g.roundRect(x + size * 0.13, y + size * 0.12, dot, dot * 0.8, dot / 2);
  g.fill({ color: 0xffffff, alpha: 0.42 * alpha });
}

/** Which orthogonal neighbours a wall block touches */
export interface WallJoins {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

const NO_JOINS: WallJoins = { up: false, down: false, left: false, right: false };

/**
 * Rounded-rect path whose corners go square wherever the tile meets a
 * neighbour, so two joined tiles have no notch between them.
 */
function wallPath(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  joins: WallJoins,
): void {
  const rad = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  const tl = joins.up || joins.left ? 0 : rad;
  const tr = joins.up || joins.right ? 0 : rad;
  const br = joins.down || joins.right ? 0 : rad;
  const bl = joins.down || joins.left ? 0 : rad;

  g.moveTo(x + tl, y);
  g.lineTo(x + w - tr, y);
  if (tr > 0) g.arcTo(x + w, y, x + w, y + tr, tr);
  g.lineTo(x + w, y + h - br);
  if (br > 0) g.arcTo(x + w, y + h, x + w - br, y + h, br);
  g.lineTo(x + bl, y + h);
  if (bl > 0) g.arcTo(x, y + h, x, y + h - bl, bl);
  g.lineTo(x, y + tl);
  if (tl > 0) g.arcTo(x, y, x + tl, y, tl);
  g.closePath();
}

/**
 * One block of a wall.
 *
 * Unlike drawBeveledBlock, (x, y, size) is the whole *cell* and `inset` is
 * the gap between the tile and the cell edge. Where `joins` reports a
 * neighbour the tile is stretched by `inset` on that side, so the two tiles
 * meet across the 2 × inset gap and the pair reads as one fence.
 *
 * The bevel is the same trick — a dark base with the lit face pulled up and
 * left off it — but every edge treatment is skipped on a joined side, so the
 * light top and dark bottom run along the wall instead of around each block.
 */
export function drawWallBlock(
  g: Graphics,
  x: number,
  y: number,
  size: number,
  inset: number,
  color: number,
  radius: number = 5,
  joins: WallJoins = NO_JOINS,
  alpha: number = 1,
): void {
  const left = x + (joins.left ? 0 : inset);
  const top = y + (joins.up ? 0 : inset);
  const w = size - (joins.left ? 0 : inset) - (joins.right ? 0 : inset);
  const h = size - (joins.up ? 0 : inset) - (joins.down ? 0 : inset);
  if (w <= 0 || h <= 0) return;

  const tile = Math.max(1, size - inset * 2);
  const bevel = Math.max(Math.floor(tile * 0.08), 2);
  const r = Math.max(2, Math.min(radius, tile / 2));

  // 1. Dark base — visible only where the wall ends, as its bottom/right edge
  wallPath(g, left, top, w, h, radius, joins);
  g.fill({ color: darken(color, 0.45), alpha });

  // 2. Face, pulled off the base on the sides that are not joined
  const faceW = w - (joins.right ? 0 : bevel);
  const faceH = h - (joins.down ? 0 : bevel);
  if (faceW <= 0 || faceH <= 0) return;
  wallPath(g, left, top, faceW, faceH, r, joins);
  g.fill({ color, alpha });

  // 3. Bands: light along the top of the wall, deep along its bottom
  if (!joins.down) {
    const band = Math.min(Math.max(faceH * 0.34, 3), faceH);
    wallPath(g, left, top + faceH - band, faceW, band, r, { ...joins, up: true });
    g.fill({ color: darken(color, 0.12), alpha });
  }
  if (!joins.up) {
    const band = Math.min(Math.max(faceH * 0.4, 4), faceH);
    wallPath(g, left, top, faceW, band, r, { ...joins, down: true });
    g.fill({ color: lighten(color, 0.14), alpha });

    const gloss = Math.min(Math.max(faceH * 0.3, 4), faceH - 2);
    if (gloss > 0) {
      wallPath(g, left + 1, top + 1, faceW - 2, gloss, Math.max(r - 1, 1), { ...joins, down: true });
      g.fill({ color: lighten(color, 0.45), alpha: 0.5 * alpha });
    }
  }

  // 4. Inner bottom shadow, so the wall has thickness where it ends
  if (!joins.down) {
    const shadowH = Math.min(Math.max(faceH * 0.14, 2), faceH);
    wallPath(g, left + 1, top + faceH - shadowH, faceW - 2, shadowH, Math.max(r - 1, 1), { ...joins, up: true });
    g.fill({ color: darken(color, 0.5), alpha: 0.35 * alpha });
  }

  // 5. Left edge catches the light, mirroring the dark base on the right
  if (!joins.left) {
    const edge = Math.min(bevel, faceW);
    wallPath(g, left, top, edge, faceH, Math.max(r - 1, 1), { ...joins, right: true });
    g.fill({ color: lighten(color, 0.3), alpha: 0.2 * alpha });
  }

  // 6. Specular dot, only on a corner that is actually exposed
  if (!joins.up && !joins.left) {
    const dot = Math.max(tile * 0.13, 2);
    g.roundRect(left + tile * 0.13, top + tile * 0.12, dot, dot * 0.8, dot / 2);
    g.fill({ color: 0xffffff, alpha: 0.42 * alpha });
  }
}

/** Rounded pill-shaped button with a highlight strip */
export function drawButton(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
  radius: number = 12,
  glow: boolean = true,
): void {
  if (glow) {
    g.roundRect(x - 4, y - 4, w + 8, h + 8, radius + 4);
    g.fill({ color, alpha: 0.16 });
  }
  g.roundRect(x, y + 3, w, h, radius);
  g.fill({ color: darken(color, 0.5) });
  g.roundRect(x, y, w, h, radius);
  g.fill({ color: darken(color, 0.08) });
  g.roundRect(x, y, w, h * 0.62, radius);
  g.fill({ color });
  g.roundRect(x + 1, y + 1, w - 2, h * 0.42, radius - 1);
  g.fill({ color: 0xffffff, alpha: 0.16 });
}

/** Translucent glass panel used behind HUD groups and dialogs */
export function drawPanel(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number = 14,
  alpha: number = 0.55,
): void {
  g.roundRect(x, y + 3, w, h, radius);
  g.fill({ color: 0x000000, alpha: alpha * 0.45 });
  g.roundRect(x, y, w, h, radius);
  g.fill({ color: THEME.panel, alpha });
  g.roundRect(x + 1, y + 1, w - 2, Math.min(h * 0.5, 40), radius - 1);
  g.fill({ color: 0xffffff, alpha: 0.035 });
  g.roundRect(x, y, w, h, radius);
  g.stroke({ color: 0xffffff, alpha: 0.09, width: 1 });
}
