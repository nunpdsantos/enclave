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
| Deal | fresh seed per run | fresh seed per run | one seed per UTC date |
| Personal best | lifetime | lifetime | per day |

Every deal is the server's: a run asks `/api/run-start` for a seed before the
first piece is dealt, and plays what it is given. See [How a score gets on the
board](#how-a-score-gets-on-the-board).

Tier thresholds (SETTLER, BUILDER, ARCHITECT, WARDEN, SOVEREIGN, LEGEND) are per mode and live in `src/core/Progression.ts`.

## The Rationed Daily

One puzzle a day, the same one for everyone: **30 pieces, no clock**. Every player of a date is dealt the same seed, so two players anywhere in the world get the same shapes in the same rotations and the same colours, and the whole game becomes planning rather than speed. HOLD works as it always does; the only refusal is parking the last piece of the ration with an empty hold slot, which would leave the hand with nothing to place. A piece parked earlier always comes back: when the bag and the queue run dry the hold slot empties into the hand, so a ration is thirty placements whether or not you used HOLD. When the last piece is placed the run ends as `complete` and the score counts in full.

- The day rolls over at **UTC midnight**, not local midnight — everyone has to be on the same puzzle at the same instant.
- **The seed is the server's, not the date's.** It is the first 32 bits of an HMAC of the date under the server's secret, handed out with the run ticket. A date hash would let anyone deal next Tuesday's puzzle tonight, solve it at leisure and post a studied run as a first attempt. `dailySeed` in `src/core/Daily.ts` still computes the old public hash, for tests and for the offline practice run — that deal is a different puzzle from the one on the board, and it cannot be submitted.
- **First submission counts** — and "first" means the first submission, not the first one good enough to rank. Replaying the day is allowed and is labelled `PRACTICE RUN · NOT SUBMITTED`; the leaderboard keeps the score you posted first, higher or not, so the board measures the puzzle and not how many attempts you had.
- **No hurry, and no gap limit.** A daily has no clock, so leaving it open over lunch is legal play. The per-gap limit that timed runs are held to (half an hour) does not apply; the run ticket's 24-hour life is the only bound.
- Each day is its own leaderboard (`leaderboard:enclave:v2:daily:YYYY-MM-DD`), readable for a week and expiring after eight days. Scores can only be posted to today's or yesterday's board — the second so a run that crossed midnight still lands where it was dealt.
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

- Deploy on Vercel. The leaderboard API lives in `api/leaderboard.ts` and the run tickets that gate it in `api/run-start.ts`.
- Anonymous run telemetry lives in `api/runs.ts` and shares the same credentials. `POST /api/runs` stores one finished run; `GET /api/runs` returns aggregates only — never raw runs and never player ids. Without credentials it answers 503 and the client, which is fire-and-forget, simply ignores it.
- To enable the shared leaderboard, set these in the Vercel project's environment variables:
  - `KV_REST_API_URL`
  - `KV_REST_API_TOKEN`
  - `ENCLAVE_SECRET` — optional. The key run tickets are signed with and the daily seed is derived from. **It falls back to `KV_REST_API_TOKEN`**, which is already a server-only secret and must be set for any of this to work, so an existing deployment gets tickets without configuring anything new. Set `ENCLAVE_SECRET` to sign with something you can rotate independently of the database credential. Rotating either one changes every daily seed, so rotate at a UTC midnight; tickets issued under the old key stop verifying immediately, which costs at most the runs in flight.
- Never commit those values. `.env` files are git-ignored, and no secret is ever sent to a client.
- Redis keys, so a board can be found without reading the handler. `v2` is `RULES_VERSION` (`src/core/Rules.ts`): the boards are versioned by the rules their scores were proved under, and bumping it starts every board empty. The old keys are left in place, untouched and unread — what to do with them is a product decision, not the handler's.
  - `leaderboard:enclave:v2:classic`, `leaderboard:enclave:v2:blitz` — permanent sorted sets, member = player id, score = score. One entry per player, replaced only by a higher one (`ZADD ... GT`).
  - `leaderboard:enclave:v2:daily:YYYY-MM-DD` — the same, one per UTC date, first score wins (`ZADD ... NX`), expiring 8 days after its last write.
  - `...:meta` beside each board — a hash of player id → `{ name, date }`. Names and dates never take part in ordering, so they do not belong in the sorted set.
  - `leaderboard:enclave:v2:daily:YYYY-MM-DD:ids` — every id that submitted that day, ranked or not. This is what makes first-submission-wins true for a player whose first run missed the top ten. Expires with the board.
  - `leaderboard:enclave:replays:v2:<board>` — the SHA-256 of each run already banked on that board, so one replay cannot be posted twice. Kept 30 days on a daily board, forever on a permanent one. It is the one key here that grows without bound — 64 bytes per accepted score — and the first candidate for a TTL if a ladder ever gets busy.
  - `leaderboard:enclave:used-tokens:YYYY-MM-DD` — spent run tickets, bucketed by the day the ticket was *issued* so a token can never fall between two buckets. Expires after 2 days, which outlives the 24-hour ticket.
  - `telemetry:enclave:runs` — the newest 5,000 finished runs, aggregated on read.
- The sorted sets are not trimmed to ten. A player who drops out of the top ten keeps their entry, so they can still beat their own score years later, and `GET` only ever reads the top ten. The cost is one member and one hash field (about a hundred bytes) per player who has ever posted a score.
- Bump `CACHE_NAME` in `public/sw.js` on each deploy. The menu shows the `package.json` version in the bottom-right corner, so it is obvious when a new build has arrived.

## Repository map

### Rules

- `src/core/Board.ts`: the 9×9 grid, the flood-fill enclosure detection, and the lit-floor map
- `src/core/Pieces.ts`: piece shapes, rotation, the seeded shuffled-bag dealer, and the per-tier bag table
- `src/core/Rules.ts`: `RULES_VERSION` — bump it whenever dealing or scoring changes
- `src/core/Replay.ts`: re-playing a run from its seed and its inputs, and the reconstructed clock
- `src/core/Random.ts`: mulberry32, FNV-1a, and the per-run seed
- `src/core/Daily.ts`: which day it is, and what this browser has done with it. Its `dailySeed` is the old public deal, kept for tests and practice only
- `src/core/Ticket.ts`: the run ticket format, its HMAC, the daily's derived seed and the replay fingerprint. Pure — the secret is a parameter, so it is never bundled into the client
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
- `src/core/Leaderboard.ts`: the shared board, the local fallback, the stored player id, and the run-ticket request

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

- `api/run-start.ts`: the deal a run is played from, and the signed ticket that says so
- `api/leaderboard.ts`: the permanent and daily boards, and the three checks every score has to pass
- `api/runs.ts`: anonymous run telemetry, aggregates on read
- `public/how-to-play.html`: the interactive Playbook, served at `/how-to-play`
- `public/sw.js`, `public/manifest.json`: the service worker and the PWA manifest

## How enclosure detection works

An empty cell is "outside" if it can reach the board edge by walking through empty cells. We flood-fill from every empty cell on the border; anything empty that the flood never reaches is inside a fence. Grouping those cells into connected components gives the individual rooms, and the blocks orthogonally touching a room are its fence. On a 9×9 board this runs in a fraction of a millisecond, so it is also used to compute the gold "closing" hints after every move.

The fill takes an optional set of extra walls — the echo cells — which hold it back exactly as blocks do. They are reported separately from the fence, because there is no block there for a claim to remove, and their presence is what earns the claim its ECHO multiplier.

## How a score gets on the board

A score has to get past three separate things, and each answers a question the others cannot: the **replay** proves the rules produce that number, the **run ticket** proves somebody played it, and the **fingerprints** stop a proven run from being banked twice.

### The ticket

A run starts by asking the server for one. `POST /api/run-start { id, mode }` answers with the seed the run will be dealt from, the daily's date if it is a daily, and a token:

```
base64url({"v":1,"id":"…","mode":"classic","seed":2748215883,"issuedAt":1757400000000})
  . base64url(HMAC-SHA-256(secret, that same base64url text))
```

The seed is the server's choice — 32 bits from `crypto.getRandomValues` for Classic and Blitz, and for the Daily the first 32 bits of `HMAC(secret, 'enclave-daily-' + date)`, so a future puzzle cannot be dealt and studied offline. The MAC covers the encoded payload, so the seed, the id, the mode and the issue time are one indivisible claim rather than four hints. `GET /api/run-start?mode=daily` answers today's date and seed without a token, for anything that wants to know the deal without identifying itself; it cannot be used to post a score.

If the request fails — offline, API down, slower than two and a half seconds — the run still plays, on a local seed, and the game-over screen says `NOT VERIFIED · SCORE KEPT LOCALLY` without attempting to submit. On a Daily that means a practice puzzle rather than the shared one.

### The replay

Every run records its inputs: `{ t: 'p', row, col, rot, at }` for a placement, `{ t: 'h', at }` for a hold, where `at` is the second of the run the input landed on, unrounded. That log, plus the seed and the mode, is the **replay**, and it travels with the score and the token.

The server does not take the score. It re-plays the log — same `GameState`, same seeded bag, same echo window, same territory map — and the score only lands on the board if the run comes out at exactly that number. Everything a score depends on is reproduced: the bag tightens with the score, echo walls fade on `at`, claims light the floor. Colours come from the same RNG draw whatever palette is set, and no rule reads them.

Times are recorded to the full double and the simulation *assigns* them to its clock rather than accumulating gaps, so an echo wall's `expiresAt` — which is `gameElapsed + window` — is bit-identical on both sides and a claim taken a microsecond inside a ghost wall is judged the same way in both places.

The clock is the one thing the server cannot reproduce exactly, because a browser drains it a frame at a time. Instead it reconstructs the bank analytically — the drain rate integrated between moves, closed form — and allows 0.05 s of slack. The client's frame-wise drain uses the rate at the *end* of each frame and the rate never falls, so a browser always drains at least as much as the integral; both sides then add the same engine-computed bonus and clamp at the same cap, and clamping is monotonic. The reconstructed bank is therefore never below the bank the browser really had, and the slack only has to absorb float noise.

Two limits on the log itself: placements at least 0.08 s apart (nobody drags a piece onto a board twelve times a second), and, in a timed mode, no gap over half an hour. A run with no clock has no gap limit beyond the ticket's own day.

### The submission

`POST /api/leaderboard?difficulty=…` carries `{ id, name, score, replay, token }` and is checked in this order:

1. the board exists, and a daily board is today's or yesterday's;
2. the body is under 64 KB, is JSON, and is an object — `null`, `[]` and `"x"` are 400s, and so is a `name` that is not a string;
3. `id`, `name` and `score` have the right types, and `replay` and `token` are present (a client missing either is told `Update required`, not called a cheat);
4. the replay's shape: rules version, mode, seed range, monotonic times, real board coordinates, and that the run's mode matches the board it is posted to;
5. the ticket's MAC verifies, and its `id`, `mode`, `seed` and `dailyKey` match the body, the replay and the board;
6. the ticket is under 24 hours old and not dated in the future;
7. **the wall clock has allowed the run**: the time since `issuedAt` covers the replay's last move, less two seconds for the countdown and clock skew. A run cannot be played faster than real time, and this is the one check a log's own timestamps can never make;
8. the replay re-plays to exactly the score claimed;
9. the ticket has not been spent (`SADD` on the used-token set — a ticket is one run);
10. the replay has not been banked (`SADD` of its fingerprint — a replay is one score);
11. on a daily, the player has not already submitted today (`SADD` on the per-day id set, which counts a first score whether or not it ranked);
12. and only then the write: `ZADD ... GT` on a permanent board, `ZADD ... NX` on a daily, with the name and date going into the meta hash beside it.

Everything before step 9 is a pure function of the request, so a submission that fails any of it has spent nothing. From step 9 on it consumes state, which is what makes each of those a one-shot.

`RULES_VERSION` in `src/core/Rules.ts` guards the whole arrangement. Bump it whenever dealing or scoring changes: old replays will no longer re-play to their scores, the boards move to fresh keys, and the server answers stale clients with `Update required` rather than calling them cheats.

## Known limitations

- **Verification proves the run, not the player.** A bot that scripts legal moves through the real rules, at human speed, produces a run that is real in every sense the server can test: it was dealt a ticket, it took as long as it says, and the rules pay it that score. What is closed is the fabricated score, not the automated one. Closing that needs something none of this is — behavioural analysis, or an account.
- **Tickets can be collected in advance.** `/api/run-start` will mint one for any id that asks, so a patient attacker can hold a batch of them. It buys nothing but patience: each is single-use, bound to one seed, and still has to wait out the run it vouches for in real time. There is no rate limit on the endpoint yet.
- **A daily replay can be perturbed.** The fingerprint dedupe refuses the same log twice, but a shared daily run with one timestamp nudged is a different log, and every player of a date is dealt the same seed. What stops the obvious version of this is the per-day id set: one submission per player per day, so a passed-around run costs the receiver their own attempt.
- **The clock check has 0.05 s of slack**, down from a second. The argument that an honest run cannot fail it is in `drainIntegral` and above; the slack absorbs float noise, not model error.
- **A run past 600 recorded inputs is playable but unprovable.** The log stops at the cap, is marked `truncated`, and the server refuses it. Six hundred placements is far past what any bank can fund.
- **A score kept locally is not a shared score.** When the server refuses one, or the run never got a ticket, the game says so under the board instead of implying it went out.
- **Starting a run mints an anonymous id**, because a ticket has to be bound to one. A player who never posts a score used to stay unidentified; now the id exists from the first run. It is a random UUID in `localStorage`, it is never returned by `GET`, and nothing else is stored against it.
