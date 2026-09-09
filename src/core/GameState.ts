import { Board, INNER_CELLS } from './Board';
import { PieceBag, rotatePiece } from './Pieces';
import { Difficulty, GameConfig, SiegeConfig, TerritoryConfig, DEFAULT_CONFIG } from './Config';
import { dailyKey, dailySeed } from './Daily';
import { cellsOfTerrain, terrainOf } from './Missions';
import { getProgressStatus } from './Progression';
import { Rng, mulberry32, randomSeed } from './Random';
import { RULES_VERSION } from './Rules';
import {
  SiegeIntent, keyOf, readIntent, stepRaiders, stepTide, tideIntervalAt,
} from './Siege';
import {
  getPersonalBest, getSiegeBest, recordPbTimeline, recordPersonalBest, recordSiegeBest,
} from './Settings';
import {
  PieceInstance, FeedbackEvent, ClaimResult, ClaimPoints, ScoreBreakdown, Region,
  RunEndCause, RunSummary, GridPos, CellColor, EchoWall, Move, Replay, MAX_REPLAY_MOVES,
  DECISION_TIME_CAP, Raider, SiegeMetrics, SiegeVariant, siegeVariantKey,
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
 * The tide's ticks and the raiders' turns each get their own seeded draw, and
 * this keeps the two streams apart. See `siegeRng`.
 */
const TIDE_SALT = 0x40000;

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
  gameElapsed = 0;
  /**
   * The `gameElapsed` the piece in hand was dealt at — the previous placement,
   * or 0 at the start of the run. `pieceElapsed` is derived from it rather
   * than accumulated, which is the whole point: see the getter below.
   */
  lastPlacementAt = 0;
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

  // ── Siege ──

  /** Raiders on the board, oldest first. Empty outside the siege. */
  raiders: Raider[] = [];
  /** Cells the tide holds, as 'row,col'. Empty outside the siege. */
  tide = new Set<string>();
  /** Where the Keep is, read off the mission map */
  keep: GridPos = { row: 4, col: 4 };
  /** Gate cells in map reading order, which is what a spawn index means */
  gates: GridPos[] = [];
  /** What the enemy will do next, for the intent preview */
  intent: SiegeIntent | null = null;
  /** Bumped whenever the enemy or the terrain moves, so a view knows to redraw */
  siegeVersion = 0;
  private nextRaiderId = 1;
  /** Tide expansions so far — the tempo tightens with it */
  private tideTicks = 0;
  /** Game time the next tide expansion is due at */
  private nextTideAt = 0;

  /**
   * Events raised outside a `tryPlace` — the tide expanding on the clock, and
   * the breach that may follow. Drained by the scene each frame, because the
   * caller of `tick` has no return value to put them in.
   */
  private pending: FeedbackEvent[] = [];

  private siegeMetrics: SiegeMetrics | null = null;

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
   * How long the piece in hand has been sat on, as a difference of two
   * absolute clock readings rather than a sum of frames.
   *
   * This used to be accumulated in `advanceClock`, and that was a bug with a
   * price on it. A browser reaches a placement by adding up sixty frames a
   * second; the replay simulation *assigns* the recorded `at` to its clock
   * (see `advanceClockTo`), so its own accumulation landed a few bits away —
   * 0.40404040404040403 against 0.404040404040405 in the case that found
   * this. The time bonus is rounded to a tenth of a second, so a difference
   * in the last bits can round one way live and the other way on the server:
   * 1.8 s banked in the browser, 1.7 s reconstructed. That breaks the
   * invariant the clock check rests on — reconstructed bank ≥ real bank —
   * and an honest run finishing on 0.035 s reconstructs to −0.065 s and is
   * refused as `'clock'`.
   *
   * Derived from `gameElapsed`, both sides compute `gameElapsed −
   * lastPlacementAt` from the same two doubles: the recorded `at` of this
   * placement and of the one before it. One subtraction, bit-identical, so
   * the rounded bonus is bit-identical too.
   */
  get pieceElapsed(): number {
    return this.gameElapsed - this.lastPlacementAt;
  }

  /**
   * Only the tests set this, to age a piece without playing the seconds. It
   * moves the anchor rather than storing a total, so the derivation above
   * stays the one definition of what `pieceElapsed` means.
   */
  set pieceElapsed(seconds: number) {
    this.lastPlacementAt = this.gameElapsed - seconds;
  }

  /**
   * 1.0 right after a placement, decaying to minSpeedFraction.
   *
   * With no clock there is no reward for hurrying, so it is flat 1 — which
   * also keeps the HUD off a fraction that would mean nothing.
   */
  get currentSpeedFraction(): number {
    if (!this.config.clock.enabled) return 1;
    // The siege pays a claim in full however long it was thought about: the
    // pressure there is the thing walking at the Keep, not the stopwatch.
    if (!this.config.timer.speedScaling) return 1;
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
    // A room needs at least one block the player put there. Outside the siege
    // that is every enclosed room by definition, so this only ever bites on a
    // ghost wall or on a pocket of the map the ruins had already closed —
    // free ground nobody built, which must not pay like a claim.
    const built = regions.filter(r => r.fence.length > 0);
    if (this.echoes.length === 0 && this.spentFloor.length === 0) return built;
    const spent = new Set(this.spentFloor.map(cellKey));
    return built.filter(r => !r.echoCells.some(c => spent.has(cellKey(c))));
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
    if (!s.streakEnabled) return 1;
    return Math.min(1 + this.streakCount * s.streakIncrement, s.streakCap);
  }

  /** The siege's config, or null in every other mode */
  get siege(): SiegeConfig | null {
    return this.config.siege ?? null;
  }

  /** Which of the four sieges this is, for a key, a label or a log */
  get siegeVariant(): SiegeVariant | null {
    const s = this.siege;
    return s ? { missionId: s.missionId, enemy: s.enemy, mission: s.mission } : null;
  }

  /** Enemies on the board right now, whichever kind they are */
  enemyCells(): GridPos[] {
    if (this.raiders.length > 0) {
      return this.raiders.map(r => ({ row: r.row, col: r.col }));
    }
    return [...this.tide].map(k => {
      const comma = k.indexOf(',');
      return { row: Number(k.slice(0, comma)), col: Number(k.slice(comma + 1)) };
    });
  }

  /** Tide expansions so far. The countdown ring reads it for the tempo. */
  get tideTickCount(): number {
    return this.tideTicks;
  }

  /** Game time the next tide expansion is due at */
  get nextTideDueAt(): number {
    return this.nextTideAt;
  }

  /** Events raised off the clock rather than off an input. Clears the queue. */
  drainEvents(): FeedbackEvent[] {
    if (this.pending.length === 0) return [];
    const out = this.pending;
    this.pending = [];
    return out;
  }


  // ── The siege ──

  /**
   * A fresh generator for one enemy decision, keyed to which decision it is.
   *
   * Deliberately not a running stream. The intent preview asks the same
   * question the enemy phase will answer, and it asks it every time the player
   * moves the piece — so a shared stream would make the preview change the
   * future it is previewing. Keying the draw to the turn (or the tide tick)
   * instead means the preview is *the same draw* the phase will make, however
   * many times it is asked, and a replay reproduces both.
   */
  private siegeRng(salt: number): Rng {
    return mulberry32((this.seed + Math.imul(salt, 0x9e3779b1)) | 0);
  }

  /** The draw the raider phase of `turn` will make */
  private raiderRng(turn: number): Rng {
    return this.siegeRng(turn);
  }

  /** The draw the tide's `tick`-th expansion will make */
  private tideRng(tick: number): Rng {
    return this.siegeRng(TIDE_SALT + tick);
  }

  /** Lay the mission out: terrain, the Keep, the gates and the starting enemy. */
  private startSiege(siege: SiegeConfig): void {
    const terrain = terrainOf(siege.map);
    this.board.setTerrain(terrain);
    const keeps = cellsOfTerrain(terrain, 'keep');
    this.keep = keeps[0] ?? { row: 4, col: 4 };
    this.gates = cellsOfTerrain(terrain, 'gate');
    this.raiders = [];
    this.tide = new Set();
    this.nextRaiderId = 1;
    this.tideTicks = 0;
    this.nextTideAt = 0;
    if (siege.enemy === 'tide') {
      // The tide is the gates: it does not arrive, it is already in the doorway
      for (const g of this.gates) this.tide.add(keyOf(g));
      this.nextTideAt = tideIntervalAt(siege, 0);
    }
    this.siegeMetrics = {
      variant: { missionId: siege.missionId, enemy: siege.enemy, mission: siege.mission },
      breachTurn: null,
      wallsLost: 0,
      enemiesCaptured: 0,
      routeChangingPlacements: 0,
      roomAreas: [],
      capturesPerClaim: {},
      decisionTimes: [],
      enemiesAtEnd: 0,
    };
    this.syncEnemies();
  }

  /**
   * Push the enemy's footprint onto the board, so `canPlace` refuses to build
   * on an enemy, and recompute what it will do next. One call after every
   * change to the enemy or to the walls.
   */
  private syncEnemies(): void {
    const cells = this.enemyCells();
    this.board.setOccupied(cells);
    const siege = this.siege;
    if (!siege) { this.intent = null; return; }
    const rng = siege.enemy === 'tide'
      ? this.tideRng(this.tideTicks)
      : this.raiderRng(this.totalTurns + 1);
    this.intent = readIntent(this.board, this.raiders, this.tide, this.keep, rng);
    this.siegeVersion++;
  }

  /** Weighted route length per raider, or the tide's next cell — what a placement can change */
  private routeSignature(): Map<number, number> | string {
    const siege = this.siege;
    if (!siege) return '';
    if (siege.enemy === 'tide') {
      const rng = this.tideRng(this.tideTicks);
      const target = readIntent(this.board, [], this.tide, this.keep, rng).tideTarget;
      return target ? keyOf(target) : 'none';
    }
    const rng = this.raiderRng(this.totalTurns + 1);
    return readIntent(this.board, this.raiders, this.tide, this.keep, rng).routeLengths;
  }

  /**
   * Did this placement change what the enemy is going to do?
   *
   * The go-gate number: a mode where most placements leave the siege's plan
   * untouched is a mode where the second force is scenery.
   */
  private routeChanged(
    before: Map<number, number> | string, after: Map<number, number> | string,
  ): boolean {
    if (typeof before === 'string' || typeof after === 'string') return before !== after;
    for (const [id, length] of before) {
      if (!after.has(id)) continue; // captured, which is a different thing
      if (after.get(id) !== length) return true;
    }
    return false;
  }

  /** An enemy stands on the Keep. Nothing after this matters. */
  private breach(): void {
    if (this.isGameOver) return;
    this.isGameOver = true;
    this.deathCause = 'breach';
    if (this.siegeMetrics) this.siegeMetrics.breachTurn = this.totalTurns;
    this.finalizeBest();
  }

  private keepHeldByEnemy(): boolean {
    if (this.tide.has(keyOf(this.keep))) return true;
    return this.raiders.some(r => r.row === this.keep.row && r.col === this.keep.col);
  }

  /**
   * The raiders' turn: every raider steps toward the Keep or breaks the wall
   * in its way, then the schedule lands whoever is due at the gates.
   *
   * Run from inside `tryPlace`, which is what makes a replay reproduce it: the
   * simulation drives the same method with the same inputs and never has to
   * know a siege is being played.
   */
  private raiderPhase(): FeedbackEvent[] {
    const siege = this.siege;
    if (!siege || siege.enemy !== 'raiders') return [];
    const turn = this.totalTurns;
    const steps = stepRaiders(this.board, this.raiders, this.keep, this.raiderRng(turn));
    const broken: GridPos[] = [];
    const moved: GridPos[] = [];
    for (const step of steps) {
      const raider = this.raiders.find(r => r.id === step.id);
      if (!raider) continue;
      if (step.brokeWall) {
        broken.push(step.brokeWall);
        if (this.siegeMetrics) this.siegeMetrics.wallsLost++;
        continue;
      }
      raider.row = step.to.row;
      raider.col = step.to.col;
      moved.push({ row: step.to.row, col: step.to.col });
    }

    // Arrivals. A gate with a raider still standing in it is skipped rather
    // than queued: the schedule is a tempo, not a debt.
    const held = new Set(this.raiders.map(keyOf));
    for (const spawn of siege.spawns) {
      if (spawn.turn !== turn) continue;
      const gate = this.gates[spawn.gate];
      if (!gate || held.has(keyOf(gate))) continue;
      this.raiders.push({ id: this.nextRaiderId++, row: gate.row, col: gate.col });
      held.add(keyOf(gate));
      moved.push({ row: gate.row, col: gate.col });
    }

    this.syncEnemies();
    const events: FeedbackEvent[] = [
      { type: 'enemy', wallsBroken: broken, enemyMoved: moved },
    ];
    if (this.keepHeldByEnemy()) {
      this.breach();
      events.push({ type: 'breach' });
    }
    return events;
  }

  /**
   * The tide, on the clock rather than on placements.
   *
   * Driven from `advanceClock` and `advanceClockTo` alike, and off absolute
   * times rather than deltas, so sixty small frames and one big jump to the
   * same instant produce exactly the same expansions — which is the whole
   * reason a replay of a tide run lands on the same board.
   */
  private runTide(): void {
    const siege = this.siege;
    if (!siege || siege.enemy !== 'tide' || this.isGameOver) return;
    while (this.gameElapsed >= this.nextTideAt && !this.isGameOver) {
      const step = stepTide(this.board, this.tide, this.keep, this.tideRng(this.tideTicks));
      const broken: GridPos[] = [];
      const moved: GridPos[] = [];
      if (step.erodedWall) {
        broken.push(step.erodedWall);
        if (this.siegeMetrics) this.siegeMetrics.wallsLost++;
      } else if (step.claimed) {
        this.tide.add(keyOf(step.claimed));
        moved.push(step.claimed);
      }
      this.tideTicks++;
      this.nextTideAt += tideIntervalAt(siege, this.tideTicks);
      this.syncEnemies();
      this.pending.push({ type: 'enemy', wallsBroken: broken, enemyMoved: moved });
      if (this.keepHeldByEnemy()) {
        this.breach();
        this.pending.push({ type: 'breach' });
        this.pending.push({ type: 'gameOver' });
      }
    }
  }

  /**
   * Enemies caught inside the rooms a claim just sealed. They are removed and
   * paid for; the floor they stood on is claimed like any other.
   */
  private captureEnemies(regions: Region[]): number {
    const siege = this.siege;
    if (!siege) return 0;
    const inside = new Set<string>();
    for (const r of regions) for (const c of r.cells) inside.add(keyOf(c));
    if (inside.size === 0) return 0;

    const before = this.raiders.length + this.tide.size;
    this.raiders = this.raiders.filter(r => !inside.has(keyOf(r)));
    for (const key of [...this.tide]) if (inside.has(key)) this.tide.delete(key);
    const captured = before - (this.raiders.length + this.tide.size);
    if (captured > 0 && this.siegeMetrics) {
      this.siegeMetrics.enemiesCaptured += captured;
    }
    if (this.siegeMetrics) {
      const m = this.siegeMetrics.capturesPerClaim;
      m[captured] = (m[captured] ?? 0) + 1;
    }
    return captured;
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
    this.gameElapsed = 0;
    this.lastPlacementAt = 0;
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
    this.pending = [];
    // The siege has one best per variant: the same score means four different
    // things across the 2×2, so one lifetime number would compare nothing.
    const variant = this.siegeVariant;
    this.highScore = variant
      ? getSiegeBest(siegeVariantKey(variant))
      : getPersonalBest(this.difficulty, this.dailyDate ?? undefined);

    // The mission's map, its Keep, its gates, and the enemy already in them.
    // Before the bag is dealt, because a piece is offered against this board.
    if (this.config.siege) this.startSiege(this.config.siege);

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
    this.gameElapsed += dt;
    this.sampleTimeline();
    // Echo walls run on the game clock, not on placements, so this is the one
    // place they can fade out.
    this.filterEchoes(c => c.expiresAt > this.gameElapsed);
    this.runTide();
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
   * sides compare the same two numbers. `pieceElapsed` rides on the same
   * assignment: it is `gameElapsed − lastPlacementAt`, and both of those are
   * recorded `at` values here, so the speed fraction and the tenth-of-a-
   * second bonus it feeds come out bit-identical to the browser's.
   *
   * Never runs backwards: a move that claims to be earlier than the clock is
   * the caller's to refuse, and silently rewinding one would un-expire the
   * echo walls that have already been swept.
   */
  advanceClockTo(elapsed: number): void {
    if (this.isGameOver) return;
    if (!(elapsed > this.gameElapsed)) return;
    this.gameElapsed = elapsed;
    this.sampleTimeline();
    this.filterEchoes(c => c.expiresAt > this.gameElapsed);
    this.runTide();
  }

  /** Tick the clock. Returns true if time ran out. */
  tick(dt: number): boolean {
    if (this.isGameOver) return false;
    this.advanceClock(dt);
    // The tide runs on the clock, so it can end the run inside advanceClock.
    // Report that as a finished run and leave the cause it set alone.
    if (this.isGameOver) return true;
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
    // `lastPlacementAt` is deliberately untouched: the speed window runs from
    // one piece landing to the next, and a swap is not a placement. Moving it
    // here would hand back a full time bonus for the price of a hold, which
    // is a scoring change and would need a RULES_VERSION bump, not a tidy-up.
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
    // How long the player looked at this piece before committing, recorded
    // before the clock is reset. Capped, so an endless run cannot grow it.
    if (this.siegeMetrics && this.siegeMetrics.decisionTimes.length < DECISION_TIME_CAP) {
      this.siegeMetrics.decisionTimes.push(this.pieceElapsed);
    }
    // What the enemy was going to do, judged against the board the player was
    // looking at. Compared again once the claim has resolved.
    const routeBefore = this.routeSignature();
    // The new piece's clock starts here, at the same double this placement
    // was recorded at — which is what the simulation reads it back as.
    this.lastPlacementAt = this.gameElapsed;
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
    // Enemies caught inside the rooms die with them. Before the score, so the
    // count is in hand when the claim is paid and the clock refilled.
    const enemiesCaptured = claim ? this.captureEnemies(claim.regions) : 0;

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
      bonus += Math.min(
        t.claimBonusCap,
        t.claimBaseBonus
        + t.claimPerCellBonus * claim.totalArea
        + t.claimPerEnemyBonus * enemiesCaptured,
      );
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
      // Flat, per enemy, outside every multiplier: one number to tune, and a
      // capture is worth the same whatever room it happened to be in.
      this.score += enemiesCaptured * this.config.scoring.pointsPerEnemy;

      if (this.config.scoring.streakEnabled) {
        this.streakCount++;
        this.maxStreak = Math.max(this.maxStreak, this.streakCount);
      }
      this.claims++;
      this.cellsClaimed += claim.totalArea;
      this.roomsClaimed += claim.regions.length;
      for (const r of claim.regions) {
        this.biggestRoom = Math.max(this.biggestRoom, r.area);
        this.roomSizes[r.area] = (this.roomSizes[r.area] ?? 0) + 1;
        this.siegeMetrics?.roomAreas.push(r.area);
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
        enemiesCaptured,
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

    // The enemy answers. Inside tryPlace on purpose: the replay simulation
    // drives this same method, so the siege re-plays with no special casing.
    if (this.config.siege) {
      this.syncEnemies();
      if (this.routeChanged(routeBefore, this.routeSignature())) {
        if (this.siegeMetrics) this.siegeMetrics.routeChangingPlacements++;
      }
      for (const e of this.raiderPhase()) events.push(e);
      if (this.isGameOver) {
        events.push({ type: 'gameOver' });
        return events;
      }
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
      // Surviving all eighteen is the mission, not merely the end of the bag
      this.deathCause = this.config.siege?.mission === 'finite' ? 'victory' : 'complete';
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
    // Freshness pricing without the objective: the siege wants relit ground
    // to be worth less, not a second thing to be winning.
    if (!this.config.territory.surveyEnabled) return false;
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
    // A siege best is per variant and stays on this device: this prototype
    // posts nothing, so there is no board for it to be compared on.
    const variant = this.siegeVariant;
    if (variant) {
      recordSiegeBest(siegeVariantKey(variant), this.score);
      return;
    }
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
      // Which siege: the map, the enemy and the goal all change what the same
      // inputs do, so the log has to carry them for a replay to mean anything.
      ...(this.siegeVariant ? { siege: this.siegeVariant } : {}),
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
      ...(this.siegeMetrics
        ? {
          siege: {
            ...this.siegeMetrics,
            roomAreas: [...this.siegeMetrics.roomAreas],
            capturesPerClaim: { ...this.siegeMetrics.capturesPerClaim },
            decisionTimes: [...this.siegeMetrics.decisionTimes],
            enemiesAtEnd: this.raiders.length + this.tide.size,
          },
        }
        : {}),
      replay: this.buildReplay(),
    };
  }
}
