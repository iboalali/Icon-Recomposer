// colorpicker.js — a small in-page color popover (RGB hex).
//
// Replaces native <input type="color"> whose popup is browser-positioned and
// clips off-screen near the right-edge inspector. This popover is appended to
// <body> as position:fixed and clamped to the viewport, so it's always visible.
//
// Usage: createColorField(swatchButton, { onInput, onCommit }).
//   onInput(hex)  fires live while editing (drag/type) — mutate + scheduleRender
//   onCommit()    fires when the gesture ends (close/blur) — finalize undo
// The field exposes setValue(hex) for the render loop to reflect state.

// ---- color math ----
function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16) || 0, g: parseInt(h.slice(2, 4), 16) || 0, b: parseInt(h.slice(4, 6), 16) || 0 };
}
function rgbToHex(r, g, b) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// One shared popover element, reused by whichever field is open.
let pop = null;
let activeField = null;

function buildPopover() {
  pop = document.createElement('div');
  pop.className = 'cp-popover';
  pop.hidden = true;
  pop.innerHTML = `
    <div class="cp-sv"><div class="cp-sv-thumb"></div></div>
    <div class="cp-hue"><div class="cp-hue-thumb"></div></div>
    <div class="cp-foot">
      <span class="cp-preview"></span>
      <input class="cp-hex" type="text" spellcheck="false" maxlength="7" />
    </div>`;
  document.body.appendChild(pop);

  const sv = pop.querySelector('.cp-sv');
  const svThumb = pop.querySelector('.cp-sv-thumb');
  const hue = pop.querySelector('.cp-hue');
  const hueThumb = pop.querySelector('.cp-hue-thumb');
  const hex = pop.querySelector('.cp-hex');
  pop._els = { sv, svThumb, hue, hueThumb, hex, preview: pop.querySelector('.cp-preview') };

  // saturation/value drag
  dragArea(sv, (px, py) => {
    if (!activeField) return;
    activeField.hsv.s = clamp01(px);
    activeField.hsv.v = clamp01(1 - py);
    activeField.emit();
  });
  // hue drag
  dragArea(hue, (px) => {
    if (!activeField) return;
    activeField.hsv.h = clamp01(px) * 360;
    activeField.emit();
  });
  // hex typing
  hex.addEventListener('input', () => {
    if (!activeField) return;
    let v = hex.value.trim();
    if (v[0] !== '#') v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      activeField.hsv = rgbToHsv(...Object.values(hexToRgb(v)));
      activeField.emit(true); // don't overwrite the field the user is typing in
    }
  });
}

function dragArea(el, onMove) {
  const handle = (e) => {
    const rect = el.getBoundingClientRect();
    onMove((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    handle(e);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (el.hasPointerCapture(e.pointerId)) handle(e);
  });
}

function positionPopover(swatch) {
  const r = swatch.getBoundingClientRect();
  pop.hidden = false; // must be visible to measure
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const margin = 8;
  let left = r.left;
  let top = r.bottom + 6;
  if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
  if (left < margin) left = margin;
  if (top + ph > window.innerHeight - margin) top = r.top - ph - 6; // flip above
  if (top < margin) top = margin;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

export function createColorField(swatch, { onInput, onCommit }) {
  if (!pop) buildPopover();

  const field = {
    swatch,
    value: '#000000',
    hsv: { h: 0, s: 0, v: 0 },
    open: false,
    onInput,
    onCommit,
    // Called by the render loop to reflect state. Ignored while open (the
    // popover is the source of truth mid-edit).
    setValue(hex) {
      this.value = hex;
      swatch.style.background = hex;
      if (!this.open) this.hsv = rgbToHsv(...Object.values(hexToRgb(hex)));
    },
    // Push current hsv → hex, update UI, fire onInput.
    emit(skipHexInput) {
      const rgb = hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      this.value = hex;
      swatch.style.background = hex;
      if (pop && activeField === this) {
        const { svThumb, hueThumb, sv, hue, preview, hex: hexInput } = pop._els;
        sv.style.backgroundColor = `hsl(${this.hsv.h}, 100%, 50%)`;
        svThumb.style.left = this.hsv.s * 100 + '%';
        svThumb.style.top = (1 - this.hsv.v) * 100 + '%';
        hueThumb.style.left = (this.hsv.h / 360) * 100 + '%';
        preview.style.background = hex;
        if (!skipHexInput) hexInput.value = hex;
      }
      this.onInput(hex);
    },
    openPicker() {
      if (this.open) return closePicker();
      activeField = this;
      this.open = true;
      // sync popover to current value
      pop._els.hex.value = this.value;
      this.emit();
      positionPopover(swatch);
      pop._els.hex.value = this.value;
    },
  };

  swatch.addEventListener('click', (e) => {
    e.stopPropagation();
    field.openPicker();
  });

  return field;
}

function closePicker() {
  if (!activeField) return;
  pop.hidden = true;
  const f = activeField;
  activeField = null;
  f.open = false;
  if (f.onCommit) f.onCommit();
}

// Close on outside click / Escape.
document.addEventListener('click', (e) => {
  if (activeField && pop && !pop.contains(e.target) && e.target !== activeField.swatch) closePicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeField) {
    closePicker();
    // This Escape closed the popover — stop it here so the app's global handler
    // (registered later on document) doesn't ALSO treat it as "deselect layer".
    e.stopImmediatePropagation();
  }
});
