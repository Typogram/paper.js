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
 * @name GLStroker
 * @class Expands the flattened polylines of a {@link GLPath} into the triangle
 *     soup that covers the stroked region.
 *
 * The output is deliberately allowed to self-overlap at joins and caps: it is
 * rasterized through a union stencil pass (see GLContext#_stencilThenCover),
 * so overlapping triangles contribute coverage exactly once and translucent
 * strokes do not double-blend along their own seams.
 *
 * @private
 */
var GLStroker = new function() {

    // Emits the two triangles covering the quad a-b-c-d.
    function quad(out, ax, ay, bx, by, cx, cy, dx, dy) {
        out.push(ax, ay, bx, by, cx, cy, ax, ay, cx, cy, dx, dy);
    }

    // Emits a triangle fan approximating the disc of the given radius, used
    // for both round joins and round caps. Emitting the full disc rather than
    // just the covered wedge is correct under union rasterization and avoids
    // having to reason about the turn direction.
    function disc(out, cx, cy, radius) {
        // One segment per ~0.2px of sagitta, clamped to a sane range.
        var steps = Math.max(8, Math.min(128,
                Math.ceil(Math.PI / Math.acos(Math.max(-1,
                    1 - 0.2 / Math.max(radius, 0.2)))))),
            step = Math.PI * 2 / steps,
            px = cx + radius,
            py = cy;
        for (var i = 1; i <= steps; i++) {
            var angle = i * step,
                x = cx + Math.cos(angle) * radius,
                y = cy + Math.sin(angle) * radius;
            out.push(cx, cy, px, py, x, y);
            px = x;
            py = y;
        }
    }

    // Angular step that keeps the sagitta of an arc approximation under
    // ~0.2 units at the given radius.
    function arcStep(radius) {
        return 2 * Math.acos(Math.max(-1, 1 - 0.2 / Math.max(radius, 0.2)));
    }

    // Fills the outer corner of a round join with a fan spanning only the
    // turn, rather than a whole disc. A flattened curve has a join at every
    // segment, each turning a few degrees, so emitting a full disc at each one
    // was by far the largest source of stroke geometry: a stroked circle came
    // out at hundreds of vertices where tens will do.
    function wedge(out, cx, cy, a0, a1, radius) {
        var delta = a1 - a0;
        // Take the short way round; the long way is the inner side, which the
        // segment quads already cover.
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        var steps = Math.max(1, Math.min(64,
                Math.ceil(Math.abs(delta) / arcStep(radius)))),
            step = delta / steps,
            px = cx + Math.cos(a0) * radius,
            py = cy + Math.sin(a0) * radius;
        for (var i = 1; i <= steps; i++) {
            var angle = a0 + step * i,
                x = cx + Math.cos(angle) * radius,
                y = cy + Math.sin(angle) * radius;
            out.push(cx, cy, px, py, x, y);
            px = x;
            py = y;
        }
    }

    function join(out, style, miterLimit, x, y, d0x, d0y, d1x, d1y, radius) {
        var cross = d0x * d1y - d0y * d1x;
        // Collinear: nothing to fill in.
        if (!cross)
            return;
        if (style === 'round') {
            var s = cross > 0 ? -1 : 1;
            wedge(out, x, y,
                    Math.atan2(d0x * s, d0y * -s),
                    Math.atan2(d1x * s, d1y * -s), radius);
            return;
        }
        // Left normals of both segments, flipped to whichever side is on the
        // outside of the turn.
        var sign = cross > 0 ? -1 : 1,
            n0x = -d0y * sign, n0y = d0x * sign,
            n1x = -d1y * sign, n1y = d1x * sign,
            o0x = x + n0x * radius, o0y = y + n0y * radius,
            o1x = x + n1x * radius, o1y = y + n1y * radius;
        if (style === 'miter') {
            var mx = n0x + n1x,
                my = n0y + n1y,
                length = Math.sqrt(mx * mx + my * my);
            if (length > 1e-9) {
                mx /= length;
                my /= length;
                var cos = mx * n0x + my * n0y;
                // 1 / cos is the miter length as a multiple of the half-width,
                // which is what strokeMiterLimit is defined against.
                if (cos > 1e-9 && 1 / cos <= miterLimit) {
                    var scale = radius / cos,
                        px = x + mx * scale,
                        py = y + my * scale;
                    out.push(x, y, o0x, o0y, px, py);
                    out.push(x, y, px, py, o1x, o1y);
                    return;
                }
            }
            // Fall through to bevel when the miter limit is exceeded, as
            // Canvas2D does.
        }
        out.push(x, y, o0x, o0y, o1x, o1y);
    }

    function cap(out, style, x, y, dx, dy, radius) {
        if (style === 'round') {
            disc(out, x, y, radius);
        } else if (style === 'square') {
            var nx = -dy * radius,
                ny = dx * radius,
                ex = dx * radius,
                ey = dy * radius;
            quad(out,
                    x + nx, y + ny,
                    x + nx + ex, y + ny + ey,
                    x - nx + ex, y - ny + ey,
                    x - nx, y - ny);
        }
        // 'butt' adds nothing.
    }

    return /** @lends GLStroker */{
        /**
         * @param {GLPath} path the flattened path, in device space
         * @param {Number} width the stroke width, in device pixels
         * @param {String} lineCap one of 'butt', 'round', 'square'
         * @param {String} lineJoin one of 'miter', 'round', 'bevel'
         * @param {Number} miterLimit
         * @return {Number[]} a flat list of triangle coordinates
         */
        expand: function(path, width, lineCap, lineJoin, miterLimit) {
            var out = [],
                radius = Math.max(width, 0.5) / 2,
                contours = path.contours;
            for (var i = 0, l = contours.length; i < l; i++) {
                var contour = contours[i],
                    coords = contour.coords,
                    closed = contour.closed,
                    // Directions and lengths of the non-degenerate segments,
                    // collected first so joins can see both neighbours.
                    points = [],
                    count = coords.length / 2;
                // Drop repeated points, which would otherwise produce NaN
                // directions.
                for (var j = 0; j < count; j++) {
                    var x = coords[j * 2],
                        y = coords[j * 2 + 1],
                        last = points.length;
                    if (!last || Math.abs(x - points[last - 2]) > 1e-9
                            || Math.abs(y - points[last - 1]) > 1e-9) {
                        points.push(x, y);
                    }
                }
                var num = points.length / 2;
                if (closed && num > 1
                        && Math.abs(points[0] - points[num * 2 - 2]) < 1e-9
                        && Math.abs(points[1] - points[num * 2 - 1]) < 1e-9) {
                    // A closed contour that already repeats its first point:
                    // drop the duplicate, the wrap-around below handles it.
                    points.length -= 2;
                    num--;
                }
                if (num < 2) {
                    // A degenerate contour still paints a dot under round or
                    // square caps, matching Canvas2D.
                    if (num === 1 && !closed && lineCap !== 'butt') {
                        if (lineCap === 'round') {
                            disc(out, points[0], points[1], radius);
                        } else {
                            quad(out,
                                    points[0] - radius, points[1] - radius,
                                    points[0] + radius, points[1] - radius,
                                    points[0] + radius, points[1] + radius,
                                    points[0] - radius, points[1] + radius);
                        }
                    }
                    continue;
                }
                var segments = closed ? num : num - 1,
                    dirs = [];
                for (var j = 0; j < segments; j++) {
                    var k = (j + 1) % num,
                        x0 = points[j * 2], y0 = points[j * 2 + 1],
                        x1 = points[k * 2], y1 = points[k * 2 + 1],
                        dx = x1 - x0, dy = y1 - y0,
                        length = Math.sqrt(dx * dx + dy * dy);
                    dx /= length;
                    dy /= length;
                    dirs.push(dx, dy);
                    var nx = -dy * radius,
                        ny = dx * radius;
                    quad(out,
                            x0 + nx, y0 + ny,
                            x1 + nx, y1 + ny,
                            x1 - nx, y1 - ny,
                            x0 - nx, y0 - ny);
                }
                // Joins at every vertex shared by two segments.
                var joins = closed ? num : num - 2;
                for (var j = 0; j < joins; j++) {
                    var prev = closed ? (j + segments - 1) % segments : j,
                        next = closed ? j : j + 1,
                        vertex = closed ? j : j + 1;
                    join(out, lineJoin, miterLimit,
                            points[vertex * 2], points[vertex * 2 + 1],
                            dirs[prev * 2], dirs[prev * 2 + 1],
                            dirs[next * 2], dirs[next * 2 + 1],
                            radius);
                }
                if (!closed) {
                    cap(out, lineCap, points[0], points[1],
                            -dirs[0], -dirs[1], radius);
                    cap(out, lineCap,
                            points[num * 2 - 2], points[num * 2 - 1],
                            dirs[segments * 2 - 2], dirs[segments * 2 - 1],
                            radius);
                }
            }
            return out;
        }
    };
};
