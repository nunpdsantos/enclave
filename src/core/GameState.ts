import { Board } from './Board';
import { PieceBag, rotatePiece } from './Pieces';
import { Difficulty, GameConfig, DEFAULT_CONFIG } from './Config';
import { getPersonalBest, recordPersonalBest } from './Settings';
import {
  PieceInstance, FeedbackEvent, ClaimResult, ScoreBreakdown, RunEndCause, RunSummary, GridPos,
} from './types';

/**
 * The run: board, hand (current piece), next queue, hold slot, clock, score.
 *
 * Everything here is pure game logic with no rendering. Scenes call
 * tryPlace / rotate / hold and react to the FeedbackEvents that come back.
 */
export class GameState {
  board: Board;
  current: PieceInstance | null = null;
  queue: PieceInstance[] = [];
  held: PieceInstance | null = null;
  /** Hold may be used once per piece (standard rule, prevents stalling) */
  holdUsed = false;

  score = 0;
  highScore = 0;
  streakCount = 0;
  movesSinceLastClaim = 0;
  isGameOver = false;
  deathCause: RunEndCause | null = null;

  timeRemaining = 0;
  pieceElapsed = 0;
  gameElapsed = 0;
  drainRate = 1;

  totalTurns = 0;
  claims = 0;
  cellsClaimed = 0;
  biggestRoom = 0;
  doubleCloses = 0;
  maxStreak = 0;
  newBestReached = false;

  private bag = new PieceBag();
  readonly config: GameConfig;
  readonly difficulty: Difficulty;

  constructor(config: GameConfig = DEFAULT_CONFIG, difficulty: Difficulty = 'classic') {
    this.config = config;
    this.difficulty = difficulty;
    this.board = new Board();
    this.highScore = getPersonalBest(difficulty);
  }

  get maxTime(): number {
    return this.config.timer.maxSeconds;
  }

  /** 1.0 right after a placement, decaying to minSpeedFraction */
  get currentSpeedFraction(): number {
    const { speedWindowSeconds, minSpeedFraction } = this.config.timer;
    const t = Math.min(this.pieceElapsed / speedWindowSeconds, 1);
    return 1 - (1 - minSpeedFraction) * t;
  }

  get streakSafeMoves(): number {
    if (this.streakCount <= 0) return 0;
    return Math.max(0, this.config.scoring.streakWindow - this.movesSinceLastClaim);
  }

  get streakMultiplier(): number {
    const s = this.config.scoring;
    return Math.min(1 + this.streakCount * s.streakIncrement, s.streakCap);
  }

  start(): FeedbackEvent {
    this.board.reset();
    this.bag = new PieceBag();
    this.score = 0;
    this.streakCount = 0;
    this.movesSinceLastClaim = 0;
    this.isGameOver = false;
    this.deathCause = null;
    this.timeRemaining = this.config.timer.startSeconds;
    this.pieceElapsed = 0;
    this.gameElapsed = 0;
    this.drainRate = 1;
    this.totalTurns = 0;
    this.claims = 0;
    this.cellsClaimed = 0;
    this.biggestRoom = 0;
    this.doubleCloses = 0;
    this.maxStreak = 0;
    this.newBestReached = false;
    this.held = null;
    this.holdUsed = false;
    this.highScore = getPersonalBest(this.difficulty);

    // Deal the hand plus exactly previewCount upcoming pieces
    this.current = this.bag.next();
    this.queue = [];
    for (let i = 0; i < this.config.previewCount; i++) this.queue.push(this.bag.next());
    return { type: 'newHand' };
  }

  /** Tick the clock. Returns true if time ran out. */
  tick(dt: number): boolean {
    if (this.isGameOver) return false;
    this.pieceElapsed += dt;
    this.gameElapsed += dt;
    const t = this.config.timer;
    this.drainRate = Math.min(t.drainCap, 1 + (this.gameElapsed / 60) * t.drainAccelPerMinute);
    this.timeRemaining = Math.max(0, this.timeRemaining - dt * this.drainRate);
    if (this.timeRemaining <= 0) {
      this.isGameOver = true;
      this.deathCause = 'timeout';
      this.finalizeBest();
      return true;
    }
    return false;
  }

  addTime(seconds: number): void {
    this.timeRemaining = Math.min(this.timeRemaining + seconds, this.config.timer.maxSeconds);
  }

  /** Rotate the piece in hand */
  rotate(steps: number = 1): void {
    if (!this.current || this.isGameOver) return;
    this.current = rotatePiece(this.current, steps);
  }

  /** Swap the hand with the hold slot (once per piece) */
  hold(): FeedbackEvent[] {
    if (!this.current || this.isGameOver || this.holdUsed) return [];
    const events: FeedbackEvent[] = [];
    const outgoing = this.current;
    if (this.held) {
      this.current = this.held;
    } else {
      this.current = this.queue.shift()!;
      this.queue.push(this.bag.next());
    }
    this.held = outgoing;
    this.holdUsed = true;
    events.push({ type: 'hold' });
    events.push({ type: 'newHand' });
    if (this.checkGameOver()) {
      this.isGameOver = true;
      this.deathCause = 'board_lock';
      this.finalizeBest();
      events.push({ type: 'gameOver' });
    }
    return events;
  }

  /** True if the current piece fits somewhere in any rotation */
  canPlaceCurrentAnywhere(): boolean {
    if (!this.current) return false;
    return this.fitsAnyRotation(this.current);
  }

  private fitsAnyRotation(piece: PieceInstance): boolean {
    let p = piece;
    for (let i = 0; i < 4; i++) {
      if (this.board.canPlaceAnywhere(p.shape)) return true;
      p = rotatePiece(p);
    }
    return false;
  }

  /** Attempt to place the current piece at (row, col) */
  tryPlace(row: number, col: number): FeedbackEvent[] {
    const events: FeedbackEvent[] = [];
    const piece = this.current;
    if (!piece || this.isGameOver) return events;
    if (!this.board.canPlace(piece.shape, row, col)) return events;

    this.totalTurns++;
    const placedCells = this.board.place(piece.shape, row, col, piece.color);
    const speedFraction = this.currentSpeedFraction;
    this.pieceElapsed = 0;
    events.push({ type: 'place', placedCells, pieceColor: piece.color, speedFraction });

    // Placement points
    this.score += placedCells.length * this.config.scoring.pointsPerBlockPlaced;

    // Detect and resolve enclosures
    const regions = this.board.findEnclosures();
    let claim: ClaimResult | null = null;
    if (regions.length > 0) {
      const fenceSet = new Set<string>();
      const fenceCleared: GridPos[] = [];
      for (const r of regions) {
        for (const f of r.fence) {
          const key = `${f.row},${f.col}`;
          if (!fenceSet.has(key)) {
            fenceSet.add(key);
            fenceCleared.push(f);
          }
        }
      }
      const fenceColors = this.board.clearCells(fenceCleared);
      claim = {
        regions,
        totalArea: regions.reduce((a, r) => a + r.area, 0),
        fenceCleared,
        fenceColors,
      };
    }

    // Streak bookkeeping BEFORE scoring so the multiplier reflects the run-up
    if (claim) {
      this.movesSinceLastClaim = 0;
    } else {
      this.movesSinceLastClaim++;
      if (this.movesSinceLastClaim >= this.config.scoring.streakWindow && this.streakCount > 0) {
        if (this.streakCount >= 3) events[0].streakBroken = true;
        this.streakCount = 0;
      }
    }

    // Time bonus
    const t = this.config.timer;
    let bonus = t.placeBonus;
    if (claim) {
      bonus += Math.min(t.claimBonusCap, t.claimBaseBonus + t.claimPerCellBonus * claim.totalArea);
    }
    const timeBonus = Math.round(bonus * speedFraction * 10) / 10;
    this.addTime(timeBonus);
    events[0].timeBonus = timeBonus;

    // Claim scoring
    if (claim) {
      const s = this.config.scoring;
      const basePoints = claim.regions.reduce((a, r) => a + r.area * r.area * s.pointsPerAreaSquared, 0);
      const multiCloseMultiplier = 1 + s.multiCloseBonusPerRoom * (claim.regions.length - 1);
      const streakMultiplier = this.streakMultiplier;
      const turnScore = Math.floor(basePoints * multiCloseMultiplier * streakMultiplier);
      this.score += turnScore;

      this.streakCount++;
      this.maxStreak = Math.max(this.maxStreak, this.streakCount);
      this.claims++;
      this.cellsClaimed += claim.totalArea;
      for (const r of claim.regions) this.biggestRoom = Math.max(this.biggestRoom, r.area);
      if (claim.regions.length >= 2) this.doubleCloses++;

      const breakdown: ScoreBreakdown = {
        basePoints, multiCloseMultiplier, streakMultiplier, turnScore, totalScore: this.score,
      };
      events.push({
        type: 'claim',
        claim,
        scoreBreakdown: breakdown,
        streakCount: this.streakCount,
        timeBonus,
      });
    }

    // Personal best crossed?
    if (!this.newBestReached && this.highScore > 0 && this.score > this.highScore) {
      this.newBestReached = true;
      events.push({ type: 'newBest', previousBest: this.highScore });
    }

    // Deal the next piece
    this.current = this.queue.shift()!;
    this.queue.push(this.bag.next());
    this.holdUsed = false;
    events.push({ type: 'newHand' });

    // Game over: nothing fits, even after a hold swap
    if (this.checkGameOver()) {
      this.isGameOver = true;
      this.deathCause = 'board_lock';
      this.finalizeBest();
      events.push({ type: 'gameOver' });
    }

    return events;
  }

  private checkGameOver(): boolean {
    if (this.current && this.fitsAnyRotation(this.current)) return false;
    // A hold swap could rescue the player
    if (!this.holdUsed) {
      const alt = this.held ?? this.queue[0];
      if (alt && this.fitsAnyRotation(alt)) return false;
    }
    return true;
  }

  finalizeBest(): void {
    recordPersonalBest(this.difficulty, this.score);
  }

  buildRunSummary(endCauseOverride?: RunEndCause): RunSummary {
    if (endCauseOverride === 'quit') this.finalizeBest();
    return {
      score: this.score,
      endCause: endCauseOverride ?? this.deathCause ?? 'board_lock',
      totalTurns: this.totalTurns,
      claims: this.claims,
      cellsClaimed: this.cellsClaimed,
      biggestRoom: this.biggestRoom,
      doubleCloses: this.doubleCloses,
      maxStreak: this.maxStreak,
      gameElapsed: this.gameElapsed,
      previousBest: this.highScore,
      isNewBest: this.score > this.highScore,
    };
  }
}
