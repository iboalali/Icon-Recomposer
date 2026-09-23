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

function geometryCss(shape) {
  const radius = shape.kind === 'ellipse' ? '50%' : `${num(shape.radius)}px`;
  let css = `left:${num(shape.x)}px;top:${num(shape.y)}px;width:${num(shape.w)}px;height:${num(shape.h)}px;border-radius:${radius};`;
  if (shape.rotation) css += `transform:rotate(${num(shape.rotation)}deg);`;
  return css;
}

// extra: CSS appended to the element (and its glow), e.g. a crossing clip-path.
// A copy (extra set) carries no data-id, so hit tests see only the original.
function shapeMarkup(shape, scene, extra = '') {
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
  const geo = geometryCss(shape) + extra;
  const opacity = st.opacity < 1 ? `opacity:${num(st.opacity)};` : '';
  let out = '';
  if (st.glow && st.glowSize > 0) {
    out += `<div class="ir-halo" style="${geo}${opacity}box-shadow:0 0 ${num(st.glowSize)}px ${num(st.glowSize / 3)}px ${st.glowColor}"></div>`;
  }
  const id = extra ? '' : ` data-id="${esc(shape.id)}"`;
  out += `<div class="${classes.join(' ')}"${id} style="${geo}${opacity}${vars}"></div>`;
  return out;
}

// Outline of a shape as a convex polygon in canvas coordinates. Rounded
// corners and ellipses are sampled finely enough to be invisible as facets.
function outline(shape, pad = 0) {
  const w = shape.w + pad * 2;
  const h = shape.h + pad * 2;
  const pts = [];
  if (shape.kind === 'ellipse' && !pad) {
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      pts.push([(Math.cos(a) * w) / 2, (Math.sin(a) * h) / 2]);
    }
  } else {
    const r = pad ? 0 : Math.min(shape.radius || 0, w / 2, h / 2);
    const corners = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]];
    for (const [cx, cy, start] of corners) {
      const steps = r ? 12 : 0;
      for (let i = 0; i <= steps; i++) {
        const a = ((start + (90 * i) / (steps || 1)) * Math.PI) / 180;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    }
  }
  const t = (shape.rotation * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const ox = shape.x + shape.w / 2;
  const oy = shape.y + shape.h / 2;
  return pts.map(([x, y]) => [ox + x * c - y * s, oy + x * s + y * c]);
}

// Canvas points → the element's own untransformed box (clip-path space).
function toBox(shape, pts) {
  const t = (shape.rotation * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const ox = shape.x + shape.w / 2;
  const oy = shape.y + shape.h / 2;
  return pts.map(([x, y]) => {
    const dx = x - ox;
    const dy = y - oy;
    return [dx * c + dy * s + shape.w / 2, -dx * s + dy * c + shape.h / 2];
  });
}

// Sutherland-Hodgman: subject clipped by a convex polygon (both counterclockwise
// or both clockwise, as outline() produces).
function clipPolygon(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const k = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]);
      }
    }
  }
  return out;
}

const clipCss = (pts) => `clip-path:polygon(${pts.map(([x, y]) => `${num(x)}px ${num(y)}px`).join(',')});`;

// How far a shape's drop shadow can reach past its outline (ambient.css's
// outermost layer: offset + blur + spread, at the longest light component).
function shadowReach(shape) {
  const { elevation: e, thickness: k } = shape.style;
  return e * 6.8 + k * 3.8 + e * 4.8 + k * 2.7 + 1;
}

// Puts `over` on top of `under` where they cross, with two copies of `over`
// drawn right after `under`, each at its real position and clipped with a
// clip-path (which also clips its shadow):
// 1. to `under`'s outline: `over`'s body and its shadow on `under`;
// 2. to `over`'s own outline within reach of `under`'s shadow: hides the
//    shadow `under` casts onto `over`, without doubling `over`'s shadow on
//    whatever lies around it.
// Shapes that paint after `under` still cover both copies.
function crossingMarkup(over, under, scene) {
  const onUnder = clipCss(toBox(over, outline(under)));
  const own = clipPolygon(outline(over), outline(under, shadowReach(under)));
  let out = shapeMarkup(over, scene, onUnder);
  if (own.length > 2) out += shapeMarkup(over, scene, clipCss(toBox(over, own)));
  return out;
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
