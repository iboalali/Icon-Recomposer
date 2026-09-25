// textures.js: our own surface materials (wood, stone, fibers, carbon, neon…)
// drawn as layers inside the shape, on top of the lit ambient.css surface.
//
// A layer is a square covering the shape at any angle, turned to the texture
// direction and clipped back to the shape by .ir-tex. It paints a color derived
// from the shape's own color (--amb-albedo) through an alpha mask, usually an
// SVG noise pattern, and blends it over the surface (multiply darkens, screen
// lightens), so the texture keeps the surface's shading and curvature.
//
// Masks are generated per seed (Shuffle) and per slider value where a slider
// sets a threshold (how many pits, chips or speckles), and cached. They go
// inline in the style attribute, so they are quoted with ' and must not
// contain ' themselves.
//
// Everything is designed at 108 canvas units, but exports and the zoomed
// editor show it several times larger, so textures carry detail down to about
// a quarter of a unit; coarser noise reads as a blurry, upscaled image.

const num = (n) => +(+n).toFixed(3);

// A repeatable pseudo-random number in 0..1 for a seed and an index.
export function rand(seed, i) {
  let h = (Math.imul(seed | 0, 2654435761) ^ Math.imul(i + 1, 40503)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// feTurbulence seed for a pattern's own base seed and the shape's seed.
const ns = (base, seed) => base + (seed % 9973) * 7;

// Noise tiles repeat seamlessly only when each frequency times the tile size
// is a whole number, so frequencies are written as periods per tile.
const noise = (size, px, py, octaves, seed, result = '') =>
  `<feTurbulence type="fractalNoise" baseFrequency="${px / size} ${py / size}" numOctaves="${octaves}" seed="${seed}" stitchTiles="stitch"${result ? ` result="${result}"` : ''}/>`;

// Alpha = k * (noise - t), clamped to 0..1: a soft or hard threshold.
const cut = (k, t, result = '') =>
  `<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${num(k)} 0 0 0 ${num(-k * t)}"${result ? ` result="${result}"` : ''}/>`;

const table = (values, result = '') =>
  `<feComponentTransfer${result ? ` result="${result}"` : ''}><feFuncA type="table" tableValues="${values.join(' ')}"/></feComponentTransfer>`;

// Adds two alpha masks: a + k * b.
const add = (a, b, k) => `<feComposite in="${a}" in2="${b}" operator="arithmetic" k2="1" k3="${k}"/>`;

const svgTile = (size, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
<filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${body}</filter>
<rect width="100%" height="100%" filter="url(#f)"/>
</svg>`;

// Noise cut at a threshold, the building block of speckles, chips and pores.
const spots = (size, period, octaves, seed, k, t) => svgTile(size, noise(size, period, period, octaves, seed) + cut(k, t));

const cache = new Map();
function mask(key, make) {
  if (!cache.has(key)) cache.set(key, `url('data:image/svg+xml,${encodeURIComponent(make())}')`);
  return cache.get(key);
}
const step = (a) => Math.round(a * 50) / 50;

// Plank grain: contours of noise stretched along x, cut into thin bands, fine
// fibers along x, and short dark pores.
const woodPlank = (seed) => mask(`plank:${seed}`, () => svgTile(256,
  noise(256, 1, 6, 3, ns(7, seed)) + cut(1, 0) +
  table(Array.from({ length: 25 }, (_, i) => (i % 2 ? 1 : 0))) +
  '<feComponentTransfer result="bands"><feFuncA type="gamma" amplitude="1" exponent="2.2" offset="0"/></feComponentTransfer>' +
  noise(256, 4, 256, 2, ns(3, seed)) + cut(2.2, 0.36, 'fibers') +
  add('bands', 'fibers', 0.35)));
const woodPores = (seed) => mask(`pores:${seed}`, () => svgTile(256, noise(256, 24, 320, 1, ns(13, seed)) + cut(9, 0.72)));

// End grain as one 1024px image: growth rings of uneven spacing and width
// around a pith slightly off center, wobbled by noise and speckled with pores.
// Rings reach past the corners, so the square is covered everywhere.
const woodRings = (seed) => mask(`rings:${seed}`, () => {
  let i = 0;
  const rnd = () => rand(seed + 11, i++);
  let rings = '';
  for (let r = 3; r < 740; r += 7 + rnd() * 7) {
    rings += `<circle r="${r.toFixed(1)}" stroke-width="${(1.5 + rnd() * 3).toFixed(2)}" stroke-opacity="${(0.45 + rnd() * 0.45).toFixed(2)}"/>`;
  }
  const cx = seed ? 430 + rnd() * 160 : 500;
  const cy = seed ? 430 + rnd() * 160 : 488;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
<filter id="r" filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.006" numOctaves="4" seed="${ns(5, seed)}"/>
<feDisplacementMap in="SourceGraphic" scale="36" xChannelSelector="R" yChannelSelector="G"/>
<feGaussianBlur stdDeviation="0.45" result="rings"/>
<feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="1" seed="${ns(9, seed)}"/>
<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 5 0 0 0 -3.1" result="pores"/>
<feComposite in="rings" in2="pores" operator="arithmetic" k2="1" k3="0.25"/>
</filter>
<g filter="url(#r)"><g transform="translate(${num(cx)} ${num(cy)})" fill="none" stroke="#000">${rings}</g></g>
</svg>`;
});

// Marble veins as one 1024px image. Each vein is a ribbon across the image:
// its middle line wanders with a slope and six sine waves, each finer and
// smaller than the last (so it meanders at every scale), and its width swells
// and pinches along the way. A hairline companion drifts alongside. The shape
// shows the middle of the image, so veins are placed to cross it. Drawn as
// filled paths, so the edges stay clean at any size.
function marbleVeins(key, seed, count, widths, slope, bend, base) {
  return mask(`${key}:${seed}`, () => {
    let i = 0;
    const rnd = () => rand(seed + base, i++);
    const ribbon = (at, width) => {
      const left = [];
      const right = [];
      for (let y = -120; y <= 1144; y += 6) {
        const x = at(y);
        const dx = (at(y + 1) - at(y - 1)) / 2;
        const len = Math.hypot(dx, 1);
        const hw = width(y) / 2;
        left.push(`${(x - hw / len).toFixed(1)} ${(y + (hw * dx) / len).toFixed(1)}`);
        right.push(`${(x + hw / len).toFixed(1)} ${(y - (hw * dx) / len).toFixed(1)}`);
      }
      return `M${left.join('L')}L${right.reverse().join('L')}Z`;
    };
    let paths = '';
    for (let n = 0; n < count; n++) {
      const tilt = slope * (0.5 + rnd());
      const x0 = 512 + (rnd() - 0.5) * 560 - tilt * 512;
      const waves = Array.from({ length: 6 }, (_, k) => ({ f: 0.0035 * 2.1 ** k * (0.8 + rnd() * 0.4), a: bend / 1.9 ** k, p: rnd() * 6.283 }));
      const at = (y, phase = 0) => x0 + tilt * y + waves.reduce((x, w) => x + w.a * Math.sin(w.f * y + w.p + phase), 0);
      const w = widths[0] + rnd() * (widths[1] - widths[0]);
      const wf = [0.004 + rnd() * 0.004, 0.017 + rnd() * 0.01];
      const wp = [rnd() * 6.283, rnd() * 6.283];
      const width = (y) => w * Math.max(0.15, 0.55 + 0.3 * Math.sin(wf[0] * y + wp[0]) + 0.2 * Math.sin(wf[1] * y + wp[1]));
      const o = (0.45 + rnd() * 0.55).toFixed(2);
      paths += `<path d="${ribbon(at, width)}" fill-opacity="${o}"/>`;
      const off = 5 + rnd() * 16;
      const ph = 0.3 + rnd() * 0.5;
      paths += `<path d="${ribbon((y) => at(y, ph) + off, (y) => width(y) * 0.28)}" fill-opacity="${(o * 0.7).toFixed(2)}"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
<filter id="m" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="0.45"/></filter>
<g filter="url(#m)">${paths}</g>
</svg>`;
  });
}
const marbleMain = (seed) => marbleVeins('veins', seed, 5, [2, 6], 0.35, 60, 3);
const marbleFine = (seed) => marbleVeins('fine', seed, 12, [0.6, 1.6], -0.3, 40, 17);
const marbleCloud = (seed) => mask(`cloud:${seed}`, () => svgTile(256, noise(256, 3, 3, 6, ns(4, seed)) + cut(1.6, 0.4)));

// Carbon fiber 2x2 twill: 4x4 cells, each a tow running across (h) or along (v)
// the tile, stepping one cell per row. Each tow is brightest along its middle.
function twill(horizontal) {
  return mask(`twill:${horizontal}`, () => {
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
  });
}

// Crazing: the edges of Voronoi cells around jittered grid points, a seamless
// tile of irregular polygons like the crack network in a glaze. Each cell is
// the square clipped by the bisectors to its neighbors; neighbors wrap around
// the tile, and each cell is drawn at every wrap offset so edges continue
// across the seams. A slight displacement makes the cracks less straight.
function crackleMask(seed) {
  return mask(`crackle:${seed}`, () => {
    const n = 7;
    const size = 256;
    const c = size / n;
    const pts = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        pts.push([(i + 0.15 + rand(seed + 7, k * 2) * 0.7) * c, (j + 0.15 + rand(seed + 7, k * 2 + 1) * 0.7) * c]);
      }
    }
    const clip = (poly, [px, py], [qx, qy]) => {
      const mx = (px + qx) / 2;
      const my = (py + qy) / 2;
      const nx = qx - px;
      const ny = qy - py;
      const side = ([x, y]) => (x - mx) * nx + (y - my) * ny;
      const out = [];
      for (let a = 0; a < poly.length; a++) {
        const u = poly[a];
        const v = poly[(a + 1) % poly.length];
        const su = side(u);
        const sv = side(v);
        if (su <= 0) out.push(u);
        if ((su <= 0) !== (sv <= 0)) {
          const t = su / (su - sv);
          out.push([u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t]);
        }
      }
      return out;
    };
    let d = '';
    for (const p of pts) {
      let poly = [[p[0] - c * 2, p[1] - c * 2], [p[0] + c * 2, p[1] - c * 2], [p[0] + c * 2, p[1] + c * 2], [p[0] - c * 2, p[1] + c * 2]];
      for (const q of pts) {
        for (const ox of [-size, 0, size]) {
          for (const oy of [-size, 0, size]) {
            const qq = [q[0] + ox, q[1] + oy];
            if (qq[0] === p[0] && qq[1] === p[1]) continue;
            if (Math.abs(qq[0] - p[0]) > c * 2.5 || Math.abs(qq[1] - p[1]) > c * 2.5) continue;
            poly = clip(poly, p, qq);
          }
        }
      }
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          d += `M${poly.map(([x, y]) => `${(x + ox).toFixed(1)} ${(y + oy).toFixed(1)}`).join('L')}Z`;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
<filter id="c" x="0" y="0" width="100%" height="100%">${noise(size, 8, 8, 2, ns(71, seed), 'n')}<feDisplacementMap in="SourceGraphic" in2="n" scale="5" xChannelSelector="R" yChannelSelector="G"/></filter>
<path d="${d}" fill="none" stroke="#000" stroke-width="0.9" filter="url(#c)"/>
</svg>`;
  });
}

// Paper fibers as a seamless 256px tile of short, slightly curved strokes in
// every direction, drawn as vector paths so they stay sharp. A stroke that
// crosses an edge is drawn again on the opposite side.
function fiberMask(key, seed, count, len, width) {
  return mask(`${key}:${seed}`, () => {
    let i = 0;
    const rnd = () => rand(seed + 97, i++);
    let d = '';
    for (let n = 0; n < count; n++) {
      const x = rnd() * 256;
      const y = rnd() * 256;
      const a = rnd() * Math.PI;
      const l = len[0] + rnd() * (len[1] - len[0]);
      const bend = (rnd() - 0.5) * l * 0.5;
      const ex = Math.cos(a) * l;
      const ey = Math.sin(a) * l;
      const cx = ex / 2 - Math.sin(a) * bend;
      const cy = ey / 2 + Math.cos(a) * bend;
      const xs = [0, ...(x + Math.max(0, cx, ex) > 256 ? [-256] : []), ...(x + Math.min(0, cx, ex) < 0 ? [256] : [])];
      const ys = [0, ...(y + Math.max(0, cy, ey) > 256 ? [-256] : []), ...(y + Math.min(0, cy, ey) < 0 ? [256] : [])];
      for (const ox of xs) {
        for (const oy of ys) d += `M${(x + ox).toFixed(1)} ${(y + oy).toFixed(1)}q${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><path d="${d}" fill="none" stroke="#000" stroke-width="${width}" stroke-linecap="round"/></svg>`;
  });
}

// Crumpled paper as one 512px image: a jittered grid split into triangles
// along random diagonals, each facet tilted a random way. The tilt is stored
// as four masks (how much each facet faces -x, +x, -y, +y), so the light can
// weight them without regenerating the image when it moves.
function crumpleMasks(seed) {
  const key = (dir) => `crumple:${seed}:${dir}`;
  if (!cache.has(key('-x'))) {
    const n = 12;
    const c = 512 / n;
    const v = [];
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const k = j * (n + 1) + i;
        const edge = i === 0 || j === 0 || i === n || j === n;
        const jx = edge ? 0 : (rand(seed + 5, k * 2) - 0.5) * c * 0.8;
        const jy = edge ? 0 : (rand(seed + 5, k * 2 + 1) - 0.5) * c * 0.8;
        v.push([i * c + jx, j * c + jy]);
      }
    }
    const tris = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = v[j * (n + 1) + i];
        const b = v[j * (n + 1) + i + 1];
        const cc = v[(j + 1) * (n + 1) + i + 1];
        const d = v[(j + 1) * (n + 1) + i];
        const k = j * n + i;
        const pair = rand(seed + 6, k) < 0.5 ? [[a, b, cc], [a, cc, d]] : [[a, b, d], [b, cc, d]];
        pair.forEach((t, h) => {
          const ang = rand(seed + 8, k * 2 + h) * Math.PI * 2;
          const tilt = 0.15 + rand(seed + 9, k * 2 + h) * 0.85;
          tris.push({ t, nx: Math.cos(ang) * tilt, ny: Math.sin(ang) * tilt });
        });
      }
    }
    for (const [dir, f] of [['-x', (t) => -t.nx], ['+x', (t) => t.nx], ['-y', (t) => -t.ny], ['+y', (t) => t.ny]]) {
      const polys = tris.filter((t) => f(t) > 0)
        .map((t) => `<path d="M${t.t.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z" fill-opacity="${f(t).toFixed(2)}"/>`).join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><filter id="b"><feGaussianBlur stdDeviation="1.1"/></filter><g filter="url(#b)" stroke="none">${polys}</g></svg>`;
      cache.set(key(dir), `url('data:image/svg+xml,${encodeURIComponent(svg)}')`);
    }
  }
  return { nx: [cache.get(key('-x')), cache.get(key('+x'))], ny: [cache.get(key('-y')), cache.get(key('+y'))] };
}

// Isotropic noise tiles, keyed by everything that shapes them.
const tile = (name, seed, size, period, octaves, base, k, t) =>
  mask(`${name}:${seed}`, () => svgTile(size, noise(size, period, period, octaves, ns(base, seed)) + cut(k, t)));
const tileXY = (name, seed, size, px, py, octaves, base, k, t) =>
  mask(`${name}:${seed}`, () => svgTile(size, noise(size, px, py, octaves, ns(base, seed)) + cut(k, t)));
const spotsBy = (name, seed, amount, size, period, octaves, base, k, t0, span) =>
  mask(`${name}:${seed}:${step(amount)}`, () => spots(size, period, octaves, ns(base, seed), k, t0 - step(amount) * span));

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
//   mask: an inline url('…'); size: mask tile size in canvas units;
//   repeat: false for a single image; color: CSS color, or bg: any background;
//   blend: mix-blend-mode; opacity: number; angle: extra rotation in degrees;
//   turn: false to ignore the texture angle; pos: mask position offset;
//   shift: false to keep the pattern where it is on Shuffle.
const TEXTURES = {
  wood: (st) => {
    const rings = st.woodFigure === 'rings';
    const s = Math.min(1, st.grain * 0.7);
    return [
      { mask: rings ? woodRings(st.seed) : woodPlank(st.seed), size: rings ? 512 : 128, repeat: !rings, shift: !rings, color: darker(30), blend: 'multiply', opacity: s },
      ...(rings ? [] : [{ mask: woodPores(st.seed), size: 128, color: darker(45), blend: 'multiply', opacity: s * 0.8 }]),
    ];
  },
  marble: (st) => {
    const dark = st.texTone !== 'light';
    const vein = dark ? { color: darker(45), blend: 'multiply' } : { color: lighter(80), blend: 'screen' };
    return [
      { mask: marbleCloud(st.seed), size: 160, color: dark ? darker(14) : lighter(25), blend: vein.blend, opacity: 0.45 * st.grain },
      { mask: marbleFine(st.seed), size: 320, repeat: false, shift: false, ...vein, opacity: Math.min(1, 0.5 * st.grain) },
      { mask: marbleMain(st.seed), size: 320, repeat: false, shift: false, ...vein, opacity: Math.min(1, 0.9 * st.grain) },
    ];
  },
  granite: (st) => [
    { mask: tile('gr-mid', st.seed, 128, 25, 3, 3, 10, 0.52), size: 48, color: darker(30), blend: 'multiply', opacity: Math.min(1, 0.7 * st.grain) },
    { mask: tile('gr-fine', st.seed, 128, 96, 2, 5, 14, 0.6), size: 48, color: darker(45), blend: 'multiply', opacity: Math.min(1, 0.6 * st.grain) },
    { mask: tile('gr-light', st.seed, 128, 25, 3, 2, 14, 0.6), size: 48, color: lighter(70), blend: 'screen', opacity: Math.min(1, 0.9 * st.grain) },
    { mask: tile('gr-sparkle', st.seed, 128, 110, 1, 6, 20, 0.72), size: 48, color: lighter(85), blend: 'screen', opacity: Math.min(1, 0.7 * st.grain) },
    { mask: tile('gr-dark', st.seed, 128, 25, 3, 1, 16, 0.58), size: 48, color: darker(65), blend: 'multiply', opacity: Math.min(1, st.grain) },
  ],
  terrazzo: (st) => {
    const chips = (base, color) => ({ mask: spotsBy(`tz${base}`, st.seed, st.texAmount, 256, 20, 3, base, 34, 0.66, 0.14), size: 128, color, opacity: 1 });
    return [
      chips(11, st.accent),
      chips(12, lighter(55)),
      chips(13, darker(45)),
      { mask: tile('tz-grit', st.seed, 256, 60, 2, 14, 30, 0.66), size: 128, color: darker(55), blend: 'multiply', opacity: Math.min(1, 0.8 * st.grain) },
      { mask: tile('tz-dust', st.seed, 256, 200, 1, 15, 8, 0.55), size: 128, color: darker(25), blend: 'multiply', opacity: Math.min(1, 0.5 * st.grain) },
    ];
  },
  concrete: (st, light) => {
    const layers = [
      { mask: tile('cc-mottle', st.seed, 256, 4, 6, 21, 1.2, 0.35), size: 128, color: darker(25), blend: 'multiply', opacity: Math.min(1, 0.5 * st.grain) },
      { mask: tile('cc-fine', st.seed, 256, 180, 2, 22, 3, 0.48), size: 128, color: darker(22), blend: 'multiply', opacity: Math.min(1, 0.45 * st.grain) },
      { mask: tile('cc-light', st.seed, 256, 180, 1, 24, 4, 0.6), size: 128, color: lighter(35), blend: 'screen', opacity: Math.min(1, 0.35 * st.grain) },
    ];
    if (st.texAmount > 0) {
      const m = spotsBy('cc-pits', st.seed, st.texAmount, 256, 40, 2, 23, 25, 0.8, 0.12);
      layers.push(
        { mask: m, size: 128, color: 'white', blend: 'screen', opacity: 0.35, turn: false, pos: { x: -light.x * 0.4, y: -light.y * 0.4 } },
        { mask: m, size: 128, color: darker(55), blend: 'multiply', opacity: 0.9, turn: false },
      );
    }
    return layers;
  },
  slate: (st) => [
    { mask: tileXY('sl-bands', st.seed, 256, 1, 12, 4, 31, 2, 0.35), size: 160, color: darker(30), blend: 'multiply', opacity: Math.min(1, 0.5 * st.grain) },
    { mask: tileXY('sl-streaks', st.seed, 256, 3, 90, 3, 32, 3, 0.5), size: 160, color: lighter(20), blend: 'screen', opacity: Math.min(1, 0.25 * st.grain) },
    { mask: tileXY('sl-cleave', st.seed, 256, 8, 200, 3, 34, 9, 0.64), size: 160, color: darker(45), blend: 'multiply', opacity: Math.min(1, 0.6 * st.grain) },
    { mask: tileXY('sl-cleave', st.seed, 256, 8, 200, 3, 34, 9, 0.64), size: 160, color: lighter(30), blend: 'screen', opacity: Math.min(1, 0.35 * st.grain), pos: { x: 0, y: -0.35 } },
    { mask: tile('sl-rough', st.seed, 256, 240, 2, 33, 4, 0.5), size: 96, color: darker(35), blend: 'multiply', opacity: st.texAmount },
    { mask: tile('sl-glint', st.seed, 256, 240, 1, 35, 10, 0.7), size: 96, color: lighter(35), blend: 'screen', opacity: st.texAmount * 0.6 },
  ],
  carbon: (st, light) => {
    const l = turn(light, st.texAngle);
    const sheen = (c) => Math.min(1, st.grain * (0.2 + 0.55 * Math.abs(c)));
    return [
      { mask: twill(true), size: 14, shift: false, color: lighter(45), blend: 'screen', opacity: sheen(l.x) },
      { mask: twill(false), size: 14, shift: false, color: lighter(45), blend: 'screen', opacity: sheen(l.y) },
    ];
  },
  ceramic: (st, light) => {
    const layers = [
      // A deeper, richer body where the glaze is thick.
      { color: 'var(--amb-albedo)', blend: 'multiply', opacity: 0.3, turn: false },
    ];
    if (st.mottle > 0) {
      const m = st.mottle;
      layers.push(
        { mask: tile('ce-mottle', st.seed, 256, 3, 4, 42, 1.8, 0.45), size: 128, color: darker(30), blend: 'multiply', opacity: m * 0.8, turn: false },
        { mask: tile('ce-float', st.seed, 256, 5, 4, 43, 2, 0.5), size: 128, color: lighter(30), blend: 'screen', opacity: m * 0.55, turn: false },
        { mask: tileXY('ce-runs', st.seed, 256, 10, 1, 3, 44, 2.2, 0.5), size: 96, color: darker(18), blend: 'multiply', opacity: m * 0.3, turn: false },
        { mask: tile('ce-hue', st.seed, 256, 2, 3, 45, 2, 0.5), size: 160, color: 'oklch(from var(--amb-albedo) l c calc(h + 35))', opacity: m * 0.35, turn: false },
      );
    }
    if (st.texAmount > 0) {
      layers.push({ mask: spotsBy('ce-speckle', st.seed, st.texAmount, 256, 48, 2, 41, 25, 0.82, 0.1), size: 128, color: darker(55), blend: 'multiply', opacity: 0.9, turn: false });
    }
    if (st.crackle > 0) {
      layers.push({ mask: crackleMask(st.seed), size: 40, color: darker(45), blend: 'multiply', opacity: st.crackle, turn: false });
    }
    // Glaze pools toward the edges and thins to a lighter line right at the
    // rim, where the clay shows through.
    layers.push({ fit: true, css: `box-shadow:inset 0 0 0.9px 0.35px ${lighter(40)},inset 0 0 7px 1.5px ${darker(28)}` });
    if (st.finish !== 'matte') {
      const gloss = st.finish === 'gloss';
      const x = num(50 + light.x * 20);
      const y = num(50 + light.y * 20);
      layers.push({
        fit: true,
        bg: `radial-gradient(ellipse ${gloss ? '34% 26%' : '55% 45%'} at ${x}% ${y}%, rgb(255 255 255 / ${gloss ? 0.5 : 0.22}) 0%, rgb(255 255 255 / ${gloss ? 0.12 : 0.06}) 45%, transparent 100%),`
          + 'linear-gradient(to bottom, rgb(255 255 255 / 0.1) 0%, transparent 40%, transparent 70%, rgb(0 0 0 / 0.06) 100%)',
      });
    }
    return layers;
  },
  enamel: (st, light) => {
    const a = num((Math.atan2(light.y, light.x) * 180) / Math.PI + 270);
    const w = num(7 - st.texAmount * 5);
    const band = `linear-gradient(${a}deg, rgb(255 255 255 / 0.3) 0%, transparent 8%, transparent ${num(28 - w)}%, rgb(255 255 255 / 0.55) 28%, transparent ${num(28 + w)}%)`;
    const room = 'linear-gradient(to bottom, rgb(255 255 255 / 0.16) 0%, transparent 45%, transparent 60%, rgb(0 0 0 / 0.1) 100%)';
    const layers = [];
    const metal = RIM_METALS[st.rim] || (st.rim === 'custom' ? st.accent : null);
    const ring = 1.8;
    if (metal) {
      // The enamel sits a little below the rim: a shadow falls on it from the
      // rim on the lit side.
      layers.push({ fit: true, inset: ring, css: `box-shadow:inset ${num(-light.x * 0.9)}px ${num(-light.y * 0.9)}px 1.4px rgb(0 0 0 / 0.35)` });
    }
    layers.push({ fit: true, inset: metal ? ring : 0, bg: `${band}, ${room}` });
    if (metal) {
      const la = num((Math.atan2(light.y, light.x) * 180) / Math.PI + 90);
      const hi = `color-mix(in oklab, ${metal}, white 65%)`;
      const lo = `color-mix(in oklab, ${metal}, black 45%)`;
      layers.push({
        fit: true,
        bg: `linear-gradient(${la}deg, ${lo} 0%, ${metal} 35%, ${hi} 50%, ${metal} 65%, ${lo} 100%)`,
        css: `padding:${ring}px;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);box-sizing:border-box`,
      });
      layers.push({ fit: true, css: `box-shadow:inset 0 0 0 0.35px ${lo}` });
    }
    return layers;
  },
  holographic: (st, light) => holoLayers(st, light),
  paper: (st, light) => paperLayers(st, light, 1),
  cardboard: (st, light) => {
    const layers = paperLayers(st, light, 1.6);
    if (st.texAmount > 0) {
      const l = turn(light, st.texAngle);
      const k = st.texAmount * (0.4 + 0.6 * Math.abs(l.x));
      const hi = `hsl(0 0% ${num(50 + 30 * k)}%)`;
      const lo = `hsl(0 0% ${num(50 - 30 * k)}%)`;
      const [a, b] = l.x < 0 ? [hi, lo] : [lo, hi];
      const p = num(st.texScale * 7);
      layers.splice(layers.length - foldCount(st), 0, { bg: `repeating-linear-gradient(90deg, ${a} 0px, ${b} ${num(p / 2)}px, ${a} ${p}px)`, blend: 'overlay' });
    }
    return layers;
  },
  cork: (st) => {
    const layers = [
      { mask: tile('ck-mid', st.seed, 128, 16, 4, 63, 8, 0.5), size: 64, color: darker(15), blend: 'multiply', opacity: Math.min(1, 0.8 * st.grain) },
      { mask: tile('ck-light', st.seed, 128, 16, 4, 62, 10, 0.57), size: 64, color: lighter(30), blend: 'screen', opacity: Math.min(1, 0.6 * st.grain) },
      { mask: tile('ck-dark', st.seed, 128, 16, 4, 61, 10, 0.55), size: 64, color: darker(35), blend: 'multiply', opacity: Math.min(1, 0.9 * st.grain) },
      { mask: tile('ck-fine', st.seed, 128, 120, 2, 64, 6, 0.55), size: 64, color: darker(30), blend: 'multiply', opacity: Math.min(1, 0.5 * st.grain) },
    ];
    if (st.texAmount > 0) layers.push({ mask: spotsBy('ck-pores', st.seed, st.texAmount, 128, 30, 2, 65, 30, 0.8, 0.1), size: 64, color: darker(65), blend: 'multiply', opacity: 1, turn: false });
    return layers;
  },
};

const HOLO_COLORS = {
  rainbow: [0, 50, 110, 180, 230, 290].map((h) => `hsl(${h} 90% 62%)`),
  pastel: [0, 50, 110, 180, 230, 290].map((h) => `hsl(${h} 85% 82%)`),
  oilslick: ['#2b1b5c', '#1d6f7a', '#3f8f5a', '#6a3e8f', '#b0417a', '#2d5a8f'],
  gold: ['#fff1b8', '#e8b64c', '#b9822a', '#ffe08a', '#d99c3a'],
  silver: ['#ffffff', '#c9ced6', '#8e959f', '#e8ecf2', '#aab1bb'],
};

// Color stops for one period p of a repeating gradient, starting at `from`
// and closed back on the first color. Sharpness widens each color from a
// point into a flat band. Shifting `from` moves the bands without moving the
// gradient box, which would show a seam where the box repeats.
function holoStops(colors, p, sharp, unit, from = 0) {
  const n = colors.length;
  const hw = p / n / 2;
  const o = ((from % p) + p) % p - p;
  const stops = [];
  colors.forEach((c, i) => {
    const mid = o + ((i + 0.5) / n) * p;
    stops.push(`${c} ${num(mid - hw * sharp)}${unit}`, `${c} ${num(mid + hw * sharp)}${unit}`);
  });
  return `${colors[n - 1]} ${num(o)}${unit}, ${stops.join(', ')}, ${colors[n - 1]} ${num(o + p)}${unit}`;
}

// Glitter: six groups of small flakes, each group a facet facing its own
// direction, lit by how much that direction faces the light.
function glitterMask(seed, g) {
  return mask(`glitter:${seed}:${g}`, () => {
    let i = 0;
    const rnd = () => rand(seed + 31 + g * 101, i++);
    let d = '';
    for (let n = 0; n < 34; n++) {
      const x = rnd() * 128;
      const y = rnd() * 128;
      const r = 2.6 + rnd() * 2.4;
      const a = rnd() * Math.PI;
      const pts = [0, 1, 2, 3, 4, 5].map((k) => [x + Math.cos(a + (k * Math.PI) / 3) * r, y + Math.sin(a + (k * Math.PI) / 3) * r]);
      d += `M${pts.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join('L')}Z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><path d="${d}"/></svg>`;
  });
}

function holoLayers(st, light) {
  const colors = st.holoPalette === 'custom' ? [st.accent, st.accent2, `color-mix(in oklab, ${st.accent}, ${st.accent2})`] : HOLO_COLORS[st.holoPalette];
  const lightAngle = (Math.atan2(light.y, light.x) * 180) / Math.PI;
  const a = num(st.holoFollow === 'light' ? lightAngle + 90 : st.texAngle);
  const resp = st.holoShift;
  const strength = Math.min(1, 0.6 * st.grain);
  const p = num(st.texScale * 40);
  const layers = [];
  if (st.holoBase === 'silver') {
    layers.push({ fit: true, bg: `linear-gradient(${num(lightAngle + 90)}deg, #eef1f5 0%, #a3aab4 30%, #f7f9fb 55%, #9aa1ab 80%, #dfe3e8 100%)`, opacity: 0.9 });
  }
  // The palette's hue goes on with the color blend, which keeps the surface's
  // own lightness and shading; soft light carries the palette's own light and
  // dark (all a silver foil has), and a weaker screen on top adds the sheen.
  const paint = (layer) => [
    { ...layer, blend: 'color', opacity: strength },
    { ...layer, blend: 'soft-light', opacity: strength },
    { ...layer, blend: 'screen', opacity: strength * 0.4 },
  ];
  if (st.holoPattern === 'bands') {
    const shift = (light.x + light.y) * p * resp;
    layers.push(...paint({ bg: `repeating-linear-gradient(${a}deg, ${holoStops(colors, p, st.holoSharp, 'px', shift)})`, turn: false }));
  } else if (st.holoPattern === 'swirl') {
    const cx = num(50 - light.x * 30 * resp);
    const cy = num(50 - light.y * 30 * resp);
    const turns = Math.max(1, Math.round(4 / st.texScale));
    layers.push(...paint({ fit: true, bg: `repeating-conic-gradient(from ${num(a + lightAngle * resp)}deg at ${cx}% ${cy}%, ${holoStops(colors, 360 / turns, st.holoSharp, 'deg')})` }));
  } else if (st.holoPattern === 'prism') {
    const cell = num(st.texScale * 9);
    layers.push(...paint({ bg: `repeating-conic-gradient(from ${num(a + lightAngle * resp * 2)}deg, ${holoStops(colors, 360, st.holoSharp, 'deg')})`, css: `background-size:${cell}px ${cell}px`, turn: false }));
  } else {
    for (let g = 0; g < 6; g++) {
      const facing = (g * 60 * Math.PI) / 180;
      const lit = Math.max(0, Math.cos(facing - (lightAngle * Math.PI) / 180));
      const o = Math.min(1, st.grain) * (1 - resp + resp * (0.1 + 0.9 * lit));
      layers.push({ mask: glitterMask(st.seed, g), size: 24, color: `color-mix(in oklab, ${colors[g % colors.length]}, white ${num(lit * 35)}%)`, opacity: o, turn: false });
    }
  }
  if (st.texAmount > 0) {
    layers.push({ bg: `repeating-linear-gradient(${num(a + 90)}deg, rgb(255 255 255 / 0.6) 0 0.2px, transparent 0.2px 0.7px)`, blend: 'screen', opacity: st.texAmount * 0.35, turn: false });
  }
  return layers;
}

const foldCount = (st) => ({ none: 0, one: 1, two: 2 })[st.folds] || 0;

// Paper: cloudy formation, dark and light fibers, a fine tooth, and per type
// kraft flecks or laid and chain lines; then crumpled facets and folds, both
// lit from the scene light. `weight` makes everything coarser for cardboard.
function paperLayers(st, light, weight) {
  const g = Math.min(1, st.grain);
  const kraft = st.paperType === 'kraft';
  const layers = [
    { mask: tile('pa-form', st.seed, 256, 5, 5, 52, 1.4, 0.42), size: 96, color: darker(kraft ? 16 : 9), blend: 'multiply', opacity: 0.6 * g },
    { mask: fiberMask('pa-dark', st.seed, 260, [4, 14], 0.35 * weight), size: 64 * weight, color: darker(kraft ? 28 : 16), blend: 'multiply', opacity: 0.4 * g },
    { mask: fiberMask('pa-light', st.seed + 1, 160, [4, 12], 0.4 * weight), size: 64 * weight, color: lighter(40), blend: 'screen', opacity: 0.35 * g },
    { mask: tile('pa-tooth', st.seed, 256, 200, 1, 53, 2, 0.5), size: 96, color: darker(8), blend: 'multiply', opacity: 0.5 * g },
  ];
  if (kraft) {
    layers.push({ mask: fiberMask('pa-fleck', st.seed + 2, 70, [1.2, 5], 0.8 * weight), size: 64 * weight, color: darker(60), blend: 'multiply', opacity: 0.75 * g });
  }
  if (st.paperType === 'laid') {
    layers.push(
      { bg: 'repeating-linear-gradient(0deg, rgb(0 0 0 / 0.045) 0 0.25px, transparent 0.25px 0.8px)' },
      { bg: 'repeating-linear-gradient(90deg, rgb(0 0 0 / 0.05) 0 0.5px, transparent 0.5px 14px)' },
    );
  }
  if (st.crumple > 0) {
    const m = crumpleMasks(st.seed);
    const k = st.crumple * 0.42;
    for (const [axis, c] of [['nx', light.x], ['ny', light.y]]) {
      const [neg, pos] = m[axis];
      const [lit, shade] = c < 0 ? [neg, pos] : [pos, neg];
      const o = k * Math.abs(c);
      layers.push(
        { mask: lit, size: 140, repeat: false, shift: false, turn: false, color: lighter(70), blend: 'screen', opacity: o },
        { mask: shade, size: 140, repeat: false, shift: false, turn: false, color: darker(40), blend: 'multiply', opacity: o },
      );
    }
  }
  // A fold tilts the two halves opposite ways: one catches the light, the
  // other turns away, and the crease between them catches a thin highlight.
  const l = turn(light, st.texAngle);
  for (let f = 0; f < foldCount(st); f++) {
    const c = f ? l.x : l.y;
    const tone = (v) => (v > 0 ? `rgb(255 255 255 / ${num(v * 0.16)})` : `rgb(0 0 0 / ${num(-v * 0.1)})`);
    const a = tone(-c);
    const b = tone(c);
    layers.push({ bg: `linear-gradient(to bottom, ${a} 0%, ${a} 49.6%, rgb(255 255 255 / 0.22) 50%, ${b} 50.4%, ${b} 100%)`, angle: f ? -90 : 0 });
  }
  return layers;
}

// Materials that take a matte, satin or glossy finish on top. Ceramic draws
// its own softer gloss.
const FINISHED = new Set(['wood', 'marble', 'granite', 'terrazzo', 'carbon']);

const RIM_METALS = { gold: '#d4a53c', silver: '#c3c8cf', black: '#3b3e44' };

export const isTextured = (material) => material in TEXTURES;
// An enamel's metal rim covers the shape's own edge highlight, which would
// tint the metal with the enamel's color.
export const coversEdge = (st) => st.material === 'enamel' && st.rim !== 'none';
export const hasFinish = (material) => FINISHED.has(material);

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
/* Finer sandblast grain than ambient.css's own tile, which is about a canvas
   unit across and reads as a blurry upscale at export size. */
.ir-shape.amb-mat-blasted { --_grain-scale: 56px; --_grain-offset: 1px; }
`;

// A fit layer follows the shape's own outline (inset by `inset` units)
// instead of being a turned square, for effects that belong to the edge.
function layerMarkup(layer, st, d) {
  let css;
  if (layer.fit) {
    css = `inset:${num(layer.inset || 0)}px;margin:0;border-radius:inherit;`;
  } else {
    const angle = (layer.turn === false ? 0 : st.texAngle) + (layer.angle || 0);
    css = `width:${d}px;height:${d}px;margin:${-d / 2}px 0 0 ${-d / 2}px;`;
    if (angle) css += `transform:rotate(${num(angle)}deg);`;
  }
  if (layer.bg) {
    css += `background:${layer.bg};`;
    if (layer.bgPos) css += `background-position:${layer.bgPos};`;
  } else if (layer.color) {
    css += `background:${layer.color};`;
  }
  if (layer.css) css += `${layer.css};`;
  if (layer.mask) {
    const size = layer.size * st.texScale;
    css += `mask-image:${layer.mask};mask-size:${num(size)}px;`;
    if (layer.repeat === false) css += 'mask-repeat:no-repeat;';
    // A shuffled tile also starts at a random point, so repeats of the
    // pattern don't line up with the shape's edges the same way.
    let x = layer.pos?.x || 0;
    let y = layer.pos?.y || 0;
    if (st.seed && layer.shift !== false) {
      x += rand(st.seed, 90) * size;
      y += rand(st.seed, 91) * size;
    }
    if (x || y) css += `mask-position:calc(50% + ${num(x)}px) calc(50% + ${num(y)}px);`;
  }
  if (layer.blend) css += `mix-blend-mode:${layer.blend};`;
  if (layer.opacity !== undefined && layer.opacity < 1) css += `opacity:${num(Math.max(0, layer.opacity))};`;
  return `<div style="${css}"></div>`;
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

// Shuffle for ambient.css's metals, through the hooks render.js adds: a new
// offset and length for the brushed streaks and the blasted grain, and for
// radial brushed a new spin center, turn of the streaks and hotspot size.
// Offsets stay whole pixels, which the grain's pixel snapping needs.
export function metalVars(shape) {
  const { seed, material } = shape.style;
  if (!seed) return '';
  const r = (i) => rand(seed, i);
  if (material === 'brushed') {
    const size = Math.round(512 * (1 + r(1) * 0.8));
    return `;--ir-grain-dx:${Math.round(r(2) * size)}px;--ir-grain-dy:${Math.round(r(3) * size)}px;--_grain-scale:${size}px`;
  }
  if (material === 'blasted') return `;--ir-grain-dx:${Math.round(r(2) * 56)}px;--ir-grain-dy:${Math.round(r(3) * 56)}px`;
  if (material === 'brushed-round') {
    const dx = Math.round((r(2) - 0.5) * 0.5 * shape.w);
    const dy = Math.round((r(3) - 0.5) * 0.5 * shape.h);
    return `;--ir-spin-dx:${dx}px;--ir-spin-dy:${dy}px;--ir-spin-turn:${Math.round(r(4) * 360)}deg;--ir-spin-spot:${Math.round(22 + r(5) * 36)}%`;
  }
  return '';
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
