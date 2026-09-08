import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { ShapeMatrix, Region, GRID_SIZE } from '../core/types';
import { Layout } from './LayoutManager';
import { FONT_DISPLAY, THEME, lighten } from './Theme';

const BLOCK_RADIUS = 4;
const INSET = 2;

// Close preview: soft gold field over the rooms, bright gold around them
const PREVIEW_FILL_ALPHA = 0.18;
const PREVIEW_OUTLINE_ALPHA = 0.9;
const PREVIEW_OUTLINE_WIDTH = 2;
const PREVIEW_FONT_SIZE = 14;

export class GhostRenderer {
  container: Container;
  private graphics: Graphics;
  private previewGraphics: Graphics;
  private pointsText: Text;
  private layout!: Layout;
  private hideTimer: number | null = null;

  constructor() {
    this.container = new Container();
    this.previewGraphics = new Graphics();
    this.graphics = new Graphics();
    this.pointsText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_DISPLAY, fontSize: PREVIEW_FONT_SIZE, fontWeight: '800',
        fill: THEME.gold, letterSpacing: 1,
        stroke: { color: 0x0a0e20, width: 3 },
        dropShadow: { alpha: 0.85, blur: 4, color: 0x000000, distance: 1 },
      }),
    });
    this.pointsText.anchor.set(0.5);
    this.pointsText.visible = false;

    this.container.addChild(this.previewGraphics);
    this.container.addChild(this.graphics);
    this.container.addChild(this.pointsText);
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
  }

  /** Show ghost preview — outline style for valid, filled for invalid */
  show(shape: ShapeMatrix, row: number, col: number, color: number, valid: boolean): void {
    this.clearHideTimer();
    this.drawGhost(shape, row, col, color, valid, valid ? 0.2 : 0.12, valid ? 0.6 : 0.3);
  }

  flashRejected(shape: ShapeMatrix, row: number, col: number, color: number): void {
    this.clearHideTimer();
    this.hidePreview();
    this.drawGhost(shape, row, col, color, false, 0.2, 0.65);
    this.hideTimer = window.setTimeout(() => {
      this.hide();
    }, 120);
  }

  /**
   * Gold outline and fill over the rooms this drop would seal, with what the
   * claim pays. The caller decides whether there is anything to show; this
   * only draws what it is handed.
   */
  showClosePreview(regions: Region[], points: number): void {
    const g = this.previewGraphics;
    g.clear();
    if (!this.layout || regions.length === 0) {
      this.pointsText.visible = false;
      return;
    }
    const { gridOriginX, gridOriginY, cellSize } = this.layout;

    // Outline segments are collected first: a fill in between would swallow them
    const segments: [number, number, number, number][] = [];
    let largest = regions[0];
    for (const region of regions) {
      if (region.area > largest.area) largest = region;
      const inRoom = new Set(region.cells.map(c => `${c.row},${c.col}`));
      for (const cell of region.cells) {
        const x = gridOriginX + cell.col * cellSize;
        const y = gridOriginY + cell.row * cellSize;
        g.rect(x, y, cellSize, cellSize);
        g.fill({ color: THEME.gold, alpha: PREVIEW_FILL_ALPHA });

        // Only the sides that face out of the room, so it reads as one shape
        if (!inRoom.has(`${cell.row - 1},${cell.col}`)) segments.push([x, y, x + cellSize, y]);
        if (!inRoom.has(`${cell.row + 1},${cell.col}`)) segments.push([x, y + cellSize, x + cellSize, y + cellSize]);
        if (!inRoom.has(`${cell.row},${cell.col - 1}`)) segments.push([x, y, x, y + cellSize]);
        if (!inRoom.has(`${cell.row},${cell.col + 1}`)) segments.push([x + cellSize, y, x + cellSize, y + cellSize]);
      }
    }
    for (const [x1, y1, x2, y2] of segments) {
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
    }
    g.stroke({ color: THEME.gold, alpha: PREVIEW_OUTLINE_ALPHA, width: PREVIEW_OUTLINE_WIDTH });

    // Label the biggest room: on a double close that is where the eye goes
    let cx = 0;
    let cy = 0;
    for (const cell of largest.cells) {
      cx += gridOriginX + cell.col * cellSize + cellSize / 2;
      cy += gridOriginY + cell.row * cellSize + cellSize / 2;
    }
    this.pointsText.text = `+${points.toLocaleString()}`;
    this.pointsText.position.set(cx / largest.cells.length, cy / largest.cells.length);
    this.pointsText.visible = true;
  }

  hidePreview(): void {
    this.previewGraphics.clear();
    this.pointsText.visible = false;
  }

  private drawGhost(
    shape: ShapeMatrix,
    row: number,
    col: number,
    color: number,
    valid: boolean,
    fillAlpha: number,
    strokeAlpha: number,
  ): void {
    const g = this.graphics;
    g.clear();
    const { gridOriginX, gridOriginY, cellSize } = this.layout;

    for (let r = 0; r < shape.length; r++) {
      for (let c = 0; c < shape[0].length; c++) {
        if (!shape[r][c]) continue;
        const gr = row + r;
        const gc = col + c;
        if (gr < 0 || gr >= GRID_SIZE || gc < 0 || gc >= GRID_SIZE) continue;

        const x = gridOriginX + gc * cellSize + INSET;
        const y = gridOriginY + gr * cellSize + INSET;
        const size = cellSize - INSET * 2;

        if (valid) {
          // Valid: soft glow fill + bright border
          g.roundRect(x, y, size, size, BLOCK_RADIUS);
          g.fill({ color: lighten(color, 0.3), alpha: fillAlpha });
          g.roundRect(x, y, size, size, BLOCK_RADIUS);
          g.stroke({ width: 1.5, color: lighten(color, 0.4), alpha: strokeAlpha });
        } else {
          // Invalid: dim red fill
          g.roundRect(x, y, size, size, BLOCK_RADIUS);
          g.fill({ color: THEME.danger, alpha: fillAlpha });
          g.roundRect(x, y, size, size, BLOCK_RADIUS);
          g.stroke({ width: 1.4, color: THEME.danger, alpha: strokeAlpha });
        }
      }
    }
  }

  hide(): void {
    this.clearHideTimer();
    this.graphics.clear();
    this.hidePreview();
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}
