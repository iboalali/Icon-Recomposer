// animate.js — the timeline pre-pass (ANIMATION.md §2, §9.2).
//
// Animation needs NO new renderer: derive() is a pure function of the authoring
// document, so a frame is just the document interpolated at time t, fed through
// the existing derive → svg → canvas pipeline. documentAt(doc, t) produces that
// interpolated copy; everything downstream is unchanged.
//
// Raster-only / motion features target PNG + (future) video export only — never
// VectorDrawable. This module is pure (no DOM) so it can be exercised headlessly.

import { parseColor, toHex, mix } from './color.js';

// ---- animatable property allow-list (ANIMATION.md §5.3) ----
// A track binds a property PATH to keyframes. We resolve a layer by its id (not
// its index) at sample time, so reordering/deleting layers never retargets a
// track. propType() is the single source of truth for which props are
// animatable and how each interpolates; model.js validation imports it.

// Scene (document-level) props → interpolation type.
const SCENE_PROPS = {
  'light.azimuth': 'angle',
  'light.elevation': 'number',
  'light.intensity': 'number',
  'light.position.x': 'number',
  'light.position.y': 'number',
};
// Fixed per-layer props → interpolation type.
const LAYER_PROPS = {
  'material.fillAlpha': 'number',
  'material.baseColor': 'color',
  'material.embossIntensity': 'number',
  'material.sheen.strength': 'number',
  'transform.translateX': 'number',
  'transform.translateY': 'number',
  'transform.rotation': 'angle',
  'transform.scaleX': 'number',
  'transform.scaleY': 'number',
};
// Per-stop gradient props (dynamic index) → type. Decision G (Phase 1).
const GRAD_STOP_RE = /^material\.gradient\.stops\.(\d+)\.(offset|color|alpha)$/;

// The interpolation type for a (scope, prop), or null if it isn't animatable.
export function propType(scope, prop) {
  if (typeof prop !== 'string') return null;
  if (scope === 'scene') return SCENE_PROPS[prop] || null;
  if (LAYER_PROPS[prop]) return LAYER_PROPS[prop];
  const m = GRAD_STOP_RE.exec(prop);
  if (m) return m[2] === 'color' ? 'color' : 'number';
  return null;
}

// Coerce a stored keyframe value to its type, or undefined if unusable. Colors
// are kept as '#rrggbb' (no alpha — alpha rides a separate stop track).
export function coerceKeyValue(type, v) {
  if (type === 'color') return typeof v === 'string' && v[0] === '#' ? v.slice(0, 7) : undefined;
  return isFinite(+v) ? +v : undefined;
}

// ---- dotted-path get/set (no intermediate creation — guards on missing) ----
export function getAtPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
// Set obj.<path> = value. Returns false (no-op) if any intermediate is missing,
// so a track for a gradient stop that no longer exists is simply skipped.
export function setAtPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return false;
    cur = cur[parts[i]];
  }
  if (cur == null || typeof cur !== 'object') return false;
  cur[parts[parts.length - 1]] = value;
  return true;
}

// ---- easing (ANIMATION.md §5.2; decision F) ----
// Each maps an eased fraction 0..1 → 0..1. `hold` is a step (value stays on the
// left key until the next one). The curve is held on the LEFT key of a segment.
export const EASINGS_LIST = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'];
const EASINGS = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  hold: () => 0,
};

// ---- interpolation by type (ANIMATION.md §5.4) ----
function lerp(a, b, e) { return a + (b - a) * e; }
// Shortest-arc so 350°→10° travels +20°, not −340° (azimuth/rotation).
function lerpAngle(a, b, e) {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return a + d * e;
}
// Perceptual OKLab mix (reuses color.js — same machinery the emboss ramp uses).
function lerpColor(a, b, e) {
  const ca = parseColor(a) || parseColor('#000000');
  const cb = parseColor(b) || ca;
  return toHex(mix(ca, cb, e));
}
function interp(type, a, b, e) {
  if (type === 'color') return lerpColor(a, b, e);
  if (type === 'angle') return lerpAngle(+a, +b, e);
  return lerp(+a, +b, e);
}

// The value of one track at time t. Held (clamped) before the first / after the
// last key — never extrapolated. undefined if the track has no keys.
export function sampleTrack(track, t) {
  const keys = track.keys;
  if (!keys || !keys.length) return undefined;
  if (t <= keys[0].t) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.value;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const span = k1.t - k0.t;
  const frac = span > 0 ? (t - k0.t) / span : 0;
  const ease = EASINGS[k0.easing] || EASINGS.linear;
  return interp(track.type, k0.value, k1.value, ease(frac));
}

// The authoring document interpolated at time t. Returns the SAME object
// (no clone) when there's nothing to animate, so the static path is zero-cost.
export function documentAt(document, t) {
  const tl = document.timeline;
  if (!tl || !tl.enabled || !tl.tracks || !tl.tracks.length) return document;
  const next = structuredClone(document);
  const byId = new Map(next.layers.map((l) => [l.id, l]));
  for (const track of tl.tracks) {
    const value = sampleTrack(track, t);
    if (value === undefined) continue;
    if (track.scope === 'scene') {
      setAtPath(next, track.prop, value);
    } else {
      const layer = byId.get(track.layerId);
      if (layer) setAtPath(layer, track.prop, value);
    }
  }
  return next;
}
