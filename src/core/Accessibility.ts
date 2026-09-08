import { MotionSetting, loadSettings } from './Settings';
import { CellColor, HIGH_CONTRAST_PIECE_COLORS, PIECE_COLORS } from './types';

/**
 * Comfort and accessibility resolution: motion, and the piece palette.
 *
 * Everything here is deliberately free of Pixi and of the DOM apart from one
 * guarded `matchMedia` call, so the rules can be unit-tested directly.
 */

/** Cycle order of the MOTION control, and the labels shown on its pill */
export const MOTION_ORDER: MotionSetting[] = ['system', 'reduced', 'full'];
export const MOTION_LABELS: string[] = ['SYSTEM', 'REDUCED', 'FULL'];

/** Reduced motion keeps a quarter of the particles: enough to read, not to swim */
export const REDUCED_PARTICLE_SCALE = 0.25;

/** The whole motion decision, in one pure function so it can be tested. */
export function resolveReducedMotion(setting: MotionSetting, systemPrefersReduced: boolean): boolean {
  if (setting === 'reduced') return true;
  if (setting === 'full') return false;
  return systemPrefersReduced;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** null once probed and unavailable — some webviews have no matchMedia */
let mediaQuery: MediaQueryList | null = null;
let probed = false;

function reducedMotionQuery(): MediaQueryList | null {
  if (!probed) {
    probed = true;
    try {
      mediaQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(REDUCED_MOTION_QUERY)
        : null;
    } catch {
      mediaQuery = null;
    }
  }
  return mediaQuery;
}

export function systemPrefersReducedMotion(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

/** The setting, resolved against the OS preference */
export function isReducedMotion(): boolean {
  return resolveReducedMotion(loadSettings().motion, systemPrefersReducedMotion());
}

type ReducedMotionListener = (reduced: boolean) => void;

const listeners = new Set<ReducedMotionListener>();
let watching = false;

function onQueryChange(): void {
  const reduced = isReducedMotion();
  for (const listener of listeners) listener(reduced);
}

/**
 * Fire when the OS preference flips, so toggling it mid-session applies
 * without a reload. Returns an unsubscribe.
 */
export function onReducedMotionChange(listener: ReducedMotionListener): () => void {
  listeners.add(listener);
  const mq = reducedMotionQuery();
  if (mq && !watching) {
    watching = true;
    // addEventListener is the modern form; older Safari only has addListener
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onQueryChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onQueryChange);
  }
  return () => { listeners.delete(listener); };
}

// ── Palette ──

/**
 * The palette new pieces are dealt from. Returns the PIECE_COLORS array
 * itself when standard, so nothing about the default path changes.
 */
export function getPiecePalette(): number[] {
  return loadSettings().palette === 'highContrast' ? HIGH_CONTRAST_PIECE_COLORS : PIECE_COLORS;
}

/**
 * Translate a colour from one palette to the other by position, so a block
 * keeps its identity across a palette switch. Colours that belong to neither
 * palette (gold claim fills, UI accents) pass through untouched.
 */
export function remapColor(color: CellColor, from: number[], to: number[]): CellColor {
  const i = from.indexOf(color);
  return i >= 0 && i < to.length ? to[i] : color;
}
