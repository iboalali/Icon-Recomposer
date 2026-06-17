// ui.js — panels, controlled inputs, draggable light handle, render loop,
// undo/redo, and file/export wiring (PLAN §6, §15).
//
// One-way data flow: input → mutate state → render(). Two kinds of DOM:
//   - derived views (preview SVG, layer list): rebuilt from state each render.
//   - controlled inputs (in index.html): built ONCE; render only updates .value
//     (never recreates them — that would kill focus/drag/color-pickers).

import { derive, bakedOutline } from './derive.js';
import * as P from './path.js';
import { previewSvg, standaloneSvg } from './svg.js';
import { exportVD } from './export-vd.js';
import { renderPng } from './export-png.js';
import { importVector } from './import.js';
import { createColorField } from './colorpicker.js';
import {
  APP_VERSION,
  newId,
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
  ui: { selectedLayerIds: [], primaryLayerId: null, selectAnchorId: null, projectName: 'icon' },
};
const undoStack = [];
const redoStack = [];
let gestureSnapshot = null;

// Custom color-popover fields (created once in wireControls).
let matColorField = null;
let bgColorField = null;
let strokeColorField = null;

const doc = () => appState.document;
// Selection is a set of layer ids; the "primary" (last-clicked) layer's values
// populate the inspector, while edits apply to every selected layer.
const selectedLayers = () => doc().layers.filter((l) => appState.ui.selectedLayerIds.includes(l.id));
const primaryLayer = () =>
  doc().layers.find((l) => l.id === appState.ui.primaryLayerId) ||
  doc().layers.find((l) => appState.ui.selectedLayerIds.includes(l.id)) ||
  null;

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
  const ids = doc().layers.map((l) => l.id);
  appState.ui.selectedLayerIds = appState.ui.selectedLayerIds.filter((id) => ids.includes(id));
  if (!ids.includes(appState.ui.primaryLayerId)) {
    appState.ui.primaryLayerId = appState.ui.selectedLayerIds[appState.ui.selectedLayerIds.length - 1] || null;
  }
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
  updateSelectionOverlay();
  updateInspector();
}

// ---- selection marquee ----
// Outlines the selected layer over the preview. Cached on (id + geometry) so
// the marching-ants animation isn't reset every frame during a light drag
// (only gradients change then, not the path geometry).
let lastSelKey = null; // sentinel: null ≠ the empty-selection key, so the first
// render always applies (otherwise an unselected start never gets hidden).
function updateSelectionOverlay() {
  const ov = $('selection-overlay');
  const d = doc();
  ov.setAttribute('viewBox', `0 0 ${d.canvas.viewportWidth} ${d.canvas.viewportHeight}`);

  const sel = selectedLayers().filter((l) => l.visible && l.pathData);
  const outline = sel.map((l) => bakedOutline(l)).join('');
  const key = outline ? sel.map((l) => l.id).join(',') + '|' + outline : '';
  if (key === lastSelKey) return;
  lastSelKey = key;

  // Toggle the `hidden` ATTRIBUTE (SVGElement has no `.hidden` IDL property,
  // so setting el.hidden wouldn't reflect to CSS).
  if (!outline) {
    ov.setAttribute('hidden', '');
    ov.innerHTML = '';
    return;
  }
  const dEsc = outline.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  ov.removeAttribute('hidden');
  // sel-hit (first) is an invisible, FILLED drag target — `fill="none"` would
  // not be hittable. The halo/line are decorative and inert (see styles.css).
  ov.innerHTML =
    `<path class="sel-hit" fill="#000" fill-opacity="0" d="${dEsc}"/>` +
    `<path class="sel-halo" fill="none" d="${dEsc}"/>` +
    `<path class="sel-line" fill="none" d="${dEsc}"/>`;
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
    const isSel = appState.ui.selectedLayerIds.includes(layer.id);
    li.className =
      'layer-item' +
      (isSel ? ' selected' : '') +
      (layer.id === appState.ui.primaryLayerId ? ' primary' : '') +
      (layer.visible ? '' : ' hidden-layer');
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
    const dup = miniBtn('⧉', 'Duplicate', (e) => { e.stopPropagation(); duplicateLayers([layer.id]); });
    const del = miniBtn('✕', 'Delete', (e) => { e.stopPropagation(); deleteLayer(layer.id); });

    li.append(vis, name, up, down, dup, del);
    li.addEventListener('click', (e) => handleLayerClick(layer.id, e));
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
  appState.ui.selectedLayerIds = id ? [id] : [];
  appState.ui.primaryLayerId = id || null;
  appState.ui.selectAnchorId = id || null;
  scheduleRender();
}
// Layer-list click with modifiers: plain = single; Ctrl/Cmd = toggle; Shift =
// range from the anchor (in visual / front-first order).
function handleLayerClick(id, e) {
  const ui = appState.ui;
  if (e.shiftKey && ui.selectAnchorId) {
    const order = doc().layers.map((l) => l.id).reverse();
    const a = order.indexOf(ui.selectAnchorId);
    const b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      ui.selectedLayerIds = order.slice(lo, hi + 1);
      ui.primaryLayerId = id;
    }
  } else if (e.ctrlKey || e.metaKey) {
    const i = ui.selectedLayerIds.indexOf(id);
    if (i >= 0) {
      ui.selectedLayerIds.splice(i, 1);
      ui.primaryLayerId = ui.selectedLayerIds[ui.selectedLayerIds.length - 1] || null;
    } else {
      ui.selectedLayerIds.push(id);
      ui.primaryLayerId = id;
    }
    ui.selectAnchorId = id;
  } else {
    ui.selectedLayerIds = [id];
    ui.primaryLayerId = id;
    ui.selectAnchorId = id;
  }
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
    reconcileSelection();
  });
}
function deleteSelected() {
  if (!appState.ui.selectedLayerIds.length) return;
  commit(() => {
    const sel = new Set(appState.ui.selectedLayerIds);
    doc().layers = doc().layers.filter((l) => !sel.has(l.id));
    reconcileSelection();
  });
}
// Duplicate the given layers, inserting each copy directly above its original
// (i.e. right after it in paint order), then select the copies.
function duplicateLayers(ids) {
  if (!ids || !ids.length) return;
  const set = new Set(ids);
  commit(() => {
    const out = [];
    const newIds = [];
    for (const l of doc().layers) {
      out.push(l);
      if (set.has(l.id)) {
        const copy = structuredClone(l);
        copy.id = newId();
        copy.name = l.name + ' copy';
        out.push(copy);
        newIds.push(copy.id);
      }
    }
    doc().layers = out;
    appState.ui.selectedLayerIds = newIds;
    appState.ui.primaryLayerId = newIds[newIds.length - 1] || null;
    appState.ui.selectAnchorId = appState.ui.primaryLayerId;
  });
}
// Resize the project's canvas (viewport = VD viewportWidth/Height = SVG
// viewBox, also the dp display size). When "Scale contents" is on, every layer
// path and the light position scale by the ratio so the icon keeps filling the
// canvas; otherwise only the coordinate space changes.
function resizeCanvas(newW, newH) {
  const d = doc();
  newW = clampNum(Math.round(newW), 1, 8192, d.canvas.viewportWidth);
  newH = clampNum(Math.round(newH), 1, 8192, d.canvas.viewportHeight);
  const oldW = d.canvas.viewportWidth;
  const oldH = d.canvas.viewportHeight;
  if (newW === oldW && newH === oldH) return;
  const scaleContents = $('canvas-scale').checked;
  commit(() => {
    if (scaleContents && oldW > 0 && oldH > 0) {
      const m = P.scale(newW / oldW, newH / oldH);
      for (const l of d.layers) {
        if (l.pathData) l.pathData = P.serialize(P.transform(P.parse(l.pathData), m));
      }
      d.light.position = { x: (d.light.position.x * newW) / oldW, y: (d.light.position.y * newH) / oldH };
    }
    d.canvas.viewportWidth = d.canvas.width = newW;
    d.canvas.viewportHeight = d.canvas.height = newH;
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
  if (doc().light.type === 'off') return; // nothing to drag when the light is off
  dragging = true;
  try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  beginGesture();
  // Don't jump on press — the handle already sits at the light; only a drag moves it.
  e.preventDefault();
  e.stopPropagation();
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
  try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
  commitGesture();
}
// Only the handle is draggable — clicking elsewhere on the canvas does nothing.
handle.addEventListener('pointerdown', onDragStart);
handle.addEventListener('pointermove', onDragMove);
handle.addEventListener('pointerup', onDragEnd);
handle.addEventListener('pointercancel', onDragEnd);

// ---- moving layers on the canvas (click to select, drag to move) ----
// Listeners live on the STABLE #canvas-wrap; pointer capture there survives the
// selection overlay's per-frame innerHTML rebuild during a drag. The light
// handle stopPropagations its own presses, so they never reach here.
const canvasWrap = $('canvas-wrap');
let layerDrag = null;

// Geometric hit-test: topmost (front-most) filled layer under a viewport point.
let _hitCtx = null;
function hitContext() {
  if (!_hitCtx) _hitCtx = document.createElement('canvas').getContext('2d');
  return _hitCtx;
}
function layerAt(vx, vy) {
  const layers = doc().layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.visible || !l.pathData) continue;
    const d = bakedOutline(l);
    if (!d) continue;
    let path;
    try { path = new Path2D(d); } catch (_) { continue; }
    const rule = l.fillRule === 'evenOdd' ? 'evenodd' : 'nonzero';
    if (hitContext().isPointInPath(path, vx, vy, rule)) return l.id;
  }
  return null;
}

function startLayerDrag(e, v) {
  const sel = selectedLayers();
  if (!sel.length) return;
  layerDrag = {
    startX: v.x,
    startY: v.y,
    moved: false,
    items: sel.map((l) => ({
      id: l.id,
      tx: (l.transform && +l.transform.translateX) || 0,
      ty: (l.transform && +l.transform.translateY) || 0,
    })),
  };
  try { canvasWrap.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
}

function onCanvasPointerDown(e) {
  if (e.button != null && e.button !== 0) return; // primary button / touch only
  const v = viewportFromEvent(e);
  const modifier = e.ctrlKey || e.metaKey || e.shiftKey;
  // Always hit-test the actual layer geometry (front-most first), NOT the
  // selection overlay's sel-hit. A selected layer's sel-hit covers its whole
  // shape, so trusting e.target would mask any layer it overlaps and you could
  // never click-select them.
  const hitId = layerAt(v.x, v.y);

  // With a modifier, the canvas mirrors the layer list (toggle / range select).
  if (modifier) {
    if (hitId) handleLayerClick(hitId, e);
    return;
  }

  if (hitId) {
    if (appState.ui.selectedLayerIds.includes(hitId)) {
      // Grabbed an already-selected shape → drag the whole selection.
      startLayerDrag(e, v);
    } else {
      // Clicked a different (front-most) layer → select it, then drag it.
      appState.ui.selectedLayerIds = [hitId];
      appState.ui.primaryLayerId = hitId;
      appState.ui.selectAnchorId = hitId;
      startLayerDrag(e, v);
      scheduleRender();
    }
  } else if (appState.ui.selectedLayerIds.length) {
    selectLayer(null); // clicked empty canvas → deselect
  }
}

function onCanvasPointerMove(e) {
  if (!layerDrag) return;
  const v = viewportFromEvent(e);
  const dx = v.x - layerDrag.startX;
  const dy = v.y - layerDrag.startY;
  if (!layerDrag.moved) {
    if (dx === 0 && dy === 0) return; // a click that never moved: no undo entry
    beginGesture();
    layerDrag.moved = true;
  }
  const byId = new Map(doc().layers.map((l) => [l.id, l]));
  for (const it of layerDrag.items) {
    const l = byId.get(it.id);
    if (!l) continue;
    const t = ensureTransform(l);
    t.translateX = it.tx + dx; // no clamping — off-canvas is allowed
    t.translateY = it.ty + dy;
  }
  scheduleRender();
}

function onCanvasPointerUp(e) {
  if (!layerDrag) return;
  const moved = layerDrag.moved;
  layerDrag = null;
  try { canvasWrap.releasePointerCapture(e.pointerId); } catch (_) {}
  if (moved) commitGesture();
}

canvasWrap.addEventListener('pointerdown', onCanvasPointerDown);
canvasWrap.addEventListener('pointermove', onCanvasPointerMove);
canvasWrap.addEventListener('pointerup', onCanvasPointerUp);
canvasWrap.addEventListener('pointercancel', onCanvasPointerUp);

function positionLightHandle() {
  const d = doc();
  // Hide the handle when the light is off (nothing to drag).
  if (d.light.type === 'off') {
    handle.style.display = 'none';
    return;
  }
  handle.style.display = '';
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
  const layer = primaryLayer();
  const count = appState.ui.selectedLayerIds.length;
  const showLayer = count >= 1 && !!layer;
  $('scene-panel').hidden = showLayer;
  $('layer-panel').hidden = !showLayer;
  if (showLayer) updateLayerControls(layer, count);
  else updateSceneControls();
}

function updateSceneControls() {
  const d = doc();
  const L = d.light;
  setVal($('light-type'), L.type);
  const off = L.type === 'off';
  const point = L.type === 'point';
  // Position X/Y apply to a point light; azimuth to a distant light; everything
  // light-related hides when off.
  $('row-light-x').style.display = point ? '' : 'none';
  $('row-light-y').style.display = point ? '' : 'none';
  setVal($('light-x'), round2(L.position.x));
  setVal($('light-y'), round2(L.position.y));
  $('row-azimuth').style.display = L.type === 'distant' ? '' : 'none';
  $('row-elevation').style.display = off ? 'none' : '';
  $('row-intensity').style.display = off ? 'none' : '';
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
  bgColorField.setValue(d.canvas.exportBackground.color);
  setVal($('png-size'), d.canvas.pngSize);
}

function updateLayerControls(layer, count) {
  const m = layer.material;
  // Multi-select: title shows the count; the per-layer Name field is hidden
  // (controls show the primary layer's values; edits apply to all selected).
  $('layer-panel-title').textContent = count > 1 ? `${count} layers` : 'Layer';
  $('row-layer-name').style.display = count > 1 ? 'none' : '';
  setVal($('layer-name'), layer.name);
  // Position = primary layer's current bbox top-left (focus-safe via setVal).
  const tl = layer.pathData ? layerTopLeft(layer) : { x: 0, y: 0 };
  setVal($('layer-x'), round2(tl.x));
  setVal($('layer-y'), round2(tl.y));
  matColorField.setValue(m.baseColor.slice(0, 7));
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
  const dist = layer.castsShadow.distance == null ? 1 : layer.castsShadow.distance;
  setVal($('shadow-distance'), dist);
  $('out-shadow-distance').textContent = (+dist).toFixed(2) + '×';
  setChecked($('shadow-clip'), layer.castsShadow.clipToLayers !== false);

  const stroke = m.stroke;
  setChecked($('stroke-on'), !!stroke);
  strokeColorField.setValue(stroke ? stroke.color.slice(0, 7) : '#000000');
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
  liveInput($('light-x'), (el) => { const v = +el.value; if (isFinite(v)) doc().light.position.x = clamp(v, 0, doc().canvas.viewportWidth); });
  liveInput($('light-y'), (el) => { const v = +el.value; if (isFinite(v)) doc().light.position.y = clamp(v, 0, doc().canvas.viewportHeight); });
  liveInput($('light-azimuth'), (el) => { doc().light.azimuth = +el.value; });
  liveInput($('light-elevation'), (el) => { doc().light.elevation = +el.value; });
  liveInput($('light-intensity'), (el) => { doc().light.intensity = +el.value; });

  // Scene · canvas — resize on commit (change), not per keystroke, so "scale
  // contents" computes the ratio against the size you started from. With "Link
  // W/H" on (default), editing one dimension updates the other to keep the
  // current aspect ratio, so the whole canvas resizes together.
  // After resizing, reflect the final dimensions in BOTH fields immediately.
  // The async render's setVal() skips a focused field, so when the user edits
  // one field and tabs/clicks into the other, the linked field would otherwise
  // stay stale — write them directly here.
  function syncCanvasFields() {
    $('canvas-w').value = doc().canvas.viewportWidth;
    $('canvas-h').value = doc().canvas.viewportHeight;
  }
  $('canvas-w').addEventListener('change', () => {
    const c = doc().canvas;
    let w = +$('canvas-w').value;
    let h = +$('canvas-h').value;
    if ($('canvas-lock').checked && c.viewportWidth > 0) h = Math.round((w * c.viewportHeight) / c.viewportWidth);
    resizeCanvas(w, h);
    syncCanvasFields();
  });
  $('canvas-h').addEventListener('change', () => {
    const c = doc().canvas;
    let w = +$('canvas-w').value;
    let h = +$('canvas-h').value;
    if ($('canvas-lock').checked && c.viewportHeight > 0) w = Math.round((h * c.viewportWidth) / c.viewportHeight);
    resizeCanvas(w, h);
    syncCanvasFields();
  });
  for (const b of document.querySelectorAll('.preset-size')) {
    b.addEventListener('click', () => resizeCanvas(+b.dataset.size, +b.dataset.size));
  }
  liveInput($('bg-transparent'), (el) => { doc().canvas.exportBackground.transparent = el.checked; });
  liveInput($('png-size'), (el) => { doc().canvas.pngSize = clampNum(+el.value, 16, 8192, 1024); });

  // Color fields (custom in-page popover — never clips off-screen).
  matColorField = createColorField($('mat-color'), {
    onInput: (hex) => { beginGesture(); withSelected((l) => (l.material.baseColor = hex)); scheduleRender(); },
    onCommit: commitGesture,
  });
  bgColorField = createColorField($('bg-color'), {
    onInput: (hex) => { beginGesture(); doc().canvas.exportBackground.color = hex; scheduleRender(); },
    onCommit: commitGesture,
  });
  strokeColorField = createColorField($('stroke-color'), {
    onInput: (hex) => { beginGesture(); withSelected((l) => { if (l.material.stroke) l.material.stroke.color = hex; }); scheduleRender(); },
    onCommit: commitGesture,
  });

  // Document name → export/save filename (UI state; not undone).
  const nameInput = $('doc-name');
  nameInput.value = appState.ui.projectName;
  nameInput.addEventListener('input', () => { appState.ui.projectName = nameInput.value; });

  // Layer · position — absolute bbox top-left. Editing moves the PRIMARY layer
  // to the typed coordinate and shifts every selected layer by the same delta
  // (matching drag). Delta is from the exact minX/minY so there's no drift.
  liveInput($('layer-x'), (el) => {
    const p = primaryLayer();
    if (!p || !p.pathData) return;
    const v = +el.value;
    if (!isFinite(v)) return;
    const dx = v - layerTopLeft(p).x;
    withSelected((l) => translateLayer(l, dx, 0));
  });
  liveInput($('layer-y'), (el) => {
    const p = primaryLayer();
    if (!p || !p.pathData) return;
    const v = +el.value;
    if (!isFinite(v)) return;
    const dy = v - layerTopLeft(p).y;
    withSelected((l) => translateLayer(l, 0, dy));
  });

  // Layer · material
  liveInput($('layer-name'), (el) => { withPrimary((l) => (l.name = el.value)); });
  liveInput($('mat-alpha'), (el) => { withSelected((l) => (l.material.fillAlpha = +el.value)); });
  for (const r of document.querySelectorAll('input[name="fillmode"]')) {
    r.addEventListener('change', () => commit(() => withSelected((l) => (l.material.fillMode = r.value))));
  }
  liveInput($('mat-emboss'), (el) => { withSelected((l) => (l.material.embossIntensity = +el.value)); });
  liveInput($('mat-sheen-on'), (el) => { withSelected((l) => (l.material.sheen.enabled = el.checked)); });
  liveInput($('mat-sheen'), (el) => { withSelected((l) => (l.material.sheen.strength = +el.value)); });
  liveInput($('mat-fillrule'), (el) => { withSelected((l) => (l.fillRule = el.value)); });

  // Layer · shadow
  liveInput($('shadow-on'), (el) => { withSelected((l) => (l.castsShadow.enabled = el.checked)); });
  liveInput($('shadow-opacity'), (el) => { withSelected((l) => (l.castsShadow.opacity = +el.value)); });
  liveInput($('shadow-spread'), (el) => { withSelected((l) => (l.castsShadow.spread = +el.value)); });
  liveInput($('shadow-distance'), (el) => {
    $('out-shadow-distance').textContent = (+el.value).toFixed(2) + '×';
    withSelected((l) => (l.castsShadow.distance = +el.value));
  });
  liveInput($('shadow-clip'), (el) => { withSelected((l) => (l.castsShadow.clipToLayers = el.checked)); });

  // Layer · stroke
  liveInput($('stroke-on'), (el) => {
    withSelected((l) => {
      if (el.checked) l.material.stroke = l.material.stroke || { color: '#000000ff', width: 1, cap: 'butt', join: 'miter' };
      else l.material.stroke = null;
    });
  });
  liveInput($('stroke-width'), (el) => { withSelected((l) => { if (l.material.stroke) l.material.stroke.width = +el.value; }); });
  liveInput($('mat-fillnone'), (el) => { withSelected((l) => (l.material.fillNone = el.value === 'true')); });

  $('layer-deselect').addEventListener('click', () => selectLayer(null));
}

// Apply an edit to every selected layer (shared material/shadow/stroke).
function withSelected(fn) {
  for (const l of selectedLayers()) fn(l);
}
// Apply an edit to the primary layer only (the per-layer Name).
function withPrimary(fn) {
  const l = primaryLayer();
  if (l) fn(l);
}

// ---- layer position (move) ----
// The move offset lives in layer.transform.translateX/Y — already baked by
// derive() and bakedOutline(), and already persisted. These helpers are the
// single source of truth shared by the drag gesture and the X/Y fields.
function ensureTransform(layer) {
  if (!layer.transform) layer.transform = { translateX: 0, translateY: 0 };
  if (!isFinite(+layer.transform.translateX)) layer.transform.translateX = 0;
  if (!isFinite(+layer.transform.translateY)) layer.transform.translateY = 0;
  return layer.transform;
}
function translateLayer(layer, dx, dy) {
  const t = ensureTransform(layer);
  t.translateX += dx;
  t.translateY += dy;
}
// Current top-left of the layer's baked bbox, in viewport (canvas) coordinates.
function layerTopLeft(layer) {
  if (!layer || !layer.pathData) return { x: 0, y: 0 };
  const b = P.bbox(P.parse(bakedOutline(layer)));
  return { x: b.minX, y: b.minY };
}

// ---- top bar: file + export ----
function wireToolbar() {
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);

  // Privacy link opens the policy in a new tab; record the click as an
  // anonymous TelemetryDeck signal (no-op when the SDK is absent, e.g. on
  // localhost/file test mode).
  $('privacy-link').addEventListener('click', () => {
    window.td?.signal?.('privacyLinkClicked');
  });

  $('btn-new').addEventListener('click', () => {
    if (doc().layers.length && !confirm('Start a new document? Unsaved changes will be lost.')) return;
    loadDocument({ canvas: defaultCanvas(), light: defaultLight(), layers: [] }, 'icon');
    toast('New document.');
  });

  // Both pickers sniff the file and route by content, so a project opened via
  // Import (or a vector "opened") still does the right thing. `prefer` only
  // breaks ties for ambiguous files.
  $('file-open').addEventListener('change', (e) => handleFile(e, 'project'));
  $('file-import').addEventListener('change', (e) => handleFile(e, 'vector'));

  $('btn-save').addEventListener('click', () => {
    const json = serializeProject(doc(), appState.ui.projectName);
    download(new Blob([json], { type: 'application/json' }), exportName('', 'json'));
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

// A project file is JSON with our magic id; a vector is SVG/VD markup.
function looksLikeProject(text, filename) {
  if (/"format"\s*:\s*"icon-emboss"/.test(text)) return true;
  if (/\.json$/i.test(filename)) {
    try { return JSON.parse(text) && typeof JSON.parse(text) === 'object'; } catch (_) { return false; }
  }
  return false;
}
function looksLikeVector(text, filename) {
  return /<\s*svg[\s>]/i.test(text) || /<\s*vector[\s>]/i.test(text) || /\.(svg|xml)$/i.test(filename);
}

// Single entry for both Open and Import — detect kind, route, and tell the user
// when it didn't match the button they pressed (Open vs Import, PLAN §7).
async function handleFile(e, prefer) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();

  const isProject = looksLikeProject(text, file.name);
  const isVector = !isProject && looksLikeVector(text, file.name);
  const kind = isProject ? 'project' : isVector ? 'vector' : prefer;

  if (kind === 'project') {
    const res = parseProject(text);
    if (!res.ok) return toast(res.error, 'error');
    loadDocument(res.document, res.name);
    toast(prefer === 'vector' ? `That's a project file — opened "${res.name}".` : `Opened "${res.name}".`);
  } else {
    const res = importVector(text, file.name);
    if (!res.ok) return toast(res.error, 'error');
    importLayers(res, file.name, prefer === 'project');
  }
}

function importLayers(res, filename, viaOpen) {
  commit(() => {
    const d = doc();
    if (d.layers.length === 0 && res.viewport) {
      d.canvas.viewportWidth = d.canvas.width = res.viewport.width;
      d.canvas.viewportHeight = d.canvas.height = res.viewport.height;
      d.light.position = { x: res.viewport.width * 0.35, y: res.viewport.height * 0.3 };
    }
    d.layers.push(...res.layers);
  });
  if (res.layers.length) {
    appState.ui.selectedLayerIds = [res.layers[0].id];
    appState.ui.primaryLayerId = res.layers[0].id;
    appState.ui.selectAnchorId = res.layers[0].id;
  }
  const warn = res.warnings && res.warnings.length;
  const prefix = viaOpen ? `That's a vector file — ` : '';
  toast(`${prefix}Imported ${res.layers.length} layer${res.layers.length === 1 ? '' : 's'} from ${filename}.` + (warn ? ` (${res.warnings.length} warning${res.warnings.length === 1 ? '' : 's'})` : ''), warn ? 'warn' : '');
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
      download(new Blob([xml], { type: 'text/xml' }), exportName('vd', 'xml'));
      toast('Exported VectorDrawable XML.');
    } else if (action === 'svg') {
      const svg = standaloneSvg(derived, d.canvas.viewportWidth, d.canvas.viewportHeight, { background: true });
      download(new Blob([svg], { type: 'image/svg+xml' }), exportName('svg', 'svg'));
      toast('Exported SVG.');
    } else if (action === 'project') {
      const json = serializeProject(d, appState.ui.projectName);
      download(new Blob([json], { type: 'application/json' }), exportName('', 'json'));
      toast('Saved project JSON.');
    } else if (action === 'png-transparent' || action === 'png-bg') {
      const size = d.canvas.pngSize || 1024;
      const withBg = action === 'png-bg';
      const background = withBg ? { transparent: false, color: d.canvas.exportBackground.color } : { transparent: true };
      const blob = await renderPng(derived, size, background);
      download(blob, exportName(withBg ? 'iwb' : 'iwt', 'png'));
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
  appState.ui.selectedLayerIds = [];
  appState.ui.primaryLayerId = null;
  appState.ui.selectAnchorId = null;
  appState.ui.projectName = name || 'icon';
  $('doc-name').value = appState.ui.projectName;
  undoStack.length = 0;
  redoStack.length = 0;
  gestureSnapshot = null;
  updateHistoryButtons();
  scheduleRender();
}

// ---- helpers ----
// Sanitize the document name into a safe download filename base.
function fileBase() {
  const safe = (appState.ui.projectName || '').replace(/[\/\\?%*:|"<>\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').trim();
  return safe || 'icon';
}
// Build an export filename: "<name>-<suffix>.<ext>" (no suffix → "<name>.<ext>").
// Suffixes: vd (VectorDrawable), svg, iwb (png w/ background), iwt (png transparent).
function exportName(suffix, ext) {
  return `${fileBase()}${suffix ? '-' + suffix : ''}.${ext}`;
}

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
function round2(v) {
  return Math.round(v * 100) / 100;
}

// ---- keyboard ----
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === 'd' && appState.ui.selectedLayerIds.length) { e.preventDefault(); duplicateLayers(appState.ui.selectedLayerIds.slice()); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && appState.ui.selectedLayerIds.length) {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      e.preventDefault();
      deleteSelected();
    }
  }
});

// ---- init ----
const DEFAULT_PROJECT_URL = 'assets/' + encodeURIComponent('app icon.json');

async function init() {
  $('app-version').textContent = 'v' + APP_VERSION;
  wireControls();
  wireToolbar();
  updateHistoryButtons();

  // Load from share link if present; otherwise open the bundled default
  // project ("app icon"), falling back to the built-in sample document if it
  // can't be fetched (e.g. the assets aren't available).
  if (location.hash && location.hash.indexOf('doc=') >= 0) {
    const res = decodeShareFragment(location.hash);
    if (res && res.ok) {
      appState.document = res.document;
      appState.ui.projectName = res.name;
      toast(`Loaded shared "${res.name}".`);
    } else if (res && !res.ok) {
      toast(res.error, 'error');
    }
  } else {
    try {
      const resp = await fetch(DEFAULT_PROJECT_URL);
      if (resp.ok) {
        const parsed = parseProject(await resp.text());
        if (parsed.ok) {
          appState.document = parsed.document;
          appState.ui.projectName = parsed.name;
        }
      }
    } catch (_) {
      /* keep the built-in sample document */
    }
  }
  $('doc-name').value = appState.ui.projectName;
  render();
}

init();
