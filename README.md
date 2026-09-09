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
- **Double close.** Seal two rooms with one piece for a multiplier: `1 + 0.5 × (rooms − 1)`.
- **Streaks.** Claims on consecutive placements multiply the score by `1 + 0.25 × streak`, capped at ×3. A few empty placements and the streak breaks.
- **Closing hints.** Gold cells mark where a single block would close a room.
- **Shared walls.** Claiming a room removes its walls, including any wall it shares with a neighbouring room. Closing order matters.
- **Echo walls.** A fence a claim removes lingers for a moment as a fading ghost that still counts as a wall, so the room next door can be closed against it. A claim bounded by a ghost pays **×1.25**. The window is 2 s in Classic and 1.5 s in Blitz, which turns the shared wall from a pitfall into the game's signature combo. The floor a claim just took stays solid for the same window, so a room can never re-close itself off its own ghosts.
- **Territory.** The board remembers every cell you claim, and rebuilding on lit floor pays less. Lighting all 49 inner cells banks a Survey bonus and wipes the map. See [Territory](#territory).
- **Bag by tier.** From ARCHITECT upward the bag gets stingier with fence material: fewer long bars, then fewer corners, more awkward shapes, and by SOVEREIGN no BAR 5 at all. Every bag still holds 23 or 24 pieces, and the change only ever lands at a refill, never mid-bag.
- **Ghost pace.** Once a mode has a personal best, the HUD carries a grey `PB PACE` line: what that run had banked at the second this one is on. It turns green while you are ahead of it. Classic and Blitz only, and only after a first run has set the curve.

## Modes

Each mode has its own leaderboard and its own personal best.

| | Classic | Blitz | Rationed Daily |
|---|---|---|---|
| Clock | 60 s, bank caps at 90 s | 35 s, bank caps at 50 s | none |
| Pieces | unlimited | unlimited | 30 |
| Time per placement | 1.8 s | 1.2 s | — |
| Time per claim | 2.0 + 0.8 × area, max 16 s | 1.5 + 0.6 × area, max 10 s | — |
| Speed window | 8 s, down to 0.45× | 5 s, down to 0.30× | — |
| Drain acceleration | +0.16× per minute, max 1.7× | +0.30× per minute, max 2.0× | — |
| Streak survives | 2 placements without a claim | 1 | 2 |
| Echo window | 2.0 s | 1.5 s | off |
| Survey bonus | 5,000 | 2,500 | 2,000 |
| Bag by tier | yes | yes | no |
| Deal | fresh seed per run | fresh seed per run | the UTC date |
| Personal best | lifetime | lifetime | per day |

Tier thresholds (SETTLER, BUILDER, ARCHITECT, WARDEN, SOVEREIGN, LEGEND) are per mode and live in `src/core/Progression.ts`.

## The Rationed Daily

One puzzle a day, the same one for everyone: **30 pieces, no clock**. The seed is the UTC date, so two players anywhere in the world are dealt the same shapes in the same rotations and the same colours, and the whole game becomes planning rather than speed. HOLD works as it always does; the only refusal is parking the last piece of the ration with an empty hold slot, which would leave the hand with nothing to place. When the last piece is placed the run ends as `complete` and the score counts in full.

- The day rolls over at **UTC midnight**, not local midnight — everyone has to be on the same puzzle at the same instant.
- **First submission counts.** Replaying the day is allowed and is labelled `PRACTICE RUN · NOT SUBMITTED`; the leaderboard keeps the score you posted first, higher or not, so the board measures the puzzle and not how many attempts you had.
- Each day is its own leaderboard (`leaderboard:enclave:daily:YYYY-MM-DD`), readable for a week and expiring after eight days. Scores can only be posted to today's or yesterday's board — the second so a run that crossed midnight still lands where it was dealt.
- The personal best is per day, for the same reason: a lifetime daily best would only say you once had a good seed.
- **No echo walls and no tier bag.** An echo window is measured in seconds and the Daily has no clock, and a bag that tightens with the score would deal two players different pieces on the same puzzle. Both are off, so the mix and the order are the same for everyone.
- Its own tier ladder, lower than Classic's: 600 / 1,600 / 3,500 / 7,000 / 14,000. Thirty pieces without a clock cannot out-last a timed run, so the ladder sits between Blitz and Classic. A first pass, tunable once telemetry says where daily scores land.

## Territory

The board remembers. Every cell you claim stays **lit** for the rest of the run, and relit floor pays half: a room is worth its full `area² × 10` only on new ground, half that if every cell of it has been claimed before, and somewhere in between for a mix. The claim is scaled by `0.5 + 0.5 × fresh / area`, so a 2×2 rebuilt entirely on lit floor pays 80 instead of 160. Claiming the same corner over and over gets steadily less profitable, so the run pushes you outward.

Light all 49 inner cells — the board edge is never a wall, so those are the only cells that can ever be floor — and you complete a **Survey**: a flat 5,000 points in Classic, 2,500 in Blitz, 2,000 in the Daily, paid on top of the claim and multiplied by nothing. The map then goes dark and the next survey starts from an empty one, which is what gives a long run an arc instead of flattening it into the same claim repeated.

The HUD carries a `SURVEY 23/49` readout under the tier chip, and the share card draws the lit map the run ended on.

## Options

Three pills on the menu turn SOUND, MUSIC and HAPTIC on and off. Everything else is behind OPTIONS, and each row applies on the spot and is persisted, so there is nothing to confirm.

- **SFX and MUSIC sliders.** Both start below full — 0.8 and 0.7 — so the mix the game shipped with is where you begin and there is still somewhere to go louder.
- **MOTION** — SYSTEM / REDUCED / FULL. SYSTEM follows the device's `prefers-reduced-motion`, and flipping the OS switch mid-run applies immediately. REDUCED turns off screen shake, flashes, zoom pulses and slow-motion, and keeps a quarter of the particles. Claim outlines, dissolves and score popups are untouched, because they say what just happened.
- **COLOURS** — STANDARD / HIGH. High contrast deals pieces from the Okabe–Ito palette, which stays distinguishable under deuteranopia, protanopia and tritanopia, and deepens the empty cell well behind them. Blocks already on screen are remapped position for position, so the switch is visible rather than confusing.
- **LAYOUT** — RIGHT / LEFT. Mirrors the HOLD slot and the NEXT column for left-thumb play. Takes effect on the next run.

## After a run

- **Insights.** At most three lines about the run just played, chosen from a table ordered most useful first: points you could have had and know how to get next time outrank a description of what happened, and praise comes last. The rules are pure functions of the run summary, in `src/core/Insights.ts`.
- **Stats.** Lifetime totals per mode — runs, best, biggest room, rooms sealed, surveys, the room size you actually build most often, time played, last played. Every run folds in exactly once, quits included.
- **Share card.** A 1080×1350 PNG carrying the score, the mode, four or five stats and the final territory map, drawn on a plain 2D canvas off-screen. It goes out through the Web Share API when the browser will take a file, then as a text share, then to the clipboard.
- **Telemetry.** Anonymous end-of-run stats, on by default, so the clock can be tuned on numbers instead of feel. It mints no identifier of its own — the only id sent is the leaderboard's, and only if the player already has one — and it is fire-and-forget, so a blocked endpoint can never delay the game-over screen.

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
- Redis keys, so a board can be found without reading the handler:
  - `leaderboard:enclave:classic` and `leaderboard:enclave:blitz` — permanent, ten entries, one per player.
  - `leaderboard:enclave:daily:YYYY-MM-DD` — one per UTC date, expiring 8 days after its last write. A score may only be posted to today's or yesterday's board, and the menu reads back a week.
  - `telemetry:enclave:runs` — the newest 5,000 finished runs, aggregated on read.
- Bump `CACHE_NAME` in `public/sw.js` on each deploy. The menu shows the `package.json` version in the bottom-right corner, so it is obvious when a new build has arrived.

## Repository map

### Rules

- `src/core/Board.ts`: the 9×9 grid, the flood-fill enclosure detection, and the lit-floor map
- `src/core/Pieces.ts`: piece shapes, rotation, the seeded shuffled-bag dealer, and the per-tier bag table
- `src/core/Random.ts`: mulberry32, FNV-1a, and the per-run seed
- `src/core/Daily.ts`: which day it is, what it deals, and what this browser has done with it
- `src/core/GameState.ts`: the run loop: hand, queue, hold, claims, scoring, streaks, echo walls, territory, clock, piece budget, score timeline
- `src/core/Config.ts`: per-mode scoring, timer, territory, echo, bag and budget numbers
- `src/core/Progression.ts`: score tiers (SETTLER through LEGEND), per mode
- `src/core/Settings.ts`: persisted preferences, personal bests, and the personal best's score curve
- `src/core/Accessibility.ts`: the motion decision and the piece palette, free of Pixi and of the DOM
- `src/core/types.ts`: the core → rendering contract (feedback events, run summary, palettes)

### After the run

- `src/core/Insights.ts`: the recap lines, as a pure function of the run summary
- `src/core/Stats.ts`: lifetime stats per mode — the fold, the derived readouts and the storage
- `src/core/ShareCard.ts`: the 1080×1350 card; `layoutShareCard` decides every string and position, `renderShareCard` paints them
- `src/core/Telemetry.ts`: the anonymous run report and its fire-and-forget send
- `src/core/Leaderboard.ts`: the shared board, the local fallback, and the stored player id

### Presentation

- `src/scenes/MenuScene.ts`, `GameScene.ts`, `GameOverScene.ts`, `SceneManager.ts`
- `src/rendering/GridRenderer.ts`: board, lit floor, echo walls, closing hints, placement pops, claim animation
- `src/rendering/HandRenderer.ts`: hold slot, current piece, next queue, rotate button, drag piece
- `src/rendering/GhostRenderer.ts`: the drop ghost and the gold claim preview
- `src/rendering/UIRenderer.ts`: HUD (score, pace, tier, best, streak pips, survey, timer or piece budget)
- `src/rendering/LayoutManager.ts`: one layout for every screen size, and pixel → grid
- `src/rendering/Widgets.ts`, `Theme.ts`, `FXManager.ts`, `AnimationManager.ts`
- `src/audio/AudioManager.ts`: the mixer, the voices and the clock — everything that touches an AudioContext
- `src/audio/Music.ts`: the notes — chord tables, stinger timing, the leitmotif and the mixer's curves, pure and testable
- `src/input/DragController.ts`: drag, tap-to-rotate, hold

### Server

- `api/leaderboard.ts`: the permanent and daily boards
- `api/runs.ts`: anonymous run telemetry, aggregates on read
- `public/how-to-play.html`: the interactive Playbook, served at `/how-to-play`
- `public/sw.js`, `public/manifest.json`: the service worker and the PWA manifest

## How enclosure detection works

An empty cell is "outside" if it can reach the board edge by walking through empty cells. We flood-fill from every empty cell on the border; anything empty that the flood never reaches is inside a fence. Grouping those cells into connected components gives the individual rooms, and the blocks orthogonally touching a room are its fence. On a 9×9 board this runs in a fraction of a millisecond, so it is also used to compute the gold "closing" hints after every move.

The fill takes an optional set of extra walls — the echo cells — which hold it back exactly as blocks do. They are reported separately from the fence, because there is no block there for a claim to remove, and their presence is what earns the claim its ECHO multiplier.

## Known limitations

- The leaderboard trusts the client. Preventing fabricated scores needs server-side validation of a replay log, which is future work.
