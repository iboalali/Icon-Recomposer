// svg.js — derived model → SVG string.
//
// Two variants share one builder:
//   previewSvg()    — viewBox only; scales to its container (the editor canvas).
//   standaloneSvg() — explicit width/height in px for the PNG rasterizer.
//
// Faithfulness rule (PLAN §9): gradientUnits="userSpaceOnUse" and only
// VD-expressible features, so the preview is pixel-identical to the VD export.

import { toHex, toHexA } from './color.js';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function n(v) {
  const s = (+v).toFixed(3);
  return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
}

function stopEls(stops) {
  return stops
    .map((s) => `<stop offset="${n(s.offset)}" stop-color="${toHex(s.color)}" stop-opacity="${n(s.color.a == null ? 1 : s.color.a)}"/>`)
    .join('');
}

function gradientDef(g) {
  if (g.kind === 'linear') {
    return (
      `<linearGradient id="${g.id}" gradientUnits="userSpaceOnUse" ` +
      `x1="${n(g.x1)}" y1="${n(g.y1)}" x2="${n(g.x2)}" y2="${n(g.y2)}">${stopEls(g.stops)}</linearGradient>`
    );
  }
  if (g.kind === 'radial') {
    return (
      `<radialGradient id="${g.id}" gradientUnits="userSpaceOnUse" ` +
      `cx="${n(g.cx)}" cy="${n(g.cy)}" r="${n(g.r)}" fx="${n(g.cx)}" fy="${n(g.cy)}">${stopEls(g.stops)}</radialGradient>`
    );
  }
  return '';
}

function pathEl(p) {
  const attrs = [`d="${esc(p.d)}"`];
  if (p.fill == null) {
    attrs.push('fill="none"');
  } else if (p.fill.type === 'solid') {
    attrs.push(`fill="${toHexA(p.fill.color)}"`);
  } else if (p.fill.type === 'gradient') {
    attrs.push(`fill="url(#${p.fill.gradient.id})"`);
  }
  if (p.fillRule === 'evenOdd') attrs.push('fill-rule="evenodd"');
  if (p.clip) attrs.push(`clip-path="url(#${p.clip.id})"`);
  if (p.stroke) {
    attrs.push(`stroke="${toHexA(p.stroke.color)}"`);
    attrs.push(`stroke-width="${n(p.stroke.width)}"`);
    if (p.stroke.cap && p.stroke.cap !== 'butt') attrs.push(`stroke-linecap="${esc(p.stroke.cap)}"`);
    if (p.stroke.join && p.stroke.join !== 'miter') attrs.push(`stroke-linejoin="${esc(p.stroke.join)}"`);
  }
  return `<path ${attrs.join(' ')}/>`;
}

// Build the inner SVG markup (defs + paths). dims is an optional
// { width, height } to emit explicit pixel size (required for PNG).
function build(derived, dims, opts = {}) {
  const vw = derived.viewportWidth;
  const vh = derived.viewportHeight;
  const gradDefs = derived.paths
    .filter((p) => p.fill && p.fill.type === 'gradient')
    .map((p) => gradientDef(p.fill.gradient))
    .join('');
  const clipDefs = derived.paths
    .filter((p) => p.clip)
    .map((p) => `<clipPath id="${p.clip.id}" clipPathUnits="userSpaceOnUse"><path d="${esc(p.clip.pathData)}"/></clipPath>`)
    .join('');
  const defs = gradDefs + clipDefs;
  const body = derived.paths.map(pathEl).join('');

  const sizeAttrs = dims ? ` width="${n(dims.width)}" height="${n(dims.height)}"` : '';
  let bg = '';
  if (opts.background && !derived.background.transparent) {
    bg = `<rect x="0" y="0" width="${n(vw)}" height="${n(vh)}" fill="${toHex({
      ...parseHexLike(derived.background.color),
    })}"/>`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${sizeAttrs} viewBox="0 0 ${n(vw)} ${n(vh)}">` +
    (defs ? `<defs>${defs}</defs>` : '') +
    bg +
    body +
    `</svg>`
  );
}

function parseHexLike(hex) {
  // Minimal #rrggbb passthrough for the optional background rect.
  const h = (hex || '#ffffff').replace('#', '');
  return {
    r: parseInt(h.slice(0, 2) || 'ff', 16),
    g: parseInt(h.slice(2, 4) || 'ff', 16),
    b: parseInt(h.slice(4, 6) || 'ff', 16),
  };
}

// Preview: no fixed size, fills its container; transparent (the editor draws
// the checkerboard / chosen bg behind it).
export function previewSvg(derived) {
  return build(derived, null, { background: false });
}

// Standalone: explicit width/height (the #1 PNG trap if omitted). For PNG the
// canvas fills the background, so leave the SVG transparent (default). For an
// SVG-file export, pass { background: true } to bake the chosen bg color in.
export function standaloneSvg(derived, width, height, opts = {}) {
  return build(derived, { width, height: height == null ? width : height }, { background: !!opts.background });
}
