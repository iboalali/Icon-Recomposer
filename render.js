// render.js: variant → icon markup, plus the stylesheet the markup needs.
//
// The live preview (inside a shadow root) and the PNG capture (inside an SVG
// foreignObject) both use exactly this markup and stylesheet, so the export
// matches the preview.
//
// The markup is XHTML-safe: it is parsed as XML inside the capture SVG.

import { CANVAS, holeShape, isOver, paintOrder, shapesOverlap } from './model.js';
import { TEXTURE_CSS, ambientMaterial, coversEdge, holeFuzz, isTextured, metalSurface, metalVars, neonFace, neonTones, reflectivity, textureMarkup, underlayMarkup } from './textures.js';

const AMBIENT_URL = new URL('./vendor/ambientcss/ambient.css', import.meta.url);

const SURFACE_CLASS = {
  flat: 'amb-surface',
  concave: 'amb-surface-concave',
  'concave-h': 'amb-surface-concave-h',
  convex: 'amb-surface-convex',
  groove: 'amb-groove',
};

function edgeBands(inset) {
  return `
    ${inset}calc(var(--amb-light-x) * var(--_cw) * -1px) calc(var(--amb-light-y) * var(--_cw) * -1px) 0 0
      color-mix(in oklab, var(--_tint) calc(var(--_chl) * 100%), transparent),
    ${inset}calc(var(--amb-light-x) * var(--_cw) * 1px) calc(var(--amb-light-y) * var(--_cw) * 1px) 0 0
      color-mix(in oklab, var(--_dark) calc(var(--_csh) * 100%), transparent),
    ${inset}calc(var(--amb-light-x) * var(--_fw) * -1.4px) calc(var(--amb-light-y) * var(--_fw) * -1.4px) 2px 0
      color-mix(in oklab, var(--_tint) calc(var(--_fhl) * 100%), transparent),
    ${inset}calc(var(--amb-light-x) * var(--_fw) * 1.4px) calc(var(--amb-light-y) * var(--_fw) * 1.4px) 2px 0
      color-mix(in oklab, var(--_dark) calc(var(--_fsh) * 100%), transparent)`;
}

const BASE_CSS = `
.ir-stage { position: relative; width: ${CANVAS}px; height: ${CANVAS}px; overflow: hidden; }
.ir-shape, .ir-halo, .ir-refl, .ir-hole { position: absolute; box-sizing: border-box; }
.ir-halo, .ir-refl, .ir-hole { background: transparent; pointer-events: none; }
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
.ir-edge, .ir-rim {
  position: absolute;
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
}
.ir-edge { inset: 0; border-radius: inherit; box-shadow: ${edgeBands('inset ')}; }
/* The hole's rim: the same bands on the outside of the hole's box, which is
   the frame's face. The wall facing the light is on the far side of the hole,
   so the offsets keep their sign. */
.ir-rim { box-shadow: ${edgeBands('')}; }
.ir-rims { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; pointer-events: none; }
.ir-hole-glow { position: absolute; }
.ir-glass-rim { position: absolute; pointer-events: none; }
.ir-wall-layer { position: absolute; inset: 0; border-radius: inherit; pointer-events: none; mask-size: 100% 100%; mask-repeat: no-repeat; }
.ir-hole-clip { position: absolute; overflow: hidden; }
.ir-hole.ir-glass .ir-hole-in { --_amb-sh-gain: calc(0.12 + var(--amb-elevation) * 0.12); }
`;

// A frame's or ring's wall as a field: for each point, how far across the wall
// it lies (t: 0 at the outer edge, 1 at the hole's) and the direction the
// wall faces there (n, outward). Its masks are smooth, so a few pixels per
// canvas unit are enough.
const WALL_PX = 2;
const wallFields = new Map();
const wallMaskCache = new Map();
// Resizing a frame makes a new geometry on every frame of the drag, so only
// the most recent ones are kept.
function remember(map, key, value) {
  map.set(key, value);
  if (map.size > 48) map.delete(map.keys().next().value);
  return value;
}
const wallKey = (shape) => [shape.kind, shape.w, shape.h, shape.radius, shape.wall].map(num).join(':');

// Signed distance to a box's outline around its center (positive outside)
// and the outward direction there.
function boxField(x, y, hw, hh, r, ellipse) {
  if (ellipse) {
    const gx = x / (hw * hw);
    const gy = y / (hh * hh);
    const rho = Math.hypot(x / hw, y / hh) || 1e-6;
    const g = Math.hypot(gx, gy) / rho || 1e-6;
    return [(rho - 1) / g, gx / rho / g, gy / rho / g];
  }
  const qx = Math.abs(x) - hw + r;
  const qy = Math.abs(y) - hh + r;
  let d, nx, ny;
  if (qx > 0 && qy > 0) {
    const l = Math.hypot(qx, qy);
    [d, nx, ny] = [l - r, qx / l, qy / l];
  } else if (qx > qy) {
    [d, nx, ny] = [qx - r, 1, 0];
  } else {
    [d, nx, ny] = [qy - r, 0, 1];
  }
  return [d, Math.sign(x) * nx, Math.sign(y) * ny];
}

function wallField(shape, hole) {
  const key = wallKey(shape);
  if (wallFields.has(key)) return wallFields.get(key);
  const ellipse = shape.kind === 'ellipse';
  const W = Math.ceil(shape.w * WALL_PX);
  const H = Math.ceil(shape.h * WALL_PX);
  const outR = Math.max(0, Math.min(shape.radius, shape.w / 2, shape.h / 2));
  // The wall's facing direction turns around a corner as a tube bent at
  // least as wide as the wall, so a sharp corner has no crease.
  const bend = Math.min(Math.max(outR, shape.wall), shape.w / 2, shape.h / 2);
  const t = new Float32Array(W * H);
  const nx = new Float32Array(W * H);
  const ny = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = ((i + 0.5) / W) * shape.w - shape.w / 2;
      const y = ((j + 0.5) / H) * shape.h - shape.h / 2;
      const [dOut, ox, oy] = boxField(x, y, shape.w / 2, shape.h / 2, outR, ellipse);
      const [dIn, ix, iy] = boxField(x, y, hole.w / 2, hole.h / 2, hole.radius, ellipse);
      const a = Math.max(0, -dOut);
      const b = Math.max(0, dIn);
      const k = j * W + i;
      t[k] = a + b > 0 ? a / (a + b) : 0.5;
      let [, fx, fy] = ellipse
        ? [0, (1 - t[k]) * ox + t[k] * ix, (1 - t[k]) * oy + t[k] * iy]
        : boxField(x, y, shape.w / 2, shape.h / 2, bend, false);
      const n = Math.hypot(fx, fy) || 1;
      nx[k] = fx / n;
      ny[k] = fy / n;
    }
  }
  return remember(wallFields, key, { W, H, t, nx, ny });
}

// An alpha mask of the wall, alpha = fn(t, nx, ny) clamped to 0..1, as a PNG.
function wallMask(shape, hole, name, fn) {
  const key = `${wallKey(shape)}:${name}`;
  if (wallMaskCache.has(key)) return wallMaskCache.get(key);
  const { W, H, t, nx, ny } = wallField(shape, hole);
  const img = new ImageData(W, H);
  for (let k = 0; k < W * H; k++) img.data[k * 4 + 3] = Math.round(Math.max(0, Math.min(1, fn(t[k], nx[k], ny[k]))) * 255);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.getContext('2d').putImageData(img, 0, 0);
  return remember(wallMaskCache, key, canvas.toDataURL('image/png'));
}

const wallLayer = (url, css) => `<div class="ir-wall-layer" style="mask-image:url('${url}');${css}"></div>`;

// Curved surfaces on a frame or ring follow the wall, as a bent tube (convex)
// or a groove (concave): each point is shaded by n dotted with the light,
// times ambient.css's curve profile p across the wall (+1 at the outer edge,
// -1 at the hole's). That sum splits into an x and a y part, so four
// light-independent masks carry it: where n.x * p and n.y * p are positive
// and negative. Each paints the lighter or darker end shade of the curve,
// weighted by that light component.
const CURVED = new Set(['convex', 'concave', 'concave-h']);
const PROFILE = [[0, 1], [0.35, 0.33], [0.5, 0], [0.65, -0.33], [1, -1]];

function profileAt(t) {
  for (let i = 1; i < PROFILE.length; i++) {
    const [t1, v1] = PROFILE[i];
    if (t <= t1) {
      const [t0, v0] = PROFILE[i - 1];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return -1;
}

// light: the scene light in the shape's own frame.
function wallShading(shape, hole, light) {
  const surface = shape.style.surface;
  const sign = surface === 'convex' ? 1 : -1;
  const shade = (up) => `hsl(from var(--amb-lit) h s calc(l ${up ? '+' : '-'} var(--amb-curve-delta)))`;
  const layer = (name, fn, k) => {
    const w = Math.min(1, Math.abs(k));
    if (w < 0.005) return '';
    return wallLayer(wallMask(shape, hole, name, fn), `background:${shade(k * sign > 0)};opacity:${num(w)}`);
  };
  let out = layer('x+', (t, nx) => nx * profileAt(t), light.x) + layer('x-', (t, nx) => -nx * profileAt(t), -light.x);
  // concave-h curves only across the frame's left and right walls.
  if (surface !== 'concave-h') {
    out += layer('y+', (t, nx, ny) => ny * profileAt(t), light.y) + layer('y-', (t, nx, ny) => -ny * profileAt(t), -light.y);
  }
  return out;
}

// A hollow neon shape is a bent tube, brightest along the middle of its wall:
// its rim color, then the tube's color, a lighter mid tone and the white
// core, each faded in toward the middle, as neonFace's tube gradient runs
// across a long solid shape.
function neonWallFace(shape, hole) {
  const tone = neonTones(shape.style);
  const steps = [[0, 0.14, tone.color], [0.14, 0.32, tone.mid], [0.32, 0.5, tone.white]];
  const layers = steps.map(([a, b, color]) => wallLayer(
    wallMask(shape, hole, `neon${a}`, (t) => (Math.min(t, 1 - t) - a) / (b - a)),
    `background:${color}`,
  )).join('');
  return `<div class="ir-neon-face" style="background:${tone.rim}">${layers}</div>`;
}

// Per-shape hooks into the metal grain, so Shuffle can move it: an offset for
// the brushed and blasted tiles, and for radial brushed a spin center, a turn
// of the streaks and the size of the bright spot. Each defaults to the
// original value, so a shape without them renders exactly as ambient.css does.
const SPIN_AT = 'calc(50% + var(--ir-spin-dx, 0px)) calc(50% + var(--ir-spin-dy, 0px))';
const AMBIENT_HOOKS = [
  ['background-position: var(--_grain-x) var(--_grain-y);',
    'background-position: calc(var(--_grain-x) + var(--ir-grain-dx, 0px)) calc(var(--_grain-y) + var(--ir-grain-dy, 0px));'],
  ['background-position: calc(var(--_grain-x) * -1) calc(var(--_grain-y) * -1);',
    'background-position: calc(var(--_grain-x) * -1 + var(--ir-grain-dx, 0px)) calc(var(--_grain-y) * -1 + var(--ir-grain-dy, 0px));'],
  ['from 0deg at 50% 50%', 'from var(--ir-spin-turn, 0deg) at 50% 50%'],
  ['circle closest-side at 50% 50%', `circle closest-side at ${SPIN_AT}`],
  ['/ 0) 40%', '/ 0) var(--ir-spin-spot, 40%)'],
  ['from var(--_sheen-angle) at 50% 50%', `from var(--_sheen-angle) at ${SPIN_AT}`],
  ['background-position: calc(50% + var(--_grain-x)) calc(50% + var(--_grain-y));',
    'background-position: calc(50% + var(--ir-spin-dx, 0px) + var(--_grain-x)) calc(50% + var(--ir-spin-dy, 0px) + var(--_grain-y));'],
  ['background-position: calc(50% - var(--_grain-x)) calc(50% - var(--_grain-y));',
    'background-position: calc(50% + var(--ir-spin-dx, 0px) - var(--_grain-x)) calc(50% + var(--ir-spin-dy, 0px) - var(--_grain-y));'],
];

function adaptAmbient(css) {
  let out = css.replace(/:root\s*\{/, ':root, .ir-stage {');
  for (const [from, to] of AMBIENT_HOOKS) {
    if (!out.includes(from)) console.warn(`ambient.css changed: "${from}" not found`);
    out = out.split(from).join(to);
  }
  return out + holeShadowCss(css) + glassHoleCss(css);
}

// Splits at `sep` outside parentheses.
function splitTop(str, sep) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') depth--;
    else if (str[i] === sep && !depth) {
      out.push(str.slice(from, i));
      from = i + 1;
    }
  }
  out.push(str.slice(from));
  return out;
}

// The shadow a hollow shape casts into its hole: the .ambient rule's drop
// shadow layers, made inset on the hole's box. An inset shadow is the box's
// outside moved by the offset, which is where the walls around the hole cast.
// ambient.css registers --amb-elevation as not inherited, which takes effect
// in the export's document but not in the editor's shadow root, so the rule
// inherits it explicitly.
function holeShadowCss(css) {
  const block = /\n\.ambient \{([\s\S]*?)\n\}/.exec(css);
  const body = block ? block[1].replace(/\/\*[\s\S]*?\*\//g, '') : '';
  const decls = splitTop(body, ';');
  const shadow = decls.find((d) => /^\s*box-shadow\s*:/.test(d));
  if (!shadow) {
    console.warn('ambient.css changed: the .ambient box-shadow was not found');
    return '';
  }
  const drops = splitTop(shadow.replace(/^\s*box-shadow\s*:/, ''), ',').map((l) => l.trim()).filter((l) => !l.startsWith('inset'));
  const vars = decls.filter((d) => /^\s*--/.test(d)).join(';');
  return `\n.ir-hole-in { position: absolute; --amb-elevation: inherit; ${vars}; box-shadow: ${drops.map((l) => `inset ${l}`).join(', ')}; }\n`;
}

// The declarations of the first top-level rule for `selector` whose body
// contains `marker`, without comments.
function ruleDecls(css, selector, marker) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of css.matchAll(new RegExp(`\\n${esc} \\{([\\s\\S]*?)\\n\\}`, 'g'))) {
    const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
    if (body.includes(marker)) return splitTop(body, ';').map((d) => d.trim()).filter(Boolean);
  }
  return null;
}

// A frosted glass frame's walls around the hole: the shadow ring and skirt
// ambient.css draws for a pane's outer walls (.amb-mat-glass::after), drawn
// again for the hole's walls in the hole's wrapper. The ring lies just outside
// the hole's box, so its inset shadow, the skirt, fills the hole's box and is
// blurred with it. It is clipped to the hole: past it, the ring would lie
// under the pane as a hard line along the wall. The wrapper is not the
// glass element, so it computes ambient.css's private --_glass-* variables
// itself, from the same declarations.
function glassHoleCss(css) {
  const decls = ruleDecls(css, '.amb-mat-glass', '--_glass-skirt-a');
  if (!decls) {
    console.warn('ambient.css changed: the .amb-mat-glass variables were not found');
    return '';
  }
  const vars = decls.filter((d) => d.startsWith('--_glass-')).join(';\n  ');
  // Per side, as for a pane's walls, but the hole's left edge is the wall
  // right of it in the frame: the one whose shadow falls into the hole.
  const side = (edge, s) => `border-${edge}-color: hsl(var(--amb-light-hue) var(--amb-light-saturation) 0% / calc(var(--_glass-ring-a) * (max(0, -1 * var(--_glass-s-${s})) + (1 - max(0, -1 * var(--_glass-s-${s}))) * var(--_glass-ring-lift))));`;
  return `
.ir-hole.ir-glass {
  ${vars};
}
.ir-hole-ring {
  position: absolute;
  translate: var(--_glass-sh-x) var(--_glass-sh-y);
  border-style: solid;
  border-width: var(--_glass-ring-w);
  ${side('left', 'right')}
  ${side('right', 'left')}
  ${side('top', 'bottom')}
  ${side('bottom', 'top')}
  box-shadow: inset 0 0 var(--_glass-skirt-blur) 0 hsl(var(--amb-light-hue) var(--amb-light-saturation) 0% / var(--_glass-skirt-a));
  filter: blur(var(--_glass-ring-blur));
}
`;
}

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
      .then((css) => adaptAmbient(css) + BASE_CSS + TEXTURE_CSS);
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

// A box's outline as an SVG subpath, in the shape's own box.
function boxPath(x, y, w, h, r, ellipse) {
  if (ellipse) {
    const [rx, ry] = [num(w / 2), num(h / 2)];
    return `M${num(x)} ${num(y + h / 2)}a${rx} ${ry} 0 1 0 ${num(w)} 0a${rx} ${ry} 0 1 0 ${num(-w)} 0Z`;
  }
  const k = num(Math.max(0, Math.min(r, w / 2, h / 2)));
  const [x0, y0, x1, y1] = [num(x), num(y), num(x + w), num(y + h)];
  if (!k) return `M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
  const a = `A${k} ${k} 0 0 1`;
  return `M${num(x + k)} ${y0}H${num(x + w - k)}${a} ${x1} ${num(y + k)}V${num(y + h - k)}${a} ${num(x + w - k)} ${y1}H${num(x + k)}${a} ${x0} ${num(y + h - k)}V${num(y + k)}${a} ${num(x + k)} ${y0}Z`;
}

const outlinePath = (shape, inset = 0) => boxPath(inset, inset, shape.w - inset * 2, shape.h - inset * 2, shape.radius - inset, shape.kind === 'ellipse');

// The hole's outline in its shape's box.
const holePath = (shape, hole) => boxPath(shape.wall, shape.wall, hole.w, hole.h, hole.radius, shape.kind === 'ellipse');

// An even-odd SVG mask image of the area (x, y, w, h) of an element's box.
// The export rasterizes it at its own size, so it is drawn at the output
// resolution: the seam overlap is 1.25 output pixels, which gives the pixels
// per canvas unit.
function svgUrl(body, x, y, w, h, overlap) {
  const k = Math.min(16, Math.max(2, Math.ceil(1.25 / overlap)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w * k)}" height="${Math.ceil(h * k)}" viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}" preserveAspectRatio="none">${body}</svg>`;
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
}

const maskUrl = (d, x, y, w, h, overlap) => svgUrl(`<path fill-rule="evenodd" d="${d}"/>`, x, y, w, h, overlap);

// A mask rather than a clip-path, so it combines with a crossing's clip-path.
// no-clip keeps the drop shadow, which paints outside the box.
function maskCss(d, x, y, w, h, overlap) {
  return `mask-image:${maskUrl(d, x, y, w, h, overlap)};mask-position:${num(x)}px ${num(y)}px;mask-size:${num(w)}px ${num(h)}px;mask-repeat:no-repeat;mask-clip:no-clip;`;
}

// What an element of `shape` may paint. pass 'all': everything but the hole;
// 'shadow': only around the shape, reaching slightly under its edge so the
// face's anti-aliased rim has no gap; 'face': only the shape's body.
function cutCss(shape, hole, pass, overlap) {
  if (pass === 'face') return maskCss(outlinePath(shape) + (hole ? holePath(shape, hole) : ''), 0, 0, shape.w, shape.h, overlap);
  if (pass !== 'shadow' && !hole) return '';
  const p = inkReach(shape);
  const around = boxPath(-p, -p, shape.w + p * 2, shape.h + p * 2, 0, false);
  return maskCss(around + (pass === 'shadow' ? outlinePath(shape, overlap) : holePath(shape, hole)), -p, -p, shape.w + p * 2, shape.h + p * 2, overlap);
}

const holeBox = (shape, hole) => `left:${num(shape.wall)}px;top:${num(shape.wall)}px;width:${num(hole.w)}px;height:${num(hole.h)}px;border-radius:${shape.kind === 'ellipse' ? '50%' : `${num(hole.radius)}px`};`;

// What a hollow shape paints into its hole: its drop shadow on whatever shows
// through, and its glow.
function holeMarkup(shape, hole, geo, vars, amb) {
  const st = shape.style;
  const neon = st.material === 'neon';
  const box = holeBox(shape, hole);
  let glow = '';
  if (neon && st.glowSize > 0) {
    const g = num(st.glowSize);
    glow = `inset 0 0 ${num(g / 3)}px ${num(g / 8)}px ${st.color},inset 0 0 ${g}px ${num(g / 3)}px ${st.color}`;
  } else if (st.glow && st.glowSize > 0) {
    glow = `inset 0 0 ${num(st.glowSize)}px ${num(st.glowSize / 3)}px ${st.glowColor}`;
  }
  let inner = neon ? '' : `<div class="ir-hole-in" style="${box}"></div>`;
  if (amb === 'glass') {
    const edge = 'calc(var(--_glass-ring-w) * -1)';
    const size = (v) => `calc(${num(v)}px + var(--_glass-ring-w) * 2)`;
    const radius = shape.kind === 'ellipse' ? '50%' : `calc(${num(hole.radius)}px + var(--_glass-ring-w))`;
    const ring = `<div class="ir-hole-ring" style="left:${edge};top:${edge};width:${size(hole.w)};height:${size(hole.h)};border-radius:${radius}"></div>`;
    inner += `<div class="ir-hole-clip" style="${box}">${ring}</div>`;
  }
  if (glow) inner += `<div class="ir-hole-glow" style="${box}box-shadow:${glow}"></div>`;
  inner += holeFuzz(shape, hole);
  if (!inner) return '';
  const cls = amb !== 'glass' ? '' : st.material === 'jelly' ? ' ir-glass ir-jelly' : ' ir-glass';
  return `<div class="ir-hole${cls}" style="${geo}${vars}">${inner}</div>`;
}

// keep: the region (see meet) the element and its glow are clipped to, e.g. by
// a crossing. holeKeep: the same for the hole wrapper.
// plain: without texture layers.
// pass: 'all', or for a shape sharing a level with its neighbors 'shadow'
// (its shadows and glow) and 'face' (its body), drawn in separate rounds.
// overlap: the crossing seam overlap, in canvas units.
function shapeMarkup(shape, scene, { keep = null, holeKeep = keep, plain = false, pass = 'all', overlap = 0.3 } = {}) {
  const st = shape.style;
  const classes = ['ir-shape', 'ambient'];
  const neon = st.material === 'neon';
  const textured = isTextured(st.material);
  // The ambient.css material: the shape's own, or the one a texture builds on.
  const amb = textured ? ambientMaterial(st) : st.material !== 'matte' && !neon ? st.material : null;
  const light = localLight(scene, shape.rotation || 0);
  const hole = holeShape(shape);
  const metal = metalSurface(shape, light);
  // A frame or ring gets its curve from wallShading on a flat base, which
  // also leaves out shiny's box-wide gradients, as a solid curved surface does.
  const walled = hole && CURVED.has(st.surface) && amb !== 'glass' && !neon && !metal;
  if (amb !== 'glass') classes.push(neon || walled ? 'amb-surface' : SURFACE_CLASS[st.surface] || 'amb-surface');
  if (amb) classes.push(`amb-mat-${amb}`);
  if (textured) classes.push('ir-textured', `ir-${st.material}`);
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
  ].join(';') + metalVars(shape, amb);
  const look = vars + metal + (walled ? ';background-image:none' : '');
  const geo = geometryCss(shape) + (keep ? regionClip(shape, keep) : '');
  const opacity = st.opacity < 1 ? `opacity:${num(st.opacity)};` : '';
  let cut = cutCss(shape, hole, pass, overlap);
  let face = geo;
  // Chrome ignores the mask of an element with a backdrop-filter and a
  // clip-path, so a clipped pane's clip also cuts what its mask would.
  if (keep && amb === 'glass' && cut) {
    face = geometryCss(shape) + regionClip(shape, maskedKeep(shape, keep, hole, pass, overlap));
    cut = '';
  }
  const body = `<div class="${classes.join(' ')}" style="${face}${opacity}${look}`;
  if (pass === 'face') {
    if (neon) return `${body};box-shadow:none;${cut}">${hole ? neonWallFace(shape, hole) : neonFace(shape)}</div>`;
    return `${body};${cut}">${innerMarkup(shape, scene, light, hole, plain, amb, walled)}</div>`;
  }
  let out = '';
  if (neon && st.glowSize > 0) {
    const g = num(st.glowSize);
    out += `<div class="ir-halo" style="${geo}${opacity}box-shadow:0 0 ${num(g / 3)}px ${num(g / 8)}px ${st.color},0 0 ${g}px ${num(g / 3)}px ${st.color}"></div>`;
  } else if (st.glow && st.glowSize > 0) {
    out += `<div class="ir-halo" style="${geo}${opacity}box-shadow:0 0 ${num(st.glowSize)}px ${num(st.glowSize / 3)}px ${st.glowColor}"></div>`;
  }
  if (!plain) out += underlayMarkup(shape, scene, geo, hole ? cutCss(shape, hole, 'all', overlap) : '');
  if (hole) out += holeMarkup(shape, hole, geometryCss(shape) + (holeKeep ? regionClip(shape, holeKeep) : '') + opacity, vars, amb);
  if (neon) {
    if (pass !== 'shadow') out += `${body};box-shadow:none;${cut}">${hole ? neonWallFace(shape, hole) : neonFace(shape)}</div>`;
    return out;
  }
  out += `${body};${cut}">${innerMarkup(shape, scene, light, hole, plain, amb, walled)}</div>`;
  return out;
}

// A glass frame's edge bands along its hole, like the ones ambient.css paints
// inside a pane's edges: the hole's outline shadow moved toward the light is
// the glow on the far walls, moved away from it the wash on the walls facing
// the light. The shadow follows the hole's corners and thins out toward the
// walls parallel to the light, as the pane's bands do per side.
function glassRim(shape, hole, light) {
  const hsl = (l, a) => `hsl(var(--amb-light-hue) var(--amb-light-saturation) ${l}% / ${a})`;
  const by = (w, k) => `calc(var(--_glass-${w}-w) * ${num(light.x * k)}) calc(var(--_glass-${w}-w) * ${num(light.y * k)})`;
  const glow = `${by('glow', 0.5)} 1.5px 0 ${hsl(100, 'calc(var(--_glass-far-a) * 0.8)')}`;
  const wash = `${by('band', -0.6)} 2px 0 ${hsl(53, 'var(--_glass-lit-a)')}`;
  return `<div class="ir-glass-rim" style="${holeBox(shape, hole)}box-shadow:${glow},${wash}"></div>`;
}

function innerMarkup(shape, scene, light, hole, plain, amb, walled) {
  const st = shape.style;
  let edge = '';
  if (st.chamfer || st.fillet) {
    edge = '<div class="ir-edge"></div>';
    if (hole) edge += `<div class="ir-rims"><div class="ir-rim" style="${holeBox(shape, hole)}"></div></div>`;
  }
  if (hole && amb === 'glass') edge = glassRim(shape, hole, light) + edge;
  const tex = (walled ? wallShading(shape, hole, light) : '') + (plain ? '' : textureMarkup(shape, light, scene));
  return coversEdge(st) ? edge + tex : tex + edge;
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
  const { elevation: e, thickness: k, glow, glowSize, material } = shape.style;
  return e * 6.8 + k * 3.8 + e * 4.8 + k * 2.7 + 1 + (glow || material === 'neon' ? glowSize * 1.4 : 0) + 2;
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
// Along `under`'s edge, a band `overlap` wide is painted by both. An opaque
// `over` puts it outside `under`: the copy reaches past the edge and covers
// its anti-aliased pixels, which would otherwise show `under`'s rim as a line.
// A see-through `over` puts it inside, where `under` hides the original and
// the band isn't seen twice. Shadows and glows are see-through, so the copy's
// stop at `under`'s outline: past it they would land on the original faces
// where the copy's face only partly covers them, and show as a dark line.
// Through a hollow shape's hole, the shape on the other side shows as it would
// with no crossing, except that a hollow `under` casts no hole shadow on `over`.
function overCopy(over, under, scene, overlap, pass = 'all') {
  const grow = seeThrough(over) ? 0 : overlap;
  const part = (p, d) => shapeMarkup(over, scene, { keep: solid(under, d), holeKeep: solid(under, 0), pass: p, overlap });
  if (pass === 'face') return part('face', grow);
  if (pass === 'shadow' || !grow) return part(pass, 0);
  return part('shadow', 0) + part('face', grow);
}

const seeThrough = (shape) => shape.style.opacity < 1 || (isTextured(shape.style.material) ? ambientMaterial(shape.style) : shape.style.material) === 'glass';

// Regions are lists of convex polygons that combine by the even-odd rule, so
// that overlapping cutouts can be merged with clipPolygon alone:
// a ∪ b = a ⊕ b ⊕ (a ∩ b), a \ b = a ⊕ (a ∩ b).
const polyArea = (pts) => Math.abs(pts.reduce((sum, [x, y], i) => {
  const [nx, ny] = pts[(i + 1) % pts.length];
  return sum + x * ny - nx * y;
}, 0)) / 2;
const meet = (a, b) => a.flatMap((p) => b.map((q) => clipPolygon(p, q))).filter((p) => p.length > 2 && polyArea(p) > 1e-6);
const join = (a, b) => [...a, ...b, ...meet(a, b)];
const minus = (a, b) => [...a, ...meet(a, b)];

// A shape's outline without its hole, grown by d.
function solid(shape, d) {
  const out = [insetPolygon(outline(shape), -d)];
  const hole = holeShape(shape);
  return hole ? minus(out, [insetPolygon(outline(hole), d)]) : out;
}

const regionClip = (shape, r) => `clip-path:path(evenodd,'${r.map((p) => ring(toBox(shape, p))).join('')}');`;

// keep, narrowed to what cutCss's mask leaves of the pass.
function maskedKeep(shape, keep, hole, pass, overlap) {
  if (pass === 'face') return meet(keep, solid(shape, 0));
  if (pass === 'shadow') return minus(keep, [insetPolygon(outline(shape), overlap)]);
  return minus(keep, [outline(hole)]);
}

// Along every cut edge, `overlap` canvas units (about 1.25 output pixels) are
// painted from both sides: the cutouts for shapes over this one are inset by
// it, and so are those for shapes this one crosses over, unless a copy of this
// shape reaches past their edge instead (overCopy). Two anti-aliased edges
// meeting exactly would let the background show through as a hairline.
// holes: { over: shapes drawn over this one, under: shapes this one is drawn over }
// Returns the region the shape keeps and the one its hole wrapper keeps, which
// also leaves out the shapes over it inside its hole, so its hole shadow and
// glow don't land on them.
function crossingClip(shape, holes, overlap) {
  const pad = inkReach(shape);
  const box = [outline(shape, pad)];
  const own = [outline(shape)];
  const hole = holeShape(shape);
  let cut = [];
  let inHole = [];
  for (const over of holes.over) {
    const b = solid(over, -overlap);
    cut = join(cut, minus(b, own));
    if (hole) inHole = join(inHole, meet(b, [outline(hole)]));
  }
  for (const under of holes.under) {
    const shared = clipPolygon(outline(shape), outline(under));
    if (shared.length <= 2) continue;
    const inset = seeThrough(shape) ? overlap : 0;
    cut = join(cut, meet([insetPolygon(shared, inset)], solid(under, -inset)));
  }
  return { keep: minus(box, cut), holeKeep: minus(box, join(cut, inHole)) };
}

// Reflections of `sources` inside `glossy`, as one layer in glossy's frame:
// blurred, then clipped to glossy's outline and faded out before its rim.
// A reflection sits along the line of sight, so by default it drops straight
// down (the icon is seen slightly from the front). The drop grows with the
// reflected shape's elevation and follows the glossy shape's reflection
// direction, or the scene light when locked to it. The copies skip their
// texture layers, which a blurred reflection can't show, and have no
// elevation, so they cast no shadow.
// Blend stays normal: Chrome's live preview draws a rotated element with another
// mix-blend-mode outside its clip-path.
// holes: shapes glossy is put over by a crossing, which paint over its
// reflections there. within: the shape a crossing copy of glossy is clipped to.
function reflectionMarkup(glossy, sources, scene, overlap, { holes = [], within = null } = {}) {
  const st = glossy.style;
  const r = reflectivity(st);
  const [dx, dy] = st.reflectLock ? [scene.lightX, scene.lightY] : [st.reflectX, st.reflectY];
  const copies = sources.map((src) => {
    const drop = REFLECT_DROP * src.style.elevation;
    const [[cx, cy]] = toBox(glossy, [[src.x + src.w / 2 + dx * drop, src.y + src.h / 2 + dy * drop]]);
    const c = structuredClone(src);
    c.x = cx - src.w / 2;
    c.y = cy - src.h / 2;
    c.rotation = (src.rotation || 0) - (glossy.rotation || 0) + 180;
    Object.assign(c.style, { elevation: 0, glow: false, glowSize: 0 });
    return shapeMarkup(c, scene, { plain: true, overlap });
  }).join('');
  const inner = insetPolygon(outline(glossy), overlap);
  let covered = [];
  for (const u of holes) {
    const shared = clipPolygon(outline(glossy), outline(u));
    if (shared.length > 2) covered = join(covered, [insetPolygon(shared, overlap)]);
  }
  const d = minus([within ? clipPolygon(inner, outline(within)) : inner], covered).map((p) => ring(toBox(glossy, p))).join('');
  const f = num(Math.min(REFLECT_FADE, glossy.w / 4, glossy.h / 4));
  const fade = glossy.kind === 'ellipse'
    ? `radial-gradient(closest-side,#000 calc(100% - ${f}px),transparent)`
    : `linear-gradient(to right,transparent,#000 ${f}px,#000 calc(100% - ${f}px),transparent),linear-gradient(transparent,#000 ${f}px,#000 calc(100% - ${f}px),transparent)`;
  const hole = holeShape(glossy);
  const mask = hole ? `${fade},${holeFadeUrl(glossy, hole, f, overlap)};mask-size:100% 100%;mask-repeat:no-repeat` : fade;
  const blur = num((1 + 0.5 * Math.max(...sources.map((s) => s.style.elevation))) / r);
  const alpha = num(REFLECT_ALPHA * st.reflect * r * st.opacity);
  return `<div class="ir-refl" style="${geometryCss(glossy)}clip-path:path(evenodd,'${d}');filter:blur(${blur}px);mask-image:${mask};mask-composite:intersect;opacity:${alpha}">${copies}</div>`;
}

// A mask over a hollow shape's box that fades out over `f` units toward the
// hole and is empty inside it: the hole, grown by f/2 and blurred.
function holeFadeUrl(shape, hole, f, overlap) {
  const { w, h } = shape;
  const area = `x="0" y="0" width="${num(w)}" height="${num(h)}"`;
  const body = `<filter id="b" filterUnits="userSpaceOnUse" ${area}><feGaussianBlur stdDeviation="${num(f / 4)}"/></filter>`
    + `<mask id="m" maskUnits="userSpaceOnUse" ${area}><rect ${area} fill="#fff"/>`
    + `<path d="${holePath(shape, hole)}" stroke="#000" stroke-width="${num(f)}" stroke-linejoin="round" filter="url(#b)"/></mask>`
    + `<rect ${area} mask="url(#m)"/>`;
  return svgUrl(body, 0, 0, w, h, overlap);
}

const REFLECT_DROP = 9;
const REFLECT_FADE = 9;
const REFLECT_ALPHA = 0.6;

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
  // Shapes that show in a glossy shape: visible ones on top of it, from either
  // layer, so the background layer carries the foreground's reflections.
  const reflected = (g) => (g.style.reflect > 0 && reflectivity(g.style) > 0
    ? ordered.filter((o) => o !== g && !o.hidden && shapesOverlap(o, g) && isOver(variant, o.id, g.id))
    : []);
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
  // A run of level shapes in one layer draws every shadow before any face, so
  // no shadow lands on a face of the run. Copies of them over one shape do the
  // same.
  const runOf = new Map();
  const list = ordered.filter(drawn);
  for (let i = 0; i < list.length;) {
    let j = i + 1;
    if (list[i].level) {
      while (j < list.length && list[j].level && list[j].layer === list[i].layer) j++;
    }
    if (j - i > 1) for (let k = i; k < j; k++) runOf.set(list[k].id, i);
    i = j;
  }
  const groups = (items, shapeOf) => {
    const out = [];
    for (const it of items) {
      const run = runOf.get(shapeOf(it).id);
      const last = out[out.length - 1];
      if (run !== undefined && last && runOf.get(shapeOf(last[0]).id) === run) last.push(it);
      else out.push([it]);
    }
    return out;
  };
  const leveled = (group, shadow, face, all) => (group.length > 1 ? group.map(shadow).join('') + group.map(face).join('') : all(group[0]));
  const pieces = list.map((s) => {
    const overs = (patches.get(s.id) || []).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const unders = coveredBy.get(s.id) || [];
    const clip = overs.length || unders.length ? crossingClip(s, { over: overs, under: unders }, overlap) : {};
    const mirror = reflected(s);
    const refl = mirror.length ? reflectionMarkup(s, mirror, sc, overlap, { holes: unders }) : '';
    const copy = (pass) => (o) => {
      const m = pass !== 'shadow' && reflected(o);
      return overCopy(o, s, sc, overlap, pass) + (m && m.length ? reflectionMarkup(o, m, sc, overlap, { within: s }) : '');
    };
    const copies = groups(overs, (o) => o).map((g) => leveled(g, copy('shadow'), copy('face'), copy('all'))).join('');
    const part = (pass) => shapeMarkup(s, sc, { ...clip, pass, overlap });
    return { s, all: () => part('all') + refl + copies, shadow: () => part('shadow'), face: () => part('face') + refl + copies };
  });
  const shapes = groups(pieces, (p) => p.s).map((g) => leveled(g, (p) => p.shadow(), (p) => p.face(), (p) => p.all())).join('');
  return `<div class="ir-stage" style="${style}">${shapes}</div>`;
}
