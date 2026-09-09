import { DIFFICULTY_CONFIGS, GameConfig, TimerConfig } from './Config';
import { dailySeed, isDailyKey } from './Daily';
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
export type SimFailure = 'rules' | 'shape' | 'seed' | 'move' | 'clock' | 'score';

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
 * The longest a run may sit between two moves. Half an hour is a tab left
 * open, not a run, and it bounds the work one submission can ask of us.
 */
const MAX_GAP_SECONDS = 1800;

/**
 * How far under zero the reconstructed bank may go before the run is called
 * dead. See `drainIntegral` for why one second is generous.
 */
const CLOCK_SLACK_SECONDS = 1.0;

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
    // The daily's whole promise is that everyone played the same deal, so the
    // seed is not the client's to choose: it is the date's.
    const key = replay.dailyKey;
    if (typeof key !== 'string' || !isDailyKey(key)) return fail('seed', 0, 0);
    if (replay.seed !== dailySeed(key)) return fail('seed', 0, 0);
  }

  const gs = new GameState({ ...base, seed: replay.seed }, replay.mode);
  gs.start();

  const clocked = base.clock.enabled;
  // The reconstructed bank, in seconds. Only ever consulted, never the thing
  // that ends the run: the engine's own timeout cannot be reproduced here.
  let bank = base.timer.startSeconds;
  let previousAt = 0;

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    if (!move || (move.t !== 'p' && move.t !== 'h')) return fail('shape', gs.score, i);

    const at = move.at;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return fail('shape', gs.score, i);
    const dt = at - gs.gameElapsed;
    if (dt < -TIME_EPSILON || dt > MAX_GAP_SECONDS) return fail('move', gs.score, i);
    // A run the engine has already ended cannot take another input
    if (gs.isGameOver) return fail('move', gs.score, i, gs.deathCause ?? undefined);
    if (dt > 0) gs.advanceClock(dt);

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
