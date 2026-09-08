import { GRID_SIZE, Grid, CellColor, GridPos, Region, ShapeMatrix } from './types';

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

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

  constructor() {
    this.grid = Board.createEmptyGrid();
  }

  static createEmptyGrid(): Grid {
    return Array.from({ length: GRID_SIZE }, () =>
      Array.from({ length: GRID_SIZE }, () => null),
    );
  }

  reset(): void {
    this.grid = Board.createEmptyGrid();
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

  /** Check if a shape can be placed at (row, col) */
  canPlace(shape: ShapeMatrix, row: number, col: number): boolean {
    const shapeRows = shape.length;
    const shapeCols = shape[0].length;
    if (row < 0 || col < 0 || row + shapeRows > GRID_SIZE || col + shapeCols > GRID_SIZE) {
      return false;
    }
    for (let r = 0; r < shapeRows; r++) {
      for (let c = 0; c < shapeCols; c++) {
        if (shape[r][c] && this.grid[row + r][col + c] !== null) return false;
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
   * Find every enclosed room.
   * Cost is tiny (81 cells), so callers can use this freely.
   */
  findEnclosures(): Region[] {
    const outside = this.floodFromEdges();
    const visited: boolean[][] = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(false));
    const regions: Region[] = [];

    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        if (this.grid[r][c] !== null || outside[r][c] || visited[r][c]) continue;

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
            if (visited[nr][nc] || this.grid[nr][nc] !== null) continue;
            visited[nr][nc] = true;
            stack.push({ row: nr, col: nc });
          }
        }

        // The fence: blocks orthogonally touching the room
        const fenceSet = new Set<string>();
        const fence: GridPos[] = [];
        for (const p of cells) {
          for (const [dr, dc] of DIRS) {
            const nr = p.row + dr, nc = p.col + dc;
            if (nr < 0 || nc < 0 || nr >= GRID_SIZE || nc >= GRID_SIZE) continue;
            if (this.grid[nr][nc] === null) continue;
            const key = `${nr},${nc}`;
            if (!fenceSet.has(key)) {
              fenceSet.add(key);
              fence.push({ row: nr, col: nc });
            }
          }
        }

        regions.push({ cells, fence, area: cells.length });
      }
    }
    return regions;
  }

  /** Flood fill from border empties: true = reachable from the edge */
  private floodFromEdges(): boolean[][] {
    const outside: boolean[][] = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(false));
    const stack: GridPos[] = [];
    const seed = (r: number, c: number) => {
      if (this.grid[r][c] === null && !outside[r][c]) {
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
        if (outside[nr][nc] || this.grid[nr][nc] !== null) continue;
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
   */
  findClosingCells(): GridPos[] {
    const before = this.findEnclosures().length;
    const out: GridPos[] = [];
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        if (this.grid[r][c] !== null) continue;
        this.grid[r][c] = 0;
        const after = this.findEnclosures().length;
        this.grid[r][c] = null;
        if (after > before) out.push({ row: r, col: c });
      }
    }
    return out;
  }

  clone(): Board {
    const b = new Board();
    b.grid = this.grid.map(row => [...row]);
    return b;
  }
}
