// export-png.js — derived model → PNG (PLAN §14).
//
// Pipeline: standalone SVG (with explicit width/height) → Blob URL → Image →
// <canvas> → toBlob. Gotchas handled: explicit SVG size (the #1 trap, done in
// svg.js), object URL over data URI, await onload before draw, no taint
// (pure inline vector), exact output dims (ignore devicePixelRatio).

import { standaloneSvg } from './svg.js';
import { toRgbaCss, parseColor } from './color.js';

function rasterize(svgString, width, height) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas);
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to rasterize SVG.'));
    };
    img.src = url;
  });
}

// Render the derived model to a PNG Blob. `size` is the longest edge; the other
// edge follows the viewport aspect ratio (so non-square canvases aren't
// letterboxed). opts.background: { transparent, color } — fill first if opaque.
export async function renderPng(derived, size, background) {
  const vw = derived.viewportWidth;
  const vh = derived.viewportHeight;
  const w = vw >= vh ? size : Math.round((size * vw) / vh);
  const h = vh >= vw ? size : Math.round((size * vh) / vw);

  const svg = standaloneSvg(derived, w, h);
  const canvas = await rasterize(svg, w, h);

  if (background && !background.transparent) {
    // Background must sit UNDER the artwork; re-composite onto a filled canvas.
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d');
    octx.fillStyle = toRgbaCss(parseColor(background.color) || { r: 255, g: 255, b: 255, a: 1 });
    octx.fillRect(0, 0, w, h);
    octx.drawImage(canvas, 0, 0);
    return toBlob(out);
  }
  return toBlob(canvas);
}

function toBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas toBlob failed.'));
    }, 'image/png');
  });
}
