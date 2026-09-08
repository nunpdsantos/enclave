import { Difficulty } from './Config';

// ── Grid ──
export const GRID_SIZE = 9;

export type CellColor = number;
export type Grid = (CellColor | null)[][];

// ── Piece shape ──
export type ShapeMatrix = boolean[][];

export interface PieceType {
  id: string;
  /** Display name */
  name: string;
  /** All distinct rotations, in clockwise order */
  rotations: ShapeMatrix[];
  /** How many copies go into each bag */
  bagCount: number;
}

// ── Piece instance (in hand, hold, queue, or being dragged) ──
export interface PieceInstance {
  typeId: string;
  rotation: number;
  shape: ShapeMatrix;
  color: CellColor;
  rows: number;
  cols: number;
}

// ── Grid coordinate ──
export interface GridPos {
  row: number;
  col: number;
}

/** An enclosed region of empty cells, fully surrounded by blocks */
export interface Region {
  /** Empty cells inside the fence */
  cells: GridPos[];
  /** Blocks orthogonally adjacent to the region: the fence */
  fence: GridPos[];
  area: number;
}

/** Result of one placement */
export interface ClaimResult {
  regions: Region[];
  totalArea: number;
  /** Fence blocks removed (deduplicated across regions) */
  fenceCleared: GridPos[];
  fenceColors: CellColor[];
}

/**
 * What sealing a set of rooms is worth right now. Split out of
 * ScoreBreakdown so the drag preview can price a hypothetical claim with
 * the same code that pays the real one.
 */
export interface ClaimPoints {
  /** Sum of area² × pointsPerAreaSquared */
  basePoints: number;
  multiCloseMultiplier: number;
  streakMultiplier: number;
  turnScore: number;
}

export interface ScoreBreakdown extends ClaimPoints {
  totalScore: number;
}

export type RunEndCause = 'timeout' | 'board_lock' | 'quit';

export interface RunSummary {
  score: number;
  /** Which mode the run was played in — needed to read the score's tier */
  difficulty: Difficulty;
  endCause: RunEndCause;
  totalTurns: number;
  claims: number;
  cellsClaimed: number;
  /** Rooms sealed, which is >= claims because one piece can close several */
  roomsClaimed: number;
  biggestRoom: number;
  /** Room area → how many rooms of that area were sealed */
  roomSizes: Record<number, number>;
  doubleCloses: number;
  maxStreak: number;
  /** How many times the hold slot was used */
  holds: number;
  gameElapsed: number;
  previousBest: number;
  isNewBest: boolean;
}

// ── Feedback event: the contract between core → rendering ──
export interface FeedbackEvent {
  type:
    | 'place'
    | 'claim'
    | 'gameOver'
    | 'newHand'
    | 'newBest'
    | 'hold';
  placedCells?: GridPos[];
  pieceColor?: CellColor;
  claim?: ClaimResult;
  scoreBreakdown?: ScoreBreakdown;
  streakCount?: number;
  timeBonus?: number;
  speedFraction?: number;
  streakBroken?: boolean;
  previousBest?: number;
}

// ── Palette — bold and saturated ──
export const PIECE_COLORS: number[] = [
  0x4b7bec, // blue
  0xe8913a, // orange
  0xd65db1, // pink
  0x8854d0, // purple
  0xd64545, // red
  0x20bf6b, // green
  0x45aaf2, // light blue
  0xf7b731, // yellow
];

/**
 * High-contrast palette — the Okabe–Ito set, which stays distinguishable
 * under deuteranopia, protanopia and tritanopia. Okabe–Ito's eighth colour is
 * black, which would disappear against the board, so light grey takes its
 * place. Same length and same order semantics as PIECE_COLORS, so a colour
 * can be remapped index-to-index between the two.
 */
export const HIGH_CONTRAST_PIECE_COLORS: number[] = [
  0xe69f00, // orange
  0x56b4e9, // sky blue
  0x009e73, // bluish green
  0xf0e442, // yellow
  0x0072b2, // blue
  0xd55e00, // vermilion
  0xcc79a7, // reddish purple
  0xe5e5e5, // light grey
];
