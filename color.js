// color.js — color parsing/formatting + perceptual mixing (OKLab).
//
// Internal color representation: { r, g, b, a } where r/g/b are floats 0..255
// and a is 0..1. We keep floats internally for precise mixing and round only
// when formatting to a string.
//
// Why OKLab: mixing toward white/black in sRGB produces muddy/chalky ramps.
// OKLab is perceptually even, so the emboss highlight→shadow ramp reads clean.

const NAMED = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  silver: { r: 192, g: 192, b: 192, a: 1 },
  none: null,
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

export { BLACK, WHITE };

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Parse a CSS/SVG/VD color string into { r, g, b, a } (or null for none).
// Handles: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba(), a few named colors.
// Android also uses #AARRGGBB on input — but inside the model we always store
// the web order; the VD importer converts before calling here.
export function parseColor(str) {
  if (str == null) return null;
  if (typeof str === 'object') return str; // already a color object
  let s = String(str).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower in NAMED) return cloneColor(NAMED[lower]);

  if (s[0] === '#') {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }

  const m = lower.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length >= 3) {
      const chan = (p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
      const r = chan(parts[0]);
      const g = chan(parts[1]);
      const b = chan(parts[2]);
      let a = 1;
      if (parts[3] != null) a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      return { r, g, b, a };
    }
  }
  return null;
}

function cloneColor(c) {
  return c == null ? null : { r: c.r, g: c.g, b: c.b, a: c.a };
}

function hex2(n) {
  const v = clamp(Math.round(n), 0, 255);
  return v.toString(16).padStart(2, '0');
}

// '#rrggbb' (sRGB, no alpha) — for <input type="color">.
export function toHex(c) {
  if (!c) return '#000000';
  return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
}

// '#rrggbbaa' — web order, used inside preview SVG (browsers accept 8-digit).
export function toHexA(c) {
  if (!c) return '#00000000';
  return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + hex2(c.a * 255);
}

// 'rgba(r,g,b,a)' — handy for canvas fills.
export function toRgbaCss(c) {
  if (!c) return 'rgba(0,0,0,0)';
  return `rgba(${clamp(Math.round(c.r), 0, 255)},${clamp(Math.round(c.g), 0, 255)},${clamp(Math.round(c.b), 0, 255)},${+c.a.toFixed(4)})`;
}

// '#AARRGGBB' — Android VectorDrawable order (alpha FIRST). Classic VD bug.
export function toAndroid(c) {
  if (!c) return '#00000000';
  return ('#' + hex2(c.a * 255) + hex2(c.r) + hex2(c.g) + hex2(c.b)).toUpperCase();
}

export function withAlpha(c, a) {
  return { r: c.r, g: c.g, b: c.b, a: clamp(a, 0, 1) };
}

// Multiply existing alpha (used to fold a layer's fillAlpha into gradient stops).
export function scaleAlpha(c, m) {
  return { r: c.r, g: c.g, b: c.b, a: clamp(c.a * m, 0, 1) };
}

// ---- sRGB <-> OKLab ----
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp(v * 255, 0, 255);
}

function rgbToOklab(c) {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

function oklabToRgb(o) {
  const l_ = o.L + 0.3963377774 * o.a + 0.2158037573 * o.b;
  const m_ = o.L - 0.1055613458 * o.a - 0.0638541728 * o.b;
  const s_ = o.L - 0.0894841775 * o.a - 1.291485548 * o.b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) };
}

// mix(base, target, k): perceptual lerp from base toward target by k (0..1),
// in OKLab. Alpha is lerped linearly. k<=0 returns base unchanged.
export function mix(base, target, k) {
  if (k <= 0) return cloneColor(base);
  const t = clamp(k, 0, 1);
  const A = rgbToOklab(base);
  const B = rgbToOklab(target);
  const rgb = oklabToRgb({
    L: A.L + (B.L - A.L) * t,
    a: A.a + (B.a - A.a) * t,
    b: A.b + (B.b - A.b) * t,
  });
  const baseA = base.a == null ? 1 : base.a;
  const targetA = target.a == null ? 1 : target.a;
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: baseA + (targetA - baseA) * t };
}
