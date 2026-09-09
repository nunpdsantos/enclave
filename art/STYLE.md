# ENCLAVE / Siege art bible

## Current direction: Square v3

The owner's selected `01-keep-reference.png` governs proportions, warm sandstone,
cool slate shadow, cobalt cloth, crenellations and forecourt paving. The board
must read first at **32 CSS px per cell, DPR 3 (96 device px)**, then stay legible
at DPR 1. The previous silhouette freeze and 10% course modulation are withdrawn.
Square v1 and Square v2 remain immutable visual comparisons. No gameplay or
`src/` / `api/` changes belong to this track.

Broad silhouette, mass, four value bands, directional light and cast shadow do
the work. No grain, scratch textures or tiny random surface decoration. Player
cloth has two squared tails with a deep central notch; enemy cloth has one point.
Cobalt right-angle inlays and amber centres reinforce ownership independently of hue.

## Reference sampling and palette

Reference: `/Users/nunosantos/Desktop/ENCLAVE/concepts/01-keep-reference.png`,
1232×928. Samples are per-channel medians of the specified pixel rectangles
(left, top, right, bottom; exclusive right/bottom), not guessed colour names.
`verification/reference-samples-v3.json` records the source hash and measurements.

| Reference area | Rectangle | Sample |
| --- | --- | --- |
| Sunlit sandstone | 477,464,494,485 | `#F5DBAE` |
| Warm top stone | 632,165,649,174 | `#DDB58D` |
| Cool stone shadow | 771,557,785,576 | `#343F40` |
| Door recess | 536,634,548,661 | `#1C201A` |
| Slate background | 70,200,150,280 | `#586D83` |
| Cobalt cloth in shadow | 521,403,536,463 | `#233143` |

Four **authored face bands** remain the backbone: recess, cool body shadow,
mid-value body, pale light. Unlike v1/v2, v3 does not force every hue to identical
luma targets. Direct reference samples span a wider range. Shader courses,
right-side tint, AO, edge antialiasing and translucent shadows produce intermediate
values. Equal-luma historical palette checks still apply to Diamond, not v3.

| Family | L0 recess | L1 shadow | L2 body | L3 light |
| --- | --- | --- | --- | --- |
| Sandstone v3 | `#1C201A` | `#343F40` | `#A5845E` | `#F5DBAE` |
| Slate v3 | `#202C39` | `#586D83` | `#808F9F` | `#C2D0DE` |
| Paving / parchment v3 | `#232019` | `#554B3A` | `#BBA98E` | `#C8BBA5` |
| Roof deck v3 | `#1C201A` | `#344346` | `#455356` | `#66706A` |
| Cobalt, retained | `#0C2146` | `#294CA8` | `#7093C8` | `#C0D0EF` |
| Oxblood, retained | `#3C111D` | `#902B42` | `#C47485` | `#EFC0C7` |
| Torch, retained | `#351717` | `#85391D` | `#D27E33` | `#F3CC77` |

**Changed sandstone:** old `#1F2023 / #514B42 / #9C8C73 / #DDCDAA` becomes the
v3 row. Recess, shadow and light are direct samples. L2 `#A5845E` is an authored,
darker golden translation of sampled `#DDB58D`, deliberately preserving a clear
front-to-top separation at phone scale; it is **not a direct sampled pixel**.
Slate L0/L1 changed from `#1B2026 / #424E5B`. Paving L2/L3 changed from
`#A18C6B / #DFCDAE` to a closer, quieter warm/cool pair. Roof deck is new.
Sampled dark cloth is documented, while the brighter existing cobalt is retained
for ownership readability. Palette implementations are in `blender/v3.py`;
`geometry.py` retains the historical ramps.

## Camera, dimensions and anchors

Square stays orthographic, **60° elevation, azimuth 0°**, upright axes, no roll.
Logical `(x,y,z)` maps to `(-y/sin(60°),x,z)` in Blender. Ground depth compensation
is 1.154700538; one world cell projects to 128×128 source pixels at 2×, or 64×64
nominal pixels. Screen mapping is `(anchorX+128x, anchorY-128y-64z)`.

| Frame class | Source size | Ground anchor in pixels | JSON normalized anchor |
| --- | --- | --- | --- |
| Keep only | 256×288 | 128,192 | 0.5, 2/3 |
| Walls and gates | 192×192 | 96,112 | 0.5, 7/12 |
| Other Square sprites | 192×192 | 96,96 | 0.5, 0.5 |

The taller keep extends above its cell. Its 1×1 ownership footprint is unchanged;
its physical plinth is about .95×.59 units, with forecourt threshold still inside
the cell. Width and depth are deliberately different to expose a taller front in
the fixed high-angle square view. Opaque raster bounds are 120×174, ratio 1.45.
Only the keep frame grows; wall/gate anchors move down to hold their raised north
geometry without clipping. Ground cell spacing never follows frame size.

Pixi uses `meta.scale: "2"`; the keep texture is 128×144 logical pixels, the
others 96×96. **Always use each frame's anchor**, not `anchor.set(.5)` or the
atlas default `enclave.groundAnchor`. The preview does this and checks dimensions.
Rendering a taller portrait frame requires orthographic scale `max(w,h)/128`,
with camera target offset along its up axis to place the specified anchor.

Square board columns step `(64,0)`, rows `(0,64)`. Draw floors and tide first,
then objects by row, column and raised height; draw target markers last. Wall
banners rise .52 units, or 16.64 nominal pixels. A 9×9 phone board uses 288×288 CSS
pixels centred within 360×360. DPR 3 produces 1080×1080 with 96 device px cells.
The preview now honours devicePixelRatio up to 3 with Pixi autoDensity.

Historical Diamond remains 60° elevation, -45° / 315° azimuth, ortho scale sqrt(2),
128×128 source frames, centre anchors, column step `(32,27.7128129211)` and row
step `(-32,27.7128129211)`. Its atlas and the earlier hero studies are retained.
A strict azimuth-zero Square view cannot expose the reference's full east face;
side mass is communicated through caps, side runs, recesses and cool right falloff.

## Geometry and materials

`blender/v3.py` rebuilds Square while leaving historical `geometry.py` intact.
The keep uses a raised shaft, tapered corner buttresses with sloped tops, threshold,
five-wedge arch with a dark recessed portal, thick parapets and merlons on all four
sides. The roof has separate dark stone slabs and a walking border, not a black
hole. Folded hanging cobalt cloth, a thin pole and small notched flag, brazier
bowl/bars/flame, and an authored amber light pool complete the silhouette.

Walls grow from .44 to **.60** width, .25 to **.52** body height, and .14 to **.20**
merlon height. Merlons are .175 wide. The 3×3 occupied-footprint algorithm re-derives
all 16 join masks, with open joins reaching exactly ±.5; U=1, D=2, L=4, R=8.
The inset walking strip follows all connected arms. No finished sprite rotates.
Gate piers/arches and ruins rise 23%. The raider gains a helmet ridge and shield
boss; its silhouette and the ownership banners retain their established shapes.
All standing objects receive directional ground shadows.

Six large offset pavers have clipped corners and visible joints. Paving colours
alternate gently between warm and cooler stone; courtyard variants keep the cobalt
inlay and amber centre/step. Broad repeated slabs are intentional, not random grain.

The fixed logical key is `(-.45,-.60,.80)`, weight .76; fill `(.7,.2,.5)`, weight .12;
ambient .12. Normal thresholds .20/.47/.72 select four face bands. Warm light and
cool shadow are authored in those bands, with a broad cool right-side UV falloff.
The named Blender sun lights document the rig; EEVEE **emission bakes** carry the
colours, so these are not physically ray-lit diffuse materials.

`materials_v3.py` uses logical UV ashlar: .36-unit brick width, .20-unit course
height, .012-unit mortar, .002-unit smoothing. Mortar multiplier is .40 in linear
light (60% shader modulation), which measures **31.30% display-luma contrast** on
the wall-12 front at source 2×. Do not confuse shader modulation with measured
sRGB contrast. AO contributes at most 16% linear darkening over .16-unit distance.

Cast shadows project mesh vertices to `(x+.25z,y-.16z)` on the ground, merge them
into a convex silhouette, and render cool `#16273C` at .48 alpha in Blender. They
extend lower-right and are intentionally hard and broad. Convex hulls merge small
crenellation gaps; they are stylised cast silhouettes, not physical light transport.
No opaque receiver rectangle, image-editor paintover, shell Blender or software
fallback is used. The brazier warmth is an authored deck pool, not a live point light.

## Reproduction and acceptance

Every asset render uses the MCP server `blender`, tool `blender_run_script`:

```json
{"script":"/Users/nunosantos/Projects/enclave-art/art/blender/kit.py","args":["--projection","square"],"cwd":"/Users/nunosantos/Projects/enclave-art","timeout_ms":900000}
```

`blender_python_expr` health-checks Blender version and mesh/render APIs. Do not
invoke Blender from the shell or use `render.sh`. `--only NAME` is for diagnosis;
run the full kit again before delivery so the manifest agrees with all frames.

```sh
python3 art/pack.py --projection square
python3 art/check_assets.py --projection square
node art/verify.mjs
```

Square acceptance assembly uses installed Pillow and NumPy with `python3`.
`ART_PYTHON` can override the verification interpreter. Packing uses the existing
standard-library PNG codec, two extruded texels and two clear gutter texels.
The keep occupies a dedicated final shelf; 30 normal frames keep their slot positions.
The resulting atlas is 1584×1086, 31 frames, below the 2 MB limit. Unused shelf
space is transparent and compresses cheaply.

Difference is measured over corresponding frame names registered to their ground
anchors, using only pixels fully opaque (alpha 255) in **both** versions. This
avoids inflating the score with moved packing positions, new padding or black RGB
under transparency. Acceptance is at least 40/255 mean absolute RGB channel delta.
The opaque-union comparison over slate is reported separately. Keep aspect uses
alpha≥250 silhouette bounds and excludes its translucent cast shadow.

`verification/before-after-v3.png` shows the requested eight comparisons at actual
phone DPR 3, 96 device px/cell. `keep-v3-3x.png` uses the same scale. Phone composites
are assembled from the shipped atlas, not screenshots or new 3D renders.
`verify_v3.py` checks all source/atlas bytes, preserved v1/v2 hashes, all 16 joins,
geometry and alpha bounds, exact square cell raster, shadows, dimensions and anchors.
`verify.mjs` parses all four atlases with installed Pixi and runs the actual preview
script with DOM/GPU adapters, switching versions and testing controls and cell picking.
These adapters do not establish live CDN, WebGL or physical-phone behaviour.

See `REPORT-geometry-v3.md` for final measurements, visual caveats and owner questions.

## Ten concept-sheet prompts for the owner

These are historical prompts only, superseded by the selected Keep reference
above wherever their no-masonry wording conflicts. No image model was called. Run them in ChatGPT yourself;
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
