# Icon Recomposer

A browser editor for lit, layered app icons. Place shapes, give them depth and material under one light, keep many variants side by side, and export them all as ready-to-use PNGs.

**Live:** https://iboalali.com/Icon-Recomposer/ (Chrome)

## Using it

- **Add shapes** (rectangles and ellipses) and move, resize and rotate them on the canvas. Arrow keys nudge, Shift snaps.
- **Style each shape:** color, material (matte, shiny, frosted glass, brushed, blasted), surface (flat, concave, convex, groove), elevation, thickness, rounded or beveled edges, and glow. More knobs are under **Advanced**.
- **Set the light:** drag the dot in the light pad, and adjust key and fill light. The light shades every shape and the background.
- **Make variants:** duplicate the current variant from the strip under the canvas and change colors, light or anything else. Turn on **Apply edits to all variants** to change every variant at once.
- **Choose layers:** each shape belongs to the adaptive icon's foreground or background layer.
- **Import a VectorDrawable** to start from an existing Android icon: simple shapes and straight-edged outlines become editable shapes, and the whole drawing stays visible as a tracing guide.
- **Export PNG:** Play Store 512 px, legacy launcher icons at every density, adaptive icon layers with their XML, or custom sizes, for one variant or all. Several files download as one zip laid out like an Android `res/` folder.
- Work is saved in the browser automatically. **Save** and **Open** use `.icjson` project files.

## How it works

The icon is plain HTML styled by [ambientcss](https://github.com/kikkupico/ambientcss) (MIT, vendored in `vendor/ambientcss/`). The editor shows it in a shadow root. Export wraps the same markup in an SVG `<foreignObject>`, which Chrome paints straight onto a canvas at the output size, so the PNG matches the preview at any resolution.

No build step and no dependencies. Serve the folder and open `index.html`:

```
python3 -m http.server
```

## Credits

Lighting model and materials: [ambientcss](https://github.com/kikkupico/ambientcss) by Ramakrishnan Veeraragavan, MIT license.
