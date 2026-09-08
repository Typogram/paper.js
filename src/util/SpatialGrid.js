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
 * @name SpatialGrid
 * @class A uniform grid over a fixed set of leaf items' bounds, built once in
 * *project* space rather than device space, so it stays valid across pan and
 * zoom - only an actual edit to the indexed items requires a rebuild.
 *
 * This exists because {@link Item#draw}'s viewport cull check, while cheap
 * per item, still costs one bounds computation and one rectangle test for
 * every item in the scene, every frame - fine at a few thousand items, but at
 * tens of thousands it becomes the floor under panning speed even once every
 * offscreen item is being correctly skipped. A grid turns "which items are
 * near the viewport" from an O(n) scan into a handful of bucket lookups, at
 * the cost of only tracking leaf items and requiring an explicit rebuild
 * (see {@link FastCanvasView#rebuildIndex}) when the scene's items - not just
 * the camera - change.
 *
 * @private
 */
var SpatialGrid = Base.extend(/** @lends SpatialGrid# */{
    _class: 'SpatialGrid',

    initialize: function SpatialGrid() {
        this.clear();
    },

    clear: function() {
        this._cellSize = 1;
        this._cols = 0;
        this._originX = 0;
        this._originY = 0;
        // Sparse: keyed by "col,row", each entry an array of item ids.
        this._cells = {};
        this._built = false;
    },

    /**
     * Rebuilds the grid from the given items' current bounds. Only items
     * without children are indexed - see the note in Item#draw().
     *
     * @param {Item[]} items
     */
    build: function(items) {
        this.clear();
        var leaves = [],
            bounds = [],
            minX = Infinity, minY = Infinity,
            maxX = -Infinity, maxY = -Infinity;
        for (var i = 0, l = items.length; i < l; i++) {
            var item = items[i];
            if (item.hasChildren())
                continue;
            var b = item.getStrokeBounds();
            if (!b.width && !b.height)
                continue;
            leaves.push(item);
            bounds.push(b);
            minX = Math.min(minX, b.left);
            minY = Math.min(minY, b.top);
            maxX = Math.max(maxX, b.right);
            maxY = Math.max(maxY, b.bottom);
        }
        var count = leaves.length;
        if (!count)
            return;
        // Aim for roughly one item per cell on average: a grid this coarse
        // keeps the cells-per-query low without each cell holding so many
        // items that the point of indexing them is lost.
        var width = Math.max(maxX - minX, 1e-6),
            height = Math.max(maxY - minY, 1e-6),
            cellSize = Math.max(Math.sqrt((width * height) / count), 1e-6);
        this._cellSize = cellSize;
        this._originX = minX;
        this._originY = minY;
        this._cols = Math.max(1, Math.ceil(width / cellSize) + 1);
        var cells = this._cells;
        for (var i = 0; i < count; i++) {
            var item = leaves[i],
                b = bounds[i],
                c0 = this._col(b.left), c1 = this._col(b.right),
                r0 = this._row(b.top), r1 = this._row(b.bottom);
            for (var r = r0; r <= r1; r++) {
                for (var c = c0; c <= c1; c++) {
                    var key = r * this._cols + c,
                        cell = cells[key];
                    if (!cell)
                        cell = cells[key] = [];
                    cell.push(item._id);
                }
            }
        }
        this._built = true;
    },

    _col: function(x) {
        return Math.floor((x - this._originX) / this._cellSize);
    },

    _row: function(y) {
        return Math.floor((y - this._originY) / this._cellSize);
    },

    /**
     * @param {Rectangle} rect a rectangle in the same (project) space the
     *     grid was built in
     * @return {Set|null} the ids of indexed items whose cell may overlap
     *     `rect`, or `null` if the grid holds nothing (callers should then
     *     fall back to the plain per-item bounds check)
     */
    query: function(rect) {
        if (!this._built)
            return null;
        var cells = this._cells,
            c0 = this._col(rect.left), c1 = this._col(rect.right),
            r0 = this._row(rect.top), r1 = this._row(rect.bottom),
            result = new Set();
        for (var r = r0; r <= r1; r++) {
            for (var c = c0; c <= c1; c++) {
                var cell = cells[r * this._cols + c];
                if (cell) {
                    for (var i = 0, l = cell.length; i < l; i++)
                        result.add(cell[i]);
                }
            }
        }
        return result;
    }
});
