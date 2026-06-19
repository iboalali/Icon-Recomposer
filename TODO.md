# TODO

Planned improvements. Unordered; check off as done.

- [ ] **Resizable left and right panels (with min width)**
  Add draggable splitters between the panels and the canvas. Today the layout is
  fixed (`styles.css` `.workspace { grid-template-columns: 240px 1fr 300px }`).
  Each side needs a min width so it can't be collapsed to nothing.

- [ ] **Inline dialogs, not the browser ones**
  Replace native `confirm()` / `alert()` with in-page modal dialogs (same
  approach as the custom color popover). Currently the only native dialog is the
  "Start a new document?" confirm in the New button handler (`ui.js`).

- [ ] **Scalable UI (phone support)**
  Make the editor usable on small / touch screens. There's a basic
  `@media (max-width: 820px)` rule today; needs real touch ergonomics, larger
  hit targets, and a layout that works one-panel-at-a-time on a phone.

- [ ] **Zoom support for canvas**
  Let the user zoom (and pan) the preview. The canvas is a fixed size now
  (`.canvas-wrap { width: 70vh }`). Keep the light handle, selection overlay, and
  drag-to-move hit-testing correct under zoom/pan.

- [ ] **Esc key removes selection**
  Pressing Escape should deselect all layers (`selectLayer(null)`). Watch the
  ordering against the color popover, which already closes on Escape — Esc
  should close an open popover first, then deselect on a second press.

- [ ] **More keyboard shortcuts**
  Build on the existing set (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, Ctrl+D, Delete).
  Candidates: select all, arrow-key nudge, bracket keys for layer order,
  show/hide layer, group-friendly shortcuts.
