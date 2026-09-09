# ENCLAVE / Siege art bible

## Intent and scope

A tactile strategy table: a living medieval map, built from short sandstone
fortifications, slate ground and weathered parchment. Cobalt cloth and warm
torchlight mark the player. Oxblood cloth, iron, smoke and embers mark the siege.
Enclosed ground becomes a warm, visibly patterned courtyard. Broad silhouettes
and four value bands do the work; no brick textures, scratches, bevel noise,
specular gloss, neon bloom, gore or tiny surface decoration.

Authority: section 4 of the owner's **ENCLAVE - direction v3.md** (2026-09-09).
This kit is an art study. The enemy model and the graybox's playtest outcome are
not decided by these assets. No game rules or production renderer were changed.

The inspected worktree started clean at `e3b61cb` on `art`. There was no `art/`
directory or siege kit in `public/`. The existing playbook, PWA files and icons
are retained. The playbook's direct imperative tone informs the preview copy.
`Theme.ts` currently uses night blue `#2B3A86`, accent `#4A7AF7`, and danger
`#EF4444`; this new asset palette proposes the siege identity independently.

## Palette and four luminance levels

The levels use the same brightness measure as `Theme.ts`'s `luminance()`:
`Y' = 0.299 R + 0.587 G + 0.114 B` on 8-bit sRGB. This is display luma, not
physical linear-light luminance. All six ramps hit the same four targets within
2/255; this deliberately prevents hue from substituting for value hierarchy.

| Level | Target Y' | Purpose |
| --- | ---: | --- |
| L0 / recess | 32 (12.5%) | Iron recesses, doorway, roof well, deepest shadow |
| L1 / body shadow | 76 (29.8%) | Slate ground, cobalt and oxblood cloth, stone side |
| L2 / body light | 142 (55.7%) | Warm courtyard, sandstone lit face, broad colour accent |
| L3 / light | 206 (80.8%) | Stone caps, pale parchment, torch and intent accents |

| Family | L0 | L1 | L2 | L3 |
| --- | --- | --- | --- | --- |
| Sandstone | `#1F2023` | `#514B42` | `#9C8C73` | `#DDCDAA` |
| Slate / iron / smoke | `#1B2026` | `#424E5B` | `#808F9F` | `#C2D0DE` |
| Weathered parchment | `#232019` | `#554B3A` | `#A18C6B` | `#DFCDAE` |
| Cobalt | `#0C2146` | `#294CA8` | `#7093C8` | `#C0D0EF` |
| Oxblood | `#3C111D` | `#902B42` | `#C47485` | `#EFC0C7` |
| Torchlight / ember | `#351717` | `#85391D` | `#D27E33` | `#F3CC77` |

Four levels means four authored **interior face values per hue**, with matching
brightness across hues. Antialiasing, translucent tide and compositing necessarily
produce intermediate pixel values. Do not posterise alpha edges to force four
literal colours into the PNG; it damages silhouettes at phone size.

Player: two squared banner tails separated by a deep notch, cobalt right-angle
floor inlays and square warm centres. Enemy: a single pointed cloth tail, pointed
shield, and repeated floor chevrons. Intent: four pale corner brackets with an
oxblood direction wedge; its open centre leaves the destination visible. A colour
change alone is insufficient for any ownership or threat state. Greyscale review
is a structural check, not a claim of validated colour-vision accessibility.

## Camera, scale and integration contract

### Diamond (original, default)

- Orthographic; elevation **60° above the ground** (30° down from vertical).
  Azimuth **315° / -45°**, measured from +X toward +Y. Camera is southeast at
  `(+X, -Y, +Z)` looking at the origin. No perspective, tilt or camera roll.
- One logical cell = **1 × 1 Blender units**, nominal **64 px tile width at 1×**.
  Every gameplay PNG is **128 × 128 RGBA at 2×**. Orthographic scale is `sqrt(2)`
  Blender units, so the projected diamond of one cell spans exactly 128 rendered
  pixels horizontally. Ground centre is pixel `(64,64)` in every asset.
- **64 px means the whole projected diamond width**, not the distance between
  neighbouring centres. A rotated square cannot both fit a 64 px bounding box
  and have 64 px projected edges. At 1×, grid steps are:
  `column = (+32, +27.7128129211)`, `row = (-32, +27.7128129211)`.
  Ground diamond height is `55.4256258422` px. Sprite anchor is `(0.5,0.5)`.
- A 9×9 diamond is 576 px wide and about 499 px high at nominal 1×. The preview
  also draws 32 px tiles, producing a 288 px board that fits a phone. At 60° the
  front faces remain visible, but floor exposure is larger than a low 30° view.
  A 45° azimuth gives equal weight to both board axes and exposes wall thickness.
### Square oblique

- Orthographic camera at **60° elevation, azimuth 0°**, looking from
  `(+X, 0, +Z)` at the origin, no roll. Azimuth uses the same +X reference as
  Diamond. Logical geometry is mapped `(x,y,z) → (-y/sin(60°), x, z)` before
  rendering: logical south/front faces face the camera, columns go right and
  rows go down. The 90° coordinate remap does not rotate the on-screen board.
- A camera change alone would make rectangular cells. The **1.154700538× ground
  depth compensation** cancels foreshortening; heights are unchanged. With
  **192×192 px frames and ortho scale 1.5**, the projection is exactly
  `(96 + 128x, 96 - 128y - 64z)` at 2×. Thus a ground cell is exactly
  **64×64 px at 1×**, column step `(64,0)`, row step `(0,64)`.
- Ground centre retains the same normalized **anchor `(0.5,0.5)`**, now pixel
  `(96,96)`. Pixi frames are 96×96 logical pixels with `meta.scale:"2"`;
  **frame size is not cell spacing**. Transparent margins contain the raised
  north wall and the oversized axe without clipping or changing the 64 px grid.
- **Why 60°:** the parapet front is 8 px high at 1×, with 4.48 px of merlon
  height. At 55° these would be 9.18 / 5.14 px, with 22.1% depth compensation;
  at 65°, 6.76 / 3.79 px, with 10.3% compensation. These are geometric
  comparisons, not three rendered studies. 60° balances visible fronts with
  exposed floor area; the 32 px phone composite retains the wall silhouette.
- Square uses rows for back-to-front object ordering, then column and height
  within a row. Wall banners rise 8 px (the parapet height). Diamond retains
  `row + column` ordering and its 5.66 px banner rise. Floors and tide draw first;
  intent brackets draw last. East/west gate arches appear edge-on in Square.
- A 9×9 Square board occupies 576×576 px at 1×, or 288×288 px at phone scale.
  Preview canvases include margins: 608×624, 1216×1248, and 304×312 px.
- Use **Square for the phone puzzle**: cell ownership, orthogonal piece shapes,
  rotations and touch regions share the same screen axes. Use **Diamond for
  dioramas, campaign views or art presentation** where seeing two wall faces is
  useful and direct grid manipulation is secondary. This preview does not
  integrate either projection into the game or validate dragging on a device.

### Shared geometry

- Wall width **0.44 units**; parapet **0.25**; merlons **0.14** above it. The keep's
  crown reaches **0.685**, plus its small flag. Height stays subordinate to cell
  ownership. Joined wall ends reach exactly `±0.5`, without a decorative cap.
- The raider is an intentionally oversized tabletop figure, 1.45 times its
  primitive construction dimensions (0.783 units tall). Human/building scale is
  symbolic: its helmet, shield, axe and boots need to survive a 32 px tile.
- `+X = right`, `+Y = up`, row increases toward `-Y`. Wall masks:
  `mask = (up ? 1 : 0) | (down ? 2 : 0) | (left ? 4 : 0) | (right ? 8 : 0)`.
  Render **all 16 masks**, including isolated 00 and cross 15. No 2D sprite
  rotations or reflections: they would rotate the baked light and the projection.
- Gates `n/e/s/w` identify the board edge they open onto. All four are rendered
  from rotated world geometry; the camera and lighting stay fixed.
- To raise a sprite by `z` logical world units, move it up by
  `z * cos(60°) * 64 / sqrt(2)` logical pixels in Diamond, or `z * 32` in Square.
- Square's board basis agrees with the game's axis-aligned grid. Integration
  still needs to respect the larger padded frames and existing game sizing.
  Diamond would additionally need projected placement and inverse hit-testing.
  No `src/` or `api/` edits are part of this art branch. Relative to the first
  centre, Square inspection uses `col=floor(x/64 + .5)`, `row=floor(y/64 + .5)`.
  Diamond uses `dx=x/32`, `dy=y/27.7128129211`, then
  `col=floor((dy+dx)/2 + .5)`, `row=floor((dy-dx)/2 + .5)`.
  Both reject out-of-board cells.

## Light rig and geometry

Fixed world-space key direction `(-0.45,-0.60,0.80)`, normalised, weight `0.76`.
Fill direction `(0.70,0.20,0.50)`, normalised, weight `0.12`. Constant ambient
weight `0.12`. Face brightness is ambient plus positive normal dot products with
key and fill; thresholds `0.20`, `0.47`, `0.72` choose L0 through L3. This reads
as a broad upper-left key, with the right face darker. No moving sun.

`geometry.py` bakes those bands per flat polygon in logical coordinates, before
the Square coordinate transform. Both projections preserve the authored palette. `kit.py` creates named sun rig
objects and uses EEVEE emission materials for the already baked colours, so
continuous renderer lighting cannot add extra shades. This is an intentional
four-step light bake, not physically based material lighting. Standard colour
transform, no AgX grading, exposure 0, gamma 1. No AO, cast-shadow texture or
bloom. Torch warmth is a reserved colour mass; live flicker belongs in Pixi later.
Tide alpha is 0.64, chevrons 0.85, smoke 0.40. Geometry and ember positions are
deterministic. EEVEE transparency and antialiasing may differ from the CPU fallback.

Mesh sources are primitive boxes, a tiled wall footprint, low-sided cylinders,
five arch wedges and flat cloth polygons. Keep shapes broad enough to trace from
a concept sheet. Change the named proportion constants before editing individual
vertices. No external assets or new packages are required.

## Files, atlas and reproduction

Render with the **Blender MCP server**, which runs outside the shell sandbox.
The shell Blender path crashes during Metal detection on this machine. Do not
use the legacy `render.sh` here. Call `blender_run_script` twice:

```json
{"script":"/Users/nunosantos/Projects/enclave-art/art/blender/kit.py","args":["--projection","diamond"],"cwd":"/Users/nunosantos/Projects/enclave-art","timeout_ms":900000}
{"script":"/Users/nunosantos/Projects/enclave-art/art/blender/kit.py","args":["--projection","square"],"cwd":"/Users/nunosantos/Projects/enclave-art","timeout_ms":900000}
```

Then pack and verify from the repository root (Python 3.10+):

```sh
python3 art/pack.py --projection diamond
python3 art/pack.py --projection square
node art/verify.mjs                 # checks both atlases, including geometry
python3 art/check_assets.py --projection diamond
python3 art/check_assets.py --projection square
npm run dev
# Open the reported local URL followed by /art-preview.html
```

`ART_PYTHON` overrides the verification interpreter; its default is Blender's
bundled Python at `/Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13`.
MCP args can include `--save-blend` (writes `kit.blend` or `kit-square.blend`),
or `--only wall-07` for an isolated inspection. Run a full build before packing
and delivery so the manifest and all images agree. The historical CPU fallback
is Diamond-only; it is not used for these renders.

Source names use lowercase kebab-case. `wall-00` through `wall-15` use decimal
two-digit masks, not binary strings. `floor-*` is terrain, `banner-*` ownership,
`enemy-*` provisional opposition. Keep those roles separate from gameplay enums;
replace `raider()` or `tide()` in `geometry.py` without changing the common kit.

`art/renders/` holds 31 untrimmed 128 px Diamond frames; `art/renders-square/`
holds the same 31 names at 192 px. Each also has the 384 px 3×3
`sample-board.png` and `render-manifest.json`. The sample is excluded from the
atlas. `art/pack.py` uses a standard-library PNG reader/writer, 8 columns, two
extruded texels per edge, two clear texels between slots. No trimming, rotation or
resampling. Diamond atlas dimensions are 1072×536; Square is 1584×792. Each has a
checked limit below 2,000,000 bytes. PNG data is straight alpha; edge filtering averages premultiplied colours.

Pixi v8 JSON has `frames[name].frame = {x,y,w,h}`, `rotated:false`,
`trimmed:false`, full `sourceSize` / `spriteSourceSize`, centre anchors,
`meta.image:"atlas.png"` or `"atlas-square.png"`, **`meta.scale:"2"`**. Pixi
loads Diamond frames at 64 logical pixels and Square frames at 96 logical pixels.
Both use 64 px cells; `enclave` metadata records projection, frame size, ground
anchor, camera and board basis steps. The preview explicitly checks that
contract. `enclave.engine` exposes render provenance. Never relabel CPU output as
Blender output. Generated files include no timestamps inside PNGs.

`art/verification/pipeline.json` and `pipeline-square.json` record measured render time, atlas bytes,
frame count and SHA-256 hashes. `art/verify.mjs` exercises the installed Pixi v8
spritesheet parser, preview frame contract and PNG/atlas structure. The preview
uses the owner-requested jsDelivr v8 URL, whose resolved minor version can change;
actual browser checks must be reported separately from installed-library checks.
Both projections have separate `geometry`, `preview` and board-composite files,
with `-square` suffixes for Square. `blocked-checks.txt` records current limits.

## Ten concept-sheet prompts for the owner

These are prompts only. No image model was called. Run them in ChatGPT yourself;
use the output as a reference to trace in Blender, not as independent gameplay
sprites. Each prompt repeats the camera and palette to prevent drift. The model
may not reproduce exact hex values; the procedural kit remains authoritative.

### 1. Keep tower

ENCLAVE concept sheet of one squat square keep, broad sandstone plinth, four
oversized corner crenellations, dark roof well, one large doorway, cobalt
double-tail notched flag and a single warm brazier. Tactile medieval strategy-table
miniature. Fixed orthographic camera, 60° elevation, azimuth 315° from +X, no roll
or perspective, one-unit square footprint, framed with generous margin. Palette:
sandstone #9C8C73 and #DDCDAA, slate #1B2026 and #424E5B, parchment #DFCDAE,
cobalt #294CA8, oxblood #902B42 only as an optional opposing swatch, torch #F3CC77.
Broad upper-left key, restrained right fill, four flat luminance bands, no fine
detail, no bloom. Transparent background or plain #1B2026. No text, labels or logos.

### 2. Crenellated wall segments

ENCLAVE concept sheet of short, thick sandstone wall modules: isolated block,
straight run, corner, T junction and cross, with large alternating merlons and
an obvious walkway thickness. Arrange as separated miniatures with equal scale.
Fixed orthographic camera, 60° elevation, azimuth 315° from +X, no perspective or
roll. Each cell is one world unit; walls occupy 0.44 unit width and 0.39 total
height. Sandstone #9C8C73 / #DDCDAA, slate #1B2026 / #424E5B, parchment #DFCDAE,
cobalt #294CA8, oxblood #902B42, torch #F3CC77; accents very sparse. Broad upper-left
key and restrained right fill, four flat luminance bands, no mortar texture or
small surface detail. Transparent or plain #1B2026 background. No text or labels.

### 3. Border gate arch

ENCLAVE concept sheet of a squat open medieval gate arch fitting one border
cell, two thick piers, five large arch stones and two broad crenellations, a
single pointed oxblood pennant. The opening must be real negative space, wide
enough for a miniature raider. Fixed orthographic camera, 60° elevation, azimuth
315° from +X, no roll or perspective; same one-unit scale as the wall kit.
Sandstone #9C8C73 / #DDCDAA, slate iron #1B2026 / #424E5B, parchment #DFCDAE,
cobalt #294CA8, oxblood #902B42 and ember #F3CC77. Broad upper-left key, quiet
right fill, four flat luminance bands. Tactile strategy table, no masonry noise,
no cinematic smoke. Transparent or plain #1B2026 background. No text or labels.

### 4. Ruins

ENCLAVE concept sheet of two clearly different old fortification ruins: one
upright broken pier with a fallen lintel; one low collapsed corner with three
large rubble masses. No gravel or tiny chips. Keep each within a one-unit cell.
Fixed orthographic camera, 60° elevation, azimuth 315° from +X, no roll or
perspective. Sandstone #9C8C73 / #DDCDAA over slate #1B2026 / #424E5B; parchment
#DFCDAE, cobalt #294CA8, oxblood #902B42, torch #F3CC77 restricted to a small
palette strip made of unlabelled colour squares. Broad upper-left key and quiet
right fill; exactly four flat value bands. Tactile medieval tabletop sculpture.
Transparent or plain #1B2026 background. No text, symbols, lettering or logos.

### 5. Raider figure

ENCLAVE concept sheet of a low-poly raider miniature that reads at 32 pixels:
oversized iron helmet, broad oxblood cloak, two separated boots, a pointed shield
and one short chunky axe. No face detail, fingers, armour studs or realistic
violence. Fixed orthographic camera, 60° elevation, azimuth 315° from +X, no roll
or perspective; oversized tabletop figure under 0.8 units tall in a one-unit cell. Slate iron
#1B2026 / #424E5B, oxblood #902B42, sandstone #9C8C73 / #DDCDAA, parchment
#DFCDAE, cobalt #294CA8 reserved for a separate ally reference, ember #F3CC77.
Broad upper-left key, quiet right fill, four flat luminance bands. Transparent
or plain #1B2026 background, no cast ground. No text or labels.

### 6. Spreading tide

ENCLAVE concept sheet of a provisional spreading siege tide across a three-cell
diamond patch: translucent oxblood ground, two broad chevrons per cell, two
simple iron-dark smoke masses and a few large ember flecks. Show the underlying
floor through the tide. Tactile strategy-table tokens, no fluid simulation,
tentacles or noisy particles. Fixed orthographic camera, 60° elevation, azimuth
315° from +X, no perspective or roll, one-unit cells. Oxblood #902B42, slate
#1B2026 / #424E5B, ember #F3CC77; sandstone #9C8C73 / #DDCDAA, parchment
#DFCDAE and cobalt #294CA8 only on the underlying floor. Broad upper-left key,
restrained fill, four flat value bands. Transparent background. No text or labels.

### 7. Courtyard floor

ENCLAVE concept sheet of three one-unit floor tiles: quiet slate paving, a warm
claimed courtyard with a cobalt right-angle inlay and square amber centre, and
a second courtyard with one broad raised garden bed. Four large paving slabs,
no small stone texture. Fixed orthographic camera, 60° elevation, azimuth 315°
from +X, no roll or perspective. Palette slate #1B2026 / #424E5B, parchment
#A18C6B / #DFCDAE, sandstone #9C8C73 / #DDCDAA, cobalt #294CA8, oxblood
#902B42 confined to a separate unlabelled enemy chevron swatch, torch #F3CC77.
Broad upper-left key, quiet right fill and four flat luminance bands. Transparent
or plain #1B2026 background. No text, lettering or labels.

### 8. Ownership banners

ENCLAVE concept sheet of two readable miniature banners on plain iron poles:
cobalt player cloth with two squared tails separated by a deep central notch;
oxblood enemy cloth ending in a single spear point. Broad flat cloth, no crest,
sewing, texture or tiny fringe. Fixed orthographic camera, 60° elevation, azimuth
315° from +X, no roll or perspective. Turn the flag faces toward the camera so
their distinct bottom silhouettes survive at phone scale. Cobalt #294CA8,
oxblood #902B42, iron #1B2026 / #424E5B; sandstone #9C8C73 / #DDCDAA, parchment
#DFCDAE and torch #F3CC77 as sparse supporting colours. Broad upper-left key,
quiet fill, four flat value bands. Transparent background. No text or logos.

### 9. World map parchment

ENCLAVE concept sheet of a weathered parchment campaign map laid on a dark
slate strategy table, four broad terrain regions indicated by simple contours
and chunky miniature gate, ruin, city and keep silhouettes. Leave blank areas
for future UI placement; invent no place names. Fixed orthographic camera, 60°
elevation, azimuth 315° from +X, no roll or perspective. Parchment #A18C6B /
#DFCDAE, slate #1B2026 / #424E5B, sandstone #9C8C73 / #DDCDAA, cobalt #294CA8
for player route markers, oxblood #902B42 for threat markers, torch #F3CC77.
Broad upper-left key, restrained right fill, four flat luminance bands. No paper
grain or tiny map detail. Plain #1B2026 background. No text, numbers or labels.

### 10. UI frame

ENCLAVE concept sheet of a restrained medieval tabletop UI frame: thick slate
plate, weathered parchment inset, broad clipped corners, cobalt notched tab for
the player and oxblood pointed tab for the enemy, one warm torch-coloured focus
edge. Show a single frame as a shallow object with a generous blank centre,
not a finished interface. Fixed orthographic camera, 60° elevation, azimuth 315°
from +X, no roll or perspective. Slate #1B2026 / #424E5B, parchment #A18C6B /
#DFCDAE, sandstone #9C8C73 / #DDCDAA, cobalt #294CA8, oxblood #902B42, torch
#F3CC77. Broad upper-left key, quiet right fill, four flat luminance bands, no
filigree, grain, gloss or tiny details. Transparent background. No text or icons.
