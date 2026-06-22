# Icon Recomposer — Project File Format Specification

> Audience: a code-generating agent that must **produce** a valid `.json` project
> file or **modify** an existing one. This is the contract enforced by
> `model.js` (`parseProject` / `normalizeDocument`) and consumed by `derive.js`.
> Authoritative source: `model.js`. Current `schemaVersion`: **2**.

---

## 1. What the file is

A single UTF-8 JSON document. Extension `.json`. It fully describes one icon:
a shared scene light plus an ordered stack of vector layers. Opening it
**replaces** the in-app document (vs. *Import*, which appends raw geometry).

The same payload is also used for share-by-link: `wrapProject(...)` JSON →
base64url → URL fragment `#doc=…`. Generators don't need to do the base64 step;
produce the JSON.

---

## 2. Top-level envelope (required)

```jsonc
{
  "format": "icon-emboss",   // REQUIRED, must equal this exact string or open fails
  "schemaVersion": 2,         // 1 or 2 accepted; >2 is rejected as "newer version"
  "app": "1.7.2",            // informational only (the app version that wrote it)
  "name": "icon",            // document name; drives export filenames; defaults to "icon"
  "document": { /* see §3 */ }
}
```

Rules enforced by `parseProject`:
- `format` **must** be `"icon-emboss"` exactly, else: *"Not an Icon Recomposer project."*
- `schemaVersion` greater than `2` is rejected. Missing → treated as `1`. A `1`
  document loads fine (v1→v2 is purely additive: missing `material.gradient`
  becomes `null`).
- `app` is never validated; set it to any version string (or omit).
- Anything else at the top level is ignored.

Everything inside `document` is **coerced, not rejected** — unknown keys are
dropped, missing keys get defaults, wrong types fall back. So a partial document
still loads. But to be correct, follow the shapes below.

---

## 3. `document`

```jsonc
{
  "canvas": { /* §4 */ },
  "light":  { /* §5 */ },
  "layers": [ /* §6 — ordered bottom → top */ ]
}
```

Layer order is paint order: `layers[0]` is the bottom, the last entry is on top.
Shadows from a layer fall on the filled layers **below** it.

---

## 4. `canvas`

```jsonc
{
  "width": 108,
  "height": 108,
  "viewportWidth": 108,      // THE coordinate space all path/geometry coords live in
  "viewportHeight": 108,
  "exportBackground": { "transparent": true, "color": "#ffffff" },
  "pngSize": 1024            // px, the exported PNG's longest side; min 16
}
```

- **`viewportWidth` / `viewportHeight` define the coordinate system.** Every
  `pathData` coordinate, `light.position`, and gradient geometry value is in this
  space. Default `108×108` matches the Android adaptive-icon canvas — keep it
  unless you have a reason not to. `width`/`height` are the document's nominal
  size and normally equal the viewport.
- `exportBackground.color` is a web `#rrggbb` color (no alpha). Used only when
  `transparent` is `false`.
- Missing fields are filled from these defaults; the whole object may be omitted.

---

## 5. `light` (one shared scene light)

```jsonc
{
  "type": "point",                 // "point" | "distant" | "off"
  "position": { "x": 38, "y": 30 },// viewport coords; = radial-gradient CENTER for point lights
  "azimuth": 135,                  // 0..360 deg, direction light comes FROM, clockwise from top
  "elevation": 55,                 // 0..90 deg; 0 = grazing/long shadow, 90 = overhead/flat
  "intensity": 1.0,                // 0..2
  "color": "#ffffff"               // stored; renderer currently mixes toward pure white/black
}
```

Semantics (from `derive.js`):
- **`type: "point"`** → emboss uses a **radial** gradient centered at
  `position`. `position` is the meaningful control.
- **`type: "distant"`** → emboss uses a **linear** gradient whose angle comes
  from `azimuth`; `position` is ignored. `elevation` sets shadow length
  (`cot(elevation)`); the renderer clamps elevation to `[1, 89]`.
- **`type: "off"`** → no lighting: embossed fills render flat at base color,
  sheen and cast shadows are suppressed.
- `intensity` range is `0..2` (the engine treats `2` as the max). Higher pulls
  the shadow plateau toward the canvas center.

---

## 6. `layers[]` — one layer

```jsonc
{
  "id": "layer-ab3-1",      // string, MUST be unique within the doc (auto-regenerated if missing/dup)
  "name": "Plate",
  "visible": true,           // false = skipped in all renderers
  "pathData": "M8 32 ...Z", // SVG path string in viewport space (§10)
  "fillRule": "nonZero",    // "nonZero" | "evenOdd"
  "material":   { /* §7 */ },
  "castsShadow":{ /* §8 */ },
  "transform":  null         // null or §9
}
```

- **`id`** must be unique. Selection filters layers by id, so duplicates break the
  app — `normalizeDocument` regenerates any missing/duplicate id, but a generator
  should emit distinct ids (any string; e.g. `"layer-1"`, `"plate"`).
- **`pathData`** is the original, untransformed geometry. Leave it as the source
  path and express moves/scales/flips via `transform` (§9) — `derive()` bakes the
  transform into the coords at render time; `pathData` stays canonical.
- `fillRule` other than `"evenOdd"` becomes `"nonZero"`.

---

## 7. `material`

```jsonc
{
  "baseColor": "#2563eb",       // web #rrggbb (NO alpha); truncated to 7 chars on load
  "fillAlpha": 1,                // 0..1 — the layer fill's opacity
  "fillMode": "solid",          // "solid" | "embossed" | "gradient"  (default "solid")
  "embossIntensity": 1.0,        // 0..2 — only used when fillMode = "embossed"
  "sheen": { "enabled": false, "strength": 0.35 },  // strength 0..1; embossed layers only
  "stroke": null,                // null OR { color, width, cap, join } — §7.1
  "fillNone": false,             // true = stroke-only layer (no fill; doesn't catch shadows)
  "gradient": null               // null OR §7.2 — only used when fillMode = "gradient"
}
```

`fillMode` decides which fill path runs:
- **`"solid"`** (default) → flat `baseColor` at `fillAlpha`. New/imported art is solid.
- **`"embossed"`** → the 3D emboss gradient driven by the shared light. Opt-in.
  `embossIntensity` (0..2) scales the effect; `sheen` adds a white hotspot on top.
- **`"gradient"`** → a literal user gradient fill (§7.2); emboss is **not** applied
  to that layer. To get emboss *and* a gradient, stack two layers with the same
  `pathData`.

**Color rule:** `baseColor` and all gradient stop colors are stored as `#rrggbb`
(web order, 6 hex digits, **no alpha**). Opacity lives in `fillAlpha` and per-stop
`alpha`. The `#AARRGGBB` alpha-first ordering is an Android *VectorDrawable export*
concern only — never put it in the project file.

### 7.1 `stroke`

```jsonc
{ "color": "#000000", "width": 2, "cap": "butt", "join": "miter" }
```
- `width` is in viewport units, base value (it gets scaled by any layer transform
  at render time).
- `cap`: `"butt"` | `"round"` | `"square"` (default `"butt"`).
- `join`: `"miter"` | `"round"` | `"bevel"` (default `"miter"`).
- Strokes are passthrough — never embossed.

### 7.2 `gradient` (user gradient fill)

```jsonc
{
  "type": "linear",          // "linear" | "radial"  (sweep/conic NOT supported)
  "x1": 8, "y1": 54, "x2": 100, "y2": 54,   // linear endpoints (local/pathData space)
  "cx": 54, "cy": 54, "r": 46,               // radial center + radius (local space)
  "stops": [
    { "offset": 0, "color": "#2563eb", "alpha": 1 },
    { "offset": 1, "color": "#ffffff", "alpha": 1 }
  ]
}
```
- **Geometry is in the layer's local (pre-transform `pathData`) space** and is
  baked by the layer's `transform` at render time, so it tracks move/scale/flip.
- `type` must be `"linear"` or `"radial"`. Linear reads `x1,y1,x2,y2`; radial reads
  `cx,cy,r`. Include both sets (the unused one is harmless) or just the relevant one.
- **`stops`: minimum 2.** Each: `offset` 0..1 (sorted ascending on load), `color`
  `#rrggbb`, `alpha` 0..1. Fewer than 2 valid stops → the whole gradient becomes
  `null` and the layer falls back to solid.

---

## 8. `castsShadow`

```jsonc
{
  "enabled": false,       // master switch
  "opacity": 0.35,        // 0..1 — shadow darkness at the object edge
  "spread": 0.4,          // 0..1 — how far the shadow fades out (softness)
  "distance": 1,          // 0..3 — multiplies the auto throw length (apparent height)
  "clipToLayers": true    // clip the shadow to the union of FILLED layers below
}
```
- A cast shadow is an offset clone of the path with a fading black gradient.
- With `clipToLayers: true` (default), the shadow only shows where it lands on a
  layer below. **A bottom-most layer therefore casts no visible shadow** — there's
  no surface beneath it. Set `false` to let it fall on the background.
- Suppressed entirely when `light.type` is `"off"`.

---

## 9. `transform` (non-destructive move / scale / flip)

```jsonc
{
  "translateX": 0, "translateY": 0,
  "rotation": 0,                 // degrees
  "scaleX": 1, "scaleY": 1,      // negative = flip on that axis
  "pivotX": 0, "pivotY": 0       // pivot for rotation/scale (viewport coords)
}
```
- `null` means identity (no transform). All seven fields must be numeric; any
  NaN/non-number falls back to its default (`0`, or `1` for scales).
- Applied (matching VD `<group>` order) as: scale → rotate → translate, about the
  pivot. The matrix bakes into path coords, scales stroke width, and scales the
  radial-gradient radius — `pathData` itself never changes.
- Flip = negative `scaleX` (H) or `scaleY` (V).

---

## 10. `pathData` (path string)

Standard SVG path syntax in **viewport coordinates**. The app's hand-rolled parser
(`path.js`) accepts the full grammar (relative/absolute, arcs, shorthand) and
normalizes internally to absolute `M/L/C/Z` (arcs → béziers). For generated files,
prefer **absolute commands** with `M …`, `L …`, `C …`, `Z`. Example rounded rect /
glyph from the sample doc:

```
M32 8 L76 8 C82.6 8 100 25.4 100 32 L100 76 ... Z      // plate
M44 38 L74 54 L44 70 Z                                  // play triangle
```

Keep coordinates within `0..viewportWidth/Height` (default `0..108`) to stay on
canvas. Multiple subpaths in one string are fine; `fillRule` resolves overlaps.

---

## 11. Minimal valid example

The smallest file that opens cleanly (one solid blue rounded square):

```json
{
  "format": "icon-emboss",
  "schemaVersion": 2,
  "app": "1.7.2",
  "name": "minimal",
  "document": {
    "canvas": { "width": 108, "height": 108, "viewportWidth": 108, "viewportHeight": 108 },
    "light": { "type": "point", "position": { "x": 38, "y": 30 }, "azimuth": 135, "elevation": 55, "intensity": 1, "color": "#ffffff" },
    "layers": [
      {
        "id": "bg",
        "name": "Background",
        "visible": true,
        "pathData": "M8 32 C8 18.7 18.7 8 32 8 L76 8 C89.3 8 100 18.7 100 32 L100 76 C100 89.3 89.3 100 76 100 L32 100 C18.7 100 8 89.3 8 76 Z",
        "fillRule": "nonZero",
        "material": { "baseColor": "#3b82f6", "fillAlpha": 1, "fillMode": "solid" }
      }
    ]
  }
}
```

(`castsShadow`, `transform`, and the rest of `material` are filled with defaults.)

---

## 12. Full example exercising every feature

```json
{
  "format": "icon-emboss",
  "schemaVersion": 2,
  "app": "1.7.2",
  "name": "demo",
  "document": {
    "canvas": {
      "width": 108, "height": 108, "viewportWidth": 108, "viewportHeight": 108,
      "exportBackground": { "transparent": false, "color": "#0b1020" },
      "pngSize": 1024
    },
    "light": { "type": "point", "position": { "x": 38, "y": 30 }, "azimuth": 135, "elevation": 55, "intensity": 1.2, "color": "#ffffff" },
    "layers": [
      {
        "id": "plate",
        "name": "Plate",
        "visible": true,
        "pathData": "M32 8 L76 8 C89.3 8 100 18.7 100 32 L100 76 C100 89.3 89.3 100 76 100 L32 100 C18.7 100 8 89.3 8 76 L8 32 C8 18.7 18.7 8 32 8 Z",
        "fillRule": "nonZero",
        "material": {
          "baseColor": "#2563eb",
          "fillAlpha": 1,
          "fillMode": "embossed",
          "embossIntensity": 1.0,
          "sheen": { "enabled": true, "strength": 0.3 },
          "stroke": null,
          "fillNone": false,
          "gradient": null
        },
        "castsShadow": { "enabled": true, "opacity": 0.4, "spread": 0.5, "distance": 1, "clipToLayers": true },
        "transform": null
      },
      {
        "id": "glyph",
        "name": "Glyph",
        "visible": true,
        "pathData": "M44 38 L74 54 L44 70 Z",
        "fillRule": "nonZero",
        "material": {
          "baseColor": "#eff6ff",
          "fillAlpha": 1,
          "fillMode": "gradient",
          "embossIntensity": 1,
          "sheen": { "enabled": false, "strength": 0.35 },
          "stroke": { "color": "#1e3a8a", "width": 1.5, "cap": "round", "join": "round" },
          "fillNone": false,
          "gradient": {
            "type": "linear",
            "x1": 44, "y1": 38, "x2": 74, "y2": 70,
            "cx": 59, "cy": 54, "r": 18,
            "stops": [
              { "offset": 0, "color": "#ffffff", "alpha": 1 },
              { "offset": 1, "color": "#93c5fd", "alpha": 1 }
            ]
          }
        },
        "castsShadow": { "enabled": true, "opacity": 0.3, "spread": 0.35, "distance": 1.6, "clipToLayers": true },
        "transform": { "translateX": 0, "translateY": 0, "rotation": 0, "scaleX": 1, "scaleY": 1, "pivotX": 54, "pivotY": 54 }
      }
    ]
  }
}
```

---

## 13. Generation / modification checklist

1. **Envelope is exact:** `"format": "icon-emboss"`, `schemaVersion` ≤ 2.
2. **All coordinates** (`pathData`, `light.position`, gradient geometry) are in
   the `viewportWidth × viewportHeight` space — default `108 × 108`.
3. **Colors are `#rrggbb`** (web order, no alpha) everywhere in the file. Opacity
   goes in `fillAlpha` / stop `alpha`. Never use `#AARRGGBB` here.
4. **Layer ids are unique** and stable across edits.
5. **Emboss is opt-in:** set `material.fillMode` to `"embossed"` to get the 3D look
   (default `"solid"` is flat).
6. **Gradients are linear or radial only** — no sweep/conic. Min 2 stops. Geometry
   in local (pre-transform) path space.
7. **Don't rewrite `pathData` to move a shape** — set `transform` instead; the
   engine bakes it.
8. **Bottom layer + `clipToLayers: true` = no visible shadow.** Either reorder or
   set `clipToLayers: false` for a shadow on the background.
9. Layer array order = bottom-to-top paint order.
10. Partial documents load (everything is coerced to defaults), but emit complete
    objects for predictable results.
