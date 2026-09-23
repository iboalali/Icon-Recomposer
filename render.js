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
/* Frost scales ambient.css's glass pane: 0 is clear glass, 0.3 is ambient.css's
   own fit, 1 is a near-opaque milky pane. The pane keeps the tone it has at the
   fit, so more frost turns it milkier, not darker. */
.ir-shape.amb-mat-glass {
  --_ir-a0: calc(
    (0.232 - var(--amb-fill-light-intensity) * 0.017) *
      (0.245 + var(--_glass-body) * 0.755 + var(--_glass-slab2) * 0.09)
  );
  --_ir-lo: min(1, var(--ir-frost) / 0.3);
  --_ir-hi: max(0, (var(--ir-frost) - 0.3) / 0.7);
  --_glass-lightness: calc(var(--_glass-veil) / var(--_ir-a0) * 100%);
  --_glass-alpha: calc(var(--_ir-a0) * var(--_ir-lo) + (0.82 - var(--_ir-a0)) * var(--_ir-hi));
  --_glass-blur: calc(
    (var(--amb-elevation) * 1.51 + var(--amb-thickness) * 0.63) * var(--_ir-lo) * 1px + var(--_ir-hi) * 6px
  );
}
.ir-edge {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  --_g: max(0, min(var(--amb-thickness), 1));
  --_cw: max(-1 * var(--amb-thickness), min(var(--amb-chamfer-width), var(--amb-thickness)));
  --_fw: max(-1 * var(--amb-thickness), min(var(--amb-fillet-width), var(--amb-thickness)));
  --_k: var(--amb-key-light-intensity);
  --_f: var(--amb-fill-light-intensity);
  --_tint: color-mix(in oklab, oklch(from var(--amb-lit) calc(l + (1 - l) * 0.55) c h), white calc(var(--ir-edge-shine) * 100%));
  --_dark: hsl(var(--amb-light-hue) var(--amb-light-saturation) 0%);
  --_chl: max(0, min(1, var(--ir-chamfer) * var(--_g) * (var(--_k) * 1.57 + var(--_f) * 0.85 - 1.03)));
  --_csh: max(0, min(1, var(--ir-chamfer) * var(--_g) * ((var(--_k) - var(--_f)) * 0.19 + 0.24)));
  --_fhl: max(0, min(1, var(--ir-fillet) * var(--_g) * (var(--_k) * 1.44 + var(--_f) * 0.85 - 0.99)));
  --_fsh: max(0, min(1, var(--ir-fillet) * var(--_g) * ((var(--_k) - var(--_f)) * 0.23 + 0.3)));
  box-shadow:
    inset calc(var(--amb-light-x) * var(--_cw) * -1px) calc(var(--amb-light-y) * var(--_cw) * -1px) 0 0
      color-mix(in oklab, var(--_tint) calc(var(--_chl) * 100%), transparent),
    inset calc(var(--amb-light-x) * var(--_cw) * 1px) calc(var(--amb-light-y) * var(--_cw) * 1px) 0 0
      color-mix(in oklab, var(--_dark) calc(var(--_csh) * 100%), transparent),
    inset calc(var(--amb-light-x) * var(--_fw) * -1.4px) calc(var(--amb-light-y) * var(--_fw) * -1.4px) 2px 0
      color-mix(in oklab, var(--_tint) calc(var(--_fhl) * 100%), transparent),
    inset calc(var(--amb-light-x) * var(--_fw) * 1.4px) calc(var(--amb-light-y) * var(--_fw) * 1.4px) 2px 0
      color-mix(in oklab, var(--_dark) calc(var(--_fsh) * 100%), transparent);
}
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

// extra: CSS appended to the element and its glow, e.g. a crossing clip-path.
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
    '--amb-chamfer:0',
    '--amb-fillet:0',
    `--ir-chamfer:${st.chamfer ? 1 : 0}`,
    `--amb-chamfer-width:${num(st.chamferWidth)}`,
    `--ir-fillet:${st.fillet ? 1 : 0}`,
    `--amb-fillet-width:${num(st.filletWidth)}`,
    `--ir-edge-shine:${num(st.edgeShine)}`,
    `--ir-frost:${num(st.frost)}`,
    `--amb-curve-scale:${num(st.curveScale)}`,
    `--amb-grain-amount:${num(st.grain)}`,
  ].join(';');
  const geo = geometryCss(shape) + extra;
  const opacity = st.opacity < 1 ? `opacity:${num(st.opacity)};` : '';
  let out = '';
  if (st.glow && st.glowSize > 0) {
    out += `<div class="ir-halo" style="${geo}${opacity}box-shadow:0 0 ${num(st.glowSize)}px ${num(st.glowSize / 3)}px ${st.glowColor}"></div>`;
  }
  const edge = st.chamfer || st.fillet ? '<div class="ir-edge"></div>' : '';
  out += `<div class="${classes.join(' ')}" style="${geo}${opacity}${vars}">${edge}</div>`;
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

// Moves every edge of a convex polygon (in outline()'s winding) inward by d.
function insetPolygon(pts, d) {
  const n = pts.length;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    lines.push([ax + nx * d, ay + ny * d, bx - ax, by - ay]);
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const [px, py, dx, dy] = lines[(i + lines.length - 1) % lines.length];
    const [qx, qy, ex, ey] = lines[i];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) {
      out.push([qx, qy]);
      continue;
    }
    const t = ((qx - px) * ey - (qy - py) * ex) / den;
    out.push([px + dx * t, py + dy * t]);
  }
  return out;
}

const clipCss = (pts) => `clip-path:polygon(${pts.map(([x, y]) => `${num(x)}px ${num(y)}px`).join(',')});`;

// How far a shape's paint can reach past its outline: ambient.css's outermost
// drop-shadow layer (offset + blur + spread at the longest light component),
// plus its glow.
function inkReach(shape) {
  const { elevation: e, thickness: k, glow, glowSize } = shape.style;
  return e * 6.8 + k * 3.8 + e * 4.8 + k * 2.7 + 1 + (glow ? glowSize * 1.4 : 0) + 2;
}

const ring = (pts) => `M${pts.map(([x, y]) => `${num(x)} ${num(y)}`).join('L')}Z`;

// Where `over` crosses `under` against the paint order, `over` is put on top
// without painting anything twice, so translucent shapes (glass, opacity) look
// the same as at a natural crossing:
// - a copy of `over`, drawn right after `under` and clipped to `under`'s
//   outline, shows `over`'s body and its shadow on `under` (overCopy);
// - `under` gets a hole where `over` lies outside it, so `under`'s shadow
//   never lands on `over`; the even-odd rule keeps `under`'s body where they
//   overlap;
// - the original `over` gets a hole where they overlap, which the copy covers.
// Shapes that paint after `under` still cover all of it.
function overCopy(over, under, scene) {
  return shapeMarkup(over, scene, clipCss(toBox(over, outline(under))));
}

// Holes are inset by `overlap` canvas units (about 1.25 output pixels) so that
// the shape on the other side of a hole edge still paints across it. Two
// anti-aliased edges meeting exactly would let the background show through as
// a hairline.
// holes: { over: shapes drawn over this one, under: shapes this one is drawn over }
function crossingClip(shape, holes, overlap) {
  const pad = inkReach(shape);
  let d = ring([[-pad, -pad], [shape.w + pad, -pad], [shape.w + pad, shape.h + pad], [-pad, shape.h + pad]]);
  for (const over of holes.over) {
    const hole = insetPolygon(outline(over), overlap);
    d += ring(toBox(shape, hole));
    const shared = clipPolygon(hole, outline(shape));
    if (shared.length > 2) d += ring(toBox(shape, shared));
  }
  for (const under of holes.under) {
    const shared = clipPolygon(outline(shape), outline(under));
    if (shared.length > 2) d += ring(toBox(shape, insetPolygon(shared, overlap)));
  }
  return `clip-path:path(evenodd,'${d}');`;
}

// layer: 'all' (the composite), 'foreground' (no background) or 'background'.
// pxPerUnit: output pixels per canvas unit, which sizes the crossing seam overlap.
export function stageMarkup(variant, { layer = 'all', transparent = false, pxPerUnit = 4 } = {}) {
  const overlap = 1.25 / pxPerUnit;
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
  const coveredBy = new Map();
  for (const cr of variant.crossings || []) {
    const over = byId.get(cr.over);
    const under = byId.get(cr.under);
    if (!over || !under || over.hidden || !drawn(under)) continue;
    if (rank.get(over.id) > rank.get(under.id)) continue; // already on top
    if (!patches.has(under.id)) patches.set(under.id, []);
    patches.get(under.id).push(over);
    if (!coveredBy.has(over.id)) coveredBy.set(over.id, []);
    coveredBy.get(over.id).push(under);
  }
  const shapes = ordered
    .filter(drawn)
    .map((s) => {
      const overs = (patches.get(s.id) || []).sort((a, b) => rank.get(a.id) - rank.get(b.id));
      const unders = coveredBy.get(s.id) || [];
      const clip = overs.length || unders.length ? crossingClip(s, { over: overs, under: unders }, overlap) : '';
      return shapeMarkup(s, sc, clip) + overs.map((o) => overCopy(o, s, sc)).join('');
    })
    .join('');
  return `<div class="ir-stage" style="${style}">${shapes}</div>`;
}
