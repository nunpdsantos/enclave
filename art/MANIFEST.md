# ENCLAVE siege kit / delivery manifest

Delivered on branch `art`, from clean baseline `e3b61cb`. All new tracked files
are under `art/` and `public/`. No `src/`, `api/`, dependency or existing public
files changed. Nothing was pushed. Only local free software and the installed
development tools were used; no image-generation API, paid art API, external
model or new package was used.

**Material limitation:** Blender 5.2.1 LTS crashes during Metal detection before
Python runs. Delivered PNGs come from the explicitly labelled CPU fallback,
using the same source meshes, camera, palette and face-light bake. The Blender
script is supplied and syntax-checked, but its EEVEE output is not verified.

## Measured result

| Item | Result |
| --- | --- |
| Gameplay frames | 31, each 128×128 transparent RGBA |
| Review composite | 3×3, 384×384, excluded from atlas |
| Atlas | 1072×536, **34,902 bytes / 34.1 KiB** |
| Pixi resolution | `meta.scale: "2"`; parsed as 64×64 logical textures |
| Last render | **4.519 seconds**, CPU fallback, including 3×3 sample |
| Complete render + pack | **5.244 seconds**, measured on the rebuild |
| Reproducibility | All 33 PNGs plus atlas JSON were byte-identical on rebuild |
| Installed parser exercised | PixiJS 8.20.1 |

Measurements and hashes are in [pipeline.json](verification/pipeline.json) and
[reproducibility.json](verification/reproducibility.json). Render time is a local
measurement, not a prediction for another machine or for Blender EEVEE.

## File manifest

| Files | Purpose |
| --- | --- |
| [STYLE.md](STYLE.md) | Concrete palette, four luma bands, camera, light rig, scale/placement contract, atlas conventions, ten owner-run concept prompts |
| [blender/geometry.py](blender/geometry.py) | Authoritative procedural meshes, proportions, six four-value ramps and asset names |
| [blender/kit.py](blender/kit.py) | `bpy` construction, orthographic EEVEE rendering, optional `.blend` inspection scene |
| [blender/render.sh](blender/render.sh) | One-command full render and pack; explicit `--software` fallback |
| [blender/software.py](blender/software.py) | Standard-library CPU rasteriser for the same meshes and camera |
| [pngio.py](pngio.py), [pack.py](pack.py) | No-package PNG codec and padded, untrimmed Pixi atlas packer |
| `renders/wall-00.png` … `wall-15.png` | All 16 U=1/D=2/L=4/R=8 join masks, each rendered separately |
| `renders/keep.png`, `gate-n.png`, `gate-e.png`, `gate-s.png`, `gate-w.png` | Keep and four border-entry orientations |
| `renders/ruin-a.png`, `ruin-b.png` | High broken-pier and low collapsed-corner variants |
| `renders/floor-stone.png`, `floor-courtyard-a.png`, `floor-courtyard-b.png` | Neutral floor and two warm player courtyards |
| `renders/banner-cobalt.png`, `banner-oxblood.png` | Notched player cloth and pointed enemy cloth |
| `renders/enemy-raider.png`, `enemy-tide.png`, `enemy-target.png` | Provisional figure, translucent spreading patch and next-step marker |
| [renders/sample-board.png](renders/sample-board.png) | 3×3 composition for direct visual review |
| [renders/render-manifest.json](renders/render-manifest.json) | Renderer provenance, frame contract and measured duration |
| [public/assets/siege/atlas.png](../public/assets/siege/atlas.png), [atlas.json](../public/assets/siege/atlas.json) | Shipped texture and Pixi v8 spritesheet |
| [public/art-preview.html](../public/art-preview.html) | Standalone 9×9 Pixi review page, true 1×/2× side-by-side boards, 32 px phone study, all-frame catalog, enemy/greyscale/grid controls |
| [check_assets.py](check_assets.py), [verify.mjs](verify.mjs) | Source/atlas and actual preview-script verification using the installed Pixi library |
| `verification/board-1x.png`, `board-2x.png`, `board-phone.png`, `board-phone-greyscale.png` | Inspected CPU composites of the shipped sprites; **not browser screenshots** |
| `verification/geometry.json`, `preview.json`, `pipeline.json`, `reproducibility.json` | Machine-readable check results and hashes |
| [verification/blocked-checks.txt](verification/blocked-checks.txt) | Exact Blender failure and browser/HTTP approval limits |
| [.gitignore](.gitignore), this manifest | Ignore disposable logs/caches; delivery record |

## Review decisions

There was no previous siege artwork in this worktree: `art/` was absent, and
`public/` contained the existing playbook, service worker, manifest and icons.
Those existing files were kept intact; no previous siege asset was replaced.

The kit implements the requested tactile table direction with a 60° elevation,
45° three-quarter view, thick low walls and restrained flat shading. During
review I aligned every hue to the same four brightness bands, widened the flag
faces and deepened the player notch, corrected a two-pixel keep-crown crop,
enlarged the raider silhouette for the phone study, and added dark keylines to
intent brackets so they remain visible over pale sandstone. Enemy art remains
two separate functions and frame roles for easy replacement after playtesting.

The oblique diamond projection is deliberate. At nominal 64 px tile width,
neighbour centres step `(±32, 27.7128)`, not 64 px. STYLE.md spells out both the
projection and inverse hit test. The existing rectangular game renderer has not
been integrated with this view; integration is a separate code-track decision.

## Verification and remaining limits

Passed: all 16 mask extents; 16 different wall images; no source mesh clipped by
its frame; four luma targets across all material hues; nonempty alpha; translucent
tide interior; PNG CRC/round-trip; every atlas region identical to its source;
31 exact preview frame names; Pixi parse and anchors; the actual page's three
scene graphs, catalog, enemy/intent toggles, grid control, greyscale class and
inverse cell inspection. Shell and Python syntax checks also passed. I visually
inspected the sample, atlas and 32/64/128 px board composites, including greyscale.

Unverified: actual EEVEE rendering, a saved Blender scene, browser/CDN execution,
GPU compositing, responsive CSS and real-device usability. Blender exited 139 in
`supports_barycentric_whitelist` / `MTLBackend::metal_is_supported` before Python.
Vite started successfully on port 5173, but the HTTP probe was rejected by the
approval policy. Browser inventory had no providers and native Chrome control
was not approved. The offline checks use real Pixi scene objects with DOM and
GPU Application adapters; they are not substituted evidence of a browser run.

## Reproduce and inspect

```sh
# Intended Blender path, with a working Metal GPU context:
art/blender/render.sh

# Explicit, verified fallback used for these delivered assets:
art/blender/render.sh --software
node art/verify.mjs

# Serve the standalone page at /art-preview.html:
npm run dev
```

## Commits

- `98785ed` — Define siege art direction and procedural render pipeline.
- `8e9c5f5` — Add siege sprites, atlas, and 9x9 art preview.
- The validation/handoff commit contains this manifest and `verification/`;
  resolve its exact hash with `git log -1 --format='%h %s' -- art/MANIFEST.md`.

## Three owner decisions

1. Should the keep feel like a home worth protecting or a military command post?
2. Should the enemy remain human and heraldic even if spreading-tide rules win?
3. Is this carved-tabletop tone right, or should it become darker and more weathered?
