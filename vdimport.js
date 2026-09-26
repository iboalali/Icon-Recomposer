// vdimport.js: Android VectorDrawable → shapes plus a tracing guide.
//
// Shapes are lit boxes, so a path only becomes shapes when it is one:
// - an ellipse or a (rounded) rectangle, axis-aligned;
// - an outline made only of horizontal and vertical edges, which is split into
//   the fewest overlapping rectangles that cover it exactly (a # becomes its
//   four bars);
// - several separate subpaths, each of which is one of the above.
// Everything else is skipped and reported. Every path also goes into the
// guide, drawn faintly over the canvas, so skipped parts can be rebuilt by
// hand.

import * as P from './path.js';
import { CANVAS, newShape, defaultStyle } from './model.js';

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

// A VectorDrawable whose viewport is not the 108dp adaptive canvas is a plain
// icon: it is centered at the size a launcher foreground usually gives a 24dp
// icon (24 × 2.0625).
const ICON_SIZE = 49.5;

const ANDROID_COLORS = { white: '#ffffff', black: '#000000', transparent: '#000000' };

export function looksLikeVectorDrawable(text) {
  return /<\s*vector[\s>]/.test(text);
}

function attr(el, name) {
  return el.getAttributeNS(ANDROID_NS, name) || el.getAttribute(`android:${name}`) || el.getAttribute(name) || '';
}

const tagOf = (el) => el.tagName.toLowerCase().replace(/^.*:/, '');

// Android colors put alpha first (#AARRGGBB / #ARGB).
function parseColor(str, notes) {
  const s = (str || '').trim();
  if (!s) return null;
  const ref = /^@android:color\/(\w+)$/.exec(s);
  if (ref && ANDROID_COLORS[ref[1]]) return { hex: ANDROID_COLORS[ref[1]], alpha: ref[1] === 'transparent' ? 0 : 1 };
  if (s[0] === '@' || s[0] === '?') {
    notes.add(`The color ${s} is a resource reference, so a grey stand-in is used.`);
    return { hex: '#9e9e9e', alpha: 1 };
  }
  const h = s.replace('#', '');
  const x = (v) => parseInt(v, 16);
  const two = (c) => c + c;
  if (h.length === 3) return { hex: `#${two(h[0])}${two(h[1])}${two(h[2])}`, alpha: 1 };
  if (h.length === 4) return { hex: `#${two(h[1])}${two(h[2])}${two(h[3])}`, alpha: x(two(h[0])) / 255 };
  if (h.length === 6) return { hex: `#${h}`.toLowerCase(), alpha: 1 };
  if (h.length === 8) return { hex: `#${h.slice(2)}`.toLowerCase(), alpha: x(h.slice(0, 2)) / 255 };
  return null;
}

function groupMatrix(g) {
  const f = (a, d) => {
    const v = parseFloat(attr(g, a));
    return Number.isFinite(v) ? v : d;
  };
  const px = f('pivotX', 0);
  const py = f('pivotY', 0);
  let m = P.translate(px + f('translateX', 0), py + f('translateY', 0));
  m = P.multiply(m, P.rotate(f('rotation', 0)));
  m = P.multiply(m, P.scale(f('scaleX', 1), f('scaleY', 1)));
  return P.multiply(m, P.translate(-px, -py));
}

function gradientColor(pathEl, notes) {
  for (const child of pathEl.children) {
    if (tagOf(child) !== 'attr') continue;
    for (const g of child.children) {
      if (tagOf(g) !== 'gradient') continue;
      notes.add('Gradient fills become a single color from the middle of the gradient.');
      const items = [...g.children].filter((c) => tagOf(c) === 'item');
      const mid = items[Math.floor(items.length / 2)];
      return parseColor(mid ? attr(mid, 'color') : attr(g, 'centerColor') || attr(g, 'startColor'), notes);
    }
  }
  return null;
}

function collectPaths(el, matrix, out, notes) {
  for (const child of el.children) {
    const tag = tagOf(child);
    if (tag === 'group') collectPaths(child, P.multiply(matrix, groupMatrix(child)), out, notes);
    else if (tag === 'clip-path') notes.add('Clip paths are ignored.');
    else if (tag === 'path') {
      const d = attr(child, 'pathData');
      if (!d) continue;
      let fill = parseColor(attr(child, 'fillColor'), notes) || gradientColor(child, notes);
      const fillAlpha = parseFloat(attr(child, 'fillAlpha'));
      if (fill && Number.isFinite(fillAlpha)) fill = { ...fill, alpha: fill.alpha * fillAlpha };
      const stroke = parseColor(attr(child, 'strokeColor'), notes);
      out.push({
        name: attr(child, 'name'),
        d,
        matrix,
        fill: fill && fill.alpha > 0 ? fill : null,
        stroke: stroke && stroke.alpha > 0 ? stroke : null,
        evenOdd: attr(child, 'fillType').toLowerCase() === 'evenodd',
      });
    }
  }
}

// ---- geometry ----

function subpaths(segs) {
  const out = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let curved = false;
  for (const s of segs) {
    if (s.c === 'M') {
      cur = { pts: [[s.x, s.y]], curved: false };
      out.push(cur);
      [x, y] = [s.x, s.y];
    } else if (s.c === 'L') {
      cur.pts.push([s.x, s.y]);
      [x, y] = [s.x, s.y];
    } else if (s.c === 'C') {
      cur.curved = true;
      curved = true;
      for (let i = 1; i <= 16; i++) {
        const t = i / 16;
        const u = 1 - t;
        cur.pts.push([
          u * u * u * x + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
          u * u * u * y + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y,
        ]);
      }
      [x, y] = [s.x, s.y];
    }
  }
  for (const sp of out) {
    const [a, b] = [sp.pts[0], sp.pts[sp.pts.length - 1]];
    if (sp.pts.length > 1 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) sp.pts.pop();
  }
  return { list: out.filter((sp) => sp.pts.length > 2), curved };
}

function bboxOf(pts) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// Distance from p to the outline of an axis-aligned rounded rectangle.
function roundRectDistance(p, b, r) {
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const hx = (b.x1 - b.x0) / 2 - r;
  const hy = (b.y1 - b.y0) / 2 - r;
  const qx = Math.abs(p[0] - cx) - hx;
  const qy = Math.abs(p[1] - cy) - hy;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return Math.abs(outside + Math.min(Math.max(qx, qy), 0) - r);
}

// One subpath as an ellipse or a rounded rectangle, or null.
function simpleShape(sp) {
  const b = bboxOf(sp.pts);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  if (w < 0.2 || h < 0.2) return null;
  const tol = Math.max(0.06, Math.min(w, h) * 0.02);
  if (sp.curved) {
    const rx = w / 2;
    const ry = h / 2;
    const cx = b.x0 + rx;
    const cy = b.y0 + ry;
    const onEllipse = sp.pts.every(([x, y]) => Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry) < tol);
    if (onEllipse) return { kind: 'ellipse', x: b.x0, y: b.y0, w, h, radius: 0 };
  }
  let best = null;
  const steps = sp.curved ? 60 : 0;
  for (let i = 0; i <= steps; i++) {
    const r = (Math.min(w, h) / 2) * (i / (steps || 1));
    const err = Math.max(...sp.pts.map((p) => roundRectDistance(p, b, r)));
    if (!best || err < best.err) best = { r, err };
  }
  if (best.err < tol) return { kind: 'rect', x: b.x0, y: b.y0, w, h, radius: best.r };
  return null;
}

function windingAt(list, x, y) {
  let wn = 0;
  let crossings = 0;
  for (const sp of list) {
    const pts = sp.pts;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= y) !== (by <= y)) {
        const t = (y - ay) / (by - ay);
        if (ax + t * (bx - ax) > x) {
          crossings++;
          wn += by > ay ? 1 : -1;
        }
      }
    }
  }
  return { wn, crossings };
}

const axisAligned = (list) => list.every((sp) => sp.pts.every((p, i) => {
  const q = sp.pts[(i + 1) % sp.pts.length];
  return Math.abs(p[0] - q[0]) < 1e-3 || Math.abs(p[1] - q[1]) < 1e-3;
}));

// Covers a region with straight edges by the fewest overlapping rectangles:
// compress the plane to a grid on the distinct edge coordinates, list every
// maximal all-inside rectangle, then greedily take the one covering the most
// uncovered area until nothing is left.
function rectilinearCover(list, evenOdd) {
  const key = (v) => Math.round(v * 1000) / 1000;
  const xs = [...new Set(list.flatMap((sp) => sp.pts.map((p) => key(p[0]))))].sort((a, b) => a - b);
  const ys = [...new Set(list.flatMap((sp) => sp.pts.map((p) => key(p[1]))))].sort((a, b) => a - b);
  if (xs.length > 60 || ys.length > 60) return null;
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const inside = [];
  for (let i = 0; i < nx; i++) {
    inside.push([]);
    for (let j = 0; j < ny; j++) {
      const w = windingAt(list, (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2);
      inside[i].push(evenOdd ? w.crossings % 2 === 1 : w.wn !== 0);
    }
  }
  const full = (i0, i1, j0, j1) => {
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (!inside[i][j]) return false;
    return true;
  };
  const rects = [];
  for (let i0 = 0; i0 < nx; i0++) {
    for (let j0 = 0; j0 < ny; j0++) {
      if (!inside[i0][j0]) continue;
      for (let i1 = i0; i1 < nx && inside[i1][j0]; i1++) {
        let j1 = j0;
        while (j1 + 1 < ny && full(i0, i1, j1 + 1, j1 + 1)) j1++;
        const r = { i0, i1, j0, j1 };
        const grows = (i0 > 0 && full(i0 - 1, i0 - 1, j0, j1)) || (i1 + 1 < nx && full(i1 + 1, i1 + 1, j0, j1))
          || (j0 > 0 && full(i0, i1, j0 - 1, j0 - 1)) || (j1 + 1 < ny && full(i0, i1, j1 + 1, j1 + 1));
        if (!grows) rects.push(r);
      }
    }
  }
  const covered = inside.map((col) => col.map(() => false));
  const cellArea = (i, j) => (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
  const gain = (r) => {
    let a = 0;
    for (let i = r.i0; i <= r.i1; i++) for (let j = r.j0; j <= r.j1; j++) if (!covered[i][j]) a += cellArea(i, j);
    return a;
  };
  const chosen = [];
  for (;;) {
    let best = null;
    let bestGain = 1e-9;
    for (const r of rects) {
      const g = gain(r);
      if (g > bestGain) [best, bestGain] = [r, g];
    }
    if (!best) break;
    chosen.push(best);
    for (let i = best.i0; i <= best.i1; i++) for (let j = best.j0; j <= best.j1; j++) covered[i][j] = true;
  }
  return chosen.map((r) => ({
    kind: 'rect', x: xs[r.i0], y: ys[r.j0], w: xs[r.i1 + 1] - xs[r.i0], h: ys[r.j1 + 1] - ys[r.j0], radius: 0,
  }));
}

const containsBox = (a, b) => a.x0 <= b.x0 && a.y0 <= b.y0 && a.x1 >= b.x1 && a.y1 >= b.y1;

function convert(list, curved, evenOdd) {
  if (list.length === 1) {
    const one = simpleShape(list[0]);
    if (one) return [one];
  }
  if (!curved && axisAligned(list)) {
    const cover = rectilinearCover(list, evenOdd);
    if (cover && cover.length) return cover;
  }
  if (list.length > 1) {
    const boxes = list.map((sp) => bboxOf(sp.pts));
    const nested = boxes.some((a, i) => boxes.some((b, j) => i !== j && containsBox(a, b)));
    if (!nested) {
      const parts = list.map(simpleShape);
      if (parts.every(Boolean)) return parts;
    }
  }
  return null;
}

// ---- entry point ----

// Returns { shapes, guide, skipped, notes }. Shapes and guide paths are in
// canvas units.
export function importVectorDrawable(text, fileName = 'vector') {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('The file is not valid XML.');
  const root = xml.documentElement;
  if (tagOf(root) !== 'vector') throw new Error('The file is not an Android VectorDrawable (no <vector> root).');

  const vw = parseFloat(attr(root, 'viewportWidth')) || 24;
  const vh = parseFloat(attr(root, 'viewportHeight')) || 24;
  let place;
  if (Math.abs(vw - CANVAS) < 0.01 && Math.abs(vh - CANVAS) < 0.01) {
    place = P.identity();
  } else {
    const k = ICON_SIZE / Math.max(vw, vh);
    place = P.multiply(P.translate((CANVAS - vw * k) / 2, (CANVAS - vh * k) / 2), P.scale(k));
  }

  const notes = new Set();
  const paths = [];
  collectPaths(root, P.identity(), paths, notes);
  if (!paths.length) throw new Error('The VectorDrawable has no paths.');

  const shapes = [];
  const guide = [];
  const skipped = [];
  const counts = { rect: 0, ellipse: 0 };
  paths.forEach((p, index) => {
    const segs = P.transform(P.parse(p.d), P.multiply(place, p.matrix));
    const color = p.fill || p.stroke || { hex: '#9e9e9e', alpha: 1 };
    guide.push({ d: P.serialize(segs), fill: color.hex, evenOdd: p.evenOdd });
    const label = p.name || `Path ${index + 1}`;
    if (!p.fill) {
      skipped.push(`${label} (stroke only)`);
      return;
    }
    const { list, curved } = subpaths(segs);
    const parts = convert(list, curved, p.evenOdd);
    if (!parts) {
      skipped.push(label);
      return;
    }
    parts.forEach((g, i) => {
      const round = (v) => Math.round(v * 1000) / 1000;
      counts[g.kind] += 1;
      const auto = `${g.kind === 'ellipse' ? 'Ellipse' : 'Rectangle'} ${counts[g.kind]}`;
      let name = auto;
      if (p.name) name = parts.length > 1 ? `${p.name} ${i + 1}` : p.name;
      shapes.push(newShape(g.kind, {
        name,
        x: round(g.x), y: round(g.y), w: round(g.w), h: round(g.h), radius: round(g.radius),
        style: { ...defaultStyle(), color: color.hex, opacity: Math.round(color.alpha * 100) / 100 },
      }));
    });
  });
  const name = fileName.replace(/\.[^.]+$/, '');
  return { shapes, guide: { name, paths: guide, visible: true }, skipped, notes: [...notes] };
}
