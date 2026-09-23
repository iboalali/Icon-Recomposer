// render.js: variant → icon markup, plus the stylesheet the markup needs.
//
// The live preview (inside a shadow root) and the PNG capture (inside an SVG
// foreignObject) both use exactly this markup and stylesheet, so the export
// matches the preview.
//
// The markup is XHTML-safe: it is parsed as XML inside the capture SVG.

import { CANVAS, paintOrder } from './model.js';

const AMBIENT_URL = new URL('./vendor/ambientcss/ambient.css', import.meta.url);

const SURFACE_CLASS = {
  flat: 'amb-surface',
  concave: 'amb-surface-concave',
  'concave-h': 'amb-surface-concave-h',
  convex: 'amb-surface-convex',
  groove: 'amb-groove',
};

const BASE_CSS = `
.ir-stage { position: relative; width: ${CANVAS}px; height: ${CANVAS}px; overflow: hidden; }
.ir-shape, .ir-halo { position: absolute; box-sizing: border-box; }
.ir-halo { background: transparent; pointer-events: none; }
`;

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
      .then((css) => css.replace(/:root\s*\{/, ':root, .ir-stage {') + BASE_CSS);
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
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

function shapeMarkup(shape, scene) {
  const st = shape.style;
  const classes = ['ir-shape', 'ambient'];
  if (st.material === 'glass') {
    classes.push('amb-mat-glass');
  } else {
    classes.push(SURFACE_CLASS[st.surface] || 'amb-surface');
    if (st.material !== 'matte') classes.push(`amb-mat-${st.material}`);
  }
  const light = localLight(scene, shape.rotation || 0);
  const vars = [
    `--amb-light-x:${num(light.x)}`,
    `--amb-light-y:${num(light.y)}`,
    `--amb-albedo:${st.color}`,
    `--amb-shade:${num(st.shade)}`,
    `--amb-elevation:${num(st.elevation)}`,
    `--amb-thickness:${num(st.thickness)}`,
    `--amb-chamfer:${st.chamfer ? 1 : 0}`,
    `--amb-chamfer-width:${num(st.chamferWidth)}`,
    `--amb-fillet:${st.fillet ? 1 : 0}`,
    `--amb-fillet-width:${num(st.filletWidth)}`,
    `--amb-curve-scale:${num(st.curveScale)}`,
    `--amb-grain-amount:${num(st.grain)}`,
  ].join(';');
  const geo = geometryCss(shape);
  const opacity = st.opacity < 1 ? `opacity:${num(st.opacity)};` : '';
  let out = '';
  if (st.glow && st.glowSize > 0) {
    out += `<div class="ir-halo" style="${geo}${opacity}box-shadow:0 0 ${num(st.glowSize)}px ${num(st.glowSize / 3)}px ${st.glowColor}"></div>`;
  }
  out += `<div class="${classes.join(' ')}" data-id="${esc(shape.id)}" style="${geo}${opacity}${vars}"></div>`;
  return out;
}

// layer: 'all' (the composite), 'foreground' (no background) or 'background'.
export function stageMarkup(variant, { layer = 'all', transparent = false } = {}) {
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
  const shapes = paintOrder(variant.shapes)
    .filter((s) => !s.hidden && (layer === 'all' || s.layer === layer))
    .map((s) => shapeMarkup(s, sc))
    .join('');
  return `<div class="ir-stage" style="${style}">${shapes}</div>`;
}
