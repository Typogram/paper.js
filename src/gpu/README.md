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

## Using this fork in an app

`dist/paper-full.js` is committed on this branch, so the package needs no build
step at install time. The public API is identical to upstream 0.12.18, so an
app's existing `import paper from 'paper'` keeps working unchanged.

**Tarball (recommended).** A git dependency does not work reliably: npm installs
a git dependency's devDependencies, and `canvas` — pulled in transitively via
`jsdom` — needs Cairo headers and aborts the install wherever they are missing.
Packing sidesteps devDependencies entirely:

```sh
git clone -b <this-branch> https://github.com/Typogram/paper.js
cd paper.js && npm pack          # -> paper-0.12.18.tgz
```

Then in the app, commit the tarball (or host it) and point at it:

```json
"dependencies": {
  "paper": "file:vendor/paper-0.12.18.tgz"
}
```

**Git dependency**, if `canvas` builds in every environment that runs
`npm install` (`brew install cairo pango` on macOS,
`apt install libcairo2-dev libpango1.0-dev` on Debian):

```json
"paper": "github:Typogram/paper.js#<this-branch>"
```

### Turning the renderer on

Nothing changes until a view opts in, so the switch can be made one canvas at a
time and reverted instantly:

```svelte
<canvas bind:this={canvasElement} data-paper-renderer="webgl"></canvas>
```

or globally, before any `setup()` call:

```js
paper.settings.renderer = 'auto';  // GPU where WebGL2 exists, canvas otherwise
```

`paper.settings` is per-`PaperScope`, so an app that creates several scopes has
to set it on each one, or use the attribute.

Read the performance section below before switching anything user-facing on.

## Testing

`dist/paper-full.js` is committed on this branch, so the pages below work as
checked out. After changing anything under `src/`, rebuild it — `gulp` 3 does
not run on modern Node, so use the stand-in:

```sh
node tools/build.js           # -> dist/paper-full.js
node tools/build.js --core    # -> dist/paper-core.js
```

```sh
node test/gl/run.js            # render every scene through both renderers and diff
node test/gl/run.js --write-images
node test/gl/animated.js        # drive transforms, then diff (catches stale caches)
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

## Geometry caching

Tessellation is cached per item and reused while the item's geometry is
unchanged, with the transform applied by the vertex shader (`u_matrix`) instead
of being baked into the coordinates on the CPU. Paths are therefore recorded in
their own space, and `Path#_version` — which Paper.js bumps only on real
segment edits — is the invalidation signal.

This needs one addition in core, in `Item#draw`:

```js
var prevItem = ctx._currentItem;
ctx._currentItem = this;
this._draw(ctx, param, viewMatrix, strokeMatrix);
ctx._currentItem = prevItem;
```

A Canvas2D context accepts and ignores the property, so the default renderer is
byte-for-byte unaffected (`test/gl/regression.js` checks exactly that). Only
`Path` carries `_version`; every other item type tessellates each frame as
before.

**It only pays off with `applyMatrix: false`.** Paper.js's default is `true`,
which means a transform *rewrites every segment coordinate in place* — the
geometry genuinely changed, there is nothing to reuse, and the measured hit rate
is 0%. Turning it off keeps the transform on the item as a matrix and the hit
rate goes to 95%:

```js
item.applyMatrix = false;   // or paper.settings.applyMatrix = false
```

### A latent bug this surfaced

`Segment#_transformCoordinates` writes new coordinates directly into the point
objects, bypassing the setters that call `_changed()`, and `Item#transform()`
then reports only `Change.MATRIX`. So with `applyMatrix: true` every segment
changed while `Path#_version` stood still. `Path#_transformContent` now bumps
it. Without that fix a cache keyed on `_version` renders visibly stale geometry
— 14% of pixels wrong in `test/gl/animated.js`, which exists to catch exactly
this. The same staleness applies to any other `_version` consumer, which
upstream is `CurveLocation`.

### A second one: clip masks baked against the wrong matrix

Recording paths in local space instead of transforming them immediately (the
change above) has a second consequence: `clip()` has to bake the CTM into the
clip geometry itself, since nothing downstream re-applies a per-shape matrix
to clip triangles. Which CTM, though, matters. `Item#draw()` calls
`ctx.clip()` only *after* `ctx.restore()` — this mirrors Canvas2D, where
`clip()` just reuses the path that was already recorded, in device space, at
`moveTo()`/`lineTo()` time, so it does not matter that the matrix has since
been popped off the stack. Here it does: reading `state.matrix` at the point
`clip()` runs reads the *parent's* matrix, not the clip item's own.

`Path`-based clip masks mostly hid this by coincidence — the geometry a
`Path` bakes at `applyMatrix: true` time already has the transform folded
into its segment coordinates, so the CTM active when `clip()` ran didn't
matter. `Shape` cannot do that (`applyMatrix` is always `false` for `Shape`;
see above), so it depends entirely on the CTM at draw time — and SVG import
auto-generates exactly this: a `Shape` clip mask, translated to the middle
of the viewBox, as the first child of an imported group. Importing any SVG
with a viewBox rendered only the fraction of content that happened to fall
under the *parent's* untransformed clip rectangle.

The fix captures the matrix once, in `beginPath()`, while the path is being
built and the correct matrix is still guaranteed to be current, and has
`clip()` read that instead of `state.matrix`:

```js
beginPath: function() {
    ...
    this._pathMatrix = this._state.matrix;
},
```

`fill()` and `stroke()` are unaffected — both are always called from within
the same item's `_draw()`, before its `ctx.restore()`, so `state.matrix` was
already correct for them. `test/gl/compare.html`'s `clipTranslatedShapeInGroup`
scene is the regression test: a translated `Shape` clip mask nested inside a
translated `Group`, which fails at 24.7% pixel difference without the fix
and passes at 0.75% with it.

## Batching

Solid-painted shapes are queued instead of drawn, and the queue is rasterized
in a handful of draw calls rather than two per shape:

| scene | before | after |
| --- | --- | --- |
| 1000 filled circles | ~2000 draw calls | 48 |
| 1000 filled + stroked circles | ~4000 draw calls | 100 |

Three things make it work.

**Disjoint stencil bits per rule.** `Path#_draw` emits `fill()` then `stroke()`,
and the two always overlap, so a single shared winding counter would force a
flush between them - which is exactly what happened in the first version, and
why stroked scenes saw no benefit at all. The nonzero counter now lives in
`0x3f` and the union bit in `0x40`, so a fill and a stroke accumulate in the
same pass without touching each other. (Even-odd is left on the direct path;
it is rare and would need a third allocation.)

**An occupancy grid.** Two shapes may share a stencil pass only if they cannot
corrupt each other's coverage, so bounds are tested against a coarse grid of
32px cells. Cells record their owning item, which is what allows the one
overlap that must be permitted - an item's own fill and stroke - while still
rejecting overlap between different items. An overlapping shape flushes the
batch, which keeps painter order exact.

**Transform on the CPU, into the batch.** A batch has one buffer and many
transforms, so the per-item `u_matrix` uniform cannot be used and coordinates
are transformed as they are appended. The tessellation cache still holds: what
is paid per frame is a matrix multiply per vertex, not a re-flattening. That
accumulation is the hottest loop in the renderer and writes into a growable
`Float32Array` by index - an earlier version used a plain Array and
`Float32Array#set()`, whose per-element boxing conversion cost more than the
draw calls the batching saved.

Batching can be disabled at runtime for measurement:

```js
view.getContext()._batchEnabled = false;
```

### Round joins emit a wedge, not a disc

A round join used to emit a whole disc at every vertex. A flattened curve has
a join per segment, each turning a few degrees, so that was by far the largest
source of stroke geometry. Only the outer corner is ever missing between two
segment quads, so only that wedge is emitted now: 500 round-joined stroked
circles went from 1,318,263 vertices a frame to 478,263, and 140ms to 104ms.

Note that Paper.js defaults `strokeJoin` to `'miter'`, so this only shows up on
content that asks for round joins.

### What is not yet measurable here

The draw-call reduction is exact and reproducible. The wall-clock benefit is
**not verified**: this environment only has SwiftShader, a software rasterizer,
where draw calls are nearly free and fragment work dominates - the opposite of
the cost model batching targets. Measurements there are also unstable, since
without a per-frame `gl.finish()` the command queue back-pressures and the
timing absorbs driver stalls. Toggling batching within one page - the lowest-variance
comparison available - repeatedly showed filled scenes ~3x faster and
filled-and-stroked ones 18-47% *slower*, with the magnitude drifting ~25%
between runs of identical code. The direction is consistent; the size is not.

The likely reason strokes regress *here*: batching transforms vertices on the
CPU, which the per-item uniform avoided, and stroke geometry has many vertices.
Where draw calls are nearly free, that trade loses. Where they are not - a real
GPU - 1964 draw calls becoming 28 should dominate it.

Run `test/gl/bench.js` on real hardware, or flip the demo's batching toggle,
before drawing any conclusion about speed.

## Performance: read this before building on it

All numbers below come from headless Chromium on SwiftShader — **software**
WebGL, a floor rather than a prediction for real hardware. Software
rasterization also inflates per-fragment cost, which shifts the balance away
from the CPU-side work the cache targets.

### What the geometry cache is worth

Minimum of 5 runs, 20 frames each, same build with the cache toggled:

| scene | cache off | cache on | speedup | hit rate |
| --- | --- | --- | --- | --- |
| 100 circles, applyMatrix off | 2.33 ms | 2.30 ms | 1.02× | 95% |
| 500 circles, applyMatrix off | 24.56 ms | 23.52 ms | 1.04× | 95% |
| 100 stroked, applyMatrix off | 18.12 ms | 19.56 ms | 0.93× | 95% |
| 500 stroked, applyMatrix off | 35.72 ms | 24.13 ms | 1.48× | 95% |
| any scene, applyMatrix on (default) | — | — | ~1× (noise) | 0% |

Strokes gain most, because expanding a polyline into join and cap geometry is
the most expensive CPU step. Fills gain little.

### Where the time actually goes

**Caching geometry does not close the gap with Canvas2D**, and that is the
useful result. Draw-call overhead dominates: the backend still issues four to
six calls per item — a stencil pass, a cover pass, a program switch and a
buffer upload each — so at 2000 items it is making roughly 10,000 draw calls a
frame. Removing CPU tessellation from that picture changes a small share of the
total.

| items | canvas | webgl | ratio |
| --- | --- | --- | --- |
| 100 circles | 0.57 ms | 5.38 ms | 0.11× |
| 500 circles | 1.84 ms | 20.78 ms | 0.09× |
| 2000 circles | 6.44 ms | 160.77 ms | 0.04× |
| 8000 circles | 23.05 ms | 459.44 ms | 0.05× |

**Batching is the next thing to build, and the evidence now says so rather than
just predicting it**: group items that share a program and paint into one
vertex buffer and one `drawArrays`, instead of a stencil/cover pair per item.
After that, skipping the stencil pass entirely for convex shapes, and instanced
signed-distance rendering for large numbers of small marks, are the follow-ups.
Until batching lands, Canvas2D remains the right default for Paper.js scenes.
