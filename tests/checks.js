// Automated render checks for TESTING.md. In the served app's DevTools console:
//   await import('/tests/checks.js')
//   await vt.run('CR-1')     one check, with a table of its parts
//   await vt.runAll()        every check; vt.runAll('MT') runs one group
// A check renders scenes and compares them against a target: another render
// that must look the same, a measured property, or an approved reference image
// in captures/golden/.
import vt from './vt.js';
import { parseCustomSizes, planExport } from '../export.js';
import { importVectorDrawable } from '../vdimport.js';

const { M } = vt;
const checks = [];
const check = (id, title, run) => checks.push({ id, title, run });

// Parts of a check. pass: true, false, or null when skipped.
const exact = (label, c) => ({ label, pass: c.max === 0, value: c });
const near = (label, c) => ({ label, pass: c.mean <= 0.5 && c.over <= 0.5, value: c });
const differs = (label, c, min = 1) => ({ label, pass: c.mean >= min, value: c });
const prop = (label, pass, value) => ({ label, pass, value });
const skip = (label, value) => ({ label, pass: null, value });

const dominant = (px) => px.slice(0, 3).indexOf(Math.max(...px.slice(0, 3)));
const RGB = ['red', 'green', 'blue'];
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------------------
// AP: app shell (run in the editor page)

check('AP-1', 'ambient.css stays inside the stage and never reaches the editor UI', async () => {
  const host = document.getElementById('stage-host');
  const own = [...document.styleSheets].map((s) => s.href || 'inline');
  const inPage = document.adoptedStyleSheets.length + own.filter((h) => /ambient/.test(h)).length;
  const rules = (sheets) => sheets.flatMap((s) => [...s.cssRules].map((r) => r.cssText));
  const pageText = rules([...document.styleSheets]).join('\n');
  const stageText = host?.shadowRoot ? rules(host.shadowRoot.adoptedStyleSheets).join('\n') : '';
  return [
    prop('the page has no ambient.css rules', inPage === 0 && !/--amb-light-x/.test(pageText), own),
    prop("the stage's shadow root has them", /--amb-light-x/.test(stageText) && /\.ir-stage/.test(stageText), host ? 'stage found' : 'open the editor page'),
  ];
});

// ---------------------------------------------------------------------------
// RC: rendering core

check('RC-1', 'Rendering the same scene twice gives the same pixels', async () => {
  const v = M.sampleDocument().variants[0];
  return [exact('sample variant 1', vt.compare(await vt.render(v), await vt.render(v)))];
});

check('RC-2', 'Saving and reopening a project renders the same', async () => {
  const d = M.sampleDocument();
  d.variants[0].shapes[0].style.material = 'marble';
  Object.assign(d.variants[0].shapes[0].style, M.materialDefaults('marble'), { seed: 77 });
  d.variants[0].shapes[1].wall = 4;
  const back = M.parseProject(M.serializeProject(d));
  const out = [];
  for (const [i, v] of d.variants.entries()) {
    out.push(exact(`variant ${i + 1}`, vt.compare(await vt.render(v), await vt.render(back.variants[i]))));
  }
  return out;
});

check('RC-3', 'A hidden shape renders like a deleted one', async () => {
  const hid = vt.pair();
  hid.shapes[1].hidden = true;
  const del = vt.pair();
  del.shapes.splice(1, 1);
  return [exact('B hidden vs B deleted', vt.compare(await vt.render(hid), await vt.render(del)))];
});

check('RC-4', 'Opacity 0 renders like no shape at all', async () => {
  return [exact('tile at opacity 0 vs empty', vt.compare(await vt.render(vt.tile({ opacity: 0 })), await vt.render(vt.empty())))];
});

check('RC-5', 'Turning the whole scene 90° turns the render 90°', async () => {
  const out = [];
  for (const [i, v] of M.sampleDocument().variants.entries()) {
    out.push(near(`sample variant ${i + 1}`, vt.compare(vt.rot90(await vt.render(v)), await vt.render(vt.rotated(v)))));
  }
  return out;
});

check('RC-6', 'The background layer paints under the foreground, whatever the list order', async () => {
  const a = vt.pair();
  a.shapes[1].layer = 'background';
  const b = structuredClone(a);
  b.shapes.reverse();
  return [exact('background B listed on top vs below', vt.compare(await vt.render(a), await vt.render(b)))];
});

check('RC-7', 'A symmetric shape turned 180° looks unturned', async () => {
  const out = [];
  for (const surface of ['flat', 'convex', 'concave', 'groove']) {
    out.push(near(surface, vt.compare(await vt.render(vt.tile({ surface }, { rotation: 180 })), await vt.render(vt.tile({ surface })))));
  }
  return out;
});

// ---------------------------------------------------------------------------
// LB: light and background

check('LB-1', 'Shadows fall away from the light', async () => {
  const out = [];
  for (const [lx, ly] of [[-1, -1], [1, 0], [0, 1], [1, 1], [-0.5, 1]]) {
    const v = vt.tile({}, { x: 44, y: 44, w: 20, h: 20, radius: 4 });
    Object.assign(v.scene, { lightX: lx, lightY: ly });
    const [dx, dy] = await vt.shadowOffset(v, { x: 43, y: 43, w: 22, h: 22 });
    const ok = (l, d) => (l === 0 ? Math.abs(d) < 1.5 : Math.sign(d) === -Math.sign(l) && Math.abs(d) > 1);
    out.push(prop(`light (${lx}, ${ly})`, ok(lx, dx) && ok(ly, dy), `shadow offset (${dx}, ${dy})`));
  }
  return out;
});

check('LB-2', 'Elevation 0 and thickness 0 cast no shadow', async () => {
  const a = await vt.render(vt.tile({ elevation: 0, thickness: 0 }));
  const e = await vt.render(vt.empty());
  return [
    exact('right of the tile', vt.compare(a, e, { x: 85, y: 0, w: 23, h: 108 })),
    exact('below the tile', vt.compare(a, e, { x: 0, y: 85, w: 108, h: 23 })),
    differs('sanity: elevation 1 does cast one', vt.compare(await vt.render(vt.tile()), e, { x: 85, y: 0, w: 23, h: 108 })),
  ];
});

check('LB-3', 'An unshaded background is exactly its color', async () => {
  const v = vt.empty();
  Object.assign(v.background, { color: '#336699', lit: false });
  const c = await vt.render(v);
  return [prop('corner and center', same(vt.pixel(c, 1, 1), [0x33, 0x66, 0x99, 255]) && same(vt.pixel(c, 54, 54), [0x33, 0x66, 0x99, 255]), vt.pixel(c, 54, 54))];
});

check('LB-4', "A shaded background takes the light's strength and tint; an unshaded one ignores them", async () => {
  const bg = async (lit, scene) => {
    const v = vt.empty();
    v.background.lit = lit;
    Object.assign(v.scene, scene);
    return vt.render(v, 108);
  };
  return [
    differs('shaded: key light 0.3 vs 0.9', vt.compare(await bg(true, { key: 0.3 }), await bg(true, { key: 0.9 }))),
    differs('shaded: tint 60 vs 0', vt.compare(await bg(true, { hue: 30, saturation: 60 }), await bg(true, { hue: 30, saturation: 0 }))),
    exact('unshaded: key light 0.3 vs 0.9', vt.compare(await bg(false, { key: 0.3 }), await bg(false, { key: 0.9 }))),
  ];
});

check('LB-5', 'No background (transparent) leaves only the shapes', async () => {
  const v = vt.tile();
  v.background.transparent = true;
  const c = await vt.render(v);
  const o = await vt.render(vt.tile(), 512, { transparent: true });
  return [
    prop('project setting: corner alpha 0', vt.pixel(c, 1, 1)[3] === 0, vt.pixel(c, 1, 1)),
    prop('export option: corner alpha 0', vt.pixel(o, 1, 1)[3] === 0, vt.pixel(o, 1, 1)),
    prop('shape stays opaque', vt.pixel(c, 54, 54)[3] === 255, vt.pixel(c, 54, 54)),
  ];
});

// ---------------------------------------------------------------------------
// SH: shapes

check('SH-1', 'Every surface turns with the scene', async () => {
  const out = [];
  for (const { id } of M.SURFACES) {
    for (const kind of ['rect', 'ellipse']) {
      const v = vt.scene(vt.shape(kind, { x: 20, y: 30, w: 64, h: 44, radius: 10, rotation: 15 }, { surface: id }));
      out.push(near(`${id} ${kind}`, vt.compare(vt.rot90(await vt.render(v)), await vt.render(vt.rotated(v)))));
    }
  }
  return out;
});

check('SH-2', 'A frame and a ring show the background through their hole', async () => {
  const e = await vt.render(vt.empty());
  const out = [];
  for (const kind of ['rect', 'ellipse']) {
    const c = await vt.render(vt.scene(vt.shape(kind, { x: 14, y: 14, w: 80, h: 80, radius: 10, wall: 8 })));
    out.push(exact(`${kind}: center of the hole`, vt.compare(c, e, { x: 50, y: 50, w: 8, h: 8 })));
    out.push(differs(`${kind}: sanity, the wall is drawn`, vt.compare(c, e, { x: 15, y: 50, w: 6, h: 8 })));
  }
  return out;
});

check('SH-3', 'Frames and rings turn with the scene, curved walls included', async () => {
  const out = [];
  for (const surface of ['flat', 'convex', 'concave', 'concave-h']) {
    for (const kind of ['rect', 'ellipse']) {
      const v = vt.scene(vt.shape(kind, { x: 18, y: 26, w: 72, h: 56, radius: 12, wall: 9, rotation: 10 }, { surface }));
      out.push(near(`${surface} ${kind}`, vt.compare(vt.rot90(await vt.render(v)), await vt.render(vt.rotated(v)))));
    }
  }
  const neon = vt.scene(vt.shape('rect', { x: 18, y: 26, w: 72, h: 56, radius: 12, wall: 6 }, { material: 'neon', color: '#ff3d8b' }));
  out.push(near('neon frame', vt.compare(vt.rot90(await vt.render(neon)), await vt.render(vt.rotated(neon)))));
  return out;
});

check('SH-4', 'Level shapes cast no shadow on each other', async () => {
  const two = () => vt.scene(
    vt.shape('rect', { name: 'A', x: 54, y: 34, w: 34, h: 40, radius: 0 }, { color: '#d04a4a' }),
    vt.shape('rect', { name: 'B', x: 20, y: 34, w: 34, h: 40, radius: 0 }, { color: '#4a7bd0' }),
  );
  const level = two();
  level.shapes.forEach((s) => { s.level = true; });
  const onlyA = two();
  onlyA.shapes[1].hidden = true;
  const faceA = { x: 55, y: 35, w: 32, h: 38 };
  const ref = await vt.render(onlyA);
  return [
    exact("level: A's face as if B were not there", vt.compare(await vt.render(level), ref, faceA)),
    differs("sanity, not level: B's shadow lands on A", vt.compare(await vt.render(two()), ref, faceA)),
  ];
});

// ---------------------------------------------------------------------------
// CR: crossings

check('CR-1', 'An opaque crossing looks like painting the shape on top', async () => {
  const [c, r] = vt.crossed(vt.pair());
  return [near('A over B vs A painted last', vt.compare(await vt.render(c), await vt.render(r)))];
});

check('CR-2', "The shape on top keeps its own face, untouched by the one below", async () => {
  const [c] = vt.crossed(vt.pair());
  const alone = vt.pair();
  alone.shapes[1].hidden = true;
  return [near("A's face vs A alone", vt.compare(await vt.render(c), await vt.render(alone), { x: 21, y: 45, w: 66, h: 18 }))];
});

// A bar A with two bars B and C crossing it, B left and C right; C paints last.
const bars = (styleA = {}) => vt.scene(
  vt.shape('rect', { name: 'A', x: 10, y: 44, w: 88, h: 20, radius: 4 }, { color: '#d04a4a', ...styleA }),
  vt.shape('rect', { name: 'B', x: 22, y: 20, w: 16, h: 68, radius: 4 }, { color: '#4a7bd0' }),
  vt.shape('rect', { name: 'C', x: 70, y: 20, w: 16, h: 68, radius: 4 }, { color: '#40a060' }),
);

check('CR-3', 'A see-through shape on top looks like painting it on top, with what lies under it seen through it', async () => {
  const inside = { x: 45, y: 45, w: 18, h: 18 };
  const out = [];
  for (const [label, style] of [['opacity 0.5', { opacity: 0.5 }], ['frosted glass', { material: 'glass' }], ['jelly', { material: 'jelly' }]]) {
    const [c, r] = vt.crossed(vt.pair(style));
    const a = await vt.render(c);
    const b = await vt.render(r);
    out.push(near(`${label}: inside the overlap`, vt.compare(a, b, inside)));
    out.push(near(`${label}: whole canvas`, vt.compare(a, b)));
  }
  const two = bars({ material: 'glass' });
  two.crossings = [{ over: two.shapes[0].id, under: two.shapes[1].id }, { over: two.shapes[0].id, under: two.shapes[2].id }];
  const twoRef = structuredClone(two);
  twoRef.crossings = [];
  twoRef.shapes.push(twoRef.shapes.shift());
  out.push(near('glass over two shapes: whole canvas', vt.compare(await vt.render(two), await vt.render(twoRef))));
  // Glass A over C only: B, painted between them, stays on top of A.
  const past = bars({ material: 'glass' });
  past.crossings = [{ over: past.shapes[0].id, under: past.shapes[2].id }];
  const pastRef = structuredClone(past);
  pastRef.crossings = [];
  pastRef.shapes = [pastRef.shapes[2], pastRef.shapes[0], pastRef.shapes[1]];
  out.push(near('glass lifted past a shape on top of it: away from that shape', vt.compare(await vt.render(past), await vt.render(pastRef), { x: 50, y: 0, w: 58, h: 108 })));
  return out;
});

// The design from the VectorDrawable in the bug report: a # of four bars, with
// the lower horizontal bar crossing over the right vertical one. Bars 2 and 3
// paint between them and shade the lower bar.
const hash = () => {
  const bar = (name, x, y, w, h, color) => vt.shape('rect', { name, x, y, w, h, radius: 0 }, { color });
  const v = vt.scene(
    bar('R1', 45.75, 56.063, 16.5, 2.063, '#3f2274'),
    bar('R2', 45.75, 49.875, 16.5, 2.063, '#381d68'),
    bar('R3', 49.875, 45.75, 2.063, 16.5, '#1c0c38'),
    bar('R4', 56.063, 45.75, 2.063, 16.5, '#1c0c38'),
  );
  v.crossings = [{ over: v.shapes[0].id, under: v.shapes[3].id }];
  return v;
};

check('CR-4', 'The part of a shape on top has the same shading as the rest of it', async () => {
  const c = await vt.render(hash(), 1024);
  const out = [];
  for (const [side, inX, outX] of [['left edge', 56.5, 55.6], ['right edge', 57.7, 58.6]]) {
    let worst = 0;
    for (const y of [56.4, 56.8, 57.2, 57.6, 57.9]) {
      const a = vt.pixel(c, inX, y);
      const b = vt.pixel(c, outX, y);
      worst = Math.max(worst, ...a.map((v, i) => Math.abs(v - b[i])));
    }
    out.push(prop(`${side}: step across the patch edge ≤ 8`, worst <= 8, `largest step ${worst}`));
  }
  return out;
});

check('CR-5', 'Three shapes weave: A over B, B over C, C over A', async () => {
  const v = vt.scene(
    vt.shape('rect', { name: 'A', x: 14, y: 24, w: 80, h: 12, radius: 3 }, { color: '#e04040' }),
    vt.shape('rect', { name: 'B', x: 24, y: 14, w: 12, h: 80, radius: 3 }, { color: '#40c040' }),
    vt.shape('rect', { name: 'C', x: 15, y: 54, w: 90, h: 12, radius: 3, rotation: -45 }, { color: '#4060e0' }),
  );
  const [a, b] = v.shapes;
  v.crossings = [{ over: a.id, under: b.id }, { over: b.id, under: v.shapes[2].id }];
  const c = await vt.render(v);
  return [[30, 30, 0, 'A over B'], [30, 90, 1, 'B over C'], [90, 30, 2, 'C over A']].map(([x, y, want, label]) => {
    const px = vt.pixel(c, x, y);
    return prop(label, dominant(px) === want, `${RGB[dominant(px)]} on top ${px}`);
  });
});

check('CR-6', 'Several shapes cross over one shape, also where they overlap each other', async () => {
  const v = vt.scene(
    vt.shape('rect', { name: 'X', x: 14, y: 46, w: 80, h: 16, radius: 3 }, { color: '#e04040' }),
    vt.shape('rect', { name: 'Y', x: 46, y: 14, w: 16, h: 80, radius: 3 }, { color: '#4060e0' }),
    vt.shape('rect', { name: 'P', x: 30, y: 30, w: 48, h: 48, radius: 6 }, { color: '#40c040' }),
  );
  const [x, y, p] = v.shapes;
  v.crossings = [{ over: x.id, under: p.id }, { over: y.id, under: p.id }];
  const c = await vt.render(v);
  return [[36, 54, 0, 'X over P'], [54, 36, 2, 'Y over P'], [54, 54, 2, 'Y over X over P'], [36, 36, 1, 'P alone']].map(([px, py, want, label]) => {
    const got = vt.pixel(c, px, py);
    return prop(label, dominant(got) === want, `${RGB[dominant(got)]} ${got}`);
  });
});

check('CR-7', "A shape crossing over a frame stays clear of the frame's hole shadow", async () => {
  const v = vt.scene(
    vt.shape('rect', { name: 'A', x: 10, y: 48, w: 88, h: 12, radius: 3 }, { color: '#e04040' }),
    vt.shape('rect', { name: 'F', x: 24, y: 24, w: 60, h: 60, radius: 8, wall: 10 }, { color: '#4060e0' }),
  );
  v.crossings = [{ over: v.shapes[0].id, under: v.shapes[1].id }];
  const alone = structuredClone(v);
  alone.shapes[1].hidden = true;
  alone.crossings = [];
  return [near("A's face inside the hole vs A alone", vt.compare(await vt.render(v), await vt.render(alone), { x: 35, y: 49, w: 38, h: 10 }))];
});

check('CR-8', 'Reflections respect crossings', async () => {
  const scene = (reflect, cross) => {
    const v = vt.scene(
      vt.shape('rect', { name: 'A', x: 44, y: 14, w: 20, h: 40, radius: 4 }, { color: '#e04040' }),
      vt.shape('rect', { name: 'G', x: 20, y: 40, w: 68, h: 48, radius: 8 }, { material: 'shiny', color: '#303848', reflect }),
    );
    if (cross) v.crossings = [{ over: v.shapes[0].id, under: v.shapes[1].id }];
    return v;
  };
  const face = { x: 22, y: 42, w: 64, h: 44 };
  return [
    differs('A crosses over G: G reflects A', vt.compare(await vt.render(scene(1, true)), await vt.render(scene(0, true)), face), 0.3),
    exact('A under G: nothing to reflect', vt.compare(await vt.render(scene(1, false)), await vt.render(scene(0, false)), face)),
  ];
});

check('CR-9', 'A shape crossing over two shapes gets no shadow from the first on its part over the second', async () => {
  // B close enough to C that B's shadow would reach A's part over C.
  const v = bars();
  Object.assign(v.shapes[1], { x: 50, w: 12 });
  v.crossings = [{ over: v.shapes[0].id, under: v.shapes[1].id }, { over: v.shapes[0].id, under: v.shapes[2].id }];
  const ref = structuredClone(v);
  ref.crossings = [];
  ref.shapes.push(ref.shapes.shift());
  const a = await vt.render(v);
  const b = await vt.render(ref);
  return [
    near("A's part over C", vt.compare(a, b, { x: 71, y: 45, w: 14, h: 18 })),
    near('whole canvas', vt.compare(a, b)),
  ];
});

// ---------------------------------------------------------------------------
// MT: materials

check('MT-1', 'Every material turns with the scene', async () => {
  const out = [];
  for (const { id } of M.MATERIALS) {
    const v = vt.tile({ material: id }, { rotation: 20 });
    out.push(near(id, vt.compare(vt.rot90(await vt.render(v)), await vt.render(vt.rotated(v)))));
  }
  return out;
});

check('MT-2', 'Every material matches its approved reference image', async () => {
  const out = [];
  for (const { id } of M.MATERIALS) {
    let ref;
    try {
      ref = await vt.image(`/captures/golden/MT-${id}.png`);
    } catch {
      out.push(skip(id, `no captures/golden/MT-${id}.png yet (vt.approve('${id}'))`));
      continue;
    }
    out.push(near(id, vt.compare(await vt.render(vt.tile({ material: id })), ref)));
  }
  return out;
});

check('MT-3', 'Shuffle gives a new layout that renders the same every time', async () => {
  const out = [];
  const face = { x: 30, y: 30, w: 48, h: 48 };
  for (const { id } of M.MATERIALS) {
    const style = { material: id };
    if (!M.shuffles({ ...M.materialDefaults(id), ...style })) continue;
    const a = await vt.render(vt.tile({ ...style, seed: 4321 }));
    const d = vt.compare(a, await vt.render(vt.tile(style)), face);
    const again = vt.compare(a, await vt.render(vt.tile({ ...style, seed: 4321 })));
    out.push(prop(id, d.mean >= 0.3 && again.max === 0, { vsOriginal: d, repeat: again.max }));
  }
  return out;
});

// ---------------------------------------------------------------------------
// RF: reflections

const onGlossy = (style, reflect, layer = 'foreground') => vt.scene(
  vt.shape('rect', { name: 'G', x: 16, y: 30, w: 76, h: 62, radius: 10, layer }, { color: '#303848', ...style, reflect }),
  vt.shape('ellipse', { name: 'S', x: 40, y: 20, w: 28, h: 28 }, { color: '#f0c040' }),
);

check('RF-1', 'Only glossy shapes reflect', async () => {
  const face = { x: 18, y: 32, w: 72, h: 40 };
  return [
    exact('matte: Reflections does nothing', vt.compare(await vt.render(onGlossy({}, 1)), await vt.render(onGlossy({}, 0)), face)),
    differs('shiny: the reflection shows', vt.compare(await vt.render(onGlossy({ material: 'shiny' }, 1)), await vt.render(onGlossy({ material: 'shiny' }, 0)), face), 0.3),
  ];
});

check('RF-2', 'A reflection stays inside the glossy shape', async () => {
  const a = await vt.render(onGlossy({ material: 'shiny' }, 1));
  const b = await vt.render(onGlossy({ material: 'shiny' }, 0));
  return [
    exact('below the shape', vt.compare(a, b, { x: 0, y: 93, w: 108, h: 15 })),
    exact('left of the shape', vt.compare(a, b, { x: 0, y: 50, w: 15, h: 40 })),
  ];
});

check('RF-3', 'A satin finish reflects less than a glossy one', async () => {
  const face = { x: 18, y: 32, w: 72, h: 40 };
  const strength = async (finish) => vt.compare(await vt.render(onGlossy({ material: 'wood', finish }, 1)), await vt.render(onGlossy({ material: 'wood', finish }, 0)), face).mean;
  const gloss = await strength('gloss');
  const satin = await strength('satin');
  return [prop('satin < gloss', satin < gloss && satin > 0, { gloss, satin })];
});

check('RF-4', 'Locking reflections to the light equals setting the light direction by hand', async () => {
  const locked = onGlossy({ material: 'shiny', reflectLock: true }, 1);
  const byHand = onGlossy({ material: 'shiny', reflectX: locked.scene.lightX, reflectY: locked.scene.lightY }, 1);
  return [exact('locked vs same direction', vt.compare(await vt.render(locked), await vt.render(byHand)))];
});

check('RF-5', 'In adaptive layers, a background shape carries the foreground reflections', async () => {
  const face = { x: 18, y: 32, w: 72, h: 40 };
  const layer = async (r) => vt.render(onGlossy({ material: 'shiny' }, r, 'background'), 432, { layer: 'background' });
  return [differs('background layer, reflect 1 vs 0', vt.compare(await layer(1), await layer(0), face), 0.3)];
});

// ---------------------------------------------------------------------------
// VA: variants

check('VA-1', 'Copy to variants with every part makes the target render like the source', async () => {
  const src = vt.pair({ material: 'marble', seed: 9 });
  src.crossings = [{ over: src.shapes[0].id, under: src.shapes[1].id }];
  const dst = structuredClone(src);
  Object.assign(dst.shapes[0], { x: 27, rotation: 12 });
  Object.assign(dst.shapes[0].style, M.materialDefaults('wood'), { material: 'wood' });
  dst.shapes[1].style.color = '#00ff00';
  dst.shapes[1].layer = 'background';
  dst.crossings = [];
  dst.scene.lightX = 1;
  dst.background.color = '#202020';
  dst.shapes.reverse();
  const ids = src.shapes.map((s) => s.id);
  const all = new Set([...M.COPY_SHAPE_PARTS, ...M.COPY_VARIANT_PARTS].map((p) => p.id));
  const full = structuredClone(dst);
  M.copyIntoVariant(src, full, ids, all);
  const lookOnly = structuredClone(dst);
  M.copyIntoVariant(src, lookOnly, ids, new Set(['look']));
  return [
    exact('every part: renders like the source', vt.compare(await vt.render(full), await vt.render(src))),
    prop('look only: keeps its own colors and geometry', lookOnly.shapes.find((s) => s.name === 'B').style.color === '#00ff00' && lookOnly.shapes.find((s) => s.name === 'A').x === 27 && lookOnly.shapes.find((s) => s.name === 'A').style.material === 'marble', lookOnly.shapes.map((s) => `${s.name} ${s.style.material} ${s.style.color} x${s.x}`)),
  ];
});

check('VA-2', 'A duplicated variant renders like the original', async () => {
  const d = M.sampleDocument();
  const copy = M.duplicateVariant(d.variants[0]);
  return [exact('duplicate vs original', vt.compare(await vt.render(copy), await vt.render(d.variants[0])))];
});

// ---------------------------------------------------------------------------
// EX: export

check('EX-1', 'The launcher view is the center 72dp of the whole canvas', async () => {
  const v = M.sampleDocument().variants[0];
  const full = await vt.render(v, 648);
  const crop = document.createElement('canvas');
  crop.width = crop.height = 432;
  crop.getContext('2d').drawImage(full, 108, 108, 432, 432, 0, 0, 432, 432);
  return [near('viewport export vs crop', vt.compare(await vt.render(v, 432, { region: 'viewport' }), crop))];
});

check('EX-2', 'Masks cut the corners and keep the middle', async () => {
  const v = M.sampleDocument().variants[0];
  const out = [];
  for (const mask of ['circle', 'rounded', 'squircle']) {
    const c = await vt.render(v, 512, { mask });
    out.push(prop(mask, vt.pixel(c, 1, 1)[3] === 0 && vt.pixel(c, 106.5, 106.5)[3] === 0 && vt.pixel(c, 54, 54)[3] === 255 && vt.pixel(c, 54, 1)[3] === 255, { corner: vt.pixel(c, 1, 1)[3], center: vt.pixel(c, 54, 54)[3], topMiddle: vt.pixel(c, 54, 1)[3] }));
  }
  const none = await vt.render(v, 512, { mask: 'none' });
  out.push(prop('none keeps the corner', vt.pixel(none, 1, 1)[3] === 255, vt.pixel(none, 1, 1)));
  return out;
});

check('EX-3', 'Adaptive layers split the shapes', async () => {
  const v = vt.pair();
  v.shapes[1].layer = 'background';
  const fg = await vt.render(v, 432, { layer: 'foreground' });
  const bg = await vt.render(v, 432, { layer: 'background' });
  const bgOnly = structuredClone(v);
  bgOnly.shapes = bgOnly.shapes.filter((s) => s.layer === 'background');
  return [
    prop('foreground: no background color', vt.pixel(fg, 1, 1)[3] === 0, vt.pixel(fg, 1, 1)),
    prop('foreground: no background shape', vt.pixel(fg, 54, 22)[3] === 0, vt.pixel(fg, 54, 22)),
    prop('foreground: its own shape', vt.pixel(fg, 30, 54)[3] === 255, vt.pixel(fg, 30, 54)),
    exact('background layer vs only the background shapes', vt.compare(bg, await vt.render(bgOnly, 432))),
  ];
});

check('EX-4', 'Presets and custom sizes list the right files', async () => {
  const d = M.sampleDocument();
  const one = planExport('My Icon', { variants: [d.variants[0]], presets: ['play', 'launcher', 'adaptive'], customSizes: [1024] });
  const paths = one.map((j) => `${j.path}${j.size ? `@${j.size}` : ''}`);
  const want = ['play-store-512.png@512',
    ...[['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]].map(([dn, s]) => `mipmap-${dn}/ic_launcher.png@${s}`),
    ...[['mdpi', 108], ['hdpi', 162], ['xhdpi', 216], ['xxhdpi', 324], ['xxxhdpi', 432]].flatMap(([dn, s]) => [`mipmap-${dn}/ic_launcher_foreground.png@${s}`, `mipmap-${dn}/ic_launcher_background.png@${s}`]),
    'mipmap-anydpi-v26/ic_launcher.xml', 'mipmap-anydpi-v26/ic_launcher_round.xml', 'my-icon-1024.png@1024'];
  const all = planExport('My Icon', { variants: d.variants, presets: ['play'], customSizes: [] }).map((j) => j.path);
  const sizes = parseCustomSizes('64, 128;128 8 5000 2048');
  return [
    prop('one variant, every preset + 1024', JSON.stringify(paths) === JSON.stringify(want), paths),
    prop('all variants go in one folder each', all.length === d.variants.length && new Set(all.map((p) => p.split('/')[0])).size === d.variants.length, all),
    prop('custom sizes: 16-4096, no repeats', JSON.stringify(sizes) === JSON.stringify([64, 128, 2048]), sizes),
  ];
});

// ---------------------------------------------------------------------------
// IM: VectorDrawable import

check('IM-1', 'Imported shapes cover exactly what the drawing covers', async () => {
  const text = await (await fetch('/tests/import-fixture.xml')).text();
  const { shapes, guide, skipped } = importVectorDrawable(text, 'import-fixture.xml');
  const g = document.createElement('canvas').getContext('2d');
  // The drawing's paths that became shapes: all but the two skipped ones at the end.
  const drawn = guide.paths.slice(0, guide.paths.length - 2);
  const inDrawing = (x, y) => drawn.some((p) => {
    const path = new Path2D(p.d);
    if (p.stroke) {
      g.lineWidth = p.stroke;
      return g.isPointInStroke(path, x, y);
    }
    return g.isPointInPath(path, x, y, p.evenOdd ? 'evenodd' : 'nonzero');
  });
  let wrong = 0;
  let n = 0;
  for (let y = 0.1; y < 108; y += 0.4) {
    for (let x = 0.1; x < 108; x += 0.4) {
      n++;
      if (inDrawing(x, y) !== shapes.some((s) => M.insideShape(s, { x, y }))) wrong++;
    }
  }
  const names = shapes.map((s) => s.name);
  return [
    prop('coverage matches (≤ 0.2% of samples off, on edges)', wrong / n <= 0.002, `${wrong} of ${n} samples differ`),
    prop('the # becomes four bars', names.filter((s) => s.startsWith('hash')).length === 4, names),
    prop('frame and stroked ring become hollow', shapes.filter((s) => s.wall > 0).map((s) => `${s.name} wall ${s.wall}`).join(', ') === 'frame wall 4, stroked-ring wall 3', shapes.filter((s) => s.wall > 0).map((s) => s.name)),
    prop('alpha comes along', shapes.find((s) => s.name === 'circle').style.opacity === 0.5, shapes.find((s) => s.name === 'circle').style.opacity),
    prop('curve and open stroke are reported as skipped', JSON.stringify(skipped) === JSON.stringify(['curve', 'open-stroke (stroke)']), skipped),
  ];
});

// ---------------------------------------------------------------------------

function summary(parts) {
  if (parts.some((p) => p.pass === false)) return 'FAIL';
  if (parts.every((p) => p.pass === null)) return 'SKIP';
  return 'PASS';
}

vt.checks = checks;

vt.run = async (id) => {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  const parts = await c.run();
  console.log(`${c.id} ${summary(parts)}: ${c.title}`);
  console.table(parts.map((p) => ({ part: p.label, result: p.pass === null ? 'skip' : p.pass ? 'pass' : 'FAIL', value: JSON.stringify(p.value) })));
  return { id: c.id, result: summary(parts), parts };
};

vt.runAll = async (prefix = '') => {
  const rows = [];
  for (const c of checks.filter((x) => x.id.startsWith(prefix))) {
    const t = performance.now();
    let parts;
    try {
      parts = await c.run();
    } catch (err) {
      parts = [prop('threw', false, String(err))];
    }
    const failed = parts.filter((p) => p.pass === false).map((p) => p.label);
    rows.push({ id: c.id, result: summary(parts), title: c.title, failed: failed.join('; '), ms: Math.round(performance.now() - t) });
  }
  console.table(rows);
  return rows;
};

// Renders a material's test tile and downloads it as its reference image.
// Look at it first (vt.show), then move the file to captures/golden/.
vt.approve = async (id) => {
  const c = await vt.render(vt.tile({ material: id }));
  vt.show(c);
  vt.save(c, `MT-${id}.png`);
};

export default vt;
