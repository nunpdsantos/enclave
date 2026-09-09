# Enclave

Fence in empty space to claim it. A fast spatial-strategy puzzle for the browser, built with Vite, TypeScript and PixiJS.

## The one rule

Drag pieces onto a 9×9 board. Whenever empty space is **completely surrounded by blocks**, you claim it: the room and its walls vanish and you score the room's **area squared**. (Hold the Keep plays a different game on an 11×11 board — see [Hold the Keep](#hold-the-keep-siege--a-graybox).)

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

| | Classic | Blitz | Rationed Daily | Hold the Keep (graybox) |
|---|---|---|---|---|
| Board | 9×9 | 9×9 | 9×9 | **11×11** |
| Clock | 60 s, bank caps at 90 s | 35 s, bank caps at 50 s | none | none |
| Pieces | unlimited | unlimited | 30 | 18, authored |
| Time per placement | 1.8 s | 1.2 s | — | — |
| Time per claim | 2.0 + 0.8 × area, max 16 s | 1.5 + 0.6 × area, max 10 s | — | — |
| Speed window | 8 s, down to 0.45× | 5 s, down to 0.30× | — | off |
| Drain acceleration | +0.16× per minute, max 1.7× | +0.30× per minute, max 2.0× | — | — |
| Streak survives | 2 placements without a claim | 1 | 2 | off |
| Echo window | 2.0 s | 1.5 s | off | off |
| Survey bonus | 5,000 | 2,500 | 2,000 | off |
| Bag by tier | yes | yes | no | no |
| Deal | fresh seed per run | fresh seed per run | one seed per UTC date | authored, seedless |
| Personal best | lifetime | lifetime | per day | per mission, local |

The board size is a property of the game, not a global: `GameConfig.boardSize`
and `Board.size`, read by the layout, the renderers, the closing hints, the
drag preview and the replay simulator alike.

Every deal is the server's: a run asks `/api/run-start` for a seed before the
first piece is dealt, and plays what it is given. See [How a score gets on the
board](#how-a-score-gets-on-the-board).

Tier thresholds (SETTLER, BUILDER, ARCHITECT, WARDEN, SOVEREIGN, LEGEND) are per mode and live in `src/core/Progression.ts`.

## The Rationed Daily

One puzzle a day, the same one for everyone: **30 pieces, no clock**. Every player of a date is dealt the same seed, so two players anywhere in the world get the same shapes in the same rotations and the same colours, and the whole game becomes planning rather than speed. HOLD works as it always does; the only refusal is parking the last piece of the ration with an empty hold slot, which would leave the hand with nothing to place. A piece parked earlier always comes back: when the bag and the queue run dry the hold slot empties into the hand, so a ration is thirty placements whether or not you used HOLD. When the last piece is placed the run ends as `complete` and the score counts in full.

- The day rolls over at **UTC midnight**, not local midnight — everyone has to be on the same puzzle at the same instant.
- **The seed is the server's, not the date's.** It is the first 32 bits of an HMAC of the date under the server's secret, handed out with the run ticket. A date hash would let anyone deal next Tuesday's puzzle tonight, solve it at leisure and post a studied run as a first attempt. `dailySeed` in `src/core/Daily.ts` still computes the old public hash, for tests and for the offline practice run — that deal is a different puzzle from the one on the board, and it cannot be submitted.
- **The first ticket is the attempt.** Asking for the deal is what spends it: the first daily ticket an id is issued on a date is a normal one and puts that id in the day's ticket set, and every later one comes back marked practice. A daily you start and abandon has therefore been played — that is the cost of counting the attempt at the only moment the server can be sure one happened. A practice run gets the real puzzle and plays it for real — replaying the day is allowed and always was — but it is labelled `PRACTICE RUN · NOT SUBMITTED`, the client never posts it, and the leaderboard refuses it if it arrives anyway. It used to be the first *submission* that counted, which let a player take the deal, play it as many times as they liked and post only the best of them. The per-day set of ids that have already submitted still stands behind it, so a ticket write that never happened cannot re-open the day.
- **No hurry, and no gap limit.** A daily has no clock, so leaving it open over lunch is legal play. The per-gap limit that timed runs are held to (half an hour) does not apply; the run ticket's 24-hour life is the only bound.
- Each day is its own leaderboard (`leaderboard:enclave:v2:daily:YYYY-MM-DD`), readable for a week and expiring after eight days. Scores can only be posted to today's or yesterday's board — the second so a run that crossed midnight still lands where it was dealt.
- The personal best is per day, for the same reason: a lifetime daily best would only say you once had a good seed.
- **No echo walls and no tier bag.** An echo window is measured in seconds and the Daily has no clock, and a bag that tightens with the score would deal two players different pieces on the same puzzle. Both are off, so the mix and the order are the same for everyone.
- Its own tier ladder, lower than Classic's: 600 / 1,600 / 3,500 / 7,000 / 14,000. Thirty pieces without a clock cannot out-last a timed run, so the ladder sits between Blitz and Classic. A first pass, tunable once telemetry says where daily scores land.

## Hold the Keep (siege) — a graybox

A prototype of the direction in `ENCLAVE - direction v3.md`, section 3: a
second force on the board, and a run with a beginning and an end. **Nothing
from it is posted anywhere** — no leaderboard, no run ticket, no server
validation. Its rules are still being decided, and a shared board for rules
that change is a board that has to be thrown away.

It is not Classic with raiders bolted on. Every rule Classic scores by is off,
because the first version of this played as two games at once: a room game and
a siege game, sharing a board and arguing about it.

### The objective

**Hold the Keep until relief arrives after 18 turns.** A raider standing on the
Keep ends the run immediately — including on the eighteenth turn. Survive the
eighteenth enemy phase without one and relief arrives: `VICTORY`, even with
raiders still on the board. Holding the Keep is the mission; clearing the field
is not.

**M1, THE GATEHOUSE.** An 11×11 board, a single-cell Keep at (5,5), one gate at
the top-centre border cell, no ruins. Raiders arrive after turns 1, 3, 5, 7, 9
and 11 — one each. M2 and M3 are still in `Missions.ts` as data; the picker
shows one mission, because this test has one question in it.

### A turn

Rotate freely, HOLD once per piece, then either **place** the piece or **SKIP**
it. Either spends one piece and advances one enemy phase; rotating, dragging
and HOLD do not. SKIP sits beside ROTATE and takes two taps — the first arms it
and says `DISCARD?` — because a skip hands the raiders a free turn and is far
too expensive to lose to a thumb landing an inch to the left.

SKIP is what replaced losing to a board with nowhere to put the piece. A run
that ends because the eleventh piece was the wrong shape is not a decision, it
is an accident.

### The supply

One authored 18-piece sequence per mission, **identical on every attempt**, in
`Missions.ts` as a list of piece ids and rotations. No bag, no seed. M1's mix
is eight straight sections of 2–4 cells, eight corners and Ls of 3–4 cells, and
two single-cell patches, alternating so that no stretch of the run is all one
kind of material. **Four** upcoming pieces are visible, not two: what the queue
shows is a plan to be made rather than luck to be hedged against.

Eighteen pieces and eighteen turns is not a coincidence — running out of supply
and being relieved are the same moment.

### Walls, and the ground behind them

**Walls persist.** They occupy whole cells and stand until a raider knocks one
down. A piece cannot overlap a wall, a raider, a ruin, a gate or the Keep;
building on your own courtyard floor is allowed, and those cells stop being
courtyard.

**Courtyards are held, not claimed.** Newly enclosed floor becomes yours — the
same orthogonal enclosure detection the rest of the game uses, where the board
edge is never a wall, raiders never form boundaries, and the enclosure has to
have been created by the placement (the enclosures are compared before and
after it). A region held up by ruins alone never counts: nobody built it.

Held ground stays visibly held for as long as it stays sealed. After any wall
destruction, ownership is recomputed: held ground that is now connected to the
outside stops being yours, and still-enclosed ground stays. The Keep, the
gates, ruins and wall cells never earn.

### The order a turn resolves in

One placement or one skip:

1. **place** the piece (a skip places nothing);
2. **capture** every raider standing inside a courtyard this turn newly
   enclosed — they are removed, and the walls stay;
3. **spawn** whatever the schedule owes, at the gates. Arrivals idle on the
   phase they appear in, and a blocked gate delays an arrival rather than
   cancelling it;
4. the raiders already on the board **act**, all planned from one snapshot in
   id order: one orthogonal step along the weighted route to the Keep, or one
   targeted wall destroyed instead of moving. A raider whose target became
   occupied waits;
5. **breach check**;
6. **recompute** held ground;
7. **award income**.

The drag preview runs *this same routine* on a cloned board — same method, not
a second implementation — so the captures, the resulting raider positions, the
wall about to be attacked and the ground the drop would leave are the ones the
turn will actually produce. The enemy phase is a fixed ~300 ms animation
whatever the raider count.

### Score

- `+75` per raider captured (`enemyBonus`).
- `+1` per held floor cell, after every enemy phase the run survives
  (`groundIncome`).

That is the whole scoring surface. No upfront room payment, no area², no
multipliers, no clock refunds, no point per block, no streak, no echo, no
survey, no tier bag, no territory freshness. Score is mastery: the best is
local and per mission.

Capturing is the spike and ground is the curve — a courtyard sealed on turn 4
pays fourteen times, and one sealed on turn 16 pays twice. That is the trade
the mode is asking about.

### The raiders

A weighted Dijkstra from the Keep where open floor costs 1, a player wall costs
`wallCost` (4) and a ruin is impassable. Weighting a wall rather than
forbidding it is what makes a wall a *delay* rather than a door. **The number
is a cost, not a countdown** — a distance of 8 is not eight turns away, because
a wall contributes 4 to it and takes one turn to break.

Ties are broken by a draw **keyed to the turn number alone**, not to a run
seed. Two things fall out of that: the intent preview asks the same question
the phase will answer, on every pointer move, without a shared stream letting
the preview change the future it is previewing; and a mission is a puzzle, so
the same plan meets the same raiders doing the same thing on every attempt.

### What the screen says

The HUD is three lines in 64 px, and the order is the argument:

```
      RELIEF IN 12 TURNS
CAPTURED 3        HELD 12
SCORE 940          NEXT RAIDERS: TURN 5
```

The best is not on it: at 360 px a third item on the last row runs into the
forecast, and the forecast is the one a player has to be able to read. The
menu and the game-over screen carry the best instead. A breach warning goes
*under* the board, in the gap above the hand, for the same reason.

No score tiers, no streak, no clock bar, no pace ghost, no BIG ROOM
celebration, no room dissolve or shockwave on enclosure. Instead: a persistent
courtyard fill that appears when ground becomes held and drains when it is
lost, a gold burst where a raider was captured, grey shards and a low knock
where a wall came down, and a breach sequence when the Keep falls. The
first-run card is the siege's own three lines, on its own flag, so meeting one
does not silently spend the other.

Game over is `VICTORY` or `BREACHED`, with captured, held, turns survived and
walls lost — and the two questions the playtest is actually asking, written
out: *Could you read the threats and place what you intended?* and *What would
you build differently?*

### Layout

The siege board is 11×11 and the other three modes stay 9×9. The siege takes
8 px side gutters instead of 16, a 64 px HUD instead of 104, and a board height
capped by what is left after the HUD and the hand rather than by half the
screen. That lands **31 px cells at 360 px wide and 34 px at 390 px**, with
44 px buttons — asserted in `tests/siege.test.ts` against `computeLayout`,
which is the layout arithmetic split out as a pure function so it can be
checked without a browser.

### Tunable knobs

All in `SiegeConfig` (`src/core/Config.ts`) and `src/core/Missions.ts`:
`wallCost` (4), `enemyBonus` (75), `groundIncome` (1), `reliefTurns` (18),
`previewCount` (4), each mission's map, spawn list and supply. The flags
`enemy`, `mission`, `clockMode` and `fenceSurvivesEnemyPhase` are kept in the
config and hidden from the UI: `enemy` still names the tide, whose pathing
survives in `Siege.ts` but is not wired into a turn loop that has no clock for
it to expand on.

### Replays and telemetry

Recording works as it does everywhere else. A skip is logged as
`{ t: 's', at }`, and the simulator spends it exactly as the browser did — a
log that dropped its skips would be one turn out from the first one onward.
Telemetry rides on `variant`, now `m1-raiders-relief18`, with the siege
counters beside it: captured, held at end, turns survived, skips used, walls
lost, breach turn, route-changing placements.

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
  - `leaderboard:enclave:v2:daily:YYYY-MM-DD:tickets` — every id that has been dealt that day's puzzle, written by `api/run-start.ts` as the ticket is issued. The first ask is the player's attempt; every one after it is answered with a practice ticket. Expires with the board. If Redis is unreachable the endpoint deals a normal ticket rather than refusing to deal at all — an outage should cost an extra attempt, not the day.
  - `leaderboard:enclave:v2:daily:YYYY-MM-DD:ids` — every id that submitted that day, ranked or not. Behind the ticket set: it is what still closes the day if that write never happened, and what makes first-submission-wins true for a player whose first run missed the top ten. Expires with the board.
  - `leaderboard:enclave:replays:v2:<board>` — the SHA-256 of each run already banked on that board, so one replay cannot be posted twice. Kept 30 days on a daily board, forever on a permanent one. It is the one key here that grows without bound — 64 bytes per accepted score — and the first candidate for a TTL if a ladder ever gets busy.
  - `leaderboard:enclave:used-tokens:YYYY-MM-DD` — spent run tickets, bucketed by the day the ticket was *issued* so a token can never fall between two buckets. Expires after 2 days, which outlives the 24-hour ticket.
  - `telemetry:enclave:runs` — the newest 5,000 finished runs, aggregated on read.
- The sorted sets are not trimmed to ten. A player who drops out of the top ten keeps their entry, so they can still beat their own score years later, and `GET` only ever reads the top ten. The cost is one member and one hash field (about a hundred bytes) per player who has ever posted a score.
- Bump `CACHE_NAME` in `public/sw.js` on each deploy. The menu shows the `package.json` version in the bottom-right corner, so it is obvious when a new build has arrived.

## Repository map

### Rules

- `src/core/Board.ts`: the grid at whatever size the game asked for, the flood-fill enclosure detection, the lit-floor map, and the siege's terrain and raider-occupancy overlays
- `src/core/Siege.ts`: the second force — the weighted distance field, the raiders' plan/resolve phase, and the intent preview. Pure, and driven by the turn number. The tide's pathing is kept here, unwired
- `src/core/Missions.ts`: the three siege maps as rows of strings, their arrival schedules, their authored supplies, and the terrain semantics table
- `src/core/Pieces.ts`: piece shapes, rotation, the seeded shuffled-bag dealer, and the per-tier bag table
- `src/core/Rules.ts`: `RULES_VERSION` — bump it whenever dealing or scoring changes
- `src/core/Replay.ts`: re-playing a run from its seed and its inputs, and the reconstructed clock
- `src/core/Random.ts`: mulberry32, FNV-1a, and the per-run seed
- `src/core/Daily.ts`: which day it is, and what this browser has done with it. Its `dailySeed` is the old public deal, kept for tests and practice only
- `src/core/Ticket.ts`: the run ticket format, its HMAC, the daily's derived seed and the replay fingerprint. Pure — the secret is a parameter, so it is never bundled into the client
- `src/core/GameState.ts`: the run loop: hand, queue, hold, claims, scoring, streaks, echo walls, territory, clock, piece budget, score timeline — and the siege's own turn, which shares none of the scoring and all of the board
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
- `src/rendering/GridRenderer.ts`: board, lit floor, echo walls, closing hints, placement pops, claim animation, and the siege's held courtyards, captures and wall breaks
- `src/rendering/HandRenderer.ts`: hold slot, current piece, next queue, rotate button, drag piece
- `src/rendering/GhostRenderer.ts`: the drop ghost and the gold claim preview
- `src/rendering/UIRenderer.ts`: HUD (score, pace, tier, best, streak pips, survey, timer or piece budget), and the siege's three lines instead of all of it
- `src/rendering/LayoutManager.ts`: `computeLayout`, one layout for every screen size and board size, as a pure function; the class holds the current one and does pixel → grid
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

An empty cell is "outside" if it can reach the board edge by walking through empty cells. We flood-fill from every empty cell on the border; anything empty that the flood never reaches is inside a fence. Grouping those cells into connected components gives the individual rooms, and the blocks orthogonally touching a room are its fence. On a 9×9 or 11×11 board this runs in a fraction of a millisecond, so it is also used to compute the gold "closing" hints after every move, and to recompute the siege's held ground after every enemy phase.

The fill takes an optional set of extra walls — the echo cells — which hold it back exactly as blocks do. They are reported separately from the fence, because there is no block there for a claim to remove, and their presence is what earns the claim its ECHO multiplier.

## How a score gets on the board

A score has to get past three separate things, and each answers a question the others cannot: the **replay** proves the rules produce that number, the **run ticket** proves somebody played it, and the **fingerprints** stop a proven run from being banked twice.

### The ticket

A run starts by asking the server for one. `POST /api/run-start { id, mode }` answers with the seed the run will be dealt from, the daily's date if it is a daily, and a token:

```
base64url({"v":1,"id":"…","mode":"classic","seed":2748215883,"issuedAt":1757400000000})
  . base64url(HMAC-SHA-256(secret, that same base64url text))
```

The seed is the server's choice — 32 bits from `crypto.getRandomValues` for Classic and Blitz, and for the Daily the first 32 bits of `HMAC(secret, 'enclave-daily-' + date)`, so a future puzzle cannot be dealt and studied offline. The MAC covers the encoded payload, so the seed, the id, the mode and the issue time are one indivisible claim rather than four hints.

A daily payload carries `"dailyKey":"YYYY-MM-DD"`, and a second or later daily ticket for the same id and date carries `"practice":true` as well — a ticket that plays the real puzzle and cannot post a score. Because the flag is inside the MAC it cannot be edited off; the client reads it from the payload segment (plain base64url JSON, no secret needed) to know it should not offer to submit.

`GET /api/run-start?mode=daily` answers the date and the daily number, and no seed. It used to answer the seed too, which handed the shared deal to anybody who asked: a solved daily could then be posted from a fresh id that had never spent an attempt on it. Every mode now takes its deal out of the `POST`, with the ticket that goes with it.

If the request fails — offline, API down, slower than two and a half seconds — the run still plays, on a local seed, and the game-over screen says `NOT VERIFIED · SCORE KEPT LOCALLY` without attempting to submit. On a Daily that means a practice puzzle rather than the shared one.

### The replay

Every run records its inputs: `{ t: 'p', row, col, rot, at }` for a placement, `{ t: 'h', at }` for a hold, and `{ t: 's', at }` for a siege skip, where `at` is the second of the run the input landed on, unrounded. That log, plus the seed and the mode, is the **replay**, and it travels with the score and the token.

The server does not take the score. It re-plays the log — same `GameState`, same seeded bag, same echo window, same territory map — and the score only lands on the board if the run comes out at exactly that number. Everything a score depends on is reproduced: the bag tightens with the score, echo walls fade on `at`, claims light the floor. Colours come from the same RNG draw whatever palette is set, and no rule reads them.

Times are recorded to the full double and the simulation *assigns* them to its clock rather than accumulating gaps, so an echo wall's `expiresAt` — which is `gameElapsed + window` — is bit-identical on both sides and a claim taken a microsecond inside a ghost wall is judged the same way in both places. How long a piece has been sat on rides on the same assignment: it is `gameElapsed − lastPlacementAt` in both places, and both of those are recorded times, so the speed fraction and the time bonus rounded off it are bit-identical too. It used to be accumulated frame by frame in the browser, which put the two sides a few bits apart, and a bonus rounded to a tenth of a second could round one way live and the other way on the server.

The clock is the one thing the server cannot reproduce exactly, because a browser drains it a frame at a time. Instead it reconstructs the bank analytically — the drain rate integrated between moves, closed form — and allows 0.05 s of slack. The client's frame-wise drain uses the rate at the *end* of each frame and the rate never falls, so a browser always drains at least as much as the integral; both sides then add the same bonus, computed from the same doubles, and clamp at the same cap, and clamping is monotonic. The reconstructed bank is therefore never below the bank the browser really had, and the slack absorbs nothing but the noise between one closed-form evaluation and a sum of thousands of per-frame subtractions of it.

Two limits on the log itself: placements at least 0.08 s apart (nobody drags a piece onto a board twelve times a second), and, in a timed mode, no gap over half an hour. A run with no clock has no gap limit beyond the ticket's own day.

### The submission

`POST /api/leaderboard?difficulty=…` carries `{ id, name, score, replay, token }` and is checked in this order:

1. the board exists, and a daily board is today's or yesterday's;
2. the body is under 64 KB, is JSON, and is an object — `null`, `[]` and `"x"` are 400s, and so is a `name` that is not a string;
3. `id`, `name` and `score` have the right types, and `replay` and `token` are present (a client missing either is told `Update required`, not called a cheat);
4. the replay's shape: rules version, mode, seed range, monotonic times, real board coordinates, and that the run's mode matches the board it is posted to;
5. the ticket's MAC verifies, it is not a practice ticket, and its `id`, `mode`, `seed` and `dailyKey` match the body, the replay and the board;
6. the ticket is under 24 hours old and not dated in the future;
7. **the wall clock has allowed the run**: the time since `issuedAt` covers the replay's last move, less two seconds for the countdown and clock skew. A run cannot be played faster than real time, and this is the one check a log's own timestamps can never make;
8. the replay re-plays to exactly the score claimed;
9. the ticket has not been spent (`SADD` on the used-token set — a ticket is one run);
10. the solution has not been banked (`SADD` of its fingerprint — one solution is one score);
11. on a daily, the player has not already submitted today (`SADD` on the per-day id set, which counts a first score whether or not it ranked);
12. and only then the write: `ZADD ... GT` on a permanent board, `ZADD ... NX` on a daily, with the name and date going into the meta hash beside it.

Everything before step 9 is a pure function of the request, so a submission that fails any of it has spent nothing. From step 9 on it consumes state, which is what makes each of those a one-shot.

### The fingerprint

The dedupe hashes **the deal and the placements, and not their timing**: the seed, the mode, the daily's date, and each move as `p, row, col, rot` or a bare `h`. Two submissions of the same placements are one run whatever the clock said.

The times used to be in it, and that made the dedupe trivial to walk around. A daily replay is a document, every player of a date is dealt the same seed, and nudging one `at` by a microsecond made a different fingerprint out of the same solution — so a passed-around run could be posted again under a fresh id. Timing is not part of what a run *is*; in the Daily it cannot even affect the score.

`RULES_VERSION` in `src/core/Rules.ts` guards the whole arrangement. Bump it whenever dealing or scoring changes: old replays will no longer re-play to their scores, the boards move to fresh keys, and the server answers stale clients with `Update required` rather than calling them cheats.

## Known limitations

- **Verification proves the run, not the player.** A bot that scripts legal moves through the real rules, at human speed, produces a run that is real in every sense the server can test: it was dealt a ticket, it took as long as it says, and the rules pay it that score. What is closed is the fabricated score, not the automated one. Closing that needs something none of this is — behavioural analysis, or an account.
- **Tickets can be collected in advance.** `/api/run-start` will mint one for any id that asks, so a patient attacker can hold a batch of them. It buys nothing but patience: each is single-use, bound to one seed, and still has to wait out the run it vouches for in real time. There is no rate limit on the endpoint yet — and now that a daily ticket writes an id into that day's ticket set, an unauthenticated flood of daily asks writes a set member each (bounded at 64 bytes by the id format, and gone in eight days). A rate limit is the answer to both, and there still is not one.
- **A new browser identity is a new player.** The daily's one-attempt rule is enforced against the id in `localStorage`, so clearing it, or opening a private window, buys another attempt at today's puzzle — and a solution can still be shared with somebody who has not played yet, at the cost of their own attempt. The fingerprint stops the same solution being banked twice on a board and the ticket set stops one id playing twice, but nothing here can tell two browsers from two people. That needs accounts, which is a product decision rather than a missing check.
- **The clock check has 0.05 s of slack**, down from a second. The argument that an honest run cannot fail it is in `drainIntegral`, `CLOCK_SLACK_SECONDS` and above. It rests on the two sides computing the *same* time bonus, which they now do because `pieceElapsed` is derived from the recorded times rather than accumulated per frame; while it was accumulated, the tenth-of-a-second rounding could flip and an honest run finishing on 0.035 s reconstructed to −0.065 s and was refused.
- **A run past 600 recorded inputs is playable but unprovable.** The log stops at the cap, is marked `truncated`, and the server refuses it. Six hundred placements is far past what any bank can fund.
- **A score kept locally is not a shared score.** When the server refuses one, or the run never got a ticket, the game says so under the board instead of implying it went out.
- **The siege is a graybox and posts nothing.** No leaderboard, no run ticket, no server validation; the best is per mission and lives in `localStorage`. Its `RULES_VERSION` is shared with the other modes, so a siege replay is only reproducible against the build that recorded it. `api/leaderboard.ts` accepts three modes and the siege is not one of them, so an 11×11 coordinate or a skip can never reach it.
- **The siege's numbers are first-pass.** Eighteen turns, the 75-point capture, one point a cell a turn, the wall cost of 4 and M1's arrival schedule are all placeholders the playtest is meant to move.
- **The siege's presentation has not been seen in a browser by whoever wrote it.** The rules, the resolution order, the replay round trip and the layout arithmetic are covered by tests; how it *reads* on a phone is exactly what the playtest is for.
- **Starting a run mints an anonymous id**, because a ticket has to be bound to one. A player who never posts a score used to stay unidentified; now the id exists from the first run. It is a random UUID in `localStorage`, it is never returned by `GET`, and nothing else is stored against it.
