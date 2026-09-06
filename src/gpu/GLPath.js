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
 * @name GLPath
 * @class Accumulates the path currently being built by a {@link GLContext},
 *     already flattened to polylines in device space.
 *
 * Canvas2D transforms path points by the CTM in effect when each command is
 * issued, so GLContext applies the CTM before handing coordinates over and
 * everything stored here is in device pixels. Since affine transforms map
 * béziers to béziers, flattening after transformation is exact and lets the
 * tolerance be expressed directly in output pixels.
 *
 * @private
 */
var GLPath = Base.extend(/** @lends GLPath# */{
    _class: 'GLPath',

    // Maximum deviation of the polyline from the true curve, in device pixels.
    _tolerance: 0.2,

    initialize: function GLPath() {
        this.reset();
    },

    reset: function() {
        this.contours = [];
        this._current = null;
        this._x = 0;
        this._y = 0;
        this._startX = 0;
        this._startY = 0;
        this._min = [Infinity, Infinity];
        this._max = [-Infinity, -Infinity];
        return this;
    },

    isEmpty: function() {
        return !this.contours.length;
    },

    moveTo: function(x, y) {
        this._current = { coords: [x, y], closed: false };
        this.contours.push(this._current);
        this._x = this._startX = x;
        this._y = this._startY = y;
        this._include(x, y);
    },

    lineTo: function(x, y) {
        // Canvas2D treats lineTo() without a preceding moveTo() as a moveTo().
        if (!this._current) {
            this.moveTo(x, y);
        } else {
            this._current.coords.push(x, y);
            this._x = x;
            this._y = y;
            this._include(x, y);
        }
    },

    cubicTo: function(x1, y1, x2, y2, x3, y3) {
        if (!this._current)
            this.moveTo(x1, y1);
        this._flatten(this._x, this._y, x1, y1, x2, y2, x3, y3, 0);
        // Emit the exact end point rather than a subdivided approximation of
        // it, so consecutive curves stay watertight.
        this.lineTo(x3, y3);
    },

    quadraticTo: function(x1, y1, x2, y2) {
        var x0 = this._x,
            y0 = this._y;
        // Elevate the quadratic to an equivalent cubic.
        this.cubicTo(
                x0 + 2 / 3 * (x1 - x0), y0 + 2 / 3 * (y1 - y0),
                x2 + 2 / 3 * (x1 - x2), y2 + 2 / 3 * (y1 - y2),
                x2, y2);
    },

    close: function() {
        var current = this._current;
        if (current) {
            current.closed = true;
            this._x = this._startX;
            this._y = this._startY;
        }
    },

    /**
     * Recursive de Casteljau subdivision, using the Anti-Grain flatness
     * criterion: a curve is flat once both control points lie within the
     * tolerance of the chord.
     */
    _flatten: function(x0, y0, x1, y1, x2, y2, x3, y3, depth) {
        if (depth < 16) {
            var dx = x3 - x0,
                dy = y3 - y0,
                // Perpendicular distances of both control points from the
                // chord, scaled by the chord length (compared squared below).
                d1 = (x1 - x3) * dy - (y1 - y3) * dx,
                d2 = (x2 - x3) * dy - (y2 - y3) * dx,
                dd = d1 + d2,
                tolerance = this._tolerance;
            if (dd * dd <= tolerance * tolerance * (dx * dx + dy * dy)
                    // Guard against the degenerate case of a zero-length chord
                    // with control points far away, where the test above is
                    // trivially satisfied.
                    && Math.abs(x1 - x0) + Math.abs(x2 - x0)
                        + Math.abs(x1 - x3) + Math.abs(x2 - x3)
                        + Math.abs(y1 - y0) + Math.abs(y2 - y0)
                        + Math.abs(y1 - y3) + Math.abs(y2 - y3)
                        <= tolerance * 8) {
                return;
            }
            var x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2,
                x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2,
                x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2,
                x012 = (x01 + x12) / 2, y012 = (y01 + y12) / 2,
                x123 = (x12 + x23) / 2, y123 = (y12 + y23) / 2,
                xm = (x012 + x123) / 2, ym = (y012 + y123) / 2;
            this._flatten(x0, y0, x01, y01, x012, y012, xm, ym, depth + 1);
            this.lineTo(xm, ym);
            this._flatten(xm, ym, x123, y123, x23, y23, x3, y3, depth + 1);
        }
    },

    _include: function(x, y) {
        var min = this._min,
            max = this._max;
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
    },

    /**
     * Returns the device-space bounds of the path as [x0, y0, x1, y1], padded
     * by the given amount. Returns null for an empty path.
     */
    getBounds: function(padding) {
        var min = this._min,
            max = this._max;
        if (min[0] > max[0])
            return null;
        padding = padding || 0;
        return [
            min[0] - padding, min[1] - padding,
            max[0] + padding, max[1] + padding
        ];
    },

    /**
     * Returns the total number of points across all contours.
     */
    getPointCount: function() {
        var contours = this.contours,
            count = 0;
        for (var i = 0, l = contours.length; i < l; i++)
            count += contours[i].coords.length / 2;
        return count;
    },

    clone: function() {
        var copy = new GLPath(),
            contours = this.contours;
        for (var i = 0, l = contours.length; i < l; i++) {
            var contour = contours[i];
            copy.contours.push({
                coords: contour.coords.slice(),
                closed: contour.closed
            });
        }
        copy._min = this._min.slice();
        copy._max = this._max.slice();
        copy._x = this._x;
        copy._y = this._y;
        copy._startX = this._startX;
        copy._startY = this._startY;
        copy._current = copy.contours[copy.contours.length - 1] || null;
        return copy;
    }
});
