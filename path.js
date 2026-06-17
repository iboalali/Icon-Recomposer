// path.js — SVG/VD path normalization, transform baking, bbox, serialization.
//
// This is the shared, riskiest heart (PLAN §13): every `d`/`pathData` from
// either importer flows through here, and derive() leans on it for cast-shadow
// offsetting and bbox-driven gradient geometry.
//
// Normalized form: an array of segments, each one of
//   { c: 'M', x, y }
//   { c: 'L', x, y }
//   { c: 'C', x1, y1, x2, y2, x, y }
//   { c: 'Z' }
// All coordinates absolute. H/V→L, S/T/Q→C, arcs A→cubic béziers. Béziers are
// closed under affine transforms, which makes transform-baking a plain matrix
// multiply on every point.

// ---- low-level scanner ----
function isWsp(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === ',';
}

// Parse a `d` string into raw segments preserving original commands/relativity:
// [{ cmd:'m', params:[...] }, ...]. Handles implicit repeated commands and
// arc-flag packing (e.g. "a25 25 0 0150 0" where the two flags are single digits).
function parseRaw(d) {
  const segs = [];
  let i = 0;
  const n = d.length;

  function skip() {
    while (i < n && isWsp(d[i])) i++;
  }
  function readNumber() {
    skip();
    const start = i;
    if (d[i] === '+' || d[i] === '-') i++;
    let sawDigit = false;
    while (i < n && d[i] >= '0' && d[i] <= '9') { i++; sawDigit = true; }
    if (d[i] === '.') {
      i++;
      while (i < n && d[i] >= '0' && d[i] <= '9') { i++; sawDigit = true; }
    }
    if (sawDigit && (d[i] === 'e' || d[i] === 'E')) {
      i++;
      if (d[i] === '+' || d[i] === '-') i++;
      while (i < n && d[i] >= '0' && d[i] <= '9') i++;
    }
    if (!sawDigit) return null;
    return parseFloat(d.slice(start, i));
  }
  function readFlag() {
    skip();
    const c = d[i];
    if (c === '0') { i++; return 0; }
    if (c === '1') { i++; return 1; }
    // Tolerate malformed flags written as full numbers.
    return readNumber();
  }

  const COUNTS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

  let cmd = null;
  while (true) {
    skip();
    if (i >= n) break;
    const ch = d[i];
    if (/[a-zA-Z]/.test(ch)) {
      cmd = ch;
      i++;
    } else if (cmd == null) {
      i++; // junk before first command
      continue;
    }
    const lc = cmd.toLowerCase();
    if (lc === 'z') {
      segs.push({ cmd, params: [] });
      cmd = null; // a bare z is not implicitly repeated
      continue;
    }
    const count = COUNTS[lc];
    if (count == null) { i++; continue; } // unknown command
    const params = [];
    for (let k = 0; k < count; k++) {
      let val;
      if (lc === 'a' && (k === 3 || k === 4)) val = readFlag();
      else val = readNumber();
      if (val == null) { params.length = -1; break; }
      params.push(val);
    }
    if (params.length < 0) break; // ran out of numbers
    segs.push({ cmd, params });
    // Implicit repeat: after M/m the implicit command is L/l.
    if (lc === 'm') cmd = cmd === 'M' ? 'L' : 'l';
  }
  return segs;
}

// Endpoint-parameterization arc → array of cubic bézier control sets.
function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    return [[x1, y1, x2, y2, x2, y2]]; // degenerate → straight line
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cosp = Math.cos(phi);
  const sinp = Math.sin(phi);

  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosp * dx + sinp * dy;
  const y1p = -sinp * dx + cosp * dy;

  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc !== sweep ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosp * cxp - sinp * cyp + (x1 + x2) / 2;
  const cy = sinp * cxp + cosp * cyp + (y1 + y2) / 2;

  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let dtheta = angle(ux, uy, vx, vy);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;

  const segCount = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / segCount;
  const t = (4 / 3) * Math.tan(delta / 4);

  const onArc = (a) => {
    const ex = Math.cos(a);
    const ey = Math.sin(a);
    return [cx + rx * ex * cosp - ry * ey * sinp, cy + rx * ex * sinp + ry * ey * cosp];
  };
  const deriv = (a) => {
    const s = Math.sin(a);
    const c = Math.cos(a);
    return [-rx * s * cosp - ry * c * sinp, -rx * s * sinp + ry * c * cosp];
  };

  const out = [];
  let a1 = theta1;
  let p1 = [x1, y1];
  for (let k = 0; k < segCount; k++) {
    const a2 = a1 + delta;
    const p2 = onArc(a2);
    const d1 = deriv(a1);
    const d2 = deriv(a2);
    out.push([p1[0] + t * d1[0], p1[1] + t * d1[1], p2[0] - t * d2[0], p2[1] - t * d2[1], p2[0], p2[1]]);
    a1 = a2;
    p1 = p2;
  }
  return out;
}

// Normalize raw segments → absolute M/L/C/Z segment objects.
export function normalize(raw) {
  const out = [];
  let cx = 0;
  let cy = 0; // current point
  let sx = 0;
  let sy = 0; // subpath start
  let prevCtrlX = null;
  let prevCtrlY = null; // last C/S control (for S)
  let prevQX = null;
  let prevQY = null; // last Q/T control (for T)
  let prevType = null; // 'C' | 'Q' | other

  for (const seg of raw) {
    const cmd = seg.cmd;
    const rel = cmd === cmd.toLowerCase();
    const p = seg.params;
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;

    switch (cmd.toUpperCase()) {
      case 'M': {
        const x = p[0] + ox;
        const y = p[1] + oy;
        out.push({ c: 'M', x, y });
        cx = x; cy = y; sx = x; sy = y;
        prevType = 'M';
        break;
      }
      case 'L': {
        const x = p[0] + ox;
        const y = p[1] + oy;
        out.push({ c: 'L', x, y });
        cx = x; cy = y; prevType = 'L';
        break;
      }
      case 'H': {
        const x = p[0] + (rel ? cx : 0);
        out.push({ c: 'L', x, y: cy });
        cx = x; prevType = 'L';
        break;
      }
      case 'V': {
        const y = p[0] + (rel ? cy : 0);
        out.push({ c: 'L', x: cx, y });
        cy = y; prevType = 'L';
        break;
      }
      case 'C': {
        const x1 = p[0] + ox, y1 = p[1] + oy;
        const x2 = p[2] + ox, y2 = p[3] + oy;
        const x = p[4] + ox, y = p[5] + oy;
        out.push({ c: 'C', x1, y1, x2, y2, x, y });
        prevCtrlX = x2; prevCtrlY = y2;
        cx = x; cy = y; prevType = 'C';
        break;
      }
      case 'S': {
        let x1, y1;
        if (prevType === 'C') { x1 = 2 * cx - prevCtrlX; y1 = 2 * cy - prevCtrlY; }
        else { x1 = cx; y1 = cy; }
        const x2 = p[0] + ox, y2 = p[1] + oy;
        const x = p[2] + ox, y = p[3] + oy;
        out.push({ c: 'C', x1, y1, x2, y2, x, y });
        prevCtrlX = x2; prevCtrlY = y2;
        cx = x; cy = y; prevType = 'C';
        break;
      }
      case 'Q': {
        const qx = p[0] + ox, qy = p[1] + oy;
        const x = p[2] + ox, y = p[3] + oy;
        out.push(quadToCubic(cx, cy, qx, qy, x, y));
        prevQX = qx; prevQY = qy;
        cx = x; cy = y; prevType = 'Q';
        break;
      }
      case 'T': {
        let qx, qy;
        if (prevType === 'Q') { qx = 2 * cx - prevQX; qy = 2 * cy - prevQY; }
        else { qx = cx; qy = cy; }
        const x = p[0] + ox, y = p[1] + oy;
        out.push(quadToCubic(cx, cy, qx, qy, x, y));
        prevQX = qx; prevQY = qy;
        cx = x; cy = y; prevType = 'Q';
        break;
      }
      case 'A': {
        const rx = p[0], ry = p[1], rot = p[2], laf = p[3], sf = p[4];
        const x = p[5] + ox, y = p[6] + oy;
        const cubics = arcToCubics(cx, cy, rx, ry, rot, laf, sf, x, y);
        for (const cb of cubics) {
          out.push({ c: 'C', x1: cb[0], y1: cb[1], x2: cb[2], y2: cb[3], x: cb[4], y: cb[5] });
        }
        cx = x; cy = y; prevType = 'A';
        break;
      }
      case 'Z': {
        out.push({ c: 'Z' });
        cx = sx; cy = sy; prevType = 'Z';
        break;
      }
    }
    if (cmd.toUpperCase() !== 'C' && cmd.toUpperCase() !== 'S') {
      // keep prevCtrl meaningful only right after C/S
    }
  }
  return out;
}

function quadToCubic(x0, y0, qx, qy, x, y) {
  return {
    c: 'C',
    x1: x0 + (2 / 3) * (qx - x0),
    y1: y0 + (2 / 3) * (qy - y0),
    x2: x + (2 / 3) * (qx - x),
    y2: y + (2 / 3) * (qy - y),
    x,
    y,
  };
}

// Parse + normalize in one step.
export function parse(d) {
  return normalize(parseRaw(d || ''));
}

// ---- affine matrices: [a, b, c, d, e, f] => x'=a*x+c*y+e, y'=b*x+d*y+f ----
export const identity = () => [1, 0, 0, 1, 0, 0];
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export function rotate(deg, cxr = 0, cyr = 0) {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // translate(cx,cy) * rotate * translate(-cx,-cy)
  return multiply(translate(cxr, cyr), multiply([cos, sin, -sin, cos, 0, 0], translate(-cxr, -cyr)));
}
export const skewX = (deg) => [1, 0, Math.tan((deg * Math.PI) / 180), 1, 0, 0];
export const skewY = (deg) => [1, Math.tan((deg * Math.PI) / 180), 0, 1, 0, 0];

// multiply(m1, m2): the matrix that applies m2 first, then m1 (m1 ∘ m2).
export function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function applyPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function isIdentity(m) {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

// Bake a matrix into normalized segments (returns a new array).
export function transform(segs, m) {
  if (isIdentity(m)) return segs;
  return segs.map((s) => {
    if (s.c === 'Z') return { c: 'Z' };
    if (s.c === 'C') {
      const [x1, y1] = applyPoint(m, s.x1, s.y1);
      const [x2, y2] = applyPoint(m, s.x2, s.y2);
      const [x, y] = applyPoint(m, s.x, s.y);
      return { c: 'C', x1, y1, x2, y2, x, y };
    }
    const [x, y] = applyPoint(m, s.x, s.y);
    return { c: s.c, x, y };
  });
}

// Parse an SVG `transform` attribute into a single matrix.
export function parseTransformAttr(str) {
  let m = identity();
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(str))) {
    const fn = match[1];
    const args = match[2].split(/[\s,]+/).filter((s) => s.length).map(Number);
    let t = identity();
    switch (fn) {
      case 'matrix':
        if (args.length === 6) t = args;
        break;
      case 'translate':
        t = translate(args[0] || 0, args[1] || 0);
        break;
      case 'scale':
        t = scale(args[0] || 0, args.length > 1 ? args[1] : args[0]);
        break;
      case 'rotate':
        t = rotate(args[0] || 0, args[1] || 0, args[2] || 0);
        break;
      case 'skewX':
        t = skewX(args[0] || 0);
        break;
      case 'skewY':
        t = skewY(args[0] || 0);
        break;
    }
    m = multiply(m, t); // left-to-right list: leftmost is outermost
  }
  return m;
}

// ---- bbox + serialization ----
// Conservative bbox over all anchor + control points (slightly larger than the
// true curve hull, which is fine for sizing gradient geometry).
export function bbox(segs) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const acc = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const s of segs) {
    if (s.c === 'Z') continue;
    if (s.c === 'C') {
      acc(s.x1, s.y1);
      acc(s.x2, s.y2);
    }
    acc(s.x, s.y);
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0, cx: 0, cy: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

function num(n, prec) {
  if (!isFinite(n)) return '0';
  let s = n.toFixed(prec);
  if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return s;
}

// Serialize normalized segments back to a compact `d`/`pathData` string.
export function serialize(segs, prec = 3) {
  const parts = [];
  for (const s of segs) {
    if (s.c === 'M') parts.push(`M${num(s.x, prec)} ${num(s.y, prec)}`);
    else if (s.c === 'L') parts.push(`L${num(s.x, prec)} ${num(s.y, prec)}`);
    else if (s.c === 'C')
      parts.push(
        `C${num(s.x1, prec)} ${num(s.y1, prec)} ${num(s.x2, prec)} ${num(s.y2, prec)} ${num(s.x, prec)} ${num(s.y, prec)}`
      );
    else if (s.c === 'Z') parts.push('Z');
  }
  return parts.join('');
}

// Convenience: normalize + (optional) bake matrix + serialize.
export function normalizeAndBake(d, m) {
  let segs = parse(d);
  if (m && !isIdentity(m)) segs = transform(segs, m);
  return { segs, d: serialize(segs) };
}
