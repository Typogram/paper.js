# The SVG renderer

`SvgView` renders a project into a native SVG DOM tree instead of rasterizing it
into a 2D canvas on every frame. It is a drop-in sibling of `CanvasView`: the
Paper.js API is identical, and which one a project uses is configuration.

## Turning it on

Nothing changes until a view opts in, so the switch can be made one view at a
time and reverted instantly:

```html
<canvas data-paper-renderer="svg"></canvas>
```

or globally, before any `setup()` call:

```js
paper.settings.renderer = 'svg';
```

`paper.settings` is per-`PaperScope`, so an app that creates several scopes has
to set it on each one, or use the attribute. Passing an `<svg>` element to
`paper.setup()` selects the renderer too.

When it is handed a `<canvas>`, the view creates an `<svg>` element, copies the
canvas's id, classes, styling and `data-paper-*` attributes onto it, and
replaces it in the DOM. An app that keeps its own reference to that canvas (a
framework `ref` / `bind:this`, or listeners bound to it) should render an
`<svg>` element itself and hand that over instead, so the reference stays live.

## How it works

One DOM node per item, kept alive and updated in place. The view learns which
items changed through the change tracking in `Project#_changed()`, which it
activates on the project it renders, so an update only touches the items that
actually changed rather than walking the scene.

The view matrix lives on the root `<g>`, so panning and zooming cost one
`transform` attribute update regardless of how many items the project holds.
Nothing about the items themselves changes, and the browser's retained render
tree — which already holds the rasterized geometry and skips what is off screen
— does the rest.

Geometry, styles, gradients, clipping, symbols, text and rasters are mirrored.
Selection handles are drawn into an overlay group by reusing
`Item#_drawSelection()` through a context stand-in that records its drawing
commands as path data, so handles match the canvas renderer exactly.

Hit-testing, events and tools are unchanged: `Project#hitTest()` walks the scene
graph and tests geometry in both renderers, and pointer events reach the same
handlers. Pointer events are switched off on the content group so they always
land on the `<svg>` element itself, which is the one `View`'s event handling
knows about.

## What it costs

The trade is per-frame work for per-change work:

- **Setup and memory.** Every item becomes a live DOM node. Building a 100,000
  item scene takes noticeably longer than the first canvas draw, and the nodes
  stay resident.
- **Bulk changes.** Changing every item in one frame is more expensive here than
  a redraw would be — the canvas renderer pays that cost on every frame anyway,
  this one pays it only when it happens.
- **Text measurement** still uses an offscreen 1×1 canvas context, since SVG
  cannot measure text without laying it out.

It wins wherever the document is large and the camera moves more often than the
content does, which is the usual editor workload.

## Where it differs from the canvas renderer

- **Five blend modes render as `normal`.** `add` maps to CSS `plus-lighter`,
  and the other 15 of Paper.js's modes map to the CSS mode of the same name.
  `subtract`, `average`, `pin-light` and `negation` have no CSS equivalent —
  `BlendMode` emulates those in JavaScript for the canvas renderer, which is
  not something a DOM tree can do.
- **The element is swapped.** Handed a `<canvas>`, the view replaces it with an
  `<svg>` and puts the original back in `remove()`. Code that holds its own
  reference to that canvas (a framework `ref`, listeners bound to it, or
  `canvas.toDataURL()` for a thumbnail) should render an `<svg>` element
  itself, or opt that view out with `renderer="canvas"`. To read pixels, go
  through `Item#rasterize()`, which makes its own canvas either way.
- **Text measurement** still uses an offscreen canvas context, as noted above.

## Using this fork in an app

`dist/paper-full.js` is committed on this branch, so the package needs no build
step at install time. The public API is identical to upstream 0.12.18, so an
app's existing `import paper from 'paper'` keeps working unchanged.

**The `dist-only` branch (recommended).** `tools/make-dist-branch.js` generates
a branch holding the built bundles and upstream's own package.json, and nothing
else. Install straight from it:

```sh
npm i github:Typogram/paper.js#dist-only
```

That package declares no devDependencies, which is what makes this work: a git
dependency on a development branch would pull in `canvas` transitively via
`jsdom`, and `canvas` needs Cairo headers and aborts the install wherever they
are missing. The dist-only branch has neither, so the install is one package and
no build step.

It also carries upstream's package name, so it installs as `paper` rather than
under a scoped name, and an app's existing `import paper from 'paper'` keeps
working unchanged.

**Tarball.** Where a git dependency is not an option — an air-gapped build, or a
vendored dependency policy — pack the dist-only branch instead:

```sh
git clone -b dist-only https://github.com/Typogram/paper.js
cd paper.js && npm pack          # -> paper-0.12.18.tgz
```

```json
"dependencies": {
  "paper": "file:vendor/paper-0.12.18.tgz"
}
```

Re-run `node tools/build.js` (and `--core`) after changing anything under
`src/`, so the committed bundles stay in sync with the sources, then regenerate
the dist-only branch so an installing app sees the change.
