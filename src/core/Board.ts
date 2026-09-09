import { GRID_SIZE, Grid, CellColor, GridPos, Region, ShapeMatrix, Terrain, TerrainGrid } from './types';

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * The board edge is never a wall, so an empty cell touching it can always
 * reach the outside: only the inner ring-less square can ever be room floor.
 */
export function isInnerCell(row: number, col: number): boolean {
  return row >= 1 && col >= 1 && row <= GRID_SIZE - 2 && col <= GRID_SIZE - 2;
}

/** How many cells a full survey has to light: the inner 7×7 = 49 */
export const INNER_CELLS = (GRID_SIZE - 2) * (GRID_SIZE - 2);

/**
 * The 9×9 board and the one rule that defines the game:
 *
 *   An empty cell is "outside" if it can reach the board edge by walking
 *   through empty cells. Everything else is enclosed.
 *
 * We find enclosures with a flood fill: start from every empty cell on the
 * border, spread through empty neighbours, and mark what we reach. Any empty
 * cell left unmarked is inside a fence. Grouping those into connected
 * components gives the individual rooms.
 */
export class Board {
  grid: Grid;
  /**
   * Territory: floor that has been claimed at least once this run. Independent
   * of `grid` — a lit cell can hold a block and still be lit underneath.
   */
  lit: boolean[][];
  /**
   * What each cell *is*, under whatever is on it. All 'floor' outside the
   * siege, which is why nothing else in the game had to change: 'floor' is
   * exactly the old behaviour on every rule below.
   */
  terrain: TerrainGrid;
  /**
   * Cells an enemy is standing on. Not part of `grid` — an enemy is a floor
   * occupant, so it never holds the flood fill back and never bounds a room —
   * but a piece cannot land on one either.
   */
  occupied: boolean[][];

  constructor() {
    this.grid = Board.createEmptyGrid();
    this.lit = Board.createUnlitMap();
    this.terrain = Board.createFloorTerrain();
    this.occupied = Board.createUnlitMap();
  }

  static createEmptyGrid(): Grid {
    return Array.from({ length: GRID_SIZE }, () =>
      Array.from({ length: GRID_SIZE }, () => null),
    );
  }

  static createUnlitMap(): boolean[][] {
    return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(false));
  }

  static createFloorTerrain(): TerrainGrid {
    return Array.from({ length: GRID_SIZE }, () =>
      Array.from({ length: GRID_SIZE }, (): Terrain => 'floor'),
    );
  }

  /**
   * `reset` deliberately does not clear the terrain: it is the mission's map,
   * set once when the run is configured, and a run that reset it would start
   * the siege on an open field. GameState re-applies it on `start`.
   */
  reset(): void {
    this.grid = Board.createEmptyGrid();
    this.lit = Board.createUnlitMap();
    this.occupied = Board.createUnlitMap();
  }

  // ── Terrain ──

  setTerrain(terrain: TerrainGrid): void {
    this.terrain = terrain.map(row => [...row]);
  }

  terrainAt(row: number, col: number): Terrain {
    return this.terrain[row][col];
  }

  /**
   * Only open floor takes a piece. The Keep and its gates are floor for the
   * flood fill — a room may enclose them — but they are never built on, and
   * ruins are wall already.
   */
  isBuildable(row: number, col: number): boolean {
    return this.terrain[row][col] === 'floor' && !this.occupied[row][col];
  }

  /** True where a permanent old wall stands: boundary the player did not build */
  isRuin(row: number, col: number): boolean {
    return this.terrain[row][col] === 'ruin';
  }

  /** Where the enemy is standing right now. Replaces the whole set. */
  setOccupied(cells: GridPos[]): void {
    this.occupied = Board.createUnlitMap();
    for (const p of cells) this.occupied[p.row][p.col] = true;
  }

  getCell(row: number, col: number): CellColor | null {
    return this.grid[row][col];
  }

  isEmpty(): boolean {
    return this.occupiedCount() === 0;
  }

  occupiedCount(): number {
    let n = 0;
    for (const row of this.grid) for (const c of row) if (c !== null) n++;
    return n;
  }

  // ── Territory ──

  /** Only inner cells can be room floor, so only they can ever be lit */
  isInner(row: number, col: number): boolean {
    return isInnerCell(row, col);
  }

  /** Lit inner cells, 0–INNER_CELLS. O(81), so claim-time only, never per frame. */
  litCount(): number {
    let n = 0;
    for (const row of this.lit) for (const c of row) if (c) n++;
    return n;
  }

  /** Light claimed floor. Cells outside the inner square are ignored. */
  markLit(cells: GridPos[]): void {
    for (const p of cells) {
      if (this.isInner(p.row, p.col)) this.lit[p.row][p.col] = true;
    }
  }

  clearLit(): void {
    this.lit = Board.createUnlitMap();
  }

  /** How many of these cells have never been claimed this run */
  freshCount(cells: GridPos[]): number {
    let n = 0;
    for (const p of cells) if (!this.lit[p.row][p.col]) n++;
    return n;
  }

  /** Check if a shape can be placed at (row, col) */
  canPlace(shape: ShapeMatrix, row: number, col: number): boolean {
    const shapeRows = shape.length;
    const shapeCols = shape[0].length;
    if (row < 0 || col < 0 || row + shapeRows > GRID_SIZE || col + shapeCols > GRID_SIZE) {
      return false;
    }
    for (let r = 0; r < shapeRows; r++) {
      for (let c = 0; c < shapeCols; c++) {
        if (!shape[r][c]) continue;
        if (this.grid[row + r][col + c] !== null) return false;
        if (!this.isBuildable(row + r, col + c)) return false;
      }
    }
    return true;
  }

  /** Check if a shape fits anywhere on the board */
  canPlaceAnywhere(shape: ShapeMatrix): boolean {
    for (let row = 0; row <= GRID_SIZE - shape.length; row++) {
      for (let col = 0; col <= GRID_SIZE - shape[0].length; col++) {
        if (this.canPlace(shape, row, col)) return true;
      }
    }
    return false;
  }

  /** Place a shape at (row, col). Returns the cells that were filled. */
  place(shape: ShapeMatrix, row: number, col: number, color: CellColor): GridPos[] {
    const cells: GridPos[] = [];
    for (let r = 0; r < shape.length; r++) {
      for (let c = 0; c < shape[0].length; c++) {
        if (shape[r][c]) {
          this.grid[row + r][col + c] = color;
          cells.push({ row: row + r, col: col + c });
        }
      }
    }
    return cells;
  }

  /**
   * Blocks, plus any extra cells the caller says are walls — the echo walls a
   * recent claim left behind. One pass over 81 cells so the flood fill and the
   * fence scan can both ask "is this a wall?" without rebuilding a key string.
   */
  private wallMap(extraWalls?: ReadonlySet<string>): boolean[][] {
    // Blocks and ruins hold it back; the Keep, its gates and the enemies
    // standing on them are all floor, so a room can enclose any of them.
    const wall: boolean[][] = this.grid.map((row, r) =>
      row.map((c, col) => c !== null || this.terrain[r][col] === 'ruin'),
    );
    if (extraWalls) {
      for (const key of extraWalls) {
        const comma = key.indexOf(',');
        const r = Number(key.slice(0, comma));
        const c = Number(key.slice(comma + 1));
        if (r >= 0 && c >= 0 && r < GRID_SIZE && c < GRID_SIZE) wall[r][c] = true;
      }
    }
    return wall;
  }

  /**
   * Find every enclosed room.
   * Cost is tiny (81 cells), so callers can use this freely.
   *
   * `extraWalls` ('row,col' keys) are cells with no block that still hold the
   * flood back: echo walls. They bound rooms exactly as blocks do, but they
   * are reported in `echoCells` rather than `fence`, because a claim cannot
   * remove a wall that is not there.
   */
  findEnclosures(extraWalls?: ReadonlySet<string>): Region[] {
    const wall = this.wallMap(extraWalls);
    const outside = this.floodFromEdges(wall);
    const visited: boolean[][] = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(false));
    const regions: Region[] = [];

    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        if (wall[r][c] || outside[r][c] || visited[r][c]) continue;

        // Collect this enclosed component
        const cells: GridPos[] = [];
        const stack: GridPos[] = [{ row: r, col: c }];
        visited[r][c] = true;
        while (stack.length) {
          const p = stack.pop()!;
          cells.push(p);
          for (const [dr, dc] of DIRS) {
            const nr = p.row + dr, nc = p.col + dc;
            if (nr < 0 || nc < 0 || nr >= GRID_SIZE || nc >= GRID_SIZE) continue;
            if (visited[nr][nc] || wall[nr][nc]) continue;
            visited[nr][nc] = true;
            stack.push({ row: nr, col: nc });
          }
        }

        // The boundary: blocks orthogonally touching the room are its fence,
        // echo walls in the same position are the ghost half of it
        const seen = new Set<string>();
        const fence: GridPos[] = [];
        const echoCells: GridPos[] = [];
        const ruinCells: GridPos[] = [];
        for (const p of cells) {
          for (const [dr, dc] of DIRS) {
            const nr = p.row + dr, nc = p.col + dc;
            if (nr < 0 || nc < 0 || nr >= GRID_SIZE || nc >= GRID_SIZE) continue;
            if (!wall[nr][nc]) continue;
            const key = `${nr},${nc}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (this.grid[nr][nc] !== null) fence.push({ row: nr, col: nc });
            else if (this.terrain[nr][nc] === 'ruin') ruinCells.push({ row: nr, col: nc });
            else echoCells.push({ row: nr, col: nc });
          }
        }

        regions.push({ cells, fence, echoCells, ruinCells, area: cells.length });
      }
    }
    return regions;
  }

  /** Flood fill from border empties: true = reachable from the edge */
  private floodFromEdges(wall: boolean[][]): boolean[][] {
    const outside: boolean[][] = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(false));
    const stack: GridPos[] = [];
    const seed = (r: number, c: number) => {
      if (!wall[r][c] && !outside[r][c]) {
        outside[r][c] = true;
        stack.push({ row: r, col: c });
      }
    };
    for (let i = 0; i < GRID_SIZE; i++) {
      seed(0, i); seed(GRID_SIZE - 1, i); seed(i, 0); seed(i, GRID_SIZE - 1);
    }
    while (stack.length) {
      const p = stack.pop()!;
      for (const [dr, dc] of DIRS) {
        const nr = p.row + dr, nc = p.col + dc;
        if (nr < 0 || nc < 0 || nr >= GRID_SIZE || nc >= GRID_SIZE) continue;
        if (outside[nr][nc] || wall[nr][nc]) continue;
        outside[nr][nc] = true;
        stack.push({ row: nr, col: nc });
      }
    }
    return outside;
  }

  /** Remove the given blocks. Returns their colors (parallel array). */
  clearCells(cells: GridPos[]): CellColor[] {
    const colors: CellColor[] = [];
    for (const p of cells) {
      colors.push(this.grid[p.row][p.col] ?? 0xffffff);
      this.grid[p.row][p.col] = null;
    }
    return colors;
  }

  /**
   * Hint helper: which empty cells would, if filled by a single block,
   * create a brand-new enclosure? These are "one block from closing".
   *
   * `extraWalls` is the same echo set the real placement will be judged
   * against, so a hint promises a close that the drop actually delivers.
   */
  findClosingCells(extraWalls?: ReadonlySet<string>): GridPos[] {
    const before = this.findEnclosures(extraWalls).length;
    const out: GridPos[] = [];
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        if (this.grid[r][c] !== null) continue;
        // A hint has to promise a placement the board would actually accept
        if (!this.isBuildable(r, c)) continue;
        this.grid[r][c] = 0;
        const after = this.findEnclosures(extraWalls).length;
        this.grid[r][c] = null;
        if (after > before) out.push({ row: r, col: c });
      }
    }
    return out;
  }

  clone(): Board {
    const b = new Board();
    b.grid = this.grid.map(row => [...row]);
    b.lit = this.lit.map(row => [...row]);
    b.terrain = this.terrain.map(row => [...row]);
    b.occupied = this.occupied.map(row => [...row]);
    return b;
  }
}
