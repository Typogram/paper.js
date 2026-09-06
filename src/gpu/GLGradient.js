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
 * @name GLGradient
 * @class The GPU stand-in for CanvasGradient.
 *
 * {@link Color#toCanvasStyle} builds gradients purely by calling
 * `ctx.createLinearGradient()` / `ctx.createRadialGradient()` and then
 * `addColorStop()` on the result, so returning an object of this shape makes
 * every gradient in the library work without a single change to `Color.js`.
 *
 * The stops are baked into a 256 pixel ramp texture on first use and sampled
 * with linear filtering, which reproduces the interpolation Canvas2D performs
 * in unpremultiplied sRGB.
 *
 * @private
 */
var GLGradient = Base.extend(/** @lends GLGradient# */{
    _class: 'GLGradient',

    initialize: function GLGradient(radial, x0, y0, x1, y1, radius) {
        this._radial = radial;
        this._x0 = x0;
        this._y0 = y0;
        this._x1 = x1;
        this._y1 = y1;
        this._radius = radius;
        // Note that the geometry stays in user space: Canvas2D interprets
        // gradient coordinates in the coordinate system current at the time of
        // *painting*, so GLContext maps them through the CTM in _bindPaint().
        this._stops = [];
        this._texture = null;
    },

    addColorStop: function(offset, color) {
        this._stops.push({ offset: offset, color: color });
        // Invalidate any ramp built from the previous stop list.
        this._dirty = true;
    },

    _getRamp: function(device) {
        var gl = device.gl;
        if (this._texture && !this._dirty)
            return this._texture;
        this._dirty = false;
        if (!this._texture)
            this._texture = gl.createTexture();
        var size = 256,
            data = new Uint8Array(size * 4),
            stops = this._stops.slice();
        stops.sort(function(a, b) {
            return a.offset - b.offset;
        });
        if (!stops.length)
            stops.push({ offset: 0, color: 'rgba(0,0,0,0)' });
        var colors = [];
        for (var i = 0, l = stops.length; i < l; i++)
            colors.push(GLGradient._parse(stops[i].color));
        for (var i = 0; i < size; i++) {
            var t = i / (size - 1),
                index = 0;
            while (index < stops.length - 1 && stops[index + 1].offset < t)
                index++;
            var from = stops[index],
                to = stops[Math.min(index + 1, stops.length - 1)],
                span = to.offset - from.offset,
                // Constant before the first stop and after the last, matching
                // the Canvas2D behaviour.
                f = span > 0 ? Math.max(0, Math.min(1,
                        (t - from.offset) / span)) : 0,
                a = colors[index],
                b = colors[Math.min(index + 1, colors.length - 1)];
            for (var j = 0; j < 4; j++) {
                data[i * 4 + j] = Math.round(
                        (a[j] + (b[j] - a[j]) * f) * 255);
            }
        }
        gl.bindTexture(gl.TEXTURE_2D, this._texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, 1, 0, gl.RGBA,
                gl.UNSIGNED_BYTE, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return this._texture;
    },

    statics: {
        // Assigned by GLContext, which owns the colour parser.
        _parse: null
    }
});
