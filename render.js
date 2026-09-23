// render.js: variant → icon markup, plus the stylesheet the markup needs.
//
// The live preview (inside a shadow root) and the PNG capture (inside an SVG
// foreignObject) both use exactly this markup and stylesheet, so the export
// matches the preview.
//
// The markup is XHTML-safe: it is parsed as XML inside the capture SVG.

import { CANVAS, paintOrder } from './model.js';

const AMBIENT_URL = new URL('./vendor/ambientcss/ambient.css', import.meta.url);

const SURFACE_CLASS = {
  flat: 'amb-surface',
  concave: 'amb-surface-concave',
  'concave-h': 'amb-surface-concave-h',
  convex: 'amb-surface-convex',
  groove: 'amb-groove',
};

const BASE_CSS = `
.ir-stage { position: relative; width: ${CANVAS}px; height: ${CANVAS}px; overflow: hidden; }
.ir-shape, .ir-halo { position: absolute; box-sizing: border-box; }
.ir-halo { background: transparent; pointer-events: none; }
.ir-clip { position: absolute; box-sizing: border-box; overflow: hidden; pointer-events: none; }
`;

let cssPromise = null;

// ambient.css puts its scene defaults and derived colors on :root. Inside a
// shadow root :root matches nothing, so the stage gets the same rule.
export function iconCss() {
  if (!cssPromise) {
    cssPromise = fetch(AMBIENT_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load ambient.css (${r.status})`);
        return r.text();
      })
      .then((css) => css.replace(/:root\s*\{/, ':root, .ir-stage {') + BASE_CSS);
  }
  return cssPromise;
}

let sheetPromise = null;
export function iconSheet() {
  if (!sheetPromise) {
    sheetPromise = iconCss().then((css) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      return sheet;
    });
  }
  return sheetPromise;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const num = (n) => +(+n).toFixed(3);

// box-shadow offsets and the shiny gradient angle live in the element's own
// rotated frame, so a rotated shape needs the light turned back by its angle to
// keep its shadow falling away from the scene light.
function localLight(scene, rotationDeg) {
  const t = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return {
    x: scene.lightX * c + scene.lightY * s,
    y: -scene.lightX * s + scene.lightY * c,
  };
}

// place: where the element sits in its container ({ x, y, rotation }); it
// differs from the shape's own values only inside a crossing clip.
function geometryCss(shape, place = shape) {
  const radius = shape.kind === 'ellipse' ? '50%' : `${num(shape.radius)}px`;
  let css = `left:${num(place.x)}px;top:${num(place.y)}px;width:${num(shape.w)}px;height:${num(shape.h)}px;border-radius:${radius};`;
  if (place.rotation) css += `transform:rotate(${num(place.rotation)}deg);`;
  return css;
}

function shapeMarkup(shape, scene, place = shape) {
  const st = shape.style;
  const classes = ['ir-shape', 'ambient'];
  if (st.material === 'glass') {
    classes.push('amb-mat-glass');
  } else {
    classes.push(SURFACE_CLASS[st.surface] || 'amb-surface');
    if (st.material !== 'matte') classes.push(`amb-mat-${st.material}`);
  }
  const light = localLight(scene, shape.rotation || 0);
  const vars = [
    `--amb-light-x:${num(light.x)}`,
    `--amb-light-y:${num(light.y)}`,
    `--amb-albedo:${st.color}`,
    `--amb-shade:${num(st.shade)}`,
    `--amb-elevation:${num(st.elevation)}`,
    `--amb-thickness:${num(st.thickness)}`,
    `--amb-chamfer:${st.chamfer ? 1 : 0}`,
    `--amb-chamfer-width:${num(st.chamferWidth)}`,
    `--amb-fillet:${st.fillet ? 1 : 0}`,
    `--amb-fillet-width:${num(st.filletWidth)}`,
    `--amb-curve-scale:${num(st.curveScale)}`,
    `--amb-grain-amount:${num(st.grain)}`,
  ].join(';');
  const geo = geometryCss(shape, place);
  const opacity = st.opacity < 1 ? `opacity:${num(st.opacity)};` : '';
  let out = '';
  if (st.glow && st.glowSize > 0) {
    out += `<div class="ir-halo" style="${geo}${opacity}box-shadow:0 0 ${num(st.glowSize)}px ${num(st.glowSize / 3)}px ${st.glowColor}"></div>`;
  }
  const id = place === shape ? ` data-id="${esc(shape.id)}"` : '';
  out += `<div class="${classes.join(' ')}"${id} style="${geo}${opacity}${vars}"></div>`;
  return out;
}

// Draws `over` again inside a box shaped like `under` that clips everything
// outside it, so within `under`'s outline `over` and its shadow sit on top.
// The copy is placed in the clip box's rotated frame; its light still turns
// with its full world angle because localLight uses the shape's own rotation.
function crossingMarkup(over, under, scene) {
  const t = (under.rotation * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const dx = over.x + over.w / 2 - (under.x + under.w / 2);
  const dy = over.y + over.h / 2 - (under.y + under.h / 2);
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  const place = {
    x: under.w / 2 + lx - over.w / 2,
    y: under.h / 2 + ly - over.h / 2,
    rotation: (over.rotation || 0) - (under.rotation || 0),
  };
  return `<div class="ir-clip" style="${geometryCss(under)}">${shapeMarkup(over, scene, place)}</div>`;
}

// layer: 'all' (the composite), 'foreground' (no background) or 'background'.
export function stageMarkup(variant, { layer = 'all', transparent = false } = {}) {
  const sc = variant.scene;
  const bg = variant.background;
  let style = [
    `--amb-light-x:${num(sc.lightX)}`,
    `--amb-light-y:${num(sc.lightY)}`,
    `--amb-key-light-intensity:${num(sc.key)}`,
    `--amb-fill-light-intensity:${num(sc.fill)}`,
    `--amb-light-hue:${num(sc.hue)}`,
    `--amb-light-saturation:${num(sc.saturation)}%`,
  ].join(';') + ';';
  if (transparent || layer === 'foreground' || bg.transparent) style += 'background:transparent;';
  else if (bg.lit) style += `--amb-albedo:${bg.color};background:var(--amb-lit);`;
  else style += `background:${bg.color};`;
  const ordered = paintOrder(variant.shapes);
  const rank = new Map(ordered.map((s, i) => [s.id, i]));
  const byId = new Map(ordered.map((s) => [s.id, s]));
  const drawn = (s) => s && !s.hidden && (layer === 'all' || s.layer === layer);
  const patches = new Map();
  for (const cr of variant.crossings || []) {
    const over = byId.get(cr.over);
    const under = byId.get(cr.under);
    if (!over || !under || over.hidden || !drawn(under)) continue;
    if (rank.get(over.id) > rank.get(under.id)) continue; // already on top
    if (!patches.has(under.id)) patches.set(under.id, []);
    patches.get(under.id).push(over);
  }
  const shapes = ordered
    .filter(drawn)
    .map((s) => shapeMarkup(s, sc) + (patches.get(s.id) || [])
      .sort((a, b) => rank.get(a.id) - rank.get(b.id))
      .map((o) => crossingMarkup(o, s, sc))
      .join(''))
    .join('');
  return `<div class="ir-stage" style="${style}">${shapes}</div>`;
}
