# Enclave

Fence in empty space to claim it. A fast spatial-strategy puzzle for the browser, built with Vite, TypeScript and PixiJS.

## The one rule

Drag pieces onto a 9×9 board. Whenever empty space is **completely surrounded by blocks**, you claim it: the room and its walls vanish and you score the room's **area squared**.

| Room | Points |
|------|--------|
| 1 cell | 10 |
| 2×2 | 160 |
| 3×3 | 810 |
| 4×4 | 2,560 |

So four tiny rooms are worth far less than one big one. The clock drains constantly, placements add a little time and claims add more, which is the tension the game is built on: build big and risk the clock, or close small and survive.

Layers on top of the rule:

- **Rotation.** Every piece rotates (tap it, tap ROTATE, or press R). Fence-building is about orientation.
- **Hold.** Park one piece for later (tap HOLD or press H). Once per piece.
- **Next queue.** Two upcoming pieces are visible, so you can plan which gap each one closes.
- **Double close.** Seal two rooms with one piece for a multiplier.
- **Streaks.** Claims on consecutive placements multiply the score. A few empty placements and the streak breaks.
- **Closing hints.** Gold cells mark where a single block would close a room.
- **Shared walls.** Claiming a room removes its walls, including any wall it shares with a neighbouring room. Closing order matters.

Three modes: Classic (60 s clock), Blitz (35 s) and the Rationed Daily, each with its own leaderboard and personal best.

## The Rationed Daily

One puzzle a day, the same one for everyone: **30 pieces, no clock**. The seed is the UTC date, so two players anywhere in the world are dealt the same shapes in the same rotations and the same colours, and the whole game becomes planning rather than speed. When the last piece is placed the run ends as `complete` and the score counts in full.

- The day rolls over at **UTC midnight**, not local midnight — everyone has to be on the same puzzle at the same instant.
- **First submission counts.** Replaying the day is allowed and is labelled `PRACTICE RUN · NOT SUBMITTED`; the leaderboard keeps the score you posted first, higher or not, so the board measures the puzzle and not how many attempts you had.
- Each day is its own leaderboard (`leaderboard:enclave:daily:YYYY-MM-DD`), readable for a week and expiring after eight days. Scores can only be posted to today's or yesterday's board — the second so a run that crossed midnight still lands where it was dealt.
- The personal best is per day, for the same reason: a lifetime daily best would only say you once had a good seed.

## Territory

The board remembers. Every cell you claim stays **lit** for the rest of the run, and relit floor pays half: a room is worth its full `area² × 10` only on new ground, half that if every cell of it has been claimed before, and somewhere in between for a mix. Claiming the same corner over and over gets steadily less profitable, so the run pushes you outward.

Light all 49 inner cells — the board edge is never a wall, so those are the only cells that can ever be floor — and you complete a **Survey**: a flat 5,000 points in Classic, 2,500 in Blitz, 2,000 in the Daily, paid on top of the claim and multiplied by nothing. The map then goes dark and the next survey starts from an empty one, which is what gives a long run an arc instead of flattening it into the same claim repeated.

## Tech stack

- Vite + TypeScript
- PixiJS for rendering, with `pixi-filters` for the bloom on particles and shockwaves
- Web Audio API for all sound (synthesized at runtime, no audio files), including a convolution reverb built from a generated impulse response, sidechain pumping, and an A/B-section generative loop
- Vercel edge function + Upstash Redis for the leaderboard (optional; the game falls back to a local leaderboard)

## Local development

```bash
npm install
npm run dev
```

Run the rule tests (Vitest, in `tests/`):

```bash
npm test
```

Build for production:

```bash
npm run build
```

## Deployment

- Deploy on Vercel. The leaderboard API lives in `api/leaderboard.ts`.
- Anonymous run telemetry lives in `api/runs.ts` and shares the same credentials. `POST /api/runs` stores one finished run; `GET /api/runs` returns aggregates only — never raw runs and never player ids. Without credentials it answers 503 and the client, which is fire-and-forget, simply ignores it.
- To enable the shared leaderboard, set these in the Vercel project's environment variables:
  - `KV_REST_API_URL`
  - `KV_REST_API_TOKEN`
- Never commit those values. `.env` files are git-ignored.

## Repository map

### Rules

- `src/core/Board.ts`: the 9×9 grid and the flood-fill enclosure detection
- `src/core/Pieces.ts`: piece shapes, rotation, and the seeded shuffled-bag dealer
- `src/core/Random.ts`: mulberry32, FNV-1a, and the per-run seed
- `src/core/Daily.ts`: which day it is, what it deals, and what this browser has done with it
- `src/core/GameState.ts`: the run loop: hand, queue, hold, claims, scoring, streaks, clock, piece budget
- `src/core/Config.ts`: per-mode scoring, timer, clock and budget numbers
- `src/core/Progression.ts`: score tiers (SETTLER through LEGEND)
- `src/core/Settings.ts`: persisted preferences and personal bests

### Presentation

- `src/scenes/MenuScene.ts`, `GameScene.ts`, `GameOverScene.ts`
- `src/rendering/GridRenderer.ts`: board, closing hints, placement pops, claim animation
- `src/rendering/HandRenderer.ts`: hold slot, current piece, next queue, rotate button, drag piece
- `src/rendering/UIRenderer.ts`: HUD (score, tier, best, streak pips, timer)
- `src/rendering/Widgets.ts`, `Theme.ts`, `FXManager.ts`, `AnimationManager.ts`
- `src/audio/AudioManager.ts`: mixer, generative music, musical sound effects
- `src/input/DragController.ts`: drag, tap-to-rotate, hold

## How enclosure detection works

An empty cell is "outside" if it can reach the board edge by walking through empty cells. We flood-fill from every empty cell on the border; anything empty that the flood never reaches is inside a fence. Grouping those cells into connected components gives the individual rooms, and the blocks orthogonally touching a room are its fence. On a 9×9 board this runs in a fraction of a millisecond, so it is also used to compute the gold "closing" hints after every move.

## Known limitations

- The leaderboard trusts the client. Preventing fabricated scores needs server-side validation of a replay log, which is future work.
