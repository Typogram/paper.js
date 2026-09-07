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
 * @name GLView
 * @class A {@link View} that rasterizes the project on the GPU.
 *
 * It mirrors {@link CanvasView} exactly, differing only in handing
 * {@link Project#draw} a {@link GLContext} instead of a
 * CanvasRenderingContext2D. Everything downstream of that call — the whole
 * scene traversal, style application and compositing — is shared with the
 * canvas renderer.
 *
 * This view is never created implicitly. It is opt-in, either per element
 * through a `data-paper-renderer="webgl"` attribute or globally through
 * `paper.settings.renderer`. See {@link View.create}.
 *
 * @private
 */
var GLView = View.extend(/** @lends GLView# */{
    _class: 'GLView',

    initialize: function GLView(project, canvas) {
        if (!(canvas instanceof window.HTMLCanvasElement)) {
            // See if the arguments describe the view size.
            var size = Size.read(arguments, 1);
            if (size.isZero())
                throw new Error(
                        'Cannot create GLView with the provided argument: '
                        + Base.slice(arguments, 1));
            canvas = CanvasProvider.getCanvas(size);
        }
        this._device = new GLDevice(canvas);
        this._context = new GLContext(this._device);
        this._pixelRatio = 1;
        if (!/^off|false$/.test(PaperScope.getAttribute(canvas, 'hidpi'))) {
            this._pixelRatio = window.devicePixelRatio || 1;
        }
        View.call(this, project, canvas);
        this._needsUpdate = true;
    },

    remove: function remove() {
        this._context.remove();
        this._device.remove();
        return remove.base.call(this);
    },

    _setElementSize: function _setElementSize(width, height) {
        var pixelRatio = this._pixelRatio;
        _setElementSize.base.call(this, width * pixelRatio, height * pixelRatio);
        var element = this._element;
        if (pixelRatio !== 1 && element
                && !PaperScope.hasAttribute(element, 'resize')) {
            // Non-resizable canvases need their CSS size pinned, or the
            // upscaled backing store would render them too large.
            element.style.width = width + 'px';
            element.style.height = height + 'px';
        }
        if (element)
            this._device.setSize(element.width, element.height);
    },

    /**
     * Returns the GLContext this view draws through. Note that this is the
     * Canvas2D-compatible façade, not the underlying WebGL context; use
     * {@link #getGLContext()} for that.
     */
    getContext: function() {
        return this._context;
    },

    /**
     * Returns the underlying WebGL2 rendering context.
     */
    getGLContext: function() {
        return this._device.gl;
    },

    getPixelSize: function getPixelSize(size) {
        var agent = paper.agent,
            pixels;
        if (agent && agent.firefox) {
            pixels = getPixelSize.base.call(this, size);
        } else {
            // Font sizes are resolved by a real 2D context, the same way
            // CanvasView does it.
            var ctx = this._context._getScratch(),
                prevFont = ctx.font;
            ctx.font = size + ' serif';
            pixels = parseFloat(ctx.font);
            ctx.font = prevFont;
        }
        return pixels;
    },

    getTextWidth: function(font, lines) {
        var ctx = this._context._getScratch(),
            prevFont = ctx.font,
            width = 0;
        ctx.font = font;
        for (var i = 0, l = lines.length; i < l; i++)
            width = Math.max(width, ctx.measureText(lines[i]).width);
        ctx.font = prevFont;
        return width;
    },

    update: function() {
        if (!this._needsUpdate)
            return false;
        var project = this._project,
            ctx = this._context,
            element = this._element;
        this._device.setSize(element.width, element.height);
        this._device.clear();
        // Per-frame diagnostics, read by the comparison demo.
        ctx._drawCalls = 0;
        ctx._vertices = 0;
        ctx._batchedShapes = 0;
        if (project) {
            ctx.save();
            // Match the HiDPI upscaling CanvasView applies to its context.
            if (this._pixelRatio !== 1)
                ctx.scale(this._pixelRatio, this._pixelRatio);
            // Overridable per view, so the culling this enables can be
            // measured against an otherwise identical run.
            project.draw(ctx, this._matrix, this._pixelRatio,
                    this._cullEnabled === false ? null : this._viewSize);
            ctx.restore();
        }
        // Nothing may stay queued past the end of a frame.
        ctx._flushBatch();
        this._needsUpdate = false;
        return true;
    }
});

View.registerRenderer('webgl', GLView, GLDevice.isSupported);
