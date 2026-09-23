// model.js: the document, a list of variants each holding a scene and a stack of shapes.
//
// Each shape sits on the adaptive icon's foreground or background layer, and
// background shapes always paint under foreground ones (paintOrder), as on a
// launcher. Within a layer, array order is paint order.
//
// A variant's crossings override the paint order where two shapes overlap:
// { over, under } draws `over` on top of `under` inside `under`'s outline, even
// when `over` paints below it. That allows woven designs, where A is over B, B
// over C and C over A, which no single stacking order can express.
//
// A variant is a complete, independent copy of the design. Shapes keep the same
// id across variants, so "edit all variants" can find the matching shape in
// each one. Coordinates are in canvas units: the icon canvas is CANVAS x CANVAS,
// the Android adaptive-icon 108dp grid.

export const APP_VERSION = '2.0.0-alpha3';
export const SCHEMA_VERSION = 1;
export const FORMAT = 'icon-recomposer/2';
export const CANVAS = 108;

export const MATERIALS = [
  { id: 'matte', label: 'Matte' },
  { id: 'shiny', label: 'Shiny' },
  { id: 'glass', label: 'Frosted glass' },
  { id: 'brushed', label: 'Brushed metal' },
  { id: 'brushed-round', label: 'Brushed (radial)' },
  { id: 'blasted', label: 'Blasted' },
  { id: 'wood', label: 'Wood' },
];

export const LAYERS = [
  { id: 'foreground', label: 'Foreground' },
  { id: 'background', label: 'Background' },
];

export const SURFACES = [
  { id: 'flat', label: 'Flat' },
  { id: 'concave', label: 'Concave (vertical)' },
  { id: 'concave-h', label: 'Concave (horizontal)' },
  { id: 'convex', label: 'Convex' },
  { id: 'groove', label: 'Groove (recessed)' },
];

let idCounter = 0;
export function newId(prefix) {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function defaultScene() {
  return {
    lightX: -1,
    lightY: -1,
    key: 0.9,
    fill: 0.7,
    hue: 234,
    saturation: 15,
  };
}

export function defaultBackground() {
  return { color: '#e8e9ee', lit: true, transparent: false };
}

export function defaultStyle() {
  return {
    color: '#3b6fd8',
    shade: 1,
    opacity: 1,
    material: 'matte',
    surface: 'flat',
    elevation: 1,
    thickness: 1,
    chamfer: false,
    chamferWidth: 1,
    fillet: true,
    filletWidth: 1,
    edgeShine: 0.2,
    frost: 0.3,
    curveScale: 1,
    grain: 1,
    woodAngle: 0,
    woodScale: 1,
    glow: false,
    glowColor: '#7fd6ff',
    glowSize: 6,
  };
}

export function newShape(kind = 'rect', over = {}) {
  const size = kind === 'ellipse' ? 48 : 64;
  return {
    id: newId('s'),
    name: kind === 'ellipse' ? 'Circle' : 'Rectangle',
    kind,
    x: (CANVAS - size) / 2,
    y: (CANVAS - size) / 2,
    w: size,
    h: size,
    radius: kind === 'ellipse' ? 0 : 16,
    rotation: 0,
    hidden: false,
    layer: 'foreground',
    style: defaultStyle(),
    ...over,
  };
}

export function newVariant(name = 'Variant 1') {
  return {
    id: newId('v'),
    name,
    scene: defaultScene(),
    background: defaultBackground(),
    shapes: [],
    crossings: [],
  };
}

export function newDocument() {
  return {
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    app: APP_VERSION,
    name: 'icon',
    variants: [newVariant()],
    guide: null,
  };
}

export function sampleDocument() {
  const doc = newDocument();
  const v = doc.variants[0];
  v.name = 'Blue';
  const plate = newShape('rect', {
    name: 'Plate', x: 16, y: 16, w: 76, h: 76, radius: 22,
    style: { ...defaultStyle(), color: '#2f6fe0', elevation: 2, thickness: 1, fillet: true },
  });
  const ring = newShape('ellipse', {
    name: 'Ring', x: 34, y: 34, w: 40, h: 40,
    style: { ...defaultStyle(), color: '#f5b400', material: 'shiny', elevation: 1, chamfer: true, fillet: false },
  });
  const dot = newShape('ellipse', {
    name: 'Dot', x: 46, y: 46, w: 16, h: 16,
    style: { ...defaultStyle(), color: '#eeeeee', surface: 'concave', elevation: 0, fillet: false },
  });
  v.shapes.push(plate, ring, dot);

  const green = duplicateVariant(v, 'Green');
  green.shapes[0].style.color = '#1f9d63';
  green.shapes[1].style.color = '#f2f2f2';
  const dark = duplicateVariant(v, 'Night');
  dark.background.color = '#23262f';
  dark.scene = { ...dark.scene, key: 0.55, fill: 0.35, hue: 220, saturation: 30 };
  doc.variants.push(green, dark);
  return doc;
}

export function duplicateVariant(variant, name) {
  const copy = structuredClone(variant);
  copy.id = newId('v');
  copy.name = name || `${variant.name} copy`;
  return copy;
}

const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const pick = (v, list, d) => (list.some((o) => o.id === v) ? v : d);
const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);

function normalizeStyle(s = {}) {
  const d = defaultStyle();
  return {
    color: hex(s.color, d.color),
    shade: clamp(s.shade, 0, 2, d.shade),
    opacity: clamp(s.opacity, 0, 1, d.opacity),
    material: pick(s.material, MATERIALS, d.material),
    surface: pick(s.surface, SURFACES, d.surface),
    elevation: clamp(s.elevation, 0, 3, d.elevation),
    thickness: clamp(s.thickness, 0, 2, d.thickness),
    chamfer: !!s.chamfer,
    chamferWidth: clamp(s.chamferWidth, -2, 2, d.chamferWidth),
    fillet: s.fillet === undefined ? d.fillet : !!s.fillet,
    filletWidth: clamp(s.filletWidth, -2, 2, d.filletWidth),
    edgeShine: clamp(s.edgeShine, 0, 1, d.edgeShine),
    frost: clamp(s.frost, 0, 1, d.frost),
    curveScale: clamp(s.curveScale, 0, 4, d.curveScale),
    grain: clamp(s.grain, 0, 3, d.grain),
    woodAngle: clamp(s.woodAngle, -90, 90, d.woodAngle),
    woodScale: clamp(s.woodScale, 0.25, 4, d.woodScale),
    glow: !!s.glow,
    glowColor: hex(s.glowColor, d.glowColor),
    glowSize: clamp(s.glowSize, 0, 30, d.glowSize),
  };
}

function normalizeShape(s = {}) {
  const kind = s.kind === 'ellipse' ? 'ellipse' : 'rect';
  const base = newShape(kind);
  return {
    id: typeof s.id === 'string' && s.id ? s.id : base.id,
    name: typeof s.name === 'string' && s.name ? s.name : base.name,
    kind,
    x: clamp(s.x, -CANVAS, CANVAS * 2, base.x),
    y: clamp(s.y, -CANVAS, CANVAS * 2, base.y),
    w: clamp(s.w, 1, CANVAS * 3, base.w),
    h: clamp(s.h, 1, CANVAS * 3, base.h),
    radius: clamp(s.radius, 0, CANVAS * 1.5, base.radius),
    rotation: clamp(s.rotation, -360, 360, 0),
    hidden: !!s.hidden,
    layer: pick(s.layer, LAYERS, 'foreground'),
    style: normalizeStyle(s.style),
  };
}

function normalizeVariant(v = {}, i = 0) {
  const sc = v.scene || {};
  const ds = defaultScene();
  const bg = v.background || {};
  const db = defaultBackground();
  return {
    id: typeof v.id === 'string' && v.id ? v.id : newId('v'),
    name: typeof v.name === 'string' && v.name ? v.name : `Variant ${i + 1}`,
    scene: {
      lightX: clamp(sc.lightX, -1, 1, ds.lightX),
      lightY: clamp(sc.lightY, -1, 1, ds.lightY),
      key: clamp(sc.key, 0, 1, ds.key),
      fill: clamp(sc.fill, 0, 1, ds.fill),
      hue: clamp(sc.hue, 0, 360, ds.hue),
      saturation: clamp(sc.saturation, 0, 100, ds.saturation),
    },
    background: {
      color: hex(bg.color, db.color),
      lit: bg.lit === undefined ? db.lit : !!bg.lit,
      transparent: !!bg.transparent,
    },
    shapes: Array.isArray(v.shapes) ? v.shapes.map(normalizeShape) : [],
    crossings: normalizeCrossings(v.crossings, v.shapes),
  };
}

function normalizeCrossings(list, shapes) {
  const ids = new Set(Array.isArray(shapes) ? shapes.map((s) => s && s.id) : []);
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !ids.has(c.over) || !ids.has(c.under) || c.over === c.under) continue;
    const key = crossingKey(c.over, c.under);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ over: c.over, under: c.under });
  }
  return out;
}

// The tracing guide: an imported drawing shown faintly over the canvas while
// editing. It belongs to the document, not to a variant, and is never exported.
function normalizeGuide(g) {
  if (!g || !Array.isArray(g.paths)) return null;
  const paths = g.paths
    .filter((p) => p && typeof p.d === 'string' && p.d)
    .map((p) => ({ d: p.d, fill: hex(p.fill, '#9e9e9e'), evenOdd: !!p.evenOdd }));
  if (!paths.length) return null;
  return { name: typeof g.name === 'string' ? g.name : 'guide', paths, visible: g.visible !== false };
}

// Throws with a readable message when the JSON is not a project of this app.
export function parseProject(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (!data || data.format !== FORMAT) {
    if (data && Array.isArray(data.layers)) {
      throw new Error('This is a project from Icon Recomposer 1.x, which this version cannot open.');
    }
    throw new Error('The file is not an Icon Recomposer project.');
  }
  const variants = Array.isArray(data.variants) && data.variants.length
    ? data.variants.map(normalizeVariant)
    : [newVariant()];
  return {
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    app: APP_VERSION,
    name: typeof data.name === 'string' && data.name ? data.name : 'icon',
    variants,
    guide: normalizeGuide(data.guide),
  };
}

export function serializeProject(doc) {
  return JSON.stringify({ ...doc, app: APP_VERSION, schemaVersion: SCHEMA_VERSION }, null, 2);
}

export function slug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'icon';
}

export function paintOrder(shapes) {
  return [...shapes.filter((s) => s.layer === 'background'), ...shapes.filter((s) => s.layer !== 'background')];
}

export function crossingKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function findCrossing(variant, a, b) {
  const key = crossingKey(a, b);
  return (variant.crossings || []).find((c) => crossingKey(c.over, c.under) === key) || null;
}

// Sets which of two shapes is on top where they cross, or clears the override
// (over = null) so the paint order decides again.
export function setCrossing(variant, a, b, over) {
  const key = crossingKey(a, b);
  variant.crossings = (variant.crossings || []).filter((c) => crossingKey(c.over, c.under) !== key);
  if (over) variant.crossings.push({ over, under: over === a ? b : a });
}

export function dropCrossingsOf(variant, ids) {
  variant.crossings = (variant.crossings || []).filter((c) => !ids.has(c.over) && !ids.has(c.under));
}

// Whether `a` is visibly on top of `b` where they overlap.
export function isOver(variant, a, b) {
  const c = findCrossing(variant, a, b);
  if (c) return c.over === a;
  const order = paintOrder(variant.shapes).map((s) => s.id);
  return order.indexOf(a) > order.indexOf(b);
}

export function insideShape(s, p) {
  const t = (s.rotation * Math.PI) / 180;
  const dx = p.x - (s.x + s.w / 2);
  const dy = p.y - (s.y + s.h / 2);
  const lx = dx * Math.cos(t) + dy * Math.sin(t);
  const ly = -dx * Math.sin(t) + dy * Math.cos(t);
  const hw = s.w / 2;
  const hh = s.h / 2;
  return s.kind === 'ellipse'
    ? (lx / hw) ** 2 + (ly / hh) ** 2 <= 1
    : Math.abs(lx) <= hw && Math.abs(ly) <= hh;
}

// Samples a grid inside `a` and reports whether any sample lies inside `b`.
export function shapesOverlap(a, b) {
  const n = 16;
  const t = (a.rotation * Math.PI) / 180;
  const c = Math.cos(t);
  const sn = Math.sin(t);
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const lx = (i / n - 0.5) * a.w;
      const ly = (j / n - 0.5) * a.h;
      const p = { x: cx + lx * c - ly * sn, y: cy + lx * sn + ly * c };
      if (insideShape(a, p) && insideShape(b, p)) return true;
    }
  }
  return false;
}

// What "Copy to variants" can carry, per shape and per variant.
export const COPY_SHAPE_PARTS = [
  { id: 'geometry', label: 'Geometry (position, size, corners, rotation, kind)' },
  { id: 'look', label: 'Look (material, surface, depth, edges, opacity, glow)' },
  { id: 'color', label: 'Colors (shape and glow color)' },
  { id: 'layer', label: 'Layer and visibility' },
];
export const COPY_VARIANT_PARTS = [
  { id: 'light', label: 'Light' },
  { id: 'background', label: 'Background' },
  { id: 'crossings', label: 'Crossings' },
  { id: 'order', label: 'Stacking order' },
  { id: 'missing', label: 'Add shapes the variant does not have' },
];

const GEOMETRY_KEYS = ['kind', 'x', 'y', 'w', 'h', 'radius', 'rotation'];
const COLOR_KEYS = ['color', 'glowColor'];

// Copies the chosen parts of the shapes `ids` (and the chosen variant-wide
// parts) from `src` into `dst`. Shapes are matched by id.
//   parts: Set of COPY_SHAPE_PARTS / COPY_VARIANT_PARTS ids
export function copyIntoVariant(src, dst, ids, parts) {
  const scope = new Set(ids);
  const srcShapes = src.shapes.filter((s) => scope.has(s.id));

  if (parts.has('missing')) {
    for (const s of srcShapes) {
      if (dst.shapes.some((d) => d.id === s.id)) continue;
      const i = src.shapes.indexOf(s);
      const before = src.shapes.slice(0, i).reverse().find((p) => dst.shapes.some((d) => d.id === p.id));
      const at = before ? dst.shapes.findIndex((d) => d.id === before.id) + 1 : 0;
      dst.shapes.splice(at, 0, structuredClone(s));
    }
  }

  for (const s of srcShapes) {
    const d = dst.shapes.find((x) => x.id === s.id);
    if (!d) continue;
    if (parts.has('geometry')) for (const k of GEOMETRY_KEYS) d[k] = s[k];
    if (parts.has('look')) {
      for (const k of Object.keys(s.style)) if (!COLOR_KEYS.includes(k)) d.style[k] = s.style[k];
    }
    if (parts.has('color')) for (const k of COLOR_KEYS) d.style[k] = s.style[k];
    if (parts.has('layer')) {
      d.layer = s.layer;
      d.hidden = s.hidden;
    }
  }

  if (parts.has('order')) {
    // The in-scope shapes keep dst's slots but take src's order among them.
    const rank = new Map(src.shapes.map((s, i) => [s.id, i]));
    const slots = [];
    dst.shapes.forEach((d, i) => { if (scope.has(d.id) && rank.has(d.id)) slots.push(i); });
    const sorted = slots.map((i) => dst.shapes[i]).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    slots.forEach((slot, k) => { dst.shapes[slot] = sorted[k]; });
  }

  if (parts.has('crossings')) {
    const inDst = new Set(dst.shapes.map((d) => d.id));
    const touches = (c) => scope.has(c.over) || scope.has(c.under);
    dst.crossings = (dst.crossings || []).filter((c) => !touches(c));
    for (const c of src.crossings || []) {
      if (touches(c) && inDst.has(c.over) && inDst.has(c.under)) dst.crossings.push({ ...c });
    }
  }

  if (parts.has('light')) dst.scene = structuredClone(src.scene);
  if (parts.has('background')) dst.background = structuredClone(src.background);
}
