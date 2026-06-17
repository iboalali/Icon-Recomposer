# Changelog

All notable changes to Icon Recomposer are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/). The version
is defined in `model.js` (`APP_VERSION`), shown in the app's top bar, and written
into saved project files.

## [1.3.0] — 2026-06-17

### Added

- **Per-layer shadow distance** — a Distance control in the Cast shadow section
  sets how far each layer throws its shadow (its apparent height above the
  surface). It multiplies the automatic length from the light, so `1×` keeps the
  previous look and higher values lift the layer further off the surface.
- The app now **opens on a bundled default project** (the "app icon") instead of
  the built-in sample, and shows that **app icon next to the title** in the top
  bar plus as the browser **favicon**.
- **Anonymous usage analytics** via the privacy-friendly TelemetryDeck Web SDK —
  one pageview per load, no cookies. Signals from `localhost`/`file://` are
  automatically flagged as test mode.

### Fixed

- Clicking the canvas could not switch the selection between overlapping layers:
  once a layer was selected, its (invisible) drag target covered its shape and
  intercepted clicks, so an overlapping layer underneath or on top couldn't be
  click-selected. Selection now hit-tests the actual layer geometry.

## [1.2.1] — 2026-06-17

### Fixed

- With **Link W/H** on, editing one canvas dimension now updates the other
  field too. The canvas already resized correctly; only the linked field's
  displayed value lagged when focus moved into it.

## [1.2.0] — 2026-06-17

### Added

- **Move layers** — drag a selected layer (or all selected layers together) on the
  canvas, or set an exact position with the layer's X/Y fields. Moving a layer
  off-canvas is allowed; the move round-trips in the project file without losing the
  original path data.
- **Click to select on the canvas** — click a layer's shape to select it, Ctrl/⌘-
  and Shift-click to extend the selection (mirroring the layer list), and click an
  empty area to deselect.
- **Numeric light position** — Position X/Y fields for fine point-light placement
  (alongside the draggable handle).

### Changed

- The light now moves **only by dragging its handle**; clicking elsewhere on the
  canvas no longer repositions it.

### Fixed

- Canvas size presets could render partially off-screen in the inspector.
- Number inputs (canvas size, light position, PNG size, stroke width) overflowed
  the right edge of their panel box — they now size to a fixed width.

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
