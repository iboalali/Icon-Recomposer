# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: pre-implementation

There is **no code yet** — only `PLAN.md`, the authoritative design spec. Read it before writing anything; this file is a fast orientation, `PLAN.md` is the detail. There is no `package.json`, build system, test suite, or git repo at this point.

## What this is

A browser tool that loads vector artwork (SVG or Android VectorDrawable XML), applies a **subtle 3D emboss** look driven by a single movable light, and exports as: PNG (transparent or chosen background), Android **VectorDrawable XML** (icon only), or a re-editable project JSON. Conceptually inspired by macOS Icon Composer, but constrained so the result round-trips to a valid VectorDrawable.

## Non-negotiable constraints (violating any of these breaks the product)

- **VectorDrawable is paths + gradients + alpha, nothing else.** No blur, no filters, no shadow/mask primitives. Every effect (emboss, shadow, sheen) is *faked* with gradient fills and extra generated paths. See `PLAN.md` §2–3.
- **Pure web, zero-build, vanilla HTML/CSS/JS.** No framework (no React), no bundler, no `npm install`. If a library is unavoidable, **vendor a single ES module** (the plan calls for `svgpath`, MIT, for path normalization). See `PLAN.md` §9.
- **`minSdk` 24+** — inline `<aapt:attr><gradient>` is used directly; no `VectorDrawableCompat` path.
- **Gradient-only emboss → preview, PNG, and VD must be pixel-identical.** Achieved by restricting the preview SVG to VD-expressible features and using `gradientUnits="userSpaceOnUse"` so gradient coordinates map 1:1 to VD attributes. Never introduce a preview-only effect that VD can't express.
- **Android colors are `#AARRGGBB` (alpha first)**, not `#RRGGBBAA`. Easy bug in the VD serializer.

## Core architecture (the big picture)

The whole app is a **two-model pipeline**:

```
authoring model ── derive() ──▶ derived model (flat paths + gradients)
   (user edits)                    ├─▶ live SVG preview   (svg.js)
                                   ├─▶ VectorDrawable XML  (export-vd.js)
                                   └─▶ PNG via canvas      (export-png.js)
```

- **Authoring model** = what the user manipulates: one **shared scene light** (azimuth/elevation, point or distant) + a `layers[]` array where each layer has a `pathData` and a material (base color, solid/embossed, emboss intensity, sheen, cast-shadow). See `PLAN.md` §4.
- **`derive()`** is the heart: it turns the light + materials into concrete paths and gradients. Light position maps to gradient geometry — **point light → radial gradient center**, **distant light → linear gradient angle**; **cast shadow = an offset clone of the path with a fading gradient**. All gradient geometry lives in shared viewport space so one light stays coherent across layers. Math in `PLAN.md` §12.
- **One derivation, three renderers** is why WYSIWYG holds — preview, PNG, and VD are three serializers of the *same* derived result.

### Planned module layout (zero-build ES modules)

| File | Role |
| --- | --- |
| `model.js` | authoring model, defaults, validation/migration |
| `derive.js` | authoring model → derived paths+gradients (the light math) |
| `svg.js` | derived model → SVG string (preview + a standalone variant for PNG) |
| `export-vd.js` | derived model → VectorDrawable XML |
| `export-png.js` | standalone SVG → `Image` → `<canvas>` → `toBlob` (+ bg) |
| `import.js` | SVG / VD parse → layers (transform flattening, shape→path) |
| `ui.js` | panels, inputs, light-handle drag, the render loop |
| `color.js` | OKLCH-ish `mix(base, white/black, k)` |

### Import / export gotchas (where the real work is)

- **Import** (`PLAN.md` §13): both SVG and VD reduce to a common intermediate `{pathData, matrix, fill, fillRule, stroke}`. Shared back-end normalizes each path to absolute `M/L/C/Z` (arcs→béziers) then **bakes all transforms into coordinates** — required because VD `<group>` has no skew/general matrix. Strokes are **preserved un-embossed** (passthrough); the emboss/shadow derivation applies to fills only.
- **VD export** (`PLAN.md` §14): `viewportWidth/Height` must equal the coordinate space `derive()` emitted; use the `<item offset color>` gradient form (3-stop ramp); round coords to ~2–3 decimals.
- **PNG export** (`PLAN.md` §14): the standalone SVG **must carry explicit `width`/`height`** or the `Image` rasterizes at viewBox size (or 0) — the #1 trap.

### UI / state model (`PLAN.md` §15)

- One-way data flow: `input → mutate state → render()`. **Build controlled inputs once and only update their `.value`** on render (recreating them kills focus/drag); **rebuild derived views** (SVG preview, layer list) freely. Batch renders with `requestAnimationFrame`.
- Split state: `appState.document` is persisted (saved as the project file) and undone; `appState.ui` (selection, drag state, undo stacks) is ephemeral.
- Undo = `structuredClone(document)` snapshots, **one entry per gesture** (commit on `pointerup`/`change`, not per `input`).
- The light handle lives in an **overlay element above the preview**, never inside the rebuilt preview SVG.

## Running it (once code exists)

Zero-build by design: no install step. Serve the directory with any static file server (e.g. `python3 -m http.server`) and open `index.html`. File access is upload/download only (pure web). The first milestone (`PLAN.md` §10, step 1) is the spine: `index.html` + model + a hardcoded sample doc → `derive()` → SVG preview.
