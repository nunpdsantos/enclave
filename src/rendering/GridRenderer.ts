import { Container, Graphics } from 'pixi.js';
import { Grid, GridPos, CellColor, EchoWall, Region, TerrainGrid } from '../core/types';
import { isInnerCell } from '../core/Board';
import { SiegeIntent } from '../core/Siege';
import { Layout } from './LayoutManager';
import { SIEGE, THEME, drawBeveledBlock, drawWallBlock, darken, getBoardTokens, lerpColor, lighten, luminance, easeOutBack } from './Theme';

const BLOCK_INSET = 3;
const CELL_RADIUS = 5;
const CELL_GAP = 1.5;

// Lit floor: a well one notch brighter, ringed in faint gold. Deliberately
// quiet — it sits under blocks, hints and the ghost, and must not shout.
const LIT_LIGHTEN = 0.10;
const LIT_BORDER_ALPHA = 0.28;
/** A survey wipes the map, so the floor dissolves instead of blinking out */
const FLOOR_FADE_DURATION = 0.6;

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

/** How solid an echo wall looks at the instant the claim removes it */
const ECHO_MAX_ALPHA = 0.55;

/** A raider's circle, as a fraction of the cell */
const RAIDER_RADIUS = 0.30;

/** How solid a held courtyard reads. Quiet: it is under everything. */
const HELD_ALPHA = 0.30;
/** Seconds a courtyard takes to fill in, and to drain back out */
const HELD_FILL_SECONDS = 0.35;
/** How long a capture burst and a wall shatter last */
const CAPTURE_SECONDS = 0.45;
const WALL_BREAK_SECONDS = 0.4;

/** One held cell, mid-fill or mid-drain */
interface HeldCell { row: number; col: number; t: number; target: 0 | 1 }
/** A raider that was just taken, or a wall that was just knocked down */
interface Burst { row: number; col: number; life: number }

export class GridRenderer {
  container: Container;
  private bgGraphics: Graphics;
  /** The mission map, under everything: keep, gates, ruins */
  private terrainGraphics: Graphics;
  private floorGraphics: Graphics;
  /** Courtyards the player holds: persistent, above the map, under the walls */
  private heldGraphics: Graphics;
  private echoGraphics: Graphics;
  private blockGraphics: Graphics;
  private hintGraphics: Graphics;
  private popGraphics: Graphics;
  private clearGraphics: Graphics;
  private claimGraphics: Graphics;
  private glowGraphics: Graphics;
  /** Enemies, above the blocks they are walking into */
  private enemyGraphics: Graphics;
  /** What the enemy will do next, above the enemies themselves */
  private intentGraphics: Graphics;
  private layout!: Layout;

  private pops: PopCell[] = [];
  private dying: DyingCell[] = [];
  private claiming: ClaimCell[] = [];
  private outlines: RoomOutline[] = [];
  private closingCells: GridPos[] = [];
  /** Echo walls, counted down here so the fade is smooth between updates */
  private echoes: EchoWall[] = [];
  /** Last grid drawn, so an echo can join to the real blocks beside it */
  private blockGrid: Grid | null = null;

  /** Last lit map drawn, kept so a resize can repaint the floor from it */
  private litMap: boolean[][] | null = null;
  private floorFade = 0;

  private glowPhase = 0;
  private hintPhase = 0;

  // ── Siege ──
  private terrain: TerrainGrid | null = null;
  private raiderCells: GridPos[] = [];
  private intent: SiegeIntent | null = null;
  /** What the enemy would do if the piece under the finger were dropped */
  private previewIntent: SiegeIntent | null = null;
  private previewCaptured: GridPos[] = [];
  private intentPhase = 0;
  /** Held courtyards, keyed 'row,col', each on its own fill or drain */
  private heldCells = new Map<string, HeldCell>();
  private captureBursts: Burst[] = [];
  private wallBreaks: Burst[] = [];

  constructor() {
    this.container = new Container();
    this.bgGraphics = new Graphics();
    this.terrainGraphics = new Graphics();
    this.floorGraphics = new Graphics();
    this.heldGraphics = new Graphics();
    this.echoGraphics = new Graphics();
    this.glowGraphics = new Graphics();
    this.blockGraphics = new Graphics();
    this.hintGraphics = new Graphics();
    this.popGraphics = new Graphics();
    this.clearGraphics = new Graphics();
    this.claimGraphics = new Graphics();
    this.enemyGraphics = new Graphics();
    this.intentGraphics = new Graphics();

    this.container.addChild(this.bgGraphics);
    // The map is what the board *is*, so it sits under the lit floor and
    // under everything the run puts on top of it
    this.container.addChild(this.terrainGraphics);
    this.container.addChild(this.floorGraphics);
    // Held ground sits on the map and under everything that moves
    this.container.addChild(this.heldGraphics);
    // Above the floor it stands on, below the blocks it used to be one of
    this.container.addChild(this.echoGraphics);
    this.container.addChild(this.glowGraphics);
    this.container.addChild(this.hintGraphics);
    this.container.addChild(this.blockGraphics);
    // Enemies stand on top of the walls they are about to knock down
    this.container.addChild(this.enemyGraphics);
    this.container.addChild(this.intentGraphics);
    this.container.addChild(this.popGraphics);
    this.container.addChild(this.clearGraphics);
    this.container.addChild(this.claimGraphics);
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
    this.drawBackground();
    // The floor is only repainted on a claim, so a resize has to repaint it
    // here or the surveyed ground would sit at the old cell size. A resize
    // mid-dissolve keeps dissolving: drawFloor resets the fade, so save it.
    if (this.litMap) {
      const fade = this.floorFade;
      this.drawFloor(this.litMap);
      this.floorFade = fade;
    }
    this.drawEcho();
    if (this.terrain) this.drawTerrain(this.terrain);
    this.drawHeld();
    this.drawEnemies();
    this.drawIntent();
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

    for (let r = 0; r < this.layout.gridCells; r++) {
      for (let c = 0; c < this.layout.gridCells; c++) {
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
   * Surveyed ground: floor already claimed once this run.
   *
   * Cheap and rare — one pass over 81 cells, called when a claim changes the
   * lit map, never per frame. Drawn straight on top of the well and under
   * everything else, so blocks, hints and the ghost all still read over it.
   */
  drawFloor(lit: boolean[][]): void {
    this.litMap = lit;
    this.floorFade = 0;
    const g = this.floorGraphics;
    g.clear();
    g.alpha = 1;
    if (!this.layout) return;
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    const floorColor = lighten(getBoardTokens().cellWell, LIT_LIGHTEN);
    const s = cellSize - CELL_GAP * 2;

    for (let r = 0; r < this.layout.gridCells; r++) {
      for (let c = 0; c < this.layout.gridCells; c++) {
        if (!lit[r][c]) continue;
        const x = gridOriginX + c * cellSize + CELL_GAP;
        const y = gridOriginY + r * cellSize + CELL_GAP;
        g.roundRect(x, y, s, s, CELL_RADIUS);
        g.fill({ color: floorColor });
        g.roundRect(x + 1.5, y + 1.5, s - 3, s - 3, Math.max(1, CELL_RADIUS - 1));
        g.stroke({ color: THEME.gold, alpha: LIT_BORDER_ALPHA, width: 1 });
      }
    }
  }

  /**
   * The survey moment: the map is full by definition, so paint the whole
   * inner square and dissolve it. Fading the layer's alpha rather than
   * redrawing keeps this free per frame.
   */
  surveyFadeOut(): void {
    const cells = this.layout.gridCells;
    const full = Array.from({ length: cells }, (_, r) =>
      Array.from({ length: cells }, (_, c) => isInnerCell(r, c, cells)),
    );
    this.drawFloor(full);
    this.floorFade = FLOOR_FADE_DURATION;
  }

  /**
   * The board as a wall: every block bridges the gap to the neighbours it
   * actually has, so a run of blocks reads as one fence and a one-cell hole
   * still reads as a hole.
   */
  drawBlocks(grid: Grid): void {
    const g = this.blockGraphics;
    this.blockGrid = grid;
    g.clear();
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    const filled = (r: number, c: number): boolean =>
      r >= 0 && c >= 0 && r < this.layout.gridCells && c < this.layout.gridCells && grid[r][c] !== null;

    for (let r = 0; r < this.layout.gridCells; r++) {
      for (let c = 0; c < this.layout.gridCells; c++) {
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

    for (let r = 0; r < this.layout.gridCells; r++) {
      for (let c = 0; c < this.layout.gridCells; c++) {
        const color = grid[r][c];
        if (color === null) continue;
        const x = gridOriginX + c * cellSize;
        const y = gridOriginY + r * cellSize;
        // Each shared edge is visited once, from the cell above/left of it.
        // The seam spans only where both tiles are painted, hence the insets.
        const right = c + 1 < this.layout.gridCells ? grid[r][c + 1] : null;
        if (right !== null) {
          const top = y + (filled(r - 1, c) && filled(r - 1, c + 1) ? 0 : BLOCK_INSET);
          const bottom = y + cellSize - (filled(r + 1, c) && filled(r + 1, c + 1) ? 0 : BLOCK_INSET);
          seam(color, right, x + cellSize, top, x + cellSize, bottom);
        }
        const below = r + 1 < this.layout.gridCells ? grid[r + 1][c] : null;
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

  /**
   * The echo walls now standing. Called only when the set changes — the fade
   * itself is run here in `update`, from the `remaining` each cell arrives
   * with, so a prune upstream also re-syncs the countdown.
   */
  setEcho(cells: EchoWall[]): void {
    this.echoes = cells.map(c => ({ ...c }));
    this.drawEcho();
  }

  /**
   * A ghost of a wall has to read as a wall, so it is the same tile in the
   * same colour, joined to the real blocks and to the rest of its own fence,
   * just translucent and dimming as its window runs out.
   */
  private drawEcho(): void {
    const g = this.echoGraphics;
    g.clear();
    if (!this.layout || this.echoes.length === 0) return;
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    const grid = this.blockGrid;
    const ghosts = new Set(this.echoes.map(e => `${e.row},${e.col}`));
    const walled = (r: number, c: number): boolean =>
      r >= 0 && c >= 0 && r < this.layout.gridCells && c < this.layout.gridCells
      && ((grid !== null && grid[r][c] !== null) || ghosts.has(`${r},${c}`));

    for (const e of this.echoes) {
      const life = e.window > 0 ? Math.max(0, Math.min(1, e.remaining / e.window)) : 0;
      const alpha = ECHO_MAX_ALPHA * life;
      if (alpha <= 0.01) continue;
      drawWallBlock(
        g,
        gridOriginX + e.col * cellSize,
        gridOriginY + e.row * cellSize,
        cellSize,
        BLOCK_INSET,
        e.color,
        CELL_RADIUS,
        {
          up: walled(e.row - 1, e.col), down: walled(e.row + 1, e.col),
          left: walled(e.row, e.col - 1), right: walled(e.row, e.col + 1),
        },
        alpha,
      );
    }
  }


  // ── Siege: the map, the enemy, and what it will do next ──

  /**
   * The mission map. Graybox and static: it is drawn once when the run starts
   * and again on a resize, never per frame.
   *
   * A gold Keep with a K on it, gates as red-outlined cells on the border, and
   * ruins as dead grey stone. Nothing here animates, because everything that
   * moves on this board should be the enemy or the player.
   */
  drawTerrain(terrain: TerrainGrid): void {
    this.terrain = terrain;
    const g = this.terrainGraphics;
    g.clear();
    if (!this.layout) return;
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    const s = cellSize - CELL_GAP * 2;

    for (let r = 0; r < this.layout.gridCells; r++) {
      for (let c = 0; c < this.layout.gridCells; c++) {
        const kind = terrain[r][c];
        if (kind === 'floor') continue;
        const x = gridOriginX + c * cellSize + CELL_GAP;
        const y = gridOriginY + r * cellSize + CELL_GAP;

        if (kind === 'ruin') {
          // Old stone: flat, unlit, obviously not something you built
          g.roundRect(x, y, s, s, 3);
          g.fill({ color: SIEGE.ruin });
          g.roundRect(x + 2, y + 2, s - 4, s - 4, 2);
          g.stroke({ color: darken(SIEGE.ruin, 0.4), width: 1 });
        } else if (kind === 'gate') {
          g.roundRect(x, y, s, s, CELL_RADIUS);
          g.fill({ color: SIEGE.gate, alpha: 0.18 });
          g.roundRect(x + 1, y + 1, s - 2, s - 2, CELL_RADIUS);
          g.stroke({ color: SIEGE.gate, alpha: 0.95, width: 2 });
        } else {
          g.roundRect(x, y, s, s, CELL_RADIUS);
          g.fill({ color: SIEGE.keep });
          g.roundRect(x + 1.5, y + 1.5, s - 3, s - 3, CELL_RADIUS - 1);
          g.stroke({ color: lighten(SIEGE.keep, 0.4), alpha: 0.8, width: 1.5 });
          this.drawKeepMark(g, x, y, s);
        }
      }
    }
  }

  /**
   * A K, in strokes. Cheaper than carrying a Text through every resize, and
   * at graybox sizes a letterform drawn as three lines reads as well as a
   * glyph would.
   */
  private drawKeepMark(g: Graphics, x: number, y: number, s: number): void {
    const left = x + s * 0.32;
    const top = y + s * 0.26;
    const bottom = y + s * 0.74;
    const mid = (top + bottom) / 2;
    const right = x + s * 0.7;
    g.moveTo(left, top);
    g.lineTo(left, bottom);
    g.moveTo(left, mid);
    g.lineTo(right, top);
    g.moveTo(left, mid);
    g.lineTo(right, bottom);
    g.stroke({ color: SIEGE.keepMark, width: Math.max(1.5, s * 0.1) });
  }

  /**
   * The courtyards the player holds.
   *
   * Persistent, not a celebration: ground that is yours stays filled for as
   * long as it is sealed, because it is paying you every turn. Cells fade in
   * when they become held and drain back out when a wall comes down and lets
   * the outside in — which is the only feedback that says what a broken wall
   * actually cost.
   */
  setHeld(cells: GridPos[]): void {
    const wanted = new Set(cells.map(c => `${c.row},${c.col}`));
    for (const cell of cells) {
      const key = `${cell.row},${cell.col}`;
      const existing = this.heldCells.get(key);
      if (existing) existing.target = 1;
      else this.heldCells.set(key, { row: cell.row, col: cell.col, t: 0, target: 1 });
    }
    for (const [key, cell] of this.heldCells) {
      if (!wanted.has(key)) cell.target = 0;
    }
    this.drawHeld();
  }

  private drawHeld(): void {
    const g = this.heldGraphics;
    g.clear();
    if (!this.layout || this.heldCells.size === 0) return;
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    const s = cellSize - CELL_GAP * 2;
    for (const cell of this.heldCells.values()) {
      if (cell.t <= 0.01) continue;
      const x = gridOriginX + cell.col * cellSize + CELL_GAP;
      const y = gridOriginY + cell.row * cellSize + CELL_GAP;
      g.roundRect(x, y, s, s, CELL_RADIUS);
      g.fill({ color: SIEGE.held, alpha: HELD_ALPHA * cell.t });
      g.roundRect(x + 1.5, y + 1.5, s - 3, s - 3, Math.max(1, CELL_RADIUS - 1));
      g.stroke({ color: SIEGE.heldEdge, alpha: 0.45 * cell.t, width: 1 });
    }
  }

  /** A raider was taken. Distinct from a wall coming down, deliberately. */
  captureCells(cells: GridPos[]): void {
    for (const cell of cells) this.captureBursts.push({ row: cell.row, col: cell.col, life: 0 });
  }

  /** A raider knocked a wall down. Grey shards, not a gold burst. */
  breakCells(cells: GridPos[]): void {
    for (const cell of cells) this.wallBreaks.push({ row: cell.row, col: cell.col, life: 0 });
  }

  /** Where the raiders are */
  setEnemies(raiders: GridPos[]): void {
    this.raiderCells = raiders;
    this.drawEnemies();
  }

  private drawEnemies(): void {
    const g = this.enemyGraphics;
    g.clear();
    if (!this.layout) return;
    const { gridOriginX, gridOriginY, cellSize } = this.layout;

    const radius = cellSize * RAIDER_RADIUS;
    for (const cell of this.raiderCells) {
      const cx = gridOriginX + cell.col * cellSize + cellSize / 2;
      const cy = gridOriginY + cell.row * cellSize + cellSize / 2;
      g.circle(cx, cy + 1, radius);
      g.fill({ color: SIEGE.enemyDark, alpha: 0.9 });
      g.circle(cx, cy, radius);
      g.fill({ color: SIEGE.enemy });
      g.circle(cx - radius * 0.3, cy - radius * 0.35, radius * 0.3);
      g.fill({ color: 0xffffff, alpha: 0.35 });
    }
  }

  /**
   * What the enemy does next, drawn before the player commits.
   *
   * The make-or-break feature of the mode: a ring on the cell each raider
   * will step into, and a red outline round any wall that will be attacked.
   * Redrawn whenever the placement might have changed the answer, which is on
   * every snapped drag position.
   */
  setIntent(intent: SiegeIntent | null): void {
    this.intent = intent;
    this.drawIntent();
  }

  /**
   * Swap the intent layer for the one a candidate placement would produce.
   *
   * `captured` are enemies the drop would destroy: they get a cross rather
   * than an arrow, because what they do next is nothing. Passing null puts
   * the live intent back.
   */
  setPreviewIntent(intent: SiegeIntent | null, captured: GridPos[]): void {
    this.previewIntent = intent;
    this.previewCaptured = captured;
    this.drawIntent();
  }

  private drawIntent(): void {
    const g = this.intentGraphics;
    g.clear();
    // While a piece is being dragged the layer shows the future that drop
    // would make, not the one the board is currently heading for
    const intent = this.previewIntent ?? this.intent;
    if (!this.layout || !intent) return;
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    const centre = (cell: GridPos): [number, number] => [
      gridOriginX + cell.col * cellSize + cellSize / 2,
      gridOriginY + cell.row * cellSize + cellSize / 2,
    ];
    // One shared breath, so every mark on the layer pulses together
    const pulse = 0.7 + Math.sin(this.intentPhase) * 0.3;

    for (const [, target] of intent.steps) {
      const [cx, cy] = centre(target);
      const r = cellSize * 0.22;
      g.circle(cx, cy, r);
      g.stroke({ color: SIEGE.intent, alpha: 0.5 + pulse * 0.35, width: 2 });
      g.circle(cx, cy, r * 0.35);
      g.fill({ color: SIEGE.intent, alpha: 0.35 + pulse * 0.3 });
    }

    // A wall about to come down is outlined, not filled: the player still has
    // it, and the outline is a warning rather than a loss.
    for (const wall of intent.threatenedWalls) {
      const x = gridOriginX + wall.col * cellSize + CELL_GAP;
      const y = gridOriginY + wall.row * cellSize + CELL_GAP;
      const s = cellSize - CELL_GAP * 2;
      g.roundRect(x, y, s, s, CELL_RADIUS);
      g.stroke({ color: SIEGE.threat, alpha: 0.55 + pulse * 0.4, width: 2.5 });
    }

    // Raiders the drop would destroy: struck out, because their next move is
    // not going to happen
    for (const cell of this.previewCaptured) {
      const [cx, cy] = centre(cell);
      const r = cellSize * 0.26;
      g.moveTo(cx - r, cy - r);
      g.lineTo(cx + r, cy + r);
      g.moveTo(cx + r, cy - r);
      g.lineTo(cx - r, cy + r);
      g.stroke({ color: THEME.gold, alpha: 0.95, width: 3 });
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

    // Surveyed floor dissolving after a survey reset
    if (this.floorFade > 0) {
      this.floorFade = Math.max(0, this.floorFade - dt);
      this.floorGraphics.alpha = this.floorFade / FLOOR_FADE_DURATION;
      if (this.floorFade === 0) {
        this.floorGraphics.clear();
        this.floorGraphics.alpha = 1;
        this.litMap = null;
      }
    }

    // Echo walls: redrawn every frame, but only while any are standing —
    // fading is the whole point of them, and there are never more than a
    // fence's worth.
    if (this.echoes.length > 0) {
      for (let i = this.echoes.length - 1; i >= 0; i--) {
        this.echoes[i].remaining -= dt;
        if (this.echoes[i].remaining <= 0) this.echoes.splice(i, 1);
      }
      this.drawEcho();
    }

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

    // Held ground fills in and drains out. Only redrawn while something is
    // actually moving; a settled courtyard costs nothing per frame.
    if (this.heldCells.size > 0) {
      let moving = false;
      for (const [key, cell] of this.heldCells) {
        const step = dt / HELD_FILL_SECONDS;
        if (cell.target === 1 && cell.t < 1) { cell.t = Math.min(1, cell.t + step); moving = true; }
        else if (cell.target === 0) {
          cell.t = Math.max(0, cell.t - step);
          moving = true;
          if (cell.t === 0) this.heldCells.delete(key);
        }
      }
      if (moving) this.drawHeld();
    }

    // A capture: a ring off the cell the raider stood on, gold, quick
    for (let i = this.captureBursts.length - 1; i >= 0; i--) {
      const b = this.captureBursts[i];
      b.life += dt;
      const t = b.life / CAPTURE_SECONDS;
      if (t >= 1) { this.captureBursts.splice(i, 1); continue; }
      const cx = gridOriginX + b.col * cellSize + cellSize / 2;
      const cy = gridOriginY + b.row * cellSize + cellSize / 2;
      const r = cellSize * (0.2 + easeOutBack(Math.min(1, t * 1.6)) * 0.55);
      cg.circle(cx, cy, r);
      cg.stroke({ color: THEME.gold, alpha: (1 - t) * 0.9, width: 3 });
      cg.circle(cx, cy, r * 0.45);
      cg.fill({ color: THEME.goldGlow, alpha: (1 - t) * 0.5 });
    }

    // A wall coming down: grey shards falling out of the gap, no gold in it
    for (let i = this.wallBreaks.length - 1; i >= 0; i--) {
      const b = this.wallBreaks[i];
      b.life += dt;
      const t = b.life / WALL_BREAK_SECONDS;
      if (t >= 1) { this.wallBreaks.splice(i, 1); continue; }
      const cx = gridOriginX + b.col * cellSize + cellSize / 2;
      const cy = gridOriginY + b.row * cellSize + cellSize / 2;
      const spread = cellSize * (0.15 + t * 0.5);
      const shard = Math.max(2, cellSize * 0.18 * (1 - t));
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.6;
        dg.rect(
          cx + Math.cos(a) * spread - shard / 2,
          cy + Math.sin(a) * spread - shard / 2 + t * cellSize * 0.3,
          shard, shard,
        );
      }
      dg.fill({ color: SIEGE.rubble, alpha: (1 - t) * 0.85 });
      dg.roundRect(cx - cellSize * 0.34, cy - cellSize * 0.34, cellSize * 0.68, cellSize * 0.68, CELL_RADIUS);
      dg.stroke({ color: SIEGE.threat, alpha: (1 - t) * 0.7, width: 2 });
    }

    // The intent layer breathes, so an arrow reads as live rather than painted
    if (this.intent || this.previewIntent) {
      this.intentPhase += dt * 3;
      this.drawIntent();
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
    return this.dying.length > 0 || this.claiming.length > 0
      || this.captureBursts.length > 0 || this.wallBreaks.length > 0;
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
