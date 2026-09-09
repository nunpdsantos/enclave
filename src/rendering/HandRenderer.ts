import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { PieceInstance } from '../core/types';
import { Layout, Rect } from './LayoutManager';
import { FONT_DISPLAY, THEME, WallJoins, drawPanel, drawWallBlock, easeOutBack, easeOutCubic } from './Theme';

const BLOCK_RADIUS = 5;
const DRAG_TRAIL_SIZE = 4;
const INTRO_DURATION = 0.22;
const PICKUP_DURATION = 0.13;
const ROTATE_DURATION = 0.14;

interface TrailPos { x: number; y: number }

/**
 * Draws the "hand": the hold slot, the current piece, the next queue and
 * the rotate button, plus the piece while it is being dragged.
 */
export class HandRenderer {
  container: Container;
  private panelGfx: Graphics;
  private holdGfx: Graphics;
  private currentGfx: Graphics;
  private nextGfx: Graphics;
  private rotateGfx: Graphics;
  /** SKIP, beside ROTATE. Drawn only where the layout gives it a rectangle. */
  private skipGfx: Graphics;
  private dragGfx: Graphics;
  private trailGfx: Graphics;
  private holdLabel: Text;
  private nextLabel: Text;
  private rotateLabel: Text;
  private skipLabel: Text;
  private layout!: Layout;
  /**
   * SKIP has been tapped once and is waiting for the confirming tap.
   *
   * A skip spends a piece and hands the raiders a free turn, which is far too
   * expensive to lose to a fat thumb landing next to ROTATE.
   */
  private skipArmed = false;

  private current: PieceInstance | null = null;
  private currentUnplaceable = false;
  private currentHidden = false;
  private introT = 1;
  private rotateT = 1;
  private rotateFrom = 0;

  private dragPiece: PieceInstance | null = null;
  private dragX = 0;
  private dragY = 0;
  private pickupT = 1;
  private trail: TrailPos[] = [];

  constructor() {
    this.container = new Container();
    this.panelGfx = new Graphics();
    this.holdGfx = new Graphics();
    this.currentGfx = new Graphics();
    this.nextGfx = new Graphics();
    this.rotateGfx = new Graphics();
    this.skipGfx = new Graphics();
    this.trailGfx = new Graphics();
    this.dragGfx = new Graphics();

    const labelStyle = () => new TextStyle({
      fontFamily: FONT_DISPLAY, fontSize: 9, fontWeight: '700', fill: THEME.textMuted, letterSpacing: 2,
    });
    this.holdLabel = new Text({ text: 'HOLD', style: labelStyle() });
    this.nextLabel = new Text({ text: 'NEXT', style: labelStyle() });
    this.rotateLabel = new Text({
      text: '⟳  ROTATE',
      style: new TextStyle({ fontFamily: FONT_DISPLAY, fontSize: 12, fontWeight: '700', fill: THEME.textPrimary, letterSpacing: 2 }),
    });
    this.skipLabel = new Text({
      text: 'SKIP',
      style: new TextStyle({ fontFamily: FONT_DISPLAY, fontSize: 12, fontWeight: '700', fill: THEME.textSecondary, letterSpacing: 2 }),
    });
    this.skipLabel.visible = false;

    this.container.addChild(this.panelGfx);
    this.container.addChild(this.holdGfx);
    this.container.addChild(this.nextGfx);
    this.container.addChild(this.rotateGfx);
    this.container.addChild(this.skipGfx);
    this.container.addChild(this.holdLabel);
    this.container.addChild(this.nextLabel);
    this.container.addChild(this.rotateLabel);
    this.container.addChild(this.skipLabel);
    this.container.addChild(this.currentGfx);
    this.container.addChild(this.trailGfx);
    this.container.addChild(this.dragGfx);
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
    const { holdRect, nextRect, rotateRect } = layout;

    this.holdLabel.anchor.set(0.5, 1);
    this.holdLabel.x = holdRect.x + holdRect.w / 2;
    this.holdLabel.y = holdRect.y - 4;
    this.nextLabel.anchor.set(0.5, 1);
    this.nextLabel.x = nextRect.x + nextRect.w / 2;
    this.nextLabel.y = nextRect.y - 4;
    this.rotateLabel.anchor.set(0.5);
    this.rotateLabel.x = rotateRect.x + rotateRect.w / 2;
    this.rotateLabel.y = rotateRect.y + rotateRect.h / 2;

    const p = this.panelGfx;
    p.clear();
    drawPanel(p, holdRect.x, holdRect.y, holdRect.w, holdRect.h, 10, 0.45);
    drawPanel(p, nextRect.x, nextRect.y, nextRect.w, nextRect.h, 10, 0.45);

    const r = this.rotateGfx;
    r.clear();
    r.roundRect(rotateRect.x, rotateRect.y, rotateRect.w, rotateRect.h, 12);
    r.fill({ color: 0x000000, alpha: 0.3 });
    r.roundRect(rotateRect.x, rotateRect.y, rotateRect.w, rotateRect.h, 12);
    r.stroke({ color: 0xffffff, alpha: 0.12, width: 1 });

    this.drawSkip();
  }

  /**
   * Arm or disarm SKIP. Armed it reads DISCARD? in warning colours, so the
   * second tap is a decision and the first one is a question.
   */
  setSkipArmed(armed: boolean): void {
    if (this.skipArmed === armed) return;
    this.skipArmed = armed;
    this.drawSkip();
  }

  private drawSkip(): void {
    const g = this.skipGfx;
    g.clear();
    const rect = this.layout?.skipRect;
    if (!rect || rect.w <= 0) { this.skipLabel.visible = false; return; }
    const armed = this.skipArmed;
    g.roundRect(rect.x, rect.y, rect.w, rect.h, 12);
    g.fill({ color: armed ? THEME.warning : 0x000000, alpha: armed ? 0.28 : 0.3 });
    g.roundRect(rect.x, rect.y, rect.w, rect.h, 12);
    g.stroke({ color: armed ? THEME.warning : 0xffffff, alpha: armed ? 0.9 : 0.12, width: armed ? 2 : 1 });

    this.skipLabel.text = armed ? 'DISCARD?' : 'SKIP';
    this.skipLabel.style.fill = armed ? THEME.warning : THEME.textSecondary;
    this.skipLabel.anchor.set(0.5);
    this.skipLabel.x = rect.x + rect.w / 2;
    this.skipLabel.y = rect.y + rect.h / 2;
    this.skipLabel.visible = true;
  }

  /**
   * Redraw hand contents. `animate` slides the new current piece in.
   *
   * `slots` is how many queue positions to lay out, which is the preview size
   * rather than the queue length: under a piece budget the queue runs dry and
   * the empty slots have to stay visible, or the last few pieces would appear
   * to grow as the column re-divided itself.
   */
  drawHand(
    current: PieceInstance | null, held: PieceInstance | null, queue: PieceInstance[],
    animate: boolean, slots: number = queue.length,
  ): void {
    this.current = current;
    if (animate) this.introT = 0;
    this.drawMini(this.holdGfx, held, this.layout.holdRect, 1);
    this.drawQueue(queue, slots);
    this.renderCurrent();
  }

  setCurrentUnplaceable(v: boolean): void {
    this.currentUnplaceable = v;
    this.renderCurrent();
  }

  /** Hide the piece in hand while it is being dragged */
  setCurrentHidden(v: boolean): void {
    this.currentHidden = v;
    this.renderCurrent();
  }

  /** Play a quick spin when the piece rotates */
  animateRotate(): void {
    this.rotateT = 0;
    this.rotateFrom = -Math.PI / 2;
  }

  private drawQueue(queue: PieceInstance[], slots: number): void {
    const g = this.nextGfx;
    g.clear();
    const { nextRect } = this.layout;
    const n = Math.max(1, slots);
    const slotH = nextRect.h / n;
    for (let i = 0; i < n; i++) {
      const rect: Rect = { x: nextRect.x, y: nextRect.y + slotH * i, w: nextRect.w, h: slotH };
      const piece = queue[i];
      if (piece) {
        this.drawPieceInRect(g, piece, rect, this.fitCell(piece, rect), i === 0 ? 1 : 0.75);
      } else {
        // A dashed-looking empty well: the ration is spent, nothing is coming
        const pad = Math.min(10, slotH * 0.22);
        g.roundRect(rect.x + pad, rect.y + pad, rect.w - pad * 2, rect.h - pad * 2, 6);
        g.stroke({ color: 0xffffff, alpha: 0.1, width: 1 });
      }
    }
  }

  private drawMini(g: Graphics, piece: PieceInstance | null, rect: Rect, alpha: number): void {
    g.clear();
    if (!piece) return;
    this.drawPieceInRect(g, piece, rect, this.fitCell(piece, rect), alpha);
  }

  /**
   * The biggest cell size that draws this piece inside this slot.
   *
   * `miniCellSize` is the size a preview *would like* to be; a four-cell bar
   * standing on end in a quarter of the NEXT column does not get it, and used
   * to be drawn at the size it wanted and clipped by the panel. Capped by the
   * slot in both directions, so nothing ever overflows whatever the queue
   * depth or the screen.
   */
  private fitCell(piece: PieceInstance, rect: Rect): number {
    const pad = 6;
    return Math.max(3, Math.min(
      this.layout.miniCellSize,
      Math.floor((rect.w - pad) / Math.max(1, piece.cols)),
      Math.floor((rect.h - pad) / Math.max(1, piece.rows)),
    ));
  }

  /** Which of a piece's own cells touch this one, so it draws as a mini-wall */
  private joinsAt(piece: PieceInstance, r: number, c: number): WallJoins {
    const on = (rr: number, cc: number): boolean =>
      rr >= 0 && cc >= 0 && rr < piece.rows && cc < piece.cols && piece.shape[rr][cc];
    return { up: on(r - 1, c), down: on(r + 1, c), left: on(r, c - 1), right: on(r, c + 1) };
  }

  private drawPieceInRect(g: Graphics, piece: PieceInstance, rect: Rect, cell: number, alpha: number): void {
    const w = piece.cols * cell;
    const h = piece.rows * cell;
    const x0 = rect.x + rect.w / 2 - w / 2;
    const y0 = rect.y + rect.h / 2 - h / 2;
    const inset = Math.max(1, cell * 0.08);
    for (let r = 0; r < piece.rows; r++) {
      for (let c = 0; c < piece.cols; c++) {
        if (!piece.shape[r][c]) continue;
        drawWallBlock(g, x0 + c * cell, y0 + r * cell, cell, inset, piece.color, Math.max(2, cell * 0.2), this.joinsAt(piece, r, c), alpha);
      }
    }
  }

  private renderCurrent(): void {
    const g = this.currentGfx;
    g.clear();
    const piece = this.current;
    if (!piece || this.currentHidden || !this.layout) return;
    const { currentRect, handCellSize } = this.layout;
    const cell = handCellSize;
    const w = piece.cols * cell;
    const h = piece.rows * cell;
    const cx = currentRect.x + currentRect.w / 2;
    const cy = currentRect.y + currentRect.h / 2;

    const intro = easeOutBack(this.introT);
    const scale = 0.6 + 0.4 * intro;
    const alpha = (this.currentUnplaceable ? 0.35 : 1) * Math.min(1, this.introT * 3 + 0.001);
    const slide = 14 * (1 - easeOutCubic(this.introT));
    const angle = this.rotateFrom * (1 - easeOutCubic(this.rotateT));

    g.position.set(cx, cy + slide);
    g.rotation = angle;
    g.scale.set(scale);
    g.alpha = alpha;

    const inset = 2;
    // Shadow
    for (let r = 0; r < piece.rows; r++) {
      for (let c = 0; c < piece.cols; c++) {
        if (!piece.shape[r][c]) continue;
        g.roundRect(-w / 2 + c * cell + inset + 2, -h / 2 + r * cell + inset + 4, cell - inset * 2, cell - inset * 2, BLOCK_RADIUS);
        g.fill({ color: 0x000000, alpha: 0.28 });
      }
    }
    for (let r = 0; r < piece.rows; r++) {
      for (let c = 0; c < piece.cols; c++) {
        if (!piece.shape[r][c]) continue;
        drawWallBlock(g, -w / 2 + c * cell, -h / 2 + r * cell, cell, inset, piece.color, BLOCK_RADIUS, this.joinsAt(piece, r, c));
      }
    }
  }

  update(dt: number): void {
    let dirty = false;
    if (this.introT < 1) { this.introT = Math.min(1, this.introT + dt / INTRO_DURATION); dirty = true; }
    if (this.rotateT < 1) { this.rotateT = Math.min(1, this.rotateT + dt / ROTATE_DURATION); dirty = true; }
    if (dirty) this.renderCurrent();

    if (this.dragPiece && this.pickupT < 1) {
      this.pickupT = Math.min(1, this.pickupT + dt / PICKUP_DURATION);
      this.renderDrag();
    }
  }

  // ── Drag ──

  beginDrag(piece: PieceInstance, px: number, py: number): void {
    this.dragPiece = piece;
    this.dragX = px;
    this.dragY = py;
    this.pickupT = 0;
    this.renderDrag();
  }

  showDragPiece(piece: PieceInstance, px: number, py: number): void {
    if (this.dragPiece !== piece) {
      // Piece rotated mid-drag: keep the pickup animation state
      this.dragPiece = piece;
    }
    this.dragX = px;
    this.dragY = py;
    this.renderDrag();
  }

  recordDragPosition(px: number, py: number): void {
    this.trail.push({ x: px, y: py });
    if (this.trail.length > DRAG_TRAIL_SIZE) this.trail.shift();
  }

  hideDragPiece(): void {
    this.dragGfx.clear();
    this.trailGfx.clear();
    this.dragPiece = null;
    this.trail = [];
    this.pickupT = 1;
  }

  private renderDrag(): void {
    const piece = this.dragPiece;
    if (!piece) return;
    const g = this.dragGfx;
    g.clear();
    const { cellSize, handCellSize } = this.layout;
    const k = easeOutCubic(this.pickupT);
    const size = handCellSize + (cellSize - handCellSize) * k;
    const offsetY = this.layout.dragOffsetY * k;
    const halfW = (piece.cols * size) / 2;
    const halfH = (piece.rows * size) / 2;
    const inset = 3 * (size / cellSize);

    for (let r = 0; r < piece.rows; r++) {
      for (let c = 0; c < piece.cols; c++) {
        if (!piece.shape[r][c]) continue;
        const x = this.dragX - halfW + c * size + inset;
        const y = this.dragY - halfH + r * size + inset + offsetY;
        g.roundRect(x + 3, y + 8 * k, size - inset * 2, size - inset * 2, BLOCK_RADIUS);
        g.fill({ color: 0x000000, alpha: 0.28 * k });
      }
    }
    for (let r = 0; r < piece.rows; r++) {
      for (let c = 0; c < piece.cols; c++) {
        if (!piece.shape[r][c]) continue;
        const x = this.dragX - halfW + c * size;
        const y = this.dragY - halfH + r * size + offsetY;
        drawWallBlock(g, x, y, size, inset, piece.color, BLOCK_RADIUS, this.joinsAt(piece, r, c));
      }
    }

    // Trail
    const tg = this.trailGfx;
    tg.clear();
    for (let ti = 0; ti < this.trail.length; ti++) {
      const pos = this.trail[ti];
      if (Math.abs(pos.x - this.dragX) < 3 && Math.abs(pos.y - this.dragY) < 3) continue;
      const alpha = 0.08 * (ti + 1) / this.trail.length;
      for (let r = 0; r < piece.rows; r++) {
        for (let c = 0; c < piece.cols; c++) {
          if (!piece.shape[r][c]) continue;
          tg.roundRect(pos.x - halfW + c * cellSize + 3, pos.y - halfH + r * cellSize + 3 + this.layout.dragOffsetY, cellSize - 6, cellSize - 6, BLOCK_RADIUS);
          tg.fill({ color: piece.color, alpha });
        }
      }
    }
  }

  /** Shake the hand piece to signal a rejected drop */
  nudge(distance: number = 8, durationMs: number = 130): void {
    const g = this.currentGfx;
    const startX = g.x;
    const startTime = performance.now();
    const animate = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed >= durationMs) { g.x = startX; return; }
      const t = elapsed / durationMs;
      g.x = startX + Math.sin(t * Math.PI * 4) * (1 - t) * distance;
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }
}
