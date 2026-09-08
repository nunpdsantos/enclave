import type { Graphics } from 'pixi.js';
import { Difficulty } from '../core/Config';

// ── Visual Identity ──

// Typography
export const FONT_DISPLAY = '"Oxanium", sans-serif';
export const FONT_MONO = '"Share Tech Mono", monospace';

// Color system — deep blue page, near-black board, saturated blocks
export const THEME = {
  // Backgrounds
  bg: 0x3d4c9a,        // page background (animated by FXManager)
  gridBg: 0x141833,    // board plate
  cellWell: 0x1c2145,  // cell depression (slightly lighter than plate)
  cellWellBorder: 0x2a3260,
  panel: 0x0f1330,     // HUD chips / panels

  // Text
  textPrimary: 0xffffff,
  textSecondary: 0xb8c0e0,
  textMuted: 0x7882aa,

  // Accents
  accent: 0x4a7af7,
  accentGlow: 0x6b9aff,
  gold: 0xfbbf24,
  goldGlow: 0xfde047,
  danger: 0xef4444,
  warning: 0xf59e0b,
  success: 0x22c55e,
  cyan: 0x22d3ee,

  // UI
  btnPrimary: 0x4a7af7,
  btnHighlight: 0x6b9aff,
  btnSecondary: 0x3a3f66,
  overlay: 0x0a0e20,
};

/** Accent color per difficulty, shared by menu, HUD and game-over */
export const DIFFICULTY_COLORS: Record<Difficulty, number> = {
  classic: THEME.accent,
  blitz: 0xf97316,
};

// Color utilities
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

/** Linearly interpolate between two RGB colors */
export function lerpColor(a: number, b: number, t: number): number {
  const clamp = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * clamp);
  const g = Math.round(ag + (bg - ag) * clamp);
  const bv = Math.round(ab + (bb - ab) * clamp);
  return (r << 16) | (g << 8) | bv;
}

/** Easing helpers shared by the renderers */
export function easeOutCubic(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - c, 3);
}

export function easeOutBack(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  const s = 1.70158;
  return 1 + (s + 1) * Math.pow(c - 1, 3) + s * Math.pow(c - 1, 2);
}

/**
 * Draw a 3D beveled block tile — a raised tile with a bright top edge,
 * a darker bottom-right shadow edge and a soft inner glow so blocks
 * read as glossy plastic rather than flat squares.
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
  const bevel = Math.max(Math.floor(size * 0.07), 2);

  // Full block filled with shadow/dark color (visible on bottom-right edges)
  g.roundRect(x, y, size, size, radius);
  g.fill({ color: darken(color, 0.4), alpha });

  // Main face (inset from bottom-right to reveal shadow edge)
  g.roundRect(x, y, size - bevel, size - bevel, radius);
  g.fill({ color, alpha });

  // Top-left highlight edge (bright strip)
  g.roundRect(x + 1, y + 1, size - bevel - 2, Math.max(size * 0.36, 6), Math.max(radius - 1, 1));
  g.fill({ color: lighten(color, 0.3), alpha: 0.5 * alpha });

  // Small specular dot in the corner
  const dot = Math.max(size * 0.12, 2);
  g.roundRect(x + size * 0.14, y + size * 0.14, dot, dot, dot / 2);
  g.fill({ color: 0xffffff, alpha: 0.35 * alpha });
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
    g.roundRect(x - 3, y - 3, w + 6, h + 6, radius + 3);
    g.fill({ color, alpha: 0.18 });
  }
  g.roundRect(x, y + 3, w, h, radius);
  g.fill({ color: darken(color, 0.45) });
  g.roundRect(x, y, w, h, radius);
  g.fill({ color });
  g.roundRect(x + 1, y + 1, w - 2, h * 0.45, radius - 1);
  g.fill({ color: 0xffffff, alpha: 0.14 });
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
  g.roundRect(x, y + 2, w, h, radius);
  g.fill({ color: 0x000000, alpha: alpha * 0.4 });
  g.roundRect(x, y, w, h, radius);
  g.fill({ color: THEME.panel, alpha });
  g.roundRect(x, y, w, h, radius);
  g.stroke({ color: 0xffffff, alpha: 0.08, width: 1 });
}
