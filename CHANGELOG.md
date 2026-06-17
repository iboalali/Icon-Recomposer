# Changelog

All notable changes to Icon Recomposer are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/). The version
is defined in `model.js` (`APP_VERSION`), shown in the app's top bar, and written
into saved project files.

## [Unreleased]

## [1.1.0] — 2026-06-17

### Added

- **Duplicate layer** — a per-row button and `Ctrl/⌘+D` copy the selected
  layer(s), inserting each copy directly above its original and selecting it.
- **Resize the project canvas** — set the canvas size via separate Width and
  Height fields or presets (24, 108, 512, 1024). Width and height are linked by
  default (keep the aspect ratio; unlink to size them independently), and a
  "Scale contents" option (default on) scales every layer and the light to fit
  the new size.

## [1.0.0] — 2026-06-17

Initial release: a zero-build, dependency-free browser tool that loads vector
artwork, applies a VectorDrawable-expressible 3D emboss driven by a single
movable light, and exports the result.

### Added

- **Import** SVG and Android VectorDrawable artwork as editable layers —
  shape→path conversion, transform baking, computed-style fill resolution, and
  un-embossed stroke passthrough.
- **Emboss engine** (`derive()`): one shared scene light → gradients. Point
  light → radial, distant light → linear; OKLab perceptual color mixing.
- **Light "Off"** mode renders the icon flat (no emboss, sheen, or shadow).
- Per-layer **materials**: base color + opacity, solid/embossed, emboss
  intensity, sheen, fill rule.
- **Cast shadows** (opacity, spread) with **clip-to-layers** (default on), so a
  shadow lands on the filled layers below it instead of the background.
- **Live preview** with a draggable light handle and a selection marquee that
  outlines the selected layer(s) on the canvas.
- **Multi-select** layers (Ctrl/⌘- and Shift-click) and edit material, shadow,
  and stroke settings for every selected layer at once.
- **Exports**: PNG (transparent or chosen background), Android VectorDrawable
  XML, SVG, and re-editable project JSON. Filenames carry a format suffix
  (`-vd`, `-svg`, `-iwb`, `-iwt`); project files use the document name alone.
- **Editable document name** that drives export/save filenames.
- **Custom in-page color picker** (the native picker clipped off-screen next to
  the inspector).
- **Open / Save project** JSON — round-trips fully editable — with
  schema-version migration, plus **share-by-link** via the URL fragment.
- **Smart file routing**: Open and Import each detect whether the file is a
  project or vector artwork and route it accordingly.
- **Undo/redo** (one entry per gesture) with `Ctrl/⌘+Z` / `Ctrl/⌘+Shift+Z`.
- Pure-web, **zero-build, no dependencies** — vanilla ES modules with a
  hand-rolled SVG path normalizer (arcs→béziers, transform baking).
