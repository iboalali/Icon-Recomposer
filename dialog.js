// dialog.js — in-page modal dialogs, replacing native confirm()/alert() whose
// chrome can't match the app's dark theme and (in some browsers) steal focus.
//
// One shared overlay element, reused per call (same pattern as colorpicker.js).
// confirmDialog(opts) returns a Promise<boolean> (true = confirmed).
//
// Keyboard is handled on the overlay itself (not document) and stopped there, so
// the global app shortcuts (undo, deselect, delete…) never fire while a dialog
// is open. Esc = cancel, Enter = confirm, Tab cycles the two buttons.

let overlay = null;
let resolveCurrent = null;

function build() {
  overlay = document.createElement('div');
  overlay.className = 'dlg-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      <h2 class="dlg-title" id="dlg-title"></h2>
      <p class="dlg-msg"></p>
      <div class="dlg-actions">
        <button class="dlg-cancel tbtn" type="button"></button>
        <button class="dlg-confirm tbtn" type="button"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay._title = overlay.querySelector('.dlg-title');
  overlay._msg = overlay.querySelector('.dlg-msg');
  overlay._cancel = overlay.querySelector('.dlg-cancel');
  overlay._confirm = overlay.querySelector('.dlg-confirm');

  overlay._cancel.addEventListener('click', () => finish(false));
  overlay._confirm.addEventListener('click', () => finish(true));
  // Click on the backdrop (outside the dialog box) cancels.
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) finish(false); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Tab') { // trap focus within the two buttons
      e.preventDefault();
      (document.activeElement === overlay._confirm ? overlay._cancel : overlay._confirm).focus();
    }
  });
}

function finish(result) {
  if (!overlay) return;
  overlay.hidden = true;
  const r = resolveCurrent;
  resolveCurrent = null;
  if (r) r(result);
}

export function isDialogOpen() {
  return !!overlay && !overlay.hidden;
}

// Show a modal confirm. Resolves true if confirmed, false if cancelled/dismissed.
//   { title, message, confirmLabel, cancelLabel, danger }
export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  if (!overlay) build();
  if (resolveCurrent) finish(false); // resolve any stale open dialog first
  overlay._title.textContent = title;
  overlay._msg.textContent = message;
  overlay._msg.style.display = message ? '' : 'none';
  overlay._confirm.textContent = confirmLabel;
  overlay._cancel.textContent = cancelLabel;
  overlay._confirm.classList.toggle('danger', !!danger);
  overlay.hidden = false;
  overlay._confirm.focus(); // Enter confirms (matches native confirm())
  return new Promise((resolve) => { resolveCurrent = resolve; });
}
