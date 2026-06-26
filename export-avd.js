// export-avd.js — authoring model → Android Animated Vector Drawable (AVD).
//
// Unlike export-vd.js (which serializes the DERIVED, gradient-baked model for a
// single static frame), AVD must keep structure that Android can animate:
//   - each layer's ORIGINAL pathData (un-baked) inside a named <group> carrying
//     the layer transform, so translate/scale/rotation can be animated;
//   - solid fills as android:fillColor (+ android:fillAlpha), so colour/opacity
//     can be animated.
//
// AVD CANNOT animate gradients, and this app fakes emboss/sheen/shadow/light as
// gradients — so those can't be represented. exportAVD collects a `warnings`
// list of everything it drops (light/emboss/sheen/gradient-stop animation, cast
// shadows, and emboss shading flattened to a solid colour), surfaced on export.

import { parseColor, toAndroid } from './color.js';
import { sampleTrack } from './animate.js';

function num(v, prec = 3) {
  const s = (+v).toFixed(prec);
  return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sanitize(id) {
  return 'l_' + String(id).replace(/[^A-Za-z0-9_]/g, '_');
}
// Opaque #FFRRGGBB (alpha rides android:fillAlpha so colour + opacity animate independently).
function solidColor(hex) {
  const c = parseColor(hex) || { r: 0, g: 0, b: 0, a: 1 };
  return toAndroid({ r: c.r, g: c.g, b: c.b, a: 1 });
}
function colorValue(hex) {
  return solidColor(hex);
}
function stopColor(s) {
  const c = parseColor(s.color) || { r: 0, g: 0, b: 0, a: 1 };
  return toAndroid({ r: c.r, g: c.g, b: c.b, a: s.alpha == null ? 1 : s.alpha });
}

// Our easing → the nearest stock Android interpolator (hold has no exact match).
const EASE_INTERP = {
  linear: '@android:anim/linear_interpolator',
  easeIn: '@android:anim/accelerate_interpolator',
  easeOut: '@android:anim/decelerate_interpolator',
  easeInOut: '@android:anim/accelerate_decelerate_interpolator',
  hold: '@android:anim/linear_interpolator',
};

// Group-transform tracks → AVD group property names (all floatType).
const GROUP_PROPS = {
  'transform.translateX': 'translateX',
  'transform.translateY': 'translateY',
  'transform.scaleX': 'scaleX',
  'transform.scaleY': 'scaleY',
  'transform.rotation': 'rotation',
};

// Build the keyframe list for a track over [0, duration], guaranteeing endpoints
// at fraction 0 and 1 (Android needs the full range). Each keyframe carries the
// interpolator of the segment LEADING to it (our easing is held on the left key).
function keyframesFor(track, durationSec, fmt) {
  const dur = durationSec || 1;
  const ks = track.keys.slice().sort((a, b) => a.t - b.t);
  const pts = [];
  if (ks[0].t > 0) pts.push({ f: 0, value: sampleTrack(track, 0), ease: null });
  ks.forEach((k, i) => {
    pts.push({
      f: Math.min(1, Math.max(0, k.t / dur)),
      value: k.value,
      ease: i > 0 ? ks[i - 1].easing : (pts.length ? ks[0].easing : null),
    });
  });
  if (ks[ks.length - 1].t < dur) pts.push({ f: 1, value: sampleTrack(track, dur), ease: ks[ks.length - 1].easing });
  return pts
    .map((p) => {
      const interp = p.ease ? ` android:interpolator="${EASE_INTERP[p.ease] || EASE_INTERP.linear}"` : '';
      return `          <keyframe android:fraction="${num(p.f)}" android:value="${fmt(p.value)}"${interp}/>`;
    })
    .join('\n');
}

function objectAnimator(property, valueType, track, durationMs, loop) {
  const fmt = valueType === 'colorType' ? colorValue : (v) => num(v);
  const rep = loop ? ` android:repeatCount="infinite" android:repeatMode="restart"` : '';
  const kfs = keyframesFor(track, durationMs / 1000, fmt);
  return (
    `      <objectAnimator android:duration="${Math.round(durationMs)}"${rep}>\n` +
    `        <propertyValuesHolder android:propertyName="${property}" android:valueType="${valueType}">\n` +
    `${kfs}\n` +
    `        </propertyValuesHolder>\n` +
    `      </objectAnimator>`
  );
}

function gradientXml(g) {
  let open;
  if (g.type === 'radial') {
    open = `<gradient android:type="radial" android:centerX="${num(g.cx)}" android:centerY="${num(g.cy)}" android:gradientRadius="${num(g.r)}">`;
  } else {
    open = `<gradient android:type="linear" android:startX="${num(g.x1)}" android:startY="${num(g.y1)}" android:endX="${num(g.x2)}" android:endY="${num(g.y2)}">`;
  }
  const items = g.stops.map((s) => `            <item android:offset="${num(s.offset)}" android:color="${stopColor(s)}"/>`).join('\n');
  return `          ${open}\n${items}\n          </gradient>`;
}

// authoring document → AVD XML. Pushes human-readable strings into `warnings`
// for anything that can't be represented. Returns the XML string.
export function exportAVD(document, warnings = []) {
  const warn = new Set();
  const tl = document.timeline;
  const animating = !!(tl && tl.enabled && tl.tracks && tl.tracks.length);
  const durationMs = animating ? Math.round(tl.duration * 1000) : 0;
  const loop = animating ? tl.loop !== false : false;
  const tracksFor = (id) => (animating ? tl.tracks.filter((t) => t.scope === 'layer' && t.layerId === id) : []);

  if (animating && tl.tracks.some((t) => t.scope === 'scene')) {
    warn.add('Light animation (position / azimuth / elevation / intensity) — AVD can’t animate the gradient-based lighting.');
  }

  const groups = []; // vector body (paint order)
  const targets = []; // <target> animation bindings

  for (const layer of document.layers) {
    if (!layer.visible || !layer.pathData) continue;
    const m = layer.material || {};
    const grpName = sanitize(layer.id) + '_g';
    const pthName = sanitize(layer.id) + '_p';
    const lTracks = tracksFor(layer.id);

    // ---- fill ----
    const pathAttrs = [`android:name="${pthName}"`, `android:pathData="${esc(layer.pathData)}"`];
    if (layer.fillRule === 'evenOdd') pathAttrs.push('android:fillType="evenOdd"');
    let gradient = null;
    const fillNone = !!m.fillNone;
    if (!fillNone) {
      if (m.fillMode === 'gradient' && m.gradient) {
        gradient = m.gradient; // static only — gradients can't be animated in AVD
      } else {
        if (m.fillMode === 'embossed') warn.add('Emboss / sheen shading is flattened to a solid colour (AVD can’t animate gradients).');
        pathAttrs.push(`android:fillColor="${solidColor(m.baseColor || '#000000')}"`);
      }
      const a = m.fillAlpha == null ? 1 : m.fillAlpha;
      if (a < 1 || lTracks.some((t) => t.prop === 'material.fillAlpha')) pathAttrs.push(`android:fillAlpha="${num(a)}"`);
    }
    if (m.stroke) {
      const sc = parseColor(m.stroke.color) || { r: 0, g: 0, b: 0, a: 1 };
      pathAttrs.push(`android:strokeColor="${toAndroid(sc)}"`, `android:strokeWidth="${num(m.stroke.width)}"`);
    }
    if (layer.castsShadow && layer.castsShadow.enabled) warn.add('Cast shadows aren’t included (AVD can’t render the gradient-based shadow).');

    let pathXml;
    if (gradient) {
      pathXml = `      <path ${pathAttrs.join(' ')}>\n        <aapt:attr name="android:fillColor">\n${gradientXml(gradient)}\n        </aapt:attr>\n      </path>`;
    } else {
      pathXml = `      <path ${pathAttrs.join(' ')}/>`;
    }

    // ---- group (needed for a base transform or any transform animation) ----
    const t = layer.transform;
    const hasGroupTrack = lTracks.some((x) => GROUP_PROPS[x.prop]);
    const needsGroup = !!t || hasGroupTrack;
    if (needsGroup) {
      const ga = [`android:name="${grpName}"`];
      const tx = (t && +t.translateX) || 0, ty = (t && +t.translateY) || 0;
      const sx = t && t.scaleX != null ? +t.scaleX : 1, sy = t && t.scaleY != null ? +t.scaleY : 1;
      const rot = (t && +t.rotation) || 0, px = (t && +t.pivotX) || 0, py = (t && +t.pivotY) || 0;
      if (tx) ga.push(`android:translateX="${num(tx)}"`);
      if (ty) ga.push(`android:translateY="${num(ty)}"`);
      if (sx !== 1) ga.push(`android:scaleX="${num(sx)}"`);
      if (sy !== 1) ga.push(`android:scaleY="${num(sy)}"`);
      if (rot) ga.push(`android:rotation="${num(rot)}"`);
      if (px) ga.push(`android:pivotX="${num(px)}"`);
      if (py) ga.push(`android:pivotY="${num(py)}"`);
      groups.push(`    <group ${ga.join(' ')}>\n${pathXml}\n    </group>`);
    } else {
      groups.push(pathXml);
    }

    // ---- animations for this layer ----
    if (!animating) continue;
    const groupAnims = [];
    const pathAnims = [];
    for (const track of lTracks) {
      if (GROUP_PROPS[track.prop]) {
        groupAnims.push(objectAnimator(GROUP_PROPS[track.prop], 'floatType', track, durationMs, loop));
      } else if (track.prop === 'material.fillAlpha') {
        pathAnims.push(objectAnimator('fillAlpha', 'floatType', track, durationMs, loop));
      } else if (track.prop === 'material.baseColor') {
        if (m.fillMode === 'solid' && !fillNone) pathAnims.push(objectAnimator('fillColor', 'colorType', track, durationMs, loop));
        else warn.add('Base-colour animation on embossed / gradient layers — AVD can only animate a solid fill colour.');
      } else if (/^material\.gradient\.stops\./.test(track.prop)) {
        warn.add('Gradient-stop animation (offset / colour / alpha) — AVD can’t animate gradients.');
      } else if (track.prop === 'material.embossIntensity' || track.prop === 'material.sheen.strength') {
        warn.add('Emboss / sheen animation — these are gradient effects AVD can’t animate.');
      }
    }
    if (groupAnims.length) targets.push(targetBlock(grpName, groupAnims));
    if (pathAnims.length) targets.push(targetBlock(pthName, pathAnims));
  }

  if (animating && !targets.length) warn.add('None of the animation could be represented in AVD — the exported file is static.');
  if (!animating) warn.add('The timeline is off, so the exported AVD is static.');

  warnings.push(...warn);

  const c = document.canvas;
  const ns = `xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:aapt="http://schemas.android.com/aapt"`;
  const vector =
    `  <aapt:attr name="android:drawable">\n` +
    `    <vector ${ns}\n` +
    `        android:width="${num(c.width)}dp" android:height="${num(c.height)}dp"\n` +
    `        android:viewportWidth="${num(c.viewportWidth)}" android:viewportHeight="${num(c.viewportHeight)}">\n` +
    `${groups.join('\n')}\n` +
    `    </vector>\n` +
    `  </aapt:attr>`;

  return (
    `<animated-vector ${ns}>\n` +
    `${vector}\n` +
    (targets.length ? targets.join('\n') + '\n' : '') +
    `</animated-vector>\n`
  );
}

function targetBlock(name, anims) {
  const body =
    anims.length === 1
      ? anims[0]
      : `      <set android:ordering="together">\n${anims.map((a) => a.replace(/^/gm, '  ')).join('\n')}\n      </set>`;
  return (
    `  <target android:name="${name}">\n` +
    `    <aapt:attr name="android:animation">\n` +
    `${body}\n` +
    `    </aapt:attr>\n` +
    `  </target>`
  );
}
