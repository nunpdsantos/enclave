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
  /**
   * Echo walls orthogonally adjacent to the region: the part of its boundary
   * that is a ghost of a wall a claim already removed. Never overlaps `fence`
   * — there is no block here to knock down — but it is what makes the claim an
   * ECHO close.
   */
  echoCells: GridPos[];
  area: number;
}

/**
 * A fence cell a claim removed that still counts as a wall, for as long as it
 * lasts. `remaining / window` is how far through its life it is, which is all
 * a renderer needs to fade it.
 */
export interface EchoWall {
  row: number;
  col: number;
  /** Colour of the block that stood here, so the ghost reads as that wall */
  color: CellColor;
  remaining: number;
  window: number;
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
  /** Sum of area² × pointsPerAreaSquared, each room already scaled by its own territory factor */
  basePoints: number;
  /** Each room's share of basePoints, in region order, so popups can show what a room actually paid */
  roomPoints: number[];
  multiCloseMultiplier: number;
  streakMultiplier: number;
  /**
   * echo.multiplier when an echo wall bounded any of the claimed rooms, 1
   * otherwise. Applied last, inside the same floor() as the others.
   */
  echoMultiplier: number;
  /**
   * What the claim as a whole paid per unit of floor, 0.5–1: full for
   * all-new floor, relitFloorFactor for all-relit, and 1 whenever territory
   * is off. One number for the HUD; the per-room factors are already in
   * basePoints.
   */
  territoryFactor: number;
  turnScore: number;
}

export interface ScoreBreakdown extends ClaimPoints {
  totalScore: number;
}

/**
 * 'complete' is the Rationed Daily's happy ending: the budget ran out with
 * the last piece placed. It is not a death, and the score counts in full.
 */
export type RunEndCause = 'timeout' | 'board_lock' | 'quit' | 'complete';

// ── Replay: everything the server needs to re-play a run ──

/**
 * One recorded input.
 *
 * Rotations are not recorded on their own: a placement carries the rotation
 * index the piece was actually placed at, which is all a simulation needs to
 * turn the dealt piece to match, and it makes a spun-in-place fidget cost
 * nothing.
 *
 * `at` is `gameElapsed` in seconds, unrounded. It used to be rounded to the
 * millisecond, which was a millisecond of disagreement about the one rule
 * that reads a time: an echo wall expires at `gameElapsed + window`, and a
 * claim decided just inside that could re-play as a claim just outside it.
 * The simulation now assigns the recorded number to its own clock, so the
 * comparison is between bit-identical doubles on both sides.
 */
export type Move =
  | { t: 'p'; row: number; col: number; rot: number; at: number }
  | { t: 'h'; at: number };

/**
 * A run as a log: the deal it was dealt from, and every input that followed.
 * Score is deliberately absent — the whole point is that the server derives
 * it rather than being told it.
 */
export interface Replay {
  /** RULES_VERSION at recording time */
  rules: number;
  mode: Difficulty;
  seed: number;
  /** 'YYYY-MM-DD' of the daily this was dealt from; absent for free play */
  dailyKey?: string;
  moves: Move[];
  /**
   * The run outran MAX_REPLAY_MOVES, so the log stops short of the score and
   * can never be verified. Set rather than dropped, so the failure is a
   * stated fact rather than a replay that mysteriously ends early.
   */
  truncated?: boolean;
}

/**
 * The longest replay anyone records or the server accepts. Six hundred
 * placements is far past any real run — a 90-second Classic bank cannot fund
 * one — so the cap only ever bites a tab left running or a forged log, and it
 * is what stops a submission from becoming an unbounded upload.
 */
export const MAX_REPLAY_MOVES = 600;

export interface RunSummary {
  score: number;
  /** Which mode the run was played in — needed to read the score's tier */
  difficulty: Difficulty;
  /** The deal this run played. Same seed, same pieces, on any device. */
  seed: number;
  /** 'YYYY-MM-DD' of the daily this run belongs to; absent for free play */
  dailyKey?: string;
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
  /** Times the whole inner board was lit and reset */
  surveys: number;
  /** Inner cells still lit when the run ended, 0–INNER_CELLS */
  litCells: number;
  /**
   * The territory map as the run left it, so the share card can draw the
   * board the score was won on. A run whose last claim completed a survey
   * ends on a freshly reset map, which is the truthful picture of it.
   */
  litMap: boolean[][];
  /**
   * Empty cells that a single block would have closed a room on, counted at
   * the final board. What the run left on the table.
   */
  closingAtEnd: number;
  /** Pieces still undealt under a budget; 0 in the unbudgeted modes */
  piecesLeft: number;
  gameElapsed: number;
  /**
   * The score at each whole second of the run, index i being second i. Stored
   * for a personal best so the next run can be raced against its pace.
   */
  scoreTimeline: number[];
  previousBest: number;
  isNewBest: boolean;
  /** The run as the server can re-play it, which is what a score is worth */
  replay: Replay;
}

// ── Feedback event: the contract between core → rendering ──
export interface FeedbackEvent {
  type:
    | 'place'
    | 'claim'
    | 'gameOver'
    | 'newHand'
    | 'newBest'
    | 'survey'
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
  /** Lit inner cells once the event has been applied ('claim' and 'survey') */
  litCount?: number;
  /** Surveys completed this run, on 'survey' */
  surveys?: number;
  /** Flat score the survey just paid, on 'survey' */
  surveyBonus?: number;
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
