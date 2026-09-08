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

export interface ScoreBreakdown {
  /** Sum of area² × pointsPerAreaSquared */
  basePoints: number;
  multiCloseMultiplier: number;
  streakMultiplier: number;
  turnScore: number;
  totalScore: number;
}

export type RunEndCause = 'timeout' | 'board_lock' | 'quit';

export interface RunSummary {
  score: number;
  endCause: RunEndCause;
  totalTurns: number;
  claims: number;
  cellsClaimed: number;
  biggestRoom: number;
  doubleCloses: number;
  maxStreak: number;
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
