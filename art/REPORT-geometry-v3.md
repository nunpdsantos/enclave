# Square v3: geometry and phone-scale readability

The v2 material pass did not change what read at phone scale. V3 changes the
silhouette and mass, then uses broader masonry and stronger value separation.
The measurable gates pass. The result remains a stylised square-projection board
kit; it does not reproduce the reference's painterly finish or two-face camera view.

## What changed

- **Keep:** a taller shaft, corner buttresses with sloped tops, recessed dark arch,
  thick four-sided crenellations, separate roof-deck slabs and walking border,
  hanging folded cobalt cloth, pole/notched flag, and a brazier with an amber deck
  pool. It owns one cell. The depth is shortened to expose its taller front in
  the fixed 60° / 0° camera. Opaque bounds are 120×174 pixels.
- **Walls:** width .44 → .60; body height .25 → .52; merlon height .14 → .20.
  Broader merlons, inset continuous walking strips and re-derived 16 join masks.
  Body/top separation, a cool right-side tint and broad courses replace flat tabs.
- **Other objects:** gates and ruins are 23% taller. The raider gains a helmet ridge
  and shield boss. All standing objects, including banners, gain directional cool
  cast silhouettes. Existing player double-tail and enemy pointed shapes remain.
- **Ground:** six large staggered, clipped-corner slabs with visible joints and
  restrained warm/cool variation. Courtyards retain cobalt inlays and amber accents.
- **Palette:** direct sampled sunlight `#F5DBAE`, stone shadow `#343F40`, recess
  `#1C201A`, and slate `#586D83`. Sandstone body `#A5845E` is an authored darker
  translation, not claimed as a direct sample. STYLE.md lists old/new values and
  every sample rectangle. Four ordered face bands remain the backbone.

## Acceptance results

| Check | Measured result |
| --- | --- |
| Mean absolute RGB channel delta | **42.1429 / 255**, required ≥40 |
| Opaque union over slate, supplementary | 49.4551 / 255 |
| Keep opaque width / height | 120 / 174 px, alpha ≥250 |
| Keep height-to-width ratio | **1.4500**, target 1.3–1.6 |
| Wall course contrast at source 2× | **31.3004%**, target 25–35% |
| Joins | 16 unique frames; all directional extents correct |
| Cell raster | Exactly 128×128 source px, or 64 nominal px |
| Frame edges | No object or shadow alpha clipped at any sprite edge |
| Required Python command | `python3 art/check_assets.py --projection square`: pass |
| Required Node command | `node art/verify.mjs`: pass, installed Pixi 8.20.1 |
| Preview versions | Square v3 default; Square v2, Square v1 and Diamond selectable |

Difference compares corresponding atlas frames, registered by ground anchor,
without resampling, using RGB channels where **both alpha values equal 255**.
This excludes new padding, translucent shadows and packing-position changes.
Per-frame scores and projected bounds are in `verification/acceptance-v3.json`.
The old v2 PNG is preserved byte-for-byte as `atlas-square-v2.png` from `57d3af9`;
both historical square PNG checksums are tested. The JSON only changes meta.image.

Course contrast uses wall-12's exposed front, median display luma across source
x=48:144, y=121:148, then `1 - min/max`. The complete profile is saved. This measures
rendered 2× pixels; the shader's 60% linear-light mortar setting is not the
reported contrast. The same course shader serves every stone object.

## Visual review

`verification/before-after-v3.png` shows keep, walls 12/03/06, floor, courtyard,
gate and raider side by side at **96 device px per cell** (32 CSS px at DPR 3).
The keep, walls and paving visibly change. The raider's largest change is its
cast shadow; its body retains the previous design. This is an assistant visual
inspection, not a test with an unbriefed human observer.

`verification/keep-v3-3x.png`: buttresses, arch, hanging cloth, flag and brazier
are each visible at actual phone DPR 3. The brazier is a small flame and amber
pool; tiny individual bars are not independently legible.

`verification/board-phone-v3-dpr3.png`: 1080×1080 pixels, 360×360 CSS viewport,
9×9 board with 96 device px cells. Broad front courses and lower-right cast
shadows read. The keep projects above its cell without changing the cell origin.

`verification/board-phone-v3-dpr1.png`: 360×360 pixels, 32 px cells. Shadows,
wall thickness, paving joints and ownership shapes remain visible. Front courses
soften into bands. Battlement tops still look busy at this scale, and the
brazier collapses to a tiny warm mark. There is no random texture grain, but
this is not a claim that every keep detail survives DPR 1.

Both phone images are composites of Blender-rendered atlas frames, not device
screenshots. The real preview adopts Pixi devicePixelRatio up to 3 and uses
per-frame anchors, including the taller keep, and these are checked in its actual
scene code using adapters.

## Rendering and delivery sizes

All renders used **blender MCP**, `blender_run_script`, Blender **5.2.1 LTS**,
EEVEE. `blender_python_expr` passed the version / mesh API / render API health
check. No shell Blender and no CPU geometry fallback were used.

Final complete build: **17.064 seconds**, including 31 sprites plus the sample
board. Final keep: **0.522 seconds**. Ten full iterations plus two keep diagnostics
total **171.337 seconds** of reported Blender script time, excluding tool startup.
`verification/render-tools-v3.json` records every build duration and final per-frame
measurements. The longer iteration sequence caught clipping, scale and contrast
failures before this delivery.

| Atlas | Dimensions | PNG bytes |
| --- | --- | ---: |
| Square v3 | 1584×1086 | 316,793 |
| Preserved Square v2 | 1584×792 | 263,465 |
| Preserved Square v1 | 1584×792 | 158,600 |
| Historical Diamond | 1072×536 | 127,151 |

Keep source frame: **256×288**, anchor `(128,192)` / normalized `(0.5,2/3)`.
Wall/gate frames: 192×192, anchor `(96,112)` / `(0.5,7/12)`.
Other frames: 192×192, centre anchor. The keep uses a separate atlas shelf;
all 31 frames remain untrimmed with two-pixel extrusion and gutters. The old
Diamond hero renders and separate 2×2 keep remain historical v2 studies.

## Limits

Computer Use inventory had no browser connection; native Chrome access returned
“Computer Use was not approved to use Google Chrome.” The `agent-browser`
executable was unavailable. Live CDN loading, WebGL, responsive CSS and physical
phone interaction remain unverified. No claim of a browser screenshot or owner
approval is made. The Node test uses real Pixi textures, sprites and scene graphs,
with DOM/GPU Application adapters, and validates switching, anchors, controls
and picking all 81 cell centres.

The Square camera does not expose the full east face seen in the chosen reference.
Lighting is authored four-band emission with AO and cool side falloff. Shadows
are projected convex silhouettes; their small gaps merge. Brazier warmth is an
authored pool. These are deliberate board-art simplifications, not physically
rendered indirect illumination. The longer shadows can overlap neighbouring
cells, and a taller keep can obscure a portion of the row behind it.

## Two questions for the owner

1. Does this keep now feel like the chosen reference at phone size, or should the
   front tower mass become more dominant relative to the roof?
2. Is the warmer paved board preferable, or does the amount of paving compete
   with the walls and make claimed courtyards harder to distinguish?
