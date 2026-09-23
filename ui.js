// ui.js: the editor. State, undo, inspector, canvas interaction, variants,
// file handling and the export dialog.
//
// Data flow is one-way: input → mutate state.doc → scheduleRender(). Inspector
// controls are built once and only their values are updated on render, so a
// control being dragged or typed in keeps focus.

import * as M from './model.js';
import { iconSheet, stageMarkup } from './render.js';
import {
  PRESETS, REGIONS, MASKS, parseCustomSizes, planExport, runExport, renderCanvas, download,
} from './export.js';
import { confirmDialog, isDialogOpen } from './dialog.js';
import { createColorField } from './colorpicker.js';

const STORAGE_KEY = 'icon-recomposer-2/doc';
const EXPORT_PREFS_KEY = 'icon-recomposer-2/export';
const UNSAVED_KEY = 'icon-recomposer-2/unsaved';
const $ = (id) => document.getElementById(id);

const state = {
  doc: loadStoredDocument(),
  ui: { variant: 0, selected: null, editAll: false, guides: false, zoom: 4, unsaved: loadUnsaved() },
};
const history = { undo: [], redo: [], pending: null };

function loadStoredDocument() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) return M.parseProject(text);
  } catch { /* fall through to the sample */ }
  return M.sampleDocument();
}

// "Unsaved" means changed since the last Save, Open or New. The document itself
// is always autosaved to the browser; this tracks whether a project file holds it.
function loadUnsaved() {
  try {
    return localStorage.getItem(UNSAVED_KEY) === '1';
  } catch {
    return false;
  }
}

function setUnsaved(v) {
  state.ui.unsaved = v;
  try {
    if (v) localStorage.setItem(UNSAVED_KEY, '1');
    else localStorage.removeItem(UNSAVED_KEY);
  } catch { /* storage unavailable */ }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, M.serializeProject(state.doc));
  } catch { /* storage unavailable: the session still works */ }
}

// ---------------------------------------------------------------------------
// state helpers

const variant = () => state.doc.variants[state.ui.variant];
const selectedShape = () => variant().shapes.find((s) => s.id === state.ui.selected) || null;
const targets = () => (state.ui.editAll ? state.doc.variants : [variant()]);

function forShape(id, fn) {
  for (const v of targets()) {
    const s = v.shapes.find((x) => x.id === id);
    if (s) fn(s, v);
  }
}

function begin() {
  if (!history.pending) history.pending = structuredClone(state.doc);
}

function commit() {
  if (history.pending) {
    history.undo.push(history.pending);
    if (history.undo.length > 200) history.undo.shift();
    history.redo = [];
    history.pending = null;
    setUnsaved(true);
    persist();
  }
  scheduleRender();
}

// A live change inside a gesture (slider drag, canvas drag). commit() ends it.
function mutate(fn) {
  begin();
  fn();
  scheduleRender();
}

// A one-shot change: its own undo step.
function edit(fn) {
  begin();
  fn();
  commit();
}

function restore(doc) {
  state.doc = doc;
  state.ui.variant = Math.min(state.ui.variant, doc.variants.length - 1);
  if (!selectedShape()) state.ui.selected = null;
  setUnsaved(true);
  persist();
  scheduleRender();
}

function undo() {
  commit();
  const prev = history.undo.pop();
  if (!prev) return;
  history.redo.push(structuredClone(state.doc));
  restore(prev);
}

function redo() {
  commit();
  const next = history.redo.pop();
  if (!next) return;
  history.undo.push(structuredClone(state.doc));
  restore(next);
}

function loadDocument(doc) {
  state.doc = doc;
  state.ui.variant = 0;
  state.ui.selected = null;
  history.undo = [];
  history.redo = [];
  history.pending = null;
  setUnsaved(false);
  persist();
  scheduleRender();
}

// ---------------------------------------------------------------------------
// render loop

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  document.title = `${state.ui.unsaved ? '• ' : ''}${state.doc.name || 'icon'} - Icon Recomposer`;
  if (document.activeElement !== $('doc-name')) $('doc-name').value = state.doc.name;
  $('btn-undo').disabled = !history.undo.length && !history.pending;
  $('btn-redo').disabled = !history.redo.length;
  $('edit-all').checked = state.ui.editAll;
  renderStage();
  renderSelection();
  renderShapeList();
  renderVariants();
  inspector.update();
}

// ---------------------------------------------------------------------------
// stage

let sheet = null;
let stageRoot = null;

function mountIcon(host) {
  const root = host.attachShadow({ mode: 'open' });
  root.adoptedStyleSheets = [sheet];
  return root;
}

function renderStage() {
  stageRoot.innerHTML = stageMarkup(variant());
  $('stage-frame').classList.toggle('no-bg', variant().background.transparent);
  $('guides').hidden = !state.ui.guides;
}

function fitStage() {
  const box = $('canvas-box').getBoundingClientRect();
  const avail = Math.max(120, Math.min(box.width, box.height) - 48);
  state.ui.zoom = avail / M.CANVAS;
  const px = M.CANVAS * state.ui.zoom;
  $('stage-host').style.zoom = state.ui.zoom;
  $('stage-frame').style.width = `${px}px`;
  $('stage-frame').style.height = `${px}px`;
  renderSelection();
}

function renderSelection() {
  const s = selectedShape();
  const sel = $('selection');
  if (!s || s.hidden) {
    sel.hidden = true;
    return;
  }
  const z = state.ui.zoom;
  sel.hidden = false;
  sel.style.left = `${s.x * z}px`;
  sel.style.top = `${s.y * z}px`;
  sel.style.width = `${s.w * z}px`;
  sel.style.height = `${s.h * z}px`;
  sel.style.transform = s.rotation ? `rotate(${s.rotation}deg)` : '';
  sel.style.borderRadius = s.kind === 'ellipse' ? '50%' : `${s.radius * z}px`;
  for (const h of sel.querySelectorAll('.handle')) {
    const hv = h.dataset.handle;
    if (hv === 'rot') {
      h.style.left = '50%';
      h.style.top = '-22px';
      continue;
    }
    const [hx, hy] = hv.split(',').map(Number);
    h.style.left = `${((hx + 1) / 2) * 100}%`;
    h.style.top = `${((hy + 1) / 2) * 100}%`;
    h.style.cursor = cursorFor(hx, hy, s.rotation);
  }
}

function cursorFor(hx, hy, rotation) {
  const names = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
  const angle = (Math.atan2(hy, hx) * 180) / Math.PI + rotation;
  const idx = Math.round((((angle % 180) + 180) % 180) / 45) % 4;
  return names[idx];
}

// ---------------------------------------------------------------------------
// canvas interaction

const rad = (d) => (d * Math.PI) / 180;
const round2 = (n) => Math.round(n * 100) / 100;
let drag = null;

function toCanvas(e) {
  const r = $('stage-frame').getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * M.CANVAS,
    y: ((e.clientY - r.top) / r.height) * M.CANVAS,
  };
}

function toLocal(s, p) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const t = rad(s.rotation);
  const dx = p.x - cx;
  const dy = p.y - cy;
  return { x: dx * Math.cos(t) + dy * Math.sin(t), y: -dx * Math.sin(t) + dy * Math.cos(t) };
}

function hitTest(p) {
  const shapes = M.paintOrder(variant().shapes);
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.hidden) continue;
    const l = toLocal(s, p);
    const hw = s.w / 2;
    const hh = s.h / 2;
    const inside = s.kind === 'ellipse'
      ? (l.x / hw) ** 2 + (l.y / hh) ** 2 <= 1
      : Math.abs(l.x) <= hw && Math.abs(l.y) <= hh;
    if (inside) return s;
  }
  return null;
}

function onCanvasDown(e) {
  if (e.button !== 0) return;
  const p = toCanvas(e);
  const handle = e.target.closest?.('.handle');
  const s = selectedShape();
  if (handle && s) {
    const hv = handle.dataset.handle;
    drag = hv === 'rot'
      ? { kind: 'rotate', id: s.id }
      : { kind: 'resize', id: s.id, h: hv.split(',').map(Number), start: p, orig: { ...s } };
  } else {
    const hit = hitTest(p);
    state.ui.selected = hit ? hit.id : null;
    drag = hit ? { kind: 'move', id: hit.id, start: p, orig: { x: hit.x, y: hit.y } } : null;
    scheduleRender();
  }
  if (drag) {
    $('canvas-box').setPointerCapture(e.pointerId);
    e.preventDefault();
  }
}

function onCanvasMove(e) {
  if (!drag) return;
  const p = toCanvas(e);
  if (drag.kind === 'move') {
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (!dx && !dy) return;
    mutate(() => forShape(drag.id, (s) => {
      s.x = round2(drag.orig.x + dx);
      s.y = round2(drag.orig.y + dy);
    }));
  } else if (drag.kind === 'rotate') {
    const s = selectedShape();
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    let a = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
    if (e.shiftKey) a = Math.round(a / 15) * 15;
    a = ((((a + 180) % 360) + 360) % 360) - 180;
    mutate(() => forShape(drag.id, (x) => { x.rotation = round2(a); }));
  } else if (drag.kind === 'resize') {
    resizeTo(p, e.shiftKey);
  }
}

// Resizes in the shape's own rotated frame: the dragged edge follows the
// pointer and the opposite edge stays put.
function resizeTo(p, keepAspect) {
  const o = drag.orig;
  const [hx, hy] = drag.h;
  const t = rad(o.rotation);
  const c = Math.cos(t);
  const sn = Math.sin(t);
  const wx = p.x - drag.start.x;
  const wy = p.y - drag.start.y;
  const lx = wx * c + wy * sn;
  const ly = -wx * sn + wy * c;
  let w = hx ? Math.max(1, o.w + hx * lx) : o.w;
  let h = hy ? Math.max(1, o.h + hy * ly) : o.h;
  if (keepAspect && hx && hy) {
    const k = Math.max(w / o.w, h / o.h);
    w = o.w * k;
    h = o.h * k;
  }
  const cxl = (hx * (w - o.w)) / 2;
  const cyl = (hy * (h - o.h)) / 2;
  const cx = o.x + o.w / 2 + cxl * c - cyl * sn;
  const cy = o.y + o.h / 2 + cxl * sn + cyl * c;
  mutate(() => forShape(drag.id, (s) => {
    s.w = round2(w);
    s.h = round2(h);
    s.x = round2(cx - w / 2);
    s.y = round2(cy - h / 2);
  }));
}

function onCanvasUp() {
  if (!drag) return;
  drag = null;
  commit();
}

// ---------------------------------------------------------------------------
// shape list

function renderShapeList() {
  const list = $('shape-list');
  const v = variant();
  const ordered = M.paintOrder(v.shapes).reverse();
  list.replaceChildren();
  if (!ordered.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No shapes yet. Add a rectangle or circle.';
    list.append(li);
  }
  let group = null;
  for (const s of ordered) {
    if (s.layer !== group) {
      group = s.layer;
      const head = document.createElement('li');
      head.className = 'group-head';
      head.textContent = group === 'background' ? 'Background layer' : 'Foreground layer';
      list.append(head);
    }
    const li = document.createElement('li');
    li.className = 'shape-row';
    li.classList.toggle('selected', s.id === state.ui.selected);
    li.classList.toggle('hidden-shape', s.hidden);
    const sw = document.createElement('span');
    sw.className = `shape-swatch ${s.kind}`;
    sw.style.background = s.style.color;
    const name = document.createElement('span');
    name.className = 'shape-name';
    name.textContent = s.name;
    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.type = 'button';
    eye.textContent = s.hidden ? 'Show' : 'Hide';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      edit(() => forShape(s.id, (x) => { x.hidden = !s.hidden; }));
    });
    li.append(sw, name, eye);
    li.addEventListener('click', () => {
      state.ui.selected = s.id;
      scheduleRender();
    });
    list.append(li);
  }
  const s = selectedShape();
  for (const id of ['btn-shape-up', 'btn-shape-down', 'btn-shape-dup', 'btn-shape-del']) $(id).disabled = !s;
}

function addShape(kind) {
  const shape = M.newShape(kind);
  const layerCount = variant().shapes.length;
  shape.name = `${shape.name} ${layerCount + 1}`;
  edit(() => {
    for (const v of targets()) v.shapes.push(structuredClone(shape));
  });
  state.ui.selected = shape.id;
  scheduleRender();
}

function duplicateShape() {
  const s = selectedShape();
  if (!s) return;
  const id = M.newId('s');
  edit(() => {
    for (const v of targets()) {
      const i = v.shapes.findIndex((x) => x.id === s.id);
      if (i < 0) continue;
      const copy = structuredClone(v.shapes[i]);
      copy.id = id;
      copy.name = `${copy.name} copy`;
      copy.x += 4;
      copy.y += 4;
      v.shapes.splice(i + 1, 0, copy);
    }
  });
  state.ui.selected = id;
  scheduleRender();
}

function deleteShape() {
  const s = selectedShape();
  if (!s) return;
  edit(() => {
    for (const v of targets()) v.shapes = v.shapes.filter((x) => x.id !== s.id);
  });
  state.ui.selected = null;
  scheduleRender();
}

// Moves the shape one step up (toward the top of its layer) or down, swapping
// with the nearest shape on the same layer.
function moveShape(dir) {
  const s = selectedShape();
  if (!s) return;
  edit(() => {
    for (const v of targets()) {
      const i = v.shapes.findIndex((x) => x.id === s.id);
      if (i < 0) continue;
      const layer = v.shapes[i].layer;
      let j = i + dir;
      while (j >= 0 && j < v.shapes.length && v.shapes[j].layer !== layer) j += dir;
      if (j < 0 || j >= v.shapes.length) continue;
      [v.shapes[i], v.shapes[j]] = [v.shapes[j], v.shapes[i]];
    }
  });
}

// ---------------------------------------------------------------------------
// variants strip

const thumbs = new Map();

function renderVariants() {
  const strip = $('variant-strip');
  if (addCard.parentNode !== strip) strip.append(addCard);
  const seen = new Set();
  state.doc.variants.forEach((v, i) => {
    seen.add(v.id);
    let t = thumbs.get(v.id);
    if (!t) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'variant-card';
      const host = document.createElement('div');
      host.className = 'thumb';
      const inner = document.createElement('div');
      inner.style.zoom = 86 / M.CANVAS;
      host.append(inner);
      const name = document.createElement('span');
      name.className = 'vname';
      card.append(host, name);
      card.addEventListener('click', () => {
        commit();
        state.ui.variant = state.doc.variants.findIndex((x) => x.id === v.id);
        if (!selectedShape()) state.ui.selected = null;
        scheduleRender();
      });
      t = { card, root: mountIcon(inner), name, markup: '' };
      thumbs.set(v.id, t);
    }
    const markup = stageMarkup(v);
    if (markup !== t.markup) {
      t.root.innerHTML = markup;
      t.markup = markup;
    }
    t.name.textContent = v.name;
    t.card.title = v.name;
    t.card.classList.toggle('active', i === state.ui.variant);
    if (strip.children[i] !== t.card) strip.insertBefore(t.card, strip.children[i] || addCard);
  });
  for (const [id, t] of thumbs) {
    if (!seen.has(id)) {
      t.card.remove();
      thumbs.delete(id);
    }
  }
  if (strip.lastChild !== addCard) strip.append(addCard);
  $('btn-var-del').disabled = state.doc.variants.length < 2;
}

const addCard = document.createElement('button');
addCard.type = 'button';
addCard.className = 'variant-card add';
addCard.title = 'Duplicate the current variant';
addCard.textContent = '+';
addCard.addEventListener('click', () => duplicateCurrentVariant());

function duplicateCurrentVariant() {
  const v = variant();
  const copy = M.duplicateVariant(v, nextVariantName(v.name));
  edit(() => state.doc.variants.splice(state.ui.variant + 1, 0, copy));
  state.ui.variant += 1;
  scheduleRender();
}

function nextVariantName(base) {
  const names = new Set(state.doc.variants.map((v) => v.name));
  const stem = base.replace(/\s+\d+$/, '');
  for (let i = 2; ; i++) if (!names.has(`${stem} ${i}`)) return `${stem} ${i}`;
}

async function deleteCurrentVariant() {
  if (state.doc.variants.length < 2) return;
  const v = variant();
  const ok = await confirmDialog({
    title: `Delete “${v.name}”?`,
    message: 'You can undo this.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  edit(() => state.doc.variants.splice(state.ui.variant, 1));
  state.ui.variant = Math.max(0, state.ui.variant - 1);
  if (!selectedShape()) state.ui.selected = null;
  scheduleRender();
}

// ---------------------------------------------------------------------------
// inspector controls

function fmt(v, step) {
  const decimals = step >= 1 ? 0 : Math.min(3, String(step).split('.')[1]?.length || 0);
  return String(+(+v).toFixed(decimals));
}

function fieldRow(label, control) {
  const row = document.createElement('label');
  row.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  row.append(span, control);
  return row;
}

function slider(label, { min, max, step, get, set, hue = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'slider';
  const range = document.createElement('input');
  range.type = 'range';
  Object.assign(range, { min, max, step });
  if (hue) range.className = 'hue-range';
  const box = document.createElement('input');
  box.type = 'number';
  Object.assign(box, { min, max, step });
  wrap.append(range, box);
  range.addEventListener('input', () => mutate(() => set(+range.value)));
  range.addEventListener('change', commit);
  box.addEventListener('input', () => {
    const n = parseFloat(box.value);
    if (Number.isFinite(n)) mutate(() => set(Math.min(max, Math.max(min, n))));
  });
  box.addEventListener('change', commit);
  const row = fieldRow(label, wrap);
  return {
    el: row,
    update() {
      const v = get();
      range.value = v;
      if (document.activeElement !== box) box.value = fmt(v, step);
    },
  };
}

function numberInput(label, { step = 1, get, set }) {
  const box = document.createElement('input');
  box.type = 'number';
  box.step = step;
  box.addEventListener('input', () => {
    const n = parseFloat(box.value);
    if (Number.isFinite(n)) mutate(() => set(n));
  });
  box.addEventListener('change', commit);
  const lab = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = label;
  lab.append(span, box);
  return {
    el: lab,
    update() {
      if (document.activeElement !== box) box.value = fmt(get(), step);
    },
  };
}

function pair(label, a, b) {
  const wrap = document.createElement('div');
  wrap.className = 'pair';
  wrap.append(a.el, b.el);
  const row = document.createElement('div');
  row.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  row.append(span, wrap);
  return { el: row, update() { a.update(); b.update(); } };
}

function select(label, { options, get, set, disabled }) {
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.label;
    sel.append(opt);
  }
  sel.addEventListener('change', () => edit(() => set(sel.value)));
  return {
    el: fieldRow(label, sel),
    update() {
      sel.value = get();
      sel.disabled = !!disabled?.();
    },
  };
}

function checkbox(label, { get, set }) {
  const lab = document.createElement('label');
  lab.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  const span = document.createElement('span');
  span.textContent = label;
  lab.append(box, span);
  box.addEventListener('change', () => edit(() => set(box.checked)));
  return { el: lab, update() { box.checked = !!get(); } };
}

function text(label, { get, set }) {
  const box = document.createElement('input');
  box.type = 'text';
  box.spellcheck = false;
  box.addEventListener('input', () => mutate(() => set(box.value)));
  box.addEventListener('change', commit);
  return {
    el: fieldRow(label, box),
    update() { if (document.activeElement !== box) box.value = get(); },
  };
}

function color(label, { get, set }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'swatch-btn';
  const field = createColorField(btn, {
    onInput: (hex) => mutate(() => set(hex)),
    onCommit: commit,
  });
  return { el: fieldRow(label, btn), update() { field.setValue(get()); } };
}

function lightPad() {
  const pad = document.createElement('div');
  pad.className = 'lightpad';
  pad.title = 'Drag to move the light';
  const area = document.createElement('div');
  area.className = 'lightpad-area';
  const dot = document.createElement('div');
  dot.className = 'lightpad-dot';
  area.append(dot);
  pad.append(area);
  const apply = (e) => {
    const r = area.getBoundingClientRect();
    let x = ((e.clientX - r.left) / r.width) * 2 - 1;
    let y = ((e.clientY - r.top) / r.height) * 2 - 1;
    x = Math.max(-1, Math.min(1, x));
    y = Math.max(-1, Math.min(1, y));
    if (e.shiftKey) {
      x = Math.round(x);
      y = Math.round(y);
    }
    mutate(() => forScene((sc) => { sc.lightX = round2(x); sc.lightY = round2(y); }));
  };
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    apply(e);
  });
  pad.addEventListener('pointermove', (e) => { if (pad.hasPointerCapture(e.pointerId)) apply(e); });
  pad.addEventListener('pointerup', commit);
  return {
    el: fieldRow('Direction', pad),
    update() {
      const sc = variant().scene;
      dot.style.left = `${((sc.lightX + 1) / 2) * 100}%`;
      dot.style.top = `${((sc.lightY + 1) / 2) * 100}%`;
    },
  };
}

const forScene = (fn) => { for (const v of targets()) fn(v.scene); };
const forBackground = (fn) => { for (const v of targets()) fn(v.background); };

function section(title, controls, { advanced = [] } = {}) {
  const el = document.createElement('section');
  el.className = 'insp-section';
  const h = document.createElement('h2');
  h.textContent = title;
  el.append(h, ...controls.map((c) => c.el));
  let all = controls;
  if (advanced.length) {
    const det = document.createElement('details');
    det.className = 'advanced';
    const sum = document.createElement('summary');
    sum.textContent = 'Advanced';
    const body = document.createElement('div');
    body.className = 'adv-body';
    body.append(...advanced.map((c) => c.el));
    det.append(sum, body);
    el.append(det);
    all = [...controls, ...advanced];
  }
  return { el, update() { for (const c of all) c.update(); } };
}

function buildInspector(root) {
  const sh = () => selectedShape();
  const shapeSet = (fn) => (v) => forShape(state.ui.selected, (s) => fn(s, v));
  const styleCtl = (key) => ({
    get: () => sh().style[key],
    set: shapeSet((s, v) => { s.style[key] = v; }),
  });
  const geoCtl = (key) => ({
    get: () => sh()[key],
    set: shapeSet((s, v) => { s[key] = key === 'w' || key === 'h' ? Math.max(1, v) : v; }),
  });

  const variantSec = section('Variant', [
    text('Name', { get: () => variant().name, set: (v) => { variant().name = v; } }),
  ]);

  const lightSec = section('Light', [
    lightPad(),
    slider('Key light', { min: 0, max: 1, step: 0.01, get: () => variant().scene.key, set: (v) => forScene((s) => { s.key = v; }) }),
    slider('Fill light', { min: 0, max: 1, step: 0.01, get: () => variant().scene.fill, set: (v) => forScene((s) => { s.fill = v; }) }),
  ], {
    advanced: [
      slider('Light hue', { min: 0, max: 360, step: 1, hue: true, get: () => variant().scene.hue, set: (v) => forScene((s) => { s.hue = v; }) }),
      slider('Light tint', { min: 0, max: 100, step: 1, get: () => variant().scene.saturation, set: (v) => forScene((s) => { s.saturation = v; }) }),
      pair('Direction',
        numberInput('X', { step: 0.01, get: () => variant().scene.lightX, set: (v) => forScene((s) => { s.lightX = Math.max(-1, Math.min(1, v)); }) }),
        numberInput('Y', { step: 0.01, get: () => variant().scene.lightY, set: (v) => forScene((s) => { s.lightY = Math.max(-1, Math.min(1, v)); }) })),
    ],
  });

  const bgSec = section('Background', [
    color('Color', { get: () => variant().background.color, set: (v) => forBackground((b) => { b.color = v; }) }),
    checkbox('Shaded by the light', { get: () => variant().background.lit, set: (v) => forBackground((b) => { b.lit = v; }) }),
    checkbox('No background (transparent)', { get: () => variant().background.transparent, set: (v) => forBackground((b) => { b.transparent = v; }) }),
  ]);

  const shapeSec = section('Shape', [
    text('Name', { get: () => sh().name, set: shapeSet((s, v) => { s.name = v; }) }),
    select('Layer', { options: M.LAYERS, ...geoCtl('layer') }),
    select('Kind', {
      options: [{ id: 'rect', label: 'Rectangle' }, { id: 'ellipse', label: 'Ellipse' }],
      ...geoCtl('kind'),
    }),
    pair('Position', numberInput('X', { step: 0.5, ...geoCtl('x') }), numberInput('Y', { step: 0.5, ...geoCtl('y') })),
    pair('Size', numberInput('W', { step: 0.5, ...geoCtl('w') }), numberInput('H', { step: 0.5, ...geoCtl('h') })),
    slider('Corner radius', { min: 0, max: 54, step: 0.5, ...geoCtl('radius') }),
    slider('Rotation', { min: -180, max: 180, step: 1, ...geoCtl('rotation') }),
  ]);

  const lookSec = section('Look', [
    color('Color', styleCtl('color')),
    select('Material', { options: M.MATERIALS, ...styleCtl('material') }),
    select('Surface', { options: M.SURFACES, ...styleCtl('surface'), disabled: () => sh().style.material === 'glass' }),
    slider('Elevation', { min: 0, max: 3, step: 0.05, ...styleCtl('elevation') }),
    slider('Thickness', { min: 0, max: 2, step: 0.05, ...styleCtl('thickness') }),
    checkbox('Rounded edge (fillet)', styleCtl('fillet')),
    checkbox('Beveled edge (chamfer)', styleCtl('chamfer')),
    slider('Opacity', { min: 0, max: 1, step: 0.01, ...styleCtl('opacity') }),
  ], {
    advanced: [
      slider('Fillet width', { min: -2, max: 2, step: 0.1, ...styleCtl('filletWidth') }),
      slider('Chamfer width', { min: -2, max: 2, step: 0.1, ...styleCtl('chamferWidth') }),
      slider('Shade', { min: 0, max: 2, step: 0.01, ...styleCtl('shade') }),
      slider('Curve depth', { min: 0, max: 4, step: 0.05, ...styleCtl('curveScale') }),
      slider('Grain', { min: 0, max: 3, step: 0.05, ...styleCtl('grain') }),
      checkbox('Glow', styleCtl('glow')),
      color('Glow color', styleCtl('glowColor')),
      slider('Glow size', { min: 0, max: 30, step: 0.5, ...styleCtl('glowSize') }),
    ],
  });

  root.append(shapeSec.el, lookSec.el, variantSec.el, lightSec.el, bgSec.el);
  return {
    update() {
      const has = !!sh();
      shapeSec.el.hidden = !has;
      lookSec.el.hidden = !has;
      if (has) {
        shapeSec.update();
        lookSec.update();
      }
      variantSec.update();
      lightSec.update();
      bgSec.update();
    },
  };
}

let inspector = { update() {} };

// ---------------------------------------------------------------------------
// files

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

function confirmReplace(title, confirmLabel) {
  if (!state.ui.unsaved) return Promise.resolve(true);
  return confirmDialog({
    title,
    message: 'The current icon has changes that are not saved to a project file. They will be lost.',
    confirmLabel,
    danger: true,
  });
}

async function newDocument() {
  if (!(await confirmReplace('Start a new icon?', 'Discard and start new'))) return;
  const doc = M.newDocument();
  doc.variants[0].shapes.push(M.newShape('rect', { name: 'Plate', x: 16, y: 16, w: 76, h: 76, radius: 22 }));
  loadDocument(doc);
}

function saveProject() {
  commit();
  const blob = new Blob([M.serializeProject(state.doc)], { type: 'application/json' });
  download(blob, `${M.slug(state.doc.name)}.icjson`);
  setUnsaved(false);
  scheduleRender();
}

async function openFile(file) {
  let doc;
  try {
    doc = M.parseProject(await file.text());
  } catch (err) {
    toast(`${file.name}: ${err.message}`, 'error');
    return;
  }
  if (!(await confirmReplace(`Open “${file.name}”?`, 'Discard and open'))) return;
  loadDocument(doc);
  toast(`Opened ${file.name}`);
}

function setupFileDrop() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth += 1;
    document.body.classList.add('file-drag');
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('file-drag');
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('file-drag');
    if (isDialogOpen() || !$('export-overlay').hidden) return;
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });
}

// ---------------------------------------------------------------------------
// export dialog

const exportUi = { presetBoxes: new Map(), previewTimer: 0, running: false };

function loadExportPrefs() {
  try {
    return JSON.parse(localStorage.getItem(EXPORT_PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveExportPrefs(prefs) {
  try {
    localStorage.setItem(EXPORT_PREFS_KEY, JSON.stringify(prefs));
  } catch { /* per-viewer convenience only */ }
}

function setupExportDialog() {
  const presetsEl = $('ex-presets');
  for (const p of PRESETS) {
    const lab = document.createElement('label');
    lab.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = p.id;
    const span = document.createElement('span');
    span.textContent = p.label;
    lab.append(box, span);
    presetsEl.append(lab);
    exportUi.presetBoxes.set(p.id, box);
  }
  for (const r of REGIONS) $('ex-region').add(new Option(r.label, r.id));
  for (const m of MASKS) $('ex-mask').add(new Option(m.label, m.id));

  const prefs = loadExportPrefs();
  for (const [id, box] of exportUi.presetBoxes) box.checked = (prefs.presets || ['play']).includes(id);
  $('ex-custom').value = prefs.custom || '';
  $('ex-region').value = prefs.region || 'full';
  $('ex-mask').value = prefs.mask || 'none';
  $('ex-transparent').checked = !!prefs.transparent;

  const overlay = $('export-overlay');
  overlay.addEventListener('input', updateExportSummary);
  overlay.addEventListener('change', updateExportSummary);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeExport(); });
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeExport();
  });
  $('ex-cancel').addEventListener('click', closeExport);
  $('ex-go').addEventListener('click', doExport);
}

function exportSettings() {
  return {
    scope: document.querySelector('input[name="ex-variants"]:checked').value,
    presets: [...exportUi.presetBoxes].filter(([, b]) => b.checked).map(([id]) => id),
    custom: $('ex-custom').value,
    region: $('ex-region').value,
    mask: $('ex-mask').value,
    transparent: $('ex-transparent').checked,
  };
}

function exportJobs(s) {
  const variants = s.scope === 'all' ? state.doc.variants : [variant()];
  return planExport(state.doc.name, { variants, presets: s.presets, customSizes: parseCustomSizes(s.custom) });
}

function openExport() {
  commit();
  $('ex-all-label').textContent = `All variants (${state.doc.variants.length})`;
  $('export-overlay').hidden = false;
  $('ex-go').focus();
  updateExportSummary();
}

function closeExport() {
  if (exportUi.running) return;
  $('export-overlay').hidden = true;
}

function updateExportSummary() {
  const s = exportSettings();
  const jobs = exportJobs(s);
  const images = jobs.filter((j) => j.text === undefined).length;
  const extra = jobs.length - images;
  $('ex-summary').textContent = jobs.length
    ? `${images} PNG${images === 1 ? '' : 's'}${extra ? ` + ${extra} XML` : ''}${jobs.length > 1 ? ', downloaded as one zip.' : '.'}`
    : 'Pick at least one size.';
  $('ex-go').disabled = !jobs.length;
  clearTimeout(exportUi.previewTimer);
  exportUi.previewTimer = setTimeout(async () => {
    try {
      const canvas = await renderCanvas(variant(), {
        size: 400, region: s.region, mask: s.mask, transparent: s.transparent,
      });
      $('ex-preview').src = canvas.toDataURL('image/png');
    } catch (err) {
      $('ex-summary').textContent = `Preview failed: ${err.message}`;
    }
  }, 120);
}

async function doExport() {
  const s = exportSettings();
  const jobs = exportJobs(s);
  if (!jobs.length) return;
  saveExportPrefs({ presets: s.presets, custom: s.custom, region: s.region, mask: s.mask, transparent: s.transparent });
  const btn = $('ex-go');
  exportUi.running = true;
  btn.disabled = true;
  try {
    const out = await runExport(state.doc.name, jobs, {
      region: s.region, mask: s.mask, transparent: s.transparent,
    }, (i, n) => { btn.textContent = `Exporting ${i}/${n}…`; });
    download(out.blob, out.filename);
    exportUi.running = false;
    closeExport();
    toast(`Exported ${out.filename}`);
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    exportUi.running = false;
    btn.textContent = 'Export';
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// keyboard

function isTyping(e) {
  const t = e.target;
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onKey(e) {
  if (isDialogOpen() || !$('export-overlay').hidden) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); saveProject(); return; }
  if (mod && k === 'o') { e.preventDefault(); $('file-open').click(); return; }
  if (isTyping(e)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicateShape(); return; }
  if (e.key === 'Escape') { state.ui.selected = null; scheduleRender(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteShape(); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const s = selectedShape();
  if (arrows[e.key] && s) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const [dx, dy] = arrows[e.key];
    edit(() => forShape(s.id, (x) => { x.x = round2(s.x + dx * step); x.y = round2(s.y + dy * step); }));
  }
}

// ---------------------------------------------------------------------------
// wiring

async function init() {
  $('app-version').textContent = `v${M.APP_VERSION}`;
  sheet = await iconSheet();
  stageRoot = mountIcon($('stage-host'));
  inspector = buildInspector($('inspector'));

  $('doc-name').addEventListener('input', (e) => mutate(() => { state.doc.name = e.target.value; }));
  $('doc-name').addEventListener('change', commit);
  $('btn-new').addEventListener('click', newDocument);
  $('btn-open').addEventListener('click', () => $('file-open').click());
  $('file-open').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) openFile(f);
  });
  $('btn-save').addEventListener('click', saveProject);
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-export').addEventListener('click', openExport);
  $('btn-add-rect').addEventListener('click', () => addShape('rect'));
  $('btn-add-ellipse').addEventListener('click', () => addShape('ellipse'));
  $('btn-shape-up').addEventListener('click', () => moveShape(1));
  $('btn-shape-down').addEventListener('click', () => moveShape(-1));
  $('btn-shape-dup').addEventListener('click', duplicateShape);
  $('btn-shape-del').addEventListener('click', deleteShape);
  $('btn-var-dup').addEventListener('click', duplicateCurrentVariant);
  $('btn-var-del').addEventListener('click', deleteCurrentVariant);
  $('edit-all').addEventListener('change', (e) => { state.ui.editAll = e.target.checked; });
  $('show-guides').addEventListener('change', (e) => { state.ui.guides = e.target.checked; scheduleRender(); });

  const box = $('canvas-box');
  box.addEventListener('pointerdown', onCanvasDown);
  box.addEventListener('pointermove', onCanvasMove);
  box.addEventListener('pointerup', onCanvasUp);
  box.addEventListener('pointercancel', onCanvasUp);
  new ResizeObserver(fitStage).observe(box);

  document.addEventListener('keydown', onKey);
  setupFileDrop();

  setupExportDialog();
  fitStage();
  render();
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<div class="toast error">Failed to start: ${String(err.message).replace(/</g, '&lt;')}</div>`);
});
