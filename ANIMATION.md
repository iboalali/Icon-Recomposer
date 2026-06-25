# ANIMATION.md — Raster-only material & motion design

> **Status: design / discussion. Nothing here is implemented yet.**
> Companion to `PLAN.md` (the authoritative spec for the *static, VD-faithful*
> app). This document covers a deliberately **raster-only** extension: richer
> materials and timeline animation that target **PNG / image-sequence / video
> export only** — never VectorDrawable or vector SVG.
>
> Read `CLAUDE.md` first for the pipeline orientation; this doc assumes it.

---

## 1. Motivation

Today the app is a static icon composer constrained so every effect round-trips
to a valid Android VectorDrawable (paths + gradients + alpha, nothing else).
That constraint is sacred for the vector exports — and it's also a ceiling.

The proposal: let the user treat a layer's fill like a material in a
professional motion-graphics tool (blur, glow, grading, soft shadow, animated
properties), then **animate** those properties / transforms / alpha over a
timeline, and export the result as a **still frame (PNG)** or **motion
(image sequence / video)**. Vector exports are explicitly out of scope for
these features and degrade gracefully (see §4).

This is a large, multi-phase feature. **Phase 1 (this doc's detailed section,
§9) is the only part being designed for build right now.** Later phases are
sketched in §7 for direction, not commitment.

---

## 2. The one architectural insight everything hangs on

`derive(document)` (`derive.js:60`) is a **pure function of the authoring
document**. The entire render path is:

```
document ──derive()──▶ derived ──▶ previewSvg() ─▶ #preview        (svg.js)
                                └─▶ standaloneSvg() ─▶ Image ─▶ canvas ─▶ PNG   (export-png.js)
                                └─▶ VectorDrawable XML            (export-vd.js)
```

Because `derive()` is pure, **animation needs no new rendering engine.** It
needs a *pre-pass* that produces an interpolated copy of the authoring document
at a given time `t`, then runs the existing, unchanged pipeline on it:

```
timeline + base document ──interpolate(t)──▶ document@t ──[existing derive→svg→canvas]──▶ frame@t
```

Every frame is just "the app as it already works, at a slightly different
document state." This reuses **100%** of `derive.js`, `svg.js`, and
`export-png.js`. This insight is the spine of the whole feature — every
decision below defers to it.

Corollary: **anything you can already author statically, you can already
animate**, the moment a property has a keyframe track. No per-property render
code. The work is the timeline model, the interpolator, the playback UI, and
(later) the encoders — not the renderer.

---

## 3. Scope & non-goals

**In scope (eventually):**
- Timeline with keyframed numeric / color / transform / alpha properties (Phase 1).
- Raster-only material effects via SVG filters: blur, glow, soft drop shadow,
  color grading, turbulence/displacement, blend modes (Phase 2).
- Still-frame PNG at the scrubber position (Phase 1).
- Motion export: PNG sequence → WebCodecs video → (optional) MediaRecorder / GIF (Phase 3).
- Path morphing (Phase 4 — the hard one).

**Explicit non-goals:**
- **No vector export of any animated or raster-only feature.** VD/SVG-vector
  export stays static and VD-expressible. See §4 for the degradation rule.
- **No new dependencies, no build step.** (See §8 — this is why `ffmpeg.wasm`
  is rejected.) Stays vanilla ES modules, zero `npm`, consistent with the
  hand-rolled `path.js` ethos.
- **No second drawing engine.** Raster effects must be expressible as SVG
  filters so the existing `SVG → Image → canvas` path renders them for free
  (see §6). We do not build a canvas compositing/particle engine.

---

## 4. The VectorDrawable-parity boundary (the real product decision)

The app's identity is *one derived model, multiple pixel-identical serializers,
all VD-expressible*. These features deliberately break "VD-expressible" for the
raster path. The risk is silent confusion: "why did my export lose the glow /
the motion?"

**Recommended rule: taint + visible badge (not a global mode switch).**

- A layer that uses a raster-only material property, **or** any document that
  has a non-empty timeline, is *tainted*.
- Vector exports (VD, vector SVG) stay available but **warn and degrade**:
  they export the **`t = 0` base frame** with raster-only effects stripped,
  via a `confirmDialog()` ("This document has motion / raster-only effects that
  VectorDrawable can't represent. Export the base frame without them?").
- The UI shows a small **"raster only — won't appear in VectorDrawable"** badge
  on tainted layers and a timeline indicator.
- PNG / image-sequence / video exports honor everything.

This keeps the WYSIWYG-to-VD promise intact for everything that *can*
round-trip, and makes the boundary honest and visible rather than silent.
**Open decision A** (§10): this taint+badge approach vs. a hard per-document
"raster mode" switch.

---

## 5. Animation model (data shapes)

All persisted (in `appState.document`, undoable, saved to the project file).
Ephemeral playback state (current time, playing/paused) lives in `appState.ui`
and is **never serialized** — same split as zoom/pan today.

### 5.1 Timeline (document-level)

```js
document.timeline = {
  enabled: false,      // false ⇒ static app, zero behavior change (default)
  duration: 3.0,       // seconds
  fps: 30,             // export frame rate; preview uses rAF + real clock
  loop: true,          // preview playback loops; export does not
  tracks: [ /* see 5.2 */ ],
};
```

When `enabled` is `false` or `tracks` is empty, the app behaves *exactly* as
today. This is the migration story: old docs simply have no `timeline` and
`normalizeDocument` fills `enabled: false`.

### 5.2 Tracks & keyframes

A track binds a **property path** (a string addressing one value in the
authoring document) to a list of keyframes:

```js
track = {
  id: 'trk-...',
  target: 'layers[2].material.fillAlpha',   // see 5.3 for the addressing scheme
  type: 'number',          // number | color | angle  (drives interpolation, §5.4)
  keys: [
    { t: 0.0, value: 1,   easing: 'easeInOut' },
    { t: 1.5, value: 0.2, easing: 'linear'    },
    { t: 3.0, value: 1,   easing: 'easeOut'   },
  ],
};
```

- `t` is in **seconds**, clamped to `[0, duration]`, sorted ascending.
- `easing` is the curve **leaving** that key toward the next (held on the
  left key, standard convention). Set: `linear`, `easeIn`, `easeOut`,
  `easeInOut`, `hold` (step). A `cubicBezier` form (`[x1,y1,x2,y2]`) is a
  natural later addition; not Phase 1.
- Before the first key / after the last key, the value is **held** (clamped),
  not extrapolated.

### 5.3 Property addressing (`target`)

A small, explicit **allow-list** of animatable paths — not arbitrary
reflection. Each entry maps a string to a getter/setter pair against the
document, plus a `type`. Phase 1 allow-list (numeric/color/transform/alpha
only — see §9.2):

| target pattern | type | notes |
| --- | --- | --- |
| `light.azimuth` | angle | shortest-arc interpolation |
| `light.elevation` | number | clamp 1–89 (derive already clamps) |
| `light.intensity` | number | |
| `light.position.x` / `.y` | number | point light → radial center |
| `layers[i].material.fillAlpha` | number | 0–1 |
| `layers[i].material.baseColor` | color | OKLab mix (§5.4) |
| `layers[i].material.embossIntensity` | number | |
| `layers[i].material.sheen.strength` | number | |
| `layers[i].transform.translateX` / `.translateY` | number | |
| `layers[i].transform.rotation` | angle | |
| `layers[i].transform.scaleX` / `.scaleY` | number | |
| `layers[i].opacity` *(if present)* / `layers[i].material.gradient.stops[j].offset` | number | gradient-stop animation is a stretch goal for P1 |

**Layer identity gotcha:** index-based paths (`layers[2]`) break if layers are
reordered/deleted. **Store `layerId` on the track, resolve index at
interpolation time.** i.e. the canonical `target` is really
`{ layerId, prop: 'material.fillAlpha' }`; the string form above is the
human-readable rendering. Document-level targets (`light.*`) have no layerId.
This avoids the classic "animation retargets to the wrong layer after a
delete" bug. **Open decision B** (§10).

### 5.4 Interpolation by type

- **number** — linear lerp `a + (b−a)·e`, where `e` is the eased fraction.
- **angle** — shortest-arc: normalize Δ into `(−180, 180]` before lerp, so
  `350°→10°` goes +20°, not −340°. Critical for `light.azimuth` and rotation.
- **color** — parse both endpoints, mix in **OKLab** (reuse `mix()` /
  `color.js` machinery — already perceptually-uniform and battle-tested in
  `derive`), re-emit. Alpha lerps linearly.

Easing functions are pure `(0..1) → (0..1)`; the standard cubic set is a few
lines, no dependency.

---

## 6. Raster materials = SVG filters (Phase 2 direction, documented now)

"Professional material properties" splits into two very different worlds:

1. **SVG-filter-expressible** — gaussian **blur** (`feGaussianBlur`), **glow**
   (blur + `feMerge`), **soft drop shadow** (`feDropShadow` / offset+blur),
   **color grading** hue/sat/brightness/contrast (`feColorMatrix`),
   **turbulence/displacement** (`feTurbulence` + `feDisplacementMap`), **blend
   modes** (`feBlend` / `mix-blend-mode`).
2. **Full canvas compositing engine** — particles, shaders, arbitrary pixel ops.

**Decision: stay in world 1.** If raster effects are emitted as SVG `<filter>`
elements inside the derived SVG, the existing `SVG → Image → canvas` path
(`export-png.js:11`) renders them **for free** in both preview and PNG —
preview/PNG/frame parity holds automatically, no second renderer, no separate
canvas code path. World 2 means a fourth renderer and the loss of
preview==export parity. World 1 buys ~90% of what users want from "material
properties" at a fraction of the cost. **Open decision C** (§10).

These filters are exactly the things VD cannot express → they're precisely the
tainting features from §4. The boundary is clean: *if it's an SVG filter, it's
raster-only.*

---

## 7. Phasing roadmap

1. **Phase 1 — Timeline + property animation + preview playback + PNG-at-scrubber.**
   No new effects, no video encoding. Animate existing numeric/color/transform/
   alpha props. Ships entirely on existing infra. **Detailed in §9.**
2. **Phase 2 — Raster-only material effects** via SVG filters (§6), behind the
   taint+badge mechanism (§4) with vector-export warnings.
3. **Phase 3 — Motion export.** In order of effort/quality:
   - **PNG sequence** (zero new infra — loops `renderPng` over frames; user
     encodes externally). The honest MVP for motion export.
   - **WebCodecs `VideoEncoder`** (native, no dependency, hardware-accelerated,
     **offline/deterministic** — see §8). The real answer.
   - **MediaRecorder + `captureStream()`** (trivial, real-time only) and **GIF**
     (hand-rolled LZW) as optional extras.
4. **Phase 4 — Path morphing.** Interpolating `pathData` requires matched
   command counts/structure (normalize both endpoints to compatible command
   lists). Much larger; deferred deliberately. Everything else ships without it.

---

## 8. Export tech analysis — and why `ffmpeg.wasm` is rejected

`ffmpeg.wasm` fights this project's identity on every axis:
- **~25–30 MB** payload — antithetical to a zero-dep, instant-load PWA that
  hand-rolls `path.js` specifically to avoid dependencies.
- **Hard dependency** — there is no "vendored, dependency-free" version of it.
- **Cross-origin isolation required** — needs COOP/COEP headers +
  `SharedArrayBuffer` for threading, which **GitHub Pages cannot set** without a
  service-worker header-injection hack (gnarly, and our `sw.js` is deliberately
  minimal).

It is the single heaviest, least-on-brand choice available. **Do not use it.**

Recommended path instead (also §7 Phase 3):

| Option | Dep? | Timing | Output | Verdict |
| --- | --- | --- | --- | --- |
| **PNG sequence** | none | offline, deterministic | N × PNG (+ optional zip) | MVP — reuses `renderPng` wholesale |
| **WebCodecs `VideoEncoder`** | none (native) | **offline, frame-accurate** | H.264 / VP9 / AV1 | the real answer; needs a tiny/hand-rolled muxer for the container |
| MediaRecorder + captureStream | none (native) | **real-time only** | webm | simplest code, but hostage to async-decode jank (below) |
| GIF | hand-rolled LZW | offline | gif | 256-color, dated, big files — low priority |

**The sleeper problem:** the `SVG → Image` step is **async per frame**
(`img.onload`). Anything bound to the wall clock (MediaRecorder) will **jank**
when a frame's decode is slow. WebCodecs lets us go **offline** — render frame,
encode frame, advance, no real-time dependence — which sidesteps the jank
entirely. This is the main argument for WebCodecs over MediaRecorder despite the
latter's simpler code. PNG-sequence shares the same offline determinism.

---

## 9. PHASE 1 — detailed design (the part to build first)

**Goal:** a working timeline that animates existing authoring properties, plays
back in the preview, and exports a still PNG at the scrubber position. No new
material effects, no video encoder. Proves the spine (§2) end-to-end.

### 9.1 Data model changes

- Add `document.timeline` (§5.1), default `{ enabled:false, duration:3, fps:30,
  loop:true, tracks:[] }`.
- `model.js`:
  - `defaultDocument` / `sampleDocument` — leave `timeline.enabled = false`
    (sample stays static so nothing visually changes for existing users).
  - `normalizeDocument` — fill a default `timeline` when absent; validate
    tracks (drop tracks whose `layerId` no longer resolves; clamp/sort keys).
  - **Bump `SCHEMA_VERSION` 2 → 3**, additive. Add a `migrate` step `v<3 ⇒ v=3`
    (no structural transform needed — normalize fills the field, mirroring the
    v1→v2 gradient migration at `model.js:230`).
  - Tracks are part of the document → **saved in the `.icjson` project file**
    automatically via `wrapProject`. Good: animation persists.

### 9.2 Interpolation pre-pass (new module: `animate.js`)

Single pure function, the heart of Phase 1:

```js
// animate.js
export function documentAt(document, t) {
  if (!document.timeline?.enabled || !document.timeline.tracks.length) return document;
  const next = structuredClone(document);          // never mutate the source
  for (const track of document.timeline.tracks) {
    const value = sampleTrack(track, t);            // §5.4 interpolation
    if (value !== undefined) applyTarget(next, track, value);  // §5.3 resolve layerId→index, set
  }
  return next;
}
```

- Pure, no DOM, headless-testable (matches the repo's "exercise modules
  headlessly" convention in `CLAUDE.md`).
- `applyTarget` resolves `layerId → current index` each call (§5.3 gotcha), then
  writes via the allow-listed setter. Unknown/!resolvable targets are skipped.
- `structuredClone` per frame is fine for preview (rAF) and acceptable for
  Phase 1 PNG. If profiling shows it hot during export, optimize later (apply
  deltas to a reused scratch doc) — **not** a Phase 1 concern.

### 9.3 Render integration (`ui.js`)

The current `render()` (`ui.js:186`) does `cachedDerived = derive(doc())`.
Phase 1 inserts the pre-pass when previewing animation:

```js
function render() {
  const base = doc();
  const playing = appState.ui.playback.playing || appState.ui.playback.scrubbing;
  const d = (base.timeline?.enabled && (playing || base.timeline.tracks.length))
    ? documentAt(base, appState.ui.playback.time)
    : base;
  cachedDerived = derive(d);
  // ... rest unchanged: previewSvg, layer list, chrome, overlays ...
}
```

**Critical separation of concerns:**
- The timeline edits (adding tracks/keys, duration, fps) go through **`commit`/
  `commitGesture`** → undoable, saved, exactly like any other doc edit.
- The **playhead position and play/pause are EPHEMERAL** (`appState.ui.playback
  = { time, playing, scrubbing }`) — like zoom/pan (`appState.ui.view`). They
  **must not** call `commit` (would flood undo with per-frame snapshots and
  resave constantly). They mutate `appState.ui` and call `scheduleRender()`
  directly. This mirrors the existing ephemeral-view pattern precisely.

**Inspector value gotcha:** `updateInspector()` populates controlled inputs
from `primaryLayer()`/`doc()`. While scrubbing, the *displayed* values should
reflect the **interpolated** doc (so the user sees the animated state), but
**edits must write back to the base document's keyframes / base values**, never
to the interpolated clone (which is thrown away each frame). Decide the editing
convention now: editing a property *that has a track* should either (a) be
disabled with an "animated" affordance, or (b) set/insert a keyframe at the
current playhead. **Open decision D** (§10). Simplest Phase-1: show interpolated
values read-only when a track exists; all keyframe editing happens in the
timeline UI.

### 9.4 Timeline UI

A new bottom dock panel (collapsible; hidden entirely when `timeline.enabled` is
false, with a "+ Animate" affordance to enable). Components:

- **Transport:** play/pause, stop (→ t=0), loop toggle, current-time readout,
  duration & fps fields.
- **Scrubber/ruler:** click/drag to set `playback.time`; ticks at fps.
- **Track rows:** one per track, label = human `target` string (§5.3), keyframe
  diamonds at each key's `t`. Drag a diamond to move `t`; double-click empty to
  add a key (value = current interpolated value); right-click a key for easing /
  delete.
- **"Add track" flow:** pick from the allow-list (§5.3), or — nicer — a small
  "◆" record affordance next to each animatable inspector control that creates a
  track for that property and drops a key at the playhead. (Affordance can be
  Phase 1.5 if the explicit picker ships first.)

**Playback loop:** a rAF loop driven by the **real clock delta** (not a fixed
step) advances `playback.time`; on `>= duration`, loop or stop per `loop`. Reuse
the existing `scheduleRender()` batching — the playback loop just updates
`playback.time` and calls `scheduleRender()`. Stop the rAF loop when paused so
we don't spin.

> Wall-clock note: scripts in some harness contexts forbid `Date.now()`, but the
> **app** runs in a normal browser — `performance.now()` for the playback delta
> is fine here. (That restriction is a workflow-script concern, not an app
> concern.)

### 9.5 PNG-at-scrubber export

Trivial given the pre-pass: at export time, `derive(documentAt(doc(),
playback.time))` instead of `derive(doc())`, then the existing `renderPng`
path is **completely unchanged**. Wire a "Export frame (PNG)" that respects the
current playhead. Filename suffix: extend the existing scheme (`-iwb`/`-iwt`)
with the frame time or index, e.g. `<name>-f0123-iwt.png`. (Image-sequence /
video export is Phase 3 — not now.)

### 9.6 Files touched (Phase 1)

| File | Change |
| --- | --- |
| `model.js` | `timeline` defaults + normalize/validate; `SCHEMA_VERSION`→3 + migrate; (no `APP_VERSION` decision here — see §11) |
| `animate.js` *(new)* | `documentAt`, `sampleTrack`, easing, type interpolation, target resolve/apply |
| `ui.js` | pre-pass hook in `render()`; `appState.ui.playback`; timeline panel + transport + scrubber; playback rAF loop; export-frame wiring; inspector read-only-when-animated |
| `index.html` | timeline dock markup; "Export frame" control |
| `styles.css` | timeline dock, track rows, keyframe diamonds, transport |
| `sw.js` | **add `animate.js` to `PRECACHE`** (mandatory for any new top-level module — `addAll` is atomic) |
| `CHANGELOG.md` | `Added` entry (user-facing) under `[Unreleased]`, same commit |
| `telemetry.js` | optional: `animate`/`export-frame` signals (consistent with existing events) |

### 9.7 Phase 1 acceptance / headless verification

Per `CLAUDE.md` (serve + `google-chrome --headless=new --dump-dom`):
- A doc with one `fillAlpha` track [t0:1 → t1.5:0.2 → t3:1] yields, at t=1.5, a
  `#preview` whose layer `fill-opacity` ≈ 0.2 (assert the interpolated derive).
- `documentAt(doc, 0)` deep-equals the static `doc` (modulo clone) — t=0 is the
  faithful base frame (this is also what vector export emits, §4).
- Angle track `light.azimuth` [350 → 10] passes through ~0/360, not ~180
  (shortest-arc sanity).
- Reordering layers after authoring a track keeps the track on the same layer
  (layerId resolution, §5.3 gotcha).
- Toggling `timeline.enabled = false` makes `render()` byte-identical to today.

---

## 10. Open decisions (carry into build)

- **A. VD-parity boundary** — taint+badge+warn-on-vector-export *(recommended,
  §4)* vs. a hard per-document "raster mode" switch.
- **B. Track targeting** — store `layerId` + prop and resolve index at sample
  time *(recommended, §5.3)* vs. raw index paths *(fragile)*.
- **C. Material effects scope** — SVG-filter-only *(recommended, §6)* vs. a
  canvas compositing engine. (Phase 2 question; record the lean now.)
- **D. Editing an animated property** — read-only-in-inspector + edit only via
  timeline *(simplest for P1)* vs. "edit sets a keyframe at the playhead"
  *(nicer, more work)*.
- **E. Motion export format priority** (Phase 3) — confirmed order: PNG-seq →
  WebCodecs → MediaRecorder/GIF. `ffmpeg.wasm` rejected (§8).

---

## 11. Versioning / changelog mechanics (don't forget)

Per `CLAUDE.md`:
- Phase 1 is **user-facing** → `CHANGELOG.md` `Added` entry under
  `[Unreleased]` in the **same commit**.
- `SCHEMA_VERSION` (`model.js`) bumps **2 → 3** (document shape changed:
  `timeline` added) with a migration step.
- `APP_VERSION` bumps on **release**, not per-commit; move `[Unreleased]` items
  under a dated `## [x.y.z]` heading and tag `vx.y.z` when shipping.
- New module `animate.js` **must** be added to `sw.js` `PRECACHE`.
