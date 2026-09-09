# ENCLAVE siege art / current delivery

The current delivery is **Square materials v2**, based on the owner's chosen
Keep reference. See [REPORT-materials-v2.md](REPORT-materials-v2.md) for render
measurements, atlas sizes, visual findings and verification limits, and
[STYLE.md](STYLE.md) for the projection and material contract.

- `blender/geometry.py`: unchanged 31-asset board geometry and 16 join masks.
- `blender/kit.py`, `materials.py`: Square EEVEE material and rendering pipeline.
- `blender/keep_study.py`, `render_keep.py`: larger Keep and Cycles hero pipeline.
- `renders-square/`: 31 padded 192 px frames, sample board, manifest and separate 256 px 2×2 Keep.
- `hero/`: 1024 px transparent Keep, forecourt variant and render manifest.
- `public/assets/siege/atlas-square.*`: current 31-frame square atlas.
- `public/assets/siege/atlas-square-v1.*`: preserved previous square atlas.
- `public/assets/siege/atlas.*`: historical Diamond comparison atlas.
- `public/art-preview.html`: Square v2 / Square v1 / Diamond comparison, three scales, ownership and inspection controls.
- `verification/board-phone-v2.png`: 360 px viewport containing a 9×9 board at 32 px cells.
- `verification/`: geometry, Pixi, hash, AO and render-time evidence.

All Blender rendering must use the MCP `blender` server, as documented in
STYLE.md. The legacy shell renderer and software fallback are not the current
reproduction path. Historical CPU reproducibility measurements do not describe
these new EEVEE/Cycles files.

Work stays on branch `art`, in `art/` and the siege preview/assets under `public/`.
No `src/`, `api/`, dependency, gameplay, deployment or push changes are included.
