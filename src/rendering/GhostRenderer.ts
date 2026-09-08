import { Container, Graphics } from 'pixi.js';
import { ShapeMatrix, GRID_SIZE } from '../core/types';
import { Layout } from './LayoutManager';
import { THEME, lighten } from './Theme';

const BLOCK_RADIUS = 4;
const INSET = 2;

export class GhostRenderer {
  container: Container;
  private graphics: Graphics;
  private layout!: Layout;
  private hideTimer: number | null = null;

  constructor() {
    this.container = new Container();
    this.graphics = new Graphics();
    this.container.addChild(this.graphics);
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
    this.drawGhost(shape, row, col, color, false, 0.2, 0.65);
    this.hideTimer = window.setTimeout(() => {
      this.hide();
    }, 120);
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
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}
