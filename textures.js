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

// Woven cloth as a seamless tile of n×n thread crossings, 16px each. At each
// crossing weftOver(i, j) says whether the weft (running along x) or the warp
// (along y) is on top. Every thread has its own slightly uneven width; `fill`
// is how much of its 16px a thread takes. Parts:
//   weft: the weft where it is on top; hlWeft, hlWarp: a highlight along the
//   middle of each thread on top; shade: the sides of the threads on top and
//   the stubs of the thread diving under; gap: the holes between threads.
function weave(name, seed, n, weftOver, fill, part) {
  return mask(`${name}:${seed}:${part}`, () => {
    const c = 16;
    const size = n * c;
    const wy = Array.from({ length: n }, (_, j) => c * (fill[0] + rand(seed + 41, j) * (fill[1] - fill[0])));
    const wx = Array.from({ length: n }, (_, i) => c * (fill[0] + rand(seed + 43, i) * (fill[1] - fill[0])));
    const rect = (x, y, w, h, f, r = 0) => (w > 0.05 && h > 0.05 ? `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"${r ? ` rx="${r}"` : ''} fill="${f}"/>` : '');
    let body = '';
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x0 = i * c;
        const y0 = j * c;
        const top = (c - wy[j]) / 2;
        const left = (c - wx[i]) / 2;
        const weft = (f, r) => rect(x0, y0 + top, c, wy[j], f, r);
        const warp = (f, r) => rect(x0 + left, y0, wx[i], c, f, r);
        const onTop = weftOver(i, j);
        if (part === 'weft' && onTop) body += weft('#000', 5);
        if (part === 'hlWeft' && onTop) body += weft('url(#h)', 4);
        if (part === 'hlWarp' && !onTop) body += warp('url(#v)', 4);
        if (part === 'shade') {
          if (onTop) {
            body += weft('url(#eh)') + rect(x0 + left, y0, wx[i], top, '#000') + rect(x0 + left, y0 + top + wy[j], wx[i], top, '#000');
          } else {
            body += warp('url(#ev)') + rect(x0, y0 + top, left, wy[j], '#000') + rect(x0 + left + wx[i], y0 + top, left, wy[j], '#000');
          }
        }
        if (part === 'gap') {
          for (const [x, w] of [[x0, left], [x0 + left + wx[i], left]]) {
            body += rect(x, y0, w, top, '#000') + rect(x, y0 + top + wy[j], w, top, '#000');
          }
        }
      }
    }
    const hl = '<stop offset="0" stop-opacity="0"/><stop offset="0.5" stop-opacity="1"/><stop offset="1" stop-opacity="0"/>';
    const edge = '<stop offset="0" stop-opacity="0.9"/><stop offset="0.3" stop-opacity="0"/><stop offset="0.7" stop-opacity="0"/><stop offset="1" stop-opacity="0.9"/>';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs>
<linearGradient id="h" x1="0" y1="0" x2="0" y2="1">${hl}</linearGradient>
<linearGradient id="v" x1="0" y1="0" x2="1" y2="0">${hl}</linearGradient>
<linearGradient id="eh" x1="0" y1="0" x2="0" y2="1">${edge}</linearGradient>
<linearGradient id="ev" x1="0" y1="0" x2="1" y2="0">${edge}</linearGradient>
</defs>${body}</svg>`;
  });
}
const denimWeave = (seed, part) => weave('denim', seed, 8, (i, j) => (i + j) % 4 === 0, [0.86, 0.96], part);
const canvasWeave = (seed, part) => weave('canvas', seed, 8, (i, j) => (i + j) % 2 === 0, [0.7, 0.88], part);

// A dashed seam `inset` units inside the shape's outline, in canvas units, so
// the stitches keep their length on any shape. Sub-pixel CSS borders would
// vanish, since Chrome rounds border widths down to whole pixels.
function stitchMask(shape, inset) {
  const { w, h } = shape;
  const key = `stitch:${shape.kind}:${num(w)}:${num(h)}:${num(shape.radius)}:${inset}`;
  return mask(key, () => {
    const line = 'fill="none" stroke="#000" stroke-width="0.55" stroke-dasharray="1.7 1.1" stroke-linecap="round"';
    const body = shape.kind === 'ellipse'
      ? `<ellipse cx="${num(w / 2)}" cy="${num(h / 2)}" rx="${num(w / 2 - inset)}" ry="${num(h / 2 - inset)}" ${line}/>`
      : `<rect x="${inset}" y="${inset}" width="${num(w - inset * 2)}" height="${num(h - inset * 2)}" rx="${num(Math.max(0, Math.min(shape.radius, w / 2, h / 2) - inset))}" ${line}/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w * 8)}" height="${num(h * 8)}" viewBox="0 0 ${num(w)} ${num(h)}">${body}</svg>`;
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

// Relief: a height map (alpha, 1 is high) lit by the scene light as a bumpy
// surface. The light is written into the SVG, since an image cannot read CSS
// variables, so each light gets its own image. A flat surface comes out 50%
// gray, which a hard-light layer leaves unchanged; lit slopes lighten and
// shaded ones darken, over the surface's own shading. The filter works on a
// margin around the tile, because normals at the edge of a filter region are
// wrong and would show a seam where the tiles meet.
// height() returns, only when the image is not cached yet:
//   height.filter: primitives giving the height, from SourceGraphic;
//   height.draw: what they filter (default: a rect over the margin);
//   height.tile: repeat the height, made at tile size, over the margin;
//   spec: { exp, k } for a specular highlight.
const litCache = new Map();
function litImage(key, make) {
  let v = litCache.get(key);
  if (v) litCache.delete(key);
  else v = `url('data:image/svg+xml,${encodeURIComponent(make())}')`;
  litCache.set(key, v);
  if (litCache.size > 300) litCache.delete(litCache.keys().next().value);
  return v;
}

// The scene light over a layer (l: the light in the layer's frame) as a
// distant light: it comes from the light's direction, lower the further the
// light is from straight above. Rounded, so dragging the light reuses images.
function reliefLight(l, scene) {
  const two = (a) => Math.round(a / 2) * 2;
  const tw = (v) => Math.round(v * 20) / 20;
  return {
    az: two((Math.atan2(l.y, l.x) * 180) / Math.PI),
    el: two(90 - 40 * Math.min(1.5, Math.hypot(l.x, l.y))),
    key: tw(scene.key),
    fill: tw(scene.fill),
  };
}

function relief(key, size, height, depth, rl, spec = null) {
  const id = `${key}:${num(depth)}:${rl.az}:${rl.el}:${rl.key}:${rl.fill}${spec ? `:${spec.exp}:${spec.k}` : ''}`;
  return litImage(id, () => {
    const h = height();
    const m = 4;
    const e = (rl.el * Math.PI) / 180;
    // Key light sets the contrast of the relief, fill light lifts its shadows.
    const hi = num(0.5 + 0.6 * rl.key);
    const lo = num(0.5 - 0.6 * rl.key * (1 - rl.fill * 0.5));
    const light = `<feDistantLight azimuth="${rl.az}" elevation="${rl.el}"/>`;
    let fx = h.filter + (h.tile ? '<feTile result="h"/>' : '<feComponentTransfer result="h"/>');
    fx += `<feDiffuseLighting in="h" surfaceScale="${num(depth)}" diffuseConstant="${num(0.5 / Math.sin(e))}" lighting-color="#fff">${light}</feDiffuseLighting>`;
    fx += `<feComponentTransfer result="d">${['R', 'G', 'B'].map((c) => `<feFunc${c} type="table" tableValues="${lo} 0.5 ${hi}"/>`).join('')}</feComponentTransfer>`;
    if (spec) {
      // Minus what a flat surface reflects, so flat stays 50% gray.
      const k = spec.k * rl.key;
      const flat = num(k * Math.sqrt((1 + Math.sin(e)) / 2) ** spec.exp);
      fx += `<feSpecularLighting in="h" surfaceScale="${num(depth)}" specularConstant="${num(k)}" specularExponent="${spec.exp}" lighting-color="#fff">${light}</feSpecularLighting>`
        // Chrome's specular result is white at an alpha of the intensity.
        + `<feColorMatrix type="matrix" values="0 0 0 1 ${-flat} 0 0 0 1 ${-flat} 0 0 0 1 ${-flat} 0 0 0 0 1"/>`
        + '<feComposite in="d" operator="arithmetic" k2="1" k3="1"/>';
    }
    const box = `x="${-m}" y="${-m}" width="${size + m * 2}" height="${size + m * 2}"`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
<filter id="f" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" ${box} color-interpolation-filters="sRGB">${fx}</filter>
<g filter="url(#f)">${h.draw || `<rect ${box}/>`}</g>
</svg>`;
  });
}

// Hammered dents as a height map: a jittered grid of round dents, each a
// spherical cap of its own size and depth, drawn as gray (white is deepest)
// and combined with lighten, so neighbors meet in a sharp ridge. Dents near
// an edge are drawn again on the opposite side, out into the margin.
function dentHeight(seed) {
  const n = 6;
  const size = 128;
  const c = size / n;
  let i = 0;
  const rnd = () => rand(seed + 21, i++);
  let dents = '';
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < n; k++) {
      const x = (k + 0.5 + (rnd() - 0.5) * 0.7) * c;
      const y = (j + 0.5 + (rnd() - 0.5) * 0.7) * c;
      const r = c * (0.72 + rnd() * 0.38);
      const o = (0.65 + rnd() * 0.35).toFixed(2);
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          const cx = x + ox;
          const cy = y + oy;
          if (cx + r < -4 || cy + r < -4 || cx - r > size + 4 || cy - r > size + 4) continue;
          dents += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="url(#d)" fill-opacity="${o}"/>`;
        }
      }
    }
  }
  const cap = Array.from({ length: 17 }, (_, k) => {
    const p = Math.sin((k / 16) * (Math.PI / 2));
    const v = Math.round(Math.sqrt(1 - p * p) * 255);
    return `<stop offset="${p.toFixed(3)}" stop-color="rgb(${v} ${v} ${v})"/>`;
  }).join('');
  return {
    draw: `<defs><style>circle{mix-blend-mode:lighten}</style><radialGradient id="d">${cap}</radialGradient></defs><rect x="-4" y="-4" width="${size + 8}" height="${size + 8}"/>${dents}`,
    // The blur hides the steps of the 8-bit gray, which the light would
    // show as contour lines.
    filter: '<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 0 0 0 1"/><feGaussianBlur stdDeviation="0.8"/>',
  };
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
//   shift: false to keep the pattern where it is on Shuffle;
//   image: an inline url('…') tiled as the background instead of a mask,
//   sized and placed the same way.
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
  // 3/1 twill: the dyed warp floats over three pale weft threads and under
  // one, so the weft shows as a diagonal of small light dots. The indigo
  // varies along each warp thread, and wear fades it in patches and at the
  // edges. Stitching runs just inside the outline.
  denim: (st, light, shape) => {
    const g = Math.min(1, st.grain);
    const l = turn(light, st.texAngle);
    const fade = st.texAmount;
    const layers = [
      { mask: denimWeave(st.seed, 'weft'), size: 7, color: lighter(60), blend: 'screen', opacity: 0.55 * g },
      { mask: denimWeave(st.seed, 'shade'), size: 7, color: darker(45), blend: 'multiply', opacity: 0.5 * g },
      { mask: denimWeave(st.seed, 'hlWarp'), size: 7, color: lighter(25), blend: 'screen', opacity: 0.35 * g, pos: { x: -l.x * 0.08, y: 0 } },
      { mask: tileXY('dn-slub', st.seed, 256, 48, 2, 3, 71, 3, 0.55), size: 40, color: lighter(30), blend: 'screen', opacity: 0.35 * g },
      { mask: tileXY('dn-dark', st.seed, 256, 64, 3, 2, 72, 3, 0.55), size: 40, color: darker(30), blend: 'multiply', opacity: 0.35 * g },
    ];
    if (fade > 0) {
      layers.push(
        { mask: tile('dn-fade', st.seed, 256, 2, 4, 73, 1.6, 0.45), size: 110, color: lighter(45), blend: 'screen', opacity: fade * 0.8, turn: false },
        { fit: true, css: `box-shadow:inset 0 0 5px 1px ${lighter(50)}`, blend: 'screen', opacity: fade },
      );
    }
    if (st.stitching) {
      const m = stitchMask(shape, 2.6);
      const sx = num(-light.x * 0.3);
      const sy = num(-light.y * 0.3);
      layers.push(
        { fit: true, color: darker(55), css: `mask-image:${m};mask-size:100% 100%;translate:${sx}px ${sy}px`, opacity: 0.6 },
        { fit: true, color: st.accent, css: `mask-image:${m};mask-size:100% 100%` },
      );
    }
    return layers;
  },
  // Plain weave: each thread over one and under the next, rounded like a
  // tube, with holes at the crossings. The highlight on each thread moves
  // toward the light.
  canvas: (st, light) => {
    const g = Math.min(1, st.grain);
    const k = st.texAmount;
    const l = turn(light, st.texAngle);
    return [
      { mask: canvasWeave(st.seed, 'shade'), size: 7.2, color: darker(40), blend: 'multiply', opacity: (0.3 + 0.6 * k) * g },
      { mask: canvasWeave(st.seed, 'gap'), size: 7.2, color: darker(65), blend: 'multiply', opacity: (0.4 + 0.6 * k) * g },
      { mask: canvasWeave(st.seed, 'hlWeft'), size: 7.2, color: lighter(35), blend: 'screen', opacity: (0.2 + 0.4 * k) * g, pos: { x: 0, y: -l.y * 0.1 } },
      { mask: canvasWeave(st.seed, 'hlWarp'), size: 7.2, color: lighter(35), blend: 'screen', opacity: (0.2 + 0.4 * k) * g, pos: { x: -l.x * 0.1, y: 0 } },
      { mask: tileXY('cv-slub-x', st.seed, 256, 2, 36, 2, 74, 3, 0.58), size: 36, color: darker(20), blend: 'multiply', opacity: 0.5 * g },
      { mask: tileXY('cv-slub-y', st.seed, 256, 36, 2, 2, 75, 3, 0.58), size: 36, color: lighter(20), blend: 'screen', opacity: 0.4 * g },
      { mask: tile('cv-mottle', st.seed, 256, 3, 4, 76, 1.4, 0.4), size: 120, color: darker(10), blend: 'multiply', opacity: 0.5 * g, turn: false },
    ];
  },
  // Felt: a dense mat of short fibers in every direction, no weave. The
  // fibers at the outline catch the light, and a few stick out past it
  // (feltFuzz), so the edge reads soft.
  felt: (st) => {
    const g = Math.min(1, st.grain);
    return [
      { mask: tile('fe-mottle', st.seed, 256, 4, 5, 77, 1.4, 0.4), size: 90, color: darker(14), blend: 'multiply', opacity: 0.6 * g },
      { mask: fiberMask('fe-dark', st.seed, 1400, [6, 16], 1.1), size: 18, color: darker(24), blend: 'multiply', opacity: 0.55 * g },
      { mask: fiberMask('fe-light', st.seed + 1, 1000, [6, 14], 1.1), size: 18, color: lighter(28), blend: 'screen', opacity: 0.45 * g },
      { mask: tile('fe-fine', st.seed, 256, 180, 1, 78, 3, 0.5), size: 60, color: darker(10), blend: 'multiply', opacity: 0.5 * g },
      { fit: true, css: `box-shadow:inset 0 0 1.4px 0.5px ${lighter(22)}`, opacity: st.fuzz },
    ];
  },
  // Hammered metal: the shape color as the metal, a broad sheen across it,
  // and the dents lit from the scene light, with a highlight on each for a
  // satin or glossy finish.
  hammered: (st, light, shape, scene) => {
    const a = num((Math.atan2(light.y, light.x) * 180) / Math.PI + 270);
    const spec = { satin: { exp: 6, k: 0.45 }, gloss: { exp: 48, k: 1.8 } }[st.finish];
    const depth = (1.5 + 9 * st.texAmount) * st.grain;
    return [
      { fit: true, bg: `linear-gradient(${a}deg, ${lighter(40)} 0%, transparent 40%, transparent 65%, ${darker(35)} 100%)`, blend: 'soft-light' },
      { image: relief(`hammered:${st.seed}`, 128, () => dentHeight(st.seed), depth, reliefLight(light, scene), spec), size: 48, blend: 'hard-light', turn: false },
    ];
  },
  chrome: (st) => metalLayers(st),
  gold: (st) => metalLayers(st),
  copper: (st) => metalLayers(st),
  // Anodized aluminum: ambient.css's metal relief over the shape color, with
  // a clear, bright sheen that keeps the color saturated.
  anodized: (st, light) => {
    const a = num((Math.atan2(light.y, light.x) * 180) / Math.PI + 270);
    return [
      { color: 'var(--amb-albedo)', blend: 'color', opacity: 0.6, turn: false },
      { fit: true, bg: `linear-gradient(${a}deg, ${lighter(45)} 0%, transparent 38%, transparent 70%, ${darker(30)} 100%)`, blend: 'soft-light' },
    ];
  },
  // Jelly: a tinted glass pane. The body is deepest at the edges, light
  // passing through glows on the far side, and the lit side has a soft rim
  // and a highlight. Its colored shadow is jellyShadow.
  jelly: (st, light) => {
    const t = st.texAmount;
    const g = st.innerGlow;
    const at = (k) => `${num(50 + light.x * k)}% ${num(50 + light.y * k)}%`;
    return [
      { fit: true, color: 'var(--amb-albedo)', blend: 'multiply', opacity: 0.35 + t * 0.4 },
      { fit: true, bg: `radial-gradient(farthest-corner at ${at(10)}, ${lighter(12)} 0%, var(--amb-albedo) 45%, ${darker(38)} 100%)`, opacity: 1 - t * 0.75 },
      { fit: true, bg: `radial-gradient(ellipse 75% 65% at ${at(-32)}, ${lighter(60)} 0%, transparent 70%)`, blend: 'screen', opacity: g * 0.9 },
      { fit: true, css: `box-shadow:inset 0 0 ${num(3 + 4 * g)}px ${num(0.5 + g)}px ${lighter(40)}`, blend: 'screen', opacity: g * 0.7 },
      { fit: true, css: `box-shadow:inset ${num(-light.x * 1.3)}px ${num(-light.y * 1.3)}px 1.6px -0.3px rgb(255 255 255 / 0.7)` },
      { fit: true, bg: `radial-gradient(ellipse 30% 20% at ${at(28)}, rgb(255 255 255 / 0.85) 0%, rgb(255 255 255 / 0.25) 50%, transparent 100%)` },
    ];
  },
};

// Mirror metals reflect a studio: a bright sky, a sharp horizon and a dark
// floor, painted as the shape's own background (metalSurface). Layers only
// add the satin grain and copper's patina.
function metalLayers(st) {
  const layers = [];
  if (st.metalFinish === 'satin') {
    layers.push(
      { mask: tile('mt-satin', st.seed, 256, 180, 2, 81, 3, 0.5), size: 48, color: 'black', blend: 'multiply', opacity: 0.12, turn: false },
      { mask: tile('mt-satin-l', st.seed, 256, 180, 1, 82, 6, 0.6), size: 48, color: 'white', blend: 'screen', opacity: 0.12, turn: false },
    );
  }
  if (st.material === 'copper' && st.patina > 0) {
    const p = st.patina;
    const green = '#5aa894';
    layers.push(
      { mask: spotsBy('cu-patina', st.seed, p, 256, 4, 5, 83, 4, 0.78, 0.4), size: 100, color: green, opacity: 0.9, turn: false },
      { mask: spotsBy('cu-patina-d', st.seed, p, 256, 8, 4, 84, 3, 0.8, 0.35), size: 100, color: '#3f8a78', blend: 'multiply', opacity: 0.35, turn: false },
      { fit: true, css: `box-shadow:inset 0 0 ${num(3 + 6 * p)}px ${num(1 + 2 * p)}px ${green}`, opacity: Math.min(1, p * 1.4) },
    );
  }
  return layers;
}

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

const METALS = new Set(['chrome', 'gold', 'copper']);

// Dark, mid and bright tone of each mirror metal.
const METAL_TONES = {
  chrome: ['#15171b', '#8b929c', '#ffffff'],
  yellow: ['#3d2503', '#c9962f', '#ffec9e'],
  rose: ['#3a1810', '#c4826f', '#ffd9c8'],
  white: ['#2a2925', '#b3ad9f', '#fffdf5'],
  copper: ['#2f0f05', '#bb5f36', '#ffc7a3'],
};

function metalTones(st) {
  const own = [`color-mix(in oklab, ${st.color}, black 82%)`, st.color, `color-mix(in oklab, ${st.color}, white 80%)`];
  if (st.material === 'gold') return st.goldTone === 'shape' ? own : METAL_TONES[st.goldTone];
  if (st.material === 'copper') return METAL_TONES.copper;
  const t = num(st.tint * 100);
  return t ? METAL_TONES.chrome.map((c, k) => `color-mix(in oklab, ${c}, ${own[k]} ${t}%)`) : METAL_TONES.chrome;
}

// The studio reflected in a mirror metal, as stops (position %, brightness
// 0..1) from the side facing the light. `soft` widens every edge.
//   horizon: the sky, a dark horizon at `at`, then the floor, which grows
//   lighter toward the viewer. A convex face adds a hot band near the lit
//   edge and dark far edges.
//   softbox: a dark room with a broad light panel centered at `at` and a thin
//   strip light beyond it, as in product shots. No floor line.
// A concave face shows the studio upside down.
function studio(kind, surface, at, soft) {
  const convex = surface === 'convex';
  let stops;
  if (kind === 'softbox') {
    const e = soft / 2 + 1;
    stops = [[0, convex ? 0.2 : 0.45], [at - 12 - e, 0.3], [at - 12, 0.84], [at - 4, 1], [at + 6, 0.8], [at + 6 + e, 0.28], [at + 30, 0.18],
      [at + 36, 0.62], [at + 39, 0.62], [at + 39 + e * 0.6, 0.2], [100, convex ? 0.12 : 0.35]];
  } else if (convex) {
    const a = Math.max(16, at - soft);
    const b = Math.min(96, Math.max(at, a + 1) + soft + 1.5);
    stops = [[0, 0.45], [5, 0.95], [14, 1], [(14 + a) / 2, 0.86], [a, 0.66], [Math.max(at, a + 1), 0.1], [b, 0.2],
      [b + (100 - b) * 0.6, 0.42], [b + (100 - b) * 0.85, 0.58], [100, 0.3]];
  } else {
    const a = Math.max(6, at - soft - 5);
    const h = Math.max(at, a + 6);
    const b = Math.min(96, h + soft + 1.5);
    stops = [[0, 0.92], [a * 0.3, 1], [a * 0.55, 0.8], [a * 0.8, 0.95], [a, 0.72], [h - soft, 0.62], [h, 0.1], [b, 0.22],
      [b + (100 - b) * 0.45, 0.4], [b + (100 - b) * 0.75, 0.3], [100, 0.52]];
  }
  return surface === 'concave' ? stops.map(([p, v]) => [100 - p, v]).reverse() : stops;
}

// A mirror metal's inline CSS: its mid tone as the shape color (the edge
// highlight and the texture layers derive from it) and the reflected studio
// as its background, dimmed with the scene light. Curved faces bend the
// studio along their own axis; flat ones and grooves turn it to the light.
export function metalSurface(shape, light) {
  const st = shape.style;
  if (!METALS.has(st.material)) return '';
  const [lo, mid, hi] = metalTones(st);
  const tone = (v) => {
    const x = Math.max(0, Math.min(1, v));
    return x < 0.5 ? `color-mix(in oklab, ${lo}, ${mid} ${num(x * 200)}%)` : `color-mix(in oklab, ${mid}, ${hi} ${num((x - 0.5) * 200)}%)`;
  };
  const soft = { polished: 0.6, satin: 6, brushed: 3.5 }[st.metalFinish] + (1 - st.horizonSharp) * 18;
  const k = (0.4 + 1.2 * st.texAmount) * (st.metalFinish === 'satin' ? 0.7 : 1);
  const s = st.surface;
  let dir;
  if (s === 'convex' || s === 'concave') dir = light.y > 0 ? 'to top' : 'to bottom';
  else if (s === 'concave-h') dir = light.x > 0 ? 'to left' : 'to right';
  else dir = `${num((Math.atan2(light.y, light.x) * 180) / Math.PI + 270)}deg`;
  const at = st.studio === 'softbox' ? 15 + st.horizon * 50 : 30 + st.horizon * 40;
  const stops = studio(st.studio, s === 'concave-h' || s === 'groove' ? 'concave' : s, at, soft)
    .map(([p, v]) => `${tone(0.5 + (v - 0.5) * k)} ${num(p)}%`).join(', ');
  const dim = 'rgb(0 0 0 / calc(max(0, 1.6 - var(--amb-key-light-intensity) - var(--amb-fill-light-intensity)) * 0.55))';
  return `;--amb-albedo:${mid};background:linear-gradient(${dim}, ${dim}), linear-gradient(${dir}, ${stops})`;
}

// The ambient.css material a texture builds on, if any.
export function ambientMaterial(st) {
  if (st.material === 'anodized') return st.anodTexture;
  if (st.material === 'jelly') return 'glass';
  if (METALS.has(st.material) && st.metalFinish === 'brushed') return 'brushed';
  return null;
}

// The band from a shape's outline out to `d` units past it, as a mask for a
// box that reaches `d` past the shape on every side. It starts a little
// inside the outline, so no hairline of background shows between the band's
// anti-aliased edge and the shape's.
function ringMask(shape, d) {
  const o = 0.2;
  const w = shape.w - o * 2;
  const h = shape.h - o * 2;
  return mask(`ring:${shape.kind}:${num(shape.w)}:${num(shape.h)}:${num(shape.radius)}:${num(d)}`, () => {
    const W = shape.w + d * 2;
    const H = shape.h + d * 2;
    const e = d + o;
    let inner;
    if (shape.kind === 'ellipse') {
      const rx = w / 2;
      const ry = h / 2;
      inner = `M${num(e)} ${num(e + ry)}a${num(rx)} ${num(ry)} 0 1 0 ${num(w)} 0a${num(rx)} ${num(ry)} 0 1 0 ${num(-w)} 0Z`;
    } else {
      const r = Math.max(0, Math.min(shape.radius - o, w / 2, h / 2));
      inner = `M${num(e + r)} ${num(e)}h${num(w - r * 2)}a${num(r)} ${num(r)} 0 0 1 ${num(r)} ${num(r)}v${num(h - r * 2)}a${num(r)} ${num(r)} 0 0 1 ${num(-r)} ${num(r)}h${num(r * 2 - w)}a${num(r)} ${num(r)} 0 0 1 ${num(-r)} ${num(-r)}v${num(r * 2 - h)}a${num(r)} ${num(r)} 0 0 1 ${num(r)} ${num(-r)}Z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(W * 8)}" height="${num(H * 8)}" viewBox="0 0 ${num(W)} ${num(H)}"><path fill-rule="evenodd" d="M0 0H${num(W)}V${num(H)}H0Z${inner}"/></svg>`;
  });
}

// Felt's stray fibers just past the outline: children of the shape reaching
// out by up to `f`, masked to the band outside the outline, so they paint
// over the shape's own drop shadow. Dense right at the outline, sparser
// further out.
function feltFuzz(shape) {
  const st = shape.style;
  const f = 0.2 + st.fuzz * 0.7;
  const size = num(20 * st.texScale);
  const ring = (d, fibers, css) => {
    const radius = shape.kind === 'ellipse' ? '50%' : `${num(shape.radius + d)}px`;
    const band = ringMask(shape, d);
    const m = `mask-image:${fibers}, ${band};mask-size:${size}px, 100% 100%;mask-repeat:repeat, no-repeat;mask-composite:intersect;`;
    return `<div class="ir-fuzz" style="inset:${num(-d)}px;border-radius:${radius};${m}${css}"></div>`;
  };
  return ring(f * 0.6, fiberMask('fe-fuzz', st.seed + 3, 1800, [8, 20], 2.4), 'opacity:0.85')
    + ring(f, fiberMask('fe-fuzz2', st.seed + 4, 700, [8, 20], 1.8), 'opacity:0.4');
}

// Drawn right under the shape, in its geometry (geo): the colored light a
// jelly lets through, falling away from the scene light.
export function underlayMarkup(shape, scene, geo) {
  const st = shape.style;
  if (st.material === 'jelly') {
    const e = st.elevation * 3 + st.thickness * 2.5;
    const o = st.opacity * (0.2 + 0.25 * st.texAmount);
    return `<div class="ir-halo" style="${geo}background:color-mix(in oklab, ${st.color}, black 10%);translate:${num(-scene.lightX * e)}px ${num(-scene.lightY * e)}px;filter:blur(${num(2 + e * 0.5)}px);opacity:${num(o)}"></div>`;
  }
  return '';
}

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
.ir-fuzz {
  position: absolute;
  background: color-mix(in oklab, var(--amb-lit), black 10%);
  pointer-events: none;
}
/* A jelly's own colored shadow (underlayMarkup) replaces most of the glass's
   gray one. */
.ir-shape.ir-jelly.amb-mat-glass {
  --_glass-ring-a: calc((0.2 + var(--amb-elevation) * 0.04) * var(--_glass-body) * 0.4);
  --_glass-skirt-a: calc(var(--_glass-body) * var(--_glass-ring-lift) * (0.12 + min(var(--amb-elevation), 2) * 0.12) * 0.4);
}
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
  if (layer.mask || layer.image) {
    const size = layer.size * st.texScale;
    // A shuffled tile also starts at a random point, so repeats of the
    // pattern don't line up with the shape's edges the same way.
    let x = layer.pos?.x || 0;
    let y = layer.pos?.y || 0;
    if (st.seed && layer.shift !== false) {
      x += rand(st.seed, 90) * size;
      y += rand(st.seed, 91) * size;
    }
    const pos = `calc(50% + ${num(x)}px) calc(50% + ${num(y)}px)`;
    if (layer.image) {
      css += `background-image:${layer.image};background-size:${num(size)}px;background-position:${pos};`;
    } else {
      css += `mask-image:${layer.mask};mask-size:${num(size)}px;`;
      if (layer.repeat === false) css += 'mask-repeat:no-repeat;';
      if (x || y) css += `mask-position:${pos};`;
    }
  }
  if (layer.blend) css += `mix-blend-mode:${layer.blend};`;
  if (layer.opacity !== undefined && layer.opacity < 1) css += `opacity:${num(Math.max(0, layer.opacity))};`;
  return `<div style="${css}"></div>`;
}

// light: the scene light in the shape's own frame.
export function textureMarkup(shape, light, scene) {
  const st = shape.style;
  const make = TEXTURES[st.material];
  if (!make) return '';
  const d = Math.ceil(Math.hypot(shape.w, shape.h)) + 2;
  const layers = make(st, light, shape, scene).map((l) => layerMarkup(l, st, d)).join('');
  let out = `<div class="ir-tex">${layers}</div>`;
  if (st.material === 'felt' && st.fuzz > 0) out += feltFuzz(shape);
  if (hasFinish(st.material) && st.finish !== 'matte') {
    out += `<div class="ir-sheen amb-mat-shiny${st.finish === 'satin' ? ' ir-satin' : ''}"></div>`;
  }
  return out;
}

// Shuffle for ambient.css's metals (material: the ambient.css one the shape
// uses), through the hooks render.js adds: a new
// offset and length for the brushed streaks and the blasted grain, and for
// radial brushed a new spin center, turn of the streaks and hotspot size.
// Offsets stay whole pixels, which the grain's pixel snapping needs.
export function metalVars(shape, material) {
  const { seed } = shape.style;
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
