# ENCLAVE siege art / current delivery

Current delivery: **Square v3**, geometry, sampled palette and directional shadows.
Read [REPORT-geometry-v3.md](REPORT-geometry-v3.md) for measurements and limits,
and [STYLE.md](STYLE.md) for reproduction and the per-frame anchor contract.

- `blender/v3.py`, `materials_v3.py`: current Square geometry and materials.
- `blender/kit.py`: Blender MCP render pipeline; 31 sprites plus sample board.
- `blender/geometry.py`, `materials.py`: historical geometry/material sources.
- `renders-square/`: current sprites; keep 256×288, others 192×192; render manifest.
- `public/assets/siege/atlas-square.*`: current 31-frame atlas.
- `public/assets/siege/atlas-square-v2.*`, `atlas-square-v1.*`: immutable comparisons.
- `public/assets/siege/atlas.*`, `hero/`, `renders-square/keep-2x2.png`: historical studies.
- `public/art-preview.html`: Square v3 default; v2/v1/Diamond controls; device DPR up to 3.
- `verification/before-after-v3.png`, `keep-v3-3x.png`: 96 device px/cell review.
- `verification/board-phone-v3-dpr3.png`, `board-phone-v3-dpr1.png`: 360 CSS px composites.
- `verification/acceptance-v3.json`, `render-tools-v3.json`, `reference-samples-v3.json`: evidence.

Render only through MCP server `blender`. Then run `python3 art/pack.py --projection square`,
`python3 art/check_assets.py --projection square`, and `node art/verify.mjs`.
The Square compositor requires installed Pillow and NumPy. No project dependencies
were changed. Work stays on `art`, within `art/` and the preview/siege assets under
`public/`. No `src/`, `api/`, gameplay, deployment or push changes are included.
