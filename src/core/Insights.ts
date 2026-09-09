import { INNER_CELLS } from './Board';
import { GameConfig } from './Config';
import { RunSummary } from './types';

/**
 * What the run just taught you, in at most three lines.
 *
 * The rules below are listed in the order they are offered, most useful
 * first, and the first three that fire are what the player sees. "Useful"
 * means points they could have had and know how to get next time, so
 * actionable advice outranks a description of what happened, and praise
 * comes last.
 *
 * Nothing here reads storage, the clock or the DOM: one summary in, lines
 * out, which is what makes the whole table testable.
 */

/** At most this many lines, however many rules fire */
export const MAX_INSIGHTS = 3;

/** A timed run this short never got going, whatever else it did wrong */
const FAST_TIMEOUT_SECONDS = 25;

/** Half the rooms being single cells is the costliest habit in the game */
const SINGLE_ROOM_SHARE = 0.5;

/** Two closing hints left standing is a claim the run walked away from */
const CLOSING_LEFT = 2;

/** How much of the floor has to be lit before a missed survey is worth saying */
const SURVEY_NEAR = 0.6;

/** A room this size is worth a mention, and this size is worth a shout */
const BIG_ROOM = 9;
const HUGE_ROOM = 16;

export function insightsFor(summary: RunSummary, config: GameConfig): string[] {
  const rooms = summary.roomsClaimed;
  const singles = summary.roomSizes[1] ?? 0;
  const singlesHeavy = rooms > 0 && singles / rooms >= SINGLE_ROOM_SHARE;

  // Praise and complaint about the same placement contradict each other: when
  // one claim sealed the big room and the single cells together, only the
  // actionable half of that is worth saying.
  const bigRoomMuted = singlesHeavy && summary.claims <= 1;

  const territory = config.territory.enabled;
  const isDaily = summary.difficulty === 'daily';
  const budget = config.pieceBudget ?? 0;
  const left = summary.piecesLeft;

  const candidates: (string | null)[] = [
    // A run that died this fast has one problem, and it is not room size
    summary.endCause === 'timeout' && summary.gameElapsed < FAST_TIMEOUT_SECONDS
      ? 'Time ran out fast. Every placement adds time; place before you plan.'
      : null,

    singlesHeavy
      ? `${singles} of ${rooms} rooms were single cells. A 2×2 pays sixteen times more.`
      : null,

    summary.closingAtEnd >= CLOSING_LEFT
      ? `${summary.closingAtEnd} rooms were one block from closing when the run ended.`
      : null,

    territory && summary.surveys === 0 && summary.litCells / INNER_CELLS >= SURVEY_NEAR
      ? `${summary.litCells}/${INNER_CELLS} floor lit. The survey was close.`
      : null,

    summary.maxStreak <= 1 && summary.claims >= 3
      ? 'No streak. Claims on consecutive placements multiply.'
      : null,

    summary.holds === 0 && summary.totalTurns >= 10
      ? 'HOLD never used. Park a piece to finish the fence first.'
      : null,

    isDaily && summary.endCause === 'board_lock'
      ? `Ran out of space with ${left} ${left === 1 ? 'piece' : 'pieces'} left.`
      : null,

    isDaily && summary.endCause === 'complete'
      ? `All ${budget} pieces placed.`
      : null,

    summary.biggestRoom >= BIG_ROOM && !bigRoomMuted
      ? `Biggest room ${summary.biggestRoom} cells. ${summary.biggestRoom >= HUGE_ROOM ? 'Massive.' : 'Big room.'}`
      : null,
  ];

  const lines: string[] = [];
  for (const line of candidates) {
    if (line === null) continue;
    lines.push(line);
    if (lines.length === MAX_INSIGHTS) break;
  }
  return lines;
}
