// Visual test helpers. Load in the served app's DevTools console:
//   await import('/tests/checks.js')
// Every render goes through the export path (renderCanvas), the same markup
// the editor shows.
import { renderCanvas } from '../export.js';
import * as M from '../model.js';

export const LIMIT = 16;
// Chrome's SVG image rasterization can shift a whole render by 1-2 levels
// from one render to the next, so differences up to FLOOR count as none.
export const FLOOR = 2;

const vt = {
  M,
  // The document the editor holds; every commit autosaves it.
  doc: () => M.parseProject(localStorage.getItem('icon-recomposer-2/doc')),
  variant: (i = 0) => vt.doc().variants[i],
  load: async (url) => M.parseProject(await (await fetch(url)).text()),
  render: (variant, size = 512, opts = {}) => renderCanvas(variant, { size, ...opts }),

  // An image from the served folder (a reference image, a screenshot), as a canvas.
  async image(url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  },

  // Compares two same-size canvases inside a window given in canvas units.
  // A pixel's difference is its largest channel difference (0-255), taken as 0
  // up to FLOOR. mean: the average difference; max: the largest; over: percent
  // of pixels differing by more than `limit`.
  compare(a, b, { x = 0, y = 0, w = 108, h = 108, limit = LIMIT } = {}) {
    if (a.width !== b.width || a.height !== b.height) throw new Error(`sizes differ: ${a.width} vs ${b.width}`);
    const k = a.width / 108;
    const [px, py, pw, ph] = [x, y, w, h].map((v) => Math.round(v * k));
    const da = a.getContext('2d').getImageData(px, py, pw, ph).data;
    const db = b.getContext('2d').getImageData(px, py, pw, ph).data;
    let sum = 0;
    let max = 0;
    let over = 0;
    for (let i = 0; i < da.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(da[i + c] - db[i + c]));
      if (d <= FLOOR) d = 0;
      sum += d;
      max = Math.max(max, d);
      if (d > limit) over++;
    }
    const n = da.length / 4;
    return { mean: +(sum / n).toFixed(2), max, over: +((100 * over) / n).toFixed(3) };
  },

  // Shows |a - b|, amplified 8×, over the page. Click it to close.
  diff(a, b) {
    const c = document.createElement('canvas');
    c.width = a.width;
    c.height = a.height;
    const da = a.getContext('2d').getImageData(0, 0, a.width, a.height);
    const db = b.getContext('2d').getImageData(0, 0, a.width, a.height).data;
    for (let i = 0; i < da.data.length; i += 4) {
      for (let ch = 0; ch < 3; ch++) da.data[i + ch] = Math.min(255, Math.abs(da.data[i + ch] - db[i + ch]) * 8);
      da.data[i + 3] = 255;
    }
    c.getContext('2d').putImageData(da, 0, 0);
    vt.show(c);
    return c;
  },

  // Shows a canvas over the page. Click it to close.
  show(c) {
    c.style.cssText = 'position:fixed;inset:0;margin:auto;max-width:90vmin;max-height:90vmin;z-index:9999;border:4px solid #f0f;background:#000;image-rendering:pixelated';
    c.onclick = () => c.remove();
    document.body.append(c);
    return c;
  },

  // One pixel's RGBA at canvas-unit coordinates.
  pixel(c, x, y) {
    const k = c.width / 108;
    return [...c.getContext('2d').getImageData(Math.floor(x * k), Math.floor(y * k), 1, 1).data];
  },

  // The whole scene turned 90° clockwise about the canvas center: shapes,
  // their rotation and the light. Its render should equal rot90(render).
  rotated(variant) {
    const v = structuredClone(variant);
    for (const s of v.shapes) {
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      s.x = 108 - cy - s.w / 2;
      s.y = cx - s.h / 2;
      s.rotation = (((s.rotation || 0) + 90 + 180) % 360) - 180;
    }
    const { lightX: lx, lightY: ly } = v.scene;
    v.scene.lightX = -ly;
    v.scene.lightY = lx;
    return v;
  },
  rot90(c) {
    const r = document.createElement('canvas');
    r.width = c.height;
    r.height = c.width;
    const g = r.getContext('2d');
    g.translate(r.width, 0);
    g.rotate(Math.PI / 2);
    g.drawImage(c, 0, 0);
    return r;
  },

  // Where the variant darkens the empty background, as an offset in canvas
  // units from the canvas center, leaving out the window `skip` (the shapes).
  async shadowOffset(variant, skip = { x: 0, y: 0, w: 0, h: 0 }) {
    const empty = structuredClone(variant);
    empty.shapes = [];
    const n = 216;
    const a = (await vt.render(variant, n)).getContext('2d').getImageData(0, 0, n, n).data;
    const b = (await vt.render(empty, n)).getContext('2d').getImageData(0, 0, n, n).data;
    const k = n / 108;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (x >= skip.x * k && x < (skip.x + skip.w) * k && y >= skip.y * k && y < (skip.y + skip.h) * k) continue;
        const i = (y * n + x) * 4;
        const d = Math.max(0, b[i] - a[i]);
        sx += d * x;
        sy += d * y;
        sw += d;
      }
    }
    return sw ? [+(sx / sw / k - 54).toFixed(2), +(sy / sw / k - 54).toFixed(2)] : [0, 0];
  },

  // Test scenes. style and shape override the defaults; a material in style
  // starts from that material's own defaults, as picking it in the app does.
  shape(kind, geo, style = {}) {
    const s = M.newShape(kind, geo);
    Object.assign(s.style, style.material ? M.materialDefaults(style.material) : {}, style);
    return s;
  },
  scene(...shapes) {
    const v = M.newDocument().variants[0];
    v.shapes.push(...shapes);
    return v;
  },
  empty: () => vt.scene(),
  // One 60×60 rounded square in the middle.
  tile: (style = {}, shape = {}) => vt.scene(vt.shape('rect', { name: 'Tile', x: 24, y: 24, w: 60, h: 60, radius: 14, ...shape }, style)),
  // A horizontal bar A and a vertical bar B crossing in the middle; B paints on top.
  pair: (styleA = {}, styleB = {}) => vt.scene(
    vt.shape('rect', { name: 'A', x: 20, y: 44, w: 68, h: 20, radius: 4 }, { color: '#d04a4a', ...styleA }),
    vt.shape('rect', { name: 'B', x: 44, y: 20, w: 20, h: 68, radius: 4 }, { color: '#4a7bd0', ...styleB }),
  ),
  // A with a crossing that puts it over B, and the same scene with A simply painted last.
  crossed(v, over = 0, under = 1) {
    const c = structuredClone(v);
    c.crossings = [{ over: v.shapes[over].id, under: v.shapes[under].id }];
    const r = structuredClone(v);
    const [s] = r.shapes.splice(over, 1);
    r.shapes.push(s);
    return [c, r];
  },

  // Opens a variant in the editor (replaces the autosaved document) to look at it.
  open(variant) {
    const d = M.newDocument();
    d.variants = [structuredClone(variant)];
    localStorage.setItem('icon-recomposer-2/doc', M.serializeProject(d));
    location.reload();
  },
  // Downloads a canvas as a PNG, e.g. to approve it as a reference image.
  save(c, name) {
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = name;
    a.click();
  },
};

window.vt = vt;
export default vt;
