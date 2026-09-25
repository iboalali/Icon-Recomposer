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
import { confirmDialog } from './dialog.js';
import { createColorField } from './colorpicker.js';
import { importVectorDrawable, looksLikeVectorDrawable } from './vdimport.js';

const STORAGE_KEY = 'icon-recomposer-2/doc';
const EXPORT_PREFS_KEY = 'icon-recomposer-2/export';
const UNSAVED_KEY = 'icon-recomposer-2/unsaved';
const VARIANT_KEY = 'icon-recomposer-2/variant';
const $ = (id) => document.getElementById(id);

const state = {
  doc: loadStoredDocument(),
  ui: {
    variant: 0, selected: [], primary: null, editAll: false, guides: false, unsaved: loadUnsaved(),
    // zoom = fit * view.scale is CSS px per canvas unit; view.scale 1 fits the
    // canvas, and pan (screen px) moves the frame inside the canvas area.
    zoom: 4, fit: 4, view: { scale: 1, panX: 0, panY: 0 },
  },
};
const history = { undo: [], redo: [], pending: null };
state.ui.variant = loadVariantIndex(state.doc);
// Saved right away so a fresh sample keeps its ids (and remembered variant)
// across reloads, not only after the first edit.
persist();

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

// The selected variant is remembered by id, so a reload reopens it.
function loadVariantIndex(doc) {
  try {
    const i = doc.variants.findIndex((v) => v.id === localStorage.getItem(VARIANT_KEY));
    return i < 0 ? 0 : i;
  } catch {
    return 0;
  }
}

let rememberedVariant = null;
function rememberVariant() {
  const id = variant().id;
  if (id === rememberedVariant) return;
  rememberedVariant = id;
  try {
    localStorage.setItem(VARIANT_KEY, id);
  } catch { /* per-viewer convenience only */ }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, M.serializeProject(state.doc));
  } catch { /* storage unavailable: the session still works */ }
}

// ---------------------------------------------------------------------------
// state helpers

const variant = () => state.doc.variants[state.ui.variant];
// Selection is a list of shape ids in the current variant. The primary shape is
// the one clicked last: the inspector shows its values and single-shape
// handles belong to it.
const selectedShapes = () => variant().shapes.filter((s) => state.ui.selected.includes(s.id));
const primaryShape = () => {
  const sel = selectedShapes();
  return sel.find((s) => s.id === state.ui.primary) || sel[sel.length - 1] || null;
};
const isSelected = (id) => state.ui.selected.includes(id);

function setSelection(ids, primary = ids[ids.length - 1] ?? null) {
  state.ui.selected = [...new Set(ids)];
  state.ui.primary = primary;
  scheduleRender();
}

function pruneSelection() {
  const ids = new Set(variant().shapes.map((s) => s.id));
  state.ui.selected = state.ui.selected.filter((id) => ids.has(id));
  if (!ids.has(state.ui.primary)) state.ui.primary = state.ui.selected[state.ui.selected.length - 1] ?? null;
}

function forSelected(fn) {
  for (const id of state.ui.selected) forShape(id, fn);
}
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
  pruneSelection();
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
  state.ui.view = { scale: 1, panX: 0, panY: 0 };
  if ($('stage-frame')) applyView();
  state.ui.variant = 0;
  state.ui.selected = [];
  state.ui.primary = null;
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
  rememberVariant();
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
  stageRoot.innerHTML = stageMarkup(variant(), { pxPerUnit: state.ui.zoom * devicePixelRatio });
  $('stage-frame').classList.toggle('no-bg', variant().background.transparent);
  $('guides').hidden = !state.ui.guides;
  renderTraceGuide();
}

let guideDrawn = null;
function renderTraceGuide() {
  const g = state.doc.guide;
  $('guide-controls').hidden = !g;
  const layer = $('guide-layer');
  layer.hidden = !g || !g.visible;
  if (!g) return;
  $('show-trace').checked = g.visible;
  $('trace-label').textContent = `Tracing guide (${g.name})`;
  if (guideDrawn === g) return;
  guideDrawn = g;
  const NS = 'http://www.w3.org/2000/svg';
  layer.replaceChildren(...g.paths.map((p) => {
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('d', p.d);
    el.setAttribute('fill', p.fill);
    if (p.evenOdd) el.setAttribute('fill-rule', 'evenodd');
    return el;
  }));
}

// ---------------------------------------------------------------------------
// zoom and pan (view only: never part of the document or the exports)
//
// The frame grows through CSS zoom rather than a transform, so the icon is
// laid out and painted again at the new size and stays sharp. toCanvas reads
// the frame's live rect, so hit tests and drags work at any zoom.

const MAX_ZOOM = 16;
const activePointers = new Map();
let pinch = null;
let panDrag = null;
let spaceHeld = false;

function fitStage() {
  const box = $('canvas-box').getBoundingClientRect();
  state.ui.fit = Math.max(120, Math.min(box.width, box.height) - 48) / M.CANVAS;
  applyView();
}

function boxCenter() {
  const r = $('canvas-box').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}

function clampView() {
  const v = state.ui.view;
  const c = boxCenter();
  const size = M.CANVAS * state.ui.fit * v.scale;
  // Free panning, as long as at least 48 px of the canvas stays in view.
  const maxX = Math.max(0, (size + c.w) / 2 - 48);
  const maxY = Math.max(0, (size + c.h) / 2 - 48);
  v.panX = Math.max(-maxX, Math.min(maxX, v.panX));
  v.panY = Math.max(-maxY, Math.min(maxY, v.panY));
}

function applyView() {
  const v = state.ui.view;
  clampView();
  state.ui.zoom = state.ui.fit * v.scale;
  const px = M.CANVAS * state.ui.zoom;
  $('stage-host').style.zoom = state.ui.zoom;
  $('stage-frame').style.width = `${px}px`;
  $('stage-frame').style.height = `${px}px`;
  $('stage-frame').style.transform = `translate(calc(-50% + ${v.panX}px), calc(-50% + ${v.panY}px))`;
  $('zoom-level').textContent = `${Math.round(v.scale * 100)}%`;
  $('btn-zoom-out').disabled = v.scale <= 1;
  $('btn-zoom-in').disabled = v.scale >= MAX_ZOOM;
  $('canvas-box').classList.toggle('pannable', spaceHeld);
  $('canvas-box').classList.toggle('panning', !!panDrag);
  scheduleRender();
}

// Zooms toward a client-space point, keeping the content under it in place:
// pan' = k * pan + (1 - k) * (point - center), k = scale' / scale.
function zoomAt(cx, cy, factor) {
  const v = state.ui.view;
  const next = Math.max(1, Math.min(MAX_ZOOM, v.scale * factor));
  if (next === v.scale) return;
  const k = next / v.scale;
  const c = boxCenter();
  v.panX = k * v.panX + (1 - k) * (cx - c.x);
  v.panY = k * v.panY + (1 - k) * (cy - c.y);
  v.scale = next;
  applyView();
}

function zoomBy(factor) {
  const c = boxCenter();
  zoomAt(c.x, c.y, factor);
}

function resetView() {
  state.ui.view = { scale: 1, panX: 0, panY: 0 };
  applyView();
}

// Frames the selected shapes (all visible shapes if none are selected) so they
// fill about 60% of the canvas area.
function zoomToSelection() {
  const shapes = (selectedShapes().length ? selectedShapes() : variant().shapes).filter((s) => !s.hidden);
  if (!shapes.length) return resetView();
  const b = shapes.map(shapeBounds).reduce((a, x) => ({
    x0: Math.min(a.x0, x.x0), y0: Math.min(a.y0, x.y0), x1: Math.max(a.x1, x.x1), y1: Math.max(a.y1, x.y1),
  }));
  const c = boxCenter();
  const extent = Math.max(b.x1 - b.x0, b.y1 - b.y0, 2);
  const v = state.ui.view;
  v.scale = Math.max(1, Math.min(MAX_ZOOM, (Math.min(c.w, c.h) * 0.6) / (extent * state.ui.fit)));
  const zoom = state.ui.fit * v.scale;
  v.panX = -((b.x0 + b.x1) / 2 - M.CANVAS / 2) * zoom;
  v.panY = -((b.y0 + b.y1) / 2 - M.CANVAS / 2) * zoom;
  applyView();
}

function onCanvasWheel(e) {
  e.preventDefault();
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16;
  else if (e.deltaMode === 2) dy *= $('canvas-box').clientHeight;
  zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
}

function startPan(e) {
  const v = state.ui.view;
  panDrag = { x: e.clientX, y: e.clientY, panX: v.panX, panY: v.panY };
  $('canvas-box').setPointerCapture(e.pointerId);
  e.preventDefault();
  applyView();
}

const pointerDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pointerMid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function startPinch() {
  const [a, b] = [...activePointers.values()];
  const v = state.ui.view;
  pinch = { dist: pointerDist(a, b) || 1, mid: pointerMid(a, b), scale: v.scale, panX: v.panX, panY: v.panY };
}

function onPinchMove() {
  const [a, b] = [...activePointers.values()];
  if (!a || !b) return;
  const v = state.ui.view;
  const c = boxCenter();
  const m = pointerMid(a, b);
  const next = Math.max(1, Math.min(MAX_ZOOM, pinch.scale * (pointerDist(a, b) / pinch.dist)));
  const k = next / pinch.scale;
  v.panX = k * pinch.panX + ((m.x - c.x) - k * (pinch.mid.x - c.x));
  v.panY = k * pinch.panY + ((m.y - c.y) - k * (pinch.mid.y - c.y));
  v.scale = next;
  applyView();
}

function renderSelection() {
  const shapes = selectedShapes().filter((s) => !s.hidden);
  const sel = $('selection');
  const outlines = $('outlines');
  const z = state.ui.zoom;
  outlines.replaceChildren();
  if (shapes.length > 1) {
    sel.hidden = true;
    for (const s of shapes) {
      const o = document.createElement('div');
      o.className = 'sel-outline';
      o.classList.toggle('primary', s.id === state.ui.primary);
      placeBox(o, s, z);
      outlines.append(o);
    }
    return;
  }
  const s = shapes[0];
  if (!s) {
    sel.hidden = true;
    return;
  }
  sel.hidden = false;
  placeBox(sel, s, z);
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

function placeBox(el, s, z) {
  el.style.left = `${s.x * z}px`;
  el.style.top = `${s.y * z}px`;
  el.style.width = `${s.w * z}px`;
  el.style.height = `${s.h * z}px`;
  el.style.transform = s.rotation ? `rotate(${s.rotation}deg)` : '';
  el.style.borderRadius = s.kind === 'ellipse' ? '50%' : `${s.radius * z}px`;
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

// The shape visibly on top at p: the topmost in paint order, unless a
// crossing puts another shape under p over it.
function hitTest(p) {
  const v = variant();
  const hits = M.paintOrder(v.shapes).filter((s) => !s.hidden && M.insideShape(s, p));
  let top = hits[hits.length - 1] || null;
  if (!top) return null;
  for (const s of hits) {
    if (s !== top && M.isOver(v, s.id, top.id)) top = s;
  }
  return top;
}

// Axis-aligned bounds of a (possibly rotated) shape, for the selection box.
function shapeBounds(s) {
  const t = rad(s.rotation);
  const hw = (Math.abs(s.w * Math.cos(t)) + Math.abs(s.h * Math.sin(t))) / 2;
  const hh = (Math.abs(s.w * Math.sin(t)) + Math.abs(s.h * Math.cos(t))) / 2;
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
}

function startMove(p, collapseTo = null) {
  const orig = new Map(selectedShapes().map((s) => [s.id, { x: s.x, y: s.y }]));
  drag = { kind: 'move', start: p, orig, moved: false, collapseTo };
}

function onCanvasDown(e) {
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 2) {
    if (drag) onCanvasUp();
    panDrag = null;
    startPinch();
    e.preventDefault();
    return;
  }
  if (e.button === 1 || (e.button === 0 && spaceHeld)) {
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  const p = toCanvas(e);
  const handle = e.target.closest?.('.handle');
  const s = primaryShape();
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (handle && s) {
    const hv = handle.dataset.handle;
    drag = hv === 'rot'
      ? { kind: 'rotate', id: s.id }
      : { kind: 'resize', id: s.id, h: hv.split(',').map(Number), start: p, orig: { ...s } };
  } else {
    const hit = hitTest(p);
    if (hit && additive) {
      if (isSelected(hit.id)) {
        setSelection(state.ui.selected.filter((id) => id !== hit.id));
        drag = null;
      } else {
        setSelection([...state.ui.selected, hit.id], hit.id);
        startMove(p);
      }
    } else if (hit) {
      if (isSelected(hit.id)) {
        state.ui.primary = hit.id;
        startMove(p, hit.id);
      } else {
        setSelection([hit.id]);
        startMove(p);
      }
      scheduleRender();
    } else {
      const base = additive ? [...state.ui.selected] : [];
      if (!additive) setSelection([]);
      drag = { kind: 'marquee', start: p, base };
    }
  }
  if (drag) {
    $('canvas-box').setPointerCapture(e.pointerId);
    e.preventDefault();
  }
}

function onCanvasMove(e) {
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch) return onPinchMove();
  if (panDrag) {
    const v = state.ui.view;
    v.panX = panDrag.panX + (e.clientX - panDrag.x);
    v.panY = panDrag.panY + (e.clientY - panDrag.y);
    applyView();
    return;
  }
  if (!drag) return;
  const p = toCanvas(e);
  if (drag.kind === 'move') {
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (!dx && !dy) return;
    drag.moved = true;
    mutate(() => {
      for (const [id, o] of drag.orig) {
        forShape(id, (s) => {
          s.x = round2(o.x + dx);
          s.y = round2(o.y + dy);
        });
      }
    });
  } else if (drag.kind === 'rotate') {
    const s = primaryShape();
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    let a = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
    if (e.shiftKey) a = Math.round(a / 15) * 15;
    a = ((((a + 180) % 360) + 360) % 360) - 180;
    mutate(() => forShape(drag.id, (x) => { x.rotation = round2(a); }));
  } else if (drag.kind === 'resize') {
    resizeTo(p, e.shiftKey);
  } else if (drag.kind === 'marquee') {
    updateMarquee(p);
  }
}

function updateMarquee(p) {
  const r = {
    x0: Math.min(drag.start.x, p.x), y0: Math.min(drag.start.y, p.y),
    x1: Math.max(drag.start.x, p.x), y1: Math.max(drag.start.y, p.y),
  };
  const z = state.ui.zoom;
  const m = $('marquee');
  m.hidden = false;
  m.style.left = `${r.x0 * z}px`;
  m.style.top = `${r.y0 * z}px`;
  m.style.width = `${(r.x1 - r.x0) * z}px`;
  m.style.height = `${(r.y1 - r.y0) * z}px`;
  const hits = variant().shapes.filter((s) => {
    if (s.hidden) return false;
    const b = shapeBounds(s);
    return b.x0 <= r.x1 && b.x1 >= r.x0 && b.y0 <= r.y1 && b.y1 >= r.y0;
  }).map((s) => s.id);
  setSelection([...drag.base, ...hits]);
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

function onCanvasUp(e) {
  if (e) activePointers.delete(e.pointerId);
  if (pinch) {
    if (activePointers.size < 2) pinch = null;
    return;
  }
  if (panDrag) {
    panDrag = null;
    applyView();
    return;
  }
  if (!drag) return;
  if (drag.kind === 'move' && !drag.moved && drag.collapseTo) setSelection([drag.collapseTo]);
  if (drag.kind === 'marquee') $('marquee').hidden = true;
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
    li.classList.toggle('selected', isSelected(s.id));
    li.classList.toggle('primary', s.id === state.ui.primary && state.ui.selected.length > 1);
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
    li.addEventListener('click', (e) => onListClick(e, s.id, ordered));
    list.append(li);
  }
  const none = !state.ui.selected.length;
  for (const id of ['btn-shape-up', 'btn-shape-down', 'btn-shape-dup', 'btn-shape-del']) $(id).disabled = none;
  $('btn-shape-copy').disabled = none || state.doc.variants.length < 2;
}

// Ctrl/Cmd-click toggles, Shift-click selects the range from the primary shape
// in list order, a plain click selects only that shape.
function onListClick(e, id, ordered) {
  if (e.ctrlKey || e.metaKey) {
    if (isSelected(id)) setSelection(state.ui.selected.filter((x) => x !== id));
    else setSelection([...state.ui.selected, id], id);
  } else if (e.shiftKey && state.ui.primary) {
    const ids = ordered.map((s) => s.id);
    const a = ids.indexOf(state.ui.primary);
    const b = ids.indexOf(id);
    if (a < 0) return setSelection([id]);
    setSelection([...state.ui.selected, ...ids.slice(Math.min(a, b), Math.max(a, b) + 1)], state.ui.primary);
  } else {
    setSelection([id]);
  }
}

function addShape(kind) {
  const shape = M.newShape(kind);
  const layerCount = variant().shapes.length;
  shape.name = `${shape.name} ${layerCount + 1}`;
  edit(() => {
    for (const v of targets()) v.shapes.push(structuredClone(shape));
  });
  setSelection([shape.id]);
}

function duplicateShape() {
  const ids = selectedShapes().map((s) => s.id);
  if (!ids.length) return;
  const copies = new Map(ids.map((id) => [id, M.newId('s')]));
  edit(() => {
    for (const v of targets()) {
      for (const id of ids) {
        const i = v.shapes.findIndex((x) => x.id === id);
        if (i < 0) continue;
        const copy = structuredClone(v.shapes[i]);
        copy.id = copies.get(id);
        copy.name = `${copy.name} copy`;
        copy.x += 4;
        copy.y += 4;
        v.shapes.splice(i + 1, 0, copy);
      }
    }
  });
  setSelection([...copies.values()], copies.get(state.ui.primary) ?? null);
}

function deleteShape() {
  const ids = new Set(state.ui.selected);
  if (!ids.size) return;
  edit(() => {
    for (const v of targets()) {
      v.shapes = v.shapes.filter((x) => !ids.has(x.id));
      M.dropCrossingsOf(v, ids);
    }
  });
  setSelection([]);
}

// Moves each selected shape one step up (toward the top of its layer) or down,
// swapping with the nearest shape on the same layer. A shape blocked by the
// layer edge or by another selected shape stays put, so the group keeps its
// order.
function moveShape(dir) {
  const ids = new Set(state.ui.selected);
  if (!ids.size) return;
  edit(() => {
    for (const v of targets()) {
      const order = v.shapes.map((_, i) => i).filter((i) => ids.has(v.shapes[i].id));
      if (dir > 0) order.reverse();
      for (const i of order) {
        const layer = v.shapes[i].layer;
        let j = i + dir;
        while (j >= 0 && j < v.shapes.length && v.shapes[j].layer !== layer) j += dir;
        if (j < 0 || j >= v.shapes.length || ids.has(v.shapes[j].id)) continue;
        [v.shapes[i], v.shapes[j]] = [v.shapes[j], v.shapes[i]];
      }
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
        pruneSelection();
        scheduleRender();
      });
      t = { card, root: mountIcon(inner), name, markup: '' };
      thumbs.set(v.id, t);
    }
    const markup = stageMarkup(v, { pxPerUnit: (86 / M.CANVAS) * devicePixelRatio });
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
  $('btn-var-copy').disabled = state.doc.variants.length < 2;
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
  pruneSelection();
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

// Controls take an optional mixed() that reports whether the selected shapes
// disagree; a mixed control shows the primary shape's value without a number,
// and editing it sets every selected shape to the new value.
function slider(label, { min, max, step, get, set, mixed, hue = false }) {
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
      const m = !!mixed?.();
      range.value = v;
      box.placeholder = m ? 'Mixed' : '';
      if (document.activeElement !== box) box.value = m ? '' : fmt(v, step);
    },
  };
}

function numberInput(label, { step = 1, get, set, mixed }) {
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
      const m = !!mixed?.();
      box.placeholder = m ? 'Mixed' : '';
      if (document.activeElement !== box) box.value = m ? '' : fmt(get(), step);
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

function select(label, { options, get, set, mixed, disabled }) {
  const sel = document.createElement('select');
  const mixedOpt = new Option('Mixed', '');
  mixedOpt.disabled = true;
  mixedOpt.hidden = true;
  sel.append(mixedOpt);
  const groups = new Map();
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.label;
    if (!o.group) {
      sel.append(opt);
      continue;
    }
    if (!groups.has(o.group)) {
      const g = document.createElement('optgroup');
      g.label = o.group;
      groups.set(o.group, g);
      sel.append(g);
    }
    groups.get(o.group).append(opt);
  }
  sel.addEventListener('change', () => edit(() => set(sel.value)));
  return {
    el: fieldRow(label, sel),
    update() {
      sel.value = mixed?.() ? '' : get();
      sel.disabled = !!disabled?.();
    },
  };
}

function checkbox(label, { get, set, mixed }) {
  const lab = document.createElement('label');
  lab.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  const span = document.createElement('span');
  span.textContent = label;
  lab.append(box, span);
  box.addEventListener('change', () => edit(() => set(box.checked)));
  return {
    el: lab,
    update() {
      box.checked = !!get();
      box.indeterminate = !!mixed?.();
    },
  };
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

function color(label, { get, set, mixed }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'swatch-btn';
  const field = createColorField(btn, {
    onInput: (hex) => mutate(() => set(hex)),
    onCommit: commit,
  });
  return {
    el: fieldRow(label, btn),
    update() {
      field.setValue(get());
      btn.classList.toggle('mixed', !!mixed?.());
      btn.title = mixed?.() ? 'Mixed: the selected shapes have different colors' : '';
    },
  };
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

function actionButton(label, onClick, disabled) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tbtn small insp-action';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return { el: btn, update() { btn.disabled = !!disabled?.(); } };
}

const forScene = (fn) => { for (const v of targets()) fn(v.scene); };
const forBackground = (fn) => { for (const v of targets()) fn(v.background); };

function section(title, controls, { advanced = [] } = {}) {
  const el = document.createElement('section');
  el.className = 'insp-section';
  const h = document.createElement('h2');
  const setTitle = () => { h.textContent = typeof title === 'function' ? title() : title; };
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
  return {
    el,
    update() {
      setTitle();
      for (const c of all) c.update();
    },
  };
}

// Shown only while show() is true.
function showWhen(show, ctrl) {
  return {
    el: ctrl.el,
    update() {
      ctrl.el.hidden = !show();
      if (!ctrl.el.hidden) ctrl.update();
    },
  };
}

// Shown only while exactly one shape is selected.
function singleOnly(ctrl) {
  return {
    el: ctrl.el,
    update() {
      ctrl.el.hidden = state.ui.selected.length > 1;
      if (!ctrl.el.hidden) ctrl.update();
    },
  };
}

// Lists the shapes the primary shape overlaps (or, with two shapes selected,
// just the other one) with an Over/Under choice for each crossing.
function crossingsSection() {
  const el = document.createElement('section');
  el.className = 'insp-section';
  const h = document.createElement('h2');
  h.textContent = 'Crossings';
  const intro = document.createElement('p');
  intro.className = 'hint';
  const list = document.createElement('div');
  list.className = 'crossings';
  el.append(h, intro, list);

  const setOver = (a, b, over) => edit(() => {
    for (const v of targets()) {
      const ids = new Set(v.shapes.map((s) => s.id));
      if (ids.has(a) && ids.has(b)) M.setCrossing(v, a, b, over);
    }
  });

  return {
    el,
    update() {
      const sel = selectedShapes();
      const p = primaryShape();
      const v = variant();
      let others = [];
      if (p && sel.length === 1) others = v.shapes.filter((s) => s.id !== p.id && !s.hidden && M.shapesOverlap(p, s));
      else if (p && sel.length === 2) others = sel.filter((s) => s.id !== p.id && M.shapesOverlap(p, s));
      el.hidden = !others.length;
      if (!others.length) return;
      intro.textContent = `Where “${p.name}” crosses another shape, it goes:`;
      list.replaceChildren();
      for (const o of M.paintOrder(others).reverse()) {
        const over = M.isOver(v, p.id, o.id);
        const explicit = !!M.findCrossing(v, p.id, o.id);
        const row = document.createElement('div');
        row.className = 'crossing-row';
        const sw = document.createElement('span');
        sw.className = `shape-swatch ${o.kind}`;
        sw.style.background = o.style.color;
        const name = document.createElement('span');
        name.className = 'shape-name';
        name.textContent = o.name;
        const seg = document.createElement('div');
        seg.className = 'seg';
        for (const [label, isOverBtn] of [['Over', true], ['Under', false]]) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = label;
          btn.classList.toggle('active', over === isOverBtn);
          btn.title = `Put “${p.name}” ${label.toLowerCase()} “${o.name}” where they cross`;
          btn.addEventListener('click', () => setOver(p.id, o.id, isOverBtn ? p.id : o.id));
          seg.append(btn);
        }
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'eye';
        reset.textContent = 'Reset';
        reset.title = 'Follow the stacking order again';
        reset.hidden = !explicit;
        reset.addEventListener('click', () => setOver(p.id, o.id, null));
        row.append(sw, name, seg, reset);
        list.append(row);
      }
    },
  };
}

function buildInspector(root) {
  const sh = () => primaryShape();
  const shapeSet = (fn) => (v) => forSelected((s) => fn(s, v));
  const mixedOf = (read) => () => {
    const all = selectedShapes();
    return all.some((s) => read(s) !== read(all[0]));
  };
  const styleCtl = (key) => ({
    get: () => sh().style[key],
    mixed: mixedOf((s) => s.style[key]),
    set: shapeSet((s, v) => { s.style[key] = v; }),
  });
  const geoCtl = (key) => ({
    get: () => sh()[key],
    mixed: mixedOf((s) => s[key]),
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

  const shapeSec = section(() => (state.ui.selected.length > 1 ? `${state.ui.selected.length} shapes` : 'Shape'), [
    singleOnly(text('Name', { get: () => sh().name, set: shapeSet((s, v) => { s.name = v; }) })),
    select('Layer', { options: M.LAYERS, ...geoCtl('layer') }),
    select('Kind', {
      options: [{ id: 'rect', label: 'Rectangle' }, { id: 'ellipse', label: 'Ellipse' }],
      ...geoCtl('kind'),
    }),
    singleOnly(pair('Position', numberInput('X', { step: 0.5, ...geoCtl('x') }), numberInput('Y', { step: 0.5, ...geoCtl('y') }))),
    singleOnly(pair('Size', numberInput('W', { step: 0.5, ...geoCtl('w') }), numberInput('H', { step: 0.5, ...geoCtl('h') }))),
    slider('Corner radius', { min: 0, max: 54, step: 0.5, ...geoCtl('radius') }),
    slider('Rotation', { min: -180, max: 180, step: 1, ...geoCtl('rotation') }),
    actionButton('Copy to variants…', () => openCopy('selected'), () => state.doc.variants.length < 2),
  ]);

  // Controls that only some materials read, each with the material's own label.
  const isMat = (...ids) => () => selectedShapes().some((s) => ids.includes(s.style.material));
  const onlyMat = (...ids) => () => selectedShapes().every((s) => ids.includes(s.style.material));
  const angle = (label, ...ids) => showWhen(isMat(...ids), slider(label, { min: -90, max: 90, step: 1, ...styleCtl('texAngle') }));
  const scale = (label, ...ids) => showWhen(isMat(...ids), slider(label, { min: 0.25, max: 4, step: 0.05, ...styleCtl('texScale') }));
  const amount = (label, ...ids) => showWhen(isMat(...ids), slider(label, { min: 0, max: 1, step: 0.01, ...styleCtl('texAmount') }));
  // Neon is self-lit, so depth, edge and shading controls do nothing for it.
  const lit = (ctrl) => showWhen(() => !onlyMat('neon')(), ctrl);
  const finish = (label, ...ids) => showWhen(isMat(...ids), select(label, { options: M.FINISHES, ...styleCtl('finish') }));

  const lookSec = section('Look', [
    color('Color', styleCtl('color')),
    select('Material', {
      options: M.MATERIALS,
      ...styleCtl('material'),
      set: shapeSet((s, v) => { Object.assign(s.style, { material: v }, M.materialDefaults(v)); }),
    }),
    showWhen(isMat('glass'), slider('Frost', { min: 0, max: 1, step: 0.01, ...styleCtl('frost') })),
    showWhen(isMat('wood'), select('Figure', { options: M.WOOD_FIGURES, ...styleCtl('woodFigure') })),
    showWhen(isMat('marble'), select('Veins', { options: M.TONES, ...styleCtl('texTone') })),
    showWhen(isMat('terrazzo'), color('Chip color', styleCtl('accent'))),
    finish('Finish', 'wood', 'marble', 'granite', 'terrazzo'),
    finish('Clear coat', 'carbon'),
    finish('Glaze', 'ceramic'),
    angle('Grain direction', 'wood'),
    angle('Layer direction', 'slate'),
    angle('Weave direction', 'carbon'),
    angle('Stripe direction', 'cardboard'),
    amount('Chips', 'terrazzo'),
    amount('Pits', 'concrete'),
    amount('Speckles', 'ceramic'),
    amount('Diffraction lines', 'holographic'),
    amount('Core brightness', 'neon'),
    amount('Corrugation', 'cardboard'),
    amount('Pores', 'cork'),
    showWhen(isMat('neon'), slider('Glow size', { min: 0, max: 30, step: 0.5, ...styleCtl('glowSize') })),
    select('Surface', { options: M.SURFACES, ...styleCtl('surface'), disabled: onlyMat('glass', 'neon') }),
    lit(slider('Elevation', { min: 0, max: 3, step: 0.05, ...styleCtl('elevation') })),
    lit(slider('Thickness', { min: 0, max: 2, step: 0.05, ...styleCtl('thickness') })),
    lit(checkbox('Rounded edge (fillet)', styleCtl('fillet'))),
    lit(checkbox('Beveled edge (chamfer)', styleCtl('chamfer'))),
    slider('Opacity', { min: 0, max: 1, step: 0.01, ...styleCtl('opacity') }),
  ], {
    advanced: [
      lit(slider('Fillet width', { min: -2, max: 2, step: 0.1, ...styleCtl('filletWidth') })),
      lit(slider('Chamfer width', { min: -2, max: 2, step: 0.1, ...styleCtl('chamferWidth') })),
      lit(slider('Edge shine', { min: 0, max: 1, step: 0.05, ...styleCtl('edgeShine') })),
      lit(slider('Shade', { min: 0, max: 2, step: 0.01, ...styleCtl('shade') })),
      lit(slider('Curve depth', { min: 0, max: 4, step: 0.05, ...styleCtl('curveScale') })),
      showWhen(() => !onlyMat('neon', 'enamel', 'ceramic')(), slider('Texture strength', { min: 0, max: 3, step: 0.05, ...styleCtl('grain') })),
      scale('Grain scale', 'wood'),
      scale('Vein scale', 'marble'),
      scale('Speckle size', 'granite'),
      scale('Chip size', 'terrazzo'),
      scale('Texture scale', 'concrete', 'paper'),
      scale('Layer scale', 'slate'),
      scale('Weave scale', 'carbon'),
      scale('Band width', 'holographic'),
      scale('Stripe spacing', 'cardboard'),
      scale('Granule size', 'cork'),
      amount('Roughness', 'slate'),
      amount('Highlight sharpness', 'enamel'),
      lit(checkbox('Glow', styleCtl('glow'))),
      lit(color('Glow color', styleCtl('glowColor'))),
      lit(slider('Glow size', { min: 0, max: 30, step: 0.5, ...styleCtl('glowSize') })),
    ],
  });

  const crossSec = crossingsSection();
  root.append(shapeSec.el, crossSec.el, lookSec.el, variantSec.el, lightSec.el, bgSec.el);
  return {
    update() {
      const has = !!sh();
      shapeSec.el.hidden = !has;
      lookSec.el.hidden = !has;
      if (has) {
        shapeSec.update();
        lookSec.update();
      }
      if (has) crossSec.update();
      else crossSec.el.hidden = true;
      variantSec.update();
      lightSec.update();
      bgSec.update();
    },
  };
}

let inspector = { update() {} };

// ---------------------------------------------------------------------------
// files

function toast(message, kind = '', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
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

// Adds the drawing's convertible paths as shapes (to the current variant, or to
// every variant with "Apply edits to all variants") and shows the whole drawing
// as the tracing guide.
async function importFile(file) {
  let result;
  try {
    result = importVectorDrawable(await file.text(), file.name);
  } catch (err) {
    toast(`${file.name}: ${err.message}`, 'error');
    return;
  }
  const { shapes, guide, skipped, notes } = result;
  edit(() => {
    for (const v of targets()) v.shapes.push(...structuredClone(shapes));
    state.doc.guide = guide;
  });
  setSelection(shapes.map((s) => s.id));
  const parts = [`Imported ${shapes.length} shape${shapes.length === 1 ? '' : 's'} from ${file.name}.`];
  if (skipped.length) parts.push(`Not converted, see the tracing guide: ${skipped.join(', ')}.`);
  parts.push(...notes);
  toast(parts.join(' '), skipped.length || notes.length ? 'warn' : '', 8000);
}

async function openFile(file) {
  const text = await file.text();
  if (looksLikeVectorDrawable(text)) return importFile(file);
  let doc;
  try {
    doc = M.parseProject(text);
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
  // Some Linux file managers announce a dragged file only as a file URL list.
  const hasFiles = (e) => {
    const types = [...(e.dataTransfer?.types || [])];
    return types.includes('Files') || types.includes('text/uri-list');
  };
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
    if (modalOpen()) return;
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
    else toast('The browser did not pass the dropped file. Use Open instead.', 'error');
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
// copy to variants

const copyUi = { shapeBoxes: new Map(), variantBoxes: new Map() };
const COPY_DEFAULTS = new Set(['geometry', 'look']);

function checkRow(parent, id, label) {
  const lab = document.createElement('label');
  lab.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = id;
  const span = document.createElement('span');
  span.textContent = label;
  lab.append(box, span);
  parent.append(lab);
  return box;
}

function setupCopyDialog() {
  for (const p of M.COPY_SHAPE_PARTS) copyUi.shapeBoxes.set(p.id, checkRow($('copy-shape-parts'), p.id, p.label));
  for (const p of M.COPY_VARIANT_PARTS) copyUi.variantBoxes.set(p.id, checkRow($('copy-variant-parts'), p.id, p.label));
  const overlay = $('copy-overlay');
  overlay.addEventListener('change', updateCopySummary);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeCopy(); });
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeCopy();
  });
  const setTargets = (on) => {
    for (const box of $('copy-targets').querySelectorAll('input')) box.checked = on;
    updateCopySummary();
  };
  $('copy-all').addEventListener('click', () => setTargets(true));
  $('copy-none').addEventListener('click', () => setTargets(false));
  $('copy-cancel').addEventListener('click', closeCopy);
  $('copy-go').addEventListener('click', doCopy);
}

// scope: 'selected' to start from the selected shapes, 'all' for every shape.
function openCopy(scope) {
  commit();
  const v = variant();
  const nSel = selectedShapes().length;
  $('copy-from').textContent = `From “${v.name}”`;
  $('copy-scope-selected').textContent = `Selected shapes (${nSel})`;
  $('copy-scope-all').textContent = `All shapes (${v.shapes.length})`;
  const selRadio = document.querySelector('input[name="copy-scope"][value="selected"]');
  selRadio.disabled = !nSel;
  document.querySelector(`input[name="copy-scope"][value="${scope === 'selected' && nSel ? 'selected' : 'all'}"]`).checked = true;
  for (const [id, box] of copyUi.shapeBoxes) box.checked = COPY_DEFAULTS.has(id);
  for (const box of copyUi.variantBoxes.values()) box.checked = false;
  const targets = $('copy-targets');
  targets.replaceChildren();
  for (const other of state.doc.variants) {
    if (other.id === v.id) continue;
    checkRow(targets, other.id, other.name).checked = true;
  }
  document.querySelector('input[name="copy-mode"][value="change"]').checked = true;
  $('copy-overlay').hidden = false;
  $('copy-go').focus();
  updateCopySummary();
}

function closeCopy() {
  $('copy-overlay').hidden = true;
}

function copySettings() {
  const v = variant();
  const scope = document.querySelector('input[name="copy-scope"]:checked').value;
  const ids = scope === 'selected' ? selectedShapes().map((s) => s.id) : v.shapes.map((s) => s.id);
  const parts = new Set([...copyUi.shapeBoxes, ...copyUi.variantBoxes].filter(([, b]) => b.checked).map(([id]) => id));
  const targets = [...$('copy-targets').querySelectorAll('input:checked')].map((b) => b.value);
  const duplicate = document.querySelector('input[name="copy-mode"]:checked').value === 'duplicate';
  return { ids, parts, targets, duplicate };
}

function copyProblem({ ids, parts, targets }) {
  if (!targets.length) return 'Tick at least one variant to copy to.';
  if (!parts.size) return 'Tick at least one thing to copy.';
  const needsShapes = [...parts].every((p) => p !== 'light' && p !== 'background');
  if (needsShapes && !ids.length) return 'There are no shapes to copy.';
  return '';
}

function updateCopySummary() {
  const settings = copySettings();
  const problem = copyProblem(settings);
  const n = settings.targets.length;
  const plural = n === 1 ? '' : 's';
  $('copy-summary').textContent = problem
    || (settings.duplicate ? `Creates ${n} new variant${plural} next to the originals.` : `Changes ${n} variant${plural}. You can undo this.`);
  $('copy-go').disabled = !!problem;
}

function doCopy() {
  const settings = copySettings();
  if (copyProblem(settings)) return;
  const { ids, parts, targets, duplicate } = settings;
  const src = structuredClone(variant());
  const current = variant().id;
  edit(() => {
    for (const id of targets) {
      const i = state.doc.variants.findIndex((x) => x.id === id);
      if (i < 0) continue;
      let dst = state.doc.variants[i];
      if (duplicate) {
        dst = M.duplicateVariant(dst, nextVariantName(dst.name));
        state.doc.variants.splice(i + 1, 0, dst);
      }
      M.copyIntoVariant(src, dst, ids, parts);
    }
  });
  state.ui.variant = state.doc.variants.findIndex((x) => x.id === current);
  closeCopy();
  toast(duplicate ? `Created ${targets.length} new variant${targets.length === 1 ? '' : 's'}` : `Copied to ${targets.length} variant${targets.length === 1 ? '' : 's'}`);
  scheduleRender();
}

// ---------------------------------------------------------------------------
// about dialog

// The website publishes the changelog of every app in one file; this app's
// entry is matched by name.
const APPS_URL = 'https://iboalali.com/apps.json';
const WEBSITE_URL = 'https://iboalali.com/app/icon_recomposer/?utm_source=icon-recomposer&utm_medium=app';
let changelog = null;

function loadChangelog() {
  if (!changelog) {
    changelog = fetch(APPS_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        const app = (data.apps || []).find((a) => a.name === 'Icon Recomposer');
        if (!app || !Array.isArray(app.changelog) || !app.changelog.length) throw new Error('No changelog');
        return app.changelog;
      });
    changelog.catch(() => { changelog = null; });
  }
  return changelog;
}

function renderChangelog(list) {
  const box = $('about-log');
  box.replaceChildren();
  for (const entry of list) {
    const h = document.createElement('h4');
    h.textContent = `Version ${entry.version}`;
    if (entry.version === M.APP_VERSION) {
      const tag = document.createElement('span');
      tag.className = 'hint';
      tag.textContent = 'this version';
      h.append(tag);
    }
    const ul = document.createElement('ul');
    for (const change of entry.changes || []) {
      const li = document.createElement('li');
      li.textContent = change;
      ul.append(li);
    }
    box.append(h, ul);
  }
}

function changelogMessage(text, withLink) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  if (withLink) {
    const a = document.createElement('a');
    a.href = WEBSITE_URL;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'website';
    p.append(' It is also on the ', a, '.');
  }
  $('about-log').replaceChildren(p);
}

function setupAboutDialog() {
  const overlay = $('about-overlay');
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeAbout(); });
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeAbout();
  });
  $('about-close').addEventListener('click', closeAbout);
  $('about-version').textContent = `Version ${M.APP_VERSION}`;
}

function openAbout() {
  $('about-overlay').hidden = false;
  $('about-close').focus();
  changelogMessage('Loading the changelog…');
  loadChangelog().then(renderChangelog, () => changelogMessage('The changelog could not be loaded.', true));
}

function closeAbout() {
  $('about-overlay').hidden = true;
}

// ---------------------------------------------------------------------------
// keyboard

// Any in-page dialog: confirm, export, copy or about. App shortcuts and file
// drops are ignored while one is open.
function modalOpen() {
  return !!document.querySelector('.dlg-overlay:not([hidden])');
}

function isTyping(e) {
  const t = e.target;
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onKey(e) {
  if (modalOpen()) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomBy(1.25); return; }
  if (mod && k === '-') { e.preventDefault(); zoomBy(0.8); return; }
  if (mod && k === '0') { e.preventDefault(); resetView(); return; }
  if (mod && k === 's') { e.preventDefault(); saveProject(); return; }
  if (mod && k === 'o') { e.preventDefault(); $('file-open').click(); return; }
  if (isTyping(e)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicateShape(); return; }
  if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); resetView(); return; }
  if (e.shiftKey && e.code === 'Digit2') { e.preventDefault(); zoomToSelection(); return; }
  if (e.code === 'Space') {
    e.preventDefault();
    if (!spaceHeld) { spaceHeld = true; applyView(); }
    return;
  }
  if (e.key === 'Escape') { setSelection([]); return; }
  if (mod && k === 'a') { e.preventDefault(); setSelection(variant().shapes.filter((s) => !s.hidden).map((s) => s.id)); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteShape(); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key] && state.ui.selected.length) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const [dx, dy] = arrows[e.key];
    edit(() => forSelected((x) => { x.x = round2(x.x + dx * step); x.y = round2(x.y + dy * step); }));
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
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  });
  $('show-trace').addEventListener('change', (e) => edit(() => { state.doc.guide.visible = e.target.checked; }));
  $('btn-trace-remove').addEventListener('click', () => edit(() => { state.doc.guide = null; }));
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-export').addEventListener('click', openExport);
  $('btn-about').addEventListener('click', openAbout);
  $('btn-add-rect').addEventListener('click', () => addShape('rect'));
  $('btn-add-ellipse').addEventListener('click', () => addShape('ellipse'));
  $('btn-shape-up').addEventListener('click', () => moveShape(1));
  $('btn-shape-down').addEventListener('click', () => moveShape(-1));
  $('btn-shape-dup').addEventListener('click', duplicateShape);
  $('btn-shape-del').addEventListener('click', deleteShape);
  $('btn-var-dup').addEventListener('click', duplicateCurrentVariant);
  $('btn-var-copy').addEventListener('click', () => openCopy('all'));
  $('btn-shape-copy').addEventListener('click', () => openCopy('selected'));
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
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && spaceHeld) { spaceHeld = false; applyView(); }
  });
  window.addEventListener('blur', () => { if (spaceHeld) { spaceHeld = false; applyView(); } });
  box.addEventListener('wheel', onCanvasWheel, { passive: false });
  box.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  $('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
  $('btn-zoom-fit').addEventListener('click', resetView);
  $('btn-zoom-sel').addEventListener('click', zoomToSelection);
  setupFileDrop();

  setupExportDialog();
  setupCopyDialog();
  setupAboutDialog();
  fitStage();
  render();
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<div class="toast error">Failed to start: ${String(err.message).replace(/</g, '&lt;')}</div>`);
});
