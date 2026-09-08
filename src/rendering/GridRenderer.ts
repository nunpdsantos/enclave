import { Container, Graphics } from 'pixi.js';
import { GRID_SIZE, Grid, GridPos, CellColor, Region } from '../core/types';
import { Layout } from './LayoutManager';
import { THEME, drawBeveledBlock, drawWallBlock, darken, getBoardTokens, lerpColor, lighten, luminance, easeOutBack } from './Theme';

const BLOCK_INSET = 3;
const CELL_RADIUS = 5;
const CELL_GAP = 1.5;

interface PopCell { row: number; col: number; color: number; life: number }
const POP_DURATION = 0.2;

/** Fence block dissolving after a claim */
interface DyingCell { row: number; col: number; color: number; delay: number; life: number }
const DIE_DURATION = 0.34;

/** Claimed room cell: fills gold, swells, fades */
interface ClaimCell { row: number; col: number; delay: number; life: number }
const CLAIM_DURATION = 0.7;

/** Glowing outline traced around a claimed room */
interface RoomOutline { segments: [number, number, number, number][]; life: number; maxLife: number }
const OUTLINE_DURATION = 0.9;

export class GridRenderer {
  container: Container;
  private bgGraphics: Graphics;
  private blockGraphics: Graphics;
  private hintGraphics: Graphics;
  private popGraphics: Graphics;
  private clearGraphics: Graphics;
  private claimGraphics: Graphics;
  private glowGraphics: Graphics;
  private layout!: Layout;

  private pops: PopCell[] = [];
  private dying: DyingCell[] = [];
  private claiming: ClaimCell[] = [];
  private outlines: RoomOutline[] = [];
  private closingCells: GridPos[] = [];

  private glowPhase = 0;
  private hintPhase = 0;

  constructor() {
    this.container = new Container();
    this.bgGraphics = new Graphics();
    this.glowGraphics = new Graphics();
    this.blockGraphics = new Graphics();
    this.hintGraphics = new Graphics();
    this.popGraphics = new Graphics();
    this.clearGraphics = new Graphics();
    this.claimGraphics = new Graphics();

    this.container.addChild(this.bgGraphics);
    this.container.addChild(this.glowGraphics);
    this.container.addChild(this.hintGraphics);
    this.container.addChild(this.blockGraphics);
    this.container.addChild(this.popGraphics);
    this.container.addChild(this.clearGraphics);
    this.container.addChild(this.claimGraphics);
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
    this.drawBackground();
  }

  private drawBackground(): void {
    const g = this.bgGraphics;
    g.clear();
    const { gridOriginX, gridOriginY, cellSize, gridSize } = this.layout;
    const { cellWell, cellWellBorder } = getBoardTokens();
    const pad = 8;

    g.roundRect(gridOriginX - pad + 2, gridOriginY - pad + 5, gridSize + pad * 2, gridSize + pad * 2, 14);
    g.fill({ color: 0x000000, alpha: 0.32 });
    g.roundRect(gridOriginX - pad, gridOriginY - pad, gridSize + pad * 2, gridSize + pad * 2, 14);
    g.fill({ color: THEME.gridBg });
    g.roundRect(gridOriginX - pad, gridOriginY - pad, gridSize + pad * 2, gridSize + pad * 2, 14);
    g.stroke({ width: 1.5, color: cellWellBorder, alpha: 0.6 });

    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const x = gridOriginX + c * cellSize + CELL_GAP;
        const y = gridOriginY + r * cellSize + CELL_GAP;
        const s = cellSize - CELL_GAP * 2;
        g.roundRect(x, y, s, s, CELL_RADIUS);
        g.fill({ color: cellWell });
        g.roundRect(x, y, s, Math.max(2, s * 0.12), CELL_RADIUS);
        g.fill({ color: 0x000000, alpha: 0.18 });
      }
    }
  }

  /**
   * The board as a wall: every block bridges the gap to the neighbours it
   * actually has, so a run of blocks reads as one fence and a one-cell hole
   * still reads as a hole.
   */
  drawBlocks(grid: Grid): void {
    const g = this.blockGraphics;
    g.clear();
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    const filled = (r: number, c: number): boolean =>
      r >= 0 && c >= 0 && r < GRID_SIZE && c < GRID_SIZE && grid[r][c] !== null;

    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const color = grid[r][c];
        if (color === null) continue;
        drawWallBlock(
          g,
          gridOriginX + c * cellSize,
          gridOriginY + r * cellSize,
          cellSize,
          BLOCK_INSET,
          color,
          CELL_RADIUS,
          { up: filled(r - 1, c), down: filled(r + 1, c), left: filled(r, c - 1), right: filled(r, c + 1) },
        );
      }
    }
    this.drawMortar(grid, filled);
  }

  /**
   * A hairline seam wherever two differently-coloured pieces join, so the
   * individual pieces stay readable once they have merged into a wall.
   */
  private drawMortar(grid: Grid, filled: (r: number, c: number) => boolean): void {
    const g = this.blockGraphics;
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    const byColor = new Map<number, [number, number, number, number][]>();

    const seam = (a: CellColor, b: CellColor, x1: number, y1: number, x2: number, y2: number): void => {
      if (a === b) return;
      const mortar = darken(luminance(a) <= luminance(b) ? a : b, 0.35);
      const segments = byColor.get(mortar) ?? [];
      segments.push([x1, y1, x2, y2]);
      byColor.set(mortar, segments);
    };

    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const color = grid[r][c];
        if (color === null) continue;
        const x = gridOriginX + c * cellSize;
        const y = gridOriginY + r * cellSize;
        // Each shared edge is visited once, from the cell above/left of it.
        // The seam spans only where both tiles are painted, hence the insets.
        const right = c + 1 < GRID_SIZE ? grid[r][c + 1] : null;
        if (right !== null) {
          const top = y + (filled(r - 1, c) && filled(r - 1, c + 1) ? 0 : BLOCK_INSET);
          const bottom = y + cellSize - (filled(r + 1, c) && filled(r + 1, c + 1) ? 0 : BLOCK_INSET);
          seam(color, right, x + cellSize, top, x + cellSize, bottom);
        }
        const below = r + 1 < GRID_SIZE ? grid[r + 1][c] : null;
        if (below !== null) {
          const left = x + (filled(r, c - 1) && filled(r + 1, c - 1) ? 0 : BLOCK_INSET);
          const rightX = x + cellSize - (filled(r, c + 1) && filled(r + 1, c + 1) ? 0 : BLOCK_INSET);
          seam(color, below, left, y + cellSize, rightX, y + cellSize);
        }
      }
    }

    for (const [color, segments] of byColor) {
      for (const [x1, y1, x2, y2] of segments) {
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
      }
      g.stroke({ color, alpha: 0.85, width: 1 });
    }
  }

  popCells(cells: GridPos[], color: CellColor): void {
    for (const cell of cells) this.pops.push({ row: cell.row, col: cell.col, color, life: 0 });
  }

  /** Cells that would close a room if one block landed there */
  setClosingCells(cells: GridPos[]): void {
    this.closingCells = cells;
  }

  /**
   * Animate a claim: room cells flood gold from the placed piece outward,
   * and fence blocks dissolve just behind the wave.
   */
  animateClaim(regions: Region[], fence: GridPos[], fenceColors: CellColor[], origin: GridPos): void {
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    for (const region of regions) {
      const inRoom = new Set(region.cells.map(c => `${c.row},${c.col}`));
      const segments: [number, number, number, number][] = [];
      for (const cell of region.cells) {
        const dist = Math.abs(cell.col - origin.col) + Math.abs(cell.row - origin.row);
        this.claiming.push({ row: cell.row, col: cell.col, delay: dist * 0.03, life: 0 });

        // Outline: every side of the cell that doesn't face another room cell
        const x = gridOriginX + cell.col * cellSize;
        const y = gridOriginY + cell.row * cellSize;
        if (!inRoom.has(`${cell.row - 1},${cell.col}`)) segments.push([x, y, x + cellSize, y]);
        if (!inRoom.has(`${cell.row + 1},${cell.col}`)) segments.push([x, y + cellSize, x + cellSize, y + cellSize]);
        if (!inRoom.has(`${cell.row},${cell.col - 1}`)) segments.push([x, y, x, y + cellSize]);
        if (!inRoom.has(`${cell.row},${cell.col + 1}`)) segments.push([x + cellSize, y, x + cellSize, y + cellSize]);
      }
      this.outlines.push({ segments, life: 0, maxLife: OUTLINE_DURATION });
    }
    for (let i = 0; i < fence.length; i++) {
      const cell = fence[i];
      const dist = Math.abs(cell.col - origin.col) + Math.abs(cell.row - origin.row);
      this.dying.push({ row: cell.row, col: cell.col, color: fenceColors[i] ?? 0xffffff, delay: 0.12 + dist * 0.03, life: 0 });
    }
  }

  update(dt: number): void {
    if (!this.layout) return;
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    const baseSize = cellSize - BLOCK_INSET * 2;

    // Placement pops
    const pg = this.popGraphics;
    pg.clear();
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.life += dt;
      const t = p.life / POP_DURATION;
      if (t >= 1) { this.pops.splice(i, 1); continue; }
      const size = baseSize * (1 + 0.18 * (1 - easeOutBack(t)));
      const cx = gridOriginX + p.col * cellSize + cellSize / 2;
      const cy = gridOriginY + p.row * cellSize + cellSize / 2;
      drawBeveledBlock(pg, cx - size / 2, cy - size / 2, size, p.color, CELL_RADIUS);
      const flash = Math.max(0, 1 - t * 2) * 0.55;
      if (flash > 0.01) {
        pg.roundRect(cx - size / 2, cy - size / 2, size, size, CELL_RADIUS);
        pg.fill({ color: 0xffffff, alpha: flash });
      }
    }

    // Claimed room cells
    const cg = this.claimGraphics;
    cg.clear();
    for (let i = this.claiming.length - 1; i >= 0; i--) {
      const c = this.claiming[i];
      c.life += dt;
      const local = c.life - c.delay;
      if (local < 0) continue;
      const t = local / CLAIM_DURATION;
      if (t >= 1) { this.claiming.splice(i, 1); continue; }
      const cx = gridOriginX + c.col * cellSize + cellSize / 2;
      const cy = gridOriginY + c.row * cellSize + cellSize / 2;
      // Swell in, hold, fade out
      const scale = t < 0.25 ? easeOutBack(t / 0.25) : 1;
      const alpha = t < 0.6 ? 0.9 : 0.9 * (1 - (t - 0.6) / 0.4);
      const size = (cellSize - CELL_GAP * 2) * scale;
      cg.roundRect(cx - size / 2, cy - size / 2, size, size, CELL_RADIUS);
      cg.fill({ color: THEME.gold, alpha });
      cg.roundRect(cx - size / 2 + 2, cy - size / 2 + 2, size - 4, size * 0.35, CELL_RADIUS - 1);
      cg.fill({ color: 0xffffff, alpha: alpha * 0.5 });
    }

    // Room outlines: bright gold stroke that fades as the room dissolves
    for (let i = this.outlines.length - 1; i >= 0; i--) {
      const o = this.outlines[i];
      o.life += dt;
      const t = o.life / o.maxLife;
      if (t >= 1) { this.outlines.splice(i, 1); continue; }
      const alpha = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
      for (const [x1, y1, x2, y2] of o.segments) {
        cg.moveTo(x1, y1);
        cg.lineTo(x2, y2);
      }
      cg.stroke({ color: THEME.goldGlow, alpha: alpha * 0.95, width: 3 });
      for (const [x1, y1, x2, y2] of o.segments) {
        cg.moveTo(x1, y1);
        cg.lineTo(x2, y2);
      }
      cg.stroke({ color: 0xffffff, alpha: alpha * 0.5, width: 1 });
    }

    // Dissolving fence
    const dg = this.clearGraphics;
    dg.clear();
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i];
      d.life += dt;
      const local = d.life - d.delay;
      const cx = gridOriginX + d.col * cellSize + cellSize / 2;
      const cy = gridOriginY + d.row * cellSize + cellSize / 2;
      if (local < 0) {
        drawBeveledBlock(dg, cx - baseSize / 2, cy - baseSize / 2, baseSize, d.color, CELL_RADIUS);
        continue;
      }
      const t = local / DIE_DURATION;
      if (t >= 1) { this.dying.splice(i, 1); continue; }
      let scale: number, alpha: number, flash: number;
      if (t < 0.3) {
        const k = t / 0.3;
        scale = 1 + 0.2 * k; alpha = 1; flash = k;
      } else {
        const k = (t - 0.3) / 0.7;
        scale = 1.2 * (1 - k * k); alpha = 1 - k; flash = 1 - k;
      }
      const size = baseSize * scale;
      if (size <= 0.5) continue;
      drawBeveledBlock(dg, cx - size / 2, cy - size / 2, size, d.color, CELL_RADIUS, alpha);
      dg.roundRect(cx - size / 2, cy - size / 2, size, size, CELL_RADIUS);
      dg.fill({ color: lighten(d.color, 0.7), alpha: flash * 0.85 * alpha });
    }

    // Closing-cell hints
    this.hintPhase += dt * 5;
    const hg = this.hintGraphics;
    hg.clear();
    if (this.closingCells.length > 0) {
      const alpha = 0.22 + Math.sin(this.hintPhase) * 0.1;
      for (const cell of this.closingCells) {
        const x = gridOriginX + cell.col * cellSize;
        const y = gridOriginY + cell.row * cellSize;
        hg.roundRect(x + 3, y + 3, cellSize - 6, cellSize - 6, 4);
        hg.fill({ color: THEME.gold, alpha });
        hg.roundRect(x + 3, y + 3, cellSize - 6, cellSize - 6, 4);
        hg.stroke({ color: THEME.gold, alpha: alpha * 1.6, width: 1 });
      }
    }
  }

  get isAnimating(): boolean {
    return this.dying.length > 0 || this.claiming.length > 0;
  }

  /** Board border heartbeat: clock drives color/rate; crowding tints it orange */
  updateGlow(dt: number, timeRemaining: number, boardFill: number = 0): void {
    const g = this.glowGraphics;
    g.clear();
    if (!this.layout) return;
    const { gridOriginX, gridOriginY, gridSize } = this.layout;
    const pad = 8;

    let rate: number;
    let color: number;
    if (timeRemaining <= 5) { rate = 3; color = 0xff4444; }
    else if (timeRemaining <= 10) { rate = 2; color = 0xff6644; }
    else if (timeRemaining <= 20) { rate = 1.5; color = 0xf59e0b; }
    else { rate = 0.8; color = THEME.accent; }

    if (boardFill >= 0.6) {
      const crowd = Math.min(1, (boardFill - 0.6) / 0.25);
      color = lerpColor(color, 0xff5a3c, crowd * 0.85);
      rate = Math.max(rate, 0.8 + crowd * 1.4);
    }

    this.glowPhase += dt * rate * Math.PI * 2;
    const alpha = Math.max(0.05, 0.3 + Math.sin(this.glowPhase) * 0.3);
    g.roundRect(gridOriginX - pad - 2, gridOriginY - pad - 2, gridSize + pad * 2 + 4, gridSize + pad * 2 + 4, 16);
    g.stroke({ width: 3, color, alpha });
    g.roundRect(gridOriginX - pad - 4, gridOriginY - pad - 4, gridSize + pad * 2 + 8, gridSize + pad * 2 + 8, 18);
    g.stroke({ width: 2, color, alpha: alpha * 0.4 });
  }
}
