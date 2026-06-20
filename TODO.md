# TODO

Planned improvements. Unordered; check off as done.

- [x] **Resizable left and right panels** — _Declined._ Decided against draggable
  splitters; the fixed panels were widened instead (Layers 280px, inspector 360px).

- [x] **Inline dialogs, not the browser ones**
  Replace native `confirm()` / `alert()` with in-page modal dialogs (same
  approach as the custom color popover). ✅ Added `dialog.js` (`confirmDialog()`
  → `Promise<boolean>`); the "Start a new document?" confirm now uses it.

- [x] **Scalable UI (phone support)**
  ✅ Phone view is a normally-scrolling stacked page (canvas on top, then Layers
  and inspector); responsive top bar collapses overflow into a "⋯" menu and the
  brand stacks (icon+version over name) when narrow; canvas scales to always fit.
  Touch zoom/pan supported via the canvas gestures.

- [x] **Zoom support for canvas**
  Zoom + pan the preview. ✅ View-only CSS transform on `#canvas-wrap`
  (`appState.ui.view`); wheel / trackpad-pinch / touch-pinch zoom toward the
  pointer (fit→8×), middle-mouse / empty-drag / two-finger pan. Coordinate math
  (hit-test, light handle, marquee) rides the transform unchanged; exports are
  unaffected.

- [x] **Esc key removes selection**
  Pressing Escape deselects all layers. ✅ An open color popover / dialog
  consumes Escape first; a focused field is blurred by the first Escape, then a
  second press clears the selection.

- [x] **More keyboard shortcuts** — _Done for now._ Current set: Ctrl+Z / Ctrl+Y /
  Ctrl+Shift+Z (undo/redo), Ctrl+D (duplicate), Delete, Esc (deselect),
  Ctrl/⌘+S (save), Ctrl/⌘+O (open). Considered sufficient; revisit if more wanted.

- [x] **Installable / offline (PWA)**
  ✅ `manifest.webmanifest` + `sw.js` (cache-first app-shell, cache versioned by
  `?v=APP_VERSION`) + registration/update-prompt in `ui.js`. Installable, fully
  offline. Maintenance: add any new top-level file to `sw.js`'s `PRECACHE` list.
