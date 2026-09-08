# FastCanvasView: optimizing stock Canvas2D, not replacing it

`FastCanvasView` is a second Canvas2D backend, registered under
`data-paper-renderer="canvas-fast"`. It draws through the exact same
`CanvasRenderingContext2D` as the default `CanvasView` - no new rasterizer,
no parity risk of the kind a GPU backend carries - and adds two targeted
optimizations aimed at the case that matters for a large, pannable document:
far more items exist than are ever onscreen at once.

This exists because the GPU backend in `src/gpu/` (see its own README)
ended up roughly on par with stock Canvas2D on this fork's own comparison
demo, after every optimization applied to it - geometry caching, draw-call
batching, viewport culling - turned out to be renderer-agnostic. None of
those techniques actually needed a GPU. `FastCanvasView` applies that same
lesson directly to Canvas2D, with none of a second rendering backend's
integration risk.

## 9a - reuse the pixels on a pure pan

Paper.js's viewport cull (`Item#draw`, shared by every backend) already
skips drawing items outside the visible area. That still leaves the cost of
*testing* every item's bounds against the viewport once per frame - and on a
frame where nothing changed except the pan offset, even that test is
unnecessary: the previous frame's pixels are still exactly what should be
on screen, just shifted.

`FastCanvasView` renders into a padded offscreen buffer - covering some
margin beyond the viewport on every side (`_pad`, default 50%) - instead of
straight onto the visible canvas. On a frame where the view matrix's scale
and rotation are unchanged from the buffer's (i.e. only the pan offset
moved) and the new offset still falls within the buffer's margin, the frame
is produced with one `drawImage()` copy and nothing else: no item is
visited, no path rebuilt. Panning past the margin, any zoom, or any content
change (see `#rebuildIndex()` below) falls back to a real redraw, which also
rebuilds the buffer, re-centered on the new position.

This is not an approximation - a blit frame shows exactly the pixels a real
redraw would have produced, since the buffer holds a real render, not a
reused/scaled stand-in. That is what makes it safe to keep on all the time,
unlike a CSS-transform-the-canvas trick, which trades a blank/blurry edge
during zoom-out for the same free pan.

## 9b - a spatial grid for the redraws that do happen

`SpatialGrid` (`src/util/SpatialGrid.js`) is a uniform grid built once from
the scene's leaf items' bounds, in *project* space rather than device space,
so it stays valid across pan and zoom - only an edit to the indexed items
requires a rebuild (`FastCanvasView#rebuildIndex()`). Querying it with the
current (padded) viewport, in project space, returns the `Set` of item ids
whose cell may be visible - a handful of bucket lookups instead of a bounds
test against every item in the scene.

That `Set` is threaded through as `param.visibleSet` in `Project#draw()` /
`Item#draw()`, alongside the existing `param.viewBounds`. A leaf item present
in the set skips its bounds computation entirely; one absent from it is
culled without ever calling `getStrokeBounds()`. Containers (anything with
children) are not indexed - their bounds are the union of their children's,
which shift too often for a one-off grid scan to track cheaply - so they
keep using the plain per-item bounds test, exactly as every backend already
does. This is why `param.visibleSet` is purely additive: with it absent (the
default for `CanvasView` and `GLView`), `Item#draw()`'s behavior is
unchanged.

## What this does not do

- The grid is not kept live: adding, removing, or moving items after
  `#rebuildIndex()` is called leaves it stale until called again. There are
  no hooks into item mutation to rebuild it automatically - a caller that
  edits the scene after the initial build is expected to call it again (the
  comparison demo does this on every scene rebuild, SVG import, or item
  count change).
- 9a only helps *panning*. A zoom always falls back to a real redraw - the
  buffer cannot be rescaled without becoming exactly the blurry
  bitmap-zoom tradeoff this approach was built to avoid.
- Both are Canvas2D only. `GLView` is untouched by any of this.

## Testing

`test/gl/fastcanvas.js` (`node test/gl/fastcanvas.js`) compares
`FastCanvasView` against plain `CanvasView` pixel-for-pixel through the
transitions that matter - a small pan (expected to blit), a big pan past the
buffer's margin (expected to fall back to a redraw), and a zoom (always a
redraw) - so a wrong buffer offset or a grid that silently drops items shows
up as a pixel mismatch, not just a wrong "blit vs redraw" label.
