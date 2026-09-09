import { DIFFICULTY_CONFIGS, GameConfig, TimerConfig } from './Config';
import { isDailyKey } from './Daily';
import { GameState } from './GameState';
import { rotationCount } from './Pieces';
import { RULES_VERSION } from './Rules';
import { GRID_SIZE, MAX_REPLAY_MOVES, PlacedPiece, Replay, RunEndCause } from './types';

/**
 * Re-play a run from its seed and its inputs, with the game's own rules, and
 * see what it scores.
 *
 * This is the whole answer to "the leaderboard trusts the client". Nothing
 * here re-implements a rule: it drives the same GameState the browser drives,
 * so a scoring change cannot drift between the two — it can only make old
 * replays stop matching, which is what RULES_VERSION is for.
 *
 * Deliberately free of the DOM. GameState reaches localStorage for personal
 * bests, but every access there is wrapped, so on a server it reads 0 and
 * writes nothing. None of it touches the score.
 */

/** Why a replay was refused. 'score' belongs to the caller that compares. */
export type SimFailure = 'rules' | 'shape' | 'seed' | 'move' | 'clock' | 'score';

export interface SimResult {
  valid: boolean;
  reason?: SimFailure;
  score: number;
  /** How many moves were applied before the verdict */
  moves: number;
  /** Set when the engine itself ended the run: 'board_lock' or 'complete' */
  endCause?: RunEndCause;
  /**
   * One entry per placement that landed, in move order: the piece the deal
   * handed over, as the simulation resolved it. Only the fingerprint needs
   * it — a solution and its rotated copies are one solution, and deciding
   * that needs the shape a `row, col, rot` triple stood for.
   */
  placed: PlacedPiece[];
}

/**
 * The longest a *timed* run may sit between two moves. Half an hour is a tab
 * left open, not a run, and it bounds the work one submission can ask of us.
 */
const MAX_GAP_SECONDS = 1800;

/**
 * The same limit for a run with no clock.
 *
 * The Daily is thirty pieces and no timer: leaving it open over lunch, or
 * overnight, is legal play and used to be refused as a forgery by a limit
 * that was never written down anywhere a player could read it. A day is the
 * honest bound, and it costs nothing — the run ticket's own 24-hour lifetime
 * already caps how long a submittable run can span.
 */
const MAX_UNCLOCKED_GAP_SECONDS = 24 * 60 * 60;

/**
 * How far under zero the reconstructed bank may go before the run is called
 * dead.
 *
 * Fifty milliseconds, not the second this used to allow. The claim is that
 * the reconstructed bank is never below the bank the browser really had, at
 * any move, so the slack absorbs float noise and nothing else. By induction
 * on the moves, with both banks read just before the move's bonus is added:
 *
 *  - they start equal, at `timer.startSeconds`;
 *  - between two moves the browser subtracts `dt × drainRate` per frame at
 *    the rate at the END of the frame, and the rate never falls, so the sum
 *    of the frames is at least the closed-form integral subtracted here
 *    (see `drainIntegral`) — including a backgrounded tab, whose one huge
 *    frame drains at the highest rate of all;
 *  - at the move both sides add the SAME bonus. That is what the derived
 *    `pieceElapsed` bought: it is `gameElapsed − lastPlacementAt` in both
 *    places, and both of those are the recorded `at` of a placement, so the
 *    speed fraction and the tenth-of-a-second rounding on top of it are
 *    computed from bit-identical doubles. While it was accumulated per
 *    frame, the two sides could disagree in the last bits, the rounding
 *    could flip a 1.7 into a 1.8, and an honest run finishing on 0.035 s
 *    reconstructed to −0.065 s and was refused;
 *  - and both then clamp at `timer.maxSeconds`, which is monotonic.
 *
 * So a run the browser survived — bank above zero at every move — cannot
 * reconstruct below zero. The one thing left between the two numbers is
 * float noise: a single closed-form evaluation against a sum of thousands of
 * per-frame subtractions of the same quantity, which is a part in 1e13 of a
 * ninety-second bank. Fifty milliseconds is eleven orders of magnitude of
 * headroom; a whole second was a whole second of free play for a forged log.
 */
const CLOCK_SLACK_SECONDS = 0.05;

/*
 * There is no cadence floor here any more.
 *
 * There used to be one — 0.08 s between placements, on the reasoning that
 * nobody drags a piece onto a board twelve times a second — and it was a rule
 * only the server knew. The live engine accepted two placements 79 ms apart
 * and paid for them; the simulation then refused the whole run as `cadence`,
 * so a fast player was told their honest score could not be verified and
 * given no way to find out why. A rule the game does not enforce while you
 * play cannot be a rule the server enforces afterwards.
 *
 * What it was defending against is already covered: the ticket binds the run
 * to a server clock reading, and `api/leaderboard.ts` refuses a submission
 * whose last move is later than the wall clock has allowed since the ticket
 * was issued. A machine-gun log is a *compressed* log, and compressed time is
 * exactly what that check reads. The non-decreasing timestamp check below
 * stays: time still runs one way.
 */

/**
 * Move times are recorded to the millisecond, and our clock is advanced by
 * differences of them, so the two can disagree in the last bits of a double.
 */
const TIME_EPSILON = 1e-6;

/**
 * Seconds of bank the drain eats between `t0` and `t1`.
 *
 * The rate is `min(drainCap, 1 + (t / 60) × drainAccelPerMinute)`: a straight
 * line until it reaches the cap, flat after it, so the integral is a
 * trapezoid plus a rectangle. Exact, and O(1) however long the run was.
 *
 * Why this is safe to check a run against: the client drains per frame with
 * the rate at the END of the frame (`tick` advances gameElapsed before
 * reading drainRate), and the rate never decreases, so each frame's drain is
 * at least the integral over that frame. The client therefore always drains
 * at least as much as this number — a run that survived on the client cannot
 * run the reconstructed bank dry. CLOCK_SLACK_SECONDS is on top of that, and
 * since the bonus is now computed from the same doubles on both sides it has
 * nothing left to absorb but the noise of the two summations.
 */
export function drainIntegral(timer: TimerConfig, t0: number, t1: number): number {
  if (!(t1 > t0)) return 0;
  const cap = timer.drainCap;
  const k = timer.drainAccelPerMinute / 60; // per second, not per minute
  if (k <= 0) return Math.min(cap, 1) * (t1 - t0);
  // Where the ramp meets the cap, clamped into the interval we are integrating
  const tCap = (cap - 1) / k;
  const split = Math.min(t1, Math.max(t0, tCap));
  const ramp = split > t0 ? (split - t0) + (k * (split * split - t0 * t0)) / 2 : 0;
  const flat = t1 > split ? cap * (t1 - split) : 0;
  return ramp + flat;
}

function fail(reason: SimFailure, score: number, moves: number, endCause?: RunEndCause): SimResult {
  // A failed run has no placements worth reporting: the caller has nothing to
  // fingerprint, because there is no proven solution to fingerprint.
  return { valid: false, reason, score, moves, placed: [], ...(endCause ? { endCause } : {}) };
}

/** A cell on the 9×9 board, as an integer */
function isBoardIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < GRID_SIZE;
}

/**
 * Re-play `replay` and report what it actually scores.
 *
 * The caller compares that against the score being claimed; a match is the
 * only thing that makes a submission real. Everything the run depends on is
 * reproduced here: the bag (which tightens with the score), the echo window
 * (which runs on `at`), and the territory map (which runs on the claims).
 * Colours are dealt from the same RNG draw whatever palette is set, and no
 * rule reads them, so a player's accessibility settings change nothing.
 */
export function simulateRun(replay: Replay): SimResult {
  if (!replay || typeof replay !== 'object') return fail('shape', 0, 0);
  if (replay.rules !== RULES_VERSION) return fail('rules', 0, 0);

  const base = DIFFICULTY_CONFIGS[replay.mode] as GameConfig | undefined;
  if (!base) return fail('shape', 0, 0);
  // A short log cannot reach the score it was cut off from
  if (replay.truncated) return fail('shape', 0, 0);
  const moves = replay.moves;
  if (!Array.isArray(moves) || moves.length > MAX_REPLAY_MOVES) return fail('shape', 0, 0);

  if (replay.mode === 'daily') {
    // A daily run has to say which day it belongs to: the board it can be
    // posted to is a date, and the ticket that vouches for it names one.
    //
    // What is deliberately NOT checked here is that the seed is the one the
    // date implies. It no longer is: the daily's deal comes from an HMAC
    // under the server's secret (see Ticket.dailySeedFor), so that a future
    // puzzle cannot be dealt offline and studied. This module holds no
    // secret and simulates rules, so the seed is bound to the day one level
    // up, where `api/leaderboard.ts` checks the replay's seed against the
    // signed ticket that issued it.
    const key = replay.dailyKey;
    if (typeof key !== 'string' || !isDailyKey(key)) return fail('seed', 0, 0);
  }

  const gs = new GameState({ ...base, seed: replay.seed }, replay.mode);
  gs.start();

  const clocked = base.clock.enabled;
  const maxGap = clocked ? MAX_GAP_SECONDS : MAX_UNCLOCKED_GAP_SECONDS;
  // The reconstructed bank, in seconds. Only ever consulted, never the thing
  // that ends the run: the engine's own timeout cannot be reproduced here.
  let bank = base.timer.startSeconds;
  let previousAt = 0;
  const placed: PlacedPiece[] = [];

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    if (!move || (move.t !== 'p' && move.t !== 'h')) return fail('shape', gs.score, i);

    const at = move.at;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return fail('shape', gs.score, i);
    const dt = at - gs.gameElapsed;
    if (dt < -TIME_EPSILON || dt > maxGap) return fail('move', gs.score, i);
    // A run the engine has already ended cannot take another input
    if (gs.isGameOver) return fail('move', gs.score, i, gs.deathCause ?? undefined);
    // Assigned, not accumulated. The client records `at` as its own
    // `gameElapsed` to the last bit, so setting the clock to that number
    // makes every echo wall's `expiresAt` — computed as gameElapsed + window
    // — bit-identical on both sides, and a claim decided a microsecond
    // either side of an expiry is decided the same way here as it was there.
    gs.advanceClockTo(at);

    if (clocked) {
      bank -= drainIntegral(base.timer, previousAt, at);
      if (bank < -CLOCK_SLACK_SECONDS) return fail('clock', gs.score, i);
    }
    previousAt = at;

    if (move.t === 'h') {
      // hold() returns nothing at all when it refuses: no piece, already
      // held this piece, or parking the last piece of a ration.
      if (gs.hold().length === 0) return fail('move', gs.score, i);
      continue;
    }

    const piece = gs.current;
    if (!piece) return fail('move', gs.score, i);
    // Checked here rather than left to the board: `canPlace` indexes the grid
    // directly, so a fractional row would throw rather than be refused. The
    // handler screens these too; the core must not depend on it having done so.
    if (!isBoardIndex(move.row) || !isBoardIndex(move.col)) return fail('move', gs.score, i);
    const turns = rotationCount(piece);
    if (!Number.isInteger(move.rot) || move.rot < 0 || move.rot >= turns) {
      return fail('move', gs.score, i);
    }
    // Turn the dealt piece to the rotation it was placed at. Bounded by the
    // piece's own rotation count, so a bad index cannot spin here forever.
    for (let n = 0; n < turns && gs.current !== null && gs.current.rotation !== move.rot; n++) {
      gs.rotate();
    }
    if (!gs.current || gs.current.rotation !== move.rot) return fail('move', gs.score, i);

    // Read before the placement consumes it: this is the piece the deal
    // actually handed over at this move, which is what the fingerprint needs
    // to know what a `row, col, rot` triple stood for on the board.
    const footprint: PlacedPiece = {
      rows: gs.current.rows,
      cols: gs.current.cols,
      turns,
    };

    const events = gs.tryPlace(move.row, move.col);
    // An off-board or occupied placement is refused silently, with no events
    if (events.length === 0 || events[0].type !== 'place') return fail('move', gs.score, i);
    placed.push(footprint);
    if (clocked) {
      // The engine's own award, so the speed fraction and the claim bonus are
      // already in it — and so is the rounding the client applied.
      bank = Math.min(bank + (events[0].timeBonus ?? 0), base.timer.maxSeconds);
    }
  }

  return {
    valid: true,
    score: gs.score,
    moves: moves.length,
    placed,
    ...(gs.deathCause ? { endCause: gs.deathCause } : {}),
  };
}

/**
 * The simulation plus the comparison that gives it a point: the score being
 * claimed has to be the score the rules produce, to the point. Kept here so
 * the verdict and its vocabulary live in one place rather than in the handler.
 */
export function verifyScore(replay: Replay, claimed: number): SimResult {
  const result = simulateRun(replay);
  if (!result.valid) return result;
  if (result.score !== claimed) return { ...result, valid: false, reason: 'score' };
  return result;
}
