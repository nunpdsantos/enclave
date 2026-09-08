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
  gridSize: number;

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

export class LayoutManager {
  layout!: Layout;

  constructor() {
    this.recalculate(window.innerWidth, window.innerHeight);
  }

  recalculate(screenW: number, screenH: number): Layout {
    const padding = 16;
    const hudHeight = 104;

    const availableWidth = Math.min(screenW - padding * 2, 520);
    const availableGridHeight = screenH * 0.5;
    const cellSize = Math.max(Math.floor(Math.min(availableWidth, availableGridHeight) / GRID_SIZE), 18);
    const gridSize = cellSize * GRID_SIZE;
    const gridOriginX = Math.floor((screenW - gridSize) / 2);
    const gridOriginY = hudHeight + padding;

    const handOriginY = gridOriginY + gridSize + padding * 1.25;
    const handHeight = Math.max(120, screenH - handOriginY - padding);

    // Hand zones: [hold] [ current ] [next]
    const sideW = Math.max(64, Math.floor(gridSize * 0.22));
    const centerW = gridSize - sideW * 2;
    const rotateH = 40;

    // Piece in hand: big enough to read, small enough for a 5-long bar
    const handCellSize = Math.max(14, Math.min(Math.floor(cellSize * 0.72), Math.floor(centerW / 5.5)));
    const miniCellSize = Math.max(7, Math.min(Math.floor(cellSize * 0.34), Math.floor((sideW - 14) / 5)));

    // The hand zone is only as tall as a 5-cell piece needs, so the rotate
    // button sits right under the piece instead of at the bottom of the screen
    const currentH = Math.max(80, Math.min(handHeight - rotateH - 8, handCellSize * 5 + 28));

    const holdRect: Rect = { x: gridOriginX, y: handOriginY + 18, w: sideW - 6, h: sideW - 6 };
    const nextRect: Rect = { x: gridOriginX + gridSize - sideW + 6, y: handOriginY + 18, w: sideW - 6, h: Math.min(handHeight - 24, (sideW - 6) * 2 + 10) };
    const currentRect: Rect = { x: gridOriginX + sideW, y: handOriginY, w: centerW, h: currentH };
    const rotateRect: Rect = {
      x: gridOriginX + sideW + centerW / 2 - 64,
      y: currentRect.y + currentRect.h + 6,
      w: 128,
      h: rotateH,
    };

    this.layout = {
      width: screenW,
      height: screenH,
      gridOriginX,
      gridOriginY,
      cellSize,
      gridSize,
      handOriginY,
      handHeight,
      holdRect,
      currentRect,
      nextRect,
      rotateRect,
      handCellSize,
      miniCellSize,
      scoreY: 22,
      streakY: 62,
      dragOffsetY: cellSize * -1.6,
    };
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
    return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  }
}
