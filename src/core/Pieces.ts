import { getPiecePalette } from './Accessibility';
import { Rng } from './Random';
import { PieceInstance, PieceType, ShapeMatrix } from './types';

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
 *
 * Dealing is seeded: the bag takes an RNG and uses it for the shuffle, the
 * rotation AND the colour, so the same seed hands two devices the same pieces
 * turned the same way in the same colours. The default RNG is `Math.random`,
 * which leaves free play statistically where it was.
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

/**
 * Shuffled-bag dealer.
 *
 * `rng` seeds the whole deal. `limit` caps how many pieces the bag will ever
 * hand out — the Rationed Daily's budget — after which `next()` returns null
 * and the queue simply runs dry. With no limit the bag refills forever, which
 * is what Classic and Blitz have always done.
 */
export class PieceBag {
  private bag: string[] = [];
  private lastColor = -1;
  private dealt = 0;
  private readonly rng: Rng;
  private readonly limit: number;

  constructor(rng: Rng = Math.random, limit?: number) {
    this.rng = rng;
    this.limit = limit ?? Infinity;
  }

  /** Pieces this bag can still deal. Infinity when there is no budget. */
  get remaining(): number {
    return this.limit - this.dealt;
  }

  next(): PieceInstance | null {
    if (this.dealt >= this.limit) return null;
    if (this.bag.length === 0) this.refill();
    const typeId = this.bag.pop()!;
    const t = TYPE_BY_ID.get(typeId)!;
    const rotation = Math.floor(this.rng() * t.rotations.length);
    // Read the palette at deal time so a colour setting applies to new pieces
    const palette = getPiecePalette();
    // Avoid two identical colors in a row so the hand reads clearly
    let color = Math.floor(this.rng() * palette.length);
    if (color === this.lastColor) color = (color + 1) % palette.length;
    this.lastColor = color;
    this.dealt++;
    return makePiece(typeId, rotation, palette[color]);
  }

  private refill(): void {
    const items: string[] = [];
    for (const t of PIECE_TYPES) for (let i = 0; i < t.bagCount; i++) items.push(t.id);
    // Fisher–Yates shuffle
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    this.bag = items;
  }
}
