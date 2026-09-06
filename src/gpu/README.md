# GPU rendering backend (WebGL2)

An **opt-in** GPU rasterizer for Paper.js. The public API is unchanged: nothing
here is reachable unless a view explicitly asks for it.

```html
<canvas id="c" resize data-paper-renderer="webgl"></canvas>
```

```js
paper.settings.renderer = 'webgl';  // 'canvas' (default) | 'webgl' | 'auto'
```

`'auto'` picks the GPU renderer where WebGL2 is available and falls back to
canvas otherwise. An explicit `'webgl'` on a machine without WebGL2 warns once
and falls back too — it never throws.

## How it works

Paper.js reaches the rasterizer only through a `ctx` argument, threaded from
`View#update` → `Project#draw` → `Item#draw` → each item's `_draw()`. Nothing in
the drawing path looks up a canvas of its own, and the whole Canvas2D surface
the library uses is about 50 members.

So the substitution point is the **context**, not the renderer. `GLContext` is a
duck-typed stand-in for `CanvasRenderingContext2D`; with it in place, the scene
traversal, `Item#_setStyles`, group compositing and selection drawing all run
unmodified. `Color#toCanvasStyle()` builds gradients purely by calling
`ctx.createLinearGradient()` and `addColorStop()`, so gradients work with no
change to `Color.js` at all.

| File | Role |
| --- | --- |
| `GLDevice.js` | WebGL2 context, programs, the shared vertex buffer, global state |
| `GLShaders.js` | GLSL sources (solid, gradient, image, stencil) |
| `GLPath.js` | Path recording and adaptive bézier flattening, in device space |
| `GLStroker.js` | Stroke expansion: segment quads, joins, caps |
| `GLGradient.js` | `CanvasGradient` stand-in, baked to a 256px ramp texture |
| `GLContext.js` | The Canvas2D façade and the rasterization passes |
| `../view/GLView.js` | The `View` subclass; mirrors `CanvasView` |

**Fills** use stencil-then-cover: contours are drawn as triangle fans into the
stencil buffer under the requested winding rule, then a bounding quad is shaded
wherever the stencil says the pixel is inside. No CPU tessellation is involved,
which matters because self-intersecting and multi-contour paths are exactly what
`CompoundPath` and the boolean operations produce.

**Strokes** run through the same machinery with a union rule, so overlapping
join and cap geometry contributes coverage once and translucent strokes do not
double-blend along their own seams.

**Clips** are kept as geometry, not as a stencil snapshot, and are re-rasterized
only when the clip stack actually changes — that is what makes `save()` and
`restore()` free. The clip occupies the top stencil bit; the winding counter
gets the low seven.

## What works

Fills (nonzero and even-odd), compound paths and holes, strokes with all caps
and joins, transforms, opacity, clipping, linear and radial gradients, images
and rasters, text, `getImageData`/`putImageData`, `isPointInPath`.

## What is not implemented yet

Each warns once to the console and is then ignored, rather than rendering
something subtly wrong:

- **Blend modes** other than `source-over`. `Item#draw` routes non-direct items
  through a temporary context and `BlendMode.process`; the GL equivalent needs a
  render-target provider plus the blend maths as shaders.
- **Shadows** (`shadowBlur` / `shadowOffset`), which need an offscreen pass and
  a separable Gaussian blur.
- **Dashed strokes** (`setLineDash`). Note that `paper.support.nativeDash` is
  computed once from a 2D context and lives on `PaperScope.prototype`, so
  `Path#_draw` does not fall back to `PathFlattener` for us.
- **Patterns** (`createPattern`) and gradient-filled **text**.

Text currently rasterizes one bitmap per distinct run into a bounded cache. That
is exact but memory-hungry for highly dynamic text; a shared glyph atlas is the
proper fix.

## Testing

Build a bundle first — `gulp` 3 does not run on modern Node, so use the
stand-in:

```sh
node tools/build.js            # -> dist/paper-gl.js
```

```sh
node test/gl/run.js            # render every scene through both renderers and diff
node test/gl/run.js --write-images
node test/gl/regression.js <baseline-bundle>   # canvas output must not move
node test/gl/bench.js          # canvas vs GL timings
```

`test/gl/run.js` is the important one: it renders each scene through both
renderers and fails if more than 3.5% of pixels differ by more than 24 per
channel. Antialiasing will never match Canvas2D exactly, so the metric is the
share of differing pixels, not whether any differ. All twelve scenes currently
land between 0.03% and 0.78%, which is edge antialiasing alone.

The library's own QUnit suite (`test/index.html`) does not run under modern
Chromium on this commit — it fails identically on unmodified `develop` — so
`test/gl/regression.js` stands in as the guard on the default path: it replays
every scene through the canvas renderer using two different builds and requires
the results to be identical, pixel for pixel.

## Performance: read this before building on it

Measured in headless Chromium (SwiftShader, i.e. **software** WebGL — a floor,
not representative of real hardware), 30 full redraws with the scene rotating
each frame:

| items | canvas | webgl | ratio |
| --- | --- | --- | --- |
| 100 circles | 1.06 ms | 8.16 ms | 0.13× |
| 500 circles | 2.94 ms | 30.42 ms | 0.10× |
| 2000 circles | 11.63 ms | 279.94 ms | 0.04× |
| 8000 circles | 38.56 ms | 459.56 ms | 0.08× |
| 500 stroked | 3.70 ms | 261.34 ms | 0.01× |

**The GPU backend is currently much slower than Canvas2D.** Two reasons, and
only one of them is the software rasterizer:

1. SwiftShader has no GPU behind it, so every fragment is CPU work anyway.
2. More importantly, this implementation issues **four to six draw calls per
   item** — a stencil pass, a cover pass, a program switch and a full vertex
   buffer re-upload each time — with no batching whatsoever. At 8000 items that
   is roughly 40,000 draw calls per frame, which would be slow on real hardware
   too.

This is the outcome the plan predicted: correctness first, and the speed comes
only from the batching phase. Before investing further, run `test/gl/bench.js`
on real hardware, then implement batching (group consecutive items sharing a
pipeline and paint into one draw call, and cache flattened and stencil geometry
per `Path` keyed by `_version`, which Paper already bumps in `_changed`). If the
numbers do not move decisively after that, the honest conclusion is that
Canvas2D is the right renderer for most Paper.js scenes and this backend should
stay a niche option.
