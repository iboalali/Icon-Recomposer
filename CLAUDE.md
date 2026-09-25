# CLAUDE.md

## What this is

A browser editor for lit, layered app icons. Rectangles and ellipses on a 108×108 canvas (the Android adaptive-icon 108dp grid) get an [ambientcss](https://github.com/kikkupico/ambientcss) look or one of our own texture materials under one scene light. A document holds several **variants** of the icon. Export writes PNGs (Play Store 512, legacy launcher densities, adaptive-icon foreground/background layers plus the `mipmap-anydpi-v26` XML, custom sizes); several files download as one zip.

Version 2 is a rewrite. The 1.x app (up to tag `v1.8.0`) shares no code or constraints with it, except `path.js`. **Target browser: Chrome only.**

## Hard constraints

- **Zero-build, vanilla ES modules, no dependencies.** No bundler, no `npm install`, no framework.
- **`vendor/ambientcss/ambient.css` stays unmodified** (upstream commit `f829df7`, MIT). Adapt it at load time in `render.js` (`adaptAmbient`, which warns in the console when a string it rewrites is gone).
- **Preview and export share one markup path.** `render.js` `stageMarkup()` builds the icon HTML. The editor shows it in a shadow root; export puts the same markup and stylesheet into an SVG `<foreignObject>`, draws it on a canvas and encodes PNG. Never add an effect to only one of them.
- **The markup must be well-formed XML**: close every tag, escape attribute values. The stylesheet goes in a `CDATA` section because ambient.css comments contain `<` and `&`.
- **Design at 108 CSS px.** ambientcss's px constants are tuned for elements around 100px; the capture scales the scene vectorially.
- **ambient.css must never reach the editor UI** (it has a global `*` rule and `:root` defaults). `render.js` rewrites `:root {` to `:root, .ir-stage {`, and the stage sets every scene variable inline.
- **Keep `sw.js`.** It retires the 1.x service worker so old visitors are not stuck on the cached app.

## Files

| File | Role |
| --- | --- |
| `model.js` | document shape, defaults, sample, `parseProject`/`normalizeStyle`, `APP_VERSION`, `SCHEMA_VERSION`, paint order, crossings, copy-to-variants |
| `render.js` | variant → markup (`stageMarkup`), ambient.css loading and adaptation, per-shape light, crossings clipping |
| `textures.js` | our texture materials as layer lists, their seeded SVG masks, finish sheen, metal Shuffle hooks, mirror-metal studio, neon face |
| `export.js` | foreignObject capture, masks, presets, `planExport`/`runExport`, download |
| `path.js` | SVG/VectorDrawable path data: parse, normalize to M/L/C/Z, transforms, bbox |
| `vdimport.js` | VectorDrawable → shapes plus the tracing guide |
| `ui.js` | the editor: state, undo, inspector, canvas gestures, lists, dialogs, shortcuts |
| `zip.js`, `dialog.js`, `colorpicker.js` | stored zip writer, `confirmDialog()`, color popover |

## Document model

- Each of `doc.variants[]` is a **full, independent copy** of the design (`scene`, `background`, `shapes[]`). Shapes keep the **same `id` across variants**; "Apply edits to all variants" and "Copy to variants" (`M.copyIntoVariant`) match by id. Colors (`color`, `glowColor`) are a separate copy part from "look", because variants usually differ in color.
- `layer: 'foreground' | 'background'`: background always paints under foreground; array order is paint order within a layer.
- `doc.guide` (tracing guide from the last VectorDrawable import) belongs to the document, not a variant, and is never exported.
- VectorDrawable import only creates shapes the renderer can light (axis-aligned ellipses, rounded rects, rectilinear outlines split by `rectilinearCover`). Everything else is reported as skipped.
- Project files: `.icjson`, `format: 'icon-recomposer/2'`. Bump `SCHEMA_VERSION` only when the shape changes, and normalize old fields in `parseProject`/`normalizeStyle`.

## Rendering traps

- box-shadow offsets and ambient.css's shiny gradient live in the element's rotated frame, so each shape gets the light rotated back by its own angle (`localLight`). Light-dependent texture layers use that local light too.
- Fillet and chamfer bands are our own `div.ir-edge` (ambient.css's are zeroed), so the highlight is a lighter shade of the shape color instead of a white outline.
- Glow is a separate `div.ir-halo`, because `.amb-glow` would replace the shape's box-shadow stack.
- Curved surfaces set the `background` shorthand, which wins over shiny's gradient layers (known ambientcss effect).
- **Crossings** (`variant.crossings[]`, `{ over, under }`) override paint order where shapes overlap. Nothing may be painted twice, so translucent shapes stay correct: a clipped copy of `over` after `under` (`overCopy`) plus evenodd `clip-path` holes (`crossingClip`). Holes are inset about 1.25 output px (`pxPerUnit`) so anti-aliased edges don't leave a hairline. Don't clip with nested rotated `overflow: hidden` boxes: Chrome cuts the blurred shadow of a rotated element inside a differently rotated clip box.
- **Textures:** detail must reach about a quarter canvas unit, or exports and the zoomed editor look like a blurry upscale. Draw thin lines as vector paths (a displacement filter tears them). Noise tiles repeat seamlessly only when each frequency × tile size is a whole number. Shift bands inside a repeating gradient, never by moving the background box, which shows a seam. Masks are generated per seed (and per threshold slider value), cached, and inlined quoted with `'`.
- Anything drawn behind a shape is grayed by the shape's own drop shadow, so effects past the outline (felt fuzz) are children masked to the outer band. Chrome rounds sub-pixel CSS borders down to nothing, so fine lines (denim stitching) are SVG masks.
- Materials share generic style fields (`texAngle`, `texScale`, `texAmount`, `finish`, `texTone`, `accent`, `accent2`, `seed`), each read in the material's own way and labeled per material in the inspector. `M.materialDefaults()` resets them on material change. Shuffle writes `style.seed` (0 = original layout).
- Frosted glass overrides ambient.css's private `--_glass-*` variables from `.ir-shape.amb-mat-glass`.

## Export

- The SVG carries output `width`/`height`; the `viewBox` picks the area (whole canvas or the center 72dp). Masks are applied on the canvas with `destination-in`.
- Adaptive-icon layer jobs always use the whole canvas and no mask; the foreground layer is transparent, its shadows stay semi-transparent.

## UI (`ui.js`)

- One-way flow: input → mutate `state.doc` → `scheduleRender()` (rAF-batched). Inspector controls are built once; render only updates their values.
- Undo is `structuredClone` snapshots: `mutate()` is a live change inside a gesture, `commit()` ends it and records one step, `edit()` is a one-shot change. Every commit autosaves to `localStorage`.
- Inspector setters go through `forSelected` (all selected shapes, plus their matches in every variant when editing all). `ui.primary` is the shape whose values the inspector shows.
- Zoom uses CSS `zoom` on the frame (not a transform) so the icon repaints sharp; `toCanvas` reads the live rect, so hit tests and drags need no zoom math.
- Every in-page dialog uses `.dlg-overlay`; `modalOpen()` blocks shortcuts and file drops while one is visible.
- `ui.unsaved` (persisted) gates the confirmation on Open and New. A file is parsed before asking, so an invalid file never prompts.
- The About dialog shows the changelog from `https://iboalali.com/apps.json`, not `CHANGELOG.md`, so a release also needs its entry there.

## Changelog and versioning

- **Every user-facing change** (feature, behavior change, UI tweak, noticeable fix) adds an entry under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog: `Added` / `Changed` / `Fixed` / `Removed`) **in the same commit**. Internal work needs none. Test: "would someone using the app notice?"
- `APP_VERSION` in `model.js` is the single source of truth. To release: move `[Unreleased]` under `## [x.y.z] - YYYY-MM-DD`, bump `APP_VERSION`, commit, add an annotated tag `vx.y.z`, and add the entry to `apps.json`.

## Running and testing

Serve the directory (ES modules need `http://`) and open `index.html`:

```
python3 -m http.server
```

No committed test suite. Verify in the served page with headless Chrome (`google-chrome --headless=new --screenshot` / `--dump-dom`) or a Chrome DevTools Protocol script (`Input.dispatchMouseEvent`, `Runtime.evaluate`), reading results from the autosaved document in `localStorage` (`icon-recomposer-2/doc`).

Deployment: GitHub Pages from `main` (root) at https://iboalali.com/Icon-Recomposer/. `Cache-Control: max-age=600`, so returning visitors can take up to 10 minutes to see a deploy.
