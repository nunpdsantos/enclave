import { PieceInstance, GridPos, GRID_SIZE } from '../core/types';
import { Board } from '../core/Board';
import { LayoutManager } from '../rendering/LayoutManager';

export interface DragState {
  piece: PieceInstance;
  pointerX: number;
  pointerY: number;
  gridPos: GridPos | null;
  isValid: boolean;
  /** True when the piece was released back over the hand area with no valid target */
  cancelled: boolean;
}

const TAP_THRESHOLD = 12; // px: below this it's a tap, not a drag
const HYSTERESIS_FRACTION = 0.12;

/**
 * Pointer handling for the hand:
 *   - drag the current piece onto the board
 *   - tap the current piece (or the rotate button) to rotate it
 *   - tap the hold slot to swap with the held piece
 *
 * It only reads the board and layout; the scene decides what to do with
 * the resulting events.
 */
export class DragController {
  private layoutManager: LayoutManager;
  private board: Board;
  private current: PieceInstance | null = null;
  private dragging: DragState | null = null;
  private active = false;
  private pointerDownPos: { x: number; y: number } | null = null;
  private downOn: 'current' | 'hold' | 'rotate' | 'none' = 'none';

  private lastSnappedRow = 0;
  private lastSnappedCol = 0;
  private hasSnappedPos = false;

  onDragStart: (state: DragState) => void = () => {};
  onDragMove: (state: DragState) => void = () => {};
  onDragEnd: (state: DragState) => void = () => {};
  onDragCancel: () => void = () => {};
  onRotate: () => void = () => {};
  onHold: () => void = () => {};

  constructor(layoutManager: LayoutManager, board: Board) {
    this.layoutManager = layoutManager;
    this.board = board;
  }

  attach(canvas: HTMLCanvasElement): void {
    this.active = true;
    canvas.addEventListener('pointerdown', this.handlePointerDown, { passive: false });
    canvas.addEventListener('pointermove', this.handlePointerMove, { passive: false });
    canvas.addEventListener('pointerup', this.handlePointerUp, { passive: false });
    canvas.addEventListener('pointercancel', this.handlePointerCancel, { passive: false });
  }

  detach(canvas: HTMLCanvasElement): void {
    this.active = false;
    if (this.dragging) {
      this.dragging = null;
      this.onDragCancel();
    }
    canvas.removeEventListener('pointerdown', this.handlePointerDown);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointercancel', this.handlePointerCancel);
  }

  setCurrent(piece: PieceInstance | null): void {
    this.current = piece;
    // If the piece in hand rotated mid-drag, keep dragging the new shape
    if (this.dragging && piece) {
      this.dragging.piece = piece;
      this.updateGridSnap(this.dragging.pointerX, this.dragging.pointerY);
      this.onDragMove(this.dragging);
    }
  }

  updateBoard(board: Board): void {
    this.board = board;
  }

  get isDragging(): boolean {
    return this.dragging !== null;
  }

  private handlePointerDown = (e: PointerEvent): void => {
    if (!this.active) return;
    if (this.dragging) {
      this.dragging = null;
      this.onDragCancel();
    }
    e.preventDefault();
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic */ }

    const px = e.clientX;
    const py = e.clientY;
    this.pointerDownPos = { x: px, y: py };
    const layout = this.layoutManager.layout;

    if (LayoutManager.inRect(layout.holdRect, px, py)) {
      this.downOn = 'hold';
    } else if (LayoutManager.inRect(layout.rotateRect, px, py)) {
      this.downOn = 'rotate';
    } else if (this.current && LayoutManager.inRect(layout.currentRect, px, py)) {
      this.downOn = 'current';
      this.dragging = {
        piece: this.current,
        pointerX: px,
        pointerY: py,
        gridPos: null,
        isValid: false,
        cancelled: false,
      };
      this.hasSnappedPos = false;
      this.updateGridSnap(px, py);
      this.onDragStart(this.dragging);
    } else {
      this.downOn = 'none';
    }
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (!this.active || !this.dragging) return;
    e.preventDefault();
    this.dragging.pointerX = e.clientX;
    this.dragging.pointerY = e.clientY;
    this.updateGridSnap(e.clientX, e.clientY);
    this.onDragMove(this.dragging);
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (!this.active) return;
    e.preventDefault();
    const px = e.clientX;
    const py = e.clientY;
    const isTap = this.pointerDownPos !== null &&
      Math.hypot(px - this.pointerDownPos.x, py - this.pointerDownPos.y) < TAP_THRESHOLD;

    if (isTap && this.downOn === 'hold') {
      this.onHold();
    } else if (isTap && this.downOn === 'rotate') {
      this.onRotate();
    } else if (isTap && this.downOn === 'current' && this.dragging) {
      // Tap on the piece in hand: rotate instead of dropping
      this.dragging = null;
      this.onDragCancel();
      this.onRotate();
    } else if (this.dragging) {
      this.updateGridSnap(px, py);
      const state = this.dragging;
      const valid = state.gridPos !== null && state.isValid;
      const layout = this.layoutManager.layout;
      const pieceCenterY = py + layout.dragOffsetY;
      state.cancelled = !valid && pieceCenterY >= layout.handOriginY;
      // Clear the drag BEFORE notifying: the scene will hand us the next piece
      // during onDragEnd, and that must not be treated as a mid-drag rotation.
      this.dragging = null;
      this.onDragEnd(state);
    }

    this.pointerDownPos = null;
    this.downOn = 'none';
  };

  private handlePointerCancel = (): void => {
    if (!this.dragging) return;
    this.dragging = null;
    this.onDragCancel();
    this.pointerDownPos = null;
    this.downOn = 'none';
  };

  /** Snap to the nearest grid cell with hysteresis so the ghost doesn't flicker */
  private updateGridSnap(px: number, py: number): void {
    if (!this.dragging) return;
    const layout = this.layoutManager.layout;
    const piece = this.dragging.piece;

    const centerX = px;
    const centerY = py + layout.dragOffsetY;
    const exactCol = (centerX - layout.gridOriginX) / layout.cellSize - piece.cols / 2;
    const exactRow = (centerY - layout.gridOriginY) / layout.cellSize - piece.rows / 2;

    let col: number;
    let row: number;
    if (this.hasSnappedPos) {
      const newCol = Math.round(exactCol);
      const newRow = Math.round(exactRow);
      col = newCol !== this.lastSnappedCol && Math.abs(exactCol - newCol) <= HYSTERESIS_FRACTION ? this.lastSnappedCol : newCol;
      row = newRow !== this.lastSnappedRow && Math.abs(exactRow - newRow) <= HYSTERESIS_FRACTION ? this.lastSnappedRow : newRow;
    } else {
      col = Math.round(exactCol);
      row = Math.round(exactRow);
      this.hasSnappedPos = true;
    }
    this.lastSnappedRow = row;
    this.lastSnappedCol = col;

    const clampedRow = Math.max(-piece.rows + 1, Math.min(GRID_SIZE - 1, row));
    const clampedCol = Math.max(-piece.cols + 1, Math.min(GRID_SIZE - 1, col));
    this.dragging.gridPos = { row: clampedRow, col: clampedCol };
    this.dragging.isValid = this.board.canPlace(piece.shape, clampedRow, clampedCol);
  }
}
