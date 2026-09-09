import { DIFFICULTY_CONFIGS, GameConfig, TimerConfig } from './Config';
import { isDailyKey } from './Daily';
import { GameState } from './GameState';
import { rotationCount } from './Pieces';
import { RULES_VERSION } from './Rules';
import { GRID_SIZE, MAX_REPLAY_MOVES, Replay, RunEndCause } from './types';

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
export type SimFailure = 'rules' | 'shape' | 'seed' | 'move' | 'clock' | 'cadence' | 'score';

export interface SimResult {
  valid: boolean;
  reason?: SimFailure;
  score: number;
  /** How many moves were applied before the verdict */
  moves: number;
  /** Set when the engine itself ended the run: 'board_lock' or 'complete' */
  endCause?: RunEndCause;
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
 * Fifty milliseconds, not the second this used to allow. The argument for
 * the tight bound is in `drainIntegral`: the client drains per frame at the
 * rate at the END of each frame, the rate never falls, so a browser always
 * eats at least the closed-form integral this reconstruction subtracts. Both
 * sides then add the same engine-computed bonus and clamp at the same cap,
 * and clamping is monotonic — so the reconstructed bank is greater than or
 * equal to the bank the browser actually had at every move. A run that
 * survived on the client therefore reconstructs to a bank at or above zero,
 * and the slack only has to absorb float noise, not model error. A whole
 * second of slack was a whole second of free play for a forged log.
 */
const CLOCK_SLACK_SECONDS = 0.05;

/**
 * The shortest gap allowed between two placements.
 *
 * Nothing in the rules says how fast a person can drag a piece onto a board,
 * so a fabricated log used to be free to place six hundred pieces at a
 * millisecond apart and re-play perfectly. Eighty milliseconds is under half
 * of a fast human tap and still refuses the machine-gun log outright. It is
 * a floor on the *inputs*, so it holds in the Daily too, where there is no
 * clock to make haste cost anything.
 */
const MIN_PLACEMENT_INTERVAL = 0.08;

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
 * run the reconstructed bank dry. CLOCK_SLACK_SECONDS is on top of that, for
 * the rounding of a bonus and the last bits of an accumulated double.
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
  return { valid: false, reason, score, moves, ...(endCause ? { endCause } : {}) };
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
  /** When the last piece went down, for the cadence floor. */
  let previousPlacementAt = -Infinity;

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

    // Nobody drags a piece onto a board twelve times a second. Checked
    // before the placement is simulated, so a machine-gun log costs the
    // server the two moves it takes to spot rather than all six hundred.
    if (at - previousPlacementAt < MIN_PLACEMENT_INTERVAL - TIME_EPSILON) {
      return fail('cadence', gs.score, i);
    }
    previousPlacementAt = at;

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

    const events = gs.tryPlace(move.row, move.col);
    // An off-board or occupied placement is refused silently, with no events
    if (events.length === 0 || events[0].type !== 'place') return fail('move', gs.score, i);
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
