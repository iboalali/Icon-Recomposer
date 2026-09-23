// model.js: the document, a list of variants each holding a scene and a stack of shapes.
//
// Each shape sits on the adaptive icon's foreground or background layer, and
// background shapes always paint under foreground ones (paintOrder), as on a
// launcher. Within a layer, array order is paint order.
//
// A variant is a complete, independent copy of the design. Shapes keep the same
// id across variants, so "edit all variants" can find the matching shape in
// each one. Coordinates are in canvas units: the icon canvas is CANVAS x CANVAS,
// the Android adaptive-icon 108dp grid.

export const APP_VERSION = '2.0.0-alpha.1';
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
    curveScale: 1,
    grain: 1,
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
  };
}

export function newDocument() {
  return {
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    app: APP_VERSION,
    name: 'icon',
    variants: [newVariant()],
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
    curveScale: clamp(s.curveScale, 0, 4, d.curveScale),
    grain: clamp(s.grain, 0, 3, d.grain),
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
  };
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
