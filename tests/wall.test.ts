import { describe, it, expect } from 'vitest';
import { drawWallBlock, WallJoins } from '../src/rendering/Theme';

// Records every point any path/shape command touches, so we can measure the
// painted extent of one wall block.
class FakeGraphics {
  xs: number[] = [];
  ys: number[] = [];
  arcs = 0;
  private p(x: number, y: number): void { this.xs.push(x); this.ys.push(y); }
  moveTo(x: number, y: number) { this.p(x, y); return this; }
  lineTo(x: number, y: number) { this.p(x, y); return this; }
  arcTo(x1: number, y1: number, x2: number, y2: number, _r: number) { this.arcs++; this.p(x1, y1); this.p(x2, y2); return this; }
  closePath() { return this; }
  roundRect(x: number, y: number, w: number, h: number, _r?: number) { this.p(x, y); this.p(x + w, y + h); return this; }
  rect(x: number, y: number, w: number, h: number) { this.p(x, y); this.p(x + w, y + h); return this; }
  fill() { return this; }
  stroke() { return this; }
}

const SIZE = 30;
const INSET = 3;
const NONE: WallJoins = { up: false, down: false, left: false, right: false };

function paint(joins: Partial<WallJoins>): FakeGraphics {
  const g = new FakeGraphics();
  drawWallBlock(g as never, 100, 200, SIZE, INSET, 0x4b7bec, 5, { ...NONE, ...joins });
  return g;
}

describe('drawWallBlock extent', () => {
  it('a lone tile stays inside its inset, on all four sides', () => {
    const g = paint({});
    expect(Math.min(...g.xs)).toBe(100 + INSET);
    expect(Math.max(...g.xs)).toBe(100 + SIZE - INSET);
    expect(Math.min(...g.ys)).toBe(200 + INSET);
    expect(Math.max(...g.ys)).toBe(200 + SIZE - INSET);
    expect(g.arcs).toBeGreaterThan(0);            // rounded on every corner
  });

  it('bridges only toward the sides that report a neighbour', () => {
    const right = paint({ right: true });
    expect(Math.max(...right.xs)).toBe(100 + SIZE);       // reaches the cell edge
    expect(Math.min(...right.xs)).toBe(100 + INSET);      // …but not the other way
    expect(Math.min(...right.ys)).toBe(200 + INSET);
    expect(Math.max(...right.ys)).toBe(200 + SIZE - INSET);

    const down = paint({ down: true });
    expect(Math.max(...down.ys)).toBe(200 + SIZE);
    expect(Math.max(...down.xs)).toBe(100 + SIZE - INSET);
  });

  it('a fully surrounded tile fills its whole cell and has no rounded corner', () => {
    const g = paint({ up: true, down: true, left: true, right: true });
    expect(Math.min(...g.xs)).toBe(100);
    expect(Math.max(...g.xs)).toBe(100 + SIZE);
    expect(Math.min(...g.ys)).toBe(200);
    expect(Math.max(...g.ys)).toBe(200 + SIZE);
    expect(g.arcs).toBe(0);
  });

  it('the block beside a one-cell gap does not reach across it', () => {
    // The ring cell left of the hole: neighbours above, below and left only.
    const g = paint({ up: true, down: true, left: true, right: false });
    expect(Math.max(...g.xs)).toBe(100 + SIZE - INSET);   // gap stays open
    expect(Math.min(...g.xs)).toBe(100);
  });
});
