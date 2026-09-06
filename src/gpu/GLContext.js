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
 * @name GLContext
 * @class A GPU-backed stand-in for CanvasRenderingContext2D.
 *
 * Paper.js reaches the rasterizer exclusively through a `ctx` argument that is
 * threaded from {@link View#update} through {@link Project#draw} and
 * {@link Item#draw} down to each item's `_draw()`. Nothing in the drawing path
 * ever looks up a canvas of its own. That makes the *context*, rather than the
 * renderer, the natural substitution point: an object implementing the subset
 * of the Canvas2D interface the library actually uses lets the whole scene
 * graph, style application, group compositing and selection drawing run
 * unmodified, with no change to the public API.
 *
 * Fills are rasterized with stencil-then-cover: the flattened contours are
 * drawn as triangle fans into the stencil buffer under the requested winding
 * rule, then a bounding quad is shaded wherever the stencil says the pixel is
 * inside. This handles self-intersecting and multi-contour paths without any
 * CPU tessellation, which matters because that is exactly what CompoundPath
 * and the boolean operations produce. Strokes go through the same machinery
 * with a union rule, so overlapping join and cap geometry contributes coverage
 * only once and translucent strokes do not double-blend along their seams.
 *
 * @private
 */
var GLContext = Base.extend(new function() {

    // Stencil bit budget: the top bit records whether a pixel is inside the
    // current clip, the remaining bits are scratch space for the winding
    // counter of the shape currently being rasterized.
    var CLIP_BIT = 0x80,
        SCRATCH_MASK = 0x7f,
        colorCache = {};

    // Parses the colour strings Color#toCSS() produces, falling back to a
    // scratch 2D context for any other CSS syntax a user may set directly.
    function parseColor(value, fallbackContext) {
        if (!value)
            return [0, 0, 0, 0];
        var cached = colorCache[value];
        if (cached)
            return cached;
        var components = null,
            match;
        if (match = /^#([0-9a-fA-F]{3,8})$/.exec(value)) {
            var hex = match[1],
                short = hex.length < 6,
                step = short ? 1 : 2;
            if (hex.length === 3 || hex.length === 4 || hex.length === 6
                    || hex.length === 8) {
                components = [];
                for (var i = 0; i < 4; i++) {
                    var part = hex.substr(i * step, step);
                    components.push(part.length
                            ? parseInt(short ? part + part : part, 16) / 255
                            : 1);
                }
            }
        } else if (match = /^rgba?\(([^)]+)\)$/i.exec(value)) {
            var parts = match[1].split(',');
            if (parts.length >= 3) {
                components = [
                    parseFloat(parts[0]) / 255,
                    parseFloat(parts[1]) / 255,
                    parseFloat(parts[2]) / 255,
                    parts.length > 3 ? parseFloat(parts[3]) : 1
                ];
            }
        }
        if (!components && fallbackContext) {
            // Let the browser resolve named colours and everything else.
            fallbackContext.fillStyle = '#000000';
            fallbackContext.fillStyle = value;
            var resolved = fallbackContext.fillStyle;
            components = resolved !== value ? parseColor(resolved) : null;
        }
        components = components || [0, 0, 0, 1];
        colorCache[value] = components;
        return components;
    }

    // Builds the column-major mat3 GLSL expects from a Paper.js Matrix.
    function toMat3(m) {
        return [m._a, m._b, 0, m._c, m._d, 0, m._tx, m._ty, 1];
    }

    return /** @lends GLContext# */{
        _class: 'GLContext',

        initialize: function GLContext(device) {
            this._device = device;
            this.canvas = device.canvas;
            this._path = new GLPath();
            this._states = [];
            this._state = {
                matrix: new Matrix(),
                fillStyle: '#000000',
                strokeStyle: '#000000',
                lineWidth: 1,
                lineCap: 'butt',
                lineJoin: 'miter',
                miterLimit: 10,
                lineDash: [],
                lineDashOffset: 0,
                globalAlpha: 1,
                globalCompositeOperation: 'source-over',
                shadowColor: 'rgba(0,0,0,0)',
                shadowBlur: 0,
                shadowOffsetX: 0,
                shadowOffsetY: 0,
                font: '10px sans-serif',
                textAlign: 'start',
                textBaseline: 'alphabetic',
                clip: []
            };
            // The clip configuration currently rasterized into the stencil
            // buffer, compared by identity against the state's to detect when
            // a rebuild is needed. See #_syncClip().
            this._activeClip = this._state.clip;
            this._clipping = false;
            this._warned = {};
            this._textures = {};
            this._textCache = {};
            this._textCacheSize = 0;
        },

        /**
         * A scratch 2D context, used for text metrics, glyph rasterization and
         * resolving CSS colour syntax we do not parse ourselves.
         */
        _getScratch: function() {
            return this._scratch || (this._scratch = CanvasProvider.getContext(
                    1, 1, { willReadFrequently: true }));
        },

        _warn: function(feature, message) {
            if (!this._warned[feature]) {
                this._warned[feature] = true;
                if (window.console && console.warn) {
                    console.warn('paper.js GL renderer: ' + message
                            + ' It is ignored; use the default canvas '
                            + 'renderer if you need this feature.');
                }
            }
        },

        // -------------------------------------------------------------------
        // State
        // -------------------------------------------------------------------

        save: function() {
            var state = this._state;
            this._states.push(state);
            this._state = Base.set({}, state);
            this._state.matrix = state.matrix.clone();
            // The clip array is shared by reference until clip() replaces it,
            // which is what makes restore() free.
        },

        restore: function() {
            if (this._states.length)
                this._state = this._states.pop();
        },

        scale: function(x, y) {
            this._state.matrix.scale(x, y);
        },

        rotate: function(angle) {
            this._state.matrix.rotate(angle * 180 / Math.PI, 0, 0);
        },

        translate: function(x, y) {
            this._state.matrix.translate(x, y);
        },

        transform: function(a, b, c, d, tx, ty) {
            this._state.matrix.append(new Matrix(a, b, c, d, tx, ty));
        },

        setTransform: function(a, b, c, d, tx, ty) {
            this._state.matrix.set(a, b, c, d, tx, ty);
        },

        resetTransform: function() {
            this._state.matrix.reset();
        },

        // -------------------------------------------------------------------
        // Path construction. Canvas2D transforms path points by the CTM in
        // effect when each command is issued, so coordinates are converted to
        // device space here and GLPath stores flattened polylines only.
        // -------------------------------------------------------------------

        beginPath: function() {
            this._path.reset();
        },

        closePath: function() {
            this._path.close();
        },

        moveTo: function(x, y) {
            var m = this._state.matrix;
            this._path.moveTo(m._a * x + m._c * y + m._tx,
                    m._b * x + m._d * y + m._ty);
        },

        lineTo: function(x, y) {
            var m = this._state.matrix;
            this._path.lineTo(m._a * x + m._c * y + m._tx,
                    m._b * x + m._d * y + m._ty);
        },

        bezierCurveTo: function(x1, y1, x2, y2, x3, y3) {
            var m = this._state.matrix;
            this._path.cubicTo(
                    m._a * x1 + m._c * y1 + m._tx, m._b * x1 + m._d * y1 + m._ty,
                    m._a * x2 + m._c * y2 + m._tx, m._b * x2 + m._d * y2 + m._ty,
                    m._a * x3 + m._c * y3 + m._tx, m._b * x3 + m._d * y3 + m._ty);
        },

        quadraticCurveTo: function(x1, y1, x2, y2) {
            var m = this._state.matrix;
            this._path.quadraticTo(
                    m._a * x1 + m._c * y1 + m._tx, m._b * x1 + m._d * y1 + m._ty,
                    m._a * x2 + m._c * y2 + m._tx, m._b * x2 + m._d * y2 + m._ty);
        },

        rect: function(x, y, width, height) {
            this.moveTo(x, y);
            this.lineTo(x + width, y);
            this.lineTo(x + width, y + height);
            this.lineTo(x, y + height);
            this.closePath();
        },

        arc: function(x, y, radius, startAngle, endAngle, anticlockwise) {
            var m = this._state.matrix,
                // Base the step count on the device-space radius, so the
                // tessellation follows the on-screen size.
                scale = Math.sqrt(Math.abs(m._a * m._d - m._b * m._c)),
                deviceRadius = Math.max(radius * scale, 0.2),
                sweep = endAngle - startAngle,
                full = Math.PI * 2;
            // Normalize the sweep the way Canvas2D does.
            if (anticlockwise) {
                if (sweep > 0)
                    sweep = sweep % full - full;
                if (sweep < -full)
                    sweep = -full;
            } else {
                if (sweep < 0)
                    sweep = sweep % full + full;
                if (sweep > full)
                    sweep = full;
            }
            var steps = Math.max(2, Math.min(1024, Math.ceil(Math.abs(sweep)
                    / (2 * Math.acos(Math.max(-1,
                        1 - 0.2 / deviceRadius)))))),
                step = sweep / steps,
                empty = this._path.isEmpty();
            for (var i = 0; i <= steps; i++) {
                var angle = startAngle + step * i,
                    px = x + Math.cos(angle) * radius,
                    py = y + Math.sin(angle) * radius;
                if (i === 0 && empty) {
                    this.moveTo(px, py);
                } else {
                    this.lineTo(px, py);
                }
            }
        },

        // -------------------------------------------------------------------
        // Painting
        // -------------------------------------------------------------------

        /**
         * Converts each contour into a triangle fan anchored at its first
         * point. Fans of a concave or self-intersecting contour do not cover
         * the plane correctly on their own, but the winding rule applied in
         * the stencil pass resolves that exactly.
         */
        _getFillTriangles: function(path) {
            var contours = path.contours,
                triangles = [];
            for (var i = 0, l = contours.length; i < l; i++) {
                var coords = contours[i].coords,
                    count = coords.length / 2;
                if (count < 3)
                    continue;
                var x0 = coords[0],
                    y0 = coords[1];
                for (var j = 1; j < count - 1; j++) {
                    triangles.push(x0, y0,
                            coords[j * 2], coords[j * 2 + 1],
                            coords[j * 2 + 2], coords[j * 2 + 3]);
                }
            }
            return triangles;
        },

        fill: function(fillRule) {
            this._stencilThenCover(this._getFillTriangles(this._path),
                    this._path.getBounds(1),
                    fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
                    this._getPaint(this._state.fillStyle));
        },

        stroke: function() {
            var state = this._state;
            if (state.lineDash && state.lineDash.length) {
                this._warn('dash',
                        'Dashed strokes (setLineDash) are not implemented yet.');
            }
            var m = state.matrix,
                // Strokes are expanded in device space, so the width follows
                // the CTM. A non-uniform scale cannot be expressed as a single
                // width; the average is exact for the uniform case, which is
                // what Item#draw guarantees whenever strokes do not scale.
                scale = (Math.sqrt(m._a * m._a + m._b * m._b)
                        + Math.sqrt(m._c * m._c + m._d * m._d)) / 2,
                width = state.lineWidth * scale;
            this._stencilThenCover(
                    GLStroker.expand(this._path, width, state.lineCap,
                        state.lineJoin, state.miterLimit),
                    this._path.getBounds(width / 2 + 1), 'union',
                    this._getPaint(state.strokeStyle));
        },

        fillRect: function(x, y, width, height) {
            var path = this._path;
            this._path = new GLPath();
            this.rect(x, y, width, height);
            this.fill();
            this._path = path;
        },

        strokeRect: function(x, y, width, height) {
            var path = this._path;
            this._path = new GLPath();
            this.rect(x, y, width, height);
            this.stroke();
            this._path = path;
        },

        clearRect: function(x, y, width, height) {
            var device = this._device,
                gl = device.gl,
                size = device.getSize(),
                m = this._state.matrix,
                xs = [],
                ys = [];
            // Device-space bounds of the transformed rectangle.
            for (var i = 0; i < 4; i++) {
                var px = x + (i & 1 ? width : 0),
                    py = y + (i & 2 ? height : 0);
                xs.push(m._a * px + m._c * py + m._tx);
                ys.push(m._b * px + m._d * py + m._ty);
            }
            var x0 = Math.max(0, Math.floor(Math.min.apply(Math, xs))),
                y0 = Math.max(0, Math.floor(Math.min.apply(Math, ys))),
                x1 = Math.min(size.width, Math.ceil(Math.max.apply(Math, xs))),
                y1 = Math.min(size.height, Math.ceil(Math.max.apply(Math, ys)));
            if (x1 <= x0 || y1 <= y0)
                return;
            if (!x0 && !y0 && x1 === size.width && y1 === size.height) {
                device.clear();
            } else {
                gl.enable(gl.SCISSOR_TEST);
                // Scissor coordinates are y-up.
                gl.scissor(x0, size.height - y1, x1 - x0, y1 - y0);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.disable(gl.SCISSOR_TEST);
            }
        },

        clip: function(fillRule) {
            var state = this._state;
            // Copy on write, so a save() taken before this clip still refers
            // to the old configuration and restore() stays free.
            state.clip = state.clip.concat([{
                triangles: this._getFillTriangles(this._path),
                rule: fillRule === 'evenodd' ? 'evenodd' : 'nonzero'
            }]);
        },

        isPointInPath: function(x, y, fillRule) {
            var m = this._state.matrix,
                px = m._a * x + m._c * y + m._tx,
                py = m._b * x + m._d * y + m._ty,
                contours = this._path.contours,
                winding = 0,
                crossings = 0;
            for (var i = 0, l = contours.length; i < l; i++) {
                var coords = contours[i].coords,
                    count = coords.length / 2;
                for (var j = 0; j < count; j++) {
                    var k = (j + 1) % count,
                        x0 = coords[j * 2], y0 = coords[j * 2 + 1],
                        x1 = coords[k * 2], y1 = coords[k * 2 + 1];
                    if (y0 === y1)
                        continue;
                    if (y0 <= py && y1 > py || y1 <= py && y0 > py) {
                        if (x0 + (py - y0) / (y1 - y0) * (x1 - x0) > px) {
                            crossings++;
                            winding += y1 > y0 ? 1 : -1;
                        }
                    }
                }
            }
            return fillRule === 'evenodd' ? !!(crossings & 1) : winding !== 0;
        },

        _getPaint: function(style) {
            return style instanceof GLGradient
                    ? { type: 'gradient', gradient: style }
                    : { type: 'solid',
                        color: parseColor(style, this._getScratch()) };
        },

        // -------------------------------------------------------------------
        // Rasterization
        // -------------------------------------------------------------------

        _drawTriangles: function(triangles) {
            var device = this._device,
                count = triangles.length / 2,
                data = device.reserve(triangles.length);
            data.set(triangles);
            device.upload(data, count);
            device.gl.drawArrays(device.gl.TRIANGLES, 0, count);
        },

        _drawQuad: function(bounds) {
            var device = this._device,
                data = device.reserve(12),
                x0 = bounds[0], y0 = bounds[1],
                x1 = bounds[2], y1 = bounds[3];
            data[0] = x0; data[1] = y0;
            data[2] = x1; data[3] = y0;
            data[4] = x1; data[5] = y1;
            data[6] = x0; data[7] = y0;
            data[8] = x1; data[9] = y1;
            data[10] = x0; data[11] = y1;
            device.upload(data, 6);
            device.gl.drawArrays(device.gl.TRIANGLES, 0, 6);
        },

        _useProgram: function(name, fragmentSource) {
            var device = this._device,
                entry = device.getProgram(name, GLShaders.vertex,
                        fragmentSource),
                size = device.getSize();
            device.useProgram(entry);
            device.gl.uniform2f(device.getUniform(entry, 'u_resolution'),
                    size.width, size.height);
            return entry;
        },

        /**
         * Binds the program and uniforms for the given paint, so the cover
         * draw that follows shades every covered pixel correctly.
         */
        _bindPaint: function(paint) {
            var device = this._device,
                gl = device.gl,
                alpha = this._state.globalAlpha,
                entry;
            if (paint.type === 'gradient') {
                var gradient = paint.gradient,
                    // Canvas2D interprets gradient coordinates in the space
                    // current at painting time, so use the CTM, not the one
                    // that was active when the gradient was created.
                    m = this._state.matrix,
                    scale = Math.sqrt(Math.abs(m._a * m._d - m._b * m._c));
                entry = this._useProgram('gradient', GLShaders.gradient);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, gradient._getRamp(device));
                gl.uniform1i(device.getUniform(entry, 'u_ramp'), 0);
                gl.uniform1f(device.getUniform(entry, 'u_alpha'), alpha);
                gl.uniform1i(device.getUniform(entry, 'u_radial'),
                        gradient._radial ? 1 : 0);
                gl.uniform2f(device.getUniform(entry, 'u_p0'),
                        m._a * gradient._x0 + m._c * gradient._y0 + m._tx,
                        m._b * gradient._x0 + m._d * gradient._y0 + m._ty);
                gl.uniform2f(device.getUniform(entry, 'u_p1'),
                        m._a * gradient._x1 + m._c * gradient._y1 + m._tx,
                        m._b * gradient._x1 + m._d * gradient._y1 + m._ty);
                gl.uniform1f(device.getUniform(entry, 'u_radius'),
                        gradient._radius * scale);
            } else {
                var color = paint.color,
                    a = color[3] * alpha;
                entry = this._useProgram('solid', GLShaders.solid);
                // Premultiplied, matching the blend function GLDevice sets up.
                gl.uniform4f(device.getUniform(entry, 'u_color'),
                        color[0] * a, color[1] * a, color[2] * a, a);
            }
        },

        _stencilThenCover: function(triangles, bounds, rule, paint) {
            if (!triangles.length || !bounds)
                return;
            var device = this._device,
                gl = device.gl,
                size = device.getSize();
            this._checkComposite();
            this._syncClip();
            var x0 = Math.max(0, Math.floor(bounds[0])),
                y0 = Math.max(0, Math.floor(bounds[1])),
                x1 = Math.min(size.width, Math.ceil(bounds[2])),
                y1 = Math.min(size.height, Math.ceil(bounds[3]));
            if (x1 <= x0 || y1 <= y0)
                return;
            var quad = [x0, y0, x1, y1];

            // Pass 1: accumulate coverage in the scratch stencil bits.
            gl.enable(gl.STENCIL_TEST);
            gl.colorMask(false, false, false, false);
            this._useProgram('none', GLShaders.none);
            this._setStencilRule(rule);
            this._drawTriangles(triangles);

            // Pass 2: shade every pixel the winding rule marked as inside, and
            // reset its scratch bits in the same draw.
            gl.colorMask(true, true, true, true);
            gl.stencilMask(SCRATCH_MASK);
            if (this._clipping) {
                // Passes exactly where the clip bit is set *and* some scratch
                // bit is, since 0x80 < (clip | scratch) holds only then.
                gl.stencilFunc(gl.LESS, CLIP_BIT, 0xff);
            } else {
                gl.stencilFunc(gl.NOTEQUAL, 0, SCRATCH_MASK);
            }
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
            this._bindPaint(paint);
            this._drawQuad(quad);

            if (this._clipping) {
                // Covered pixels outside the clip failed the test above and
                // kept their scratch bits, so clear them before the next shape.
                gl.colorMask(false, false, false, false);
                gl.stencilFunc(gl.ALWAYS, 0, 0xff);
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
                this._useProgram('none', GLShaders.none);
                this._drawQuad(quad);
                gl.colorMask(true, true, true, true);
            }
            gl.disable(gl.STENCIL_TEST);
            gl.stencilMask(0xff);
        },

        _setStencilRule: function(rule) {
            var gl = this._device.gl;
            gl.stencilFunc(gl.ALWAYS, 1, 0xff);
            if (rule === 'evenodd') {
                // A single toggling bit is all the even-odd rule needs.
                gl.stencilMask(0x01);
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
            } else if (rule === 'union') {
                // Coverage without counting, so overlapping stroke geometry is
                // not blended twice.
                gl.stencilMask(SCRATCH_MASK);
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
            } else {
                gl.stencilMask(SCRATCH_MASK);
                gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
                gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
            }
        },

        /**
         * Rebuilds the clip bit of the stencil buffer when the state's clip
         * configuration no longer matches what is rasterized. Clips are kept
         * as geometry rather than as a stencil snapshot, which is what lets
         * save() / restore() nest without any buffer copies.
         */
        _syncClip: function() {
            var state = this._state;
            if (state.clip === this._activeClip)
                return;
            var device = this._device,
                gl = device.gl,
                size = device.getSize(),
                clip = state.clip,
                full = [0, 0, size.width, size.height];
            this._activeClip = clip;
            this._clipping = clip.length > 0;
            if (!this._clipping)
                return;
            gl.enable(gl.STENCIL_TEST);
            gl.colorMask(false, false, false, false);
            this._useProgram('none', GLShaders.none);
            // Start from "everything is inside".
            gl.stencilMask(CLIP_BIT);
            gl.stencilFunc(gl.ALWAYS, CLIP_BIT, 0xff);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
            this._drawQuad(full);
            for (var i = 0, l = clip.length; i < l; i++) {
                var entry = clip[i];
                if (entry.triangles.length) {
                    this._setStencilRule(entry.rule);
                    this._drawTriangles(entry.triangles);
                    // Intersect: clear the clip bit wherever this path did not
                    // cover, leaving already-excluded pixels excluded.
                    gl.stencilMask(CLIP_BIT);
                    gl.stencilFunc(gl.EQUAL, 0, SCRATCH_MASK);
                    gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
                    this._drawQuad(full);
                    // Reset the scratch bits for the next path.
                    gl.stencilMask(SCRATCH_MASK);
                    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
                    gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
                    this._drawQuad(full);
                } else {
                    // An empty clip path clips everything away.
                    gl.stencilMask(CLIP_BIT);
                    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
                    gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
                    this._drawQuad(full);
                }
            }
            gl.colorMask(true, true, true, true);
            gl.disable(gl.STENCIL_TEST);
            gl.stencilMask(0xff);
        },

        _checkComposite: function() {
            var state = this._state;
            if (state.globalCompositeOperation !== 'source-over') {
                this._warn('composite', 'Blend mode "'
                        + state.globalCompositeOperation
                        + '" is not implemented yet.');
            }
            if ((state.shadowBlur > 0 || state.shadowOffsetX
                    || state.shadowOffsetY)
                    && parseColor(state.shadowColor, this._getScratch())[3]) {
                this._warn('shadow', 'Shadows are not implemented yet.');
            }
        },

        // -------------------------------------------------------------------
        // Images and text
        // -------------------------------------------------------------------

        _getTexture: function(element, version) {
            var gl = this._device.gl,
                id = element.__glId;
            if (id === undefined)
                id = element.__glId = GLContext._textureId++;
            var entry = this._textures[id];
            if (!entry) {
                entry = this._textures[id] = {
                    texture: gl.createTexture(),
                    version: null
                };
            }
            gl.bindTexture(gl.TEXTURE_2D, entry.texture);
            if (entry.version !== version) {
                entry.version = version;
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
                        gl.UNSIGNED_BYTE, element);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,
                        gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,
                        gl.CLAMP_TO_EDGE);
            }
            var filter = this._imageSmoothingEnabled === false
                    ? gl.NEAREST : gl.LINEAR;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            return entry.texture;
        },

        /**
         * Draws a texture over the device-space quad the unit square maps to
         * under `matrix`, sampling the sub-rectangle given in uv space.
         */
        _drawTexture: function(texture, matrix, uv) {
            var inverse = matrix.inverted();
            if (!inverse)
                return;
            this._checkComposite();
            this._syncClip();
            var device = this._device,
                gl = device.gl,
                size = device.getSize(),
                xs = [],
                ys = [];
            for (var i = 0; i < 4; i++) {
                var ux = i & 1 ? 1 : 0,
                    uy = i & 2 ? 1 : 0;
                xs.push(matrix._a * ux + matrix._c * uy + matrix._tx);
                ys.push(matrix._b * ux + matrix._d * uy + matrix._ty);
            }
            var x0 = Math.max(0, Math.floor(Math.min.apply(Math, xs))),
                y0 = Math.max(0, Math.floor(Math.min.apply(Math, ys))),
                x1 = Math.min(size.width, Math.ceil(Math.max.apply(Math, xs))),
                y1 = Math.min(size.height, Math.ceil(Math.max.apply(Math, ys)));
            if (x1 <= x0 || y1 <= y0)
                return;
            // Map device space to the unit square, then into the source rect.
            var uvMatrix = new Matrix(uv[2] - uv[0], 0, 0, uv[3] - uv[1],
                        uv[0], uv[1]).appended(inverse),
                entry = this._useProgram('image', GLShaders.image);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniform1i(device.getUniform(entry, 'u_image'), 0);
            gl.uniform1f(device.getUniform(entry, 'u_alpha'),
                    this._state.globalAlpha);
            gl.uniformMatrix3fv(device.getUniform(entry, 'u_uvMatrix'), false,
                    toMat3(uvMatrix));
            if (this._clipping) {
                gl.enable(gl.STENCIL_TEST);
                gl.stencilMask(0x00);
                gl.stencilFunc(gl.EQUAL, CLIP_BIT, CLIP_BIT);
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
            }
            this._drawQuad([x0, y0, x1, y1]);
            if (this._clipping) {
                gl.disable(gl.STENCIL_TEST);
                gl.stencilMask(0xff);
            }
        },

        drawImage: function(element, a, b, c, d, e, f, g, h) {
            var width = element.naturalWidth || element.videoWidth
                    || element.width,
                height = element.naturalHeight || element.videoHeight
                    || element.height;
            if (!width || !height)
                return;
            var sx = 0, sy = 0, sw = width, sh = height,
                dx, dy, dw, dh;
            if (arguments.length >= 9) {
                sx = a; sy = b; sw = c; sh = d;
                dx = e; dy = f; dw = g; dh = h;
            } else if (arguments.length >= 5) {
                dx = a; dy = b; dw = c; dh = d;
            } else {
                dx = a; dy = b; dw = width; dh = height;
            }
            this._drawTexture(
                    this._getTexture(element, element.__glVersion !== undefined
                        ? element.__glVersion : width + 'x' + height),
                    this._state.matrix.clone().translate(dx, dy).scale(dw, dh),
                    [sx / width, sy / height,
                        (sx + sw) / width, (sy + sh) / height]);
        },

        measureText: function(text) {
            var scratch = this._getScratch();
            scratch.font = this._state.font;
            return scratch.measureText(text);
        },

        /**
         * Rasterizes one run of text with the scratch 2D context and caches the
         * resulting bitmap. A text-heavy scene should move to a shared glyph
         * atlas, but per-run bitmaps are exact and keep font handling in the
         * hands of the engine.
         */
        _renderText: function(text, stroke) {
            var state = this._state,
                style = stroke ? state.strokeStyle : state.fillStyle;
            if (style instanceof GLGradient) {
                this._warn('gradientText',
                        'Gradient-filled text is not implemented yet.');
                return null;
            }
            var key = [state.font, state.textAlign, style, stroke,
                        stroke ? state.lineWidth : 0, text].join('\u0000'),
                cached = this._textCache[key];
            if (cached)
                return cached;
            var scratch = this._getScratch();
            scratch.font = state.font;
            var metrics = scratch.measureText(text),
                ascent = metrics.actualBoundingBoxAscent,
                descent = metrics.actualBoundingBoxDescent,
                fontSize = parseFloat(state.font) || 10;
            if (!(ascent > 0) || !(descent >= 0)) {
                // Older engines do not report the bounding box; approximate.
                ascent = fontSize;
                descent = fontSize * 0.3;
            }
            var padding = Math.ceil((stroke ? state.lineWidth : 0) / 2) + 2,
                width = Math.ceil(metrics.width) + padding * 2,
                height = Math.ceil(ascent + descent) + padding * 2;
            if (width <= 0 || height <= 0)
                return null;
            var canvas = CanvasProvider.getCanvas(width, height),
                ctx = canvas.getContext('2d'),
                x = padding,
                y = padding + Math.ceil(ascent);
            ctx.font = state.font;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            if (stroke) {
                ctx.strokeStyle = style;
                ctx.lineWidth = state.lineWidth;
                ctx.lineJoin = state.lineJoin;
                ctx.lineCap = state.lineCap;
                ctx.miterLimit = state.miterLimit;
                ctx.strokeText(text, x, y);
            } else {
                ctx.fillStyle = style;
                ctx.fillText(text, x, y);
            }
            var align = state.textAlign,
                // The horizontal shift Canvas2D would have applied for the
                // current textAlign, in user space.
                offset = align === 'center' || align === 'middle'
                        ? -metrics.width / 2
                        : align === 'right' || align === 'end'
                            ? -metrics.width
                            : 0,
                entry = {
                    canvas: canvas,
                    width: width,
                    height: height,
                    dx: offset - padding,
                    dy: -y
                };
            // Keep the cache bounded.
            if (this._textCacheSize > 256) {
                this._textCache = {};
                this._textCacheSize = 0;
            }
            this._textCache[key] = entry;
            this._textCacheSize++;
            return entry;
        },

        _drawText: function(text, x, y, stroke) {
            var entry = this._renderText(text, stroke);
            if (entry) {
                this._drawTexture(this._getTexture(entry.canvas, 'text'),
                        this._state.matrix.clone()
                            .translate(x + entry.dx, y + entry.dy)
                            .scale(entry.width, entry.height),
                        [0, 0, 1, 1]);
            }
        },

        fillText: function(text, x, y) {
            this._drawText(text, x, y, false);
        },

        strokeText: function(text, x, y) {
            this._drawText(text, x, y, true);
        },

        // -------------------------------------------------------------------
        // Gradients and pixel access
        // -------------------------------------------------------------------

        createLinearGradient: function(x0, y0, x1, y1) {
            return new GLGradient(false, x0, y0, x1, y1, 0);
        },

        createRadialGradient: function(x0, y0, r0, x1, y1, r1) {
            // Paper.js only ever produces gradients with an inner radius of 0,
            // which is exactly the focal form the shader solves.
            return new GLGradient(true, x0, y0, x1, y1, r1);
        },

        createPattern: function() {
            this._warn('pattern', 'Patterns are not implemented yet.');
            return '#000000';
        },

        createImageData: function(width, height) {
            if (width && width.width !== undefined) {
                height = width.height;
                width = width.width;
            }
            return this._getScratch().createImageData(width, height);
        },

        getImageData: function(x, y, width, height) {
            var device = this._device,
                gl = device.gl,
                size = device.getSize(),
                buffer = new Uint8Array(width * height * 4);
            // readPixels is y-up, so read the mirrored row range and flip.
            gl.readPixels(x, size.height - (y + height), width, height,
                    gl.RGBA, gl.UNSIGNED_BYTE, buffer);
            var result = this.createImageData(width, height),
                target = result.data,
                stride = width * 4;
            for (var row = 0; row < height; row++) {
                var src = (height - 1 - row) * stride,
                    dst = row * stride;
                for (var i = 0; i < stride; i += 4) {
                    var alpha = buffer[src + i + 3],
                        // The drawing buffer is premultiplied, ImageData is not.
                        scale = alpha ? 255 / alpha : 0;
                    target[dst + i] = Math.min(255, buffer[src + i] * scale);
                    target[dst + i + 1] = Math.min(255,
                            buffer[src + i + 1] * scale);
                    target[dst + i + 2] = Math.min(255,
                            buffer[src + i + 2] * scale);
                    target[dst + i + 3] = alpha;
                }
            }
            return result;
        },

        putImageData: function(data, x, y) {
            var canvas = CanvasProvider.getCanvas(data.width, data.height),
                state = this._state,
                matrix = state.matrix,
                clip = state.clip;
            canvas.getContext('2d').putImageData(data, 0, 0);
            // putImageData ignores both the CTM and the clip.
            state.matrix = new Matrix();
            state.clip = [];
            this._drawTexture(this._getTexture(canvas, GLContext._textureId++),
                    new Matrix().translate(x, y)
                        .scale(data.width, data.height),
                    [0, 0, 1, 1]);
            state.matrix = matrix;
            state.clip = clip;
            CanvasProvider.release(canvas);
        },

        getContextAttributes: function() {
            return this._device.gl.getContextAttributes();
        },

        remove: function() {
            var gl = this._device.gl;
            for (var id in this._textures)
                gl.deleteTexture(this._textures[id].texture);
            this._textures = {};
            if (this._scratch) {
                CanvasProvider.release(this._scratch);
                this._scratch = null;
            }
        },

        statics: {
            _textureId: 1,
            _parseColor: parseColor
        }
    };
});

// Canvas2D exposes its state through properties rather than methods, and
// Item#_setStyles() and the various _draw() implementations assign them
// directly, so mirror each one onto the state object. Note that these have to
// go through inject(), which turns { get, set } entries into real accessors.
GLContext.inject(Base.each([
    'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin',
    'miterLimit', 'lineDashOffset', 'globalAlpha', 'globalCompositeOperation',
    'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
    'font', 'textAlign', 'textBaseline'
], function(name) {
    this[name] = {
        get: function() {
            return this._state[name];
        },
        set: function(value) {
            this._state[name] = value;
        }
    };
}, {}));

GLContext.inject({
    currentTransform: {
        get: function() {
            var m = this._state.matrix;
            return { a: m._a, b: m._b, c: m._c, d: m._d, e: m._tx, f: m._ty };
        }
    },

    imageSmoothingEnabled: {
        get: function() {
            return this._imageSmoothingEnabled !== false;
        },
        set: function(value) {
            this._imageSmoothingEnabled = value;
        }
    },

    imageSmoothingQuality: {
        get: function() {
            return this._imageSmoothingQuality || 'low';
        },
        set: function(value) {
            this._imageSmoothingQuality = value;
        }
    },

    setLineDash: function(dash) {
        this._state.lineDash = dash || [];
    },

    getLineDash: function() {
        return this._state.lineDash;
    }
});

// GLGradient needs the colour parser that lives in this file's closure.
GLGradient._parse = function(value) {
    return GLContext._parseColor(value);
};
