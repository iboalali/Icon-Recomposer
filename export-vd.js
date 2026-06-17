// export-vd.js — derived model → Android VectorDrawable XML (PLAN §14).
//
// Input is the SAME derived model the preview consumes, so the export is
// pixel-identical to what's on screen. Key correctness points:
//   - colors are #AARRGGBB (alpha FIRST) — the classic VD bug
//   - viewportWidth/Height equal the coordinate space derive() emitted
//   - gradients use the inline <aapt:attr><gradient><item offset color> form
//   - xmlns:aapt is emitted only when a gradient actually exists

import { toAndroid } from './color.js';

function num(v, prec = 3) {
  const s = (+v).toFixed(prec);
  return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function gradientBlock(g, indent) {
  const pad = indent;
  const pad2 = indent + '  ';
  let open;
  if (g.kind === 'linear') {
    open =
      `<gradient android:type="linear" ` +
      `android:startX="${num(g.x1)}" android:startY="${num(g.y1)}" ` +
      `android:endX="${num(g.x2)}" android:endY="${num(g.y2)}">`;
  } else if (g.kind === 'radial') {
    open =
      `<gradient android:type="radial" ` +
      `android:centerX="${num(g.cx)}" android:centerY="${num(g.cy)}" ` +
      `android:gradientRadius="${num(g.r)}">`;
  } else {
    // sweep: derive() doesn't emit these (no SVG parity), but support anyway.
    open = `<gradient android:type="sweep" android:centerX="${num(g.cx)}" android:centerY="${num(g.cy)}">`;
  }
  const items = g.stops
    .map((s) => `${pad2}  <item android:offset="${num(s.offset)}" android:color="${toAndroid(s.color)}"/>`)
    .join('\n');
  return `${pad2}${open}\n${items}\n${pad2}</gradient>`;
}

function pathBlock(p) {
  const lines = [];
  const attrs = [`android:pathData="${esc(p.d)}"`];

  if (p.fillRule === 'evenOdd') attrs.push('android:fillType="evenOdd"');

  // Solid fill / stroke attrs live on the <path> element directly.
  if (p.fill && p.fill.type === 'solid') {
    attrs.push(`android:fillColor="${toAndroid(p.fill.color)}"`);
  }
  if (p.stroke) {
    attrs.push(`android:strokeColor="${toAndroid(p.stroke.color)}"`);
    attrs.push(`android:strokeWidth="${num(p.stroke.width)}"`);
    if (p.stroke.cap && p.stroke.cap !== 'butt') attrs.push(`android:strokeLineCap="${esc(p.stroke.cap)}"`);
    if (p.stroke.join && p.stroke.join !== 'miter') attrs.push(`android:strokeLineJoin="${esc(p.stroke.join)}"`);
  }

  const hasGradient = p.fill && p.fill.type === 'gradient';
  if (!hasGradient) {
    lines.push(`  <path ${attrs.join('\n        ')}/>`);
    return lines.join('\n');
  }

  // Gradient fill → <aapt:attr> child block.
  lines.push(`  <path ${attrs.join('\n        ')}>`);
  lines.push(`    <aapt:attr name="android:fillColor">`);
  lines.push(gradientBlock(p.fill.gradient, '    '));
  lines.push(`    </aapt:attr>`);
  lines.push(`  </path>`);
  return lines.join('\n');
}

// derived + canvas → VectorDrawable XML string.
export function exportVD(derived, canvas) {
  const hasGradient = derived.paths.some((p) => p.fill && p.fill.type === 'gradient');

  const ns = [`xmlns:android="http://schemas.android.com/apk/res/android"`];
  if (hasGradient) ns.push(`xmlns:aapt="http://schemas.android.com/aapt"`);

  const w = canvas && canvas.width ? canvas.width : derived.viewportWidth;
  const h = canvas && canvas.height ? canvas.height : derived.viewportHeight;

  const header =
    `<vector ${ns.join('\n        ')}\n` +
    `        android:width="${num(w)}dp" android:height="${num(h)}dp"\n` +
    `        android:viewportWidth="${num(derived.viewportWidth)}" ` +
    `android:viewportHeight="${num(derived.viewportHeight)}">`;

  const body = derived.paths.map(pathBlock).join('\n');
  return `${header}\n${body}\n</vector>\n`;
}
