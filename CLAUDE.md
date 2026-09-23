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
| `export.js` | foreignObject capture (`renderCanvas`/`renderPng`), masks, export presets, `planExport`/`runExport`, `download` |
| `zip.js` | minimal stored (uncompressed) zip writer |
| `ui.js` | editor: state, undo, inspector controls, canvas select/move/resize/rotate, shapes list, variants strip, files, export dialog, shortcuts |
| `dialog.js` | in-page `confirmDialog()` → `Promise<boolean>` |
| `colorpicker.js` | in-page color popover (`createColorField`) |
| `sw.js` | retires the 1.x service worker: deletes its caches, unregisters, reloads. **Keep it** so 1.x visitors are not stuck on the cached old app. |

### Document model (`model.js`)

- `doc.variants[]`: each variant is a **full, independent copy** of the design: `scene` (light x/y in -1..1, key, fill, hue, saturation), `background` (color, lit, transparent) and `shapes[]`.
- Shapes keep the **same `id` across variants**. "Apply edits to all variants" (`ui.editAll`, off by default) finds the matching shape in each variant by id.
- `variant.crossings[]` holds `{ over, under }` shape id pairs that override the paint order where two shapes overlap (woven designs, which no single stack can express). `render.js` `crossingMarkup` draws two copies of `over` right after `under`, each at its real position with a `clip-path` polygon (which also clips its shadow): one clipped to `under`'s outline (`over`'s body and its shadow on `under`), and one clipped to `over`'s own outline within `under`'s shadow reach (`shadowReach`, intersected with `clipPolygon`), which hides the shadow `under` casts onto `over` without doubling `over`'s shadow on the ground. Shapes painted after `under` still cover both. Don't clip with nested rotated `overflow: hidden` boxes instead: Chrome cuts the blurred shadow of a rotated element inside a differently rotated clip box, leaving a hard edge. A patch belongs to `under`'s adaptive layer. `M.isOver` gives the effective order (override, else paint order), `hitTest` uses it, and deleting a shape drops its crossings. Overlap detection (`shapesOverlap`) samples a grid, so ellipses count only where they really overlap.
- Each shape has `layer: 'foreground' | 'background'`. Background shapes always paint under foreground ones (`paintOrder`); within a layer, array order is paint order. Up/Down in the shapes list moves within the layer.
- "Copy to variants" is `M.copyIntoVariant(src, dst, ids, parts)`: it matches shapes by id and copies the ticked parts (`COPY_SHAPE_PARTS`: geometry, look, color, layer; `COPY_VARIANT_PARTS`: light, background, crossings, order, missing). "Look" is every style key except the colors (`color`, `glowColor`), which are their own part because variants usually differ in color. Order reorders only in-scope shapes within the slots they already hold in `dst`. The dialog (`openCopy` in `ui.js`) can also duplicate each target first and copy into the duplicate.
- Project files are `.icjson` with `format: 'icon-recomposer/2'`. 1.x projects are rejected with a clear message. Bump `SCHEMA_VERSION` only when the shape changes, and normalize old fields in `parseProject`.

### Rendering details (`render.js`)

- Each shape is an absolutely positioned `div.ir-shape.ambient` with ambientcss classes for surface (`amb-surface`, `-concave`, `-concave-h`, `-convex`, `amb-groove`) and material (`amb-mat-*`; glass replaces the surface class) and inline `--amb-*` variables.
- box-shadow offsets and the shiny gradient live in the element's rotated frame, so each shape gets `--amb-light-x/y` rotated back by its own angle (`localLight`).
- Fillet and chamfer bands are drawn by our own `div.ir-edge` inside each shape, not by ambient.css: the shape sets `--amb-chamfer:0; --amb-fillet:0` and `--ir-chamfer`/`--ir-fillet` instead. `.ir-edge` repeats ambient.css's band offsets, widths and alpha fits, but the highlight is a lighter shade of `--amb-lit` (mixed toward white by `--ir-edge-shine`) instead of the lamp's white, which on colored shapes read as a white outline.
- Glow is a separate `div.ir-halo` behind the shape, because ambientcss's `.amb-glow` would replace the shape's own box-shadow stack.
- Known ambientcss cascade effect: curved surfaces set the `background` shorthand, which wins over shiny's gradient layers.

### Export (`export.js`)

- The SVG carries the output `width`/`height`; the `viewBox` selects the area (whole 108 canvas, or the center 72dp launcher view). Masks (circle, rounded square, squircle) are applied on the canvas with `destination-in`.
- Adaptive-icon layer jobs (`layer` set) always use the whole canvas and no mask. The foreground layer has a transparent background; foreground shadows stay as semi-transparent pixels.
- One file downloads directly; more become a zip with one folder per variant (when exporting several variants) and `mipmap-*` folders.

### UI (`ui.js`)

- One-way data flow: input → mutate `state.doc` → `scheduleRender()` (rAF-batched). Inspector controls are built once and only their values are updated on render.
- Selection is `ui.selected` (shape ids in the current variant) plus `ui.primary`, the shape clicked last: the inspector shows its values and only a single selection gets resize/rotate handles. Inspector setters go through `forSelected`, so every selected shape (and, with "Apply edits to all variants", its match in each variant) gets the value. Controls take an optional `mixed()` and show "Mixed" when the selection disagrees; `singleOnly()` hides name, position and size for several shapes. `pruneSelection()` drops ids missing after a variant switch, undo or delete.
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
