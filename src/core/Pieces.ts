import { PieceInstance, PieceType, ShapeMatrix, PIECE_COLORS } from './types';

/**
 * Piece definitions, rotation, and the "bag" randomiser.
 *
 * Every piece can be rotated (unlike Speed Block), because fence-building is
 * about orientation: the same L closes a corner one way and blocks a corridor
 * the other way. Rotations are precomputed so a rotate is just an index bump.
 *
 * Pieces are dealt from a shuffled bag (the Tetris "7-bag" idea): each bag
 * holds a fixed mix, so runs never starve the player of straight lines for
 * long, and no two players get wildly different luck.
 */

function m(rows: number[][]): ShapeMatrix {
  return rows.map(r => r.map(v => v === 1));
}

function rotate90(shape: ShapeMatrix): ShapeMatrix {
  const rows = shape.length;
  const cols = shape[0].length;
  const out: ShapeMatrix = [];
  for (let c = 0; c < cols; c++) {
    const row: boolean[] = [];
    for (let r = rows - 1; r >= 0; r--) row.push(shape[r][c]);
    out.push(row);
  }
  return out;
}

/** All distinct clockwise rotations of a shape (1, 2, or 4) */
function rotations(shape: ShapeMatrix): ShapeMatrix[] {
  const seen = new Set<string>();
  const out: ShapeMatrix[] = [];
  let cur = shape;
  for (let i = 0; i < 4; i++) {
    const key = JSON.stringify(cur);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(cur);
    }
    cur = rotate90(cur);
  }
  return out;
}

function type(id: string, name: string, base: number[][], bagCount: number): PieceType {
  return { id, name, rotations: rotations(m(base)), bagCount };
}

/**
 * Bag composition leans toward fence material (lines and corners) with a
 * few awkward shapes (S, Z, T, square) to force creative walls.
 */
export const PIECE_TYPES: PieceType[] = [
  type('single',   'DOT',      [[1]], 1),
  type('domino',   'DOMINO',   [[1, 1]], 3),
  type('tri_line', 'BAR 3',    [[1, 1, 1]], 3),
  type('corner',   'CORNER',   [[1, 0], [1, 1]], 3),
  type('tet_line', 'BAR 4',    [[1, 1, 1, 1]], 2),
  type('l',        'L',        [[1, 0, 0], [1, 1, 1]], 2),
  type('j',        'J',        [[0, 0, 1], [1, 1, 1]], 2),
  type('t',        'T',        [[0, 1, 0], [1, 1, 1]], 1),
  type('s',        'S',        [[0, 1, 1], [1, 1, 0]], 1),
  type('z',        'Z',        [[1, 1, 0], [0, 1, 1]], 1),
  type('square',   'SQUARE',   [[1, 1], [1, 1]], 1),
  type('pent_line','BAR 5',    [[1, 1, 1, 1, 1]], 1),
  type('big_l',    'BIG L',    [[1, 0, 0], [1, 0, 0], [1, 1, 1]], 1),
  type('u',        'U',        [[1, 0, 1], [1, 1, 1]], 1),
];

const TYPE_BY_ID = new Map(PIECE_TYPES.map(t => [t.id, t]));

export function cellCount(shape: ShapeMatrix): number {
  let n = 0;
  for (const row of shape) for (const c of row) if (c) n++;
  return n;
}

export function makePiece(typeId: string, rotation: number, color: number): PieceInstance {
  const t = TYPE_BY_ID.get(typeId)!;
  const rot = ((rotation % t.rotations.length) + t.rotations.length) % t.rotations.length;
  const shape = t.rotations[rot];
  return { typeId, rotation: rot, shape, color, rows: shape.length, cols: shape[0].length };
}

/** Same piece, turned 90° clockwise */
export function rotatePiece(piece: PieceInstance, steps: number = 1): PieceInstance {
  return makePiece(piece.typeId, piece.rotation + steps, piece.color);
}

export function rotationCount(piece: PieceInstance): number {
  return TYPE_BY_ID.get(piece.typeId)!.rotations.length;
}

export function pieceName(piece: PieceInstance): string {
  return TYPE_BY_ID.get(piece.typeId)?.name ?? piece.typeId.toUpperCase();
}

/** Shuffled-bag dealer */
export class PieceBag {
  private bag: string[] = [];
  private lastColor = -1;

  next(): PieceInstance {
    if (this.bag.length === 0) this.refill();
    const typeId = this.bag.pop()!;
    const t = TYPE_BY_ID.get(typeId)!;
    const rotation = Math.floor(Math.random() * t.rotations.length);
    // Avoid two identical colors in a row so the hand reads clearly
    let color = Math.floor(Math.random() * PIECE_COLORS.length);
    if (color === this.lastColor) color = (color + 1) % PIECE_COLORS.length;
    this.lastColor = color;
    return makePiece(typeId, rotation, PIECE_COLORS[color]);
  }

  private refill(): void {
    const items: string[] = [];
    for (const t of PIECE_TYPES) for (let i = 0; i < t.bagCount; i++) items.push(t.id);
    // Fisher–Yates shuffle
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    this.bag = items;
  }
}
