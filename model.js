// model.js — the authoring model: defaults, sample doc, validation/migration,
// and the project-file / share-link serialization (PLAN §4, §8).
//
// The authoring model is what the user manipulates: ONE shared scene light plus
// a layers[] array, each layer a pathData + material. derive() turns this into
// the flat derived model that all three renderers consume.

export const SCHEMA_VERSION = 1;
export const APP_VERSION = '1.1.0';
export const FORMAT_ID = 'icon-emboss';

let idCounter = 0;
export function newId(prefix = 'layer') {
  idCounter += 1;
  return `${prefix}-${idCounter}-${(idCounter * 2654435761) % 100000}`;
}

// ---- defaults ----
export function defaultLight() {
  return {
    type: 'point', // point | distant
    position: { x: 38, y: 30 }, // point light: viewport coords (= radial center)
    azimuth: 135, // distant light: direction light comes FROM (deg, cw from top)
    elevation: 55, // 0 = grazing/long shadow, 90 = overhead/flat
    intensity: 1.0,
    color: '#ffffff',
  };
}

export function defaultMaterial(baseColor = '#3b82f6') {
  return {
    baseColor,
    fillAlpha: 1,
    fillMode: 'embossed', // solid | embossed
    embossIntensity: 1.0,
    sheen: { enabled: false, strength: 0.35 },
    stroke: null, // { color, width, cap, join } — passthrough, un-embossed
    fillNone: false, // stroke-only layer
  };
}

export function defaultLayer(opts = {}) {
  return {
    id: opts.id || newId(),
    name: opts.name || 'Layer',
    visible: opts.visible !== false,
    pathData: opts.pathData || '',
    fillRule: opts.fillRule || 'nonZero', // nonZero | evenOdd
    material: opts.material || defaultMaterial(),
    castsShadow: opts.castsShadow || { enabled: false, opacity: 0.35, spread: 0.4, clipToLayers: true },
    transform: opts.transform || null, // reserved (import bakes transforms)
  };
}

export function defaultCanvas() {
  return {
    width: 108,
    height: 108,
    viewportWidth: 108,
    viewportHeight: 108,
    exportBackground: { transparent: true, color: '#ffffff' },
    pngSize: 1024,
  };
}

// ---- rounded-rect path helper (for the sample doc) ----
export function roundedRectPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const k = 0.5522847498 * r; // circle→bézier constant
  const x2 = x + w;
  const y2 = y + h;
  return (
    `M${x + r} ${y}` +
    `L${x2 - r} ${y}` +
    `C${x2 - r + k} ${y} ${x2} ${y + r - k} ${x2} ${y + r}` +
    `L${x2} ${y2 - r}` +
    `C${x2} ${y2 - r + k} ${x2 - r + k} ${y2} ${x2 - r} ${y2}` +
    `L${x + r} ${y2}` +
    `C${x + r - k} ${y2} ${x} ${y2 - r + k} ${x} ${y2 - r}` +
    `L${x} ${y + r}` +
    `C${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y}` +
    `Z`
  );
}

// ---- sample document (the spine: PLAN §10 step 1) ----
// A rounded plate + a play triangle — recognizable and exercises emboss/shadow.
export function sampleDocument() {
  const plate = defaultLayer({
    name: 'Plate',
    pathData: roundedRectPath(8, 8, 92, 92, 24),
    material: defaultMaterial('#2563eb'),
  });
  plate.material.embossIntensity = 1.0;
  plate.material.sheen = { enabled: true, strength: 0.3 };
  plate.castsShadow = { enabled: true, opacity: 0.4, spread: 0.5, clipToLayers: true };

  const glyph = defaultLayer({
    name: 'Glyph',
    pathData: 'M44 38 L74 54 L44 70 Z',
    material: defaultMaterial('#eff6ff'),
  });
  glyph.material.embossIntensity = 0.8;
  glyph.castsShadow = { enabled: true, opacity: 0.3, spread: 0.35, clipToLayers: true };

  return {
    canvas: defaultCanvas(),
    light: defaultLight(),
    layers: [plate, glyph],
  };
}

// ---- validation / migration ----
// Coerce an arbitrary parsed object into a valid document, filling defaults for
// missing fields and dropping unknowns. Tolerant on purpose (PLAN §8).
export function normalizeDocument(input) {
  const doc = input && typeof input === 'object' ? input : {};
  const canvas = Object.assign(defaultCanvas(), doc.canvas || {});
  canvas.exportBackground = Object.assign(
    { transparent: true, color: '#ffffff' },
    (doc.canvas && doc.canvas.exportBackground) || {}
  );

  const light = Object.assign(defaultLight(), doc.light || {});
  light.position = Object.assign({ x: canvas.viewportWidth / 2, y: canvas.viewportHeight / 2 }, light.position || {});

  const layers = Array.isArray(doc.layers) ? doc.layers.map(normalizeLayer) : [];

  return { canvas, light, layers };
}

// Coerce a (possibly hand-edited) transform into all-numeric fields, or null.
// translateX/Y is now user-writable (move-layer), so guard against NaN/strings
// that would poison the affine matrix in derive().
function normalizeTransform(t) {
  if (!t || typeof t !== 'object') return null;
  const n = (v, d) => (isFinite(+v) ? +v : d);
  return {
    translateX: n(t.translateX, 0),
    translateY: n(t.translateY, 0),
    rotation: n(t.rotation, 0),
    scaleX: n(t.scaleX, 1),
    scaleY: n(t.scaleY, 1),
    pivotX: n(t.pivotX, 0),
    pivotY: n(t.pivotY, 0),
  };
}

function normalizeLayer(input) {
  const l = input && typeof input === 'object' ? input : {};
  const layer = defaultLayer({
    id: l.id,
    name: l.name,
    visible: l.visible,
    pathData: l.pathData,
    fillRule: l.fillRule === 'evenOdd' ? 'evenOdd' : 'nonZero',
    transform: normalizeTransform(l.transform),
  });
  const m = l.material || {};
  layer.material = Object.assign(defaultMaterial(), {
    baseColor: m.baseColor || '#3b82f6',
    fillAlpha: m.fillAlpha == null ? 1 : m.fillAlpha,
    fillMode: m.fillMode === 'solid' ? 'solid' : 'embossed',
    embossIntensity: m.embossIntensity == null ? 1 : m.embossIntensity,
    sheen: Object.assign({ enabled: false, strength: 0.35 }, m.sheen || {}),
    stroke: m.stroke || null,
    fillNone: !!m.fillNone,
  });
  layer.castsShadow = Object.assign({ enabled: false, opacity: 0.35, spread: 0.4, clipToLayers: true }, l.castsShadow || {});
  return layer;
}

// Migrate a parsed project payload from its schemaVersion up to current.
function migrate(payload) {
  let v = payload.schemaVersion || 1;
  // (No migrations yet — v1 is current. Future bumps add steps here.)
  return payload.document;
}

// ---- project file (save / open) ----
export function wrapProject(document, name = 'icon') {
  return {
    format: FORMAT_ID,
    schemaVersion: SCHEMA_VERSION,
    app: APP_VERSION,
    name,
    document,
  };
}

export function serializeProject(document, name) {
  return JSON.stringify(wrapProject(document, name), null, 2);
}

// Returns { ok, document, name } or { ok:false, error }.
export function parseProject(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'Not valid JSON.' };
  }
  if (!payload || payload.format !== FORMAT_ID) {
    return { ok: false, error: `Not an Icon Recomposer project (format "${payload && payload.format}").` };
  }
  if ((payload.schemaVersion || 1) > SCHEMA_VERSION) {
    return { ok: false, error: `Project is from a newer version (schema ${payload.schemaVersion}).` };
  }
  const rawDoc = migrate(payload);
  return { ok: true, document: normalizeDocument(rawDoc), name: payload.name || 'icon' };
}

// ---- share-by-link (URL fragment, no backend; PLAN §8) ----
function toB64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeShareFragment(document, name) {
  return 'doc=' + toB64Url(JSON.stringify(wrapProject(document, name)));
}

export function decodeShareFragment(hash) {
  const m = /(?:^#?|&)doc=([^&]+)/.exec(hash || '');
  if (!m) return null;
  try {
    return parseProject(fromB64Url(m[1]));
  } catch (e) {
    return { ok: false, error: 'Share link is corrupt.' };
  }
}
