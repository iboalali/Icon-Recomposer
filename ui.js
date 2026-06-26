// ui.js — panels, controlled inputs, draggable light handle, render loop,
// undo/redo, and file/export wiring (PLAN §6, §15).
//
// One-way data flow: input → mutate state → render(). Two kinds of DOM:
//   - derived views (preview SVG, layer list): rebuilt from state each render.
//   - controlled inputs (in index.html): built ONCE; render only updates .value
//     (never recreates them — that would kill focus/drag/color-pickers).

import { derive, bakedOutline } from './derive.js';
import * as P from './path.js';
import { documentAt, propType, getAtPath } from './animate.js';
import { previewSvg, standaloneSvg } from './svg.js';
import { exportVD } from './export-vd.js';
import { exportAVD } from './export-avd.js';
import { renderPng } from './export-png.js';
import { importVector } from './import.js';
import { createColorField } from './colorpicker.js';
import { confirmDialog, isDialogOpen } from './dialog.js';
import { parseColor, mix, toHex, WHITE, BLACK } from './color.js';
import { signal as tdSignal, reportError as tdError } from './telemetry.js';
import {
  APP_VERSION,
  newId,
  sampleDocument,
  defaultCanvas,
  defaultLight,
  defaultGradient,
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
  ui: {
    selectedLayerIds: [], primaryLayerId: null, selectAnchorId: null,
    projectName: 'icon', scaleLinked: true,
    // View-only zoom/pan of the canvas (ephemeral; never saved/exported).
    // scale 1 = fit; panX/panY are screen px applied as a CSS transform.
    view: { scale: 1, panX: 0, panY: 0 },
    // Timeline playback (ephemeral; never serialized — like `view`). time =
    // playhead seconds; autokey = "record edits as keyframes" (ANIMATION.md D1).
    playback: { time: 0, playing: false, scrubbing: false, autokey: false, selKey: null, speed: 1 },
  },
};
const undoStack = [];
const redoStack = [];
let gestureSnapshot = null;

// ---- file binding (File System Access API) ----
// The on-disk file the document is bound to: Save overwrites it and the watcher
// polls it. null when the document came from upload / default / session / share
// link (Save then falls back to a download). Watching is opt-in and the first
// in-app edit stops it (see commit/commitGesture). All of this is progressive
// enhancement — on browsers without the API the bindings stay null and the
// related buttons stay hidden.
let currentHandle = null;
let watchTimer = null; // setInterval id while watching external edits
let watchLastMod = 0; // last-seen file.lastModified, to detect external changes
let watchPolling = false; // re-entrancy guard for the async poll tick
const WATCH_MS = 700;
const canPick = 'showOpenFilePicker' in window; // Chromium open/save pickers
const fsaSupported = canPick || 'launchQueue' in window;

// Custom color-popover fields (created once in wireControls).
let matColorField = null;
let bgColorField = null;
let strokeColorField = null;
let gradFromField = null; // simple gradient: first stop's color
let gradToField = null; //   simple gradient: last stop's color

const doc = () => appState.document;
// The DOCUMENT AS DISPLAYED: the base document interpolated at the playhead when
// a timeline is animating, else the base itself. Set by render(); read ONLY by
// render-time display code (preview, inspector values, light handle, marquee) so
// the inspector shows animated values. All EDIT handlers mutate the base doc()
// directly — never this clone, which is discarded each frame (ANIMATION.md §9.3).
let viewDoc = null;
const view = () => viewDoc || appState.document;
const pb = () => appState.ui.playback;
// The DISPLAYED form of a layer (interpolated when animating, else the base one).
const viewLayerOf = (id) => view().layers.find((l) => l.id === id) || appState.document.layers.find((l) => l.id === id);
// Selection is a set of layer ids; the "primary" (last-clicked) layer's values
// populate the inspector, while edits apply to every selected layer.
const selectedLayers = () => doc().layers.filter((l) => appState.ui.selectedLayerIds.includes(l.id));
const primaryLayer = () =>
  doc().layers.find((l) => l.id === appState.ui.primaryLayerId) ||
  doc().layers.find((l) => appState.ui.selectedLayerIds.includes(l.id)) ||
  null;

// ---- session persistence ----
// Auto-save the current document to localStorage so work is restored on reopen.
const SESSION_KEY = 'icon-recomposer:session';

// Persist the current document (document + name only; selection and zoom/pan are
// ephemeral by design). Best-effort: storage can be full or disabled (private
// mode) — never let a save failure break an edit.
function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, serializeProject(appState.document, appState.ui.projectName));
  } catch (_) { /* quota exceeded / storage disabled — ignore */ }
}

// Load a previously-saved session, or null if none/invalid. Reuses parseProject,
// which validates format, rejects newer schema, migrates v1→v2, and normalizes.
function loadSession() {
  let text;
  try { text = localStorage.getItem(SESSION_KEY); } catch (_) { return null; }
  if (!text) return null;
  const res = parseProject(text);
  if (!res.ok) {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {} // drop corrupt entry
    return null;
  }
  return res; // { ok, document, name }
}

// ---- undo/redo ----
function snapshot() {
  return structuredClone(doc());
}
function beginGesture() {
  if (!gestureSnapshot) gestureSnapshot = snapshot();
}
function commitGesture() {
  if (gestureSnapshot) {
    if (watchTimer) stopWatch('edited'); // an in-app edit stops external watching
    undoStack.push(gestureSnapshot);
    gestureSnapshot = null;
    redoStack.length = 0;
    capStack(undoStack);
    updateHistoryButtons();
    saveSession();
  }
}
// Discrete (atomic) change: snapshot, mutate, push.
function commit(mutate) {
  if (watchTimer) stopWatch('edited'); // an in-app edit stops external watching
  const snap = snapshot();
  mutate();
  undoStack.push(snap);
  redoStack.length = 0;
  capStack(undoStack);
  updateHistoryButtons();
  saveSession();
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
  saveSession();
  scheduleRender();
  tdSignal('undo');
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  appState.document = redoStack.pop();
  reconcileSelection();
  updateHistoryButtons();
  saveSession();
  scheduleRender();
  tdSignal('redo');
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

// True when a timeline is enabled and has at least one track — i.e. the document
// should be interpolated at the playhead for display/export.
function isAnimating(d) {
  const tl = d.timeline;
  return !!(tl && tl.enabled && tl.tracks && tl.tracks.length);
}

let cachedDerived = null;
function render() {
  const d = doc();
  // Pre-pass: interpolate at the playhead (ANIMATION.md §2). documentAt returns
  // the SAME object when not animating, so the static path is unchanged.
  viewDoc = isAnimating(d) ? documentAt(d, clampTime(pb().time)) : d;
  cachedDerived = derive(viewDoc);

  // Derived views.
  $('preview').innerHTML = previewSvg(cachedDerived);
  renderLayerList();

  // Canvas chrome. Set aspect-ratio and the `--ar` (width/height) the CSS uses
  // to contain the canvas inside the stage in both dimensions.
  $('canvas-wrap').style.aspectRatio = `${d.canvas.viewportWidth} / ${d.canvas.viewportHeight}`;
  $('canvas-wrap').style.setProperty('--ar', d.canvas.viewportWidth / d.canvas.viewportHeight);
  const bg = d.canvas.exportBackground;
  $('checker').style.display = bg.transparent ? '' : 'none';
  $('canvas-wrap').style.background = bg.transparent ? '' : bg.color;

  positionLightHandle();
  updateSelectionOverlay();
  updateInspector();
  renderTimeline();

  // Re-clamp the view against the (possibly changed) canvas size and keep the
  // transform in sync — e.g. after a canvas resize or document load.
  clampView();
  applyViewTransform();
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

  // Outline from the DISPLAYED layers so the marquee tracks animated transforms.
  const vlayers = view().layers;
  const sel = selectedLayers()
    .map((l) => vlayers.find((x) => x.id === l.id) || l)
    .filter((l) => l.visible && l.pathData);
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
    const grad = miniBtn('▦', 'Duplicate as gradient overlay', (e) => { e.stopPropagation(); duplicateAsGradientOverlay(layer.id); });
    const del = miniBtn('✕', 'Delete', (e) => { e.stopPropagation(); deleteLayer(layer.id); });

    li.append(vis, name, up, down, dup, grad, del);
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
// Clone a layer directly above itself as a gradient overlay: same path, fill
// mode 'gradient' with a base-color→transparent default, shadow off (the base
// already casts). Lets you keep an embossed base AND a gradient on one shape.
function duplicateAsGradientOverlay(id) {
  commit(() => {
    const layers = doc().layers;
    const i = layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const src = layers[i];
    const copy = structuredClone(src);
    copy.id = newId();
    copy.name = src.name + ' gradient';
    const base = (copy.material.baseColor || '#3b82f6').slice(0, 7);
    const g = defaultGradient(base, copy.pathData ? P.bbox(P.parse(copy.pathData)) : null);
    g.stops = [{ offset: 0, color: base, alpha: 0.55 }, { offset: 1, color: base, alpha: 0 }];
    copy.material.fillMode = 'gradient';
    copy.material.gradient = g;
    copy.castsShadow = Object.assign({}, copy.castsShadow, { enabled: false });
    layers.splice(i + 1, 0, copy);
    appState.ui.selectedLayerIds = [copy.id];
    appState.ui.primaryLayerId = copy.id;
    appState.ui.selectAnchorId = copy.id;
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
  // Auto-key the dragged light (the handle drives position for a point light,
  // azimuth+elevation for a distant one). No-op unless REC/track per the rule.
  const type = doc().light.type;
  if (type === 'point') { recordKeyframe('scene', 'light.position.x'); recordKeyframe('scene', 'light.position.y'); }
  else if (type === 'distant') { recordKeyframe('scene', 'light.azimuth'); recordKeyframe('scene', 'light.elevation'); }
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
const stage = $('stage');
let layerDrag = null;
// Zoom/pan gesture state (all ephemeral; the result lives in appState.ui.view).
const activePointers = new Map(); // pointerId → { x, y } (for 2-finger pinch)
let pinch = null; // { distStart, midStart, scaleStart, panStart:{x,y} }
let panDrag = null; // { pointerId, startX, startY, panX0, panY0 }

const MAX_ZOOM = 8;

// Geometric hit-test: topmost (front-most) filled layer under a viewport point.
let _hitCtx = null;
function hitContext() {
  if (!_hitCtx) _hitCtx = document.createElement('canvas').getContext('2d');
  return _hitCtx;
}
function layerAt(vx, vy) {
  // Hit-test the DISPLAYED geometry (view layers) so clicks match what's drawn —
  // during animation a layer is shown at its interpolated transform, not the
  // base one. view() === doc() when not animating, so static behavior is identical.
  const layers = view().layers;
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
    // Capture the DISPLAYED translate (interpolated when animating) so the layer
    // follows the cursor from where it's drawn, not from its base position.
    items: sel.map((l) => {
      const vl = viewLayerOf(l.id) || l;
      return {
        id: l.id,
        tx: (vl.transform && +vl.transform.translateX) || 0,
        ty: (vl.transform && +vl.transform.translateY) || 0,
      };
    }),
  };
  try { canvasWrap.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
}

function onCanvasPointerDown(e) {
  // Track every pointer for pinch detection. A 2nd pointer starts a pinch and
  // takes over from any single-pointer gesture in progress.
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 2) {
    abortCanvasGestures();
    startPinch();
    e.preventDefault();
    return;
  }
  // Middle-mouse pans always (even with a selection) — must run before the
  // primary-button gate below.
  if (e.button === 1) { startPanDrag(e); return; }
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
  } else if (contentOverflows()) {
    startPanDrag(e); // empty canvas, nothing selected, zoomed in → pan
  }
}

function onCanvasPointerMove(e) {
  // Keep the tracked position fresh for pinch math.
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch) return onPinchMove();
  if (panDrag) return onPanMove(e);
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
    setLayerTranslate(l, it.tx + dx, it.ty + dy); // no clamping — off-canvas is allowed
  }
  scheduleRender();
}

function onCanvasPointerUp(e) {
  activePointers.delete(e.pointerId);
  // A finger lifting ends the pinch; don't silently convert a remaining finger
  // into a pan (that causes a jump).
  if (pinch) { pinch = null; return; }
  if (panDrag) { endPanDrag(e); return; }
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

// ---- view-only zoom + pan (PLAN: transform #canvas-wrap; coords stay correct
// because viewportFromEvent reads the live transformed rect, and the handle /
// marquee ride inside canvas-wrap). The transform never touches the document,
// so preview/PNG/SVG/VD/share are identical regardless of zoom/pan.
function contentOverflows() {
  return appState.ui.view.scale > 1;
}
// Center of the stage in client px = the transform-origin (canvas-wrap is
// centered in the stage via place-items:center, so its center == stage center).
function stageCenter() {
  const r = stage.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
// Keep pan within bounds: centered when the content fits, clamped to the content
// edges when it overflows. Uses untransformed layout size (offsetWidth/Height).
function clampView() {
  const v = appState.ui.view;
  const baseW = canvasWrap.offsetWidth;
  const baseH = canvasWrap.offsetHeight;
  if (!baseW || !baseH) return; // pre-layout: nothing to clamp yet
  const maxPanX = Math.max(0, (v.scale * baseW - stage.clientWidth) / 2);
  const maxPanY = Math.max(0, (v.scale * baseH - stage.clientHeight) / 2);
  v.panX = clamp(v.panX, -maxPanX, maxPanX);
  v.panY = clamp(v.panY, -maxPanY, maxPanY);
}
// Push appState.ui.view → the CSS transform (and the cursor affordance). Written
// as '' at rest so the DOM stays clean and there's no identity-transform blur.
function applyViewTransform() {
  const v = appState.ui.view;
  canvasWrap.style.transform =
    v.scale === 1 && v.panX === 0 && v.panY === 0
      ? ''
      : `translate(${v.panX}px, ${v.panY}px) scale(${v.scale})`;
  canvasWrap.classList.toggle('panning', !!panDrag);
  // "grab" affordance only when an empty-canvas left-drag would pan.
  canvasWrap.classList.toggle('pannable', !panDrag && contentOverflows() && !appState.ui.selectedLayerIds.length);
}
// Zoom toward a client-space focal point (cursor or pinch midpoint), keeping the
// content under that point fixed. Origin-center focal formula:
//   panNew = k*pan + (1-k)*(focal - center),  k = scaleNew/scaleOld.
function zoomAt(cx, cy, factor) {
  const v = appState.ui.view;
  const sOld = v.scale;
  const sNew = clamp(sOld * factor, 1, MAX_ZOOM);
  if (sNew === sOld) return;
  const k = sNew / sOld;
  const C = stageCenter();
  v.panX = k * v.panX + (1 - k) * (cx - C.x);
  v.panY = k * v.panY + (1 - k) * (cy - C.y);
  v.scale = sNew;
  clampView();
  applyViewTransform();
}
function onCanvasWheel(e) {
  e.preventDefault(); // also stops trackpad-pinch (ctrl+wheel) page zoom
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16; // lines → ~px
  else if (e.deltaMode === 2) dy *= stage.clientHeight; // pages → px
  // Trackpad pinch (ctrlKey) sends small deltas → use a finer rate.
  const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
  zoomAt(e.clientX, e.clientY, factor);
}

// ---- pan (middle-mouse always; empty-canvas left-drag when nothing selected
// and zoomed in). Pan is a screen-px translate, so we track raw client coords.
function startPanDrag(e) {
  const v = appState.ui.view;
  panDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, panX0: v.panX, panY0: v.panY };
  try { canvasWrap.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
  applyViewTransform(); // reflect grabbing cursor
}
function onPanMove(e) {
  const v = appState.ui.view;
  v.panX = panDrag.panX0 + (e.clientX - panDrag.startX);
  v.panY = panDrag.panY0 + (e.clientY - panDrag.startY);
  clampView();
  applyViewTransform();
}
function endPanDrag(e) {
  try { canvasWrap.releasePointerCapture(e.pointerId); } catch (_) {}
  panDrag = null;
  applyViewTransform(); // drop grabbing cursor
}

// ---- two-finger pinch (touch) — unifies zoom + pan in one gesture ----
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function twoPointers() {
  const it = activePointers.values();
  return [it.next().value, it.next().value];
}
// Abort any in-progress single-pointer gesture before a pinch takes over, so a
// half-finished layer move is committed (one undo step) and nothing dangles.
function abortCanvasGestures() {
  if (layerDrag) {
    const moved = layerDrag.moved;
    layerDrag = null;
    if (moved) commitGesture();
  }
  if (panDrag) panDrag = null;
}
function startPinch() {
  const [a, b] = twoPointers();
  const v = appState.ui.view;
  pinch = { distStart: dist(a, b) || 1, midStart: mid(a, b), scaleStart: v.scale, panStart: { x: v.panX, y: v.panY } };
}
function onPinchMove() {
  const [a, b] = twoPointers();
  if (!a || !b) return;
  const v = appState.ui.view;
  const C = stageCenter();
  const m = mid(a, b);
  const sNew = clamp(pinch.scaleStart * (dist(a, b) / pinch.distStart), 1, MAX_ZOOM);
  const kk = sNew / pinch.scaleStart;
  // Keep the content under the (moving) midpoint fixed → zoom + two-finger pan.
  v.panX = kk * pinch.panStart.x + ((m.x - C.x) - kk * (pinch.midStart.x - C.x));
  v.panY = kk * pinch.panStart.y + ((m.y - C.y) - kk * (pinch.midStart.y - C.y));
  v.scale = sNew;
  clampView();
  applyViewTransform();
}

function positionLightHandle() {
  const d = view(); // follow the animated light position during playback/scrub
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
  if (showLayer) {
    // Display the DISPLAYED (interpolated) layer so the inspector reflects the
    // animated state; edits still resolve the base layer via primaryLayer().
    const vl = view().layers.find((l) => l.id === layer.id) || layer;
    updateLayerControls(vl, count);
  } else updateSceneControls();
}

function updateSceneControls() {
  const d = doc();
  const L = view().light; // show animated light values; edits mutate doc().light
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
  // Scale = primary layer's current scale as a percentage; link state swaps rows.
  const t = layer.transform || {};
  const sx = t.scaleX == null ? 1 : t.scaleX;
  const sy = t.scaleY == null ? 1 : t.scaleY;
  const linked = appState.ui.scaleLinked;
  // Scale fields show the magnitude (always positive); the sign is the flip
  // state, surfaced on the Flip buttons below.
  setVal($('layer-scale'), round2(Math.abs(sx) * 100));
  setVal($('layer-scale-x'), round2(Math.abs(sx) * 100));
  setVal($('layer-scale-y'), round2(Math.abs(sy) * 100));
  $('row-scale').style.display = linked ? '' : 'none';
  $('row-scale-x').style.display = linked ? 'none' : '';
  $('row-scale-y').style.display = linked ? 'none' : '';
  const linkBtn = $('scale-link');
  linkBtn.setAttribute('aria-pressed', String(linked));
  linkBtn.textContent = linked ? '🔗 Linked' : '🔓 Independent';
  $('flip-h').setAttribute('aria-pressed', String(sx < 0));
  $('flip-v').setAttribute('aria-pressed', String(sy < 0));
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
  updateGradientEditor(layer);
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

// ---- gradient simple controls (presets / From→To / direction pad) ----
// Everything here just mutates layer.material.gradient — the single source of
// truth the Advanced editor and the derive() pipeline also read, so the two
// stay in sync automatically (a preset that adds a 3rd stop shows up in both).

// The layer's bbox in its own raw-path space — the space gradient geometry is
// stored in (derive() bakes the layer transform on top). Falls back to a unit
// box so presets still produce something on an empty/degenerate path.
function layerBox(layer) {
  if (layer && layer.pathData) {
    try { return P.bbox(P.parse(layer.pathData)); } catch (_) { /* fall through */ }
  }
  return { minX: 0, minY: 0, maxX: 100, maxY: 100, cx: 50, cy: 50, w: 100, h: 100 };
}
// 8 compass directions → unit vector pointing the way the gradient progresses
// (From → To). e.g. 's' = top→bottom, 'se' = top-left→bottom-right.
const DIR_VEC = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };
function applyLinearDir(g, dir, box) {
  const v = DIR_VEC[dir];
  if (!v) return;
  const hw = box.w / 2 || 50;
  const hh = box.h / 2 || 50;
  g.type = 'linear';
  g.x1 = box.cx - v[0] * hw; g.y1 = box.cy - v[1] * hh;
  g.x2 = box.cx + v[0] * hw; g.y2 = box.cy + v[1] * hh;
}
function applyRadial(g, box) {
  g.type = 'radial';
  g.cx = box.cx; g.cy = box.cy;
  g.r = 0.5 * Math.hypot(box.w, box.h) || 50; // half-diagonal covers the shape
}
// Which direction button to highlight: snap a linear gradient's vector to the
// nearest of the 8 compass points (best-effort for hand-tuned coordinates).
function currentDir(g) {
  const dx = g.x2 - g.x1;
  const dy = g.y2 - g.y1;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return null;
  const ang = Math.atan2(dy, dx);
  let best = null;
  let bestD = Infinity;
  for (const k in DIR_VEC) {
    const [vx, vy] = DIR_VEC[k];
    let d = Math.abs(((ang - Math.atan2(vy, vx) + Math.PI) % (2 * Math.PI)) - Math.PI);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}
// Shade a hex toward white / black in OKLab (perceptual, matches the emboss ramp).
function lighten(hex, k) { return toHex(mix(parseColor(hex) || parseColor('#3b82f6'), WHITE, k)); }
function darken(hex, k) { return toHex(mix(parseColor(hex) || parseColor('#3b82f6'), BLACK, k)); }
// A fresh gradient object seeded with sensible geometry for the layer's box.
function seedGradient(box) {
  return {
    type: 'linear',
    x1: box.minX, y1: box.cy, x2: box.maxX, y2: box.cy,
    cx: box.cx, cy: box.cy, r: 0.5 * Math.max(box.w, box.h) || 50,
    stops: [],
  };
}
// One-click "looks" — each builds a complete gradient from the layer's base
// colour and box. Returned object replaces material.gradient wholesale.
const GRAD_PRESETS = {
  toplight(base, box) {
    const g = seedGradient(box);
    applyLinearDir(g, 's', box); // light from the top
    g.stops = [{ offset: 0, color: lighten(base, 0.42), alpha: 1 }, { offset: 1, color: base, alpha: 1 }];
    return g;
  },
  glow(base, box) {
    const g = seedGradient(box);
    applyRadial(g, box);
    g.stops = [{ offset: 0, color: lighten(base, 0.55), alpha: 1 }, { offset: 1, color: base, alpha: 1 }];
    return g;
  },
  sheen(base, box) {
    const g = seedGradient(box);
    applyLinearDir(g, 'se', box);
    g.stops = [
      { offset: 0, color: lighten(base, 0.6), alpha: 1 },
      { offset: 0.5, color: base, alpha: 1 },
      { offset: 1, color: darken(base, 0.18), alpha: 1 },
    ];
    return g;
  },
  diagonal(base, box) {
    const g = seedGradient(box);
    applyLinearDir(g, 'se', box);
    g.stops = [{ offset: 0, color: base, alpha: 1 }, { offset: 1, color: lighten(base, 0.32), alpha: 1 }];
    return g;
  },
  fade(base, box) {
    const g = seedGradient(box);
    applyLinearDir(g, 's', box);
    g.stops = [{ offset: 0, color: base, alpha: 0.9 }, { offset: 1, color: base, alpha: 0 }];
    return g;
  },
};
// Reflect the current gradient into the simple controls (focus/popover-safe).
function updateGradientSimple(g) {
  const stops = g.stops;
  const first = stops[0] || { color: '#000000', alpha: 1 };
  const last = stops[stops.length - 1] || first;
  if (gradFromField) gradFromField.setValue((first.color || '#000000').slice(0, 7));
  if (gradToField) gradToField.setValue((last.color || '#000000').slice(0, 7));
  setChecked($('grad-fade'), (last.alpha == null ? 1 : last.alpha) < 1);
  const active = g.type === 'radial' ? 'radial' : currentDir(g);
  for (const btn of $('dir-pad').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.dir === active));
  }
}

// ---- gradient editor (derived: stop rows rebuilt only when the set changes) ----
let gradStops = []; // [{ field, off, al }] for the current stop rows
let gradStopsKey = null;
function updateGradientEditor(layer) {
  const isGrad = layer.material.fillMode === 'gradient';
  $('gradient-editor').hidden = !isGrad;
  const g = layer.material.gradient;
  if (!isGrad || !g) { gradStopsKey = null; return; }

  updateGradientSimple(g);
  setVal($('grad-type'), g.type);
  const lin = g.type !== 'radial';
  for (const el of document.querySelectorAll('.grad-lin')) el.style.display = lin ? '' : 'none';
  for (const el of document.querySelectorAll('.grad-rad')) el.style.display = lin ? 'none' : '';
  setVal($('grad-x1'), round2(g.x1)); setVal($('grad-y1'), round2(g.y1));
  setVal($('grad-x2'), round2(g.x2)); setVal($('grad-y2'), round2(g.y2));
  setVal($('grad-cx'), round2(g.cx)); setVal($('grad-cy'), round2(g.cy)); setVal($('grad-r'), round2(g.r));
  // CSS preview bar (always shown left→right regardless of type)
  $('grad-bar').style.background =
    'linear-gradient(to right,' + g.stops.map((s) => `${stopCss(s)} ${Math.round(s.offset * 100)}%`).join(',') + ')';

  // Rebuild stop rows only when the layer or stop count changes (so editing a
  // value doesn't destroy a focused input or an open color popover).
  const key = layer.id + '|' + g.stops.length;
  if (key !== gradStopsKey) {
    gradStopsKey = key;
    const cont = $('grad-stops');
    cont.innerHTML = '';
    gradStops = [];
    g.stops.forEach((stop, i) => {
      const row = document.createElement('div');
      row.className = 'row grad-stop';
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'swatch';
      const off = mkNum('grad-stop-off', 0, 1, 0.01);
      const al = mkNum('grad-stop-al', 0, 1, 0.05);
      const del = miniBtn('✕', 'Remove stop', (e) => {
        e.stopPropagation();
        if (g.stops.length <= 2) return toast('A gradient needs at least 2 stops.', 'warn');
        commit(() => withPrimary((l) => { if (l.material.gradient) l.material.gradient.stops.splice(i, 1); }));
      });
      row.append(sw, off, al, del);
      cont.appendChild(row);
      const field = createColorField(sw, {
        onInput: (hex) => { beginGesture(); withPrimary((l) => setStop(l, i, { color: hex })); recordKeyframe('layer', `material.gradient.stops.${i}.color`); scheduleRender(); },
        onCommit: commitGesture,
      });
      animLiveInput(off, 'layer', `material.gradient.stops.${i}.offset`, (el) => { const v = +el.value; if (isFinite(v)) withPrimary((l) => setStop(l, i, { offset: clamp(v, 0, 1) })); });
      animLiveInput(al, 'layer', `material.gradient.stops.${i}.alpha`, (el) => { const v = +el.value; if (isFinite(v)) withPrimary((l) => setStop(l, i, { alpha: clamp(v, 0, 1) })); });
      gradStops.push({ field, off, al });
    });
  }
  // Update row values (focus-safe).
  g.stops.forEach((stop, i) => {
    const r = gradStops[i];
    if (!r) return;
    r.field.setValue((stop.color || '#000000').slice(0, 7));
    setVal(r.off, round2(stop.offset));
    setVal(r.al, round2(stop.alpha == null ? 1 : stop.alpha));
  });
}
function setStop(layer, i, patch) {
  const g = layer.material.gradient;
  if (g && g.stops[i]) Object.assign(g.stops[i], patch);
}
function stopCss(s) {
  const a = s.alpha == null ? 1 : s.alpha;
  const c = (s.color || '#000000').slice(1);
  const r = parseInt(c.slice(0, 2), 16) || 0, gg = parseInt(c.slice(2, 4), 16) || 0, b = parseInt(c.slice(4, 6), 16) || 0;
  return `rgba(${r},${gg},${b},${a})`;
}
function mkNum(cls, min, max, step) {
  const el = document.createElement('input');
  el.type = 'number';
  el.className = 'num ' + cls;
  el.min = min;
  el.max = max;
  el.step = step;
  return el;
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

// ---- keyframe recording (auto-key; ANIMATION.md §9.3, decision D/D1) ----
// Clamp a time to the timeline's [0, duration].
function clampTime(t) {
  const tl = doc().timeline;
  const dur = tl && isFinite(+tl.duration) ? +tl.duration : 0;
  return clamp(t || 0, 0, dur);
}
// Find an existing track for (scope, layer, prop). Scene tracks have no layerId.
function findTrack(scope, layerId, prop) {
  const tl = doc().timeline;
  if (!tl) return null;
  return tl.tracks.find((tr) => tr.scope === scope && tr.prop === prop && (scope === 'scene' || tr.layerId === layerId)) || null;
}
// Insert/replace a keyframe at time t (replace if one sits at ~t, else insert
// sorted). New keys default to linear easing.
function upsertKey(track, t, value) {
  const i = track.keys.findIndex((k) => Math.abs(k.t - t) < 1e-4);
  if (i >= 0) track.keys[i].value = value;
  else {
    track.keys.push({ t, value, easing: 'linear' });
    track.keys.sort((a, b) => a.t - b.t);
  }
}
// Drop a keyframe = `value` for (scope, layerId, prop) at the playhead — but only
// if the timeline is enabled AND (REC is on OR a track already exists). Otherwise
// the edit just changed the static base value, exactly as before. The keyframe
// mutates doc().timeline, part of the gesture snapshot, so it's one undo step.
function recordKeyframeFor(scope, layerId, prop, value, force) {
  const tl = doc().timeline;
  if (!tl || !tl.enabled) return; // animation off → plain static edit
  if (scope === 'layer' && !layerId) return;
  let track = findTrack(scope, layerId, prop);
  if (!track && !force && !pb().autokey) return; // not forced/recording and no track → skip
  const type = propType(scope, prop);
  if (!type) return;
  if (value == null) return;
  const v = type === 'color' ? String(value).slice(0, 7) : +value;
  if (type !== 'color' && !isFinite(v)) return;
  if (!track) {
    track = { id: newId('trk'), scope, layerId, prop, type, keys: [] };
    tl.tracks.push(track);
  }
  upsertKey(track, clampTime(pb().time), v);
}
// Read a layer's current value for an animatable prop, defaulting transform
// fields to identity when the layer has no transform yet — so position/scale can
// be keyed on a layer that was never moved (transform: null). Returns undefined
// for genuinely absent props (e.g. a gradient stop on a non-gradient layer),
// which callers skip.
const TRANSFORM_DEFAULTS = { 'transform.translateX': 0, 'transform.translateY': 0, 'transform.rotation': 0, 'transform.scaleX': 1, 'transform.scaleY': 1 };
function layerPropValue(layer, prop) {
  const v = getAtPath(layer, prop);
  if (v == null && prop in TRANSFORM_DEFAULTS) return TRANSFORM_DEFAULTS[prop];
  return v;
}
// Record the current value of `prop` as a keyframe. Scene props key the scene;
// layer props key EVERY selected layer (matching withSelected edits), so a
// multi-selection animates together — EXCEPT gradient stops, which are edited on
// the primary layer only (per-layer geometry), so they key the primary only.
function recordKeyframe(scope, prop) {
  if (scope === 'scene') {
    recordKeyframeFor('scene', null, prop, getAtPath(doc(), prop));
    return;
  }
  const isStop = /^material\.gradient\.stops\./.test(prop);
  const layers = isStop ? [primaryLayer()].filter(Boolean) : selectedLayers();
  for (const l of layers) recordKeyframeFor('layer', l.id, prop, layerPropValue(l, prop));
}
// liveInput + auto-key: runs the base mutation, then records a keyframe for the
// given (scope, prop) per the rule above. `prop` may be an array (e.g. linked
// scale touches both axes). Use for animatable controls.
function animLiveInput(el, scope, prop, mutate) {
  const props = Array.isArray(prop) ? prop : [prop];
  el.addEventListener('input', () => {
    beginGesture();
    mutate(el);
    for (const p of props) recordKeyframe(scope, p);
    scheduleRender();
  });
  el.addEventListener('change', commitGesture);
}

function wireControls() {
  // Scene · light
  liveInput($('light-type'), (el) => { doc().light.type = el.value; });
  animLiveInput($('light-x'), 'scene', 'light.position.x', (el) => { const v = +el.value; if (isFinite(v)) doc().light.position.x = clamp(v, 0, doc().canvas.viewportWidth); });
  animLiveInput($('light-y'), 'scene', 'light.position.y', (el) => { const v = +el.value; if (isFinite(v)) doc().light.position.y = clamp(v, 0, doc().canvas.viewportHeight); });
  animLiveInput($('light-azimuth'), 'scene', 'light.azimuth', (el) => { doc().light.azimuth = +el.value; });
  animLiveInput($('light-elevation'), 'scene', 'light.elevation', (el) => { doc().light.elevation = +el.value; });
  animLiveInput($('light-intensity'), 'scene', 'light.intensity', (el) => { doc().light.intensity = +el.value; });

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
    onInput: (hex) => { beginGesture(); withSelected((l) => (l.material.baseColor = hex)); recordKeyframe('layer', 'material.baseColor'); scheduleRender(); },
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
  animLiveInput($('layer-x'), 'layer', 'transform.translateX', (el) => {
    const p = primaryLayer();
    if (!p || !p.pathData) return;
    const v = +el.value;
    if (!isFinite(v)) return;
    const dx = v - layerTopLeft(viewLayerOf(p.id) || p).x; // delta from the DISPLAYED top-left
    withSelected((l) => {
      const vl = viewLayerOf(l.id) || l;
      ensureTransform(l).translateX = ((vl.transform && +vl.transform.translateX) || 0) + dx;
    });
  });
  animLiveInput($('layer-y'), 'layer', 'transform.translateY', (el) => {
    const p = primaryLayer();
    if (!p || !p.pathData) return;
    const v = +el.value;
    if (!isFinite(v)) return;
    const dy = v - layerTopLeft(viewLayerOf(p.id) || p).y;
    withSelected((l) => {
      const vl = viewLayerOf(l.id) || l;
      ensureTransform(l).translateY = ((vl.transform && +vl.transform.translateY) || 0) + dy;
    });
  });

  // Layer · scale — percentage (100 = original), scaling each selected layer in
  // place about its own center. Guard against non-finite/<=0 so the affine
  // matrix in derive() is never poisoned. Linked = one field drives both axes.
  animLiveInput($('layer-scale'), 'layer', ['transform.scaleX', 'transform.scaleY'], (el) => {
    const v = +el.value;
    if (!isFinite(v) || v <= 0) return;
    scaleSelection(v / 100, v / 100);
  });
  animLiveInput($('layer-scale-x'), 'layer', 'transform.scaleX', (el) => {
    const v = +el.value;
    if (!isFinite(v) || v <= 0) return;
    scaleSelection(v / 100, null);
  });
  animLiveInput($('layer-scale-y'), 'layer', 'transform.scaleY', (el) => {
    const v = +el.value;
    if (!isFinite(v) || v <= 0) return;
    scaleSelection(null, v / 100);
  });
  // Link toggle is a session preference (not part of the document): just swaps
  // which scale rows are visible.
  $('scale-link').addEventListener('click', () => {
    appState.ui.scaleLinked = !appState.ui.scaleLinked;
    updateInspector();
  });
  // Flip the selection (mirror) — one undo entry per click.
  $('flip-h').addEventListener('click', () => { if (selectedLayers().length) commit(() => flipSelection('x')); });
  $('flip-v').addEventListener('click', () => { if (selectedLayers().length) commit(() => flipSelection('y')); });

  // Layer · material
  liveInput($('layer-name'), (el) => { withPrimary((l) => (l.name = el.value)); });
  animLiveInput($('mat-alpha'), 'layer', 'material.fillAlpha', (el) => { withSelected((l) => (l.material.fillAlpha = +el.value)); });
  for (const r of document.querySelectorAll('input[name="fillmode"]')) {
    r.addEventListener('change', () => commit(() => withSelected((l) => {
      l.material.fillMode = r.value;
      // Switching to Gradient with no gradient yet → seed one spanning the shape.
      if (r.value === 'gradient' && !l.material.gradient) {
        l.material.gradient = defaultGradient(l.material.baseColor, l.pathData ? P.bbox(P.parse(l.pathData)) : null);
      }
    })));
  }
  animLiveInput($('mat-emboss'), 'layer', 'material.embossIntensity', (el) => { withSelected((l) => (l.material.embossIntensity = +el.value)); });
  liveInput($('mat-sheen-on'), (el) => { withSelected((l) => (l.material.sheen.enabled = el.checked)); });
  animLiveInput($('mat-sheen'), 'layer', 'material.sheen.strength', (el) => { withSelected((l) => (l.material.sheen.strength = +el.value)); });
  liveInput($('mat-fillrule'), (el) => { withSelected((l) => (l.fillRule = el.value)); });

  // Gradient editor. The SIMPLE controls are bulk edits across every selected
  // gradient layer (withSelectedGradients); the ADVANCED controls (exact stops
  // and coordinates, which differ per layer) edit the primary layer only.
  // --- simple controls ---
  // Quick-look presets: rebuild each selected gradient from ITS base + box.
  for (const btn of document.querySelectorAll('.grad-presets [data-preset]')) {
    btn.addEventListener('click', () => {
      const build = GRAD_PRESETS[btn.dataset.preset];
      if (!build) return;
      commit(() => withSelectedGradients((l) => {
        const base = (l.material.baseColor || '#3b82f6').slice(0, 7);
        l.material.gradient = build(base, layerBox(l));
      }));
    });
  }
  // From / To colour swatches map to the first / last stop.
  gradFromField = createColorField($('grad-from'), {
    onInput: (hex) => { beginGesture(); withSelectedGradients((l, g) => { if (g.stops[0]) g.stops[0].color = hex; }); scheduleRender(); },
    onCommit: commitGesture,
  });
  gradToField = createColorField($('grad-to'), {
    onInput: (hex) => { beginGesture(); withSelectedGradients((l, g) => { if (g.stops.length) g.stops[g.stops.length - 1].color = hex; }); scheduleRender(); },
    onCommit: commitGesture,
  });
  // Fade: toggle the end stop's alpha between fully opaque and fully transparent.
  liveInput($('grad-fade'), (el) => { withSelectedGradients((l, g) => { if (g.stops.length) g.stops[g.stops.length - 1].alpha = el.checked ? 0 : 1; }); });
  // Direction pad: 8 arrows set a linear direction; the centre dot makes it radial.
  for (const btn of $('dir-pad').querySelectorAll('button')) {
    btn.addEventListener('click', () => commit(() => withSelectedGradients((l, g) => {
      if (btn.dataset.dir === 'radial') applyRadial(g, layerBox(l));
      else applyLinearDir(g, btn.dataset.dir, layerBox(l));
    })));
  }
  // --- advanced controls ---
  liveInput($('grad-type'), (el) => { withPrimary((l) => { if (l.material.gradient) l.material.gradient.type = el.value === 'radial' ? 'radial' : 'linear'; }); });
  $('grad-add').addEventListener('click', () => commit(() => withPrimary((l) => {
    const g = l.material.gradient;
    if (!g) return;
    const last = g.stops[g.stops.length - 1];
    g.stops.push({ offset: 1, color: last ? last.color : '#ffffff', alpha: last ? (last.alpha == null ? 1 : last.alpha) : 1 });
  })));
  for (const [id, key] of [['grad-x1', 'x1'], ['grad-y1', 'y1'], ['grad-x2', 'x2'], ['grad-y2', 'y2'], ['grad-cx', 'cx'], ['grad-cy', 'cy'], ['grad-r', 'r']]) {
    liveInput($(id), (el) => { const v = +el.value; if (isFinite(v)) withPrimary((l) => { if (l.material.gradient) l.material.gradient[key] = v; }); });
  }

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
// Apply a gradient edit to EVERY selected layer that uses a gradient fill (the
// simple gradient controls are bulk edits, like base colour / opacity / emboss
// — so selecting all layers and clicking a preset changes them all). fn gets
// (layer, gradient). Skips selected layers that aren't gradient layers.
function withSelectedGradients(fn) {
  for (const l of selectedLayers()) {
    if (l.material.fillMode === 'gradient' && l.material.gradient) fn(l, l.material.gradient);
  }
}

// ---- layer position (move) ----
// The move offset lives in layer.transform.translateX/Y — already baked by
// derive() and bakedOutline(), and already persisted. These helpers are the
// single source of truth shared by the drag gesture and the X/Y fields.
function ensureTransform(layer) {
  if (!layer.transform) layer.transform = { translateX: 0, translateY: 0 };
  if (!isFinite(+layer.transform.translateX)) layer.transform.translateX = 0;
  if (!isFinite(+layer.transform.translateY)) layer.transform.translateY = 0;
  if (!isFinite(+layer.transform.scaleX)) layer.transform.scaleX = 1;
  if (!isFinite(+layer.transform.scaleY)) layer.transform.scaleY = 1;
  return layer.transform;
}
// Set a layer's translate to an ABSOLUTE (tx, ty) in viewport units, then record
// it as a keyframe when its position is animated (or REC is armed) so the
// DISPLAYED position follows. Sets the base value too, so the static case (and a
// later timeline-disabled view) is correct. Use for canvas drag / X-Y fields.
function setLayerTranslate(layer, tx, ty) {
  const t = ensureTransform(layer);
  t.translateX = tx;
  t.translateY = ty;
  recordKeyframeFor('layer', layer.id, 'transform.translateX', tx);
  recordKeyframeFor('layer', layer.id, 'transform.translateY', ty);
}
// Scale every selected layer about the selection's shared "home" center, so a
// multi-layer shape (e.g. a pen made of several paths) scales as one group and
// keeps its parts aligned. Each layer's pivot is set to that common viewport
// point expressed in the layer's own raw-path space (C − translate), and the
// scale is applied; translate is left untouched. With a single layer selected
// the center is its own, so it scales in place — identical to before.
//
// `home` bbox = raw bbox shifted by the current translate (independent of the
// current scale, since pivot keeps the displayed centre at raw-centre +
// translate). Computing C from that keeps absolute scaling stable across edits.
// Pass null for an axis to leave it untouched (independent X/Y when unlinked).
// Apply `fn(transform)` to every selected layer with each layer's pivot set to
// the selection's shared "home" center, so scale and flip act on the whole
// selection as one unit (multi-part shapes keep their parts aligned). The home
// center = union of raw-bbox + translate, independent of the current scale/sign
// so it's a stable axis across repeated edits. With one layer selected it's the
// layer's own center, so it transforms in place — identical to before.
function transformSelectionAboutCenter(fn) {
  const sel = selectedLayers().filter((l) => l.pathData);
  if (!sel.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of sel) {
    const b = P.bbox(P.parse(l.pathData));
    const tx = (l.transform && +l.transform.translateX) || 0;
    const ty = (l.transform && +l.transform.translateY) || 0;
    minX = Math.min(minX, b.minX + tx);
    minY = Math.min(minY, b.minY + ty);
    maxX = Math.max(maxX, b.maxX + tx);
    maxY = Math.max(maxY, b.maxY + ty);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (const l of sel) {
    const t = ensureTransform(l);
    t.pivotX = cx - (t.translateX || 0);
    t.pivotY = cy - (t.translateY || 0);
    fn(t, l);
  }
}
// Set the scale magnitude while preserving the flip sign, so changing the
// percentage never un-flips a layer.
function scaleSelection(sx, sy) {
  transformSelectionAboutCenter((t) => {
    if (sx != null) t.scaleX = Math.abs(sx) * (t.scaleX < 0 ? -1 : 1);
    if (sy != null) t.scaleY = Math.abs(sy) * (t.scaleY < 0 ? -1 : 1);
  });
}
// Mirror the selection about its shared center: 'x' = horizontal (negate
// scaleX), 'y' = vertical (negate scaleY). Multi-select flips as a group.
function flipSelection(axis) {
  transformSelectionAboutCenter((t) => {
    if (axis === 'x') t.scaleX = -t.scaleX;
    else t.scaleY = -t.scaleY;
  });
}
// Current top-left of the layer's baked bbox, in viewport (canvas) coordinates.
function layerTopLeft(layer) {
  if (!layer || !layer.pathData) return { x: 0, y: 0 };
  const b = P.bbox(P.parse(bakedOutline(layer)));
  return { x: b.minX, y: b.minY };
}

// ---- timeline dock (raster-only animation; ANIMATION.md §9.4) ----
// Friendly labels for track rows / the add-track menu.
const PROP_LABELS = {
  'light.azimuth': 'Light azimuth',
  'light.elevation': 'Light elevation',
  'light.intensity': 'Light intensity',
  'light.position.x': 'Light X',
  'light.position.y': 'Light Y',
  'material.fillAlpha': 'Opacity',
  'material.baseColor': 'Base color',
  'material.embossIntensity': 'Emboss',
  'material.sheen.strength': 'Sheen',
  'transform.translateX': 'Position X',
  'transform.translateY': 'Position Y',
  'transform.scaleX': 'Scale X',
  'transform.scaleY': 'Scale Y',
};
function propLabel(prop) {
  if (PROP_LABELS[prop]) return PROP_LABELS[prop];
  const m = /^material\.gradient\.stops\.(\d+)\.(offset|color|alpha)$/.exec(prop);
  if (m) return `Stop ${+m[1] + 1} ${m[2]}`;
  return prop;
}
function trackLabel(track) {
  if (track.scope === 'scene') return propLabel(track.prop);
  const l = doc().layers.find((x) => x.id === track.layerId);
  return (l ? l.name : '(missing layer)') + ' · ' + propLabel(track.prop);
}

// Props offerable in the "＋ Light" menu (scene light). Only props that ALSO have
// an inspector control are listed, so every track can get further keyframes by
// editing that control at a new playhead.
// The "＋ Light" menu animates the scene light only — layer properties are keyed
// via "◆ Key layer" (which handles multi-property, multi-layer selection).
const SCENE_TARGETS = ['light.azimuth', 'light.elevation', 'light.intensity', 'light.position.x', 'light.position.y'];

function enableTimeline() { commit(() => { doc().timeline.enabled = true; }); }
function disableTimeline() {
  // Non-destructive: keeps the keyframes, just stops driving the document.
  stopPlaybackLoop();
  commit(() => { doc().timeline.enabled = false; });
}
function removeTrack(id) {
  if (pb().selKey && pb().selKey.trackId === id) pb().selKey = null;
  commit(() => { const tl = doc().timeline; tl.tracks = tl.tracks.filter((t) => t.id !== id); });
}
// Create a track seeded with one keyframe at the playhead from the live value.
function addTrackFor(scope, prop) {
  const layerId = scope === 'layer' ? (primaryLayer() && primaryLayer().id) : null;
  if (scope === 'layer' && !layerId) return toast('Select a layer first.', 'warn');
  if (findTrack(scope, layerId, prop)) return toast('Already animated — edit it at the playhead.');
  const type = propType(scope, prop);
  const raw = getAtPath(scope === 'scene' ? doc() : primaryLayer(), prop);
  if (raw == null) return;
  const value = type === 'color' ? String(raw).slice(0, 7) : +raw;
  commit(() => {
    const tl = doc().timeline;
    tl.enabled = true;
    tl.tracks.push({ id: newId('trk'), scope, layerId, prop, type, keys: [{ t: clampTime(pb().time), value, easing: 'linear' }] });
  });
  toast(`Added "${propLabel(prop)}" track.`);
}
// The animatable props relevant to a layer's CURRENT look (skips emboss/sheen
// unless embossed, gradient stops unless a gradient) — used by "Key layer".
function relevantLayerProps(layer) {
  const props = ['material.fillAlpha', 'material.baseColor', 'transform.translateX', 'transform.translateY', 'transform.scaleX', 'transform.scaleY'];
  if (layer.material.fillMode === 'embossed') props.push('material.embossIntensity', 'material.sheen.strength');
  if (layer.material.fillMode === 'gradient' && layer.material.gradient) {
    layer.material.gradient.stops.forEach((_, i) => {
      props.push(`material.gradient.stops.${i}.offset`, `material.gradient.stops.${i}.color`, `material.gradient.stops.${i}.alpha`);
    });
  }
  return props;
}
// "Key layer": snapshot the selected layer(s)' CURRENT displayed state into
// keyframes at the playhead (creating tracks as needed), so you can move the
// playhead and change things from there. `props` limits which properties are
// keyed (from the Key-layer menu); omitted → every relevant property per layer.
// Applies to EVERY selected layer; a prop absent on a layer (e.g. a gradient
// stop on a solid layer) is skipped for that layer.
function keyLayers(props) {
  const sel = selectedLayers();
  if (!sel.length) return toast('Select a layer first.', 'warn');
  commit(() => {
    doc().timeline.enabled = true;
    for (const l of sel) {
      const vl = viewLayerOf(l.id) || l; // displayed values (interpolated when animating)
      for (const prop of props || relevantLayerProps(l)) {
        const raw = layerPropValue(vl, prop);
        if (raw == null) continue;
        recordKeyframeFor('layer', l.id, prop, raw, true);
      }
    }
  });
  const n = sel.length;
  toast(`Keyed ${n} layer${n === 1 ? '' : 's'} at ${clampTime(pb().time).toFixed(2)}s.`);
}
// Build the Key-layer checkbox menu from the primary layer's relevant props
// (all checked by default), applied to the whole selection on "Key selected".
function buildKeyLayerMenu() {
  const menu = $('tl-key-menu');
  menu.innerHTML = '';
  const p = primaryLayer();
  if (!p) {
    const d = document.createElement('div');
    d.className = 'tl-empty';
    d.textContent = 'Select a layer first.';
    menu.appendChild(d);
    return;
  }
  const head = document.createElement('div');
  head.className = 'tl-key-head';
  head.textContent = 'Key these properties at the playhead:';
  menu.appendChild(head);
  for (const prop of relevantLayerProps(p)) {
    const label = document.createElement('label');
    label.className = 'tl-key-opt';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.prop = prop;
    const span = document.createElement('span');
    span.textContent = propLabel(prop);
    label.append(cb, span);
    menu.appendChild(label);
  }
  const apply = document.createElement('button');
  apply.className = 'tl-key-apply';
  apply.textContent = 'Key selected properties';
  apply.addEventListener('click', () => {
    const props = Array.from(menu.querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.dataset.prop);
    menu.hidden = true;
    if (!props.length) return toast('No properties selected.', 'warn');
    keyLayers(props);
  });
  menu.appendChild(apply);
}

// ---- playback loop (real-clock delta; performance.now is fine in the app) ----
let playRaf = null;
let playLastTs = 0;
function startPlayback() {
  if (pb().playing) return;
  if (!isAnimating(doc())) return toast('Add a keyframe first.', 'warn');
  const tl = doc().timeline;
  if (clampTime(pb().time) >= tl.duration) pb().time = 0; // at the end → replay from 0
  pb().playing = true;
  playLastTs = performance.now();
  const tick = (ts) => {
    if (!pb().playing) { playRaf = null; return; }
    const dur = doc().timeline.duration;
    const dt = (ts - playLastTs) / 1000;
    playLastTs = ts;
    let t = pb().time + dt * (pb().speed || 1); // preview speed (export uses real duration/fps)
    if (t >= dur) {
      if (doc().timeline.loop) t = dur > 0 ? t % dur : 0;
      else { t = dur; pb().playing = false; }
    }
    pb().time = t;
    scheduleRender();
    playRaf = pb().playing ? requestAnimationFrame(tick) : null;
    if (!pb().playing) updateTransport();
  };
  playRaf = requestAnimationFrame(tick);
  updateTransport();
}
function stopPlaybackLoop() {
  pb().playing = false;
  if (playRaf) { cancelAnimationFrame(playRaf); playRaf = null; }
}
function togglePlay() {
  if (pb().playing) { stopPlaybackLoop(); updateTransport(); }
  else startPlayback();
}
function stopToStart() {
  stopPlaybackLoop();
  pb().time = 0;
  updateTransport();
  scheduleRender();
}
function gotoEnd() {
  stopPlaybackLoop();
  pb().time = doc().timeline.duration;
  updateTransport();
  scheduleRender();
}

// ---- scrubbing (ruler) ----
function timeFromClientX(clientX) {
  const r = $('tl-ruler').getBoundingClientRect();
  const f = r.width > 0 ? (clientX - r.left) / r.width : 0;
  return clampTime(f * doc().timeline.duration);
}
function onRulerDown(e) {
  stopPlaybackLoop();
  pb().scrubbing = true;
  try { $('tl-ruler').setPointerCapture(e.pointerId); } catch (_) {}
  pb().time = timeFromClientX(e.clientX);
  updateTransport(); positionPlayhead(); scheduleRender();
  e.preventDefault();
}
function onRulerMove(e) {
  if (!pb().scrubbing) return;
  pb().time = timeFromClientX(e.clientX);
  updateTransport(); positionPlayhead(); scheduleRender();
}
function onRulerUp(e) {
  if (!pb().scrubbing) return;
  pb().scrubbing = false;
  try { $('tl-ruler').releasePointerCapture(e.pointerId); } catch (_) {}
}

// ---- keyframe drag / select / delete (event-delegated on #tl-tracks) ----
let keyDrag = null;
function onTracksPointerDown(e) {
  const dot = e.target.closest('.tl-key');
  if (!dot) return;
  const trackId = dot.dataset.trackId;
  const ki = +dot.dataset.keyIndex;
  pb().selKey = { trackId, ki };
  updateEasingControl();
  markSelectedKey();
  keyDrag = { trackId, ki, lane: dot.parentElement, moved: false };
  try { dot.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
  e.stopPropagation();
}
function onTracksPointerMove(e) {
  if (!keyDrag) return;
  const track = doc().timeline.tracks.find((x) => x.id === keyDrag.trackId);
  if (!track || !track.keys[keyDrag.ki]) return;
  const r = keyDrag.lane.getBoundingClientRect();
  const f = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
  const t = clampTime(f * doc().timeline.duration);
  if (!keyDrag.moved) { beginGesture(); keyDrag.moved = true; } // snapshot only once a real drag starts
  const key = track.keys[keyDrag.ki];
  key.t = t;
  track.keys.sort((a, b) => a.t - b.t);
  keyDrag.ki = track.keys.indexOf(key); // identity survives the re-sort
  pb().selKey = { trackId: keyDrag.trackId, ki: keyDrag.ki };
  pb().time = t; // drag the playhead with the key for feedback
  lastTracksKey = null; // positions changed → force lane rebuild
  scheduleRender();
}
function onTracksPointerUp() {
  if (!keyDrag) return;
  const moved = keyDrag.moved;
  keyDrag = null;
  if (moved) commitGesture();
}
function onTracksDblClick(e) {
  const dot = e.target.closest('.tl-key');
  if (!dot) return;
  const trackId = dot.dataset.trackId;
  const ki = +dot.dataset.keyIndex;
  pb().selKey = null;
  commit(() => {
    const tl = doc().timeline;
    const track = tl.tracks.find((x) => x.id === trackId);
    if (!track) return;
    track.keys.splice(ki, 1);
    if (!track.keys.length) tl.tracks = tl.tracks.filter((x) => x.id !== trackId); // last key → drop the track
  });
}

// ---- render the timeline (derived view; ANIMATION.md §9.4) ----
function renderTimeline() {
  const sec = $('timeline');
  if (!sec) return;
  const tl = doc().timeline;
  const enabled = !!(tl && tl.enabled);
  sec.classList.toggle('on', enabled);
  $('tl-enable').hidden = enabled;
  $('tl-transport').hidden = !enabled;
  $('tl-body').hidden = !enabled;
  if (!enabled) return;
  updateTransport();
  renderTracks();
  positionPlayhead();
  updateEasingControl();
  markSelectedKey();
}
function updateTransport() {
  const tl = doc().timeline;
  const p = pb();
  setVal($('tl-duration'), tl.duration);
  setVal($('tl-fps'), tl.fps);
  setChecked($('tl-loop'), tl.loop);
  setVal($('tl-speed'), String(p.speed || 1));
  $('tl-rec').setAttribute('aria-pressed', String(p.autokey));
  $('tl-rec').classList.toggle('armed', p.autokey);
  $('tl-play').textContent = p.playing ? '⏸' : '▶';
  $('tl-time').textContent = clampTime(p.time).toFixed(2) + ' / ' + (+tl.duration).toFixed(2) + 's';
  $('tl-key-layer').disabled = !primaryLayer(); // needs a selected layer to key
}
let lastTracksKey = null;
function renderTracks() {
  const tl = doc().timeline;
  const cont = $('tl-tracks');
  // Rebuild only when track structure / key positions change (not every scrub
  // frame), so a focused easing select / drag isn't destroyed mid-gesture.
  const key = tl.duration + '#' + tl.tracks.map((t) =>
    t.id + ':' + (t.scope === 'layer' ? t.layerId : '') + ':' + t.keys.map((k) => k.t.toFixed(3) + k.easing).join(',')
  ).join('|');
  if (key === lastTracksKey) return;
  lastTracksKey = key;
  cont.innerHTML = '';
  if (!tl.tracks.length) {
    const empty = document.createElement('div');
    empty.className = 'tl-empty';
    empty.textContent = 'No keyframes yet — arm ● REC and change a control, use ◆ Key layer, or ＋ Light.';
    cont.appendChild(empty);
    return;
  }
  for (const track of tl.tracks) {
    const row = document.createElement('div');
    row.className = 'tl-track';
    const label = document.createElement('div');
    label.className = 'tl-label';
    label.textContent = trackLabel(track);
    label.title = label.textContent;
    const lane = document.createElement('div');
    lane.className = 'tl-lane';
    lane.dataset.trackId = track.id;
    track.keys.forEach((k, ki) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'tl-key';
      dot.style.left = (k.t / (tl.duration || 1)) * 100 + '%';
      dot.title = `t=${k.t.toFixed(2)}s · ${k.easing} (drag to move · double-click to delete)`;
      dot.dataset.trackId = track.id;
      dot.dataset.keyIndex = String(ki);
      lane.appendChild(dot);
    });
    const del = miniBtn('✕', 'Remove track', (e) => { e.stopPropagation(); removeTrack(track.id); });
    row.append(label, lane, del);
    cont.appendChild(row);
  }
}
function positionPlayhead() {
  const tl = doc().timeline;
  const ph = $('tl-playhead');
  if (ph) ph.style.left = (clampTime(pb().time) / (tl.duration || 1)) * 100 + '%';
}
function markSelectedKey() {
  const cont = $('tl-tracks');
  for (const d of cont.querySelectorAll('.tl-key.sel')) d.classList.remove('sel');
  const sel = pb().selKey;
  if (!sel) return;
  const dot = cont.querySelector(`.tl-key[data-track-id="${CSS.escape(sel.trackId)}"][data-key-index="${sel.ki}"]`);
  if (dot) dot.classList.add('sel');
}
function updateEasingControl() {
  const wrap = $('tl-ease-wrap');
  const sel = pb().selKey;
  const track = sel && doc().timeline.tracks.find((x) => x.id === sel.trackId);
  const k = track && track.keys[sel.ki];
  if (!k) { wrap.hidden = true; if (sel) pb().selKey = null; return; }
  wrap.hidden = false;
  setVal($('tl-ease'), k.easing);
}

function wireTimeline() {
  $('tl-enable').addEventListener('click', enableTimeline);
  $('tl-disable').addEventListener('click', disableTimeline);
  $('tl-play').addEventListener('click', togglePlay);
  $('tl-stop').addEventListener('click', stopToStart);
  $('tl-end').addEventListener('click', gotoEnd);
  $('tl-rec').addEventListener('click', () => { pb().autokey = !pb().autokey; updateTransport(); });
  $('tl-key-layer').addEventListener('click', (e) => {
    e.stopPropagation();
    buildKeyLayerMenu();
    const m = $('tl-key-menu');
    m.hidden = !m.hidden;
  });
  $('tl-key-menu').addEventListener('click', (e) => e.stopPropagation());
  $('tl-duration').addEventListener('change', () => {
    const v = +$('tl-duration').value;
    if (!isFinite(v)) return;
    commit(() => {
      const tl = doc().timeline;
      tl.duration = Math.min(600, Math.max(0.1, v));
      for (const tr of tl.tracks) for (const k of tr.keys) k.t = Math.min(tl.duration, k.t);
    });
    pb().time = clampTime(pb().time);
  });
  $('tl-fps').addEventListener('change', () => {
    const v = +$('tl-fps').value;
    if (isFinite(v)) commit(() => { doc().timeline.fps = Math.round(Math.min(120, Math.max(1, v))); });
  });
  $('tl-loop').addEventListener('change', () => commit(() => { doc().timeline.loop = $('tl-loop').checked; }));
  // Playback speed is preview-only (ephemeral) — it never changes the exported
  // duration/fps, just how fast the preview plays.
  $('tl-speed').addEventListener('change', () => { const v = +$('tl-speed').value; pb().speed = isFinite(v) && v > 0 ? v : 1; });

  // ＋ Light dropdown (scene-light tracks; layers go through ◆ Key layer).
  $('tl-add').addEventListener('click', (e) => {
    e.stopPropagation();
    buildAddTrackMenu();
    const m = $('tl-add-menu');
    m.hidden = !m.hidden;
  });
  $('tl-add-menu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { $('tl-add-menu').hidden = true; $('tl-key-menu').hidden = true; });

  const ruler = $('tl-ruler');
  ruler.addEventListener('pointerdown', onRulerDown);
  ruler.addEventListener('pointermove', onRulerMove);
  ruler.addEventListener('pointerup', onRulerUp);
  ruler.addEventListener('pointercancel', onRulerUp);

  const tracks = $('tl-tracks');
  tracks.addEventListener('pointerdown', onTracksPointerDown);
  tracks.addEventListener('pointermove', onTracksPointerMove);
  tracks.addEventListener('pointerup', onTracksPointerUp);
  tracks.addEventListener('pointercancel', onTracksPointerUp);
  tracks.addEventListener('dblclick', onTracksDblClick);

  $('tl-ease').addEventListener('change', () => {
    const sel = pb().selKey;
    if (!sel) return;
    commit(() => {
      const track = doc().timeline.tracks.find((x) => x.id === sel.trackId);
      if (track && track.keys[sel.ki]) track.keys[sel.ki].easing = $('tl-ease').value;
    });
  });
}
function buildAddTrackMenu() {
  const menu = $('tl-add-menu');
  menu.innerHTML = '';
  for (const prop of SCENE_TARGETS) {
    const b = document.createElement('button');
    const exists = findTrack('scene', null, prop);
    b.textContent = propLabel(prop) + (exists ? '  ✓' : '');
    b.addEventListener('click', () => { menu.hidden = true; addTrackFor('scene', prop); });
    menu.appendChild(b);
  }
}

// ---- top bar: file + export ----
function wireToolbar() {
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);

  // Privacy link opens the policy in a new tab; record the click as an
  // anonymous TelemetryDeck signal via our own sender (the Web SDK exposes no
  // global, so the previous window.td call was a no-op).
  $('privacy-link').addEventListener('click', () => {
    tdSignal('privacyLinkClicked');
  });
  $('changelog-link').addEventListener('click', () => {
    tdSignal('changelogLinkClicked');
  });

  $('btn-new').addEventListener('click', async () => {
    if (doc().layers.length) {
      const ok = await confirmDialog({
        title: 'Start a new document?',
        message: 'Unsaved changes will be lost.',
        confirmLabel: 'New document',
        cancelLabel: 'Cancel',
        danger: true,
      });
      if (!ok) return;
    }
    loadDocument({ canvas: defaultCanvas(), light: defaultLight(), layers: [] }, 'icon');
    toast('New document.');
    tdSignal('new');
  });

  // Both pickers sniff the file and route by content, so a project opened via
  // Import (or a vector "opened") still does the right thing. `prefer` only
  // breaks ties for ambiguous files.
  $('file-open').addEventListener('change', (e) => handleFile(e, 'project'));
  $('file-import').addEventListener('change', (e) => handleFile(e, 'vector'));

  $('btn-save').addEventListener('click', saveProject);

  // Save As + picker-based Open + Watch only exist where the File System Access
  // API does; otherwise these stay hidden and Open uses the <input> label.
  const btnSaveAs = $('btn-save-as');
  if (btnSaveAs && canPick) {
    btnSaveAs.hidden = false;
    btnSaveAs.addEventListener('click', saveProjectAs);
  }
  if (canPick) {
    const openLabel = document.querySelector('label[for="file-open"]');
    if (openLabel) openLabel.addEventListener('click', (e) => { e.preventDefault(); openViaPicker(); });
  }
  setupWatch();

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
// when it didn't match the button they pressed (Open vs Import, PLAN §7). The
// <input> path can't expose a file handle, so it routes with handle = null.
async function handleFile(e, prefer) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  await routeOpenedContent(await file.text(), file.name, prefer, null);
}

// Shared open routing for the <input> fallback, the File System Access picker,
// and launchQueue. The latter two also pass a FileSystemFileHandle so Save can
// overwrite the file and the watcher can poll it; projects bind to it, vectors
// (import) don't (you can't watch an appended vector).
async function routeOpenedContent(text, name, prefer, handle) {
  const isProject = looksLikeProject(text, name);
  const isVector = !isProject && looksLikeVector(text, name);
  const kind = isProject ? 'project' : isVector ? 'vector' : prefer;

  if (kind === 'project') {
    const res = parseProject(text);
    if (!res.ok) { tdError(res.error, 'open'); return toast(res.error, 'error'); }
    loadDocument(res.document, res.name); // clears the previous handle (and watch)
    setCurrentHandle(handle || null); // bind to the on-disk file, if we have one
    toast(prefer === 'vector' ? `That's a project file — opened "${res.name}".` : `Opened "${res.name}".`);
    tdSignal('open');
  } else {
    const res = importVector(text, name);
    if (!res.ok) { tdError(res.error, 'import'); return toast(res.error, 'error'); }
    importLayers(res, name, prefer === 'project');
  }
}

// Open through the File System Access picker (Chromium) so we keep a handle for
// Save/Watch. Accepts projects and vectors (vectors route to import). Falls back
// to the hidden <input> on unsupported browsers via the Open label's default.
async function openViaPicker() {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [
        { description: 'Icon Recomposer project', accept: { 'application/x-icon-recomposer+json': ['.icjson', '.json'] } },
        { description: 'Vector artwork (SVG / VectorDrawable)', accept: { 'image/svg+xml': ['.svg'], 'application/xml': ['.xml'] } },
      ],
    });
    if (!handle) return;
    const file = await handle.getFile();
    await routeOpenedContent(await file.text(), handle.name, 'project', handle);
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user cancelled the picker
    console.error(err);
    toast('Could not open the file: ' + (err.message || err), 'error');
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
  tdSignal('import', { layers: res.layers.length });
}

async function doExport(action) {
  $('export-menu').hidden = true;
  const d = doc();
  // Single-file exports are a still of the CURRENT playhead frame (ANIMATION.md
  // §4): PNG/SVG keep full fidelity, VD strips what its format can't express
  // (no raster filters exist yet in Phase 1, so VD only loses the motion). The
  // frame index suffixes the filename so a sequence doesn't overwrite itself.
  const animating = isAnimating(d);
  const exportDoc = animating ? documentAt(d, clampTime(pb().time)) : d;
  const derived = derive(exportDoc);
  const frameTag = animating ? '-f' + String(Math.round(clampTime(pb().time) * d.timeline.fps)).padStart(4, '0') : '';
  try {
    if (action === 'vd') {
      const xml = exportVD(derived, d.canvas);
      download(new Blob([xml], { type: 'text/xml' }), exportName('vd' + frameTag, 'xml'));
      toast(animating ? 'Exported VectorDrawable (current frame — animation isn’t included).' : 'Exported VectorDrawable XML.', animating ? 'warn' : '');
    } else if (action === 'avd') {
      // Animated VectorDrawable — built from the authoring model (not the baked
      // derived frame). Warn about anything AVD can't represent before writing.
      const warnings = [];
      const xml = exportAVD(d, warnings);
      if (warnings.length) {
        const ok = await confirmDialog({
          title: 'Export Animated VectorDrawable?',
          message: 'AVD can’t represent these, so they’ll be left out:\n\n• ' + warnings.join('\n• ') + '\n\nExport anyway?',
          confirmLabel: 'Export anyway',
          cancelLabel: 'Cancel',
        });
        if (!ok) return;
      }
      download(new Blob([xml], { type: 'text/xml' }), exportName('avd', 'xml'));
      toast(warnings.length ? 'Exported Animated VectorDrawable (some parts left out).' : 'Exported Animated VectorDrawable.', warnings.length ? 'warn' : '');
    } else if (action === 'svg') {
      const svg = standaloneSvg(derived, d.canvas.viewportWidth, d.canvas.viewportHeight, { background: true });
      download(new Blob([svg], { type: 'image/svg+xml' }), exportName('svg' + frameTag, 'svg'));
      toast(animating ? 'Exported SVG (current frame).' : 'Exported SVG.');
    } else if (action === 'project') {
      downloadProject();
      toast('Downloaded project file.');
    } else if (action === 'png-transparent' || action === 'png-bg') {
      const size = d.canvas.pngSize || 1024;
      const withBg = action === 'png-bg';
      const background = withBg ? { transparent: false, color: d.canvas.exportBackground.color } : { transparent: true };
      const blob = await renderPng(derived, size, background);
      download(blob, exportName((withBg ? 'iwb' : 'iwt') + frameTag, 'png'));
      toast(`Exported PNG (${size}px${animating ? ', current frame' : ''}).`);
    } else if (action === 'share') {
      const url = location.origin + location.pathname + '#' + encodeShareFragment(d, appState.ui.projectName);
      if (url.length > 30000) {
        toast('Icon is too large for a share link — use Save instead.', 'warn');
        return;
      }
      await navigator.clipboard.writeText(url);
      toast('Share link copied to clipboard.');
    }
    // Reached only on success (failures throw; share-too-large returns early).
    tdSignal('export', { format: action });
  } catch (err) {
    console.error(err);
    toast('Export failed: ' + (err.message || err), 'error');
    tdError(err, 'export:' + action);
  }
}

function loadDocument(rawDoc, name) {
  appState.document = normalizeDocument(rawDoc);
  appState.ui.selectedLayerIds = [];
  appState.ui.primaryLayerId = null;
  appState.ui.selectAnchorId = null;
  appState.ui.projectName = name || 'icon';
  appState.ui.view = { scale: 1, panX: 0, panY: 0 }; // reset zoom/pan on load
  stopPlaybackLoop();
  appState.ui.playback = { time: 0, playing: false, scrubbing: false, autokey: false, selKey: null, speed: 1 };
  lastTracksKey = null;
  $('doc-name').value = appState.ui.projectName;
  undoStack.length = 0;
  redoStack.length = 0;
  gestureSnapshot = null;
  // A freshly loaded document is not bound to a file (stops any active watch);
  // routeOpenedContent re-binds it right after for a project opened from disk.
  setCurrentHandle(null);
  updateHistoryButtons();
  saveSession();
  scheduleRender();
}

// ---- file binding + external-edit watching (File System Access API) ----
// Opt-in: opening a file just loads it; the user clicks "Watch external edits"
// to start polling, and any in-app edit stops it (see commit/commitGesture).

// Bind the document to an on-disk file (or null). Switching files stops any
// active watch (silently — a new file replaced the watched one).
function setCurrentHandle(handle) {
  if (watchTimer) stopWatch('switch');
  currentHandle = handle || null;
  updateWatchButton();
}

function updateWatchButton() {
  const btn = $('btn-watch');
  if (!btn) return;
  const watching = !!watchTimer;
  btn.disabled = !currentHandle && !watching;
  btn.setAttribute('aria-pressed', watching ? 'true' : 'false');
  btn.textContent = watching ? 'Watching…' : 'Watch external edits';
  btn.title = !currentHandle
    ? 'Open a project file to watch it for external changes'
    : watching
    ? 'Stop watching the file for external changes'
    : 'Reload the open file when an external program changes it';
}

function setupWatch() {
  const btn = $('btn-watch');
  if (!btn || !fsaSupported) return; // unsupported → button stays hidden
  btn.hidden = false;
  btn.addEventListener('click', () => { if (watchTimer) stopWatch('user'); else startWatch(); });
  updateWatchButton();
  window.dispatchEvent(new Event('resize')); // let the toolbar overflow re-measure
}

async function startWatch() {
  if (!currentHandle || watchTimer) return;
  try {
    if (currentHandle.queryPermission) {
      let perm = await currentHandle.queryPermission({ mode: 'read' });
      if (perm === 'prompt' && currentHandle.requestPermission) perm = await currentHandle.requestPermission({ mode: 'read' });
      if (perm === 'denied') return toast('Permission to read the file was denied.', 'error');
    }
    watchLastMod = (await currentHandle.getFile()).lastModified;
  } catch (err) {
    console.error(err);
    return toast('Could not access the file to watch it.', 'error');
  }
  watchTimer = setInterval(pollWatch, WATCH_MS);
  updateWatchButton();
  toast(`Watching "${appState.ui.projectName}" — external edits reload here.`);
  tdSignal('watchStart');
}

function stopWatch(reason) {
  if (!watchTimer) return;
  clearInterval(watchTimer);
  watchTimer = null;
  watchPolling = false;
  updateWatchButton();
  if (reason === 'edited') toast('Stopped watching — you edited the icon here.');
  else if (reason === 'lost') toast('Lost access to the file — stopped watching.', 'warn');
  else if (reason === 'user') toast('Stopped watching for external edits.');
  // 'switch' is silent (a newly opened file replaced the watched one).
  if (reason !== 'switch') tdSignal('watchStop', { reason });
}

async function pollWatch() {
  if (watchPolling || !currentHandle) return;
  watchPolling = true;
  try {
    const file = await currentHandle.getFile();
    if (file.lastModified > watchLastMod) {
      const res = parseProject(await file.text());
      if (res.ok) {
        watchLastMod = file.lastModified;
        reloadFromWatch(res);
      }
      // A parse failure here is almost always a half-written file mid-save: leave
      // watchLastMod untouched so the next tick retries once the writer finishes.
    }
  } catch (err) {
    console.error(err);
    stopWatch('lost');
  } finally {
    watchPolling = false;
  }
}

// Lighter than loadDocument: reflects external changes while PRESERVING the
// current zoom/pan and selection, and stays silent (the live canvas is the
// feedback). Watching has already stopped any in-app edits, so clearing the
// undo history is safe — the file is the source of truth.
function reloadFromWatch(res) {
  appState.document = res.document; // already normalized by parseProject
  appState.ui.projectName = res.name;
  $('doc-name').value = res.name;
  // The track set may have changed under us — drop any stale keyframe selection
  // and re-clamp the playhead, but keep the current time/zoom/pan.
  pb().selKey = null;
  pb().time = clampTime(pb().time);
  lastTracksKey = null;
  reconcileSelection();
  undoStack.length = 0;
  redoStack.length = 0;
  gestureSnapshot = null;
  updateHistoryButtons();
  saveSession();
  scheduleRender();
}

// ---- save (overwrite bound file) + save as (new file) ----
// The current download behavior, kept as the universal fallback.
function downloadProject() {
  const json = serializeProject(doc(), appState.ui.projectName);
  download(new Blob([json], { type: 'application/json' }), exportName('', 'icjson'));
}

async function writeHandle(handle) {
  const json = serializeProject(doc(), appState.ui.projectName);
  const writable = await handle.createWritable();
  await writable.write(json);
  await writable.close();
  // Don't let the watcher (if running) reload from our own write.
  if (watchTimer) { try { watchLastMod = (await handle.getFile()).lastModified; } catch (_) {} }
}

// Lazily upgrade an opened (read) handle to read-write on the Save user gesture.
async function ensureWritable(handle) {
  if (!handle.queryPermission) return true; // assume writable on older impls
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  if (!handle.requestPermission) return false;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

// Save: overwrite the bound file; on no handle or refused permission, download a
// copy like before and tell the user why.
async function saveProject() {
  if (currentHandle) {
    let granted = false;
    try { granted = await ensureWritable(currentHandle); } catch (_) { granted = false; }
    if (!granted) {
      downloadProject();
      toast('Permission to edit the file was denied — downloaded a copy instead.', 'warn');
      return tdSignal('save', { mode: 'download-denied' });
    }
    try {
      await writeHandle(currentHandle);
      toast('Saved.');
      tdSignal('save', { mode: 'overwrite' });
    } catch (err) {
      console.error(err);
      downloadProject();
      toast('Could not write the file — downloaded a copy instead.', 'warn');
      tdSignal('save', { mode: 'download-error' });
    }
    return;
  }
  downloadProject(); // nothing bound → behave like today
  tdSignal('save', { mode: 'download' });
}

// Save As: pick a new file (Chromium) and bind to it; the picker grants
// read-write, so no separate permission prompt. Falls back to a download.
async function saveProjectAs() {
  if (!canPick) { downloadProject(); return tdSignal('save', { mode: 'download' }); }
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: fileBase() + '.icjson',
      types: [{ description: 'Icon Recomposer project', accept: { 'application/x-icon-recomposer+json': ['.icjson'] } }],
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user cancelled
    console.error(err);
    downloadProject();
    toast('Could not save the file — downloaded a copy instead.', 'warn');
    return tdSignal('save', { mode: 'download-error' });
  }
  // Adopt the chosen filename as the document name BEFORE writing so the file's
  // own `name` field matches.
  const base = handle.name.replace(/\.(icjson|json)$/i, '');
  if (base) { appState.ui.projectName = base; $('doc-name').value = base; }
  try {
    await writeHandle(handle);
    setCurrentHandle(handle);
    saveSession();
    toast(`Saved as "${handle.name}".`);
    tdSignal('save', { mode: 'saveas' });
  } catch (err) {
    console.error(err);
    downloadProject();
    toast('Could not save the file — downloaded a copy instead.', 'warn');
    tdSignal('save', { mode: 'download-error' });
  }
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
  // Ctrl/Cmd+S = Save, Ctrl/Cmd+Shift+S = Save As, Ctrl/Cmd+O = Open
  // (preventDefault overrides the browser's Save-page / Open-file defaults).
  else if (mod && e.key.toLowerCase() === 's' && e.shiftKey) { e.preventDefault(); saveProjectAs(); }
  else if (mod && e.key.toLowerCase() === 's' && !e.shiftKey) { e.preventDefault(); saveProject(); }
  else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); if (canPick) openViaPicker(); else $('file-open').click(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && appState.ui.selectedLayerIds.length) {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      e.preventDefault();
      deleteSelected();
    }
  } else if (e.key === 'Escape') {
    // An open color popover / dialog consumes Escape itself (they stop the event
    // before it reaches here). If a field is focused, Escape first leaves the
    // field; a second press then clears the selection.
    if (isDialogOpen()) return;
    const el = document.activeElement;
    const tag = (el && el.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { el.blur(); return; }
    if (appState.ui.selectedLayerIds.length) { e.preventDefault(); selectLayer(null); }
  }
});

// ---- toolbar overflow (priority+ menu) ----
// As the bar narrows, the lowest-priority items (data-priority; smaller = goes
// first) move into a "⋯" dropdown so the toolbar always stays on one line
// instead of wrapping/stacking messily. Items are the real DOM nodes (listeners
// intact), moved between the toolbar and the menu.
function setupToolbarOverflow() {
  const toolbar = document.querySelector('.toolbar');
  const moreWrap = $('more-dropdown');
  const moreBtn = $('btn-more');
  const moreMenu = $('more-menu');
  const spacer = toolbar.querySelector('.spacer');
  const original = Array.from(toolbar.children); // stable original order (incl. spacer, moreWrap)
  const collapsible = original
    .filter((el) => el.dataset && el.dataset.priority)
    .sort((a, b) => +a.dataset.priority - +b.dataset.priority); // lowest priority collapses first

  // Overflow test independent of the flex spacer: hide it, then compare the
  // packed content width to the toolbar's width.
  function fits() {
    spacer.style.display = 'none';
    const ok = toolbar.scrollWidth <= toolbar.clientWidth + 1;
    spacer.style.display = '';
    return ok;
  }

  function layout() {
    // Restore everything to the toolbar in original order (pulls items back out
    // of the menu), then collapse from scratch.
    for (const el of original) toolbar.appendChild(el);
    moreMenu.hidden = true;
    moreWrap.hidden = true;
    if (fits()) return;
    moreWrap.hidden = false; // the ⋯ button itself takes width
    for (const el of collapsible) {
      if (fits()) break;
      moreMenu.appendChild(el);
    }
    if (!moreMenu.children.length) moreWrap.hidden = true;
  }

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; layout(); });
  };
  window.addEventListener('resize', schedule);
  moreBtn.addEventListener('click', (e) => { e.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; });
  document.addEventListener('click', () => { moreMenu.hidden = true; });

  layout();
}

// ---- PWA service worker ----
// Registered as sw.js?v=<APP_VERSION> so each release is a distinct worker URL
// (the browser installs the new one and we version the cache by it). When an
// updated worker finishes installing, prompt to reload; on accept we tell it to
// take over and reload once it controls the page.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Local development: don't use the service worker. Its cache-first app-shell
  // serves stale modules during iteration (you stay one version behind until the
  // update prompt is accepted), which masks just-saved changes. Unregister any
  // existing worker so a plain reload always fetches fresh files. Production
  // (the deployed origin) is unaffected and stays fully offline-capable.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {});
    return;
  }
  let updateAccepted = false;
  // Reload only after the user accepted an update — ignore the initial control
  // hand-off on first install (clients.claim) so we don't reload on first visit.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateAccepted) window.location.reload();
  });
  async function promptUpdate(worker) {
    const ok = await confirmDialog({
      title: 'Update available',
      message: 'A new version of Icon Recomposer is ready. Reload to update?',
      confirmLabel: 'Reload',
      cancelLabel: 'Later',
    });
    if (ok) { updateAccepted = true; worker.postMessage('SKIP_WAITING'); }
  }
  navigator.serviceWorker
    .register('sw.js?v=' + APP_VERSION)
    .then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          // 'installed' with an existing controller ⇒ an update (not first install).
          if (nw.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(nw);
        });
      });
    })
    .catch((err) => console.warn('Service worker registration failed:', err));
}

// ---- install (PWA) ----
// Show an "Install" button only when the browser offers installation, and only
// run the native install on an explicit click — no automatic prompt/banner.
function setupInstall() {
  const btn = $('btn-install');
  if (!btn) return;
  let deferred = null;
  // Capturing this event (and preventing default) suppresses the browser's own
  // auto install prompt; we surface our button instead.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
    window.dispatchEvent(new Event('resize')); // let the toolbar overflow re-measure
  });
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt(); // native install dialog — only on this explicit click
    let outcome = 'unknown';
    try { outcome = (await deferred.userChoice).outcome; } catch (_) {}
    tdSignal('installPrompt', { outcome });
    deferred = null;
    btn.hidden = true; // the event is single-use
    window.dispatchEvent(new Event('resize'));
  });
  // Installed (via our button or the browser UI) → hide the button for good.
  window.addEventListener('appinstalled', () => {
    deferred = null;
    btn.hidden = true;
    window.dispatchEvent(new Event('resize'));
    tdSignal('appInstalled');
  });
}

// ---- init ----
const DEFAULT_PROJECT_URL = 'assets/' + encodeURIComponent('app icon.json');

async function init() {
  $('app-version').textContent = 'v' + APP_VERSION;
  wireControls();
  wireToolbar();
  wireTimeline();
  setupToolbarOverflow();
  updateHistoryButtons();
  registerServiceWorker();
  setupInstall();

  // File Handling API: when the installed PWA is launched by double-clicking a
  // .icjson file, open it (with its handle, so Save/Watch work). Opt-in: this
  // does NOT auto-start watching. An ordinary launch delivers no files → no-op,
  // so the default/session/share load below still runs.
  if ('launchQueue' in window && 'setConsumer' in window.launchQueue) {
    launchQueue.setConsumer(async (params) => {
      if (!params || !params.files || !params.files.length) return;
      try {
        const handle = params.files[0];
        const file = await handle.getFile();
        await routeOpenedContent(await file.text(), handle.name, 'project', handle);
      } catch (err) {
        console.error(err);
        toast('Could not open the file.', 'error');
      }
    });
  }

  // Canvas zoom/pan: wheel + trackpad pinch zoom (non-passive so we can
  // preventDefault), re-clamp on resize, and suppress middle-click autoscroll.
  stage.addEventListener('wheel', onCanvasWheel, { passive: false });
  window.addEventListener('resize', () => { clampView(); applyViewTransform(); });
  stage.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

  // Load priority: share link → auto-saved session → bundled default ("app
  // icon") → built-in sample document. A share link is an explicit request, so
  // it wins; the saved session restores the user's last work; the bundled asset
  // is the first-visit welcome demo. A peeked share link does not overwrite the
  // saved session — only an actual edit (commit/commitGesture) persists.
  if (location.hash && location.hash.indexOf('doc=') >= 0) {
    const res = decodeShareFragment(location.hash);
    if (res && res.ok) {
      appState.document = res.document;
      appState.ui.projectName = res.name;
      toast(`Loaded shared "${res.name}".`);
    } else if (res && !res.ok) {
      toast(res.error, 'error');
      tdError(res.error, 'share-link');
    }
  } else {
    const saved = loadSession();
    if (saved) {
      appState.document = saved.document;
      appState.ui.projectName = saved.name;
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
  }
  $('doc-name').value = appState.ui.projectName;
  render();
}

init();

