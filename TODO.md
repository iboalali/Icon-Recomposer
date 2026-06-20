# TODO

Planned improvements. Unordered; check off as done.

- [ ] **Resizable left and right panels (with min width)**
  Add draggable splitters between the panels and the canvas. Today the layout is
  fixed (`styles.css` `.workspace { grid-template-columns: 240px 1fr 300px }`).
  Each side needs a min width so it can't be collapsed to nothing.

- [x] **Inline dialogs, not the browser ones**
  Replace native `confirm()` / `alert()` with in-page modal dialogs (same
  approach as the custom color popover). ✅ Added `dialog.js` (`confirmDialog()`
  → `Promise<boolean>`); the "Start a new document?" confirm now uses it.

- [ ] **Scalable UI (phone support)**
  Make the editor usable on small / touch screens. There's a basic
  `@media (max-width: 820px)` rule today; needs real touch ergonomics, larger
  hit targets, and a layout that works one-panel-at-a-time on a phone.

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

- [ ] **More keyboard shortcuts**
  Build on the existing set (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, Ctrl+D, Delete).
  Candidates: select all, arrow-key nudge, bracket keys for layer order,
  show/hide layer, group-friendly shortcuts.
