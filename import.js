// import.js — SVG / VectorDrawable parse → layers (PLAN §13).
//
// Both formats reduce to one intermediate: { dRaw, matrix, fill, fillRule,
// fillAlpha, stroke, name }. A format-specific front-end produces those; one
// shared back-end normalizes each `d` to absolute M/L/C/Z, BAKES the transform
// into coordinates (VD <group> has no skew/general matrix, so we must bake),
// resolves fill→baseColor, and emits layers in document = paint order.

import * as P from './path.js';
import { parseColor, toHex, toHexA } from './color.js';
import { defaultLayer, defaultMaterial, newId } from './model.js';

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const AAPT_NS = 'http://schemas.android.com/aapt';

// ---- public entry ----
export function importVector(text, filename = '') {
  const warnings = [];
  try {
    const isVd = /\.xml$/i.test(filename) ? true : /\.svg$/i.test(filename) ? false : /<\s*vector[\s>]/.test(text);
    const parsed = isVd ? parseVd(text, warnings) : parseSvg(text, warnings);
    const layers = buildLayers(parsed.items, parsed.baseMatrix, warnings);
    if (!layers.length) warnings.push('No drawable paths were found.');
    return { ok: true, layers, viewport: parsed.viewport, warnings };
  } catch (e) {
    return { ok: false, error: e.message || String(e), warnings };
  }
}

// ---- shared back-end ----
function buildLayers(items, baseMatrix, warnings) {
  const layers = [];
  items.forEach((it, idx) => {
    if (!it.dRaw || !it.dRaw.trim()) return;
    let segs = P.parse(it.dRaw);
    let m = it.matrix || P.identity();
    if (baseMatrix) m = P.multiply(baseMatrix, m);
    const localBox = P.bbox(segs); // pre-bake, for objectBoundingBox gradient mapping
    if (!P.isIdentity(m)) segs = P.transform(segs, m);
    const d = P.serialize(segs);
    if (!d) return;

    const material = defaultMaterial();
    // Imported art is reproduced faithfully (flat) — colors match the source
    // rather than being shaded by the light. Emboss is an effect the user opts
    // into per layer.
    material.fillMode = 'solid';
    if (it.fill == null) {
      // No fill → stroke-only (passthrough) if there's a stroke, else default.
      if (it.stroke) {
        material.fillNone = true;
      } else {
        material.baseColor = '#888888';
      }
    } else {
      material.baseColor = toHex(it.fill);
      material.fillAlpha = it.fill.a == null ? 1 : it.fill.a; // element opacity
    }
    // A captured gradient becomes a true gradient fill (geometry baked to
    // absolute by the same matrix as the path; the averaged baseColor stays as
    // the swatch fallback).
    if (it.gradient) {
      const g = bakeImportedGradient(it.gradient, m, localBox);
      if (g) {
        material.fillMode = 'gradient';
        material.gradient = g;
      }
    }
    if (it.stroke) {
      material.stroke = {
        color: toHexA(it.stroke),
        width: it.stroke.width == null ? 1 : it.stroke.width,
        cap: it.stroke.cap || 'butt',
        join: it.stroke.join || 'miter',
      };
    }

    layers.push(
      defaultLayer({
        id: newId(),
        name: it.name || `Layer ${idx + 1}`,
        pathData: d,
        fillRule: it.fillRule === 'evenOdd' ? 'evenOdd' : 'nonZero',
        material,
      })
    );
  });
  return layers;
}

// Convert a captured import gradient to the model's gradient (absolute coords),
// baking the shape matrix `m` so it lines up with the baked pathData. SVG
// objectBoundingBox fractions are first mapped onto the shape's local bbox.
function bakeImportedGradient(g, m, localBox) {
  if (!g || !Array.isArray(g.stops) || g.stops.length < 2) return null;
  const obb = g.units === 'objectBoundingBox';
  const w = localBox.maxX - localBox.minX;
  const h = localBox.maxY - localBox.minY;
  const toAbs = (x, y) => {
    if (obb) { x = localBox.minX + x * w; y = localBox.minY + y * h; }
    return P.applyPoint(m, x, y);
  };
  const mscale = (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;
  const stops = g.stops.map((s) => ({ offset: s.offset, color: s.color, alpha: s.alpha }));
  if (g.type === 'radial') {
    const [cx, cy] = toAbs(g.cx, g.cy);
    let r = obb ? g.r * ((w + h) / 2) : g.r;
    r = Math.abs(r * mscale) || 1;
    return { type: 'radial', cx, cy, r, stops };
  }
  const [x1, y1] = toAbs(g.x1, g.y1);
  const [x2, y2] = toAbs(g.x2, g.y2);
  return { type: 'linear', x1, y1, x2, y2, stops };
}

// ---- SVG front-end ----
function parseSvg(text, warnings) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not parse SVG.');
  const root = doc.documentElement;

  // Attach offscreen so getComputedStyle resolves classes/inheritance.
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden';
  const live = document.importNode(root, true);
  host.appendChild(live);
  document.body.appendChild(host);

  try {
    let viewport = { width: 24, height: 24 };
    let baseMatrix = null;
    const vb = (live.getAttribute('viewBox') || '').trim();
    if (vb) {
      const a = vb.split(/[\s,]+/).map(Number);
      if (a.length === 4) {
        viewport = { width: a[2], height: a[3] };
        if (a[0] !== 0 || a[1] !== 0) baseMatrix = P.translate(-a[0], -a[1]);
      }
    } else {
      const w = parseFloat(live.getAttribute('width'));
      const h = parseFloat(live.getAttribute('height'));
      if (w > 0 && h > 0) viewport = { width: w, height: h };
    }

    const items = [];
    walkSvg(live, P.identity(), items, warnings, live);
    return { items, viewport, baseMatrix };
  } finally {
    host.remove();
  }
}

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

function walkSvg(el, parentMatrix, items, warnings, rootForUse) {
  if (el.nodeType !== 1) return;
  const tag = el.tagName.toLowerCase().replace(/^.*:/, '');

  if (tag === 'defs' || tag === 'symbol' || tag === 'clippath' || tag === 'mask' || tag === 'metadata') return;
  if (tag === 'text' || tag === 'tspan') {
    warnings.push('<text> is unsupported (needs font outlining) — skipped.');
    return;
  }

  const own = P.parseTransformAttr(el.getAttribute('transform'));
  const matrix = P.multiply(parentMatrix, own);

  if (tag === 'use') {
    const href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    const id = href.replace(/^#/, '');
    const target = id && rootForUse.querySelector(`#${CSS.escape(id)}`);
    if (target) {
      const x = parseFloat(el.getAttribute('x')) || 0;
      const y = parseFloat(el.getAttribute('y')) || 0;
      const useMatrix = P.multiply(matrix, P.translate(x, y));
      walkSvg(target, useMatrix, items, warnings, rootForUse);
    }
    return;
  }

  if (SHAPE_TAGS.has(tag)) {
    const dRaw = shapeToPath(el, tag, warnings);
    if (dRaw) {
      const style = getComputedStyle(el);
      const item = resolveSvgPaint(el, tag, style, rootForUse);
      item.dRaw = dRaw;
      item.matrix = matrix;
      item.name = el.getAttribute('id') || el.getAttribute('class') || cap(tag);
      items.push(item);
    }
    return;
  }

  // Container (svg, g, a, ...) → recurse.
  for (const child of el.children) walkSvg(child, matrix, items, warnings, rootForUse);
}

function resolveSvgPaint(el, tag, style, root) {
  const opacity = clamp01(parseFloat(style.opacity) || 1);

  // line/polyline are unfilled by nature unless explicitly filled.
  let fill = parseColor(style.fill);
  let gradient = null;
  if (style.fill === 'none') fill = null;
  if ((style.fill || '').indexOf('url(') === 0) {
    // Capture the full gradient as a true gradient fill; also seed an averaged
    // base color as the swatch fallback (used if the gradient can't be parsed).
    gradient = extractSvgGradient(root, style.fill);
    fill = resolveSvgGradientColor(root, style.fill) || parseColor('#888888');
  }
  if (fill) {
    const fo = clamp01(parseFloat(style.fillOpacity) || 1);
    fill = { ...fill, a: (fill.a == null ? 1 : fill.a) * fo * opacity };
  }
  const fillRule = (style.fillRule || 'nonzero').toLowerCase() === 'evenodd' ? 'evenOdd' : 'nonZero';

  let stroke = null;
  const sc = parseColor(style.stroke);
  if (style.stroke && style.stroke !== 'none' && sc) {
    const so = clamp01(parseFloat(style.strokeOpacity) || 1);
    const w = parseFloat(style.strokeWidth);
    stroke = {
      ...sc,
      a: (sc.a == null ? 1 : sc.a) * so * opacity,
      width: isFinite(w) ? w : 1,
      cap: style.strokeLinecap || 'butt',
      join: style.strokeLinejoin || 'miter',
    };
  }
  return { fill, fillRule, stroke, gradient };
}

// Capture a full SVG gradient referenced by `url(#id)` into the model gradient
// shape { type, units, geometry, stops:[{offset,color,alpha}] }. Geometry stays
// in the gradient's declared units (objectBoundingBox|userSpaceOnUse) — bakeImportedGradient
// converts to absolute. Follows xlink:href for borrowed stops. Returns null if
// fewer than two stops resolve.
function extractSvgGradient(root, fillStr) {
  const m = /url\(["']?#?.*?#?([^"')#]+)["']?\)/.exec(fillStr || '');
  if (!root || !m) return null;
  const grad = root.querySelector(`linearGradient[id="${m[1]}"], radialGradient[id="${m[1]}"]`);
  if (!grad) return null;
  let stopsEl = grad.querySelectorAll('stop');
  let cur = grad, guard = 0;
  while (cur && (!stopsEl || !stopsEl.length) && guard++ < 5) {
    const href = cur.getAttribute('href') || cur.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    const hm = /^#(.+)$/.exec(href.trim());
    cur = hm ? root.querySelector(`linearGradient[id="${hm[1]}"], radialGradient[id="${hm[1]}"]`) : null;
    if (cur) stopsEl = cur.querySelectorAll('stop');
  }
  if (!stopsEl || !stopsEl.length) return null;
  const stops = [];
  for (const s of stopsEl) {
    const cs = getComputedStyle(s);
    const c = parseColor(cs.stopColor || s.getAttribute('stop-color')) || { r: 0, g: 0, b: 0, a: 1 };
    const opStr = cs.stopOpacity != null && cs.stopOpacity !== '' ? cs.stopOpacity : s.getAttribute('stop-opacity') || '1';
    const op = parseFloat(opStr);
    let off = (s.getAttribute('offset') || '0').trim();
    off = off.endsWith('%') ? parseFloat(off) / 100 : parseFloat(off);
    stops.push({ offset: isFinite(off) ? clamp01(off) : 0, color: toHex(c), alpha: isFinite(op) ? clamp01(op) : 1 });
  }
  if (stops.length < 2) return null;
  const units = grad.getAttribute('gradientUnits') === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox';
  const ga = (name, dflt) => { const v = parseFloat(grad.getAttribute(name)); return isFinite(v) ? v : dflt; };
  if (grad.tagName.toLowerCase().replace(/^.*:/, '') === 'radialgradient') {
    return { type: 'radial', units, cx: ga('cx', 0.5), cy: ga('cy', 0.5), r: ga('r', 0.5), stops };
  }
  return { type: 'linear', units, x1: ga('x1', 0), y1: ga('y1', 0), x2: ga('x2', 1), y2: ga('y2', 0), stops };
}

// Seed a single base color from an SVG gradient referenced by `url(#id)`:
// average its stop colors. Follows xlink:href/href when a gradient borrows its
// stops from another. Returns null if the gradient or its stops can't be found.
function resolveSvgGradientColor(root, fillStr) {
  const m = /url\(["']?#?.*?#?([^"')#]+)["']?\)/.exec(fillStr || '');
  if (!root || !m) return null;
  let grad = root.querySelector(`linearGradient[id="${m[1]}"], radialGradient[id="${m[1]}"]`);
  let stops = grad ? grad.querySelectorAll('stop') : null;
  let guard = 0;
  while (grad && (!stops || !stops.length) && guard++ < 5) {
    const href = grad.getAttribute('href') || grad.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    const hm = /^#(.+)$/.exec(href.trim());
    grad = hm ? root.querySelector(`linearGradient[id="${hm[1]}"], radialGradient[id="${hm[1]}"]`) : null;
    stops = grad ? grad.querySelectorAll('stop') : null;
  }
  if (!stops || !stops.length) return null;
  let r = 0, g = 0, b = 0, n = 0;
  for (const s of stops) {
    const cs = getComputedStyle(s);
    const c = parseColor(cs.stopColor || s.getAttribute('stop-color'));
    if (c) { r += c.r; g += c.g; b += c.b; n += 1; }
  }
  if (!n) return null;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), a: 1 };
}

function shapeToPath(el, tag, warnings) {
  const num = (a, d = 0) => {
    const v = parseFloat(el.getAttribute(a));
    return isFinite(v) ? v : d;
  };
  switch (tag) {
    case 'path':
      return el.getAttribute('d') || '';
    case 'rect': {
      const x = num('x');
      const y = num('y');
      const w = num('width');
      const h = num('height');
      if (w <= 0 || h <= 0) return '';
      let rx = el.hasAttribute('rx') ? num('rx') : NaN;
      let ry = el.hasAttribute('ry') ? num('ry') : NaN;
      if (!isFinite(rx) && isFinite(ry)) rx = ry;
      if (!isFinite(ry) && isFinite(rx)) ry = rx;
      rx = isFinite(rx) ? Math.min(rx, w / 2) : 0;
      ry = isFinite(ry) ? Math.min(ry, h / 2) : 0;
      if (rx <= 0 || ry <= 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}` +
        `V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
        `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      );
    }
    case 'circle': {
      const cx = num('cx');
      const cy = num('cy');
      const r = num('r');
      if (r <= 0) return '';
      return `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
    }
    case 'ellipse': {
      const cx = num('cx');
      const cy = num('cy');
      const rx = num('rx');
      const ry = num('ry');
      if (rx <= 0 || ry <= 0) return '';
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'line':
      return `M${num('x1')} ${num('y1')}L${num('x2')} ${num('y2')}`;
    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).filter((v) => isFinite(v));
      if (pts.length < 4) return '';
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      if (tag === 'polygon') d += 'Z';
      return d;
    }
  }
  return '';
}

// ---- VectorDrawable front-end ----
function parseVd(text, warnings) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not parse VectorDrawable XML.');
  const vector = doc.documentElement;
  if (vector.tagName.toLowerCase().replace(/^.*:/, '') !== 'vector') {
    throw new Error('Root element is not <vector>.');
  }

  const vw = parseFloat(vdAttr(vector, 'viewportWidth')) || 24;
  const vh = parseFloat(vdAttr(vector, 'viewportHeight')) || 24;

  const items = [];
  walkVd(vector, P.identity(), items, warnings);
  return { items, viewport: { width: vw, height: vh }, baseMatrix: null };
}

function walkVd(el, parentMatrix, items, warnings) {
  for (const child of el.children) {
    const tag = child.tagName.toLowerCase().replace(/^.*:/, '');
    if (tag === 'group') {
      const m = P.multiply(parentMatrix, vdGroupMatrix(child));
      walkVd(child, m, items, warnings);
    } else if (tag === 'path') {
      const item = resolveVdPath(child, warnings);
      if (item.dRaw) {
        item.matrix = parentMatrix;
        items.push(item);
      }
    } else if (tag === 'clip-path') {
      warnings.push('<clip-path> is ignored.');
    }
  }
}

function vdGroupMatrix(g) {
  const f = (a) => parseFloat(vdAttr(g, a));
  const rotation = f('rotation') || 0;
  const scaleX = isFinite(f('scaleX')) ? f('scaleX') : 1;
  const scaleY = isFinite(f('scaleY')) ? f('scaleY') : 1;
  const tx = f('translateX') || 0;
  const ty = f('translateY') || 0;
  const px = f('pivotX') || 0;
  const py = f('pivotY') || 0;
  let m = P.translate(px + tx, py + ty);
  m = P.multiply(m, P.rotate(rotation));
  m = P.multiply(m, P.scale(scaleX, scaleY));
  m = P.multiply(m, P.translate(-px, -py));
  return m;
}

function resolveVdPath(el, warnings) {
  const dRaw = vdAttr(el, 'pathData') || '';
  const fillType = (vdAttr(el, 'fillType') || 'nonZero').toLowerCase() === 'evenodd' ? 'evenOdd' : 'nonZero';

  let fill = null;
  let gradient = null;
  const fillColorStr = vdAttr(el, 'fillColor');
  const grad = findGradient(el, 'android:fillColor');
  if (fillColorStr) {
    fill = resolveVdColor(fillColorStr, warnings);
  } else if (grad) {
    fill = seedFromGradient(grad); // averaged base color (swatch fallback)
    gradient = extractVdGradient(grad); // full gradient (true fill)
  }
  if (fill) {
    const fa = parseFloat(vdAttr(el, 'fillAlpha'));
    if (isFinite(fa)) fill = { ...fill, a: (fill.a == null ? 1 : fill.a) * clamp01(fa) };
  }

  let stroke = null;
  const strokeColorStr = vdAttr(el, 'strokeColor');
  const sc = strokeColorStr ? resolveVdColor(strokeColorStr, warnings) : null;
  if (sc) {
    const sw = parseFloat(vdAttr(el, 'strokeWidth'));
    const sa = parseFloat(vdAttr(el, 'strokeAlpha'));
    stroke = {
      ...sc,
      a: (sc.a == null ? 1 : sc.a) * (isFinite(sa) ? clamp01(sa) : 1),
      width: isFinite(sw) ? sw : 1,
      cap: vdAttr(el, 'strokeLineCap') || 'butt',
      join: vdAttr(el, 'strokeLineJoin') || 'miter',
    };
  }

  const name = vdAttr(el, 'name') || 'Path';
  return { dRaw, fill, fillRule: fillType, stroke, name, gradient };
}

// Capture a full VD gradient (<gradient> with <item> stops, or the
// start/center/end attribute form) into the model gradient shape. VD coords are
// absolute (userSpaceOnUse); sweep has no SVG equivalent so it's dropped (the
// averaged base color is used instead). Returns null if fewer than two stops.
function extractVdGradient(grad) {
  const stops = [];
  for (const it of grad.children) {
    if (it.tagName.toLowerCase().replace(/^.*:/, '') !== 'item') continue;
    const c = resolveVdColor(vdAttr(it, 'color'), []);
    const off = parseFloat(vdAttr(it, 'offset'));
    if (c) stops.push({ offset: isFinite(off) ? clamp01(off) : 0, color: toHex(c), alpha: c.a == null ? 1 : c.a });
  }
  if (stops.length < 2) {
    const sc = resolveVdColor(vdAttr(grad, 'startColor'), []);
    const cc = resolveVdColor(vdAttr(grad, 'centerColor'), []);
    const ec = resolveVdColor(vdAttr(grad, 'endColor'), []);
    const arr = [];
    if (sc) arr.push({ offset: 0, color: toHex(sc), alpha: sc.a == null ? 1 : sc.a });
    if (cc) arr.push({ offset: 0.5, color: toHex(cc), alpha: cc.a == null ? 1 : cc.a });
    if (ec) arr.push({ offset: 1, color: toHex(ec), alpha: ec.a == null ? 1 : ec.a });
    if (arr.length >= 2) { stops.length = 0; stops.push(...arr); }
  }
  if (stops.length < 2) return null;
  const type = (vdAttr(grad, 'type') || 'linear').toLowerCase();
  const f = (a, d) => { const v = parseFloat(vdAttr(grad, a)); return isFinite(v) ? v : d; };
  if (type === 'radial') {
    return { type: 'radial', units: 'userSpaceOnUse', cx: f('centerX', 0), cy: f('centerY', 0), r: f('gradientRadius', 1), stops };
  }
  if (type === 'sweep') return null; // not renderable in SVG → keep flat color
  return { type: 'linear', units: 'userSpaceOnUse', x1: f('startX', 0), y1: f('startY', 0), x2: f('endX', 0), y2: f('endY', 0), stops };
}

function findGradient(pathEl, attrName) {
  for (const child of pathEl.children) {
    const tag = child.tagName.toLowerCase().replace(/^.*:/, '');
    if (tag === 'attr') {
      const nm = child.getAttribute('name') || child.getAttributeNS(AAPT_NS, 'name');
      if (nm === attrName) {
        for (const gc of child.children) {
          if (gc.tagName.toLowerCase().replace(/^.*:/, '') === 'gradient') return gc;
        }
      }
    }
  }
  return null;
}

function seedFromGradient(grad) {
  const items = Array.from(grad.children).filter((c) => c.tagName.toLowerCase().replace(/^.*:/, '') === 'item');
  if (items.length) {
    const mid = items[Math.floor(items.length / 2)];
    const c = resolveVdColor(vdAttr(mid, 'color'), []);
    if (c) return { ...c, a: 1 };
  }
  // startColor/centerColor/endColor attribute form
  const c = resolveVdColor(vdAttr(grad, 'startColor') || vdAttr(grad, 'centerColor'), []);
  return c ? { ...c, a: 1 } : parseColor('#888888');
}

// Android color hex: alpha is FIRST for 4- and 8-digit forms.
function resolveVdColor(str, warnings) {
  if (!str) return null;
  const s = str.trim();
  if (s[0] === '@' || s[0] === '?') {
    warnings.push(`Color reference "${s}" can't be resolved — using a default.`);
    return parseColor('#888888');
  }
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3) {
      return { r: hx(h[0] + h[0]), g: hx(h[1] + h[1]), b: hx(h[2] + h[2]), a: 1 };
    }
    if (h.length === 4) {
      return { a: hx(h[0] + h[0]) / 255, r: hx(h[1] + h[1]), g: hx(h[2] + h[2]), b: hx(h[3] + h[3]) };
    }
    if (h.length === 6) {
      return { r: hx(h.slice(0, 2)), g: hx(h.slice(2, 4)), b: hx(h.slice(4, 6)), a: 1 };
    }
    if (h.length === 8) {
      return { a: hx(h.slice(0, 2)) / 255, r: hx(h.slice(2, 4)), g: hx(h.slice(4, 6)), b: hx(h.slice(6, 8)) };
    }
  }
  return parseColor(s);
}

// Read an android: attribute, tolerant of namespace resolution differences.
function vdAttr(el, name) {
  return el.getAttributeNS(ANDROID_NS, name) || el.getAttribute('android:' + name) || el.getAttribute(name) || '';
}

// ---- small helpers ----
function hx(s) {
  return parseInt(s, 16);
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
