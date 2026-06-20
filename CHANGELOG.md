# Changelog

All notable changes to Icon Recomposer are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/). The version
is defined in `model.js` (`APP_VERSION`), shown in the app's top bar, and written
into saved project files.

## [Unreleased]

### Added

- **Installable, works offline (PWA).** Icon Recomposer can now be installed to
  your home screen / desktop and runs fully offline — once loaded, the whole app
  (and your last-used default) is cached, so it opens with no network. Updates
  are picked up automatically: when a new version is available you'll be offered
  a one-tap reload.

## [1.5.8] — 2026-06-20

### Fixed

- **The whole canvas is always visible.** On short / wide windows the square
  canvas could be taller than the stage, so its top and bottom were clipped and
  zoom (which only goes in, never below fit) couldn't recover it. The canvas now
  scales to fit the stage in both dimensions, so the full icon is always shown.

### Changed

- **Top bar no longer stacks messily when narrow.** As the window shrinks, the
  toolbar now keeps to one line and moves the items that don't fit into a "⋯"
  overflow menu (Privacy and Changelog first, then Import, etc.), instead of the
  buttons and brand wrapping into a jumble. When it's very narrow the app icon
  and version sit together on top with the name on the line below.

## [1.5.7] — 2026-06-20

### Fixed

- **Phone layout no longer hides the canvas.** On small screens the editor used
  a height-locked three-pane layout, so once the bottom inspector grew tall the
  canvas collapsed to nothing and scrolled out of reach behind the panel. The
  phone view is now a normally-scrolling page: the canvas sits at the top with a
  fixed height (always visible), and you scroll down through Layers and the
  inspector. The toolbar is sticky and its buttons wrap instead of overflowing
  off the right edge.

## [1.5.6] — 2026-06-20

### Added

- **Keyboard shortcuts for Save and Open.** Ctrl+S / ⌘S saves the project,
  Ctrl+O / ⌘O opens a project or imports a vector (overriding the browser's
  default save-page / open-file).

### Changed

- **Wider side panels.** The Layers panel (240 → 280px) and the inspector
  (300 → 360px) are roomier, so labels and controls have more breathing room.

## [1.5.5] — 2026-06-20

### Added

- **Zoom and pan the canvas.** Zoom in with the mouse wheel, trackpad
  two-finger pinch, or touchscreen two-finger pinch — it zooms toward the
  pointer, up to 8×, and never shrinks below the fit size. Pan by dragging empty
  canvas when nothing is selected and you're zoomed in, by two-finger drag on
  touch, or with a middle-mouse drag any time (even with a layer selected).
  Zoom/pan is view-only: it changes nothing about the icon — every export (PNG,
  VectorDrawable, SVG) and the project file are unaffected.

## [1.5.4] — 2026-06-20

### Added

- **Press Esc to clear the layer selection.** If a control is focused, the first
  Esc leaves the field and a second clears the selection; an open colour picker
  or dialog closes on Esc first.

### Changed

- **The "Start a new document?" prompt is now an in-app dialog** instead of the
  browser's native confirm box, matching the app's dark theme. Esc cancels,
  Enter confirms.

## [1.5.3] — 2026-06-20

### Added

- **Changelog link in the top bar.** A "Changelog" link sits next to Privacy and
  opens the app's "What's new" page.

## [1.5.2] — 2026-06-20

### Added

- **A simple way to make gradients.** Picking the **Gradient** fill now leads
  with a beginner-friendly path: one-click **Quick looks** (Top light, Glow,
  Sheen, Diagonal, Fade out) that build a complete gradient from the layer's
  base colour, a **From → To** colour pair (with a **Fade** toggle that fades
  the end colour to transparent), and a **direction pad** — eight arrows set a
  linear direction and the centre dot makes it radial. The full multi-stop
  editor (offsets, per-stop alpha, exact Start/End or Centre/Radius
  coordinates) is still there for pros, now tucked under an **Advanced**
  disclosure. Simple and advanced controls edit the same gradient, so they stay
  in sync. The simple controls (presets, colours, fade, direction) apply to
  every selected gradient layer at once, so a multi-part icon can be restyled in
  one click; the advanced per-stop / per-coordinate controls edit the primary
  layer only.

### Fixed

- **The "Gradient" fill option is now visible.** In the Layer ▸ Material panel,
  the three fill options (Solid / Embossed / Gradient) were laid out on one line
  beside the "Fill" label and didn't fit the inspector's width, so the rightmost
  "Gradient" option was pushed off the right edge and clipped out of view. The
  segmented control now sits on its own line under the label, full width, so all
  three options are always visible.

## [1.5.1] — 2026-06-17

### Changed

- **Point (radial) light: Intensity now drives how far the shadow reaches, with
  a softer falloff.** Turning Intensity up pulls the shadow inward — at the
  slider's max it reaches and passes the canvas center, so the center and far
  side go dark; lower intensity keeps the center lit. (The radius was fixed by
  the light's elevation before and barely responded to Intensity.) The ramp runs
  highlight → base → a flat shadow plateau, so the transition into the shadow is
  gradual.

### Fixed

- **Distant (directional) light now embosses as strongly as the point light,
  and its Intensity slider has a clear effect.** The directional ramp used to
  span the whole canvas with the neutral base color at its midpoint, so a
  centered shape sat on that midpoint and barely shaded no matter the intensity.
  The bevel is now built per shape along the shared light direction and
  concentrated into the shape interior (it reached full highlight/shadow only at
  the far corners before), so the shading covers the shape and reads as 3D —
  matched to the point light's interior contrast. Distant-light icons will look
  noticeably more embossed than before.

## [1.5.0] — 2026-06-17

### Fixed

- **Stroke width now scales with the layer.** Scaling a stroked layer left its
  outline at the original absolute width, so a shrunk shape looked too heavily
  outlined (and an enlarged one too thin). The stroke now tracks the layer's
  scale in the preview, PNG, and VectorDrawable export, matching the geometry.

### Changed

- **Emboss is now opt-in, not the default.** New layers and imported art come in
  as flat **Solid** fills with the source color, instead of being auto-embossed
  (which shaded flat fills and shifted them away from the source — e.g.
  semi-transparent white highlights and solid shapes looked wrong). Apply
  **Embossed** per layer when you want the 3D look. The built-in sample document
  stays embossed to demonstrate the effect.

### Added

- **Page metadata for search & link previews** — a `<meta>` description plus Open
  Graph / Twitter card tags, so sharing the live URL shows a title, summary, and
  the app-icon image instead of a bare link.
- **True per-layer gradient fills** — a new **Gradient** fill mode (alongside Solid
  and Embossed) with a linear/radial type, an editable multi-stop list (color +
  per-stop alpha + offset), and numeric geometry. Gradients import from SVG
  (`<linearGradient>`/`<radialGradient>`, incl. objectBoundingBox) and Android
  VectorDrawable instead of being flattened to one color, round-trip in the project
  file, track the layer's move/scale/flip, and stay pixel-identical across preview,
  PNG, and VectorDrawable. A per-layer **"duplicate as gradient overlay"** action
  stacks an embossed base + a gradient layer so one shape can have both.

## [1.4.0] — 2026-06-17

### Added

- **Per-layer scale** — a Scale control in the Layer panel resizes the selected
  layer(s) in place by a percentage (`100` = original). A single layer scales
  about its own center; with several layers selected they scale **together as a
  group** about the selection's common center, so a multi-part shape keeps its
  parts aligned. Content may extend past the canvas edge; nothing is clipped and
  the original path data is preserved (the scale is stored as a non-destructive
  layer transform in the project file). A link toggle unlocks independent X / Y
  scaling.
- **Flip layers** — Flip H / V buttons mirror the selected layer(s) horizontally
  or vertically. A single layer flips in place; multiple selected layers flip
  together about the selection's common center. Non-destructive (stored as the
  layer transform's scale sign) and independent of the scale percentage.
- **Anonymous usage & error events** sent to TelemetryDeck via a tiny
  dependency-free signal sender (alongside the existing pageview): `export` (with
  the format), `open`, `import`, `new`, `save`, `undo`, `redo`, and `error`
  (explicit export/import/open failures plus any uncaught runtime error). No
  cookies; `localhost`/`file://` are flagged as test mode.
- A **Privacy** link in the top bar pointing to the app's privacy policy
  (with UTM attribution); clicking it sends a `privacyLinkClicked` usage signal.

### Fixed

- **Gradient fills imported as flat gray** — SVG shapes filled with a
  `url(#gradient)` now seed the layer's base color from the gradient's stops
  (averaged) instead of falling back to `#888888`, so imported art keeps a
  representative color. (The emboss model still uses one base color per layer.)
- **Duplicate layer ids after importing into a loaded project** — generated ids
  could collide with ids already in the document (e.g. importing into the
  default project yielded two `layer-3-7283` layers), so selecting one of them
  selected both. Ids now carry a per-session random base, and loading a project
  de-duplicates any repeated ids (so previously-saved files self-heal on open).

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
