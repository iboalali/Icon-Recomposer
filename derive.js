// derive.js — the heart (PLAN §5, §12).
//
// authoring model (one light + per-layer materials) → derived model: a flat,
// ordered list of paths, each with a solid or gradient fill (+ optional stroke).
// One derivation, three renderers (svg / vd / png) → WYSIWYG for free.
//
// All gradient geometry lives in shared viewport space (userSpaceOnUse), so a
// single light stays coherent across every layer and maps 1:1 onto VD attrs.

import * as P from './path.js';
import { mix, parseColor, scaleAlpha, withAlpha, BLACK, WHITE } from './color.js';

const DEG = Math.PI / 180;

// Tunables (PLAN §12): shadow side slightly stronger than highlight reads
// more natural; shadow length scales with cot(elevation).
const A_HI = 0.6;
const A_LO = 0.9;
const SHADOW_LEN_K = 0.22; // fraction of canvas half-extent at 45°
const SHADOW_MAX_LEN = 0.6; // fraction of canvas half-extent
const SHEEN_COVERAGE = 0.45;

let gradSeq = 0;
function gradId() {
  gradSeq += 1;
  return `g${gradSeq}`;
}
let clipSeq = 0;
function clipId() {
  clipSeq += 1;
  return `c${clipSeq}`;
}

function norm2(x, y) {
  const len = Math.hypot(x, y) || 1;
  return [x / len, y / len];
}

// derive(document) → { viewportWidth, viewportHeight, background, paths:[...] }
// Each path: { d, fillRule, fill, stroke }
//   fill: null | { type:'solid', color } | { type:'gradient', gradient:{...} }
//   gradient: { kind:'linear'|'radial', stops:[{offset,color}], ...coords }
export function derive(document) {
  gradSeq = 0;
  clipSeq = 0;
  const vw = document.canvas.viewportWidth;
  const vh = document.canvas.viewportHeight;
  const light = document.light;

  // Shared scene geometry.
  const C = [vw / 2, vh / 2];
  const R = 0.5 * Math.max(vw, vh); // canvas half-extent (radial sizing)
  const phi = light.azimuth * DEG;
  const f = [Math.sin(phi), -Math.cos(phi)]; // unit vector TOWARD the light
  const theta = Math.max(1, Math.min(89, light.elevation)) * DEG;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const cotT = cosT / sinT;
  const intensity = light.intensity;
  const lightOff = light.type === 'off'; // no lighting: flat fills, no sheen/shadow

  const paths = [];
  // Running union of the baked outlines of filled layers below the current one,
  // used to clip cast shadows so they land on surfaces, not empty background.
  let unionBelow = '';

  for (const layer of document.layers) {
    if (!layer.visible) continue;
    if (!layer.pathData) continue;

    // Normalize once; bake any user transform (import already baked its own).
    let segs = P.parse(layer.pathData);
    const lm = layer.transform ? layerMatrix(layer.transform) : null;
    if (lm) segs = P.transform(segs, lm);
    const d = P.serialize(segs);
    const box = P.bbox(segs);
    const shapeCenter = [box.cx, box.cy];

    const mat = layer.material;
    const base = parseColor(mat.baseColor) || { r: 59, g: 130, b: 246, a: 1 };
    const fillAlpha = mat.fillAlpha == null ? 1 : mat.fillAlpha;
    // Stroke width is baked-in like the geometry: scale it with the layer so a
    // scaled shape's outline keeps its proportions (the path coords are already
    // transformed above, so an unscaled width would read too thick/thin).
    const strokeOut = mat.stroke ? resolveStroke(mat.stroke, lm ? meanAxisScale(lm) : 1) : null;

    // Stroke-only layer → passthrough, excluded from emboss/shadow (PLAN §13).
    // Also not a solid surface, so it doesn't catch other layers' shadows.
    if (mat.fillNone) {
      paths.push({ d, fillRule: layer.fillRule, fill: null, stroke: strokeOut });
      continue;
    }

    const embossed = mat.fillMode === 'embossed';
    // Light off → contrast 0, so the lit fill below falls through to a flat fill.
    const c = lightOff ? 0 : clamp01(intensity * (mat.embossIntensity == null ? 1 : mat.embossIntensity) * cosT);

    // 1) Cast shadow (drawn underneath) — a light effect, skipped when off.
    if (!lightOff && layer.castsShadow && layer.castsShadow.enabled) {
      const sh = buildShadow(segs, box, shapeCenter, {
        light,
        f,
        C,
        R,
        cotT,
        // Auto throw distance from the light elevation, scaled by the layer's
        // own Distance multiplier (its apparent height above the surface).
        len: clamp(SHADOW_LEN_K * cotT, 0, SHADOW_MAX_LEN) * R *
          (layer.castsShadow.distance == null ? 1 : Math.max(0, layer.castsShadow.distance)),
        cfg: layer.castsShadow,
      });
      if (sh) {
        // Default: clip the shadow to the union of layers below, so it only
        // shows where it lands on a surface. With nothing below, it has no
        // surface to fall on → omit it entirely.
        const clipOn = layer.castsShadow.clipToLayers !== false;
        if (!clipOn) {
          paths.push(sh);
        } else if (unionBelow) {
          sh.clip = { id: clipId(), pathData: unionBelow };
          paths.push(sh);
        }
      }
    }

    // 2) Fill. A user gradient fill replaces the emboss (a VD fill holds one
    // gradient); stack a separate layer for emboss + gradient on one shape.
    if (mat.fillMode === 'gradient' && mat.gradient) {
      paths.push({
        d,
        fillRule: layer.fillRule,
        fill: { type: 'gradient', gradient: buildUserGradient(mat.gradient, lm, fillAlpha) },
        stroke: strokeOut,
      });
    } else if (!embossed || c <= 0.001) {
      paths.push({
        d,
        fillRule: layer.fillRule,
        fill: { type: 'solid', color: scaleAlpha(withAlpha(base, base.a), fillAlpha) },
        stroke: strokeOut,
      });
    } else {
      const gradient =
        light.type === 'point'
          ? radialEmboss(base, fillAlpha, light, R, sinT, c)
          : linearEmboss(base, fillAlpha, C, f, vw, vh, c);
      paths.push({ d, fillRule: layer.fillRule, fill: { type: 'gradient', gradient }, stroke: strokeOut });
    }

    // 3) Sheen (drawn on top, own path; VD clip-path is aliased) — off when no light.
    if (!lightOff && embossed && mat.sheen && mat.sheen.enabled && mat.sheen.strength > 0) {
      const gradient =
        light.type === 'point'
          ? sheenRadial(light, box, mat.sheen.strength)
          : sheenLinear(C, f, box, mat.sheen.strength);
      paths.push({ d, fillRule: layer.fillRule, fill: { type: 'gradient', gradient }, stroke: null });
    }

    // This (filled) layer becomes a surface for shadows cast by layers above.
    unionBelow += d;
  }

  return {
    viewportWidth: vw,
    viewportHeight: vh,
    background: document.canvas.exportBackground,
    paths,
  };
}

// ---- gradient builders ----
function linearEmboss(base, fillAlpha, C, f, vw, vh, c) {
  // Project canvas half-extent onto f so the ramp spans the whole canvas →
  // every layer samples one coherent light.
  const Rproj = 0.5 * (Math.abs(f[0]) * vw + Math.abs(f[1]) * vh);
  const dark = [C[0] - f[0] * Rproj, C[1] - f[1] * Rproj];
  const bright = [C[0] + f[0] * Rproj, C[1] + f[1] * Rproj];
  return {
    id: gradId(),
    kind: 'linear',
    x1: dark[0],
    y1: dark[1],
    x2: bright[0],
    y2: bright[1],
    stops: [
      { offset: 0, color: scaleAlpha(mix(base, BLACK, c * A_LO), fillAlpha) },
      { offset: 0.5, color: scaleAlpha(withAlpha(base, base.a), fillAlpha) },
      { offset: 1, color: scaleAlpha(mix(base, WHITE, c * A_HI), fillAlpha) },
    ],
  };
}

function radialEmboss(base, fillAlpha, light, R, sinT, c) {
  const r = Math.max(1, R * (0.5 + 0.7 * sinT));
  return {
    id: gradId(),
    kind: 'radial',
    cx: light.position.x,
    cy: light.position.y,
    r,
    stops: [
      { offset: 0, color: scaleAlpha(mix(base, WHITE, c * A_HI), fillAlpha) },
      { offset: 1, color: scaleAlpha(mix(base, BLACK, c * A_LO), fillAlpha) },
    ],
  };
}

function sheenLinear(C, f, box, strength) {
  // White hotspot biased to the lit side (+f), fading to transparent.
  const reach = 0.5 * Math.max(box.w, box.h) || 1;
  const hi = [box.cx + f[0] * reach, box.cy + f[1] * reach];
  const lo = [box.cx - f[0] * reach * SHEEN_COVERAGE, box.cy - f[1] * reach * SHEEN_COVERAGE];
  return {
    id: gradId(),
    kind: 'linear',
    x1: hi[0],
    y1: hi[1],
    x2: lo[0],
    y2: lo[1],
    stops: [
      { offset: 0, color: withAlpha(WHITE, clamp01(strength)) },
      { offset: 1, color: withAlpha(WHITE, 0) },
    ],
  };
}

function sheenRadial(light, box, strength) {
  const r = Math.max(1, 0.6 * Math.max(box.w, box.h));
  return {
    id: gradId(),
    kind: 'radial',
    cx: light.position.x,
    cy: light.position.y,
    r,
    stops: [
      { offset: 0, color: withAlpha(WHITE, clamp01(strength)) },
      { offset: 1, color: withAlpha(WHITE, 0) },
    ],
  };
}

// Build a derived gradient from a user gradient fill. Geometry is in the
// layer's local (pathData) space, so we bake it with the SAME matrix as the
// path → the gradient tracks move/scale/flip. Stop alpha folds in the layer's
// fillAlpha, exactly like the solid/emboss fills.
function buildUserGradient(g, m, fillAlpha) {
  const stops = g.stops.map((s) => {
    const c = parseColor(s.color) || BLACK;
    return { offset: clamp01(s.offset), color: scaleAlpha(withAlpha(c, s.alpha == null ? 1 : s.alpha), fillAlpha) };
  });
  if (g.type === 'radial') {
    let cx = g.cx, cy = g.cy, r = g.r;
    if (m) {
      const p = P.applyPoint(m, g.cx, g.cy);
      cx = p[0];
      cy = p[1];
      r = g.r * meanAxisScale(m); // mean axis scale (non-uniform → circle approx)
    }
    return { id: gradId(), kind: 'radial', cx, cy, r: Math.max(0.01, Math.abs(r)), stops };
  }
  let x1 = g.x1, y1 = g.y1, x2 = g.x2, y2 = g.y2;
  if (m) {
    const a = P.applyPoint(m, g.x1, g.y1);
    const b = P.applyPoint(m, g.x2, g.y2);
    x1 = a[0]; y1 = a[1]; x2 = b[0]; y2 = b[1];
  }
  return { id: gradId(), kind: 'linear', x1, y1, x2, y2, stops };
}

function buildShadow(segs, box, shapeCenter, ctx) {
  const { light, f, len, cfg } = ctx;
  if (len <= 0.01) return null;
  // Direction the shadow falls: opposite the light.
  let dir;
  if (light.type === 'point') {
    dir = norm2(shapeCenter[0] - light.position.x, shapeCenter[1] - light.position.y);
  } else {
    dir = [-f[0], -f[1]];
  }
  const offset = P.translate(dir[0] * len, dir[1] * len);
  const shadowSegs = P.transform(segs, offset);
  const d = P.serialize(shadowSegs);

  // Fade along dir: darkest on the object side, transparent toward the far end.
  const half = 0.5 * (Math.abs(dir[0]) * box.w + Math.abs(dir[1]) * box.h);
  const spreadLen = Math.max(1, (cfg.spread == null ? 0.4 : cfg.spread) * (box.w + box.h) * 0.5);
  const cx = box.cx + dir[0] * len;
  const cy = box.cy + dir[1] * len;
  const near = [cx - dir[0] * half, cy - dir[1] * half];
  const far = [cx + dir[0] * (half + spreadLen), cy + dir[1] * (half + spreadLen)];

  return {
    d,
    fillRule: 'nonZero',
    fill: {
      type: 'gradient',
      gradient: {
        id: gradId(),
        kind: 'linear',
        x1: near[0],
        y1: near[1],
        x2: far[0],
        y2: far[1],
        stops: [
          { offset: 0, color: withAlpha(BLACK, clamp01(cfg.opacity == null ? 0.35 : cfg.opacity)) },
          { offset: 1, color: withAlpha(BLACK, 0) },
        ],
      },
    },
    stroke: null,
  };
}

function resolveStroke(stroke, scale = 1) {
  const color = parseColor(stroke.color) || BLACK;
  return {
    color,
    width: (stroke.width == null ? 1 : stroke.width) * scale,
    cap: stroke.cap || 'butt',
    join: stroke.join || 'miter',
  };
}

// Mean axis scale of an affine matrix's linear part — for things that carry a
// single scalar magnitude (stroke width, radial gradient radius) and must track
// the layer. Exact for a uniform scale; a non-uniform scale is approximated by
// the average of the two axis lengths.
function meanAxisScale(m) {
  return (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;
}

// The baked outline of a single layer (transform applied), in viewport space.
// Used by the UI to draw a selection marquee — not part of any export.
export function bakedOutline(layer) {
  if (!layer || !layer.pathData) return '';
  let segs = P.parse(layer.pathData);
  if (layer.transform) segs = P.transform(segs, layerMatrix(layer.transform));
  return P.serialize(segs);
}

// VectorDrawable group transform order: scale, rotate, translate, around pivot.
function layerMatrix(t) {
  const px = t.pivotX || 0;
  const py = t.pivotY || 0;
  let m = P.translate(px + (t.translateX || 0), py + (t.translateY || 0));
  m = P.multiply(m, P.rotate(t.rotation || 0));
  m = P.multiply(m, P.scale(t.scaleX == null ? 1 : t.scaleX, t.scaleY == null ? 1 : t.scaleY));
  m = P.multiply(m, P.translate(-px, -py));
  return m;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v) {
  return clamp(v, 0, 1);
}
