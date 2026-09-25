# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser editor for lit, layered app icons. You place rectangles and ellipses on a 108×108 canvas (the Android adaptive-icon 108dp grid), give each one an [ambientcss](https://github.com/kikkupico/ambientcss) look (material, surface, elevation, thickness, fillet, chamfer, glow) under one scene light, keep several **variants** of the icon side by side, and export them as PNG: Play Store 512, legacy launcher densities, adaptive-icon foreground/background layers plus the `mipmap-anydpi-v26` XML, and custom sizes. Several files download as one zip.

Version 2 is a rewrite. The 1.x app (gradient emboss that round-tripped to VectorDrawable) lives on `main` history up to `v1.8.0`; none of its code or constraints apply here. A simple vector editor for monochrome icons is planned for later.

**Target browser: Chrome.** Safari and Firefox are not supported for now.

## Constraints

- **Zero-build, vanilla ES modules, no dependencies.** No bundler, no `npm install`, no framework. The one third-party file is `vendor/ambientcss/ambient.css` (MIT, license beside it), vendored **unmodified** from upstream commit `f829df7`. Don't edit it; adapt it at load time in `render.js` instead.
- **Preview and export use the same markup.** `render.js` `stageMarkup()` produces the icon HTML; the editor shows it inside a shadow root, and export puts the same markup and stylesheet into an SVG `<foreignObject>`, draws that onto a canvas at the target size, and encodes PNG. Never add an effect to one path only.
- **The markup must be well-formed XML** (it is parsed as XML inside the capture SVG): close every tag, escape attribute values. The stylesheet goes into a `CDATA` section because ambient.css comments contain `<` and `&`.
- **Everything is designed at 108 CSS px.** ambientcss's px constants are tuned for element sizes around 100px, and the capture scales the whole scene vectorially, so edges and shadows keep their proportions at any export size.
- **Shadow root isolation.** ambient.css has a global `*` rule and `:root` defaults; they must never reach the editor UI. `render.js` rewrites `:root {` to `:root, .ir-stage {` so the defaults apply inside the shadow root and the capture, and the stage sets every scene variable inline.

## Architecture

| File | Role |
| --- | --- |
| `model.js` | document shape, defaults, sample document, `parseProject` validation, `APP_VERSION`, `paintOrder` |
| `render.js` | variant → icon markup (`stageMarkup`), ambient.css loading (`iconCss`, `iconSheet`), per-shape light rotation |
| `textures.js` | our own texture materials (wood, stone, paper, ceramic, enamel, carbon, holographic) as layer lists, their seeded SVG masks, the finish sheen, the metal Shuffle hooks (`metalVars`), and neon's face |
| `export.js` | foreignObject capture (`renderCanvas`/`renderPng`), masks, export presets, `planExport`/`runExport`, `download` |
| `path.js` | SVG/VectorDrawable path data: parse, normalize to absolute M/L/C/Z (arcs to Béziers), transform baking, bbox, serialize (carried over from 1.x) |
| `vdimport.js` | VectorDrawable → shapes plus the tracing guide: group transforms, Android `#AARRGGBB` colors, shape detection (ellipse, rounded rect, straight-edged outlines as a minimal rectangle cover), skip report |
| `zip.js` | minimal stored (uncompressed) zip writer |
| `ui.js` | editor: state, undo, inspector controls, canvas select/move/resize/rotate, shapes list, variants strip, files, export dialog, shortcuts |
| `dialog.js` | in-page `confirmDialog()` → `Promise<boolean>` |
| `colorpicker.js` | in-page color popover (`createColorField`) |
| `sw.js` | retires the 1.x service worker: deletes its caches, unregisters, reloads. **Keep it** so 1.x visitors are not stuck on the cached old app. |

### Document model (`model.js`)

- `doc.variants[]`: each variant is a **full, independent copy** of the design: `scene` (light x/y in -1..1, key, fill, hue, saturation), `background` (color, lit, transparent) and `shapes[]`.
- Shapes keep the **same `id` across variants**. "Apply edits to all variants" (`ui.editAll`, off by default) finds the matching shape in each variant by id.
- `variant.crossings[]` holds `{ over, under }` shape id pairs that override the paint order where two shapes overlap (woven designs, which no single stack can express). Where a crossing puts `over` on top against the paint order, `render.js` paints nothing twice, so translucent shapes (glass, opacity below 1) look like a natural crossing: a copy of `over` right after `under`, clipped with a `clip-path` polygon to `under`'s outline (`overCopy`: `over`'s body and its shadow on `under`); a hole in `under` where `over` lies outside it, so `under`'s shadow never lands on `over`; and a hole in the original `over` where the two overlap, which the copy covers (`crossingClip`, one `clip-path: path(evenodd, …)` per shape). Holes are inset by about 1.25 output pixels (`stageMarkup`'s `pxPerUnit`, passed by the preview, the thumbnails and the export) so two anti-aliased edges never meet exactly and leave a hairline. Shapes painted after `under` still cover all of it. Don't clip with nested rotated `overflow: hidden` boxes: Chrome cuts the blurred shadow of a rotated element inside a differently rotated clip box, leaving a hard edge. A patch belongs to `under`'s adaptive layer. `M.isOver` gives the effective order (override, else paint order), `hitTest` uses it, and deleting a shape drops its crossings. Overlap detection (`shapesOverlap`) samples a grid, so ellipses count only where they really overlap.
- Each shape has `layer: 'foreground' | 'background'`. Background shapes always paint under foreground ones (`paintOrder`); within a layer, array order is paint order. Up/Down in the shapes list moves within the layer.
- "Copy to variants" is `M.copyIntoVariant(src, dst, ids, parts)`: it matches shapes by id and copies the ticked parts (`COPY_SHAPE_PARTS`: geometry, look, color, layer; `COPY_VARIANT_PARTS`: light, background, crossings, order, missing). "Look" is every style key except the colors (`color`, `glowColor`), which are their own part because variants usually differ in color. Order reorders only in-scope shapes within the slots they already hold in `dst`. The dialog (`openCopy` in `ui.js`) can also duplicate each target first and copy into the duplicate.
- `doc.guide` is the tracing guide from the last VectorDrawable import (`{ name, paths: [{ d, fill, evenOdd }], visible }`, canvas units). It belongs to the document, not a variant, is drawn in `#guide-layer` above the stage (inside the view-only overlay) and is never exported.
- VectorDrawable import (`vdimport.js`) only makes shapes that the renderer can light: axis-aligned ellipses and (rounded) rectangles, and outlines with only horizontal and vertical edges, which `rectilinearCover` splits into the fewest overlapping maximal rectangles on a grid compressed to the outline's own coordinates. Everything else is reported as skipped. A viewport other than 108 is treated as a plain icon and centered at 49.5 units (24dp × 2.0625).
- Project files are `.icjson` with `format: 'icon-recomposer/2'`. 1.x projects are rejected with a clear message. Bump `SCHEMA_VERSION` only when the shape changes, and normalize old fields in `parseProject`.

### Rendering details (`render.js`)

- Each shape is an absolutely positioned `div.ir-shape.ambient` with ambientcss classes for surface (`amb-surface`, `-concave`, `-concave-h`, `-convex`, `amb-groove`) and material (`amb-mat-*`; glass replaces the surface class) and inline `--amb-*` variables.
- box-shadow offsets and the shiny gradient live in the element's rotated frame, so each shape gets `--amb-light-x/y` rotated back by its own angle (`localLight`).
- Fillet and chamfer bands are drawn by our own `div.ir-edge` inside each shape, not by ambient.css: the shape sets `--amb-chamfer:0; --amb-fillet:0` and `--ir-chamfer`/`--ir-fillet` instead. `.ir-edge` repeats ambient.css's band offsets, widths and alpha fits, but the highlight is a lighter shade of `--amb-lit` (mixed toward white by `--ir-edge-shine`) instead of the lamp's white, which on colored shapes read as a white outline.
- Texture materials (`textures.js`) are ours, not ambientcss's: the shape gets `ir-textured` plus its surface class, and `div.ir-tex` inside it holds the material's layers. Most layers are a square covering the shape at any angle, turned by `texAngle`, that paints a color derived from `--amb-albedo` through an alpha mask (an SVG noise tile, a vector tile of fibers, flakes or Voronoi cracks, or one large image for wood rings, marble veins and crumpled facets) and blends it over the surface, usually multiply or screen, so the texture keeps the surface's shading. `fit` layers follow the shape's outline instead, for edge effects (glaze pooling, the enamel rim). Every mask is generated per seed, and per slider value where a slider sets a threshold, cached, and inlined quoted with `'`. Noise tiles repeat seamlessly only when each frequency times the tile size is a whole number.
- Detail must go down to about a quarter of a canvas unit: exports and the zoomed editor show the 108-unit design several times larger, and coarser noise reads as a blurry upscale. Masks themselves render sharp at every size (tested); thin lines must be drawn as vector paths, because a displacement filter tears them.
- Light-dependent layers compute from the shape's local light in JS: carbon tows, cardboard flutes, enamel's highlight and rim, ceramic's highlight, concrete pit rims, holographic colors, and crumples and folds. Crumpled paper stores its facet tilts as four masks (facing -x, +x, -y, +y) so moving the light only reweights them.
- The matte, satin or glossy finish is a `div.ir-sheen.amb-mat-shiny` above the texture, so ambient.css's sheen is not darkened by it. Ceramic draws its own softer gloss. An enamel rim is drawn above the shape's edge highlight (`coversEdge`), which would tint the metal.
- Holographic puts its palette on with `color` blending (keeps the surface's lightness), `soft-light` (the palette's own light and dark, all a silver foil has) and a weak `screen`. Bands shift inside the repeating gradient, never by moving the background box, which would show a seam.
- Shuffle writes `style.seed` (0 is each pattern's original layout). For our textures it reseeds the noise and generators; for ambient.css's brushed, radial brushed and blasted metal it drives hooks that `adaptAmbient` (`render.js`) adds to ambient.css at load time (`--ir-grain-dx/dy`, `--ir-spin-dx/dy/turn/spot`), set per shape by `metalVars`. `adaptAmbient` warns in the console if ambient.css no longer contains a string it rewrites.
- Materials share generic style fields (`texAngle`, `texScale`, `texAmount`, `finish`, `texTone`, `accent`, `accent2`, `seed`) plus a few specific ones (`crackle`, `mottle`, `rim`, `paperType`, `crumple`, `folds`, `holo*`), each read in the material's own way and labeled per material in the inspector. `M.materialDefaults()` resets them when a material is picked. `woodAngle`, `woodScale` and `woodFinish` from older files are read into them in `normalizeStyle`.
- Neon is self-lit: no drop shadow, no edges, a face gradient (`neonFace`) that ignores the scene light, and a halo in the shape's own color sized by `glowSize` whether or not glow is on.
- Glow is a separate `div.ir-halo` behind the shape, because ambientcss's `.amb-glow` would replace the shape's own box-shadow stack.
- Known ambientcss cascade effect: curved surfaces set the `background` shorthand, which wins over shiny's gradient layers.

### Export (`export.js`)

- The SVG carries the output `width`/`height`; the `viewBox` selects the area (whole 108 canvas, or the center 72dp launcher view). Masks (circle, rounded square, squircle) are applied on the canvas with `destination-in`.
- Adaptive-icon layer jobs (`layer` set) always use the whole canvas and no mask. The foreground layer has a transparent background; foreground shadows stay as semi-transparent pixels.
- One file downloads directly; more become a zip with one folder per variant (when exporting several variants) and `mipmap-*` folders.

### UI (`ui.js`)

- One-way data flow: input → mutate `state.doc` → `scheduleRender()` (rAF-batched). Inspector controls are built once and only their values are updated on render.
- Selection is `ui.selected` (shape ids in the current variant) plus `ui.primary`, the shape clicked last: the inspector shows its values and only a single selection gets resize/rotate handles. Inspector setters go through `forSelected`, so every selected shape (and, with "Apply edits to all variants", its match in each variant) gets the value. Controls take an optional `mixed()` and show "Mixed" when the selection disagrees; `singleOnly()` hides name, position and size for several shapes. `pruneSelection()` drops ids missing after a variant switch, undo or delete.
- Zoom and pan are view-only (`ui.view`: `scale` relative to fit, `panX/panY` in screen px). The frame grows through CSS `zoom` (`ui.zoom = ui.fit * view.scale`, CSS px per canvas unit), not a transform, so the icon is laid out and painted again and stays sharp; the frame is centered absolutely and panned with a translate. `toCanvas` reads the frame's live rect and the selection overlay uses `ui.zoom`, so hit tests and drags need no zoom math.
- The selected variant is remembered by id in `localStorage` (`icon-recomposer-2/variant`). The document is saved at startup so a fresh sample keeps its ids across reloads.
- Frosted glass has a `frost` style value: `render.js` overrides ambient.css's private `--_glass-alpha`, `--_glass-lightness` and `--_glass-blur` from `.ir-shape.amb-mat-glass` (more specific than ambient.css's rule). 0.3 reproduces ambient.css's fit, 0 is clear, 1 is an 82% milky pane; the pane keeps its fitted tone so more frost is milkier, not darker.
- The About dialog loads the changelog from `https://iboalali.com/apps.json`, which the website publishes for all apps, and picks this app's entry by name (`changelog: [{ version, changes[] }]`, each change starting with an emoji marker). It is fetched on first open, kept for the session, and retried on the next open after a failure. That file, not `CHANGELOG.md`, is what users see, so a release also needs its entry there.
- Every in-page dialog uses `.dlg-overlay`; `modalOpen()` checks for any visible one, so app shortcuts and file drops are ignored while a dialog is open.
- Undo: `structuredClone` snapshots. `mutate()` is a live change inside a gesture, `commit()` ends the gesture and records one undo step, `edit()` is a one-shot change.
- The document autosaves to `localStorage` on every commit. Export dialog settings are also remembered there.
- `ui.unsaved` means "changed since the last Save, Open or New" (a `•` in the tab title). It is kept in `localStorage` too, so it survives a reload. Open (button or file drop) and New ask for confirmation only while it is set; a file is parsed before asking, so an invalid file never prompts.

## Changelog and versioning

**Changelog (required):** every **user-facing** change (a feature, a behavior change, a UI tweak, a bug fix a user would notice) adds an entry under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog: `Added` / `Changed` / `Fixed` / `Removed`) in the **same commit**. Internal work (refactors, comments, tooling, docs) needs no entry. When unsure, ask: "would someone using the app notice?"

**Versioning:** `APP_VERSION` in `model.js` is the single source of truth (top bar + saved projects). To release, move `[Unreleased]` items under `## [x.y.z] - YYYY-MM-DD`, bump `APP_VERSION`, commit, and tag `vx.y.z` (annotated).

## Running and testing

Serve the directory and open `index.html` (ES modules need `http://`):

```
python3 -m http.server
```

There is no committed test suite. Verify changes in the served page: headless Chrome (`google-chrome --headless=new --screenshot` / `--dump-dom`), or a small Chrome DevTools Protocol script driving `Input.dispatchMouseEvent` and `Runtime.evaluate`, reading results from the autosaved document in `localStorage` (`icon-recomposer-2/doc`).

Deployment is GitHub Pages from `main` (root) at https://iboalali.com/Icon-Recomposer/. Pages serves `Cache-Control: max-age=600`, so a deploy can take up to 10 minutes to reach returning visitors.
