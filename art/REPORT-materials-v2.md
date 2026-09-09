# Keep reference / Square materials v2

The reference's painterly surface cannot survive literally on a 32 px game cell.
The delivered kit translates it into broad, quiet courses and warmer stone,
while retaining the upright square grid, existing silhouettes and all 16 joins.
The hero is a clean stylised masonry study, not a reproduction of brushwork.

## Delivered appearance

Square v2 uses .25 × .125-unit staggered ashlar, soft .004-unit joints, 10%
maximum mortar modulation in linear light and 3.5% block variation. The four
base value bands remain dominant. Light stone receives a small warm tint;
dark stone and slate receive a cool tint. EEVEE shader AO adds contact depth,
and feathered slate-alpha footprints settle objects onto the board. The rig's
warm/cool contribution is baked into sprite colours; hero lighting is physical.

The existing 1×1 Keep retains its silhouette in a 192×192 padded frame at 2×.
The separate [2×2 Keep](renders-square/keep-2x2.png) is 256×256 at 2×, centred,
with 128 pixels per cell, buttresses, slit marks, an arched door, hanging notched
cloth, a flag and a rooftop brazier. Its height is compressed to fit the board
projection. This is a footprint study; the game still has no 2×2 integration.

[Hero without ground](hero/keep-hero.png) and [hero with forecourt](hero/keep-hero-ground.png)
are both 1024×1024 RGBA. Both use 60° elevation and the reference's 45° diamond
azimuth, -45° from +X. Cycles supplies rough sandstone, subtle course relief,
soft bevels, folded cloth, warm key, cool fill and a small brazier glow. The
forecourt version remains transparent outside the paving.

`art-preview.html` defaults to **Square v2**, with **Square v1** and **Diamond**
comparison options. Square v1's PNG is byte-identical to the preceding atlas;
its JSON changes only the image filename. No wall geometry or board spacing changed.

## Measured rendering and storage

Every render used the `blender` MCP server. Both `blender_run_script` and
`blender_python_expr` were exercised successfully on Blender 5.2.1 LTS.
No shell Blender invocation or software fallback rendering was used.

| Final render batch | Time inside Blender | MCP call wall time |
| --- | ---: | ---: |
| Square kit, 31 frames + 3×3 sample, EEVEE | 17.688 s | 21.517 s |
| Keep studies, one EEVEE + two Cycles renders | 10.068 s | 14.662 s |

The Keep batch comprises 0.600 s for 2×2, 4.262 s for transparent hero and
5.206 s for the forecourt hero. Measurements include scene construction and
file writing; tool times also include process startup/transport. Earlier visual
probes and the AO diagnostic are recorded in [render-tools-v2.json](verification/render-tools-v2.json).

| Atlas | Dimensions | PNG bytes | JSON bytes |
| --- | ---: | ---: | ---: |
| Square v2 | 1584×792 | 263,465 | 13,358 |
| Preserved Square v1 | 1584×792 | 158,600 | 13,169 |
| Historical Diamond, unchanged | 1072×536 | 127,151 | 13,205 |

All contain 31 frames and remain below the 2 MB PNG budget. Square keeps 192 px
frames, 96 px logical textures and 64 px cell spacing. The separate large Keep
and hero images are excluded from the uniform atlas.

## Readability and verification

**32 px verdict: no course noise.** In the [360 px phone composite](verification/board-phone-v2.png),
the nine cells span 288 px with 36 px margins. The individual masonry courses
mostly merge into the stone tone; they are not individually legible at this
size. Wall boundaries, merlons, warm courtyards, cobalt inlays and enemy chevrons
remain distinct. No extra per-scale contrast reduction was needed. The same
low-contrast material is downsampled at 1× and phone size. The 64 px, 128 px and
greyscale boards were also inspected. This is an atlas-pixel composite, not a
browser screenshot or a user study.

Passed `python3 art/check_assets.py --projection square`, the equivalent Diamond
check, and `node art/verify.mjs`. Checks include all 16 join extents, distinct
wall images, exact source/atlas pixels, PNG integrity, transparency, source mesh
bounds, upright cell raster, base-palette luma, preserved v1 checksum, two-cell
Keep framing and both hero alpha borders. Pixi 8.20.1 parses all three atlases;
the preview script switches textures/layouts and exercises all 81 cell centres,
boundary inspection, enemy toggles, grid and greyscale controls at three scales.

A controlled MCP render with AO disabled confirmed the effect is active:
4,160 of 9,386 fully opaque Keep pixels changed; average darkening was 1.044
RGB levels and maximum average-channel darkening 8.667 levels. See
[material-ao.json](verification/material-ao.json).

**Unverified:** live CDN execution, browser WebGL output, responsive CSS and
physical phone interaction. The current browser connection returned “No browser
is available”. The preview checks use real Pixi scene objects with DOM/GPU
adapters. Neither 2×2 gameplay occupancy nor menu/world-map integration was
attempted. Arrow slits are stylised dark marks with sills, not cut-through holes.
The sole Blender warning was the upcoming removal of `World.use_nodes` in 6.0;
all render calls exited successfully.

## Two questions for the owner

1. Is this sandstone warm enough, or should it move closer to the reference's golden colour?
2. Does the squat 2×2 Keep have enough presence, or should the next study make it taller?
