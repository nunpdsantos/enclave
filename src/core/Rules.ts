/**
 * The version of the rules a replay was recorded under.
 *
 * Bump this whenever dealing or scoring changes — a new piece or bag
 * composition, a different multiplier, a moved tier threshold, anything the
 * simulation would replay differently. A replay recorded under older rules
 * cannot be re-played to the same score, and the server has no way to tell a
 * stale client from a forged one, so it refuses the version outright and the
 * client is told to update instead of being called a cheat.
 *
 * Version 1 is the unvalidated era: clients that recorded no replay at all.
 */
export const RULES_VERSION = 2;
