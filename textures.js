// textures.js: our own surface materials (wood, stone, fibers, carbon, neon…)
// drawn as layers inside the shape, on top of the lit ambient.css surface.
//
// A layer is a square covering the shape at any angle, turned to the texture
// direction and clipped back to the shape by .ir-tex. It paints a color derived
// from the shape's own color (--amb-albedo) through an alpha mask, usually an
// SVG noise pattern, and blends it over the surface (multiply darkens, screen
// lightens), so the texture keeps the surface's shading and curvature.
//
// Masks that never change are CSS classes. Masks with a threshold the user
// controls (how many pits, chips or speckles) are generated per value and
// cached. They go inline in the style attribute, so they are quoted with ' and
// must not contain ' themselves.

const num = (n) => +(+n).toFixed(3);

// Noise tiles repeat seamlessly only when each frequency times the tile size
// is a whole number, so frequencies are written as periods per tile.
const noise = (size, px, py, octaves, seed) =>
  `<feTurbulence type="fractalNoise" baseFrequency="${px / size} ${py / size}" numOctaves="${octaves}" seed="${seed}" stitchTiles="stitch"/>`;

// Alpha = k * (noise - t), clamped to 0..1: a soft or hard threshold.
const cut = (k, t) =>
  `<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${num(k)} 0 0 0 ${num(-k * t)}"/>`;

const table = (values) =>
  `<feComponentTransfer><feFuncA type="table" tableValues="${values.join(' ')}"/></feComponentTransfer>`;

const svgTile = (size, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
<filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${body}</filter>
<rect width="100%" height="100%" filter="url(#f)"/>
</svg>`;

// Noise cut at a threshold, the building block of speckles, chips and pores.
const spots = (size, period, octaves, seed, k, t) => svgTile(size, noise(size, period, period, octaves, seed) + cut(k, t));

const url = (svg, q = '"') => `url(${q}data:image/svg+xml,${encodeURIComponent(svg)}${q})`;

const peaks = (n, at, width = 1) =>
  Array.from({ length: n }, (_, i) => Math.max(0, 1 - Math.min(...at.map((a) => Math.abs(i - a))) / width).toFixed(2));

// Plank grain: contours of noise stretched along x, cut into thin bands, plus
// fine fibers along x.
const WOOD_PLANK = svgTile(256,
  noise(256, 1, 6, 2, 7) + cut(1, 0) +
  table(Array.from({ length: 25 }, (_, i) => (i % 2 ? 1 : 0))) +
  '<feComponentTransfer result="bands"><feFuncA type="gamma" amplitude="1" exponent="2.2" offset="0"/></feComponentTransfer>' +
  noise(256, 4, 128, 2, 3) + '<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 2 0 0 0 -0.75" result="fibers"/>' +
  '<feComposite in="bands" in2="fibers" operator="arithmetic" k2="1" k3="0.4"/>');

// End grain as one 1024px image: growth rings of uneven spacing and width
// around a pith slightly off center, wobbled by noise and speckled with pores.
// Rings reach past the corners, so the square is covered everywhere.
const WOOD_RINGS = (() => {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let rings = '';
  for (let r = 3; r < 740; r += 7 + rnd() * 7) {
    rings += `<circle r="${r.toFixed(1)}" stroke-width="${(1.5 + rnd() * 3).toFixed(2)}" stroke-opacity="${(0.45 + rnd() * 0.45).toFixed(2)}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
<filter id="r" filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.006" numOctaves="3" seed="5"/>
<feDisplacementMap in="SourceGraphic" scale="36" xChannelSelector="R" yChannelSelector="G"/>
<feGaussianBlur stdDeviation="0.6" result="rings"/>
<feTurbulence type="fractalNoise" baseFrequency="0.5" numOctaves="1" seed="9"/>
<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 3 0 0 0 -1.7" result="pores"/>
<feComposite in="rings" in2="pores" operator="arithmetic" k2="1" k3="0.2"/>
</filter>
<g filter="url(#r)"><g transform="translate(500 488)" fill="none" stroke="#000">${rings}</g></g>
</svg>`;
})();

// Marble veins as one 1024px image: straight lines of uneven width and
// strength, bent into wandering veins by strong low-frequency displacement,
// plus a finer family of branch veins bent differently.
function marbleVeins(count, widths, spread, freq, scale, seed) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let lines = '';
  for (let i = 0; i < count; i++) {
    const x = -200 + rnd() * 1424;
    const w = widths[0] + rnd() * (widths[1] - widths[0]);
    lines += `<line x1="${x.toFixed(0)}" y1="-200" x2="${(x + spread).toFixed(0)}" y2="1224" stroke-width="${w.toFixed(2)}" stroke-opacity="${(0.35 + rnd() * 0.65).toFixed(2)}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
<filter id="m" filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="3" seed="${seed}"/>
<feDisplacementMap in="SourceGraphic" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
<feGaussianBlur stdDeviation="0.5"/>
</filter>
<g filter="url(#m)" stroke="#000">${lines}</g>
</svg>`;
}
const MARBLE_VEINS = marbleVeins(12, [1.5, 5], 420, 0.003, 170, 3);
const MARBLE_FINE = marbleVeins(26, [0.6, 1.6], -300, 0.005, 130, 17);
const MARBLE_CLOUD = svgTile(256, noise(256, 3, 3, 3, 4) + cut(1.6, 0.4));

// Carbon fiber 2x2 twill: 4x4 cells, each a tow running across (h) or along (v)
// the tile, stepping one cell per row. Each tow is brightest along its middle.
function twill(horizontal) {
  let cells = '';
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const h = (i + j) % 4 < 2;
      if (h !== horizontal) continue;
      cells += h
        ? `<rect x="${i * 16}" y="${j * 16 + 1}" width="16" height="14" fill="url(#h)"/>`
        : `<rect x="${i * 16 + 1}" y="${j * 16}" width="14" height="16" fill="url(#v)"/>`;
    }
  }
  const stops = '<stop offset="0" stop-opacity="0.1"/><stop offset="0.5" stop-opacity="1"/><stop offset="1" stop-opacity="0.1"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs>
<linearGradient id="h" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>
<linearGradient id="v" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient>
</defs>${cells}</svg>`;
}

const STATIC_MASKS = {
  'wood-plank': WOOD_PLANK,
  'wood-rings': WOOD_RINGS,
  'marble-veins': MARBLE_VEINS,
  'marble-fine': MARBLE_FINE,
  'marble-cloud': MARBLE_CLOUD,
  'granite-dark': spots(128, 25, 2, 1, 12, 0.58),
  'granite-light': spots(128, 25, 2, 2, 12, 0.6),
  'granite-mid': spots(128, 25, 2, 3, 8, 0.52),
  'terrazzo-grit': spots(256, 40, 1, 14, 30, 0.66),
  'concrete-mottle': svgTile(256, noise(256, 4, 4, 4, 21) + cut(1.2, 0.35)),
  'concrete-fine': spots(256, 64, 1, 22, 2, 0.45),
  'slate-bands': svgTile(256, noise(256, 1, 12, 3, 31) + cut(2, 0.35)),
  'slate-streaks': svgTile(256, noise(256, 2, 40, 2, 32) + cut(3, 0.5)),
  'slate-rough': spots(256, 64, 2, 33, 2.5, 0.45),
  'carbon-h': twill(true),
  'carbon-v': twill(false),
  'paper-fibers': svgTile(256, noise(256, 16, 96, 1, 51) + cut(5, 0.6)),
  'paper-mottle': svgTile(256, noise(256, 8, 8, 3, 52) + cut(1.5, 0.4)),
  'cork-dark': spots(128, 16, 2, 61, 10, 0.55),
  'cork-light': spots(128, 16, 2, 62, 10, 0.57),
  'cork-mid': spots(128, 16, 2, 63, 8, 0.5),
};

// Masks whose threshold follows a slider, generated per value.
const dynamicCache = new Map();
function dynamicMask(key, make) {
  if (!dynamicCache.has(key)) dynamicCache.set(key, url(make(), "'"));
  return dynamicCache.get(key);
}
const amountKey = (a) => Math.round(a * 50) / 50;
const terrazzoChips = (seed, a) => dynamicMask(`chips${seed}:${amountKey(a)}`, () => spots(256, 20, 1, seed, 30, 0.66 - amountKey(a) * 0.14));
const pits = (seed, period, a, base, span) =>
  dynamicMask(`pits${seed}:${amountKey(a)}`, () => spots(256, period, 1, seed, 25, base - amountKey(a) * span));

// Colors derived from the shape color.
const darker = (p) => `color-mix(in oklab, var(--amb-albedo), black ${p}%)`;
const lighter = (p) => `color-mix(in oklab, var(--amb-albedo), white ${p}%)`;

// Light direction in a layer's own frame (the shape's local light turned back
// by the layer's angle).
function turn(light, deg) {
  const t = (deg * Math.PI) / 180;
  return { x: light.x * Math.cos(t) + light.y * Math.sin(t), y: -light.x * Math.sin(t) + light.y * Math.cos(t) };
}

// Each material lists its layers. A layer:
//   mask: STATIC_MASKS key or an inline url('…'); size: mask tile size (CSS);
//   repeat: false for a single image; color: CSS color, or bg: any background;
//   blend: mix-blend-mode; opacity: number; angle: extra rotation in degrees;
//   turn: false to ignore the texture angle; pos: mask position offset.
const TEXTURES = {
  wood: (st) => [{
    mask: st.woodFigure === 'rings' ? 'wood-rings' : 'wood-plank',
    size: st.woodFigure === 'rings' ? 512 : 128,
    repeat: st.woodFigure !== 'rings',
    color: darker(30), blend: 'multiply', opacity: Math.min(1, st.grain * 0.7),
  }],
  marble: (st) => {
    const dark = st.texTone !== 'light';
    const vein = dark ? { color: darker(45), blend: 'multiply' } : { color: lighter(80), blend: 'screen' };
    return [
      { mask: 'marble-cloud', size: 160, color: dark ? darker(14) : lighter(25), blend: vein.blend, opacity: 0.45 * st.grain },
      { mask: 'marble-fine', size: 320, repeat: false, ...vein, opacity: Math.min(1, 0.5 * st.grain) },
      { mask: 'marble-veins', size: 320, repeat: false, ...vein, opacity: Math.min(1, 0.9 * st.grain) },
    ];
  },
  granite: (st) => [
    { mask: 'granite-mid', size: 48, color: darker(30), blend: 'multiply', opacity: Math.min(1, 0.8 * st.grain) },
    { mask: 'granite-light', size: 48, color: lighter(70), blend: 'screen', opacity: Math.min(1, 0.9 * st.grain) },
    { mask: 'granite-dark', size: 48, color: darker(65), blend: 'multiply', opacity: Math.min(1, st.grain) },
  ],
  terrazzo: (st) => [
    { mask: terrazzoChips(11, st.texAmount), size: 128, color: st.accent, opacity: 1 },
    { mask: terrazzoChips(12, st.texAmount), size: 128, color: lighter(55), opacity: 1 },
    { mask: terrazzoChips(13, st.texAmount), size: 128, color: darker(45), opacity: 1 },
    { mask: 'terrazzo-grit', size: 128, color: darker(55), blend: 'multiply', opacity: Math.min(1, 0.8 * st.grain) },
  ],
  concrete: (st, light) => {
    const layers = [
      { mask: 'concrete-mottle', size: 128, color: darker(25), blend: 'multiply', opacity: Math.min(1, 0.5 * st.grain) },
      { mask: 'concrete-fine', size: 128, color: darker(20), blend: 'multiply', opacity: Math.min(1, 0.35 * st.grain) },
    ];
    if (st.texAmount > 0) {
      const m = pits(23, 40, st.texAmount, 0.8, 0.12);
      layers.push(
        { mask: m, size: 128, color: 'white', blend: 'screen', opacity: 0.35, turn: false, pos: { x: -light.x * 0.5, y: -light.y * 0.5 } },
        { mask: m, size: 128, color: darker(55), blend: 'multiply', opacity: 0.9, turn: false },
      );
    }
    return layers;
  },
  slate: (st) => [
    { mask: 'slate-bands', size: 160, color: darker(35), blend: 'multiply', opacity: Math.min(1, 0.8 * st.grain) },
    { mask: 'slate-streaks', size: 160, color: lighter(25), blend: 'screen', opacity: Math.min(1, 0.5 * st.grain) },
    { mask: 'slate-rough', size: 96, color: darker(30), blend: 'multiply', opacity: st.texAmount },
  ],
  carbon: (st, light) => {
    const l = turn(light, st.texAngle);
    const sheen = (c) => Math.min(1, st.grain * (0.2 + 0.55 * Math.abs(c)));
    return [
      { mask: 'carbon-h', size: 14, color: lighter(45), blend: 'screen', opacity: sheen(l.x) },
      { mask: 'carbon-v', size: 14, color: lighter(45), blend: 'screen', opacity: sheen(l.y) },
    ];
  },
  ceramic: (st) => {
    const layers = [{ color: 'var(--amb-albedo)', blend: 'multiply', opacity: 0.3, turn: false }];
    if (st.texAmount > 0) {
      layers.push({ mask: pits(41, 48, st.texAmount, 0.82, 0.1), size: 128, color: darker(55), blend: 'multiply', opacity: 0.9, turn: false });
    }
    return layers;
  },
  enamel: (st, light) => {
    const a = num((Math.atan2(light.y, light.x) * 180) / Math.PI + 270);
    const w = num(7 - st.texAmount * 5);
    const band = `linear-gradient(${a}deg, rgb(255 255 255 / 0.3) 0%, transparent 8%, transparent ${num(28 - w)}%, rgb(255 255 255 / 0.55) 28%, transparent ${num(28 + w)}%)`;
    const room = 'linear-gradient(to bottom, rgb(255 255 255 / 0.16) 0%, transparent 45%, transparent 60%, rgb(0 0 0 / 0.1) 100%)';
    return [{ bg: `${band}, ${room}`, turn: false }];
  },
  holographic: (st, light) => {
    const a = num((Math.atan2(light.y, light.x) * 180) / Math.PI + 90);
    const p = num(st.texScale * 40);
    const shift = num((light.x + light.y) * p * 0.5);
    const hues = [0, 50, 110, 180, 230, 290, 360].map((h, i) => `hsl(${h} 90% 62%) ${num((i / 6) * p)}px`).join(', ');
    const layers = [{ bg: `repeating-linear-gradient(${a}deg, ${hues})`, bgPos: `${shift}px ${shift}px`, blend: 'screen', opacity: Math.min(1, 0.6 * st.grain), turn: false }];
    if (st.texAmount > 0) {
      layers.push({ bg: `repeating-linear-gradient(${num(a + 90)}deg, rgb(255 255 255 / 0.7) 0 0.35px, transparent 0.35px 1.4px)`, blend: 'screen', opacity: st.texAmount * 0.6, turn: false });
    }
    return layers;
  },
  paper: (st) => [
    { mask: 'paper-mottle', size: 96, color: darker(12), blend: 'multiply', opacity: Math.min(1, 0.4 * st.grain) },
    ...[0, 60, 120].map((angle) => ({ mask: 'paper-fibers', size: 96, color: darker(18), blend: 'multiply', opacity: Math.min(1, 0.22 * st.grain), angle })),
  ],
  cardboard: (st, light) => {
    const layers = [
      { mask: 'paper-mottle', size: 128, color: darker(18), blend: 'multiply', opacity: Math.min(1, 0.5 * st.grain) },
      ...[0, 60, 120].map((angle) => ({ mask: 'paper-fibers', size: 128, color: darker(30), blend: 'multiply', opacity: Math.min(1, 0.25 * st.grain), angle })),
    ];
    if (st.texAmount > 0) {
      const l = turn(light, st.texAngle);
      const k = st.texAmount * (0.4 + 0.6 * Math.abs(l.x));
      const hi = `hsl(0 0% ${num(50 + 30 * k)}%)`;
      const lo = `hsl(0 0% ${num(50 - 30 * k)}%)`;
      const [a, b] = l.x < 0 ? [hi, lo] : [lo, hi];
      const p = num(st.texScale * 7);
      layers.push({ bg: `repeating-linear-gradient(90deg, ${a} 0px, ${b} ${num(p / 2)}px, ${a} ${p}px)`, blend: 'overlay' });
    }
    return layers;
  },
  cork: (st) => {
    const layers = [
      { mask: 'cork-mid', size: 64, color: darker(15), blend: 'multiply', opacity: Math.min(1, 0.8 * st.grain) },
      { mask: 'cork-light', size: 64, color: lighter(30), blend: 'screen', opacity: Math.min(1, 0.6 * st.grain) },
      { mask: 'cork-dark', size: 64, color: darker(35), blend: 'multiply', opacity: Math.min(1, 0.9 * st.grain) },
    ];
    if (st.texAmount > 0) layers.push({ mask: pits(64, 30, st.texAmount, 0.8, 0.1), size: 64, color: darker(65), blend: 'multiply', opacity: 1, turn: false });
    return layers;
  },
};

// Materials that take a matte, satin or glossy finish on top.
const FINISHED = new Set(['wood', 'marble', 'granite', 'terrazzo', 'carbon', 'ceramic']);

export const isTextured = (material) => material in TEXTURES;
export const hasFinish = (material) => FINISHED.has(material);

// Every layer is absolutely positioned; the static masks are classes.
export const TEXTURE_CSS = `
.ir-shape.ir-textured { isolation: isolate; }
.ir-tex {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
  pointer-events: none;
}
.ir-tex > div { position: absolute; left: 50%; top: 50%; mask-position: center; }
${Object.entries(STATIC_MASKS).map(([k, svg]) => `.ir-m-${k} { mask-image: ${url(svg)}; }`).join('\n')}
/* Gloss is ambient.css's shiny sheen on its own layer above the texture, so
   the reflection is not darkened by the texture under it. */
.ir-sheen {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
}
.ir-sheen.ir-satin { opacity: 0.5; }
.ir-neon-face { position: absolute; inset: 0; border-radius: inherit; pointer-events: none; }
`;

function layerMarkup(layer, st, d) {
  const angle = (layer.turn === false ? 0 : st.texAngle) + (layer.angle || 0);
  let css = `width:${d}px;height:${d}px;margin:${-d / 2}px 0 0 ${-d / 2}px;`;
  if (angle) css += `transform:rotate(${num(angle)}deg);`;
  let cls = '';
  if (layer.bg) {
    css += `background:${layer.bg};`;
    if (layer.bgPos) css += `background-position:${layer.bgPos};`;
  } else {
    css += `background:${layer.color};`;
  }
  if (layer.mask) {
    if (layer.mask.startsWith('url(')) css += `mask-image:${layer.mask};`;
    else cls = ` class="ir-m-${layer.mask}"`;
    const size = num(layer.size * st.texScale);
    css += `mask-size:${size}px;`;
    if (layer.repeat === false) css += 'mask-repeat:no-repeat;';
    if (layer.pos) css += `mask-position:calc(50% + ${num(layer.pos.x)}px) calc(50% + ${num(layer.pos.y)}px);`;
  }
  if (layer.blend) css += `mix-blend-mode:${layer.blend};`;
  if (layer.opacity !== undefined && layer.opacity < 1) css += `opacity:${num(Math.max(0, layer.opacity))};`;
  return `<div${cls} style="${css}"></div>`;
}

// light: the scene light in the shape's own frame.
export function textureMarkup(shape, light) {
  const st = shape.style;
  const make = TEXTURES[st.material];
  if (!make) return '';
  const d = Math.ceil(Math.hypot(shape.w, shape.h)) + 2;
  const layers = make(st, light).map((l) => layerMarkup(l, st, d)).join('');
  let out = `<div class="ir-tex">${layers}</div>`;
  if (hasFinish(st.material) && st.finish !== 'matte') {
    out += `<div class="ir-sheen amb-mat-shiny${st.finish === 'satin' ? ' ir-satin' : ''}"></div>`;
  }
  return out;
}

// Neon ignores the scene light: a face that is brightest along its core.
export function neonFace(shape) {
  const st = shape.style;
  const core = num(st.texAmount * 90);
  const white = `color-mix(in oklab, ${st.color}, white ${core}%)`;
  const mid = `color-mix(in oklab, ${st.color}, white ${num(core * 0.45)}%)`;
  const rim = `color-mix(in oklab, ${st.color}, black 25%)`;
  const ratio = shape.w / shape.h;
  // A long shape is a tube, lit along its middle line; a squarish one glows
  // from its center.
  const bg = ratio > 1.6 || ratio < 1 / 1.6
    ? `linear-gradient(${ratio > 1 ? 'to bottom' : 'to right'}, ${rim} 0%, ${st.color} 14%, ${mid} 32%, ${white} 50%, ${mid} 68%, ${st.color} 86%, ${rim} 100%)`
    : `radial-gradient(farthest-side, ${white} 0%, ${mid} 35%, ${st.color} 72%, ${rim} 100%)`;
  return `<div class="ir-neon-face" style="background:${bg}"></div>`;
}
