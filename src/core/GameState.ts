import { Board, INNER_CELLS } from './Board';
import { PieceBag, rotatePiece } from './Pieces';
import { Difficulty, GameConfig, TerritoryConfig, DEFAULT_CONFIG } from './Config';
import { dailyKey, dailySeed } from './Daily';
import { getProgressStatus } from './Progression';
import { mulberry32, randomSeed } from './Random';
import { RULES_VERSION } from './Rules';
import { getPersonalBest, recordPbTimeline, recordPersonalBest } from './Settings';
import {
  PieceInstance, FeedbackEvent, ClaimResult, ClaimPoints, ScoreBreakdown, Region,
  RunEndCause, RunSummary, GridPos, CellColor, EchoWall, Move, Replay, MAX_REPLAY_MOVES,
} from './types';

/** A cell the echo window is holding, and when it stops holding it */
interface TimedCell {
  row: number;
  col: number;
  expiresAt: number;
}

interface EchoRecord extends TimedCell {
  /** The block that stood here, so the ghost is drawn as that wall */
  color: CellColor;
}

function cellKey(p: GridPos): string {
  return `${p.row},${p.col}`;
}

/**
 * How many seconds of a run the score timeline keeps. Fifteen minutes is far
 * past any survivable Classic run, and the cap is what stops a tab left open
 * on a paused game from growing an unbounded array.
 */
const TIMELINE_CAP = 900;

/**
 * What a stretch of floor is worth: full price for ground never claimed,
 * relitFloorFactor for ground claimed before, pro rata in between.
 */
function territoryFactorOf(t: TerritoryConfig, fresh: number, area: number): number {
  if (!t.enabled || area <= 0) return 1;
  return t.relitFloorFactor + (1 - t.relitFloorFactor) * (fresh / area);
}

/**
 * area² × pointsPerAreaSquared × territoryFactor, with the division by area
 * cancelled off. Algebraically the same number, but an exact one: written the
 * obvious way, a 7-cell room on 2 fresh cells lands on 314.99999999999994 and
 * the floor() at the end of the claim quietly eats the point.
 */
function roomBasePoints(t: TerritoryConfig, pointsPerAreaSquared: number, area: number, fresh: number): number {
  if (!t.enabled) return area * area * pointsPerAreaSquared;
  const f = t.relitFloorFactor;
  return area * pointsPerAreaSquared * (f * area + (1 - f) * fresh);
}

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
  /**
   * The score at each whole second of the run, index i being second i.
   *
   * Sampled off the game clock rather than off placements, because what it
   * feeds is a pace line: the ghost of a past run has to keep moving while
   * this one is still thinking about where the piece goes.
   */
  scoreTimeline: number[] = [];

  totalTurns = 0;
  claims = 0;
  cellsClaimed = 0;
  /** Rooms sealed. Higher than `claims` when one piece closes several at once. */
  roomsClaimed = 0;
  biggestRoom = 0;
  /** Room area → count. Feeds the telemetry histogram used to tune the clock. */
  roomSizes: Record<number, number> = {};
  doubleCloses = 0;
  maxStreak = 0;
  /** Hold-slot swaps this run */
  holds = 0;
  /** Times every inner cell was lit, which banks the bonus and wipes the map */
  surveys = 0;
  newBestReached = false;

  /**
   * Echo walls: a fence a claim removed goes on holding the flood back until
   * it fades, which is what makes closing the room next door a combo rather
   * than a punishment. The set has two halves, both on the same clock:
   *
   *  - `echoes` are the removed blocks. They are drawn, fading, in the colour
   *    of the block that stood there, and a room they bound pays the ECHO
   *    multiplier.
   *  - `spentFloor` is the floor the claim just took. It is never drawn and
   *    never worth anything: it is solid only so the room a claim emptied
   *    cannot immediately re-close itself off its own ghost walls. With both
   *    halves standing, a claim's footprint holds exactly the shape it had
   *    before the claim, so nothing outside the footprint changes either.
   */
  private echoes: EchoRecord[] = [];
  private spentFloor: TimedCell[] = [];
  /**
   * Bumped whenever the echo set changes — add, consume or expire. The hints
   * and the drag preview are computed against that set, so a view polls this
   * to know when its answers went stale, without recomputing per frame.
   */
  echoVersion = 0;

  /** The deal this run is playing. Fixed by the date for the daily. */
  seed = 0;
  /** 'YYYY-MM-DD' of the daily being played, or null outside the daily */
  dailyDate: string | null = null;

  /**
   * Every input of the run, in order, so the server can re-play it from the
   * seed and arrive at the same score instead of taking the client's word.
   */
  moves: Move[] = [];
  /** The run outran the cap: the log is short, so the score cannot be proved */
  private movesTruncated = false;

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

  /**
   * 1.0 right after a placement, decaying to minSpeedFraction.
   *
   * With no clock there is no reward for hurrying, so it is flat 1 — which
   * also keeps the HUD off a fraction that would mean nothing.
   */
  get currentSpeedFraction(): number {
    if (!this.config.clock.enabled) return 1;
    const { speedWindowSeconds, minSpeedFraction } = this.config.timer;
    const t = Math.min(this.pieceElapsed / speedWindowSeconds, 1);
    return 1 - (1 - minSpeedFraction) * t;
  }

  /**
   * Pieces this run has left to play: the hand, the hold slot, the queue and
   * whatever the bag can still deal. Starts at the budget, ends at zero, so
   * "PIECES 17/30" means seventeen more placements are possible.
   */
  get piecesRemaining(): number {
    const undealt = this.bag.remaining;
    const inPlay = (this.current ? 1 : 0) + (this.held ? 1 : 0) + this.queue.length;
    return Number.isFinite(undealt) ? undealt + inPlay : Infinity;
  }

  // ── Echo walls ──

  /** 'row,col' of every cell the echo window is currently holding as a wall */
  activeEchoKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const e of this.echoes) keys.add(cellKey(e));
    for (const s of this.spentFloor) keys.add(cellKey(s));
    return keys;
  }

  /** The echo walls to draw, with how much of their window each has left */
  echoWalls(): EchoWall[] {
    const window = this.config.echo.windowSeconds;
    return this.echoes.map(e => ({
      row: e.row,
      col: e.col,
      color: e.color,
      remaining: Math.max(0, e.expiresAt - this.gameElapsed),
      window,
    }));
  }

  /**
   * The rooms a board would pay for right now, echo walls standing. The
   * placement and the drag preview both come through here, so a preview
   * cannot quote a room the placement would then refuse.
   *
   * Two kinds of region are refused, and neither can exist outside an echo
   * window. A room with no block at all in its fence is held up by ghosts
   * alone: the player built nothing and there is nothing to knock down. And a
   * room bounded by spent floor is closing against something invisible — the
   * ghost walls can be seen fading, the floor under them cannot.
   *
   * Both catch the same shape of accident: the gap a claim leaves behind can
   * seal itself when a neighbouring claim eats the wall between them.
   */
  claimableRegions(board: Board): Region[] {
    const regions = board.findEnclosures(this.activeEchoKeys());
    if (this.echoes.length === 0 && this.spentFloor.length === 0) return regions;
    const spent = new Set(this.spentFloor.map(cellKey));
    return regions.filter(r =>
      r.fence.length > 0 && !r.echoCells.some(c => spent.has(cellKey(c))),
    );
  }

  /**
   * Keep only the echo cells the predicate accepts, across both halves of the
   * set, and bump the version if the set actually moved.
   */
  private filterEchoes(keep: (cell: TimedCell) => boolean): void {
    if (this.echoes.length === 0 && this.spentFloor.length === 0) return;
    const echoes = this.echoes.filter(keep);
    const spentFloor = this.spentFloor.filter(keep);
    if (echoes.length === this.echoes.length && spentFloor.length === this.spentFloor.length) return;
    this.echoes = echoes;
    this.spentFloor = spentFloor;
    this.echoVersion++;
  }

  /**
   * The echo bookkeeping for one claim: the ghost walls it just spent are
   * gone, and the fence it just removed becomes the next set of ghosts.
   *
   * Consuming first matters — otherwise the fence this claim is echoing would
   * be swept straight back out again by its own rooms' `echoCells`.
   */
  private recordEcho(claim: ClaimResult): void {
    const used = new Set<string>();
    for (const r of claim.regions) for (const e of r.echoCells) used.add(cellKey(e));
    if (used.size > 0) this.filterEchoes(c => !used.has(cellKey(c)));

    const echo = this.config.echo;
    if (!echo.enabled) return;
    const expiresAt = this.gameElapsed + echo.windowSeconds;
    for (let i = 0; i < claim.fenceCleared.length; i++) {
      const cell = claim.fenceCleared[i];
      this.echoes.push({ row: cell.row, col: cell.col, color: claim.fenceColors[i] ?? 0xffffff, expiresAt });
    }
    for (const r of claim.regions) {
      for (const cell of r.cells) this.spentFloor.push({ row: cell.row, col: cell.col, expiresAt });
    }
    this.echoVersion++;
  }

  /**
   * Log one input. Past the cap the run goes on exactly as before and only
   * the log stops: a player who somehow gets there is still playing, they
   * just cannot prove the score afterwards.
   *
   * `at` goes in as the full double `gameElapsed` is, never rounded. The
   * echo window is decided by comparing `expiresAt` against the clock, and
   * `expiresAt` is itself `gameElapsed + window`: round the recorded time to
   * the millisecond and a claim taken a few microseconds inside a ghost wall
   * re-plays on the server as a claim taken a few microseconds outside it,
   * for a different score. Full precision costs about 4 KB on a
   * six-hundred-move log and removes the disagreement entirely.
   */
  private record(move: Move): void {
    if (this.moves.length < MAX_REPLAY_MOVES) this.moves.push(move);
    else this.movesTruncated = true;
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
    // Which day this run belongs to. The server's date when a run ticket
    // supplied one — a device clock a few hours out must not deal itself
    // yesterday's puzzle — and this browser's UTC date otherwise, which is
    // the offline practice case.
    this.dailyDate = this.difficulty === 'daily'
      ? (this.config.dailyDate ?? dailyKey())
      : null;
    // The deal. A run that got a ticket carries the server's seed in its
    // config and uses that, which is the only deal a score can be posted
    // from. Without one the run is practice: the daily falls back to the
    // public date hash and free play to a throwaway, and neither can be
    // submitted, because neither has a ticket to submit it with.
    this.seed = this.config.seed
      ?? (this.dailyDate !== null ? dailySeed(this.dailyDate) : randomSeed());
    this.bag = new PieceBag(mulberry32(this.seed), this.config.pieceBudget);
    this.score = 0;
    this.streakCount = 0;
    this.movesSinceLastClaim = 0;
    this.isGameOver = false;
    this.deathCause = null;
    this.timeRemaining = this.config.timer.startSeconds;
    this.pieceElapsed = 0;
    this.gameElapsed = 0;
    this.drainRate = 1;
    this.scoreTimeline = [];
    this.totalTurns = 0;
    this.claims = 0;
    this.cellsClaimed = 0;
    this.roomsClaimed = 0;
    this.biggestRoom = 0;
    this.roomSizes = {};
    this.doubleCloses = 0;
    this.maxStreak = 0;
    this.holds = 0;
    this.surveys = 0;
    this.newBestReached = false;
    this.held = null;
    this.holdUsed = false;
    this.echoes = [];
    this.spentFloor = [];
    this.echoVersion++;
    this.moves = [];
    this.movesTruncated = false;
    this.highScore = getPersonalBest(this.difficulty, this.dailyDate ?? undefined);

    // Deal the hand plus up to previewCount upcoming pieces. Under a budget
    // the bag can run dry, and the queue is simply shorter than the preview.
    this.syncBagTier();
    this.current = this.bag.next();
    this.queue = [];
    for (let i = 0; i < this.config.previewCount; i++) {
      const piece = this.bag.next();
      if (!piece) break;
      this.queue.push(piece);
    }
    return { type: 'newHand' };
  }

  /**
   * Age the run by `dt` without draining anything: the clocks, the echo
   * walls and the score timeline, and nothing that can end the run.
   *
   * `tick` is this plus the drain, so live play has one code path. The
   * replay simulation calls it directly, because the server cannot reproduce
   * a client's per-frame drain and reconstructs the bank analytically
   * instead (see Replay.ts) — but it must reproduce the echo window exactly,
   * since that is what decides whether a claim pays the ECHO multiplier.
   */
  advanceClock(dt: number): void {
    if (this.isGameOver) return;
    this.pieceElapsed += dt;
    this.gameElapsed += dt;
    this.sampleTimeline();
    // Echo walls run on the game clock, not on placements, so this is the one
    // place they can fade out.
    this.filterEchoes(c => c.expiresAt > this.gameElapsed);
  }

  /**
   * Age the run to an absolute `gameElapsed`, rather than by a delta.
   *
   * This exists for the replay simulation, and the difference is the whole
   * point of it. A browser reaches a move's time by adding up frames; a
   * simulation reaching it by adding up the gaps between moves lands on a
   * double a few bits away. Every echo wall's `expiresAt` is
   * `gameElapsed + windowSeconds`, and whether a claim pays the ECHO
   * multiplier is `expiresAt > gameElapsed` — so a few bits is the whole
   * difference between two scores. Assigning the recorded time makes both
   * sides compare the same two numbers.
   *
   * Never runs backwards: a move that claims to be earlier than the clock is
   * the caller's to refuse, and silently rewinding one would un-expire the
   * echo walls that have already been swept.
   */
  advanceClockTo(elapsed: number): void {
    if (this.isGameOver) return;
    if (!(elapsed > this.gameElapsed)) return;
    this.pieceElapsed += elapsed - this.gameElapsed;
    this.gameElapsed = elapsed;
    this.sampleTimeline();
    this.filterEchoes(c => c.expiresAt > this.gameElapsed);
  }

  /** Tick the clock. Returns true if time ran out. */
  tick(dt: number): boolean {
    if (this.isGameOver) return false;
    this.advanceClock(dt);
    // No clock: the run still ages (telemetry wants a duration) but nothing
    // drains and nothing can time out.
    if (!this.config.clock.enabled) return false;
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

  /**
   * One score sample per whole second. The loop fills every second a long
   * frame stepped over, so index i is always second i — a backgrounded tab
   * must not shift the whole curve left.
   */
  private sampleTimeline(): void {
    const second = Math.floor(this.gameElapsed);
    while (this.scoreTimeline.length <= second && this.scoreTimeline.length < TIMELINE_CAP) {
      this.scoreTimeline.push(this.score);
    }
  }

  addTime(seconds: number): void {
    if (!this.config.clock.enabled) return;
    this.timeRemaining = Math.min(this.timeRemaining + seconds, this.config.timer.maxSeconds);
  }

  /** Rotate the piece in hand */
  rotate(steps: number = 1): void {
    if (!this.current || this.isGameOver) return;
    this.current = rotatePiece(this.current, steps);
  }

  /**
   * Swap the hand with the hold slot (once per piece).
   *
   * A swap costs no budget: parking a piece and taking the next one deals
   * nothing new. The one refusal is parking with an empty hold and an empty
   * queue — the last piece of a rationed run would go into the slot and leave
   * the hand with nothing to place.
   */
  hold(): FeedbackEvent[] {
    if (!this.current || this.isGameOver || this.holdUsed) return [];
    if (!this.held && this.queue.length === 0) return [];
    const events: FeedbackEvent[] = [];
    const outgoing = this.current;
    if (this.held) {
      this.current = this.held;
    } else {
      this.current = this.queue.shift()!;
      const dealt = this.bag.next();
      if (dealt) this.queue.push(dealt);
    }
    this.held = outgoing;
    this.holdUsed = true;
    this.holds++;
    this.record({ t: 'h', at: this.gameElapsed });
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

  /**
   * What sealing these rooms is worth, at the streak the run is on now.
   *
   * Pure: it reads state but changes none, so the drag preview can ask the
   * same question the placement will answer and the two cannot drift. That
   * includes the territory factor — the lit map only moves once the claim is
   * actually paid, so pricing a hypothesis reads the same floor.
   */
  claimPoints(regions: Region[]): ClaimPoints {
    const s = this.config.scoring;
    const t = this.config.territory;
    let basePoints = 0;
    let totalArea = 0;
    let totalFresh = 0;
    const roomPoints: number[] = [];
    for (const r of regions) {
      const fresh = t.enabled ? this.board.freshCount(r.cells) : r.area;
      const pts = roomBasePoints(t, s.pointsPerAreaSquared, r.area, fresh);
      roomPoints.push(pts);
      basePoints += pts;
      totalArea += r.area;
      totalFresh += fresh;
    }
    const territoryFactor = territoryFactorOf(t, totalFresh, totalArea);
    const multiCloseMultiplier = 1 + s.multiCloseBonusPerRoom * (regions.length - 1);
    const streakMultiplier = this.streakMultiplier;
    // The echo bonus is a property of the rooms themselves — one of them was
    // bounded by a ghost wall — so a preview reading the same regions prices
    // it identically without knowing anything about the live echo set.
    const echoUsed = this.config.echo.enabled && regions.some(r => r.echoCells.length > 0);
    const echoMultiplier = echoUsed ? this.config.echo.multiplier : 1;
    const turnScore = Math.floor(basePoints * multiCloseMultiplier * streakMultiplier * echoMultiplier);
    return {
      basePoints, roomPoints, multiCloseMultiplier, streakMultiplier, echoMultiplier,
      territoryFactor, turnScore,
    };
  }

  /**
   * Point the bag at the tier the score has reached. Cheap by design — it
   * records an index and nothing else, and the mix changes at the next refill,
   * never mid-bag — so calling it after every score change costs nothing.
   */
  private syncBagTier(): void {
    if (!this.config.bagByTier) return;
    this.bag.setTier(getProgressStatus(this.difficulty, this.score).tierIndex);
  }

  /** Attempt to place the current piece at (row, col) */
  tryPlace(row: number, col: number): FeedbackEvent[] {
    const events: FeedbackEvent[] = [];
    const piece = this.current;
    if (!piece || this.isGameOver) return events;
    if (!this.board.canPlace(piece.shape, row, col)) return events;

    this.totalTurns++;
    // Recorded before anything is scored: what the log has to carry is the
    // input, and the rules turn that into a score on both sides.
    this.record({ t: 'p', row, col, rot: piece.rotation, at: this.gameElapsed });
    const placedCells = this.board.place(piece.shape, row, col, piece.color);
    // An echo wall is empty ground: a piece may land on one, and then it is a
    // real block again rather than a block and a ghost in the same cell.
    const covered = new Set(placedCells.map(cellKey));
    this.filterEchoes(c => !covered.has(cellKey(c)));
    const speedFraction = this.currentSpeedFraction;
    this.pieceElapsed = 0;
    events.push({ type: 'place', placedCells, pieceColor: piece.color, speedFraction });

    // Placement points
    this.score += placedCells.length * this.config.scoring.pointsPerBlockPlaced;

    // Detect and resolve enclosures, echo walls counting as walls
    const regions = this.claimableRegions(this.board);
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
      this.recordEcho(claim);
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

    // Time bonus. Nothing to bank without a clock, so it is not even quoted.
    const t = this.config.timer;
    let bonus = t.placeBonus;
    if (claim) {
      bonus += Math.min(t.claimBonusCap, t.claimBaseBonus + t.claimPerCellBonus * claim.totalArea);
    }
    const timeBonus = this.config.clock.enabled ? Math.round(bonus * speedFraction * 10) / 10 : 0;
    this.addTime(timeBonus);
    events[0].timeBonus = timeBonus;

    // Claim scoring — same method the drag preview quotes. The territory
    // factor is read before the floor is lit, so a room is priced against the
    // map the player was looking at.
    if (claim) {
      const points = this.claimPoints(claim.regions);
      this.score += points.turnScore;

      this.streakCount++;
      this.maxStreak = Math.max(this.maxStreak, this.streakCount);
      this.claims++;
      this.cellsClaimed += claim.totalArea;
      this.roomsClaimed += claim.regions.length;
      for (const r of claim.regions) {
        this.biggestRoom = Math.max(this.biggestRoom, r.area);
        this.roomSizes[r.area] = (this.roomSizes[r.area] ?? 0) + 1;
      }
      if (claim.regions.length >= 2) this.doubleCloses++;

      const surveyed = this.markTerritory(claim.regions);

      const breakdown: ScoreBreakdown = { ...points, totalScore: this.score };
      events.push({
        type: 'claim',
        claim,
        scoreBreakdown: breakdown,
        streakCount: this.streakCount,
        timeBonus,
        litCount: this.board.litCount(),
      });
      if (surveyed) {
        events.push({
          type: 'survey',
          surveys: this.surveys,
          surveyBonus: this.config.territory.surveyBonus,
          litCount: 0,
        });
      }
    }

    // Personal best crossed?
    if (!this.newBestReached && this.highScore > 0 && this.score > this.highScore) {
      this.newBestReached = true;
      events.push({ type: 'newBest', previousBest: this.highScore });
    }

    // Every score change this placement could make — the blocks, the claim
    // and the survey — has landed, so one sync here keeps the bag on tier.
    this.syncBagTier();

    // Deal the next piece. Under a budget both the queue and the bag can be
    // empty, and then the hold slot is the last place a piece can come from:
    // a ration parked early has to come back out, or holding once would
    // quietly cost the run its thirtieth placement. The run is finished only
    // when the hand and the hold slot are both empty.
    this.current = this.queue.shift() ?? null;
    if (!this.current && this.held) {
      this.current = this.held;
      this.held = null;
    }
    const dealt = this.bag.next();
    if (dealt) this.queue.push(dealt);
    this.holdUsed = false;
    events.push({ type: 'newHand' });

    if (!this.current) {
      this.isGameOver = true;
      this.deathCause = 'complete';
      this.finalizeBest();
      events.push({ type: 'gameOver' });
      return events;
    }

    // Game over: nothing fits, even after a hold swap
    if (this.checkGameOver()) {
      this.isGameOver = true;
      this.deathCause = 'board_lock';
      this.finalizeBest();
      events.push({ type: 'gameOver' });
    }

    return events;
  }

  /**
   * Light the floor a claim just took, then check the survey.
   *
   * Returns whether that claim completed one. The bonus is flat by design: it
   * rewards covering the whole board, not the streak the player happened to be
   * on when the last cell fell.
   */
  private markTerritory(regions: Region[]): boolean {
    if (!this.config.territory.enabled) return false;
    for (const r of regions) this.board.markLit(r.cells);
    if (this.board.litCount() < INNER_CELLS) return false;

    this.surveys++;
    this.score += this.config.territory.surveyBonus;
    this.board.clearLit();
    return true;
  }

  private checkGameOver(): boolean {
    // An empty hand under a budget means the run is complete, not locked.
    // Callers decide that before asking, so never report a lock for it.
    if (!this.current) return false;
    if (this.fitsAnyRotation(this.current)) return false;
    // A hold swap could rescue the player
    if (!this.holdUsed) {
      const alt = this.held ?? this.queue[0];
      if (alt && this.fitsAnyRotation(alt)) return false;
    }
    return true;
  }

  finalizeBest(): void {
    const isBest = recordPersonalBest(this.difficulty, this.score, this.dailyDate ?? undefined);
    // The pace line races the clock, and only the timed modes have one: the
    // daily deals the same thirty pieces to everyone with no seconds to
    // compare, so a curve stored for it would be measuring thinking time.
    if (isBest && this.difficulty !== 'daily') recordPbTimeline(this.difficulty, this.scoreTimeline);
  }

  /** The run as a log the server can re-play: the deal, and every input. */
  buildReplay(): Replay {
    return {
      rules: RULES_VERSION,
      mode: this.difficulty,
      seed: this.seed,
      ...(this.dailyDate !== null ? { dailyKey: this.dailyDate } : {}),
      // Entries are never mutated after recording, so a copy of the array is
      // all the isolation a caller needs.
      moves: [...this.moves],
      ...(this.movesTruncated ? { truncated: true as const } : {}),
    };
  }

  buildRunSummary(endCauseOverride?: RunEndCause): RunSummary {
    if (endCauseOverride === 'quit') this.finalizeBest();
    return {
      score: this.score,
      difficulty: this.difficulty,
      seed: this.seed,
      ...(this.dailyDate !== null ? { dailyKey: this.dailyDate } : {}),
      endCause: endCauseOverride ?? this.deathCause ?? 'board_lock',
      totalTurns: this.totalTurns,
      claims: this.claims,
      cellsClaimed: this.cellsClaimed,
      roomsClaimed: this.roomsClaimed,
      biggestRoom: this.biggestRoom,
      roomSizes: { ...this.roomSizes },
      doubleCloses: this.doubleCloses,
      maxStreak: this.maxStreak,
      holds: this.holds,
      surveys: this.surveys,
      litCells: this.board.litCount(),
      litMap: this.board.lit.map(row => [...row]),
      closingAtEnd: this.board.findClosingCells().length,
      // Only a budgeted run has a count left to report: unbudgeted play is
      // Infinity, which has no business in a summary that gets serialised.
      piecesLeft: Number.isFinite(this.piecesRemaining) ? this.piecesRemaining : 0,
      gameElapsed: this.gameElapsed,
      scoreTimeline: [...this.scoreTimeline],
      previousBest: this.highScore,
      isNewBest: this.score > this.highScore,
      replay: this.buildReplay(),
    };
  }
}
