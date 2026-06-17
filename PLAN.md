# Icon Composer — Design Plan

A tool to load vector artwork (SVG or Android VectorDrawable XML), give it a **subtle 3D emboss** look using a movable light, and export the result. Inspired by the layered/lit feel of macOS Tahoe / Golden Gate "Icon Composer", but constrained so the styled icon can be exported back as a valid **Android VectorDrawable**.

---

## 1. Goal & scope

- **Input:** an SVG or Android VectorDrawable XML (path-based vector artwork).
- **Editing:** choose a color per path, choose the effect applied to each path, and position a single light source freely — the icon's shading and shadows react live.
- **Look:** subtle 3D emboss (directional shading + soft cast shadow). **Not** liquid glass / refraction.
- **Outputs:**
  - PNG with transparent background
  - PNG with a chosen background color
  - Android VectorDrawable XML (icon only)
  - The full editable project model (for re-import / sharing)

---

## 2. The hard constraint: VectorDrawable

VectorDrawable is essentially **paths + gradients + alpha, and nothing else.**

**Supported**
- `<path>` with `pathData`, `fillColor`, `strokeColor`/`strokeWidth`, `fillAlpha`, `fillType` (evenOdd/nonZero)
- Gradient fills — `linear`, `radial`, `sweep` — via `<aapt:attr name="android:fillColor"><gradient>…</gradient></aapt:attr>`, multi-stop `<item offset color>`, colors as `#AARRGGBB` (stops can be semi-transparent)
- `<group>` transforms (rotate/scale/translate/pivot), `<clip-path>`

**NOT supported**
- ❌ Blur / Gaussian blur
- ❌ Filters (no SVG `feGaussianBlur`, `feSpecularLighting`, etc.)
- ❌ Real drop/inner shadow primitives
- ❌ Blend modes, alpha masks (clip-path is hard geometry, and is *aliased*)

**Implication:** there is no "real" shadow or blur. Everything ships as filled shapes + gradients. The target aesthetic must be **subtle** (gradient shading + gradient-faked shadow), which is exactly what we want.

### Notes / gotchas
- **Target `minSdk` 24+ (decided).** Inline `<aapt:attr>` gradients work natively at API 24+, so no `VectorDrawableCompat` / `app:srcCompat` path is needed.
- `clip-path` edges are aliased → prefer baking a highlight as its own closed path rather than clipping.

---

## 3. Effects as VectorDrawable-native techniques

| Effect | How it's done in VD |
| --- | --- |
| **Bevel / emboss** (core) | Diagonal **linear gradient** on the fill (light side bright → far side dark). |
| **Spherical / lit body** | **Radial gradient** with an off-center bright spot. |
| **Metallic sheen** | **Sweep gradient**. |
| **Gloss highlight** | Separate path filled white→transparent, on the lit side (baked as its own path). |
| **Drop shadow** | Offset duplicate of the silhouette, filled black→transparent gradient, offset opposite the light. |
| **Softer shadow** (advanced, opt-in) | Stacked concentric offset paths with decreasing alpha (bigger XML). |

---

## 4. The two-model architecture (the spine)

Split into an **authoring model** (what the user edits) and a **derived model** (flat list of paths + gradients that gets rendered/exported). One derivation function turns the first into the second; all three render targets (live preview, PNG, VD) are renderers of the same derived result → **WYSIWYG for free.**

```
authoring model ── derive() ──▶ derived model (paths + gradients)
                                   ├──▶ live SVG preview
                                   ├──▶ PNG (raster)
                                   └──▶ VectorDrawable XML (serialize)
```

### Authoring model
```
Document
  canvas
    width, height            // dp + viewport units (e.g. 24 / 108 / 1024)
    exportBackground         // transparent | {color}
  light                      // ONE scene light, shared by everything
    type                     // point | distant
    position | azimuth       // point: x,y over canvas;  distant: angle
    elevation                // 0 = raking/low, 90 = overhead
    intensity                // strength of highlight/shadow
    color                    // usually white; tintable
  layers[]   (bottom → top, = paint order)
    Layer
      id, name, visible
      pathData               // the SVG/VD path string
      material
        baseColor
        fillMode             // solid | embossed
        embossIntensity      // per-layer multiplier on the light
        sheen                // off | {strength}
      castsShadow            // off | {opacity, spread}
      transform              // optional group rotate/scale/translate
```

The entire surface the user touches: **one light**, and per layer a **color + a couple of effect knobs.**

---

## 5. Light → gradient derivation

Resolving the tension between "a movable light" and "VD has no lighting": the light is defined so its position maps directly onto exportable gradient attributes.

- **Point light** → `radial` gradient; light handle position = gradient `centerX/centerY`. Dragging the light literally edits the exported attribute.
- **Distant light** → `linear` gradient; azimuth = gradient angle.
- **Elevation** → contrast + cast-shadow length (low = high contrast + long shadow; overhead = flat + short).
- **Cast shadow** → offset duplicate path, offset opposite the light.

Each **embossed** layer expands (bottom → top) into 1–3 real VD paths:
1. **Cast shadow** (if enabled) — clone offset opposite the light, black→transparent gradient.
2. **Lit fill** — `pathData` with the light-derived gradient; highlight = `mix(baseColor, white, k)`, shadow = `mix(baseColor, black, k)`, where `k = intensity × embossIntensity`.
3. **Sheen** (if enabled) — white→transparent overlay on the lit side.

A **solid** layer emits one flat-`fillColor` path.

**Coherent lighting:** gradient geometry lives in **shared canvas/viewport space** (not per-layer bounds), so every layer references the same light center/angle — one light, not one-per-shape — while still being valid VD (same viewport coordinates).

### Fidelity decision (chosen)
**Gradient-only emboss** → preview, PNG, and VD are **pixel-identical**. (A richer filter-based PNG-only emboss with true bevel/rim lighting is a possible later option, but it makes VD a lossy approximation — deferred.)

---

## 6. Editor layout

```
┌──────────────────────────────────────────────────────────────┐
│  [Import]            Icon Composer            [Export ▾] ⟲ ⟳   │
├────────────┬─────────────────────────────┬───────────────────┤
│ LAYERS     │                             │ INSPECTOR         │
│            │      ▒▒▒▒▒▒▒▒▒▒▒▒▒           │ (layer selected)  │
│ ◉ glyph    │      ▒▒  ☀ ←light handle     │  Base color  [■]  │
│ ◉ plate    │      ▒▒▒▒▒▒▒▒▒▒▒▒▒           │  Fill   ○solid    │
│ ◉ shadow   │   (checkerboard = transp.)   │         ●embossed │
│            │                             │  Emboss   ▭▭▭○──   │
│ + reorder  │   live preview, light is     │  Sheen    [ ]     │
│   hide     │   draggable on canvas        │  Shadow   [✓] ▭○─ │
│            │                             │ ───────────────── │
│            │                             │ (no selection →   │
│            │                             │  Light + Canvas)  │
└────────────┴─────────────────────────────┴───────────────────┘
```

- **Left — Layers:** paint-order list; reorder / rename / hide; import adds shapes.
- **Center — Canvas:** live icon over checkerboard (transparent) or chosen bg color, with a **draggable light handle**; elevation via slider or ring around the handle.
- **Right — Inspector (context-sensitive):**
  - *Layer selected* → Material: base color, solid/embossed, emboss intensity, sheen, cast-shadow + opacity/spread.
  - *Nothing selected* → Scene: Light (type, azimuth/position, elevation, intensity, color) and Canvas (size, export background).
- **Top bar:** Import, three-way Export dropdown, undo/redo.

---

## 7. File operations — three distinct verbs

Disentangle these, since "VectorDrawable" appears on both input and output:

1. **Import shape** — bring SVG/VD *geometry* in as new layers (dumb paths; then assign material).
2. **Open / Save project** — full authoring-model round-trip; reopens **fully editable**.
3. **Export asset** — flattened output (PNG×2 or VD) with light/emboss **baked in**.

⚠️ An **exported** VectorDrawable is *not* a project file. Re-importing it gives baked, multiplied paths as flat geometry — light/materials gone. **To keep editing, save/share the project file.**

---

## 8. Project file (save / share the model)

The authoring model is pure data (no linked rasters/fonts) → **one self-contained JSON file**.

```
{
  "format": "icon-emboss",     // magic id — reject anything else on import
  "schemaVersion": 1,          // bump when model changes; migrate on load
  "app": "1.2.0",              // build that wrote it (debugging)
  "name": "settings-icon",
  "document": { canvas, light, layers[...] }
}
```

- **Versioning:** on load, check magic → migrate from file's `schemaVersion` up to current → ignore unknown fields, default missing ones. Distinguish wrong-format vs. older-but-migratable.
- **Sharing:** the file is enough (plain JSON: email/Slack/git-friendly, diffable, inspectable).
- **Optional (web only) share-by-link, no backend:** gzip + base64 the `document` into the URL fragment (`#doc=…`); works for small/medium icons, fall back to file download past safe URL length. Guaranteed links need a tiny paste/storage backend.

### UI placement
- **File:** New · Open project · Save / Save As · (Share link)
- **Import:** Add shape (SVG / VD geometry)
- **Export ▾:** PNG transparent · PNG with bg color · VectorDrawable

"Save" preserves editability; "Export" produces deliverables; "Import" only adds geometry.

---

## 9. Stack & tech (decided)

- **Platform:** **pure web** — a browser app. No desktop shell. File access is upload/download via the File API + download links. (Share-by-link via URL fragment, Section 8, fits naturally.)
- **Tooling:** **zero build** — `index.html` + CSS + plain **ES modules**, served by any static server. Nothing to install or configure.
- **Framework:** **none (vanilla HTML/CSS/JS).** The app is "one model → `derive()` → render one SVG," which is a modest reactivity need that maps cleanly to plain JS.

**How vanilla maps to the architecture**
- **Model:** a plain JS object (the authoring model, Section 4).
- **`derive()`:** plain function, model → array of paths + gradients (Section 5).
- **Preview:** `derive()` → build SVG string → `previewContainer.innerHTML = svg`; re-run on any change (an icon is a few paths → effectively free). Same string-building the export needs → preview and VD export are two serializers of one derived model.
- **Controls (free from the browser):** `<input type="color">` for colors, `<input type="range">` for emboss/elevation/intensity, pointer events for the draggable light handle.
- **State + render loop:** global `state` object; mutate on input → call one `render()`.
- **Undo/redo:** `structuredClone(state)` onto a stack.
- **Save:** `JSON.stringify(state)`; open: parse + validate (Section 8). The store *is* the project file.
- **Faithfulness rule:** preview SVG uses `gradientUnits="userSpaceOnUse"` and only VD-supported path commands/gradient features → preview == VD export.

**File layout (ES modules, no bundler)**
```
index.html · styles.css
model.js       // authoring model + defaults + validation/migration
derive.js      // authoring model → derived paths+gradients (light math)
svg.js         // derived model → SVG string (preview)
export-vd.js   // derived model → VectorDrawable XML
export-png.js  // SVG string → Image → canvas → toBlob (+ bg fill)
import.js      // SVG / VD parse → layers (flatten transforms)
ui.js          // panels, inputs, light-handle drag, render loop
color.js       // OKLCH-ish mix(base, white/black, k)  (optional: culori)
```

## 10. Build order

1. **Spine:** `index.html` + model types + a hardcoded sample doc → `derive()` → SVG preview. (De-risks the core first.)
2. **`derive()` engine:** light → gradients + shadow paths; shared scene-light geometry.
3. **Editor UI:** layer list, inspector (color + material knobs), draggable light handle, live `render()`.
4. **Import:** SVG + VD parsing → layers (flatten transforms).
5. **Exports:** VD serializer, then PNG (transparent + bg) via canvas.
6. **Project file:** save/open JSON + `schemaVersion` migration + undo/redo.
7. **Polish:** share-by-link, multi-resolution PNG, advanced stepped shadow.

**Decided:** `minSdk` 24+ (inline gradients, no compat layer). Layered, per-layer shading with one shared light (already in the model).

## 11. Open decisions / TBD

- **PNG export resolution(s)** — single size vs. density set (mdpi → xxxhdpi).
- Whether to offer the richer PNG-only filter emboss later (Section 5 fidelity note).

---

## 12. `derive()` light math

The core engine: authoring model (one light + per-layer materials) → flat list of paths + gradients.

### Conventions
- **Coordinates:** SVG/VD viewport space, origin top-left, **x → right, y → down**. All gradient geometry in `userSpaceOnUse` (absolute), shared across layers so the light stays coherent.
- **Light inputs:** azimuth **φ** (direction light comes *from*, clockwise from top), elevation **θ** (0° grazing → 90° overhead), `intensity`; point light also has position **L = (lx, ly)**.
- **Toward-light unit vector:** `f = (sin φ, −cos φ)` → φ=0 up `(0,−1)`, φ=90° right `(1,0)`, φ=180° down. Lit side faces **+f**, shadow side **−f**.
- **Contrast factor:** `c = intensity · embossIntensity · cos θ` (low light → max contrast; overhead → flat). Drives overall emboss strength.

### Distant light → `linear` gradient
With shape/canvas center **C** and half-extent **R** (bbox projected onto **f**):
- `dark end P0 = C − f·R`, `bright end P1 = C + f·R` → SVG `x1,y1 / x2,y2` (VD `startX/Y / endX/Y`).
- stops: `0.0` → `mix(base, black, kLo)`; `0.5` → `base` (terminator); `1.0` → `mix(base, white, kHi)`.
- `kHi = c · aHi`, `kLo = c · aLo`; shadows slightly stronger (`aHi≈0.6, aLo≈0.9`) reads more natural.

### Point light → `radial` gradient
- `center = L` (literally the VD `centerX/centerY` — dragging the handle edits the export).
- `radius r = R · (0.5 + 0.7·sin θ)` (low light = tight hotspot; overhead = broad/soft).
- stops: `0.0` → `mix(base, white, kHi)` at center; `1.0` → `mix(base, black, kLo)` at rim.

### Cast shadow (if enabled) — drawn underneath
- direction: distant → `−f`; point → `normalize(C_shape − L)`.
- length: `len = clamp(K · cot θ, 0, maxLen)` (grazing = long, overhead ≈ 0).
- fill: offset clone of the path, gradient `rgba(0,0,0, shadow.opacity)` → `#00000000` along the offset; `shadow.spread` = fade length (the only "softness" knob in pure VD).

### Sheen (optional) — drawn on top
- path filled white→transparent biased to the lit side (`+f` for distant, toward `L` for point), low coverage. Bake as its own path (VD `clip-path` is aliased).

### Color mixing
- do `mix(base, white/black, k)` in **OKLCH** (`color.js` / `culori`), not sRGB → perceptually even ramp, not muddy/chalky.

### Per-layer expansion order (bottom → top)
`[offset shadow path + fade gradient]` → `[fill path + linear/radial light gradient]` → `[optional sheen path]`, all sharing the one light's geometry. A **solid** layer emits one flat-`fillColor` path.

---

## 13. Import parser

### Unifying insight
Both SVG and VectorDrawable reduce to the same intermediate — a flat, ordered list of `{ rawPathData, transformMatrix, fill, fillRule, stroke? }`. Design = **format-specific front-end → one shared back-end**:

```
SVG DOM walk ─┐
              ├─▶ [ {dRaw, matrix, fill, fillRule, stroke}, … ] ─▶ normalize+bake ─▶ layers[]
VD DOM walk ──┘
```

The shared back-end is the reusable, riskiest heart — build and test it first (Material icons for SVG; Asset Studio exports for VD).

### Shared back-end (both formats)
1. **Normalize each `d` to absolute `M / L / C / Z`** — relative→absolute, `H/V`→`L`, `S/T/Q`→`C`, **arcs `A`→cubic béziers**. Béziers are closed under affine transforms, which makes step 2 trivial.
2. **Bake the transform matrix into coordinates** — compose element + ancestor-group matrices into one 2×3 affine, multiply every point. **Must bake (not preserve)** because VD `<group>` supports only translate/scale/rotate/pivot — **no skew / general matrix** — so a sheared SVG can't be a VD group. (Model `transform` is reserved for user-applied rotate/scale later, not import fidelity.)
3. **Resolve fill → `baseColor`**, map `fill-rule`↔`fillType` (evenodd ↔ nonZero), fold `opacity`/`fill-opacity` into color alpha.
4. Emit `layers[]` in **document order = paint order**; name from `id`/class or `Layer N`; set **canvas viewport** from the source.

### SVG front-end
- `DOMParser(…, 'image/svg+xml')`, walk the tree.
- **Shapes → paths:** `<rect>` (incl. `rx/ry`), `<circle>`, `<ellipse>`, `<line>`, `<polyline>`, `<polygon>`.
- **Fill resolution (sneaky):** can be presentation attr, inline `style`, or `<style>` classes → insert into an offscreen DOM and read **`getComputedStyle(el).fill`** (resolves classes/inheritance/`currentColor`). `url(#grad)` → fall back to default base color or first stop.
- **`viewBox`** → canvas viewport; nonzero `minX/minY` → baked translate.
- **`<use>`/`<symbol>`/`<defs>`** → resolve `<use href="#id">` by cloning target with its transform/x/y.

### VD front-end
- `DOMParser(…, 'application/xml')`. **Namespaces:** `android:` = `http://schemas.android.com/apk/res/android`, `aapt:` = `http://schemas.android.com/aapt`; read via `getAttributeNS(ANDROID_NS, …)`.
- **`<vector viewportWidth/Height>`** → canvas viewport (`width/height` are dp display size only).
- **`<path android:pathData>`** → same command set as SVG → shared normalizer.
- **`fillColor`** `#RGB/#ARGB/#RRGGBB/#AARRGGBB` → `baseColor`; `@color/…` / `?attr/…` refs **can't resolve** → default + warn.
- **`<group>`** rotation/scale/translate/pivot → matrix chain (nests).
- **`<aapt:attr name="android:fillColor"><gradient>`** → discard source gradient (user re-applies); optionally seed `baseColor` from a stop.

### Build vs. vendor
Zero-build, but **vendor one ES module: `svgpath` (MIT)** — does relative→absolute, `arc→curve`, and `matrix()` in one (steps 1–2). Hand-rolling is feasible (only arc→bézier is non-trivial, ~40 lines). Computed-style fill trick stays pure-browser.

### Stroke handling (decided): **preserve stroke as-is, un-embossed**
- Stroke-only / outline icons are common, so v1 keeps them rather than skipping.
- **Model extension:** `Layer.material` gains optional `stroke { color, width, cap, join }`, and `fill` may be `none`. Stroked layers render as a plain stroked path (passthrough) and are **excluded from the emboss/shadow derivation** — the light affects fills only. (Outlining stroke→fill for embossing is deferred.)

### v1 scope / limitations (declare up front)
- `clipPath` / `mask` / SVG filters — ignored.
- `<text>` — unsupported (needs font outlining); skip + warn.
- Source gradients — discarded (optional baseColor seed).
- `@color/…` / `?attr/…` refs — default color + warn.
- preserveAspectRatio / non-uniform viewBox — assume uniform.
- **Round-trip sanity:** feed imported layers into the same `svg.js` renderer to confirm.

---

## 14. Export (VD serializer + PNG)

### VD serializer (`export-vd.js`)
Input: the **derived** model (flat paths + gradients) + canvas viewport. Output: a `<vector>` string.

```xml
<vector xmlns:android="http://schemas.android.com/apk/res/android"
        xmlns:aapt="http://schemas.android.com/aapt"
        android:width="24dp" android:height="24dp"
        android:viewportWidth="24" android:viewportHeight="24">
  <path android:pathData="…">
    <aapt:attr name="android:fillColor">
      <gradient android:type="linear"
          android:startX="…" android:startY="…" android:endX="…" android:endY="…">
        <item android:offset="0"   android:color="#FF1A1A1A"/>
        <item android:offset="0.5" android:color="#FF808080"/>
        <item android:offset="1"   android:color="#FFFFFFFF"/>
      </gradient>
    </aapt:attr>
  </path>
</vector>
```

- **Root:** emit `xmlns:aapt` only when a gradient exists. `viewportWidth/Height` **must equal the coordinate system `derive()` emitted geometry in** (whole pipeline uses `userSpaceOnUse`, so gradient coords map 1:1, no transform). `width/height` (dp) = display size only.
- **Fill per path:** solid → `android:fillColor="#AARRGGBB"`; gradient → `<aapt:attr>` child block.
- **Gradient attrs by type:** linear → `startX/startY/endX/endY`; radial → `centerX/centerY/gradientRadius`; sweep → `centerX/centerY`. Always the `<item offset color>` form (3-stop emboss ramp). `tileMode` defaults to clamp → omit.
- **Color format — classic bug:** Android is **`#AARRGGBB` (alpha first)**, not `#RRGGBBAA`. Resolve OKLCH→sRGB, clamp/round 0–255, alpha leading.
- **Stroke passthrough:** `android:strokeColor/strokeWidth/strokeLineCap/strokeLineJoin`; stroke-only layers omit `fillColor`.
- **`fillType`:** emit `evenOdd` only when needed (nonZero is default).
- **Precision:** round coords to ~2–3 decimals, trim trailing zeros (constant). Build string by hand, XML-escape values, pretty-print (it's a committed source asset). Paths in **paint order**. **No background** (icon only; transparent is VD-native).

### PNG export (`export-png.js`)
Pipeline: **SVG string → `Image` → `<canvas>` → `toBlob`**.
1. Emit a **standalone** SVG (via `svg.js`): `xmlns="http://www.w3.org/2000/svg"` **plus explicit `width`/`height`** in target px, with artwork `viewBox` underneath — `<svg xmlns=… width="1024" height="1024" viewBox="0 0 24 24">`.
2. `Blob([svg],{type:'image/svg+xml'})` → `createObjectURL` (beats data URI) → `img.src`, **await `onload`**, then `revokeObjectURL`.
3. `<canvas>` at target px, 2D ctx. Background: chosen color → `ctx.fillRect` first; transparent → skip.
4. `drawImage(img,0,0,w,h)` → `canvas.toBlob(cb,'image/png')` (async) → download via `<a download>`.

**Gotchas:** no taint (pure inline vector); **explicit SVG `width`/`height` is the #1 trap** (without it the `Image` rasterizes at viewBox size or 0); inline all gradients/colors (external CSS won't apply during rasterization); exact output dims (ignore `devicePixelRatio`); multiple sizes = loop the pipeline.

---

## 15. UI / render loop (`ui.js`)

### One-way data flow
`input event → mutate state → render() → DOM`. One direction. Discipline that keeps vanilla clean:
- **Two kinds of DOM:**
  - **Derived views** (SVG preview, layer list) — *rebuilt* from state each render (`innerHTML` from `svg.js`). Cheap; no interactive state inside.
  - **Controlled inputs** (color pickers, sliders) — **built once at init with listeners; render only updates `.value`, never recreates them.** Recreating kills focus, interrupts drags, closes color pickers (classic vanilla bug).
- **rAF batching:** changes call `scheduleRender()` → set dirty flag + request one animation frame → real `render()` runs ≤ once/frame. Coalesces slider-drag event storms → smooth 60fps.

### Persisted vs. ephemeral state
```
appState = {
  document,              // authoring model — saved + undone
  ui: { selectedLayerId, dragging, … }   // ephemeral — NOT saved, NOT undone
}
```
`Save` serializes `document` only (§8); undo snapshots `document` only. Keeping UI state out of the document keeps the project file and undo logic trivial.

### Draggable light handle (signature interaction)
- **Own overlay element above the preview**, NOT inside the rebuilt SVG (else `innerHTML` rebuild mid-drag destroys it).
- **Pointer events + `setPointerCapture`** on `pointerdown`; `pointermove` updates light; `pointerup` ends. Capture = drag survives leaving the handle.
- **Screen→viewport:** `vx = (clientX − rect.left)/rect.width × viewportWidth` (from preview `getBoundingClientRect()`).
- **Gesture mapping:** point light → handle position = `light.position` (= radial `centerX/centerY`) + elevation slider; distant light → one handle: **angle** around center = `azimuth`, **distance** from center = `elevation` (center = overhead, rim = grazing).
- Each move → mutate `light` → `scheduleRender()`; fills + cast shadows swing live.

### Undo/redo
- `structuredClone(document)` → `undoStack`; parallel `redoStack`; cap ~100. Small JSON → full snapshots beat command/diff.
- **Granularity = per gesture, not per micro-event.** `beginChange()` on `pointerdown`/focus captures pre-edit document; `commitChange()` on `pointerup`/`change` pushes it + clears redo. (`input` drives live preview; commit on release.)
- Undo: pop `undoStack` → push current to `redoStack` → set document → render. Redo symmetric. Bind `Ctrl/Cmd+Z`, `Ctrl+Shift+Z`.

### Panel wiring (plumbing)
- **Layer list:** click selects (`ui.selectedLayerId`); reorder/hide/delete/rename mutate `document` → commit → render.
- **Inspector:** inputs bound to selected layer's material; `input` → mutate + `scheduleRender`, commit on `change`/blur.
- **Scene panel** (nothing selected): light type/azimuth/elevation/intensity/color + canvas size/bg.
- **Init:** load sample doc → build static panel DOM + listeners once → `render()`.
```
