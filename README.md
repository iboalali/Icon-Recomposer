# Icon Recomposer

A browser tool that loads vector artwork (SVG or Android **VectorDrawable** XML), applies a subtle 3D **emboss** look driven by a single movable light, and exports the result as:

- **PNG** — transparent or with a chosen background
- **Android VectorDrawable XML** — icon only
- **Project JSON** — re-editable

Conceptually inspired by macOS Icon Composer, but deliberately constrained so the output always round-trips to a valid VectorDrawable.

**Live:** https://iboalali.com/Icon-Recomposer/

> **Status: pre-implementation.** Only the design spec ([`PLAN.md`](PLAN.md)) and a placeholder landing page exist so far. App code is not written yet.

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

Then visit http://localhost:8000. File access is upload/download only (pure web).

## Deployment

Hosted on GitHub Pages (deploy-from-branch: `main` / root). Every push to `main` auto-redeploys.
