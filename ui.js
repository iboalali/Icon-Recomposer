// ui.js — panels, controlled inputs, draggable light handle, render loop,
// undo/redo, and file/export wiring (PLAN §6, §15).
//
// One-way data flow: input → mutate state → render(). Two kinds of DOM:
//   - derived views (preview SVG, layer list): rebuilt from state each render.
//   - controlled inputs (in index.html): built ONCE; render only updates .value
//     (never recreates them — that would kill focus/drag/color-pickers).

import { derive } from './derive.js';
import { previewSvg } from './svg.js';
import { exportVD } from './export-vd.js';
import { renderPng } from './export-png.js';
import { importVector } from './import.js';
import {
  sampleDocument,
  defaultCanvas,
  defaultLight,
  normalizeDocument,
  serializeProject,
  parseProject,
  encodeShareFragment,
  decodeShareFragment,
} from './model.js';

const DEG = Math.PI / 180;
const $ = (id) => document.getElementById(id);

// ---- state ----
const appState = {
  document: sampleDocument(),
  ui: { selectedLayerId: null, projectName: 'icon' },
};
const undoStack = [];
const redoStack = [];
let gestureSnapshot = null;

const doc = () => appState.document;
const selectedLayer = () => doc().layers.find((l) => l.id === appState.ui.selectedLayerId) || null;

// ---- undo/redo ----
function snapshot() {
  return structuredClone(doc());
}
function beginGesture() {
  if (!gestureSnapshot) gestureSnapshot = snapshot();
}
function commitGesture() {
  if (gestureSnapshot) {
    undoStack.push(gestureSnapshot);
    gestureSnapshot = null;
    redoStack.length = 0;
    capStack(undoStack);
    updateHistoryButtons();
  }
}
// Discrete (atomic) change: snapshot, mutate, push.
function commit(mutate) {
  const snap = snapshot();
  mutate();
  undoStack.push(snap);
  redoStack.length = 0;
  capStack(undoStack);
  updateHistoryButtons();
  scheduleRender();
}
function capStack(stack) {
  while (stack.length > 100) stack.shift();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  appState.document = undoStack.pop();
  reconcileSelection();
  updateHistoryButtons();
  scheduleRender();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  appState.document = redoStack.pop();
  reconcileSelection();
  updateHistoryButtons();
  scheduleRender();
}
function reconcileSelection() {
  if (!doc().layers.some((l) => l.id === appState.ui.selectedLayerId)) appState.ui.selectedLayerId = null;
}
function updateHistoryButtons() {
  $('btn-undo').disabled = undoStack.length === 0;
  $('btn-redo').disabled = redoStack.length === 0;
}

// ---- render loop (rAF-batched) ----
let dirty = false;
function scheduleRender() {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(() => {
    dirty = false;
    render();
  });
}

let cachedDerived = null;
function render() {
  const d = doc();
  cachedDerived = derive(d);

  // Derived views.
  $('preview').innerHTML = previewSvg(cachedDerived);
  renderLayerList();

  // Canvas chrome.
  $('canvas-wrap').style.aspectRatio = `${d.canvas.viewportWidth} / ${d.canvas.viewportHeight}`;
  const bg = d.canvas.exportBackground;
  $('checker').style.display = bg.transparent ? '' : 'none';
  $('canvas-wrap').style.background = bg.transparent ? '' : bg.color;

  positionLightHandle();
  updateInspector();
}

// ---- layer list (derived view) ----
function renderLayerList() {
  const ul = $('layer-list');
  ul.innerHTML = '';
  const layers = doc().layers;
  // Display front-most first (paint order is bottom→top in the array).
  for (let vi = 0; vi < layers.length; vi++) {
    const layer = layers[layers.length - 1 - vi];
    const li = document.createElement('li');
    li.className = 'layer-item' + (layer.id === appState.ui.selectedLayerId ? ' selected' : '') + (layer.visible ? '' : ' hidden-layer');
    li.dataset.id = layer.id;

    const vis = document.createElement('button');
    vis.className = 'vis';
    vis.textContent = layer.visible ? '👁' : '◌';
    vis.title = layer.visible ? 'Hide' : 'Show';
    vis.addEventListener('click', (e) => {
      e.stopPropagation();
      commit(() => { layer.visible = !layer.visible; });
    });

    const name = document.createElement('span');
    name.className = 'lname';
    name.textContent = layer.name;

    const up = miniBtn('↑', 'Move forward', (e) => { e.stopPropagation(); moveLayer(layer.id, -1); });
    const down = miniBtn('↓', 'Move back', (e) => { e.stopPropagation(); moveLayer(layer.id, +1); });
    const del = miniBtn('✕', 'Delete', (e) => { e.stopPropagation(); deleteLayer(layer.id); });

    li.append(vis, name, up, down, del);
    li.addEventListener('click', () => selectLayer(layer.id));
    ul.appendChild(li);
  }
  if (!layers.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'No layers — Import an SVG or VectorDrawable.';
    ul.appendChild(li);
  }
}
function miniBtn(label, title, onClick) {
  const b = document.createElement('button');
  b.className = 'mini';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function selectLayer(id) {
  appState.ui.selectedLayerId = id;
  scheduleRender();
}
function moveLayer(id, visualDir) {
  // visualDir -1 = up in list (toward front), +1 = down (toward back).
  const layers = doc().layers;
  const ai = layers.findIndex((l) => l.id === id);
  if (ai < 0) return;
  const target = ai - visualDir; // up in list = +1 in array
  if (target < 0 || target >= layers.length) return;
  commit(() => {
    const [item] = layers.splice(ai, 1);
    layers.splice(target, 0, item);
  });
}
function deleteLayer(id) {
  commit(() => {
    const layers = doc().layers;
    const i = layers.findIndex((l) => l.id === id);
    if (i >= 0) layers.splice(i, 1);
    if (appState.ui.selectedLayerId === id) appState.ui.selectedLayerId = null;
  });
}

// ---- light handle (signature interaction) ----
const overlay = $('light-overlay');
const handle = $('light-handle');
let dragging = false;

function viewportFromEvent(e) {
  const rect = $('canvas-wrap').getBoundingClientRect();
  const d = doc();
  return {
    x: ((e.clientX - rect.left) / rect.width) * d.canvas.viewportWidth,
    y: ((e.clientY - rect.top) / rect.height) * d.canvas.viewportHeight,
  };
}
function applyLightFromViewport(vx, vy) {
  const d = doc();
  const light = d.light;
  if (light.type === 'point') {
    light.position.x = clamp(vx, 0, d.canvas.viewportWidth);
    light.position.y = clamp(vy, 0, d.canvas.viewportHeight);
  } else {
    const cx = d.canvas.viewportWidth / 2;
    const cy = d.canvas.viewportHeight / 2;
    const dx = vx - cx;
    const dy = vy - cy;
    const dist = Math.hypot(dx, dy);
    const maxR = 0.5 * Math.min(d.canvas.viewportWidth, d.canvas.viewportHeight);
    light.elevation = clamp(90 * (1 - dist / maxR), 0, 90);
    if (dist > 0.001) light.azimuth = (Math.atan2(dx, -dy) / DEG + 360) % 360;
  }
}
function onDragStart(e) {
  dragging = true;
  overlay.setPointerCapture(e.pointerId);
  beginGesture();
  const v = viewportFromEvent(e);
  applyLightFromViewport(v.x, v.y);
  scheduleRender();
  e.preventDefault();
}
function onDragMove(e) {
  if (!dragging) return;
  const v = viewportFromEvent(e);
  applyLightFromViewport(v.x, v.y);
  scheduleRender();
}
function onDragEnd(e) {
  if (!dragging) return;
  dragging = false;
  try { overlay.releasePointerCapture(e.pointerId); } catch (_) {}
  commitGesture();
}
overlay.addEventListener('pointerdown', onDragStart);
overlay.addEventListener('pointermove', onDragMove);
overlay.addEventListener('pointerup', onDragEnd);
overlay.addEventListener('pointercancel', onDragEnd);

function positionLightHandle() {
  const d = doc();
  const vw = d.canvas.viewportWidth;
  const vh = d.canvas.viewportHeight;
  let vx;
  let vy;
  if (d.light.type === 'point') {
    vx = d.light.position.x;
    vy = d.light.position.y;
  } else {
    const phi = d.light.azimuth * DEG;
    const f = [Math.sin(phi), -Math.cos(phi)];
    const maxR = 0.5 * Math.min(vw, vh);
    const dist = (1 - d.light.elevation / 90) * maxR;
    vx = vw / 2 + f[0] * dist;
    vy = vh / 2 + f[1] * dist;
  }
  handle.style.left = (vx / vw) * 100 + '%';
  handle.style.top = (vy / vh) * 100 + '%';
}

// ---- inspector (controlled inputs — update .value only) ----
function setVal(el, v) {
  if (document.activeElement === el) return; // don't fight the user mid-edit
  el.value = v;
}
function setChecked(el, v) {
  el.checked = !!v;
}

function updateInspector() {
  const layer = selectedLayer();
  const showLayer = !!layer;
  $('scene-panel').hidden = showLayer;
  $('layer-panel').hidden = !showLayer;
  if (showLayer) updateLayerControls(layer);
  else updateSceneControls();
}

function updateSceneControls() {
  const d = doc();
  const L = d.light;
  setVal($('light-type'), L.type);
  $('row-azimuth').style.display = L.type === 'distant' ? '' : 'none';
  setVal($('light-azimuth'), Math.round(L.azimuth));
  $('out-azimuth').textContent = Math.round(L.azimuth) + '°';
  setVal($('light-elevation'), Math.round(L.elevation));
  $('out-elevation').textContent = Math.round(L.elevation) + '°';
  setVal($('light-intensity'), L.intensity);
  $('out-intensity').textContent = (+L.intensity).toFixed(2);

  setVal($('canvas-w'), d.canvas.viewportWidth);
  setVal($('canvas-h'), d.canvas.viewportHeight);
  setChecked($('bg-transparent'), d.canvas.exportBackground.transparent);
  $('row-bg-color').style.display = d.canvas.exportBackground.transparent ? 'none' : '';
  setVal($('bg-color'), d.canvas.exportBackground.color);
  setVal($('png-size'), d.canvas.pngSize);
}

function updateLayerControls(layer) {
  const m = layer.material;
  setVal($('layer-name'), layer.name);
  setVal($('mat-color'), m.baseColor.slice(0, 7));
  setVal($('mat-alpha'), m.fillAlpha);
  $('out-alpha').textContent = (+m.fillAlpha).toFixed(2);
  for (const r of document.querySelectorAll('input[name="fillmode"]')) r.checked = r.value === m.fillMode;
  const embossed = m.fillMode === 'embossed';
  $('row-emboss').style.display = embossed ? '' : 'none';
  $('row-sheen').style.display = embossed ? '' : 'none';
  setVal($('mat-emboss'), m.embossIntensity);
  $('out-emboss').textContent = (+m.embossIntensity).toFixed(2);
  setChecked($('mat-sheen-on'), m.sheen.enabled);
  setVal($('mat-sheen'), m.sheen.strength);
  setVal($('mat-fillrule'), layer.fillRule);

  setChecked($('shadow-on'), layer.castsShadow.enabled);
  setVal($('shadow-opacity'), layer.castsShadow.opacity);
  setVal($('shadow-spread'), layer.castsShadow.spread);

  const stroke = m.stroke;
  setChecked($('stroke-on'), !!stroke);
  setVal($('stroke-color'), stroke ? stroke.color.slice(0, 7) : '#000000');
  setVal($('stroke-width'), stroke ? stroke.width : 1);
  setVal($('mat-fillnone'), String(!!m.fillNone));
}

// ---- wire controlled inputs (once) ----
function liveInput(el, mutate) {
  el.addEventListener('input', () => {
    beginGesture();
    mutate(el);
    scheduleRender();
  });
  el.addEventListener('change', commitGesture);
}

function wireControls() {
  // Scene · light
  liveInput($('light-type'), (el) => { doc().light.type = el.value; });
  liveInput($('light-azimuth'), (el) => { doc().light.azimuth = +el.value; });
  liveInput($('light-elevation'), (el) => { doc().light.elevation = +el.value; });
  liveInput($('light-intensity'), (el) => { doc().light.intensity = +el.value; });

  // Scene · canvas
  liveInput($('canvas-w'), (el) => { doc().canvas.viewportWidth = doc().canvas.width = clampNum(+el.value, 1, 8192, 108); });
  liveInput($('canvas-h'), (el) => { doc().canvas.viewportHeight = doc().canvas.height = clampNum(+el.value, 1, 8192, 108); });
  liveInput($('bg-transparent'), (el) => { doc().canvas.exportBackground.transparent = el.checked; });
  liveInput($('bg-color'), (el) => { doc().canvas.exportBackground.color = el.value; });
  liveInput($('png-size'), (el) => { doc().canvas.pngSize = clampNum(+el.value, 16, 8192, 1024); });

  // Layer · material
  liveInput($('layer-name'), (el) => { withLayer((l) => (l.name = el.value)); });
  liveInput($('mat-color'), (el) => { withLayer((l) => (l.material.baseColor = el.value)); });
  liveInput($('mat-alpha'), (el) => { withLayer((l) => (l.material.fillAlpha = +el.value)); });
  for (const r of document.querySelectorAll('input[name="fillmode"]')) {
    r.addEventListener('change', () => commit(() => withLayer((l) => (l.material.fillMode = r.value))));
  }
  liveInput($('mat-emboss'), (el) => { withLayer((l) => (l.material.embossIntensity = +el.value)); });
  liveInput($('mat-sheen-on'), (el) => { withLayer((l) => (l.material.sheen.enabled = el.checked)); });
  liveInput($('mat-sheen'), (el) => { withLayer((l) => (l.material.sheen.strength = +el.value)); });
  liveInput($('mat-fillrule'), (el) => { withLayer((l) => (l.fillRule = el.value)); });

  // Layer · shadow
  liveInput($('shadow-on'), (el) => { withLayer((l) => (l.castsShadow.enabled = el.checked)); });
  liveInput($('shadow-opacity'), (el) => { withLayer((l) => (l.castsShadow.opacity = +el.value)); });
  liveInput($('shadow-spread'), (el) => { withLayer((l) => (l.castsShadow.spread = +el.value)); });

  // Layer · stroke
  liveInput($('stroke-on'), (el) => {
    withLayer((l) => {
      if (el.checked) l.material.stroke = l.material.stroke || { color: '#000000ff', width: 1, cap: 'butt', join: 'miter' };
      else l.material.stroke = null;
    });
  });
  liveInput($('stroke-color'), (el) => { withLayer((l) => { if (l.material.stroke) l.material.stroke.color = el.value; }); });
  liveInput($('stroke-width'), (el) => { withLayer((l) => { if (l.material.stroke) l.material.stroke.width = +el.value; }); });
  liveInput($('mat-fillnone'), (el) => { withLayer((l) => (l.material.fillNone = el.value === 'true')); });

  $('layer-deselect').addEventListener('click', () => { appState.ui.selectedLayerId = null; scheduleRender(); });
}

function withLayer(fn) {
  const l = selectedLayer();
  if (l) fn(l);
}

// ---- top bar: file + export ----
function wireToolbar() {
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);

  $('btn-new').addEventListener('click', () => {
    if (doc().layers.length && !confirm('Start a new document? Unsaved changes will be lost.')) return;
    loadDocument({ canvas: defaultCanvas(), light: defaultLight(), layers: [] }, 'icon');
    toast('New document.');
  });

  $('file-open').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const res = parseProject(text);
    if (!res.ok) return toast(res.error, 'error');
    loadDocument(res.document, res.name);
    toast(`Opened "${res.name}".`);
  });

  $('btn-save').addEventListener('click', () => {
    const json = serializeProject(doc(), appState.ui.projectName);
    download(new Blob([json], { type: 'application/json' }), `${appState.ui.projectName}.json`);
  });

  $('file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const res = importVector(text, file.name);
    if (!res.ok) return toast(res.error, 'error');
    importLayers(res, file.name);
  });

  // Export dropdown
  const menu = $('export-menu');
  $('btn-export').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => {
    const action = e.target.dataset && e.target.dataset.export;
    if (action) doExport(action);
  });
}

function importLayers(res, filename) {
  commit(() => {
    const d = doc();
    if (d.layers.length === 0 && res.viewport) {
      d.canvas.viewportWidth = d.canvas.width = res.viewport.width;
      d.canvas.viewportHeight = d.canvas.height = res.viewport.height;
      d.light.position = { x: res.viewport.width * 0.35, y: res.viewport.height * 0.3 };
    }
    d.layers.push(...res.layers);
  });
  if (res.layers.length) appState.ui.selectedLayerId = res.layers[0].id;
  const warn = res.warnings && res.warnings.length;
  toast(`Imported ${res.layers.length} layer${res.layers.length === 1 ? '' : 's'} from ${filename}.` + (warn ? ` (${res.warnings.length} warning${res.warnings.length === 1 ? '' : 's'})` : ''), warn ? 'warn' : '');
  if (warn) console.warn('Import warnings:', res.warnings);
  scheduleRender();
}

async function doExport(action) {
  $('export-menu').hidden = true;
  const d = doc();
  const derived = derive(d);
  try {
    if (action === 'vd') {
      const xml = exportVD(derived, d.canvas);
      download(new Blob([xml], { type: 'text/xml' }), `${appState.ui.projectName}.xml`);
      toast('Exported VectorDrawable XML.');
    } else if (action === 'project') {
      const json = serializeProject(d, appState.ui.projectName);
      download(new Blob([json], { type: 'application/json' }), `${appState.ui.projectName}.json`);
      toast('Saved project JSON.');
    } else if (action === 'png-transparent' || action === 'png-bg') {
      const size = d.canvas.pngSize || 1024;
      const background = action === 'png-bg' ? { transparent: false, color: d.canvas.exportBackground.color } : { transparent: true };
      const blob = await renderPng(derived, size, background);
      download(blob, `${appState.ui.projectName}-${size}.png`);
      toast(`Exported PNG (${size}px).`);
    } else if (action === 'share') {
      const url = location.origin + location.pathname + '#' + encodeShareFragment(d, appState.ui.projectName);
      if (url.length > 30000) {
        toast('Icon is too large for a share link — use Save instead.', 'warn');
        return;
      }
      await navigator.clipboard.writeText(url);
      toast('Share link copied to clipboard.');
    }
  } catch (err) {
    console.error(err);
    toast('Export failed: ' + (err.message || err), 'error');
  }
}

function loadDocument(rawDoc, name) {
  appState.document = normalizeDocument(rawDoc);
  appState.ui.selectedLayerId = null;
  appState.ui.projectName = name || 'icon';
  undoStack.length = 0;
  redoStack.length = 0;
  gestureSnapshot = null;
  updateHistoryButtons();
  scheduleRender();
}

// ---- helpers ----
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function clampNum(v, lo, hi, fallback) {
  if (!isFinite(v)) return fallback;
  return clamp(v, lo, hi);
}

// ---- keyboard ----
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && appState.ui.selectedLayerId) {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      e.preventDefault();
      deleteLayer(appState.ui.selectedLayerId);
    }
  }
});

// ---- init ----
function init() {
  wireControls();
  wireToolbar();
  updateHistoryButtons();

  // Load from share link if present.
  if (location.hash && location.hash.indexOf('doc=') >= 0) {
    const res = decodeShareFragment(location.hash);
    if (res && res.ok) {
      appState.document = res.document;
      appState.ui.projectName = res.name;
      toast(`Loaded shared "${res.name}".`);
    } else if (res && !res.ok) {
      toast(res.error, 'error');
    }
  }
  render();
}

init();
