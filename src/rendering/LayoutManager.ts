import { SIEGE_PREVIEW_COUNT } from '../core/Config';
import { loadSettings } from '../core/Settings';
import { GRID_SIZE, GridPos } from '../core/types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;

  // Board
  gridOriginX: number;
  gridOriginY: number;
  cellSize: number;
  /** The board's side in pixels */
  gridSize: number;
  /** The board's side in cells — 9 in Classic, 11 in the siege */
  gridCells: number;

  // Hand area below the board
  handOriginY: number;
  handHeight: number;
  /** Hold slot (left) */
  holdRect: Rect;
  /** Current piece zone (center) */
  currentRect: Rect;
  /** Next queue column (right) */
  nextRect: Rect;
  /** Rotate button under the current piece */
  rotateRect: Rect;
  /**
   * Skip button beside ROTATE. Zero-width outside the siege, where there is
   * no piece budget and nothing to discard.
   */
  skipRect: Rect;
  /** Cell size used to draw the piece in hand */
  handCellSize: number;
  /** Cell size for hold + next previews */
  miniCellSize: number;

  // HUD
  scoreY: number;
  streakY: number;

  /** Lift the dragged piece above the finger */
  dragOffsetY: number;
}

/** How tall the HUD is, and so where the board starts, per mode */
const HUD_HEIGHT = 104;
/**
 * The siege HUD is three short lines — relief, the two counters, the forecast
 * — instead of a tier chip, a score column and two bars, so it gives the
 * board forty pixels back. On an eleven-wide board that is a whole cell.
 */
const SIEGE_HUD_HEIGHT = 64;

/** Side gutters. The siege runs tight against the edges to buy cell size. */
const PADDING = 16;
const SIEGE_PADDING = 8;

/**
 * The least room the hand needs under a siege board: a five-cell piece to
 * drag, and the 44 px button row beneath it.
 */
const SIEGE_HAND_MIN = 150;

/** Buttons are finger targets before they are anything else */
const BUTTON_HEIGHT = 44;

/**
 * Every measurement of one screen, as a pure function.
 *
 * Split out of the class so the arithmetic can be checked without a DOM: the
 * cell size at 360 and at 390 is a *number this mode has to hit*, and a
 * promise that can only be verified by looking at a phone is not a promise.
 */
export function computeLayout(
  screenW: number, screenH: number, cells: number, leftHanded: boolean,
): Layout {
  // The siege is the wide board and the compact HUD, and it is the reason
  // both numbers are per-mode rather than constants.
  const siege = cells !== GRID_SIZE;
  const padding = siege ? SIEGE_PADDING : PADDING;
  const hudHeight = siege ? SIEGE_HUD_HEIGHT : HUD_HEIGHT;
  const gap = siege ? SIEGE_PADDING : PADDING;

  const availableWidth = Math.min(screenW - padding * 2, siege ? 560 : 520);
  // Height budget: what is left once the HUD above and the hand below have
  // been paid for, rather than half the screen. Half a screen was a fine cap
  // for a 9×9 under a tall HUD; on eleven columns it is what made the board
  // look small on a phone that had the room for it.
  const availableGridHeight = siege
    ? screenH - hudHeight - gap - SIEGE_HAND_MIN - padding
    : screenH * 0.5;
  const cellSize = Math.max(
    Math.floor(Math.min(availableWidth, availableGridHeight) / cells), 18,
  );
  const gridSize = cellSize * cells;
  const gridOriginX = Math.floor((screenW - gridSize) / 2);
  const gridOriginY = hudHeight + gap;

  const handOriginY = gridOriginY + gridSize + (siege ? gap * 1.5 : padding * 1.25);
  const handHeight = Math.max(120, screenH - handOriginY - padding);

  // Hand zones: [hold] [ current ] [next]
  const sideW = Math.max(64, Math.floor(gridSize * 0.22));
  const centerW = gridSize - sideW * 2;
  const rotateH = siege ? BUTTON_HEIGHT : 40;

  // Piece in hand: big enough to read, small enough for a 5-long bar
  const handCellSize = Math.max(14, Math.min(Math.floor(cellSize * 0.72), Math.floor(centerW / 5.5)));
  const miniCellSize = Math.max(7, Math.min(Math.floor(cellSize * 0.34), Math.floor((sideW - 14) / 5)));

  // The hand zone is only as tall as a 5-cell piece needs, so the buttons sit
  // right under the piece instead of at the bottom of the screen
  const currentH = Math.max(80, Math.min(handHeight - rotateH - 8, handCellSize * 5 + 28));

  // Left-handed play swaps the two side slots so HOLD falls under the left
  // thumb. Only their x moves: the piece in hand and the buttons stay centred.
  const leftX = gridOriginX;
  const rightX = gridOriginX + gridSize - sideW + 6;

  const holdRect: Rect = { x: leftHanded ? rightX : leftX, y: handOriginY + 18, w: sideW - 6, h: sideW - 6 };
  // The NEXT column is two slots deep in Classic and four in the siege, and
  // the tallest piece either can deal is four cells — so ask for the room
  // four of those need, and take it when the hand has it to give.
  const queueWanted = siege ? SIEGE_PREVIEW_COUNT * (4 * miniCellSize + 8) : 0;
  const nextRect: Rect = {
    x: leftHanded ? leftX : rightX,
    y: handOriginY + 18,
    w: sideW - 6,
    h: Math.min(handHeight - 24, Math.max((sideW - 6) * 2 + 10, queueWanted)),
  };
  const currentRect: Rect = { x: gridOriginX + sideW, y: handOriginY, w: centerW, h: currentH };
  const buttonY = currentRect.y + currentRect.h + 6;

  // ROTATE alone is centred; with SKIP beside it the pair is, and each half
  // keeps a 44 px target rather than shrinking to fit the old 128 px slot.
  const buttonGap = 10;
  const pairW = Math.min(centerW, 260);
  const halfW = (pairW - buttonGap) / 2;
  const rotateRect: Rect = siege
    ? { x: gridOriginX + sideW + centerW / 2 - pairW / 2, y: buttonY, w: halfW, h: rotateH }
    : { x: gridOriginX + sideW + centerW / 2 - 64, y: buttonY, w: 128, h: rotateH };
  const skipRect: Rect = siege
    ? { x: rotateRect.x + halfW + buttonGap, y: buttonY, w: halfW, h: rotateH }
    : { x: 0, y: 0, w: 0, h: 0 };

  return {
    width: screenW,
    height: screenH,
    gridOriginX,
    gridOriginY,
    cellSize,
    gridSize,
    gridCells: cells,
    handOriginY,
    handHeight,
    holdRect,
    currentRect,
    nextRect,
    rotateRect,
    skipRect,
    handCellSize,
    miniCellSize,
    scoreY: 22,
    streakY: 62,
    dragOffsetY: cellSize * -1.6,
  };
}

export class LayoutManager {
  layout!: Layout;
  /** Cells a side. Set before the first recalculate of a run that is not 9×9. */
  private gridCells: number = GRID_SIZE;

  constructor(gridCells: number = GRID_SIZE) {
    this.gridCells = gridCells;
    this.recalculate(window.innerWidth, window.innerHeight);
  }

  /**
   * Point the layout at a board of a different size.
   *
   * Called when a run starts, before the scene reads a layout out of it, so
   * that everything downstream — the renderers, the drag snap, the ghost —
   * measures the board the run is actually played on.
   */
  setGridCells(cells: number): Layout {
    this.gridCells = cells;
    return this.recalculate(this.layout?.width ?? window.innerWidth, this.layout?.height ?? window.innerHeight);
  }

  recalculate(screenW: number, screenH: number): Layout {
    this.layout = computeLayout(screenW, screenH, this.gridCells, loadSettings().leftHanded);
    return this.layout;
  }

  pixelToGrid(px: number, py: number): GridPos | null {
    const { gridOriginX, gridOriginY, cellSize, gridSize } = this.layout;
    const lx = px - gridOriginX;
    const ly = py - gridOriginY;
    if (lx < 0 || ly < 0 || lx >= gridSize || ly >= gridSize) return null;
    return { row: Math.floor(ly / cellSize), col: Math.floor(lx / cellSize) };
  }

  static inRect(r: Rect, x: number, y: number): boolean {
    return r.w > 0 && r.h > 0 && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  }
}
