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
    if (!P.isIdentity(m)) segs = P.transform(segs, m);
    const d = P.serialize(segs);
    if (!d) return;

    const material = defaultMaterial();
    if (it.fill == null) {
      // No fill → stroke-only (passthrough) if there's a stroke, else default.
      if (it.stroke) {
        material.fillNone = true;
        material.fillMode = 'solid';
      } else {
        material.baseColor = '#888888';
      }
    } else {
      material.baseColor = toHex(it.fill);
      material.fillAlpha = it.fill.a == null ? 1 : it.fill.a;
      material.fillMode = 'embossed'; // imported art gets the emboss treatment
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
      const item = resolveSvgPaint(el, tag, style);
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

function resolveSvgPaint(el, tag, style) {
  const opacity = clamp01(parseFloat(style.opacity) || 1);

  // line/polyline are unfilled by nature unless explicitly filled.
  let fill = parseColor(style.fill);
  if (style.fill === 'none') fill = null;
  if ((style.fill || '').indexOf('url(') === 0) {
    fill = parseColor('#888888'); // source gradient discarded → seed default
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
  return { fill, fillRule, stroke };
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
  const fillColorStr = vdAttr(el, 'fillColor');
  const grad = findGradient(el, 'android:fillColor');
  if (fillColorStr) {
    fill = resolveVdColor(fillColorStr, warnings);
  } else if (grad) {
    fill = seedFromGradient(grad); // discard gradient, seed baseColor from a stop
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
  return { dRaw, fill, fillRule: fillType, stroke, name };
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
