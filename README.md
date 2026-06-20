# Icon Recomposer

A browser tool that loads vector artwork (SVG or Android **VectorDrawable** XML), gives each shape a subtle 3D **emboss** driven by a single movable light (or a true gradient fill), and exports the result as:

- **PNG** — transparent or with a chosen background
- **Android VectorDrawable XML** — icon only
- **SVG**
- **Project JSON** — re-editable

Conceptually inspired by macOS Icon Composer, but deliberately constrained so the output always round-trips to a valid VectorDrawable.

It's a **PWA** — installable to your home screen / desktop and fully usable offline once loaded.

**Live:** https://iboalali.com/Icon-Recomposer/

## Using it

- **Import** an SVG or Android VectorDrawable to bring artwork in as layers (colors, strokes, and gradient fills are preserved), or **Open** a project JSON to resume editing.
- Select a layer and set its **material** — base color and opacity, a **fill mode** (Solid, Embossed, or a true multi-stop **Gradient**), emboss intensity, sheen, fill rule, and an optional stroke. New layers and imported art start flat (Solid); turn on **Embossed** when you want the 3D look.
- **Move, scale, and flip** layers — drag on the canvas or use the X/Y and Scale % fields, and Flip H/V to mirror. Several selected layers transform together as a group, and strokes and gradients scale along with the shape.
- **Drag the light** on the canvas; switch it between point, distant, or off. Elevation and intensity tune the shading.
- Give a layer a **cast shadow** (opacity, spread, distance); by default shadows clip to the layers beneath them rather than spilling onto the background.
- Name the icon (used for export filenames) and **Export** to PNG, VectorDrawable, SVG, or save the project JSON. Undo/redo with Ctrl/Cmd+Z; save/open with Ctrl/Cmd+S and Ctrl/Cmd+O.
- **Install** the app (desktop browsers show an Install button right of Export; on phones use the browser's "Add to Home screen"). Once loaded it works **offline**.

> **Open vs Import:** Open *replaces* the document with a saved project (fully re-editable). Import *appends* vector geometry as new layers. Export bakes the light/emboss into a flattened deliverable — an exported VectorDrawable is **not** a project file, so keep the JSON to keep editing.

## How it works

The whole app is a two-model pipeline — one derivation feeds three renderers, which is why preview, PNG, and VectorDrawable stay pixel-identical:

```
authoring model ── derive() ──▶ derived model (flat paths + gradients)
   (user edits)                    ├─▶ live SVG preview   (svg.js)
                                   ├─▶ VectorDrawable XML  (export-vd.js)
                                   └─▶ PNG via canvas      (export-png.js)
```

VectorDrawable supports only paths, gradients, and alpha — no blur, filters, or shadow primitives. So every effect (emboss, cast shadow, sheen) is *faked* with gradient fills and generated paths. A single shared scene light maps to gradient geometry: a point light becomes a radial gradient center, a distant light becomes a linear gradient angle.

See [`PLAN.md`](PLAN.md) for the full design and the math.

## Design constraints

- **Pure web, zero-build** — vanilla HTML/CSS/JS, no framework, no bundler, no `npm install`.
- **VectorDrawable-expressible only** — never introduce a preview effect that VectorDrawable can't reproduce.
- **`minSdk` 24+** — uses inline `<aapt:attr><gradient>` directly.

## Running locally

No build step. Serve the directory with any static file server and open `index.html`:

```sh
python3 -m http.server
```

Then visit http://localhost:8000. It must be served over `http://` (not opened as a `file://` path) because it uses ES module imports. File access is upload/download only (pure web).

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md). The current version is shown in the app's top bar and defined by `APP_VERSION` in `model.js`.

## Deployment

Hosted on GitHub Pages (deploy-from-branch: `main` / root). Every push to `main` auto-redeploys.
