/*
 * Paper.js - The Swiss Army Knife of Vector Graphics Scripting.
 * http://paperjs.org/
 *
 * Copyright (c) 2011 - 2020, Jürg Lehni & Jonathan Puckey
 * http://juerglehni.com/ & https://puckey.studio/
 *
 * Distributed under the MIT license. See LICENSE file for details.
 *
 * All rights reserved.
 */

/**
 * @name FastCanvasView
 * @class A {@link CanvasView} with two additions, both aimed squarely at
 * panning/zooming a scene far larger than the viewport - the case that
 * matters once a document has many more items than are ever onscreen at
 * once:
 *
 * 1. On a frame where only the pan offset changed (not zoom, not the scene's
 *    content), the previous frame's pixels are reused - shifted into place
 *    with one `drawImage()` - instead of Paper.js re-walking and redrawing
 *    every visible item. A small margin is kept pre-rendered around the
 *    viewport so an ordinary pan stays a pure blit for many frames in a row;
 *    panning past that margin, or any zoom or content change, falls back to
 *    a real redraw, which also refreshes the margin.
 *
 * 2. Real redraws consult a {@link SpatialGrid} built from the scene's leaf
 *    items, turning "which items are near the viewport" from a bounds test
 *    against every item into a handful of bucket lookups. This is what
 *    makes the redraws that do happen (on zoom, or once panning outruns the
 *    margin) themselves cheaper, on top of there being far fewer of them.
 *
 * Both are opt-in and additive to the existing viewport-cull check in
 * {@link Item#draw} - nothing here changes {@link CanvasView} or
 * {@link GLView}, which is what lets all three be compared honestly against
 * the same scene.
 *
 * The grid only reflects the scene as of the last {@link #rebuildIndex}
 * call: this view does not hook into item add/remove/edit to keep it
 * current automatically, so a caller that mutates the scene after the
 * initial build is expected to call it again.
 *
 * @private
 */
var FastCanvasView = CanvasView.extend(/** @lends FastCanvasView# */{
    _class: 'FastCanvasView',

    // Fraction of the viewport's own size kept pre-rendered on each side.
    // Larger buys more pan-without-redraw at the cost of a bigger offscreen
    // buffer to render and copy from.
    _pad: 0.5,

    initialize: function FastCanvasView(project, canvas) {
        FastCanvasView.base.call(this, project, canvas);
        this._grid = new SpatialGrid();
        this._buffer = null;
        this._bufferMatrix = null;
        this._bufferOffsetX = 0;
        this._bufferOffsetY = 0;
        this._bufferSlackX = 0;
        this._bufferSlackY = 0;
        // Diagnostics read by the comparison demo.
        this._lastWasBlit = false;
        this._blitCount = 0;
        this._redrawCount = 0;
        this._lastIndexed = 0;
    },

    /**
     * Rebuilds the spatial index from the project's current leaf items.
     * Call this after adding, removing, or otherwise changing which items
     * exist - panning and zooming alone never require it.
     */
    rebuildIndex: function() {
        var items = [];
        (function walk(item) {
            var children = item._children;
            if (children) {
                for (var i = 0, l = children.length; i < l; i++)
                    walk(children[i]);
            } else {
                items.push(item);
            }
        })(this._project.activeLayer);
        this._grid.build(items);
        // The cached buffer may hold items that no longer exist, or be
        // missing ones that are now there.
        this._buffer = null;
    },

    /**
     * Discards the pre-rendered pan buffer without touching the spatial
     * index, forcing the next frame to redraw. Cheaper than
     * {@link #rebuildIndex} when only style/appearance changed, not the set
     * of items or their positions.
     */
    invalidateBuffer: function() {
        this._buffer = null;
    },

    update: function() {
        if (!this._needsUpdate)
            return false;
        var project = this._project,
            ctx = this._context,
            size = this._viewSize;
        if (!project) {
            ctx.clearRect(0, 0, size.width + 1, size.height + 1);
            this._needsUpdate = false;
            return true;
        }

        var matrix = this._matrix,
            buffer = this._buffer,
            bufMatrix = this._bufferMatrix,
            pixelRatio = this._pixelRatio;

        if (buffer && bufMatrix
                && matrix._a === bufMatrix._a && matrix._b === bufMatrix._b
                && matrix._c === bufMatrix._c && matrix._d === bufMatrix._d) {
            // Same scale/rotation as the cached buffer: only the pan offset
            // may differ.
            var dx = (matrix._tx - bufMatrix._tx) * pixelRatio,
                dy = (matrix._ty - bufMatrix._ty) * pixelRatio;
            if (Math.abs(dx) <= this._bufferSlackX
                    && Math.abs(dy) <= this._bufferSlackY) {
                this._blit(dx, dy);
                this._lastWasBlit = true;
                this._blitCount++;
                this._needsUpdate = false;
                return true;
            }
            // Panned past the margin this buffer covers - redraw below
            // builds a fresh one, re-centered on the new position.
        }

        this._redraw();
        this._lastWasBlit = false;
        this._redrawCount++;
        this._needsUpdate = false;
        return true;
    },

    /**
     * Copies the buffer onto the visible canvas, offset by (dx, dy) device
     * pixels from where it lines up when the pan hasn't moved at all.
     */
    _blit: function(dx, dy) {
        var ctx = this._context,
            size = this._viewSize,
            pixelRatio = this._pixelRatio;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0,
                size.width * pixelRatio + 1, size.height * pixelRatio + 1);
        ctx.drawImage(this._buffer,
                Math.round(this._bufferOffsetX + dx),
                Math.round(this._bufferOffsetY + dy));
        ctx.restore();
    },

    _redraw: function() {
        var size = this._viewSize,
            matrix = this._matrix,
            pixelRatio = this._pixelRatio,
            pad = this._pad,
            project = this._project;

        // Rendered once into a padded offscreen buffer - never straight onto
        // the visible canvas - so the buffer this frame produces is always
        // ready for the next frame's pan to reuse via #_blit(), rather than
        // paying for the same content twice (once on-screen, once padded).
        var padWidth = size.width * pad,
            padHeight = size.height * pad,
            bufWidthCss = size.width + padWidth * 2,
            bufHeightCss = size.height + padHeight * 2,
            bufWidth = Math.ceil(bufWidthCss * pixelRatio),
            bufHeight = Math.ceil(bufHeightCss * pixelRatio);
        if (bufWidth <= 0 || bufHeight <= 0)
            return;

        var buffer = this._buffer;
        if (!buffer || buffer.width !== bufWidth
                || buffer.height !== bufHeight) {
            buffer = this._buffer = document.createElement('canvas');
            buffer.width = bufWidth;
            buffer.height = bufHeight;
        }
        var bufCtx = buffer.getContext('2d');
        bufCtx.setTransform(1, 0, 0, 1, 0, 0);
        bufCtx.clearRect(0, 0, bufWidth + 1, bufHeight + 1);
        bufCtx.scale(pixelRatio, pixelRatio);
        // Same matrix, shifted so the padded region's top-left lands at the
        // buffer's own origin - see the class comment.
        var bufMatrix = matrix.clone();
        bufMatrix._tx += padWidth;
        bufMatrix._ty += padHeight;
        // Queried against the *original*, unshifted matrix: the world-space
        // rectangle a padded region covers is the same regardless of which
        // (shifted or not) device-space matrix ends up rendering it.
        var visible = this._queryGrid(matrix, size, pad);
        this._lastIndexed = visible ? visible.size : 0;
        project.draw(bufCtx, bufMatrix, pixelRatio,
                new Size(bufWidthCss, bufHeightCss), visible);

        this._bufferMatrix = matrix.clone();
        this._bufferOffsetX = -padWidth * pixelRatio;
        this._bufferOffsetY = -padHeight * pixelRatio;
        this._bufferSlackX = padWidth * pixelRatio;
        this._bufferSlackY = padHeight * pixelRatio;
        // The buffer now holds this frame's content, so use it rather than
        // drawing the same scene a second time straight to the canvas.
        this._blit(0, 0);
    },

    /**
     * @param {Matrix} matrix the *unshifted* view matrix
     * @param {Size} size the (unpadded) viewport size, in CSS pixels
     * @param {Number} pad extra fraction of `size` to include on each side
     * @return {Set|null} see {@link SpatialGrid#query}
     */
    _queryGrid: function(matrix, size, pad) {
        var worldRect = matrix.inverted()._transformBounds(
                new Rectangle(new Point(-size.width * pad, -size.height * pad),
                        new Size(size.width * (1 + 2 * pad),
                                size.height * (1 + 2 * pad))));
        return this._grid.query(worldRect);
    }
});

// A second, opt-in Canvas2D backend: same rasterizer, added viewport
// awareness. Registered under its own key so it has to be asked for
// explicitly (data-paper-renderer="canvas-fast"), never picked as a default.
View.registerRenderer('canvas-fast', FastCanvasView);
