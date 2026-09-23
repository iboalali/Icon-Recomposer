// export.js: PNG capture and export sets.
//
// A variant's markup goes into an SVG <foreignObject>, the SVG is loaded as an
// image and drawn onto a canvas. The SVG carries the target width/height, and
// its viewBox picks the canvas region, so the browser paints the icon directly
// at the output resolution instead of upscaling a small bitmap.

import { CANVAS, slug } from './model.js';
import { iconCss, stageMarkup } from './render.js';
import { makeZip } from './zip.js';

export const REGIONS = [
  { id: 'full', label: 'Whole canvas (108dp)', box: [0, 0, CANVAS, CANVAS] },
  { id: 'viewport', label: 'Launcher view (center 72dp)', box: [18, 18, 72, 72] },
];

export const MASKS = [
  { id: 'none', label: 'None (square)' },
  { id: 'circle', label: 'Circle' },
  { id: 'rounded', label: 'Rounded square' },
  { id: 'squircle', label: 'Squircle' },
];

const DENSITIES = [
  ['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4],
];

const ADAPTIVE_XML = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;

// A job with `layer` is an adaptive-icon layer: always the whole 108dp canvas
// and never masked, because the launcher applies its own mask. Every other
// image job follows the dialog's area and mask.
export const PRESETS = [
  {
    id: 'play',
    label: 'Play Store (512 px)',
    files: () => [{ size: 512, path: 'play-store-512.png' }],
  },
  {
    id: 'launcher',
    label: 'Legacy launcher, 48dp (48-192 px)',
    files: () => DENSITIES.map(([d, k]) => ({ size: 48 * k, path: `mipmap-${d}/ic_launcher.png` })),
  },
  {
    id: 'adaptive',
    label: 'Adaptive icon layers, 108dp (108-432 px) + XML',
    files: () => [
      ...DENSITIES.flatMap(([d, k]) => [
        { size: 108 * k, layer: 'foreground', path: `mipmap-${d}/ic_launcher_foreground.png` },
        { size: 108 * k, layer: 'background', path: `mipmap-${d}/ic_launcher_background.png` },
      ]),
      { text: ADAPTIVE_XML, path: 'mipmap-anydpi-v26/ic_launcher.xml' },
      { text: ADAPTIVE_XML, path: 'mipmap-anydpi-v26/ic_launcher_round.xml' },
    ],
  },
];

export function parseCustomSizes(text) {
  return [...new Set(
    String(text || '')
      .split(/[\s,;]+/)
      .map((t) => parseInt(t, 10))
      .filter((n) => Number.isFinite(n) && n >= 16 && n <= 4096),
  )];
}

function maskPath(mask, size) {
  const p = new Path2D();
  if (mask === 'circle') {
    p.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  } else if (mask === 'rounded') {
    p.roundRect(0, 0, size, size, size * 0.225);
  } else if (mask === 'squircle') {
    const n = 5;
    const r = size / 2;
    for (let i = 0; i <= 256; i++) {
      const t = (i / 256) * Math.PI * 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const x = r + r * Math.sign(c) * Math.abs(c) ** (2 / n);
      const y = r + r * Math.sign(s) * Math.abs(s) ** (2 / n);
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
    p.closePath();
  }
  return p;
}

async function captureSvg(variant, size, region, layer, transparent) {
  const css = (await iconCss()).replaceAll(']]>', ']]]]><![CDATA[>');
  const box = (REGIONS.find((r) => r.id === region) || REGIONS[0]).box;
  const markup = stageMarkup(variant, { layer, transparent, pxPerUnit: size / box[2] });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${box.join(' ')}">`
    + `<foreignObject x="0" y="0" width="${CANVAS}" height="${CANVAS}">`
    + `<div xmlns="http://www.w3.org/1999/xhtml"><style><![CDATA[${css}]]></style>${markup}</div>`
    + '</foreignObject></svg>';
}

export async function renderCanvas(variant, { size, region = 'full', mask = 'none', layer = 'all', transparent = false }) {
  const svg = await captureSvg(variant, size, region, layer, transparent);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  g.drawImage(img, 0, 0, size, size);
  if (mask !== 'none') {
    g.globalCompositeOperation = 'destination-in';
    g.fill(maskPath(mask, size));
  }
  return canvas;
}

export async function renderPng(variant, opts) {
  const canvas = await renderCanvas(variant, opts);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

// Lists every file an export will write, without rendering anything.
//   { variants, presets: [id], customSizes: [n] }
//   → [{ variant, path, size, layer? } | { variant, path, text }]
export function planExport(docName, { variants, presets, customSizes }) {
  const jobs = [];
  const folders = variants.length > 1;
  const used = new Set();
  for (const variant of variants) {
    let folder = slug(variant.name);
    for (let i = 2; used.has(folder); i++) folder = `${slug(variant.name)}-${i}`;
    used.add(folder);
    const prefix = folders ? `${folder}/` : '';
    for (const preset of PRESETS) {
      if (!presets.includes(preset.id)) continue;
      for (const f of preset.files()) jobs.push({ ...f, variant, path: prefix + f.path });
    }
    for (const size of customSizes) {
      jobs.push({ variant, size, path: `${prefix}${slug(docName)}-${size}.png` });
    }
  }
  return jobs;
}

function jobOptions(job, opts) {
  if (!job.layer) return { ...opts, size: job.size };
  return { size: job.size, region: 'full', mask: 'none', layer: job.layer, transparent: false };
}

// Runs the jobs and returns one download: the file itself for a single job,
// otherwise a zip.
export async function runExport(docName, jobs, opts, onProgress) {
  const enc = new TextEncoder();
  const files = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    onProgress?.(i, jobs.length);
    const data = job.text !== undefined
      ? enc.encode(job.text)
      : new Uint8Array(await (await renderPng(job.variant, jobOptions(job, opts))).arrayBuffer());
    files.push({ name: job.path, data });
  }
  onProgress?.(jobs.length, jobs.length);
  if (files.length === 1 && jobs[0].text === undefined) {
    const j = jobs[0];
    return {
      blob: new Blob([files[0].data], { type: 'image/png' }),
      filename: `${slug(docName)}-${slug(j.variant.name)}-${j.size}.png`,
    };
  }
  return { blob: makeZip(files), filename: `${slug(docName)}-icons.zip` };
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
