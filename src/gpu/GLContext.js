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
        // Batched rules get disjoint stencil bits, so a fill and a stroke can
        // be accumulated in the *same* pass without contaminating each other's
        // coverage. That is what lets a filled-and-stroked item batch at all:
        // Path#_draw emits fill() then stroke(), and the two always overlap.
        // NONZERO_MASK is a wrapping winding counter, so a path nesting more
        // than 64 contours the same way would alias - far beyond real content.
        NONZERO_MASK = 0x3f,
        UNION_BIT = 0x40,
        // Passed to the vertex shader for draws whose coordinates are already
        // in device space (cover quads, clips, images, text).
        IDENTITY_MAT3 = [1, 0, 0, 0, 1, 0, 0, 0, 1],
        // Flattening tolerance, in device pixels. Paths are recorded in their
        // own space now, so the tolerance is divided by the transform's scale
        // to keep the on-screen result identical.
        BASE_TOLERANCE = 0.2,
        // Side of one occupancy cell, in device pixels. Batching needs to know
        // whether an incoming shape's bounds touch anything already queued;
        // a coarse grid answers that in a handful of lookups instead of
        // testing against every shape in the batch.
        BATCH_CELL = 32,
        // Vertex ceiling for one batch, so a pathological scene cannot grow
        // the staging arrays without bound.
        BATCH_MAX_VERTICES = 120000,
        colorCache = {};

    // The average scale a matrix applies, used both to pick a flattening
    // tolerance and to convert stroke widths between spaces.
    function matrixScale(m) {
        return (Math.sqrt(m._a * m._a + m._b * m._b)
                + Math.sqrt(m._c * m._c + m._d * m._d)) / 2;
    }

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

    /**
     * A Float32Array that grows by doubling, written by index.
     *
     * The batch fills this once per shape per frame, so it is the hottest code
     * in the renderer. Accumulating into a plain Array and converting later
     * costs far more than the draw calls batching saves: Float32Array#set() on
     * a boxed number array is a per-element conversion, and it lands right in
     * the middle of the frame.
     */
    function VertexBuffer() {
        this.data = new Float32Array(4096);
        this.length = 0;
    }

    VertexBuffer.prototype.reserve = function(count) {
        var required = this.length + count,
            size = this.data.length;
        if (required > size) {
            while (size < required)
                size *= 2;
            var grown = new Float32Array(size);
            grown.set(this.data.subarray(0, this.length));
            this.data = grown;
        }
    };

    VertexBuffer.prototype.reset = function() {
        this.length = 0;
    };

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
            // Tessellated geometry, keyed by item id. Only Path carries the
            // _version counter this relies on; every other item type falls
            // back to re-tessellating each frame, exactly as before.
            this._geometry = {};
            this._geometryCount = 0;
            // Diagnostics: how often cached tessellation is reused. A scene
            // animated with applyMatrix left on will show ~0 hits, because
            // Paper.js rewrites the segments and the geometry really did
            // change. See src/gpu/README.md.
            this._cacheHits = 0;
            this._cacheMisses = 0;
            this._currentItem = null;
            // Pending batch of solid-paint shapes, flushed as two draw calls
            // rather than two per shape. See #_appendToBatch().
            this._batch = null;
            // Reused across flushes so the staging buffers keep their capacity.
            this._batchPool = null;
            this._batchGrid = null;
            this._batchOwner = null;
            // Distinguishes shapes that belong to no item, so they never
            // appear to share an owner with one another.
            this._batchAnonymous = 0;
            this._batchCols = 0;
            this._batchRows = 0;
            // Generation stamp, so starting a batch costs an increment rather
            // than clearing the whole grid.
            this._batchGeneration = 0;
            // Diagnostics, reset each frame by GLView#update().
            this._drawCalls = 0;
            this._vertices = 0;
            this._batchedShapes = 0;
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
            // Curves are flattened in the space they are recorded in, so the
            // tolerance has to be scaled to still mean 0.2 device pixels.
            this._path._tolerance = BASE_TOLERANCE
                    / Math.max(matrixScale(this._state.matrix), 1e-6);
            this._cacheable = true;
        },

        closePath: function() {
            this._path.close();
        },

        // Path commands record coordinates exactly as given, in whatever
        // space the CTM describes, and the transform is applied later by the
        // vertex shader. That is what lets the tessellation be reused when an
        // item only moves. It relies on the CTM staying constant for the
        // duration of one path, which Paper.js guarantees: Item#draw applies
        // the item's matrix to the context once, before calling _draw().
        moveTo: function(x, y) {
            this._path.moveTo(x, y);
        },

        lineTo: function(x, y) {
            this._path.lineTo(x, y);
        },

        bezierCurveTo: function(x1, y1, x2, y2, x3, y3) {
            this._path.cubicTo(x1, y1, x2, y2, x3, y3);
        },

        quadraticCurveTo: function(x1, y1, x2, y2) {
            this._path.quadraticTo(x1, y1, x2, y2);
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

        /**
         * Returns tessellated geometry for the current path, reusing the
         * previous frame's result when the item's geometry has not changed.
         *
         * Paper.js bumps Path#_version only on ChangeFlag.SEGMENTS, so a pure
         * transform (Change.MATRIX) leaves it alone. That is exactly the
         * signal needed here: an item that merely moves, rotates or scales
         * keeps its cached triangles and pays only for a uniform update, while
         * an edited path re-tessellates. `kind` separates the fill and stroke
         * entries, and `variant` carries any style the tessellation depends on.
         *
         * Falls through to plain tessellation when there is no current item,
         * when the item type has no _version (everything but Path), or when
         * the path is a scratch one, so behaviour is unchanged in those cases.
         */
        _tessellate: function(kind, variant, build) {
            var item = this._currentItem,
                // Instance flag so the cache can be toggled on a live view
                // for measurement; undefined means enabled.
                version = this._cacheEnabled !== false && item
                        ? item._version : undefined;
            // No item (selection handles, scratch paths) or an item type
            // without a version counter (everything but Path) tessellates
            // every frame, exactly as before.
            if (!this._cacheable || version === undefined)
                return build();
            var key = item._id,
                entry = this._geometry[key];
            if (entry && entry.version === version && entry[kind]
                    && entry[kind].variant === variant) {
                this._cacheHits++;
                return entry[kind].data;
            }
            this._cacheMisses++;
            if (!entry || entry.version !== version) {
                if (!entry) {
                    // Bound the cache rather than tracking per-entry ages: the
                    // scene graph is the natural upper bound, and a wholesale
                    // clear costs one re-tessellation of what is still visible.
                    if (this._geometryCount > 20000) {
                        this._geometry = {};
                        this._geometryCount = 0;
                    }
                    this._geometryCount++;
                }
                entry = this._geometry[key] = { version: version };
            }
            var data = build();
            entry[kind] = { variant: variant, data: data };
            return data;
        },

        fill: function(fillRule) {
            var path = this._path,
                rule = fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
                that = this,
                geometry = this._tessellate('fill', rule, function() {
                    return {
                        triangles: that._getFillTriangles(path),
                        bounds: path.getBounds(1)
                    };
                });
            this._stencilThenCover(geometry.triangles, geometry.bounds, rule,
                    this._getPaint(this._state.fillStyle), this._state.matrix);
        },

        stroke: function() {
            var state = this._state,
                path = this._path;
            if (state.lineDash && state.lineDash.length) {
                this._warn('dash',
                        'Dashed strokes (setLineDash) are not implemented yet.');
            }
            // The stroke is expanded in the path's own space and scaled by the
            // shader along with everything else, so the width is used as given
            // rather than pre-multiplied by the CTM.
            var width = state.lineWidth,
                cap = state.lineCap,
                join = state.lineJoin,
                miterLimit = state.miterLimit,
                // Expansion geometry depends on these, and a style change does
                // not bump _version, so they belong in the cache key.
                variant = width + ':' + cap + ':' + join + ':' + miterLimit,
                geometry = this._tessellate('stroke', variant, function() {
                    return {
                        triangles: GLStroker.expand(path, width, cap, join,
                                miterLimit),
                        bounds: path.getBounds(width / 2 + 1)
                    };
                });
            this._stencilThenCover(geometry.triangles, geometry.bounds, 'union',
                    this._getPaint(state.strokeStyle), state.matrix);
        },

        fillRect: function(x, y, width, height) {
            var path = this._path,
                cacheable = this._cacheable;
            // A scratch path must never be stored under the current item's
            // key, or it would be replayed in place of that item's geometry.
            this._path = new GLPath();
            this._cacheable = false;
            this.rect(x, y, width, height);
            this.fill();
            this._path = path;
            this._cacheable = cacheable;
        },

        strokeRect: function(x, y, width, height) {
            var path = this._path,
                cacheable = this._cacheable;
            this._path = new GLPath();
            this._cacheable = false;
            this.rect(x, y, width, height);
            this.stroke();
            this._path = path;
            this._cacheable = cacheable;
        },

        clearRect: function(x, y, width, height) {
            this._flushBatch();
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
            var state = this._state,
                m = state.matrix,
                local = this._getFillTriangles(this._path),
                triangles = new Array(local.length);
            // A clip outlives the transform that defined it and is rebuilt
            // later against whatever matrix is current then, so bake this one
            // in now and keep clip geometry in device space.
            for (var i = 0, l = local.length; i < l; i += 2) {
                var x = local[i],
                    y = local[i + 1];
                triangles[i] = m._a * x + m._c * y + m._tx;
                triangles[i + 1] = m._b * x + m._d * y + m._ty;
            }
            // Copy on write, so a save() taken before this clip still refers
            // to the old configuration and restore() stays free.
            state.clip = state.clip.concat([{
                triangles: triangles,
                rule: fillRule === 'evenodd' ? 'evenodd' : 'nonzero'
            }]);
        },

        isPointInPath: function(x, y, fillRule) {
            // The path is recorded untransformed, and Paper.js only calls this
            // through PathItem#_contains, which draws into a fresh context
            // with an identity transform and passes a point in that same
            // space, so the coordinates are compared as given.
            var px = x,
                py = y,
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
            this._drawCalls++;
            this._vertices += count;
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
            this._drawCalls++;
        },

        _useProgram: function(name, fragmentSource, matrix) {
            var device = this._device,
                entry = device.getProgram(name, GLShaders.vertex,
                        fragmentSource),
                size = device.getSize();
            device.useProgram(entry);
            device.gl.uniform2f(device.getUniform(entry, 'u_resolution'),
                    size.width, size.height);
            device.gl.uniformMatrix3fv(device.getUniform(entry, 'u_matrix'),
                    false, matrix ? toMat3(matrix) : IDENTITY_MAT3);
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
                // The cover quad is already in device space; only the gradient
                // *geometry* below is mapped through the CTM.
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

        /**
         * Starts a fresh occupancy grid for a new batch, reallocating it only
         * when the viewport changed. Cells are stamped with a generation
         * counter, so starting a batch is an increment rather than a clear.
         */
        _resetBatchGrid: function() {
            var size = this._device.getSize(),
                cols = Math.max(1, Math.ceil(size.width / BATCH_CELL)),
                rows = Math.max(1, Math.ceil(size.height / BATCH_CELL));
            if (!this._batchGrid || this._batchCols !== cols
                    || this._batchRows !== rows) {
                this._batchGrid = new Uint32Array(cols * rows);
                this._batchOwner = new Float64Array(cols * rows);
                this._batchCols = cols;
                this._batchRows = rows;
                this._batchGeneration = 0;
            }
            if (++this._batchGeneration === 0xffffffff) {
                this._batchGrid.fill(0);
                this._batchGeneration = 1;
            }
        },

        /**
         * Claims the cells a device-space quad covers for `owner`, returning
         * false if any of them already belongs to a *different* shape in this
         * batch.
         *
         * Two shapes may share a stencil pass only when they cannot corrupt
         * each other's coverage. Different items must therefore not overlap:
         * the stencil holds one set of counters per pixel. The same item is
         * the exception - its fill and its stroke use disjoint bits, and the
         * cover passes run fill-before-stroke, which is the order Paper.js
         * asked for anyway.
         */
        _claimCells: function(quad, owner) {
            var grid = this._batchGrid,
                owners = this._batchOwner,
                cols = this._batchCols,
                gen = this._batchGeneration,
                c0 = Math.max(0, Math.floor(quad[0] / BATCH_CELL)),
                r0 = Math.max(0, Math.floor(quad[1] / BATCH_CELL)),
                c1 = Math.min(cols - 1, Math.floor((quad[2] - 1) / BATCH_CELL)),
                r1 = Math.min(this._batchRows - 1,
                        Math.floor((quad[3] - 1) / BATCH_CELL)),
                r, c, i;
            for (r = r0; r <= r1; r++) {
                for (c = c0; c <= c1; c++) {
                    i = r * cols + c;
                    if (grid[i] === gen && owners[i] !== owner)
                        return false;
                }
            }
            for (r = r0; r <= r1; r++) {
                for (c = c0; c <= c1; c++) {
                    i = r * cols + c;
                    grid[i] = gen;
                    owners[i] = owner;
                }
            }
            return true;
        },

        /**
         * Queues one solid-painted shape instead of drawing it immediately.
         *
         * The whole batch is rasterized by #_flushBatch() in a handful of draw
         * calls rather than two per shape, which is the point: at a few hundred
         * small items the per-item driver overhead, not the fragment work, is
         * what costs the frame.
         *
         * Geometry is transformed to device space here rather than by a
         * per-shape uniform, since a batch has one buffer and many transforms.
         * The tessellation cache still holds, so what is paid per frame is a
         * matrix multiply per vertex, not a re-flattening of the curves.
         */
        _appendToBatch: function(triangles, quad, matrix, rule, color) {
            var batch = this._batch,
                item = this._currentItem,
                // Shapes with no item of their own (selection handles, scratch
                // paths) must never be treated as sharing an owner, so give
                // each a distinct negative id.
                owner = item ? item._id : -(++this._batchAnonymous);
            if (batch && batch.vertices > BATCH_MAX_VERTICES) {
                this._flushBatch();
                batch = null;
            }
            if (!batch) {
                this._resetBatchGrid();
                batch = this._batch = this._newBatch();
            }
            if (!this._claimCells(quad, owner)) {
                // Overlaps a different shape already queued. Flushing keeps
                // painter order intact: everything queued before this shape
                // reaches the framebuffer before it does.
                this._flushBatch();
                this._resetBatchGrid();
                batch = this._batch = this._newBatch();
                this._claimCells(quad, owner);
            }
            var target = batch[rule],
                stencil = target.stencil,
                count = triangles.length,
                out, n, i;
            stencil.reserve(count);
            out = stencil.data;
            n = stencil.length;
            if (matrix) {
                var a = matrix._a, b = matrix._b, c = matrix._c, d = matrix._d,
                    tx = matrix._tx, ty = matrix._ty;
                for (i = 0; i < count; i += 2) {
                    var x = triangles[i],
                        y = triangles[i + 1];
                    out[n++] = a * x + c * y + tx;
                    out[n++] = b * x + d * y + ty;
                }
            } else {
                for (i = 0; i < count; i++)
                    out[n++] = triangles[i];
            }
            stencil.length = n;
            batch.vertices += count / 2;

            var cover = target.cover,
                x0 = quad[0], y0 = quad[1], x1 = quad[2], y1 = quad[3],
                cr = color[0], cg = color[1], cb = color[2], ca = color[3];
            // Two triangles, carrying this shape's colour per vertex so one
            // draw can shade many differently painted shapes.
            cover.reserve(36);
            out = cover.data;
            n = cover.length;
            var corners = [x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1];
            for (i = 0; i < 12; i += 2) {
                out[n++] = corners[i];
                out[n++] = corners[i + 1];
                out[n++] = cr;
                out[n++] = cg;
                out[n++] = cb;
                out[n++] = ca;
            }
            cover.length = n;
            this._batchedShapes++;
        },

        /**
         * Batches are reused across frames so their buffers keep the capacity
         * they grew to, instead of reallocating every flush.
         */
        _newBatch: function() {
            var batch = this._batchPool;
            if (!batch) {
                batch = this._batchPool = {
                    nonzero: {
                        stencil: new VertexBuffer(),
                        cover: new VertexBuffer()
                    },
                    union: {
                        stencil: new VertexBuffer(),
                        cover: new VertexBuffer()
                    },
                    vertices: 0
                };
            }
            batch.nonzero.stencil.reset();
            batch.nonzero.cover.reset();
            batch.union.stencil.reset();
            batch.union.cover.reset();
            batch.vertices = 0;
            return batch;
        },

        /**
         * Draws a VertexBuffer of device-space positions, straight from its
         * typed array with no intermediate copy.
         */
        _drawBuffer: function(buffer) {
            var device = this._device,
                gl = device.gl,
                count = buffer.length / 2;
            device.upload(buffer.data, count);
            gl.drawArrays(gl.TRIANGLES, 0, count);
            this._drawCalls++;
            this._vertices += count;
        },

        _drawBatchCover: function(cover) {
            var device = this._device,
                gl = device.gl,
                count = cover.length / 6,
                entry = device.getProgram('batchSolid', GLShaders.batchVertex,
                        GLShaders.batchSolid),
                size = device.getSize();
            device.useProgram(entry);
            gl.uniform2f(device.getUniform(entry, 'u_resolution'),
                    size.width, size.height);
            device.uploadColored(cover.data, count);
            gl.drawArrays(gl.TRIANGLES, 0, count);
            this._drawCalls++;
        },

        /**
         * Rasterizes the pending batch. Both rules are stencilled first, into
         * their own bits, then covered fill-before-stroke.
         */
        _flushBatch: function() {
            var batch = this._batch;
            // Cleared first: the draws below must not see a pending batch, and
            // the next shape starts a fresh one from the pool.
            this._batch = null;
            if (!batch || !batch.vertices)
                return;
            var gl = this._device.gl,
                rules = ['nonzero', 'union'],
                i, rule, target;

            gl.enable(gl.STENCIL_TEST);
            gl.colorMask(false, false, false, false);
            // Batched geometry is already in device space, so the identity.
            this._useProgram('none', GLShaders.none);
            for (i = 0; i < 2; i++) {
                target = batch[rules[i]];
                if (target.stencil.length) {
                    this._setStencilRule(rules[i]);
                    this._drawBuffer(target.stencil);
                }
            }

            gl.colorMask(true, true, true, true);
            for (i = 0; i < 2; i++) {
                rule = rules[i];
                target = batch[rule];
                if (!target.cover.length)
                    continue;
                var mask = rule === 'union' ? UNION_BIT : NONZERO_MASK;
                gl.stencilMask(mask);
                if (this._clipping) {
                    // Passes where the clip bit is set *and* some rule bit is:
                    // CLIP_BIT < (clip | rule bits) holds only in that case,
                    // since every rule mask is below CLIP_BIT.
                    gl.stencilFunc(gl.LESS, CLIP_BIT, CLIP_BIT | mask);
                } else {
                    gl.stencilFunc(gl.NOTEQUAL, 0, mask);
                }
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
                this._drawBatchCover(target.cover);
                if (this._clipping) {
                    // Covered pixels outside the clip kept their bits, so
                    // clear them. The same buffer serves; colours are masked.
                    gl.colorMask(false, false, false, false);
                    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
                    gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
                    this._drawBatchCover(target.cover);
                    gl.colorMask(true, true, true, true);
                }
            }
            gl.disable(gl.STENCIL_TEST);
            gl.stencilMask(0xff);
        },

        /**
         * @param {Number[]} triangles coverage geometry, in the space `matrix`
         *     maps to device space (identity when already in device space)
         * @param {Number[]} bounds the geometry's bounds, in that same space
         */
        _stencilThenCover: function(triangles, bounds, rule, paint, matrix) {
            if (!triangles.length || !bounds)
                return;
            var device = this._device,
                gl = device.gl,
                size = device.getSize();
            this._checkComposite();
            this._syncClip();
            // The cover quad has to be in device space, so map the geometry's
            // bounds through the matrix. A rotation makes the transformed box
            // non-axis-aligned, hence all four corners rather than two.
            var xs = [],
                ys = [];
            for (var i = 0; i < 4; i++) {
                var bx = bounds[i & 1 ? 2 : 0],
                    by = bounds[i & 2 ? 3 : 1];
                if (matrix) {
                    xs.push(matrix._a * bx + matrix._c * by + matrix._tx);
                    ys.push(matrix._b * bx + matrix._d * by + matrix._ty);
                } else {
                    xs.push(bx);
                    ys.push(by);
                }
            }
            var x0 = Math.max(0, Math.floor(Math.min.apply(Math, xs))),
                y0 = Math.max(0, Math.floor(Math.min.apply(Math, ys))),
                x1 = Math.min(size.width, Math.ceil(Math.max.apply(Math, xs))),
                y1 = Math.min(size.height, Math.ceil(Math.max.apply(Math, ys)));
            if (x1 <= x0 || y1 <= y0)
                return;
            var quad = [x0, y0, x1, y1];

            // A solid paint is expressible as a per-vertex colour, so the
            // shape can join the pending batch and be drawn alongside its
            // neighbours. Gradients, images and text need their own uniforms
            // or textures and fall through to the direct path below.
            // Even-odd is left on the direct path: it is rare, and it would
            // need a third disjoint stencil bit to coexist with the others.
            if (paint.type === 'solid' && rule !== 'evenodd'
                    && this._batchEnabled !== false) {
                var c = paint.color,
                    a = c[3] * this._state.globalAlpha;
                this._appendToBatch(triangles, quad, matrix, rule,
                        // Premultiplied, matching the blend function.
                        [c[0] * a, c[1] * a, c[2] * a, a]);
                return;
            }
            // Anything drawn directly must not jump ahead of shapes already
            // queued behind it.
            this._flushBatch();

            // Pass 1: accumulate coverage in the scratch stencil bits. The
            // coverage geometry is transformed on the GPU; the cover pass
            // below draws a device-space quad and so uses the identity.
            gl.enable(gl.STENCIL_TEST);
            gl.colorMask(false, false, false, false);
            this._useProgram('none', GLShaders.none, matrix);
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
            if (rule === 'evenodd') {
                // A single toggling bit is all the even-odd rule needs.
                gl.stencilFunc(gl.ALWAYS, 1, 0xff);
                gl.stencilMask(0x01);
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
            } else if (rule === 'union') {
                // Coverage without counting, so overlapping stroke geometry is
                // not blended twice. REPLACE writes ref masked by the stencil
                // mask, so ref must carry the union bit itself.
                gl.stencilFunc(gl.ALWAYS, UNION_BIT, 0xff);
                gl.stencilMask(UNION_BIT);
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
            } else {
                gl.stencilFunc(gl.ALWAYS, 0, 0xff);
                gl.stencilMask(NONZERO_MASK);
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
            // Queued shapes were recorded under the outgoing clip and have to
            // reach the framebuffer before it changes.
            this._flushBatch();
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
            this._flushBatch();
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
            // The batch has to have reached the framebuffer before it is read.
            this._flushBatch();
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
            this._flushBatch();
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
