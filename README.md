<!-- Generated branch. Do not edit: see tools/make-dist-branch.js. -->

> **This branch is the built package and nothing else**, so that the
> fork can be installed straight from git:
>
> ```sh
> npm i github:Typogram/paper.js#dist-only
> ```
>
> It installs under the name `paper`, so it is imported as
> `import paper from 'paper'` and drops into an app already using
> upstream Paper.js with no other change. The rest of this readme
> describes the same library published as `@typogram/paper.js`.

# @typogram/paper.js

Paper.js with an SVG renderer.

Stock Paper.js redraws the whole scene into a canvas on every frame, so panning
a document with tens of thousands of items costs a full scene traversal per
frame. This package is upstream **Paper.js 0.12.18** plus a second renderer that
mirrors the scene graph into a native SVG DOM tree and keeps one node per item
alive. Moving the camera then costs a single `transform` attribute, no matter
how many items the document holds.

Everything else is upstream Paper.js: the same items, styles, tools, events,
`hitTest()`, import and export. It is a drop-in replacement for the `paper`
package.

```sh
npm i github:Typogram/paper.js#dist-only
```

It installs under the name `paper`, so nothing that already imports `paper` has
to change:

```js
import paper from 'paper';

paper.setup(canvas);
new paper.Path.Circle({ center: [80, 50], radius: 35, fillColor: 'red' });
```

The renderer is chosen per view, so a single canvas can opt out:

```js
paper.settings.renderer = 'canvas'; // per scope, before setup()
```

```html
<canvas data-paper-renderer="canvas"></canvas>
<!-- or hand setup() an <svg> element, which always selects the SVG renderer -->
```

## Know this before you switch

- **The element is swapped.** Handed a `<canvas>`, the view replaces it with an
  `<svg>` and puts the original back on `remove()`. Code holding its own
  reference to that canvas — a framework ref, listeners bound to it, or
  `canvas.toDataURL()` for a thumbnail — should render an `<svg>` element
  itself, or opt that view out. To read pixels, go through `Item#rasterize()`,
  which makes its own canvas either way.
- **Five blend modes render as `normal`.** `add` maps to CSS `plus-lighter` and
  the other 15 map to the CSS mode of the same name, but `subtract`, `average`,
  `pin-light` and `negation` have no CSS equivalent — Paper.js emulates those in
  JavaScript for the canvas renderer, which a DOM tree cannot do.
- **Browser only.** The SVG renderer needs a DOM, and this package ships an ES
  module built for the browser. For Node.js rendering, use upstream `paper`.

## What you get

One DOM node per item, kept alive and updated in place. The view learns what
changed through Paper.js's own change tracking, so an update touches the items
that actually changed rather than walking the scene. The view matrix lives on
the root `<g>`, so a pan or zoom writes one attribute and nothing else — the
browser keeps the rasterized geometry and skips what is off screen.

The trade is per-frame work for per-change work: setup takes longer, the nodes
stay resident, and changing every item in one frame costs more than a redraw
would. On an editor workload — a large document, a camera that moves more often
than the content does — it is the right way round.

## Working on this package

```sh
cd site
npm install
npm run dev        # the landing page, against the bundle in ../dist
npm run build      # the landing page, prerendered into site/build
npm run package    # the npm package, into site/dist, then linted with publint
```

`npm run sync:paper` (which the three scripts above all run first) regenerates
`src/lib` from `../dist/paper-full.js`, so the package always ships the bundle
this repository built. After changing anything under `../src`, rebuild it with
`node tools/build.js` in the repository root.

### Publishing

```sh
cd site
npm run package                       # builds dist/ and lints the package
npm publish --access public           # scoped packages default to private
```

The version in `package.json` tracks the Paper.js version it ships, so a
release that only changes the renderer takes a patch bump of its own (for
example `0.12.18-1`, or move to `0.13.x` once upstream does).

## Links

- Live comparison and docs: the landing page in this package's repository
- Source: <https://github.com/Typogram/paper.js> (branch
  `paperjs-svg-renderer`, renderer docs in `src/view/README.md`)
- Upstream Paper.js: <http://paperjs.org/>

MIT, like Paper.js itself.
