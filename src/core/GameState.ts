import { Board } from './Board';
import { PieceBag, makePiece, rotatePiece } from './Pieces';
import { getPiecePalette } from './Accessibility';
import { Difficulty, GameConfig, SiegeConfig, TerritoryConfig, DEFAULT_CONFIG } from './Config';
import { dailyKey, dailySeed } from './Daily';
import { cellsOfTerrain, terrainOf } from './Missions';
import { getProgressStatus } from './Progression';
import { Rng, mulberry32, randomSeed } from './Random';
import { RULES_VERSION } from './Rules';
import { SiegeIntent, keyOf, readIntent, stepRaiders } from './Siege';
import {
  getPersonalBest, getSiegeBest, recordPbTimeline, recordPersonalBest, recordSiegeBest,
} from './Settings';
import {
  PieceInstance, FeedbackEvent, ClaimResult, ClaimPoints, ScoreBreakdown, Region,
  RunEndCause, RunSummary, GridPos, CellColor, EchoWall, Move, Replay, MAX_REPLAY_MOVES,
  DECISION_TIME_CAP, Raider, SiegeMetrics, SiegeVariant, siegeVariantKey,
} from './types';

/**
 * Everything a candidate turn would do, run through the same resolution the
 * real turn runs: what it seals, what it catches, what it earns, and where
 * the raiders end up because of it.
 */
export interface SiegePreview {
  /** Courtyards this turn would seal */
  regions: Region[];
  /** Capture bonus plus the income the resulting ground would pay */
  points: number;
  /** Raiders the courtyards would catch */
  captured: GridPos[];
  /** Held floor cells the turn would leave, for the courtyard fill */
  held: GridPos[];
  /** Walls the raiders would knock down in answer */
  wallsBroken: GridPos[];
  /** What the raiders do on the board this turn leaves behind */
  intent: SiegeIntent;
  /** A raider would stand on the Keep: this drop loses the run */
  breach: boolean;
}

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

/** The inverse of `cellKey`, for handing a set of held cells back as cells */
function parseCellKey(key: string): GridPos {
  const comma = key.indexOf(',');
  return { row: Number(key.slice(0, comma)), col: Number(key.slice(comma + 1)) };
}

/** What one enemy phase did, so the live turn and the preview read one answer */
interface SiegeResolution {
  /** Raiders caught inside the ground this turn sealed */
  captured: GridPos[];
  /** Cells a scheduled wave landed on */
  arrivals: GridPos[];
  /** Cells a raider stepped into */
  moved: GridPos[];
  /** Player walls knocked down this phase */
  wallsBroken: GridPos[];
  /** A raider stands on the Keep */
  breach: boolean;
  /** The raiders that are left, in their new positions */
  raiders: Raider[];
  /** Held floor after the phase, as 'row,col' */
  held: Set<string>;
  /** What that ground pays */
  income: number;
  /** Arrivals still owed, because their gate was blocked */
  pendingSpawns: number[];
  /** The next unused raider id */
  nextRaiderId: number;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

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
  /** Where the Keep is, read off the mission map */
  keep: GridPos = { row: 4, col: 4 };
  /** Gate cells in map reading order, which is what a spawn index means */
  gates: GridPos[] = [];
  /** What the raiders will do next, for the intent layer */
  intent: SiegeIntent | null = null;
  /** Bumped whenever a raider or a wall moves, so a view knows to redraw */
  siegeVersion = 0;
  /**
   * Courtyard floor the player holds, as 'row,col'.
   *
   * Ground stays yours for as long as it stays sealed, and pays every turn it
   * does — which is the whole economy of the mode. It is a set rather than a
   * count because the board draws it, and because losing a wall has to be
   * able to take back exactly the cells that just opened.
   */
  heldGround = new Set<string>();
  /**
   * What was already sealed when this turn's piece went down, so the turn can
   * tell ground it closed from ground that was standing closed. Read at the
   * top of a placement and consumed by the phase that follows it.
   */
  private enclosedBeforeTurn: ReadonlySet<string> = EMPTY_KEYS;
  /** Pieces discarded rather than placed */
  skips = 0;
  private nextRaiderId = 1;
  /**
   * Gates a scheduled wave could not use because a raider was still standing
   * in one. The arrival is owed, not cancelled: it goes out on the next phase
   * a gate is free, so blocking a door delays the siege rather than deleting
   * a raider from it.
   */
  private pendingSpawns: number[] = [];
  /**
   * The mission's authored supply, dealt in order. Not a bag: the same
   * eighteen pieces in the same order on every attempt is what makes a retry
   * a better plan rather than a better draw.
   */
  private supply: PieceInstance[] = [];
  private supplyIndex = 0;

  private siegeMetrics: SiegeMetrics | null = null;

  private bag = new PieceBag();
  readonly config: GameConfig;
  readonly difficulty: Difficulty;

  constructor(config: GameConfig = DEFAULT_CONFIG, difficulty: Difficulty = 'classic') {
    this.config = config;
    this.difficulty = difficulty;
    // The board is the size the game says it is, once: everything downstream
    // reads `board.size` rather than a global.
    this.board = new Board(config.boardSize);
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
    const undealt = this.config.siege
      ? this.supply.length - this.supplyIndex
      : this.bag.remaining;
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
   * Cells that are already inside a fence on this board.
   *
   * Read before a placement so the placement can tell a room it just closed
   * from one that was standing there before it. Without terrain that is a
   * distinction with no difference — a room closes and is paid on the same
   * placement, so nothing is ever enclosed between two of them — but ruins can
   * pre-enclose ground nobody built, and a piece dropped into a courtyard the
   * old walls had already sealed must not read as having claimed it.
   */
  enclosedCells(board: Board): Set<string> {
    const out = new Set<string>();
    for (const region of board.findEnclosures(this.activeEchoKeys())) {
      for (const cell of region.cells) out.add(cellKey(cell));
    }
    return out;
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

  /** Which siege this is, for a key, a label or a log */
  get siegeVariant(): SiegeVariant | null {
    const s = this.siege;
    return s ? { missionId: s.missionId, enemy: s.enemy, reliefTurns: s.reliefTurns } : null;
  }

  /** Raiders on the board right now */
  enemyCells(): GridPos[] {
    return this.raiders.map(r => ({ row: r.row, col: r.col }));
  }

  /** Turns left before relief arrives. Zero once it has. */
  get reliefIn(): number {
    const siege = this.siege;
    if (!siege) return 0;
    return Math.max(0, siege.reliefTurns - this.totalTurns);
  }

  /** Held floor cells: what the ground income is counted over */
  get heldCount(): number {
    return this.heldGround.size;
  }

  /** Raiders captured so far */
  get capturedCount(): number {
    return this.siegeMetrics?.enemiesCaptured ?? 0;
  }

  // ── The siege ──

  /**
   * The draw the raider phase of `turn` will make.
   *
   * Keyed to the turn alone — not to a run seed, and deliberately not a
   * running stream. Two things fall out of that. The intent preview asks the
   * same question the phase will answer, on every pointer move, so a shared
   * stream would let the preview change the future it was previewing. And a
   * mission is a puzzle: the same eighteen pieces against the same raiders
   * doing the same thing, so the second attempt is a better plan rather than
   * a luckier tie-break.
   */
  private raiderRng(turn: number): Rng {
    return mulberry32(Math.imul(turn + 1, 0x9e3779b1) | 0);
  }

  /** Lay the mission out: terrain, the Keep, the gates and the supply. */
  private startSiege(siege: SiegeConfig): void {
    const terrain = terrainOf(siege.map, this.board.size);
    this.board.setTerrain(terrain);
    const keeps = cellsOfTerrain(terrain, 'keep');
    const centre = Math.floor(this.board.size / 2);
    this.keep = keeps[0] ?? { row: centre, col: centre };
    this.gates = cellsOfTerrain(terrain, 'gate');
    this.raiders = [];
    this.heldGround = new Set();
    this.skips = 0;
    this.nextRaiderId = 1;
    this.pendingSpawns = [];
    // The supply is authored, so it is built rather than shuffled. Colours
    // come off the palette by position, which keeps a retry identical and
    // keeps a colour-blind setting applying to the whole run at once.
    const palette = getPiecePalette();
    this.supply = siege.supply.map((entry, i) =>
      makePiece(entry.id, entry.rot, palette[i % palette.length]),
    );
    this.supplyIndex = 0;
    this.siegeMetrics = {
      variant: {
        missionId: siege.missionId, enemy: siege.enemy, reliefTurns: siege.reliefTurns,
      },
      breachTurn: null,
      wallsLost: 0,
      enemiesCaptured: 0,
      heldAtEnd: 0,
      turnsSurvived: 0,
      skipsUsed: 0,
      routeChangingPlacements: 0,
      decisionTimes: [],
      enemiesAtEnd: 0,
    };
    this.syncEnemies();
  }

  /** The next piece of the authored supply, or null when it is spent */
  private nextSupplyPiece(): PieceInstance | null {
    return this.supplyIndex < this.supply.length ? this.supply[this.supplyIndex++] : null;
  }

  /** One piece off whichever dealer this mode uses */
  private dealPiece(): PieceInstance | null {
    return this.config.siege ? this.nextSupplyPiece() : this.bag.next();
  }

  /**
   * Push the enemy's footprint onto the board, so `canPlace` refuses to build
   * on an enemy, and recompute what it will do next. One call after every
   * change to the enemy or to the walls.
   */
  private syncEnemies(): void {
    this.board.setOccupied(this.enemyCells());
    const siege = this.siege;
    if (!siege) { this.intent = null; return; }
    this.intent = readIntent(
      this.board, this.raiders, this.keep, this.raiderRng(this.totalTurns + 1), siege.wallCost,
    );
    this.siegeVersion++;
  }


  /**
   * Put the enemy on the board from outside the engine.
   *
   * Keeps the three things that have to stay in step: ids stay unique against
   * everything the schedule will mint later, the occupancy overlay matches, and
   * the intent is recomputed. Setting `raiders` or `tide` directly leaves all
   * three stale, and an id that collides with a future arrival is the sort of
   * bug that only shows up as a raider mysteriously not moving.
   */
  placeEnemies(cells: GridPos[]): void {
    if (!this.siege) return;
    this.raiders = cells.map(c => ({ id: this.nextRaiderId++, row: c.row, col: c.col }));
    this.syncEnemies();
  }

  // ── One siege turn ──

  /**
   * The courtyards a turn just sealed.
   *
   * Enclosed now, not enclosed before, and held up by at least one wall the
   * player built — a pocket the ruins had already closed is free ground
   * nobody fenced, and it must not pay like a courtyard. A placement can only
   * ever *add* walls, so every cell of a post-placement region was in one
   * pre-placement component: testing a single cell settles the whole region.
   */
  courtyardsClosedBy(board: Board, enclosedBefore: ReadonlySet<string>): Region[] {
    return board.findEnclosures()
      .filter(r => r.fence.length > 0 && !enclosedBefore.has(cellKey(r.cells[0])));
  }

  /** Floor cells of a set of regions. The Keep, its gates and ruins never earn. */
  private floorOf(board: Board, regions: Region[]): GridPos[] {
    const out: GridPos[] = [];
    for (const region of regions) {
      for (const cell of region.cells) {
        if (board.terrain[cell.row][cell.col] === 'floor') out.push(cell);
      }
    }
    return out;
  }

  /**
   * Ground still yours after the board moved.
   *
   * Held cells that are still inside a fence stay held; anything a raider has
   * opened a way into is connected to the outside now, and stops paying. The
   * test is enclosure and nothing else — a courtyard whose last player wall
   * came down but which the ruins still seal is still sealed.
   */
  private stillHeld(board: Board, claimed: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    for (const region of board.findEnclosures()) {
      for (const cell of region.cells) {
        const key = cellKey(cell);
        if (claimed.has(key)) out.add(key);
      }
    }
    return out;
  }

  /**
   * The enemy phase, against explicit state, in the order the rules give:
   *
   *   capture → arrivals → the raiders act → breach → held ground → income
   *
   * Explicit state rather than `this`, because the drag preview runs the very
   * same routine on a cloned board and a cloned raider list. A preview that
   * re-implemented any of this would be a preview that could lie, and the
   * whole mode rests on it telling the truth.
   *
   * Mutates `board` (the walls a raider knocks down) and `raiders`; every
   * other input is read.
   */
  private resolveSiegePhase(
    board: Board,
    raiders: Raider[],
    pendingSpawns: readonly number[],
    held: ReadonlySet<string>,
    courtyards: Region[],
    turn: number,
    firstRaiderId: number,
  ): SiegeResolution {
    const siege = this.siege!;

    // 1. Capture. Everything standing inside the ground this turn just sealed
    // is taken; the walls that sealed it stay exactly where they are.
    const sealed = new Set<string>();
    for (const region of courtyards) for (const cell of region.cells) sealed.add(cellKey(cell));
    const captured = raiders.filter(r => sealed.has(keyOf(r))).map(r => ({ row: r.row, col: r.col }));
    const live = raiders.filter(r => !sealed.has(keyOf(r)));

    // 2. Arrivals, oldest debt first. A gate with a raider still standing in
    // it cannot take another, and the arrival waits rather than being dropped:
    // blocking a door should delay the siege, not thin it out.
    const owed = [...pendingSpawns];
    for (const spawn of siege.spawns) if (spawn.turn === turn) owed.push(spawn.gate);
    const occupied = new Set(live.map(keyOf));
    const arrivals: Raider[] = [];
    const stillWaiting: number[] = [];
    let nextId = firstRaiderId;
    for (const gateIndex of owed) {
      const gate = this.gates[gateIndex];
      if (!gate) continue;
      if (occupied.has(keyOf(gate))) { stillWaiting.push(gateIndex); continue; }
      const raider: Raider = { id: nextId++, row: gate.row, col: gate.col };
      arrivals.push(raider);
      live.push(raider);
      occupied.add(keyOf(gate));
    }

    // 3. The raiders already here act, all from one snapshot. A newborn does
    // not act on the phase it appears in — a raider that walked out of the
    // gate the instant it was placed would give the player no turn in which
    // to answer it — but its cell is in the snapshot, so the one behind it
    // plans around it.
    board.setOccupied(live.map(r => ({ row: r.row, col: r.col })));
    const newborn = new Set(arrivals.map(r => r.id));
    const actors = live.filter(r => !newborn.has(r.id));
    const steps = stepRaiders(board, actors, this.keep, this.raiderRng(turn), siege.wallCost);
    const wallsBroken: GridPos[] = [];
    const moved: GridPos[] = [];
    for (const step of steps) {
      const raider = live.find(r => r.id === step.id);
      if (!raider) continue;
      if (step.brokeWall) { wallsBroken.push(step.brokeWall); continue; }
      raider.row = step.to.row;
      raider.col = step.to.col;
      moved.push({ row: step.to.row, col: step.to.col });
    }
    board.setOccupied(live.map(r => ({ row: r.row, col: r.col })));

    // 4. Breach: nothing after this matters, so nothing after this pays.
    const breach = live.some(r => r.row === this.keep.row && r.col === this.keep.col);

    // 5. Held ground, recomputed against the board the phase left behind.
    const claimed = new Set<string>(held);
    for (const cell of this.floorOf(board, courtyards)) claimed.add(cellKey(cell));
    const nextHeld = breach ? new Set<string>() : this.stillHeld(board, claimed);

    return {
      captured,
      arrivals: arrivals.map(r => ({ row: r.row, col: r.col })),
      moved,
      wallsBroken,
      breach,
      raiders: live,
      held: nextHeld,
      income: breach ? 0 : nextHeld.size * siege.groundIncome,
      pendingSpawns: stillWaiting,
      nextRaiderId: nextId,
    };
  }

  /**
   * The whole resolution of a candidate turn, without committing to it.
   *
   * The player is being asked to weigh a courtyard against what the siege
   * does next, so a preview that showed only the courtyard would be asking
   * them to guess the half that matters. This runs the real sequence on a
   * clone — place, find what the placement newly sealed, capture what is
   * inside it, then the whole enemy phase — and reports the board it leaves.
   * An attack aimed at a wall is therefore previewed as the attack it will be.
   */
  previewPlacement(piece: PieceInstance, row: number, col: number): SiegePreview | null {
    const siege = this.siege;
    if (!siege) return null;
    const probe = this.board.clone();
    if (!probe.canPlace(piece.shape, row, col)) return null;
    const enclosedBefore = this.enclosedCells(this.board);
    probe.place(piece.shape, row, col, piece.color);

    const courtyards = this.courtyardsClosedBy(probe, enclosedBefore);
    const resolution = this.resolveSiegePhase(
      probe,
      this.raiders.map(r => ({ ...r })),
      this.pendingSpawns,
      this.heldGround,
      courtyards,
      this.totalTurns + 1,
      this.nextRaiderId,
    );

    return {
      regions: courtyards,
      points: resolution.captured.length * siege.enemyBonus + resolution.income,
      captured: resolution.captured,
      held: [...resolution.held].map(parseCellKey),
      wallsBroken: resolution.wallsBroken,
      intent: readIntent(
        probe, resolution.raiders, this.keep,
        this.raiderRng(this.totalTurns + 2), siege.wallCost,
      ),
      breach: resolution.breach,
    };
  }

  /** Weighted route length per raider — what a turn can change */
  private routeSignature(): Map<number, number> {
    const siege = this.siege;
    if (!siege) return new Map();
    return readIntent(
      this.board, this.raiders, this.keep,
      this.raiderRng(this.totalTurns + 1), siege.wallCost,
    ).routeLengths;
  }

  /**
   * Did this turn change what the raiders are going to do?
   *
   * The go-gate number: a mode where most placements leave the siege's plan
   * untouched is a mode where the second force is scenery. Only a placement
   * can move it — a skip changes no walls — so only a placement is counted.
   */
  private routeChanged(
    before: ReadonlyMap<number, number>, after: ReadonlyMap<number, number>,
  ): boolean {
    for (const [id, length] of before) {
      if (!after.has(id)) continue; // captured, which is a different thing
      if (after.get(id) !== length) return true;
    }
    return false;
  }

  /** The next arrival the schedule owes, as the turn it lands on */
  nextSpawnTurn(): number | null {
    const siege = this.siege;
    if (!siege) return null;
    // A debt already owed is due on the very next phase
    if (this.pendingSpawns.length > 0) return this.totalTurns + 1;
    for (const spawn of siege.spawns) {
      if (spawn.turn > this.totalTurns) return spawn.turn;
    }
    return null;
  }

  /**
   * Spend one turn: place the piece, or discard it.
   *
   * Both spend a piece and both advance the enemy one phase, which is why
   * they share everything after the placement itself. Rotating, dragging and
   * HOLD do none of it.
   */
  private takeSiegeTurn(placed: GridPos[] | null, events: FeedbackEvent[]): FeedbackEvent[] {
    const siege = this.siege!;
    const turn = this.totalTurns;

    // What the placement sealed. A skip seals nothing, and asking the flood
    // fill about a board that did not change would only ever say so.
    const courtyards = placed
      ? this.courtyardsClosedBy(this.board, this.enclosedBeforeTurn)
      : [];

    const r = this.resolveSiegePhase(
      this.board, this.raiders, this.pendingSpawns, this.heldGround, courtyards, turn, this.nextRaiderId,
    );
    this.raiders = r.raiders;
    this.pendingSpawns = r.pendingSpawns;
    this.nextRaiderId = r.nextRaiderId;
    this.heldGround = r.held;

    const metrics = this.siegeMetrics;
    if (r.captured.length > 0) {
      this.score += r.captured.length * siege.enemyBonus;
      if (metrics) metrics.enemiesCaptured += r.captured.length;
      events.push({
        type: 'capture',
        enemiesCaptured: r.captured.length,
        capturedCells: r.captured,
      });
    }
    if (metrics) metrics.wallsLost += r.wallsBroken.length;

    this.syncEnemies();
    events.push({ type: 'enemy', wallsBroken: r.wallsBroken, enemyMoved: [...r.arrivals, ...r.moved] });

    if (r.breach) {
      this.isGameOver = true;
      this.deathCause = 'breach';
      if (metrics) metrics.breachTurn = turn;
      this.finalizeBest();
      events.push({ type: 'breach' });
      events.push({ type: 'gameOver' });
      return events;
    }

    // Ground pays for being held, once per enemy phase survived. This is the
    // whole reason a courtyard is worth building rather than worth closing.
    if (r.income > 0) {
      this.score += r.income;
      events.push({ type: 'income', income: r.income, heldCount: this.heldGround.size });
    }

    // Personal best crossed?
    if (!this.newBestReached && this.highScore > 0 && this.score > this.highScore) {
      this.newBestReached = true;
      events.push({ type: 'newBest', previousBest: this.highScore });
    }

    // Relief. Surviving the last phase is the win, even with raiders still
    // standing on the board — holding the Keep is the mission, not clearing
    // the field.
    if (turn >= siege.reliefTurns) {
      this.isGameOver = true;
      this.deathCause = 'victory';
      this.finalizeBest();
      events.push({ type: 'gameOver' });
      return events;
    }

    // Deal the next piece. The hold slot is the last place one can come from,
    // so a piece parked early always comes back out.
    this.current = this.queue.shift() ?? null;
    if (!this.current && this.held) {
      this.current = this.held;
      this.held = null;
    }
    const dealt = this.dealPiece();
    if (dealt) this.queue.push(dealt);
    this.holdUsed = false;
    events.push({ type: 'newHand' });
    return events;
  }

  /** Place the current piece and spend the turn on it */
  private siegePlace(row: number, col: number): FeedbackEvent[] {
    const piece = this.current;
    if (!piece || this.isGameOver) return [];
    if (!this.board.canPlace(piece.shape, row, col)) return [];

    this.totalTurns++;
    // Both read before the piece lands. A turn pays for ground it closed,
    // never for ground that was standing closed already; and what the raiders
    // were going to do has to be judged against the board the player was
    // looking at, not the one the phase leaves behind.
    this.enclosedBeforeTurn = this.enclosedCells(this.board);
    const routeBefore = this.routeSignature();
    this.record({ t: 'p', row, col, rot: piece.rotation, at: this.gameElapsed });
    this.recordDecisionTime();
    const placedCells = this.board.place(piece.shape, row, col, piece.color);
    this.lastPlacementAt = this.gameElapsed;
    // Did this wall move the plan? Compared before the raiders act, so what
    // is being measured is the placement and not the walking.
    this.board.setOccupied(this.enemyCells());
    if (this.routeChanged(routeBefore, this.routeSignature()) && this.siegeMetrics) {
      this.siegeMetrics.routeChangingPlacements++;
    }
    const events: FeedbackEvent[] = [
      { type: 'place', placedCells, pieceColor: piece.color, speedFraction: 1, timeBonus: 0 },
    ];
    return this.takeSiegeTurn(placedCells, events);
  }

  /**
   * Discard the piece in hand.
   *
   * It costs the piece and it costs the turn — the raiders answer a skip
   * exactly as they answer a placement. It exists because a supply is
   * authored: a board with nowhere useful to put a BAR 4 used to be a loss
   * (`board_lock`), and a loss for having been dealt the wrong shape is not a
   * decision, it is an accident.
   */
  skipPiece(): FeedbackEvent[] {
    if (!this.siege || !this.current || this.isGameOver) return [];
    this.totalTurns++;
    this.skips++;
    if (this.siegeMetrics) this.siegeMetrics.skipsUsed = this.skips;
    this.record({ t: 's', at: this.gameElapsed });
    this.recordDecisionTime();
    this.lastPlacementAt = this.gameElapsed;
    return this.takeSiegeTurn(null, [{ type: 'skip' }]);
  }

  /** How long the player looked at this piece before spending it. Capped. */
  private recordDecisionTime(): void {
    const m = this.siegeMetrics;
    if (m && m.decisionTimes.length < DECISION_TIME_CAP) m.decisionTimes.push(this.pieceElapsed);
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
    // The siege has one best per variant: the same score means four different
    // things across the 2×2, so one lifetime number would compare nothing.
    const variant = this.siegeVariant;
    this.highScore = variant
      ? getSiegeBest(siegeVariantKey(variant))
      : getPersonalBest(this.difficulty, this.dailyDate ?? undefined);

    // The mission's map, its Keep, its gates, and the enemy already in them.
    // Before the bag is dealt, because a piece is offered against this board.
    if (this.config.siege) this.startSiege(this.config.siege);

    // Deal the hand plus up to previewCount upcoming pieces, off the bag or
    // off the mission's authored supply. Under a budget the dealer can run
    // dry, and the queue is simply shorter than the preview.
    this.syncBagTier();
    this.current = this.dealPiece();
    this.queue = [];
    for (let i = 0; i < this.config.previewCount; i++) {
      const piece = this.dealPiece();
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
      const dealt = this.dealPiece();
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

  /**
   * Attempt to place the current piece at (row, col).
   *
   * The siege is a different game after this point — no claim, no clock, no
   * streak, and an enemy phase on every turn — so it takes its own path
   * rather than threading branches through this one.
   */
  tryPlace(row: number, col: number): FeedbackEvent[] {
    if (this.config.siege) return this.siegePlace(row, col);
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
    // The new piece's clock starts here, at the same double this placement
    // was recorded at — which is what the simulation reads it back as.
    this.lastPlacementAt = this.gameElapsed;
    events.push({ type: 'place', placedCells, pieceColor: piece.color, speedFraction });

    // Placement points
    this.score += placedCells.length * this.config.scoring.pointsPerBlockPlaced;

    // Detect and resolve enclosures, echo walls counting as walls. One
    // snapshot for the whole placement: every room at once, every occupant of
    // every room captured, then the union of their fences removed.
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
    // One refund per placement, not per room — and in the siege, only for a
    // claim that actually caught something. An empty room still scores; it
    // just does not buy the time to build the next one.
    if (claim) {
      bonus += Math.min(
        t.claimBonusCap,
        t.claimBaseBonus + t.claimPerCellBonus * claim.totalArea,
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
    // Freshness pricing without the objective: the siege wants relit ground
    // to be worth less, not a second thing to be winning.
    if (!this.config.territory.surveyEnabled) return false;
    if (this.board.litCount() < this.board.innerCells) return false;

    this.surveys++;
    this.score += this.config.territory.surveyBonus;
    this.board.clearLit();
    return true;
  }

  private checkGameOver(): boolean {
    // An empty hand under a budget means the run is complete, not locked.
    // Callers decide that before asking, so never report a lock for it.
    if (!this.current) return false;
    // The siege has SKIP: a piece that fits nowhere is discarded, not fatal.
    if (this.config.siege) return false;
    if (this.canAct()) return false;
    return true;
  }

  /** True if the hand, or a hold swap, fits anywhere on the board */
  private canAct(): boolean {
    if (!this.current) return false;
    if (this.fitsAnyRotation(this.current)) return true;
    if (!this.holdUsed) {
      const alt = this.held ?? this.queue[0];
      if (alt && this.fitsAnyRotation(alt)) return true;
    }
    return false;
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
            decisionTimes: [...this.siegeMetrics.decisionTimes],
            heldAtEnd: this.heldGround.size,
            turnsSurvived: this.totalTurns,
            skipsUsed: this.skips,
            enemiesAtEnd: this.raiders.length,
          },
        }
        : {}),
      replay: this.buildReplay(),
    };
  }
}
