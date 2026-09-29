# Test plan

Every feature of Icon Recomposer 2, as a checklist to work through one case at a time. Each case says what to render or do, and the target the result is compared against. Most rendering cases run automatically in the browser; the rest are steps to follow by hand.

## How to run it

1. Serve the project root and open the editor in Chrome (the only target browser):

   ```
   python3 -m http.server
   ```

   Then open http://localhost:8000/. Use a fresh profile or clear the site data (DevTools, Application, Storage, Clear site data) when a case asks for a first visit.

2. Open the DevTools console on the editor page and load the checks:

   ```js
   await import('/tests/checks.js')
   await vt.runAll()        // every automated case, about 4 seconds
   await vt.runAll('CR')    // one group
   await vt.run('CR-4')     // one case, with a table of its parts and their numbers
   ```

   `vt.runAll()` prints one row per case: PASS, FAIL (with the parts that failed) or SKIP.

3. Work through the manual cases below and tick them off. When a case fails, note the case ID, what you saw, and the numbers from `vt.run`.

The helpers live in `tests/vt.js`, the automated cases in `tests/checks.js`, and the VectorDrawable test file in `tests/import-fixture.xml`.

## What "compare against a target" means

Every render goes through the export path (`renderCanvas`), which uses the same markup as the editor preview. A case compares that render against one of four kinds of target:

| Kind | Target | Example |
| --- | --- | --- |
| **E** equivalence | A second scene that must render the same pixels, in the whole canvas or a window of it. | A crossing that puts A over B looks like painting A last. |
| **P** property | Something measured on the render. | A masked corner has alpha 0; the shadow sits opposite the light. |
| **R** reference image | A render you looked at and approved once, stored in `captures/golden/`. | Each material's test tile. |
| **L** look | A description of what you should see, checked by eye. | Marble veins wander and swell. |

Comparisons use `vt.compare(a, b, window)`. A pixel's difference is its largest channel difference (0 to 255). Differences of 2 or less count as none, because Chrome's SVG rasterization can shift a whole render by 1 to 2 levels from one render to the next. The result has `mean` (average difference), `max`, and `over` (percent of pixels that differ by more than 16).

| Target | Passes when |
| --- | --- |
| exact | `max` is 0: no pixel differs by more than 2 |
| near | `mean` ≤ 0.5 and `over` ≤ 0.5%, which allows single-pixel differences along anti-aliased edges |
| differs | `mean` ≥ 1 (a sanity part that proves the case can fail) |

Useful helpers in the console:

| Helper | Does |
| --- | --- |
| `vt.render(variant, size, { region, mask, layer, transparent })` | Export render as a canvas |
| `vt.variant(i)` | The editor's current document, variant `i` (read from the autosave) |
| `vt.compare(a, b, { x, y, w, h })` | Compare two canvases in a window, in canvas units |
| `vt.diff(a, b)` | Show the difference, amplified 8×, over the page (click to close) |
| `vt.show(canvas)`, `vt.pixel(canvas, x, y)` | Look at a render; read one pixel |
| `vt.image('/captures/…png')` | Load a saved image (screenshot, export, reference) as a canvas |
| `vt.tile(style, shape)`, `vt.pair(styleA, styleB)`, `vt.scene(...shapes)` | Test scenes |
| `vt.open(variant)` | Load a test scene into the editor to look at it |
| `vt.approve('marble')` | Render a material's test tile, show it, and download it as its reference image |

### Reference images

Material looks have no equivalence to compare against, so they need approved images. For each material:

1. `vt.open(vt.tile({ material: 'marble' }))`, then look at it in the editor at 100% and at 1600% against the description in MT-4.
2. When it looks right, run `await vt.approve('marble')` and move the downloaded `MT-marble.png` to `captures/golden/`.

From then on MT-2 compares every render against it. Reference images depend on the GPU and Chrome version, so approve them on the machine you test on. `captures/` is gitignored; commit the images somewhere else if you want to share them.

### Preview against export

The automated cases render through the export path only. To check that the editor preview shows the same thing (a hard constraint of the app):

1. In the editor, deselect everything (Esc), untick **Android guides** and the tracing guide, and zoom to the level you want to check.
2. In DevTools, Elements, right-click `#stage-host`, then **Capture node screenshot**. Note its width in pixels, W.
3. Export the same variant at a custom size of W px, with no mask and the whole canvas.
4. Put both files in `captures/`, then compare: `vt.compare(await vt.image('/captures/preview.png'), await vt.image('/captures/export.png'))`. Target: near.

## Baseline

Measured on 2026-09-29 at commit `4b56724`, Chrome 154 on Linux: 38 automated cases pass, **CR-3 fails** for frosted glass and jelly (see the case), and **MT-2 skips** until reference images are approved.

## App shell

- [ ] **AP-1** ambient.css stays inside the stage and never reaches the editor UI. *Auto, P.* The page's own stylesheets have no ambient.css rules; the stage's shadow root has them.
- [ ] **AP-2** First visit shows Help. Clear the site data and reload. *Target:* the Help dialog opens with the getting-started guide. Close it and reload: nothing opens.
- [ ] **AP-3** What's new shows once per version. Run `localStorage.setItem('icon-recomposer-2/seen-version', '0')` and reload. *Target:* the What's new dialog shows the entry for the version in the top bar; reload again and it does not show. If https://iboalali.com/apps.json has no entry for `APP_VERSION`, nothing shows and the version stays unseen.
- [ ] **AP-4** About. Click **About**. *Target:* the version matches the top bar (`APP_VERSION` in `model.js`), the website and privacy policy links open, and the changelog loads from the website.
- [ ] **AP-5** The 1.x service worker is retired. In the console: `await caches.open('old-1x'); await navigator.serviceWorker.register('/sw.js')`. *Target:* within a second or two, `await caches.keys()` is empty and `await navigator.serviceWorker.getRegistrations()` is empty. The worker also reloads the pages it controls; a page that registers it from the console is not one of them, so this page does not reload. That part needs a browser that still has the 1.x app installed.
- [ ] **AP-6** No errors. Reload, open every dialog (Help, About, Export, Copy to variants, a confirm dialog) and import the fixture. *Target:* no errors or warnings in the console.
- [ ] **AP-7** Help button. Click **Help**. *Target:* the getting-started guide opens at any time, not just on the first visit.

## Projects and files

- [ ] **FI-1** Autosave. Make an edit, then `sessionStorage.before = localStorage['icon-recomposer-2/doc']` and reload. *Target, E exact:* `vt.compare(await vt.render(vt.M.parseProject(sessionStorage.before).variants[0]), await vt.render(vt.variant()))`. The same variant is selected as before the reload.
- [ ] **FI-2** Unsaved marker. Make an edit. *Target:* the tab title starts with `• `. Click **Save** (or Ctrl+S): a `<name>.icjson` file downloads and the `•` disappears.
- [ ] **FI-3** Open. With unsaved changes, click **Open** (or Ctrl+O) and pick a saved `.icjson`. *Target:* a confirm dialog asks before replacing; Cancel keeps the current icon; confirming opens the file and shows "Opened <file>". Without unsaved changes, it opens without asking.
- [ ] **FI-4** Invalid file. Open a text file that is not a project. *Target:* an error toast names the file, and no confirm dialog appears first.
- [ ] **FI-5** Drag and drop. Drop a `.icjson` anywhere on the page. *Target:* it opens as with Open. With a dialog open, a drop does nothing.
- [ ] **FI-6** New. Click **New**. *Target:* asks first when there are unsaved changes; the new icon has one shape, "Plate", at 16, 16, 76 × 76, radius 22.
- [ ] **FI-7** Save and reopen through the UI. Save the sample, open the saved file. *Target, E exact:* its render equals the render before saving (compare as in FI-1). The automated form of this is RC-2.

## Rendering core

- [ ] **RC-1** Rendering the same scene twice gives the same pixels. *Auto, E exact.*
- [ ] **RC-2** Saving and reopening a project renders the same, for a textured, a hollow and a plain shape. *Auto, E exact.*
- [ ] **RC-3** A hidden shape renders like a deleted one. *Auto, E exact.*
- [ ] **RC-4** Opacity 0 renders like no shape at all, shadow included. *Auto, E exact.*
- [ ] **RC-5** Turning the whole scene 90° (shapes, their rotation and the light) turns the render 90°. *Auto, E near.* This catches a shape whose light, shading or texture does not follow its own rotation.
- [ ] **RC-6** The background layer paints under the foreground, whatever the list order. *Auto, E exact.*
- [ ] **RC-7** A symmetric shape turned 180° looks unturned, for flat, convex, concave and groove surfaces. *Auto, E near.*

## Light and background

- [ ] **LB-1** Shadows fall away from the light, for five light directions. *Auto, P:* the shadow's center of mass sits on the side opposite the light.
- [ ] **LB-2** Elevation 0 and thickness 0 cast no shadow. *Auto, E exact* against an empty canvas around the shape, with a sanity part showing elevation 1 does cast one.
- [ ] **LB-3** An unshaded background is exactly its color. *Auto, P.*
- [ ] **LB-4** A shaded background takes the key light's strength and the light tint; an unshaded one ignores them. *Auto, P and E exact.*
- [ ] **LB-5** No background (transparent), as a project setting and as the export option, leaves the corners at alpha 0 and the shape opaque. *Auto, P.*
- [ ] **LB-6** Direction pad. Drag the light's pad; hold Shift. *Target:* shadows and highlights move live; Shift snaps to -1, 0 or 1 on each axis. Under Advanced, the X and Y fields clamp to -1 to 1.
- [ ] **LB-7** Key, fill, hue and tint. Move each slider. *Target, L:* key strengthens highlights and shadows, fill lifts the shadowed sides, hue and tint color the light on every shape and the shaded background.

## Shapes

- [ ] **SH-1** Every surface (flat, concave vertical, concave horizontal, convex, groove) turns with the scene, on a rectangle and an ellipse. *Auto, E near.*
- [ ] **SH-2** A frame and a ring show the background through their hole. *Auto, E exact* at the hole's center, with a sanity part on the wall.
- [ ] **SH-3** Frames and rings turn with the scene, curved walls and a neon frame included. *Auto, E near.*
- [ ] **SH-4** Level shapes cast no shadow on each other. *Auto, E exact:* with **Level with its neighbors** on both, A's face looks as if B were not there; a sanity part shows B's shadow on A without it.
- [ ] **SH-5** Surfaces. `vt.open(vt.tile({ surface: 'convex' }))`, then each other surface. *Target, L:* convex bulges toward the light; concave (vertical) and concave (horizontal) dip along their axis; groove is recessed into the plate; flat has no curve.
- [ ] **SH-6** Edges. Toggle **Rounded edge (fillet)** and **Beveled edge (chamfer)**, then change Fillet width, Chamfer width (negative too) and Edge shine under Advanced. *Target, L:* the edge highlight is a lighter shade of the shape's own color, not a white outline; Edge shine mixes it toward white; a negative width turns the band inward.
- [ ] **SH-7** Glow. Under Advanced, tick **Glow**, change its color and size. *Target, L:* a soft halo in the glow color around the shape, which does not replace the shape's shadow; a frame also glows into its hole.
- [ ] **SH-8** Hollow shapes. Tick **Hollow**, drag the wall handle (Shift for whole units), try frosted glass and jelly. *Target, L:* the shape casts its shadow and glow into the hole, the hole's rim catches the light like the outer edge, glass and jelly get their glass edge and shadow ring around the hole, and the shapes list shows a hollow swatch.
- [ ] **SH-9** Level runs. Mark three shapes that follow each other in the list as level, and one that does not follow them. *Target:* the three draw all shadows before any face; the separate one is not part of the run.

## Canvas, selection and editing

- [ ] **CV-1** Add. Click **+ Rect** and **+ Circle**. *Target:* a new shape appears, selected, on top of the list.
- [ ] **CV-2** Select. Click a shape; Shift or Ctrl-click another on the canvas; in the list, Shift-click a range and Ctrl-click to toggle. *Target:* the selection and the list highlight match; the inspector header shows "N shapes".
- [ ] **CV-3** Marquee. Drag on empty canvas. *Target:* a selection box appears and selects every visible shape whose bounding box it touches; with Shift or Ctrl held, it adds them to the current selection.
- [ ] **CV-4** Ctrl+A selects every visible shape, not hidden ones. Esc clears the selection.
- [ ] **CV-5** Move. Drag a group of selected shapes; nudge with the arrow keys and with Shift. *Target:* they move together; arrows move 1 unit, Shift+arrows 10.
- [ ] **CV-6** Resize. Drag an edge and a corner handle, also on a rotated shape; hold Shift on a corner. *Target:* the shape resizes along its own axes, never below 1 unit; Shift keeps the aspect ratio.
- [ ] **CV-7** Rotate. Drag the rotation handle; hold Shift. *Target:* the shape turns around its center; Shift snaps to 15° steps; values stay between -180 and 180.
- [ ] **CV-8** Hit tests. Click inside a frame's hole over a shape behind it, and click where one shape crosses over another. *Target:* the click selects the shape behind the hole, and the shape on top at the crossing.
- [ ] **CV-9** Delete, duplicate, reorder, hide. Use Delete/Backspace, Ctrl+D, **Up**/**Down**, and **Hide**/**Show** in the list. *Target:* each works on all selected shapes; a duplicated shape with a patterned material gets its own layout (`vt.variant().shapes.map(s => s.style.seed)` shows a new seed); deleting a shape also drops its crossings.
- [ ] **CV-10** Shortcuts stay out of the way. Type in the Name field and press Delete, arrows and Ctrl+A; open a dialog and press Delete. *Target:* the field edits text and no shape changes; with a dialog open, no shortcut runs.

## Zoom and pan

- [ ] **ZM-1** Zoom. Use the mouse wheel and a trackpad pinch (toward the pointer), the + and − buttons, and Ctrl/Cmd + = / − / 0. *Target:* zooms toward the pointer up to 1600%; Ctrl+0 and **Fit** (Shift+1) show the whole canvas; **Zoom to selection** (Shift+2) frames the selected shapes.
- [ ] **ZM-2** Pan. Middle mouse drag, Space+drag, two fingers on a touch screen. *Target:* the canvas pans; releasing Space returns to normal editing.
- [ ] **ZM-3** Sharp at every zoom. At 1600%, look at edges, fine texture and masks. *Target, L:* edges and texture detail are crisp, not a blurry upscale; mask and clip edges line up with the shapes.
- [ ] **ZM-4** Zoom never changes exports. Export the Play Store PNG at Fit and again at 800%. *Target, E exact:* compare the two files with `vt.image` and `vt.compare`.
- [ ] **ZM-5** Editing while zoomed. At 800%, drag, resize and click shapes. *Target:* shapes follow the pointer exactly; hit tests land on the shape under the pointer.

## Undo and redo

- [ ] **UN-1** Steps. Drag a shape, drag a slider, type a value, then undo with Ctrl+Z and the undo button, redo with Ctrl+Shift+Z, Ctrl+Y and the redo button. *Target:* each gesture is one step; a new edit after undo clears the redo stack.
- [ ] **UN-2** Undo restores the render. `const before = await vt.render(vt.variant())`, make an edit, undo, then `vt.compare(before, await vt.render(vt.variant()))`. *Target:* E exact.

## Inspector

- [ ] **IN-1** Shape fields. Change Name, Layer, Kind, Position, Size, Corner radius, Hollow, Wall and Rotation. *Target:* the canvas follows; W and H stay at least 1; ticking Hollow sets a wall of an eighth of the shorter side (at least 0.5); Wall only shows for hollow shapes.
- [ ] **IN-2** Several shapes. Select shapes with different values. *Target:* fields that differ show "Mixed"; a new value applies to all; Name, Position and Size are hidden.
- [ ] **IN-3** Each material shows only its own settings. Pick each material and compare the Look section (and Advanced) with this list. Every material also has Color, Material, Surface, Elevation, Thickness, the two edges, Opacity, and under Advanced the edge widths, Edge shine, Shade, Curve depth, Texture strength and Glow, except where noted.

  | Material | Its own settings (Advanced in parentheses) |
  | --- | --- |
  | Matte, Shiny | none; Shiny also has Reflections |
  | Frosted glass | Frost; Surface disabled |
  | Jelly | Frost, Translucency, Inner glow; Surface disabled; no Texture strength |
  | Enamel | Metal rim, Rim color when custom (Highlight sharpness); no Texture strength |
  | Ceramic | Glaze, Speckles, Crackle, Reactive glaze; no Texture strength |
  | Brushed metal, Brushed (radial), Blasted | Shuffle pattern |
  | Chrome | Finish, Studio, Tint (Environment contrast, Horizon and Horizon sharpness, or Light position and Light sharpness for Softbox) |
  | Gold | Gold, Finish, Studio (as Chrome) |
  | Copper | Finish, Studio, Patina (as Chrome) |
  | Anodized aluminum | Texture |
  | Hammered metal | Finish, Dent depth (Dent size) |
  | Marble | Veins, Finish (Vein scale) |
  | Granite | Finish (Speckle size) |
  | Terrazzo | Chip color, Finish, Chips (Chip size) |
  | Slate | Layer direction (Layer scale, Roughness) |
  | Concrete | Pits (Texture scale) |
  | Stucco | Relief depth (Relief size) |
  | Carved stone | Depth (Chisel size) |
  | Wood | Figure, Finish, Grain direction (Grain scale) |
  | Cork | Pores (Granule size) |
  | Leather | Stitching, Thread color when stitched, Sheen, Relief depth (Grain size) |
  | Paper | Paper, Crumpled, Folds, Direction (Fiber scale) |
  | Cardboard | Folds, Direction, Exposed flutes (Flute spacing) |
  | Denim | Fade, Stitching, Thread color when stitched, Weave direction (Weave scale) |
  | Canvas | Thread contrast, Weave direction (Weave scale) |
  | Felt | Fuzz (Fiber scale) |
  | Carbon fiber | Clear coat, Weave direction (Weave scale) |
  | Holographic | Colors, Color 1 and 2 when custom, Pattern, Base, Direction, Angle when fixed, Light response, Band sharpness, Diffraction lines (Band width) |
  | Neon | Core brightness, Glow size; no Elevation, Thickness, edges, Shade, Curve depth, Texture strength or Glow; Surface disabled |

- [ ] **IN-4** Picking a material resets its settings to that material's defaults. Change a few settings, pick another material, then check `vt.variant().shapes[0].style`. *Target:* for example Denim starts with Stitching on, thread `#d9a13b` and Fade 0.35; Enamel with a gold rim; Ceramic glossy with Reactive glaze 0.25; Cardboard as kraft.
- [ ] **IN-5** Advanced. *Target:* each section's Advanced part starts closed and opens on click; the everyday settings are all outside it.
- [ ] **IN-6** Reflections controls. *Target:* Reflections only shows for glossy materials and finishes; the Reflection direction pad and Lock reflections to the light only show when Reflections is above 0; the pad is disabled while locked.
- [ ] **IN-7** **Copy to variants…** in the Shape section is disabled with one variant.

## Crossings

- [ ] **CR-1** An opaque crossing looks like painting the shape on top. *Auto, E near:* A crossing over B against B painted after A. What remains are single-pixel lines along the edges (about 0.13% of pixels).
- [ ] **CR-2** The shape on top keeps its own face, untouched by the one below. *Auto, E near.*
- [ ] **CR-3** A see-through shape on top looks right inside the overlap: opacity 0.5, frosted glass, jelly. *Auto, E near.* **Known failure at the baseline:** glass (mean 1.32) and jelly (mean 1.05) differ from painting them last. The crossing leaves B's shadow out wherever the glass lies outside B, so that shadow is missing under the glass, and the glass's blur also misses B next to it. Outside the overlap the difference is larger. Opacity 0.5 passes exactly.
- [ ] **CR-4** The part of a shape on top has the same shading as the rest of it. *Auto, P:* the # design, with the lower horizontal bar crossing over the right vertical one while the bars stacked between them shade it; the step in color across the patch's edges is at most 8 levels. The renderer before commit `4b56724` steps by 17 and 31.
- [ ] **CR-5** Three shapes weave: A over B, B over C, C over A. *Auto, P:* at each overlap, the color on top is the right shape's.
- [ ] **CR-6** Several shapes cross over one shape, also where they overlap each other. *Auto, P.*
- [ ] **CR-7** A shape crossing over a frame stays clear of the frame's hole shadow. *Auto, E near.*
- [ ] **CR-8** Reflections respect crossings: a glossy shape reflects a shape that crosses over it, and nothing when that shape is under it. *Auto, P and E exact.*
- [ ] **CR-9** Crossings UI. Select a shape that overlaps others, then select two overlapping shapes. *Target:* the Crossings section lists every shape it crosses with Over/Under; with two selected, only their crossing; choosing Over or Under updates the canvas; clicking the crossing on the canvas selects the shape on top.
- [ ] **CR-10** No seams. Import `tests/import-fixture.xml`, make the lower # bar cross over the right one, and look at 1600%. Also build a weave with a translucent and a glass shape. *Target, L:* no hairline, light line or lighter patch along any crossing edge.

## Materials

- [ ] **MT-1** Every material turns with the scene. *Auto, E near*, one part per material (baseline: mean at most 0.27).
- [ ] **MT-2** Every material matches its approved reference image. *Auto, R near.* Skips materials without an image; see Reference images.
- [ ] **MT-3** Shuffle gives a new layout that renders the same every time, for every material Shuffle applies to. *Auto, P.*
- [ ] **MT-4** Each material looks as described. `vt.open(vt.tile({ material: '<id>' }))` for each, and try its settings. *Target, L:*
  - [ ] **matte**, **shiny**: even color; shiny adds a gloss highlight toward the light.
  - [ ] **glass**: a frosted pane that blurs what is behind it; Frost 0 is clear glass, 1 a near-opaque milky pane that keeps its tone.
  - [ ] **jelly**: translucent tinted gel with a glowing inner body, soft rim and highlight on the lit side, and a shadow in its own color.
  - [ ] **enamel**: hard, even color, crisp highlight, metal rim (gold, silver, black nickel, custom) that catches the light.
  - [ ] **ceramic**: broad glaze highlight (glossy, satin, matte), glaze pooling darker toward the edges and thinning at the rim, Speckles, Crackle lines, Reactive glaze runs.
  - [ ] **brushed**, **brushed-round**, **blasted**: straight streaks, circular streaks around a spin center with a hotspot, fine blasted grain.
  - [ ] **chrome**, **gold**, **copper**: a reflected studio (horizon or softbox) bent by the surface and turned toward the light; polished, satin, brushed; chrome Tint; gold tones; copper Patina.
  - [ ] **anodized**: the shape's color with a bright saturated sheen, brushed, radial or bead-blasted.
  - [ ] **hammered**: overlapping round dents, each lit by the scene light.
  - [ ] **marble**: dark or light veins that wander and swell.
  - [ ] **granite**, **terrazzo**, **slate**, **concrete**: speckles; chips in the chip color; layered cleft; pits.
  - [ ] **stucco**: an irregular trowelled relief lit by the light.
  - [ ] **carved**: sharp chiseled facets and deep pits that catch the light.
  - [ ] **wood**: grain in a darker shade of the color; plank, or end grain rings around an off-center pith; Grain direction turns the grain or moves the pith.
  - [ ] **cork**: granules with pores.
  - [ ] **leather**: pebbled grain with faint creases, darker burnished edges, optional stitching.
  - [ ] **paper**: plain, kraft with dark flecks, or laid lines; fibers; crumpled creases; one or two folds lit by the light.
  - [ ] **cardboard**: kraft liner, optional folds and exposed flutes.
  - [ ] **denim**: dyed warp and pale weft twill, fade patches, worn edges, optional stitching.
  - [ ] **canvas**: even over-under weave with holes between threads.
  - [ ] **felt**: dense short fibers and a soft fuzzy outline, also around a frame's hole.
  - [ ] **carbon**: twill whose tows light up with the light direction, optional clear coat.
  - [ ] **holographic**: bands, swirl, glitter or prism in each palette, on the shape color or silver, following the light or a fixed angle, with diffraction lines.
  - [ ] **neon**: a self-lit face with a glow in its own color; a neon frame glows brightest along the middle of its wall.
- [ ] **MT-5** Fine detail. For each textured material, look at 1600% and export at 1024 px. *Target, L:* detail reaches about a quarter canvas unit; thin lines (stitching, laid lines, crackle) are clean vector lines, not torn.
- [ ] **MT-6** No seams. Make a textured shape 100 × 100 with the smallest scale. *Target, L:* no visible tile seams or bands that jump.
- [ ] **MT-7** Shuffle in the UI. *Target:* **Shuffle pattern** only shows for patterned materials (and chrome, gold or copper when not polished, holographic glitter); the layout is saved with the project and, with Apply edits to all variants, is the same in every variant.

## Reflections

- [ ] **RF-1** Only glossy shapes reflect: Reflections does nothing on matte, and shows on shiny. *Auto, E exact and P.*
- [ ] **RF-2** A reflection stays inside the glossy shape. *Auto, E exact* outside the shape.
- [ ] **RF-3** A satin finish reflects less than a glossy one. *Auto, P.*
- [ ] **RF-4** Locking reflections to the light equals setting the same direction by hand. *Auto, E exact.*
- [ ] **RF-5** In the adaptive background layer, a background shape carries the foreground shapes' reflections. *Auto, P.*
- [ ] **RF-6** Look. Put shapes on a shiny plate and on a shiny frame, with Reflections at 1. *Target, L:* a soft, blurred mirror image that drops straight down by default, fades out before the rim and before the hole's edge; the direction pad moves it and changes how far it falls.

## Variants

- [ ] **VA-1** Copy to variants with every part makes the target render like the source; copying only the look keeps the target's colors and geometry. *Auto, E exact and P.*
- [ ] **VA-2** A duplicated variant renders like the original. *Auto, E exact.*
- [ ] **VA-3** Variant strip. Add (+), duplicate, rename (Variant section, Name), and delete variants. *Target:* thumbnails update live as you edit; delete asks first; after a reload the editor reopens the variant you had selected.
- [ ] **VA-4** Apply edits to all variants. Tick it, then move a shape, change its material, the light and the background. *Target:* every variant gets the change (shapes matched by id); variant names stay separate. Check with `vt.doc().variants.map(v => v.shapes[0].x)`.
- [ ] **VA-5** Copy to variants dialog. Open it from **Copy to…** in the shapes list, from the variant strip, and from the Shape section. *Target:* Geometry and Look are ticked by default; Selected shapes or All shapes; All and None for the target list; "The ticked variants" changes them, "New copies" leaves them and adds copies; the summary line matches what happens.

## VectorDrawable import

- [ ] **IM-1** Imported shapes cover exactly what the drawing covers. *Auto, P* on `tests/import-fixture.xml`: the covered area matches on a 0.4-unit grid; the # becomes four bars; the frame and the stroked ring become hollow with walls 4 and 3; alpha comes along; the free curve and the open stroke are reported as skipped.
- [ ] **IM-2** Import in the UI. Click **Import…** and pick the fixture, then drop it on the page. *Target:* a toast says how many shapes came in and lists the skipped paths; the new shapes are selected.
- [ ] **IM-3** Tracing guide. *Target:* the whole drawing shows faintly over the canvas; the checkbox hides it; **Remove** removes it; it is saved with the project; and it never appears in exports (export the Play Store PNG with the guide showing and after Remove; E exact).
- [ ] **IM-4** A drawing that is not 108dp. Import a 48dp icon (a 48 × 48 viewport). *Target:* it is centered at 49.5 units, the size a launcher foreground gives a 24dp icon, so a # drawn from 16 to 32 lands at 45.75 to 62.25.
- [ ] **IM-5** Import with Apply edits to all variants ticked. *Target:* the shapes go into every variant.

## Export

- [ ] **EX-1** The launcher view is the center 72dp of the whole canvas. *Auto, E near.*
- [ ] **EX-2** Circle, rounded square and squircle masks cut the corners and keep the middle; None keeps the corners. *Auto, P.*
- [ ] **EX-3** Adaptive layers split the shapes: the foreground layer has no background color and no background shapes; the background layer equals the background shapes alone. *Auto, P and E exact.*
- [ ] **EX-4** Presets and custom sizes list the right files: Play Store 512, legacy launcher at five densities (48 to 192 px), adaptive layers at five densities (108 to 432 px) plus both `mipmap-anydpi-v26` XML files, custom sizes 16 to 4096 without repeats, and one folder per variant for all variants. *Auto, P.*
- [ ] **EX-5** Dialog. Open **Export PNG…**, change each option. *Target:* the preview and the summary update; "All variants (N)" shows the count; Area and Mask do not apply to adaptive layers (the hint says so).
- [ ] **EX-6** Downloads. Export one file, then several. *Target:* one file downloads directly; several download as one zip. `unzip -l` shows `play-store-512.png`, `mipmap-<density>/ic_launcher.png`, `ic_launcher_foreground.png`, `ic_launcher_background.png` and `mipmap-anydpi-v26/ic_launcher.xml` and `ic_launcher_round.xml`, in one folder per variant for all variants.
- [ ] **EX-7** File contents. *Target:* every PNG has the size its name promises (`python3 -c "from PIL import Image; print(Image.open('x.png').size)"`); the XML points at `@mipmap/ic_launcher_background` and `@mipmap/ic_launcher_foreground`; adaptive layers ignore the mask and area settings.
- [ ] **EX-8** Preview against export. Follow "Preview against export" above at Fit and at 800%. *Target:* E near.
