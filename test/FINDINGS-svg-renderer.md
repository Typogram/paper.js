# SVG renderer: test coverage and findings

What came out of writing `test/tests/SvgView.js` against `src/view/SvgView.js`
(the renderer added in 1b2b972b). Two things are recorded here: where the SVG
renderer and the Canvas2D renderer disagree, and where the renderer is simply
not covered yet.

The suite is browser-only — it inspects the rendered DOM — and runs from
`test/index.html`, or through `gulp test:browser`.

## What is covered now

| | before | after |
| --- | --- | --- |
| tests | 16 | 70 |
| assertions | 109 | 543 |

`QUnit.module('SvgView')` — 62 tests, 454 assertions — covers renderer
selection and element takeover, the view API against `CanvasView`, text
measurement parity, geometry for every item class, change tracking, the scene
graph (insert / remove / reorder / nest / clip / clear), the full style
surface, gradients, shadows, blend modes, text, rasters, symbols, the
selection overlay, and interop (hit-testing, `rasterize()`, `importSVG` /
`exportSVG`, JSON round-trips).

`QUnit.module('SvgView divergences')` — 8 tests, 89 assertions — pins the
behaviour that does *not* match the canvas renderer, so each gap below is
executable rather than folklore. **A red test in that module means a gap was
closed**, not that something broke: turn the assertion around and move the
entry here into "fixed".

Full suite after the change: 15687 of 15693 assertions pass. The 6 failures
are pre-existing, all in `Path Boolean Operations`, and unrelated to the
renderer — the same 6 fail on this tree with these tests removed (measured
before the change: 15253 of 15259).

## Divergences from the canvas renderer

Ordered by how likely they are to be noticed in a real document. The numbers
are stable ids, not a sequence — an entry keeps its number when it moves to
**Fixed**, so the `GAP n` test names stay meaningful across commits.

## Fixed so far

### 1. A clip mask was clipped by the wrong winding rule

`Item#draw()` passes the fill rule to the canvas explicitly —
`ctx.clip(this.getFillRule())` in [src/item/Item.js:4520](src/item/Item.js#L4520),
added upstream for exactly this case (paperjs/paper.js#1361). The SVG renderer
wrote `fill-rule` and nothing else, but inside a `<clipPath>` SVG reads
**`clip-rule`**; `fill-rule` has no effect there. An even-odd clip mask — a
compound path with a hole, which is the usual way to punch one — clipped as
non-zero and the hole disappeared.

`_updateStyle()` now writes `clip-rule` alongside `fill-rule`, under the same
non-default-only guard. It is written there rather than in `_setClip()` so that
it stays current when the rule changes afterwards: that is a `Change.STYLE`,
which reaches `_updateStyle()` but never `_setClip()`. The attribute is inert
on nodes that are not inside a `<clipPath>`.

A *group* used as a clip item still gets nothing of its own, because
`_updateStyle()` returns early for groups — but its children are ordinary items
that each get their own `clip-rule`, and `clip-rule` inherits, so the clip
resolves correctly regardless.

Verified at the pixel level as well as by attribute: serialized to a data URL
and drawn onto a canvas, the centre of the donut is transparent with the
attribute and opaque red without it.

Covered by: *A clip item is clipped by the rule it asks for*.

### 2. With two clip masks, the last one won instead of the first

`Group#_getClipItem()` ([src/item/Group.js:109](src/item/Group.js#L109)) takes
the **first** child with `_clipMask` and stops; `Group#_draw()` then draws every
other child normally, the second clip mask included.

`_syncChildren()` derived the clip item again for itself, assigning
`clipItem = child` on every clip-mask child so the **last** one won — and
because each of them hit `continue`, none of the others were drawn at all.

It now calls `owner._getClipItem()` instead of deciding again, so there is one
answer to the question rather than two. The cache behind it is already
invalidated correctly: `Item#setClipMask()` notifies the parent with
`ChangeFlag.CLIPPING`, `Group#_changed()` clears `_clipItem` on
`CHILDREN | CLIPPING`, and `CLIPPING` is in the renderer's own `childrenFlags`,
so it is current by the time the owner is synchronized.

A `Project` has no `_getClipItem`, so this also drops clipping at the project
level — which the canvas renderer does not do either (`Project#draw()` just
draws its children), and which previously emitted a `clipPath` keyed
`id="…-clip-undefined"`, since a project has no `_id`.

Covered by: *With two clip masks, the first one clips and the rest are drawn*,
*A project is not clipped by a layer*.

### 2b. Promoting an existing child to clip mask threw its node away

Found while testing #2, and older than it — the same fault is in the original
code. The clip item is skipped in the walk that positions the siblings, so it
ends up trailing them; the sweep that follows treats anything past the last
child as removed and disposes it. A child that was already rendered and then
had `clipMask` set therefore lost its node, and `_setClip()` — running after
the sweep — found nothing to put in the `clipPath`. The group ended up clipped
by an empty path, which hides everything in it.

It only stayed hidden because the usual way in is `group.clipped = true` at
construction, where the child has no sibling node position yet.

`_setClip()` now runs *before* the sweep, so the clip node is moved into its
definition while it is still alive.

Covered by: *Promoting an existing child to clip mask keeps its node*.

### 3. `Raster#smoothing` did not take effect until something else changed

`Raster#setSmoothing()` reports `Change.ATTRIBUTE`
([src/item/Raster.js:514](src/item/Raster.js#L514)), which is what it is — an
appearance change, not a geometric one — and is right for canvas, which redraws
wholesale. `_updateItem()` routes `ATTRIBUTE` into `styleFlags` and so to
`_updateStyle()`, but `image-rendering` was written by `_updateGeometry()`. The
attribute therefore kept whatever the last *geometry* change had left, and only
caught up when an unrelated move or resize came along: set `smoothing = 'off'`
and nothing happened until you nudged the raster, at which point it snapped to
pixelated. Both directions were affected.

The write moved to `_updateStyle()`, as a `Raster` branch beside the existing
`PointText` one. The `__src` caching in `_updateGeometry()` — what keeps a move
from re-encoding the pixels — is untouched.

Covered by: *Raster#smoothing reaches the node as soon as it is set*.

## Still open

### 4. Reparenting into an existing group throws the node away

Moving an item between two groups queues two changes: `CHILDREN` on the old
owner and `INSERTION` on the item. `_processChanges()` collects owners in the
order it meets them, so the old owner is synchronized first — at which point
the node has not moved yet, so the trailing-children sweep in `_syncChildren()`
disposes it. The new owner then finds no node and builds a fresh one, along
with the whole subtree below it.

Nothing renders wrongly, but the renderer's central promise — one DOM node per
item, kept alive and updated in place — does not hold for reparenting. Anything
attached to that node is lost with it: CSS transitions in flight, a caching
`__src`, anything an application put on the element.

It works when the destination group is created in the same batch
(`new Group([item])`), because that group has no node yet when the old owner is
swept — which is why the original test for this passed.

Fix: synchronize the gaining owner before the losing one, or move the node out
of the old parent when the insertion is processed rather than during the sweep.

Pinned by: *GAP 4: reparenting into an existing group rebuilds the node*.

### 5. A raster re-encodes its pixels when it is reparented

Follows directly from #4: the rebuilt `<image>` has no `__src` cached, so the
pixels are serialized again — a full PNG encode for a canvas-backed raster.
`_updateGeometry()` goes to real trouble to avoid exactly this on every move,
and a reparent defeats it.

Pinned by: *GAP 5: a raster re-encodes its pixels when it is reparented*.

### 6. Symbol definitions are never released

`_updateSymbol()` keys definitions by `SymbolDefinition._id` and only ever adds
to `this._symbols` and `this._defs`. When the last `SymbolItem` using a
definition is removed, its `<g>` stays in the defs and the items inside it keep
their entries in `this._nodes`.

Bounded by the number of distinct definitions rather than by placements, so it
is a slow leak rather than a bad one — but a document that creates and discards
symbols (an editor with an undo stack) grows without limit.

Pinned by: *GAP 6: a symbol definition is never released*.

### 7. A singular matrix is written out rather than skipped

`Item#draw()` returns early when the global matrix is not invertible
([src/item/Item.js:4410](src/item/Item.js#L4410)). The SVG renderer writes the
matrix as it is. Browsers do not render an element under a singular transform,
so the two agree on screen — but the node, its definitions and its whole
subtree stay live and keep being updated, where the canvas renderer does no
work at all.

Pinned by: *GAP 7: a singular matrix is written out rather than skipped*.

### 8. `SvgView` has no `getContext()`

`CanvasView#getContext()` is public API. There is no SVG equivalent, and the
renderer does not offer a stand-in, so application code that reaches for the 2D
context has to be rewritten around `Item#rasterize()`. `src/view/README.md`
covers the `toDataURL()` half of this; the context getter itself is the sharper
edge, since it is what most such code actually calls.

Pinned by: *GAP 8: SvgView has no getContext()*.

### Already documented in `src/view/README.md`

Confirmed by the tests, listed here so the picture is complete:

- **Four blend modes render as `normal`** — `subtract`, `average`, `pin-light`
  and `negation`, which `BlendMode` emulates in JavaScript for the canvas
  renderer. The other 16 map to CSS, `add` to `plus-lighter`. The full table is
  asserted in *Blend modes map to CSS, or to nothing at all*.
- **The element is swapped** when the view is handed a `<canvas>`.
- **Text measurement** still goes through an offscreen canvas context. The
  tests check that both renderers return the same widths, so item bounds do not
  depend on the renderer.

### Not a divergence, worth knowing

- **`view.pixelRatio` is always 1.** SVG is resolution independent, so there is
  no HiDPI upscaling to do and this is correct — but code that reads
  `view.pixelRatio` to size something itself will see a different number than
  it did under `CanvasView`. A `hidpi` attribute on the element is carried over
  to the `<svg>` and then ignored.
- **`paper.settings.renderer` defaults to `'svg'` in this fork**
  ([src/core/PaperScope.js:56](src/core/PaperScope.js#L56)), where upstream has
  no such setting. `test/helpers.js` pins it back to `'canvas'` for the shared
  suite, which compares rendered pixels. Any downstream project with its own
  paper.js tests needs the same pin, or those tests will quietly start running
  against a renderer they were not written for.

## A leak in the tests themselves, also fixed

**The SvgView tests leaked their active scope.** Item constructors insert into
whichever `PaperScope` is active, and these tests open scopes of their own and
activate them — but nothing put the harness's scope back afterwards. It stayed
harmless only because `SvgView.js` is included last in `test/tests/load.js`, so
nothing ran after it. It surfaced as soon as QUnit's `reorder` (which runs
previously-failed tests first, from sessionStorage) moved one SvgView test to
the front: 69 of the 618 tests then ran inside a leaked SVG scope, and roughly
70 failed with `Cannot read properties of null`.

`svgViewTeardown()` now closes every scope a test opened and re-activates the
one the harness set the test up in. Measured with temporary instrumentation in
`test()`: 69 tests running in a foreign scope before, 0 after, across all 618.

## Not covered yet

Where the coverage stops, so the next person does not have to rediscover it:

- **Pixel parity.** Nothing renders both renderers and compares the result.
  The suite's `comparePixels()` helper goes through `Item#rasterize()`, which
  uses a canvas in both cases, so it cannot see an SVG-side difference — #1 and
  #3 above are exactly the kind of bug only an image diff would catch.
  Serializing the `<svg>` into an `<img>` and drawing that onto a canvas would
  work, at the cost of an async, timing-sensitive test.
- **Tools and mouse events.** `test/tests/Interactions.js` drives real events
  against a `CanvasView`. The tests here check that the content and overlay
  groups are `pointer-events: none` and that `hitTest()` agrees, which is the
  mechanism — but no tool event is actually delivered through an `<svg>`.
- **The `resize` attribute and `View#onResize`.**
- **`View#autoUpdate` and the requestAnimationFrame loop**, including
  `onFrame`. Every test here calls `update()` by hand.
- **Asynchronous raster sources** beyond the one image-load test: a `Raster`
  whose URL resolves after several frames, `crossOrigin`, and `onLoad`.
- **Deep scenes.** No test builds enough items to exercise the performance
  claims in `src/view/README.md`, in either direction.
- **`Item#guide`, `Item#locked`, `Item#selectedColor` on a layer**, and
  `Shape` with a non-uniform scale and a non-scaling stroke.
- **Node / worker contexts.** `SvgView` is browser-only by construction;
  `View.create()` falls back to the base `View` where there is no `window`.
