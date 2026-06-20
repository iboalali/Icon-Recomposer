# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: implemented & live

The app is built and deployed. `PLAN.md` remains the authoritative design spec — read it for the detail and the math; this file is the fast orientation. Still **zero-build**: no `package.json`, bundler, or committed test suite. Modules are plain ES modules and can be exercised headlessly (serve with `python3 -m http.server`, drive/assert with `google-chrome --headless=new --dump-dom`).

The repo is on GitHub (`git@github.com:iboalali/Icon-Recomposer.git`) and deployed via **GitHub Pages** (deploy-from-branch: `main` / root). Live at **https://iboalali.com/Icon-Recomposer/** — every push to `main` auto-redeploys.

**Changelog (required):** every **user-facing** change — a new feature, a behavior change, a UI tweak, a bug fix a user would notice — **must** add an entry under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog format: `Added` / `Changed` / `Fixed` / `Removed`), in the **same commit** as the change. Internal-only work (refactors, comments, tests/tooling, doc edits) does not need an entry. If in doubt, add one. When unsure whether a change is user-facing, ask: "would someone using the app notice?"

**Versioning:** the single source of truth is `APP_VERSION` in `model.js` — shown in the top bar and written into saved project files (`app` field). To **release**, move the `[Unreleased]` items under a new `## [x.y.z] — YYYY-MM-DD` heading, bump `APP_VERSION` to match, commit, and tag `vx.y.z` (annotated). Bump `schemaVersion` (also `model.js`) only when the document shape changes, and add a migration step.

## What this is

A browser tool that loads vector artwork (SVG or Android VectorDrawable XML), applies a **subtle 3D emboss** look driven by a single movable light, and exports as: PNG (transparent or chosen background), Android **VectorDrawable XML** (icon only), or a re-editable project JSON. Conceptually inspired by macOS Icon Composer, but constrained so the result round-trips to a valid VectorDrawable.

## Non-negotiable constraints (violating any of these breaks the product)

- **VectorDrawable is paths + gradients + alpha, nothing else.** No blur, no filters, no shadow/mask primitives. Every effect (emboss, shadow, sheen) is *faked* with gradient fills and extra generated paths. See `PLAN.md` §2–3.
- **Pure web, zero-build, vanilla HTML/CSS/JS.** No framework (no React), no bundler, no `npm install`, **no dependencies**. `path.js` is hand-rolled (the plan suggested vendoring `svgpath`; hand-rolling kept it truly dependency-free). See `PLAN.md` §9.
- **`minSdk` 24+** — inline `<aapt:attr><gradient>` is used directly; no `VectorDrawableCompat` path.
- **Gradient-only emboss → preview, PNG, and VD must be pixel-identical.** Achieved by restricting the preview SVG to VD-expressible features and using `gradientUnits="userSpaceOnUse"` so gradient coordinates map 1:1 to VD attributes. Never introduce a preview-only effect that VD can't express. **One deliberate exception:** a cast shadow with *clip to layers* on uses `<clipPath>` in the preview (anti-aliased) vs VD `<clip-path>` (aliased), so only that clipped shadow edge differs slightly — accepted on purpose.
- **Android colors are `#AARRGGBB` (alpha first)**, not `#RRGGBBAA`. Easy bug in the VD serializer.

## Core architecture (the big picture)

The whole app is a **two-model pipeline**:

```
authoring model ── derive() ──▶ derived model (flat paths + gradients)
   (user edits)                    ├─▶ live SVG preview   (svg.js)
                                   ├─▶ VectorDrawable XML  (export-vd.js)
                                   └─▶ PNG via canvas      (export-png.js)
```

- **Authoring model** = what the user manipulates: one **shared scene light** (azimuth/elevation, point or distant) + a `layers[]` array where each layer has a `pathData`, a material (base color + opacity, fill mode **solid / embossed / gradient** — emboss is opt-in, *not* the default — emboss intensity, sheen, optional stroke, cast-shadow), and an optional non-destructive **`transform`** (move / scale / flip). See `PLAN.md` §4.
- **`derive()`** is the heart: it turns the light + materials into concrete paths and gradients. Light position maps to gradient geometry — **point light → radial gradient center**, **distant light → linear gradient angle**; **cast shadow = an offset clone of the path with a fading gradient**. All gradient geometry lives in shared viewport space so one light stays coherent across layers. Math in `PLAN.md` §12.
- **One derivation, three renderers** is why WYSIWYG holds — preview, PNG, and VD are three serializers of the *same* derived result.

### Module layout (zero-build ES modules)

| File | Role |
| --- | --- |
| `model.js` | authoring model, defaults, sample doc, validation/migration, project file + share-link |
| `derive.js` | authoring model → derived paths+gradients (the light math) + cast-shadow clip union |
| `svg.js` | derived model → SVG string (preview + standalone-with-explicit-size variant for PNG) |
| `export-vd.js` | derived model → VectorDrawable XML |
| `export-png.js` | standalone SVG → `Image` → `<canvas>` → `toBlob` (+ bg) |
| `import.js` | SVG / VD parse → layers (transform baking, shape→path, computed-style fill) |
| `ui.js` | panels, inputs, light-handle drag, selection marquee, render loop, undo/redo, file/export wiring |
| `color.js` | color parse/format + **OKLab** `mix(base, white/black, k)`; `#AARRGGBB` formatter |
| `path.js` | **hand-rolled** path parse → normalize (arcs→béziers) → transform bake → bbox → serialize |
| `colorpicker.js` | custom in-page color popover (native `<input type=color>` clipped off-screen) |
| `dialog.js` | in-page modal dialog (`confirmDialog()` → `Promise<boolean>`) replacing native `confirm()`/`alert()`; Esc cancels / Enter confirms, stopped at the overlay so global shortcuts don't fire |
| `telemetry.js` | dependency-free TelemetryDeck custom-signal sender (export/open/import/new/save/undo/redo + errors); pairs with the Web SDK pageview `<script>` in `index.html` |
| `sw.js` | PWA service worker: precaches the app shell (cache-first, same-origin only) for offline use; cache named by `?v=APP_VERSION`. **Registered from `ui.js` (`registerServiceWorker`) and paired with `manifest.webmanifest`.** |

**PWA maintenance (important):** `sw.js` holds an explicit `PRECACHE` list of every file the app loads. When you **add a new top-level file** (a new ES module, asset, etc.), you **must add it to `PRECACHE`** or it won't be available offline (`addAll` is atomic, so a wrong/removed path makes install fail — caught early). The cache is versioned by `?v=APP_VERSION`, so bumping `APP_VERSION` in `model.js` is the only step needed to ship a new cached build; no separate cache-version bump.

**Install button (`setupInstall` in `ui.js`):** the `#btn-install` button (right of Export) is hidden until the browser fires `beforeinstallprompt`; we `preventDefault()` that event (suppressing the browser's auto-prompt/banner) and run the native install only on an explicit click — no unsolicited prompt. It shows wherever the browser supports installation — **desktop and Android Chrome/Edge** — so our button replaces the browser's own install affordance on those platforms. On **iOS/iPadOS Safari** the event never fires, so the button stays hidden (the HTML `hidden` attribute) and install is via Safari's Share → "Add to Home Screen". The update flow (`registerServiceWorker`) still uses a `confirmDialog` ("Update available — reload?").

### Implemented behavior beyond PLAN.md

In the code but not (fully) in `PLAN.md`:
- **Light `type: 'off'`** — disables lighting: embossed fills render flat, sheen/shadow suppressed, light handle and elevation/intensity controls hidden.
- **Cast shadow `clipToLayers`** (default on) — clips a layer's shadow to the union of *filled layers below it*, so shadows land on surfaces, not the background. A bottom-most layer therefore casts no shadow. Preview = `<clipPath>`, VD = `<group>` + `<clip-path>` (the pixel-identity exception above).
- **Selection marquee** — selected layer outlined by a non-interactive SVG overlay (`#selection-overlay`) above the preview; excluded from all exports; toggled via the `hidden` *attribute* (SVGElement has no `.hidden` IDL property).
- **Export filename suffixes** — `<name>-vd.xml`, `<name>-svg.svg`, `<name>-iwb.png` (background), `<name>-iwt.png` (transparent); project = `<name>.json`. Driven by an editable **document name** field.
- **SVG file export** (beyond the plan's PNG/VD/JSON); `standaloneSvg` can bake the background.
- **Open vs Import both sniff content and route** — Open *replaces* the document with a project; Import *appends* vector geometry; either redirects (with a toast) if the file doesn't match the button. PLAN §7.
- **Sweep gradients are not emitted** by `derive()` (SVG has no userspace conic gradient → would break preview/VD parity), though `export-vd.js` still supports the form.
- **Per-layer gradient fills** — `material.fillMode: 'gradient'` with `material.gradient` ({ type linear/radial, stops [{offset,color,alpha}], geometry }) is a true user gradient fill (no emboss on that layer; stack a separate embossed layer to combine). Geometry is stored in the layer's local/pathData space and baked by `layerMatrix` in `derive()` (`buildUserGradient`), so it tracks move/scale/flip. Imported from SVG/VD instead of being flattened (`import.js` `extractSvgGradient`/`extractVdGradient` + `bakeImportedGradient`, objectBoundingBox→absolute). Only linear/radial (sweep excluded). `schemaVersion` is now **2** (additive; v1 still loads).
- **Non-destructive layer transform (move / scale / flip)** — `layer.transform` ({ translateX/Y, rotation, scaleX/Y, pivotX/Y }) is now **user-driven**, not just import baking: drag on the canvas or set X/Y to **move**, a **Scale %** control resizes, **Flip H/V** mirrors (negative scale). Multi-select transforms the whole selection about its shared center (`transformSelectionAboutCenter` → `scaleSelection`/`flipSelection` in `ui.js`). All of it is baked by `layerMatrix` in `derive()`; `pathData` stays original. Scalar magnitudes that must track the layer — **stroke width** and the **radial-gradient radius** — scale by the matrix's mean axis length (`meanAxisScale(m)`); the stroke **Width** field shows the *base* value, the canvas shows `base × scale`.
- **Emboss is opt-in** — `defaultMaterial().fillMode` is `'solid'`, so new layers and imported art come in flat with the source color (faithful import; `normalizeLayer`'s fallback is also `'solid'`). The built-in sample doc sets `fillMode: 'embossed'` explicitly to demonstrate the effect.
- **Per-layer cast-shadow distance** — `castsShadow.distance` multiplies the auto throw length derived from the light (the layer's apparent height above the surface); `1×` keeps the old look.
- **View-only canvas zoom/pan** — `appState.ui.view` ({ scale, panX, panY }, ephemeral, never serialized) is applied as a CSS `transform` on `#canvas-wrap` (`applyViewTransform`/`clampView`/`zoomAt` in `ui.js`). Because `viewportFromEvent` reads the live transformed rect and the light handle / selection marquee live inside `canvas-wrap`, all coordinate math is unchanged under the transform — so it cannot leak into preview/PNG/VD/SVG. Wheel + trackpad-pinch (`onCanvasWheel`) and touch two-finger pinch (`activePointers`/`startPinch`) zoom toward the focal point (fit→8×, `transform-origin: center`); middle-mouse / empty-canvas-when-nothing-selected / two-finger drag pan, clamped to content edges.

### Import / export gotchas (where the real work is)

- **Import** (`PLAN.md` §13): both SVG and VD reduce to a common intermediate `{pathData, matrix, fill, fillRule, stroke}`. Shared back-end normalizes each path to absolute `M/L/C/Z` (arcs→béziers) then **bakes all transforms into coordinates** — required because VD `<group>` has no skew/general matrix. Strokes are **preserved un-embossed** (passthrough); the emboss/shadow derivation applies to fills only.
- **VD export** (`PLAN.md` §14): `viewportWidth/Height` must equal the coordinate space `derive()` emitted; use the `<item offset color>` gradient form (3-stop ramp); round coords to ~2–3 decimals.
- **PNG export** (`PLAN.md` §14): the standalone SVG **must carry explicit `width`/`height`** or the `Image` rasterizes at viewBox size (or 0) — the #1 trap.

### UI / state model (`PLAN.md` §15)

- One-way data flow: `input → mutate state → render()`. **Build controlled inputs once and only update their `.value`** on render (recreating them kills focus/drag); **rebuild derived views** (SVG preview, layer list) freely. Batch renders with `requestAnimationFrame`.
- Split state: `appState.document` is persisted (saved as the project file) and undone; `appState.ui` (selection, drag state, undo stacks) is ephemeral.
- Undo = `structuredClone(document)` snapshots, **one entry per gesture** (commit on `pointerup`/`change`, not per `input`).
- The light handle lives in an **overlay element above the preview**, never inside the rebuilt preview SVG.

## Running it

Zero-build by design: no install step. Serve the directory with any static file server and open `index.html`:

```
python3 -m http.server
```

then visit http://localhost:8000. **Must be served over `http://`** — ES module imports are blocked on `file://`. File access is upload/download only (pure web). There's no automated test suite; verify changes by loading the served page (headless via `google-chrome --headless=new --dump-dom`, asserting against `#preview`/exports, works well).
