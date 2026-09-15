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
 * @name SvgView
 * @class
 * @private
 *
 * A View implementation that renders a project into a native SVG DOM tree,
 * instead of rasterizing it into a 2D canvas on every frame.
 *
 * It is a drop-in replacement for {@link CanvasView}: no part of the public
 * Paper.js API changes, items are created, styled and modified in exactly the
 * same way. Which renderer a project uses is purely a matter of configuration,
 * see {@link View.create()}:
 *
 * - `paper.settings.renderer = 'svg'`, before calling `paper.setup()`
 * - a `renderer="svg"` / `data-paper-renderer="svg"` attribute on the element
 *   that is passed to `paper.setup()`
 * - passing an `<svg>` element to `paper.setup()` instead of a `<canvas>`
 *
 * Rather than redrawing the scene on each frame, the view keeps one DOM node
 * per item alive and mirrors changes into it, learning about them through the
 * change tracking of {@link Project#_changed()}, which it activates on the
 * project it renders. Panning and zooming therefore only costs one `transform`
 * attribute update on the root group, no matter how many items the project
 * holds, since nothing about the items themselves changes — the browser's own
 * render tree, which retains the rasterized geometry, does the rest.
 */
var SvgView = View.extend(new function() {
    // Numbers in attribute values are formatted through this shared formatter,
    // to keep the produced DOM attributes short.
    var // The change flags that require an item's geometry to be written out
        // again, and those that require its style to be, see #_updateItem().
        geometryFlags = /*#=*/(ChangeFlag.GEOMETRY | ChangeFlag.SEGMENTS)
                | /*#=*/(ChangeFlag.CONTENT | ChangeFlag.PIXELS),
        styleFlags = /*#=*/(ChangeFlag.STYLE | ChangeFlag.STROKE)
                | /*#=*/(ChangeFlag.ATTRIBUTE | ChangeFlag.CONTENT),
        // The flags that require a parent's children to be synchronized.
        childrenFlags = /*#=*/(ChangeFlag.CHILDREN | ChangeFlag.CLIPPING),
        // The flags that mean a raster's pixels may have changed.
        pixelFlags = /*#=*/(ChangeFlag.PIXELS | ChangeFlag.CONTENT),

        // Paper's blend modes that CSS can express, mapped to their CSS name.
        // The five it cannot - 'add', 'subtract', 'average', 'pin-light' and
        // 'negation', which BlendMode emulates in JS for the canvas renderer -
        // are left out deliberately: writing a name CSS does not know makes an
        // invalid declaration that silently renders as 'normal', which is what
        // leaving it out does too, only visibly. 'add' maps to 'plus-lighter',
        // which is the same operation where a browser supports it.
        blendModes = {
            multiply: 'multiply',
            screen: 'screen',
            overlay: 'overlay',
            darken: 'darken',
            lighten: 'lighten',
            'color-dodge': 'color-dodge',
            'color-burn': 'color-burn',
            'hard-light': 'hard-light',
            'soft-light': 'soft-light',
            difference: 'difference',
            exclusion: 'exclusion',
            hue: 'hue',
            saturation: 'saturation',
            color: 'color',
            luminosity: 'luminosity',
            add: 'plus-lighter'
        },

        formatter = new Formatter(5),

        // The SVG tags used to represent the various item classes. Shapes are
        // handled separately, as their tag depends on Shape#type, and
        // CompoundPath is rendered as one single 'path' node, meaning its
        // children never receive nodes of their own.
        tags = {
            Group: 'g',
            Layer: 'g',
            Path: 'path',
            CompoundPath: 'path',
            Shape: 'shape', // Replaced by the actual type in createNode()
            Raster: 'image',
            PointText: 'text',
            SymbolItem: 'use'
        };

    function num(val) {
        return formatter.number(val);
    }

    /**
     * Takes the nodes a view put into an `<svg>` back out of it, leaving
     * anything else in the element untouched.
     *
     * An element the view replaced is thrown away whole, so only elements it
     * adopted - an `<svg>` the application rendered itself, which stays the
     * application's - need this. It runs at both ends of the view's life: on
     * #remove(), so nothing is left on screen that no view updates any more,
     * and when a view adopts an element, so that a view that was never
     * removed cannot leave its scene behind for this one to draw on top of.
     */
    function clearNodes(svg) {
        var nodes = svg.__paperNodes;
        if (nodes) {
            for (var i = 0, l = nodes.length; i < l; i++) {
                var node = nodes[i];
                if (node.parentNode === svg)
                    svg.removeChild(node);
            }
            svg.__paperNodes = null;
        }
    }

    /**
     * Sets or removes an attribute, but only if its value actually changed.
     * Assigning the value an attribute already holds still costs an style
     * invalidation in some browsers, and updates are the common case here.
     */
    function setAttr(node, name, value) {
        if (value == null) {
            if (node.hasAttribute(name))
                node.removeAttribute(name);
        } else {
            value = '' + value;
            if (node.getAttribute(name) !== value)
                node.setAttribute(name, value);
        }
    }

    function createNode(item) {
        var tag = tags[item._class];
        if (tag === 'shape') {
            var type = item._type;
            tag = type === 'rectangle' ? 'rect' : type;
        }
        return tag ? SvgElement.create(tag) : null;
    }

    /**
     * Writes the item's own matrix to its node. Items with an applied matrix
     * (the default for paths) end up without a transform attribute at all.
     */
    function updateMatrix(item, node) {
        var matrix = item._matrix;
        if (matrix.isIdentity()) {
            setAttr(node, 'transform', null);
        } else {
            var values = matrix.getValues();
            setAttr(node, 'transform', 'matrix(' + num(values[0])
                    + ',' + num(values[1])
                    + ',' + num(values[2])
                    + ',' + num(values[3])
                    + ',' + num(values[4])
                    + ',' + num(values[5]) + ')');
        }
    }

    /**
     * A minimal stand-in for a 2D canvas context that records the drawing
     * commands it receives as SVG path data, grouped by the stroke / fill
     * style that was active. It only implements the subset of the context API
     * that the selection drawing code in Item#_drawSelection() and
     * Path#_drawSelected() uses, which lets the SVG renderer reuse that code
     * as-is rather than reimplementing it.
     */
    function Recorder(ctx) {
        // Color#toCanvasStyle() asks the context it is given for gradients,
        // and caches what it gets back on the color. Hand it a real context so
        // what ends up cached is a real CanvasGradient, valid for a canvas
        // renderer using the same color later on.
        this.ctx = ctx;
        this.parts = [];
        this.d = '';
        this.strokeStyle = this.fillStyle = '#009dec';
        // Mirrors the 2D context property, so that code setting it before
        // stroking is not silently ignored: Project#draw() means to reset it,
        // and applications wrap Item#_drawSelection() to weight the outline.
        this.lineWidth = 1;
    }

    Recorder.prototype = {
        beginPath: function() {
            this.d = '';
        },

        moveTo: function(x, y) {
            this.d += 'M' + num(x) + ',' + num(y);
        },

        lineTo: function(x, y) {
            this.d += 'L' + num(x) + ',' + num(y);
        },

        bezierCurveTo: function(c1x, c1y, c2x, c2y, x, y) {
            this.d += 'C' + num(c1x) + ',' + num(c1y)
                    + ' ' + num(c2x) + ',' + num(c2y)
                    + ' ' + num(x) + ',' + num(y);
        },

        closePath: function() {
            this.d += 'z';
        },

        // Only full circles are drawn by the selection code, so the angles are
        // not evaluated here, and two half-circle arcs are produced instead.
        arc: function(x, y, radius) {
            var r = num(radius),
                diameter = num(radius * 2),
                back = num(-radius * 2);
            this.d += 'M' + num(x - radius) + ',' + num(y)
                    + 'a' + r + ',' + r + ' 0 1,0 ' + diameter + ',0'
                    + 'a' + r + ',' + r + ' 0 1,0 ' + back + ',0z';
        },

        stroke: function() {
            this._push(this.d, this.strokeStyle, null, this.lineWidth);
        },

        fill: function() {
            this._push(this.d, null, this.fillStyle, null);
        },

        fillRect: function(x, y, width, height) {
            this._push('M' + num(x) + ',' + num(y)
                    + 'h' + num(width) + 'v' + num(height)
                    + 'h' + num(-width) + 'z', null, this.fillStyle, null);
        },

        // A CanvasGradient cannot paint an SVG node, so a gradient selection
        // color falls back to the default selection color in _push(). Plain
        // colors, which is what selection colors are in practice, come through
        // Color#toCanvasStyle() as CSS strings and are used as they are.
        createLinearGradient: function(x0, y0, x1, y1) {
            return this.ctx.createLinearGradient(x0, y0, x1, y1);
        },

        createRadialGradient: function(x0, y0, r0, x1, y1, r1) {
            return this.ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
        },

        // Collect commands that share the same paint into one path each, so a
        // selected path produces a handful of nodes instead of one per handle.
        _push: function(d, stroke, fill, width) {
            if (!d)
                return;
            if (stroke && typeof stroke !== 'string')
                stroke = '#009dec';
            if (fill && typeof fill !== 'string')
                fill = '#009dec';
            var parts = this.parts,
                last = parts[parts.length - 1];
            if (last && last.stroke === stroke && last.fill === fill
                    && last.width === width) {
                last.d += d;
            } else {
                parts.push({ d: d, stroke: stroke, fill: fill, width: width });
            }
        }
    };

    return /** @lends SvgView# */{
        _class: 'SvgView',

        /**
         * Creates a view object that renders into an SVG element.
         *
         * @name SvgView#initialize
         * @param {SVGElement|HTMLElement|Size} element the `<svg>` element to
         *     render into, an element to replace with a newly created `<svg>`
         *     element (e.g. the `<canvas>` that `paper.setup()` received), or
         *     the size of the `<svg>` element to be created
         */
        initialize: function SvgView(project, element) {
            var svg;
            if (element && element.nodeName
                    && element.nodeName.toLowerCase() === 'svg') {
                svg = element;
                // A view that rendered into this element before leaves its
                // nodes behind if it was not removed, and `project.remove();
                // setup(element)` - what deserializing over a live view does,
                // an undo for instance - would then add a second set beside
                // them and draw both scenes at once. Only the nodes a paper
                // view made are taken out; anything the document itself put
                // in the element stays where it is.
                clearNodes(svg);
            } else {
                if (element && element.nodeType === 1) {
                    // An element that a previous view already took over stands
                    // replaced in the document, so the reference the caller
                    // still holds is detached. Render into the <svg> standing
                    // in for it rather than into a fresh one that is in no
                    // document at all, which is what a second setup() on the
                    // same element would otherwise produce.
                    var existing = element.__paperSvg;
                    if (existing && (existing.parentNode
                            || !element.parentNode)) {
                        svg = existing;
                        while (svg.firstChild)
                            svg.removeChild(svg.firstChild);
                    }
                }
                if (!svg) {
                    svg = SvgElement.create('svg');
                    if (element && element.nodeType === 1) {
                        // Take over the element's identity: its id, classes,
                        // styling and all paper.js attributes (resize, hidpi,
                        // etc.), and then replace it in the DOM. This is what
                        // makes the renderer a configuration switch: an
                        // application that hands `paper.setup()` a <canvas>
                        // keeps working unchanged.
                        var attributes = element.attributes;
                        for (var i = 0, l = attributes.length; i < l; i++) {
                            var attribute = attributes[i];
                            svg.setAttribute(attribute.name, attribute.value);
                        }
                        // A <canvas> has a pixel size even without width and
                        // height attributes, so carry it over to end up with
                        // the size the view would have had with CanvasView.
                        if (typeof element.width === 'number'
                                && typeof element.height === 'number') {
                            SvgElement.set(svg, {
                                width: element.width,
                                height: element.height
                            });
                        }
                        // Keep both ends of the swap, so the element can be
                        // found again on a second setup() and put back in
                        // #remove().
                        svg.__paperReplaced = element;
                        element.__paperSvg = svg;
                        if (element.parentNode)
                            element.parentNode.replaceChild(svg, element);
                    }
                }
                if (!element || element.nodeType !== 1) {
                    var size = Size.read(arguments, 1);
                    if (size.isZero())
                        throw new Error(
                            'Cannot create SvgView with the provided argument: '
                            + Base.slice(arguments, 1));
                    SvgElement.set(svg, {
                        width: size.width,
                        height: size.height
                    });
                }
            }
            // SVG is resolution independent, so there is no HiDPI handling to
            // do, unlike in CanvasView.
            this._pixelRatio = 1;
            // Maps item ids to the DOM node that represents them.
            this._nodes = {};
            // Definitions (gradients, clip-paths, symbols) referenced by nodes.
            this._defs = SvgElement.create('defs');
            // Symbol definitions are shared by all items that use them.
            this._symbols = {};
            // All items are rendered into this group, which carries the view's
            // matrix. Panning and zooming only touch its transform attribute.
            // Pointer events are switched off on it so that events always
            // reach the <svg> element itself, which is the one View's event
            // handling knows about, and so that hit-testing keeps going
            // through Project#hitTest(), as it does with CanvasView.
            this._content = SvgElement.create('g', {
                'pointer-events': 'none'
            });
            // Selection handles are drawn in view coordinates, on top.
            this._overlay = SvgElement.create('g', {
                'pointer-events': 'none'
            });
            svg.appendChild(this._defs);
            svg.appendChild(this._content);
            svg.appendChild(this._overlay);
            // What #remove() takes out again, and what a later view adopting
            // this same element clears before it renders.
            svg.__paperNodes = [this._defs, this._content, this._overlay];
            this._matrixValue = null;
            // Activate the change tracking in Project#_changed(), which is what
            // lets #update() only touch the items that actually changed.
            if (!project._changes) {
                project._changes = [];
                project._changesById = {};
            }
            View.call(this, project, svg);
            this._needsUpdate = true;
            // The scene graph predates this view if the renderer was switched
            // on an existing project, so start from a full synchronization.
            this._rebuild = true;
        },

        remove: function remove() {
            var project = this._project,
                svg = this._element,
                // The element this view replaced at setup, if any.
                replaced = svg && svg.__paperReplaced,
                measureContext = this._measureContext;
            if (project) {
                project._changes = project._changesById = null;
            }
            this._nodes = {};
            this._symbols = {};
            if (measureContext) {
                CanvasProvider.release(measureContext);
                this._measureContext = null;
            }
            var removed = remove.base.call(this);
            // An element this view adopted rather than replaced is the
            // caller's, and it stays in the document - so the nodes this view
            // put in it have to come out, or they would still be on screen
            // with no view left to update them.
            if (removed && svg && !replaced)
                clearNodes(svg);
            // Put the caller's element back where it was, so the page is left
            // as it was found and a later setup() on that element works.
            if (removed && replaced) {
                svg.__paperReplaced = replaced.__paperSvg = null;
                if (svg.parentNode)
                    svg.parentNode.replaceChild(replaced, svg);
            }
            return removed;
        },

        _setElementSize: function(width, height) {
            var element = this._element;
            if (element) {
                // Mirror the semantics of a <canvas>, where the width / height
                // attributes define the coordinate space and CSS is free to
                // scale it in either direction independently.
                SvgElement.set(element, {
                    width: width,
                    height: height,
                    viewBox: '0 0 ' + num(width) + ' ' + num(height),
                    preserveAspectRatio: 'none'
                });
            }
        },

        /**
         * The `<svg>` element that this view renders into.
         *
         * @bean
         * @type SVGElement
         */
        getElement: function() {
            return this._element;
        },

        _getMeasureContext: function() {
            // Text measuring is the one thing SVG cannot do without laying out
            // the text first, so a 1x1 canvas context is kept around for it.
            return this._measureContext
                || (this._measureContext = CanvasProvider.getContext(1, 1));
        },

        getPixelSize: function getPixelSize(size) {
            var agent = paper.agent,
                element = this._element,
                pixels;
            // Firefox doesn't convert context.font sizes to pixels, so fall
            // back to View#getPixelSize(), which needs an inserted element.
            if (agent && agent.firefox && element && element.parentNode) {
                pixels = getPixelSize.base.call(this, size);
            } else {
                var ctx = this._getMeasureContext(),
                    prevFont = ctx.font;
                ctx.font = size + ' serif';
                pixels = parseFloat(ctx.font);
                ctx.font = prevFont;
            }
            return pixels || parseFloat(size);
        },

        getTextWidth: function(font, lines) {
            var ctx = this._getMeasureContext(),
                prevFont = ctx.font,
                width = 0;
            ctx.font = font;
            for (var i = 0, l = lines.length; i < l; i++)
                width = Math.max(width, ctx.measureText(lines[i]).width);
            ctx.font = prevFont;
            return width;
        },

        /**
         * Brings the SVG tree in sync with the project, if there are changes.
         * Note that when using built-in event handlers for interaction,
         * animation and load events, this method is invoked for you
         * automatically at the end.
         *
         * @return {Boolean} {@true if the view was updated}
         */
        update: function() {
            if (!this._needsUpdate)
                return false;
            var project = this._project;
            if (project) {
                // Panning and zooming end here for the whole scene: one
                // attribute, regardless of the number of items.
                var values = this._matrix.getValues(),
                    value = 'matrix(' + num(values[0])
                        + ',' + num(values[1])
                        + ',' + num(values[2])
                        + ',' + num(values[3])
                        + ',' + num(values[4])
                        + ',' + num(values[5]) + ')';
                if (value !== this._matrixValue) {
                    this._content.setAttribute('transform',
                            this._matrixValue = value);
                }
                var changes = project._changes;
                if (this._rebuild || !changes) {
                    this._rebuild = false;
                    this._syncChildren(project, this._content, true);
                } else if (changes.length) {
                    this._processChanges(changes);
                }
                if (changes && changes.length) {
                    changes.length = 0;
                    project._changesById = {};
                }
                this._updateSelection();
            }
            this._needsUpdate = false;
            return true;
        },

        /**
         * Applies a batch of changes collected by Project#_changed() to the
         * SVG tree. Items that did not change are not visited at all.
         */
        _processChanges: function(changes) {
            var nodes = this._nodes,
                project = this._project,
                // Owners whose child list needs to be brought back in sync,
                // collected first so each is only handled once.
                owners = [],
                ownerIds = {};

            function addOwner(owner) {
                // Only the project and groups own child nodes, see below.
                if (owner !== project && !(owner instanceof Group))
                    return;
                var id = owner._id;
                if (!ownerIds[id]) {
                    ownerIds[id] = true;
                    owners.push(owner);
                }
            }

            for (var i = 0, l = changes.length; i < l; i++) {
                var entry = changes[i],
                    item = entry.item,
                    flags = entry.flags;
                if (!item)
                    continue;
                // A CompoundPath's children have no nodes of their own — its
                // own <path> covers them — and Item#_changed() reports only the
                // item it happened to, never its parent, so a change made
                // through a child would be dropped below for want of a node.
                // Whatever happens to one is a change of the compound path's
                // geometry, insertion included.
                var owner = item._parent;
                if (owner && owner._class === 'CompoundPath') {
                    item = owner;
                    flags = /*#=*/ChangeFlag.GEOMETRY;
                }
                if (flags & /*#=*/ChangeFlag.INSERTION) {
                    var owner = item._getOwner();
                    if (owner) {
                        addOwner(owner);
                    } else {
                        this._removeItem(item);
                    }
                    // The owner's synchronization creates or updates the node.
                    continue;
                }
                var node = nodes[item._id];
                if (!node)
                    continue;
                // A change in clipping is handled by the child synchronization
                // too, as that is where clip items are moved in and out of
                // their clipPath definition. Only groups own child nodes: a
                // CompoundPath renders as a single <path>, and syncing its
                // children would nest a <path> per sub-path inside it. Its own
                // path data covers them, and the geometry flags that come with
                // a CHILDREN change rewrite that below.
                if (flags & childrenFlags)
                    addOwner(item);
                this._updateItem(item, node, flags);
            }

            for (var i = 0, l = owners.length; i < l; i++) {
                var owner = owners[i],
                    node = owner === project ? this._content
                        : nodes[owner._id];
                // A group that was itself removed in the same batch has no
                // node left to synchronize.
                if (node)
                    this._syncChildren(owner, node, false);
            }
        },

        /**
         * Creates the node for an item, including the nodes of its children.
         */
        _createItem: function(item) {
            var node = createNode(item);
            if (!node)
                return null;
            node.__paperId = item._id;
            this._nodes[item._id] = node;
            updateMatrix(item, node);
            this._updateGeometry(item, node, geometryFlags);
            this._updateStyle(item, node);
            if (item instanceof Group)
                this._syncChildren(item, node, true);
            return node;
        },

        _updateItem: function(item, node, flags) {
            if (flags & /*#=*/ChangeFlag.MATRIX) {
                updateMatrix(item, node);
                // Gradients are defined in the item's parent coordinate
                // system, so moving the item redefines them.
                if (node.__fillDef || node.__strokeDef)
                    flags |= styleFlags;
            }
            if (flags & geometryFlags)
                this._updateGeometry(item, node, flags);
            // Style reports the text properties — font, size, leading,
            // justification — as Change.GEOMETRY rather than Change.STYLE,
            // since they change the text's bounds. #_updateStyle() is what
            // writes them out, so text has to reach it on those flags too, or
            // every text style stays frozen at the value it was created with.
            if (flags & (item._class === 'PointText'
                    ? styleFlags | geometryFlags : styleFlags))
                this._updateStyle(item, node);
        },

        _updateGeometry: function(item, node, flags) {
            var cls = item._class;
            if (cls === 'Path' || cls === 'CompoundPath') {
                // CompoundPath produces the path data of all its children, so
                // its children never get nodes of their own.
                setAttr(node, 'd', item.getPathData(null, formatter.precision));
            } else if (cls === 'Shape') {
                var type = item._type,
                    radius = item._radius,
                    size = item._size,
                    width = size.width,
                    height = size.height;
                // Shapes are centered on their own origin, which the item's
                // matrix then places, so the geometry is always written out
                // around (0, 0).
                if (type === 'rectangle') {
                    setAttr(node, 'x', num(-width / 2));
                    setAttr(node, 'y', num(-height / 2));
                    setAttr(node, 'width', num(width));
                    setAttr(node, 'height', num(height));
                    setAttr(node, 'rx',
                            radius.width ? num(radius.width) : null);
                    setAttr(node, 'ry',
                            radius.height ? num(radius.height) : null);
                } else if (type === 'circle') {
                    setAttr(node, 'r', num(radius));
                } else { // ellipse
                    setAttr(node, 'rx', num(radius.width));
                    setAttr(node, 'ry', num(radius.height));
                }
            } else if (cls === 'Raster') {
                var size = item.getSize(),
                    smoothing = item.getSmoothing();
                setAttr(node, 'x', num(-size.width / 2));
                setAttr(node, 'y', num(-size.height / 2));
                setAttr(node, 'width', num(size.width));
                setAttr(node, 'height', num(size.height));
                // Match the way CanvasView stretches rasters into their size.
                setAttr(node, 'preserveAspectRatio', 'none');
                setAttr(node, 'image-rendering',
                        smoothing === 'off' ? 'pixelated' : null);
                // Serializing the pixels is expensive - for a raster backed by
                // a canvas it means encoding a PNG - so only do it when they
                // can actually have changed. A move carries GEOMETRY too, and
                // must not cost a re-encode per frame.
                if (!node.__src || flags & pixelFlags) {
                    var image = item.getImage(),
                        // Prefer the image's own source over serializing.
                        src = image && image.src && !/^data:/.test(image.src)
                            ? image.src
                            : item.toDataURL();
                    if (node.__src !== src) {
                        node.__src = src;
                        SvgElement.set(node, { href: src });
                    }
                }
            } else if (cls === 'PointText') {
                this._updateText(item, node);
            } else if (cls === 'SymbolItem') {
                this._updateSymbol(item, node);
            }
        },

        _updateText: function(item, node) {
            var lines = item._lines || [],
                leading = item.getLeading(),
                children = node.childNodes;
            // Each line becomes a tspan placed at the same leading offsets that
            // PointText#_draw() uses on canvas.
            while (children.length > lines.length)
                node.removeChild(node.lastChild);
            for (var i = 0, l = lines.length; i < l; i++) {
                var tspan = children[i];
                if (!tspan) {
                    tspan = SvgElement.create('tspan');
                    node.appendChild(tspan);
                }
                setAttr(tspan, 'x', '0');
                setAttr(tspan, 'y', num(i * leading));
                // Keep leading and trailing spaces of a line, which SVG would
                // collapse away otherwise.
                tspan.setAttributeNS('http://www.w3.org/XML/1998/namespace',
                        'xml:space', 'preserve');
                var line = lines[i];
                if (tspan.textContent !== line)
                    tspan.textContent = line;
            }
        },

        _updateSymbol: function(item, node) {
            var definition = item._definition,
                symbols = this._symbols,
                id = this._id + '-symbol-' + definition._id;
            if (!symbols[id]) {
                var def = symbols[id] = SvgElement.create('g', { id: id }),
                    definitionNode = this._createItem(definition._item);
                if (definitionNode)
                    def.appendChild(definitionNode);
                this._defs.appendChild(def);
            }
            if (node.__href !== id) {
                node.__href = id;
                SvgElement.set(node, { href: '#' + id });
            }
        },

        /**
         * Writes the item's style to its node. Only the attributes that the
         * item actually defines are set, so that the produced markup stays
         * close to what Item#exportSVG() would produce.
         */
        _updateStyle: function(item, node) {
            var opacity = item._opacity,
                blend = blendModes[item._blendMode];
            setAttr(node, 'opacity', opacity < 1 ? num(opacity) : null);
            setAttr(node, 'style', blend ? 'mix-blend-mode:' + blend : null);
            setAttr(node, 'visibility', item._visible ? null : 'hidden');
            if (item instanceof Group || item._class === 'SymbolItem') {
                // Style getters on items with children merge the children's
                // values, which would mean walking the whole subtree here.
                // Groups only carry the attributes handled above anyway, and a
                // symbol placement carries none of its own: writing them would
                // override the definition's.
                return;
            }
            var style = item._style,
                fillColor = style.getFillColor(),
                strokeColor = style.getStrokeColor(),
                dashArray = style.getDashArray(),
                strokeWidth = style.getStrokeWidth(),
                strokeCap = style.getStrokeCap(),
                strokeJoin = style.getStrokeJoin(),
                miterLimit = style.getMiterLimit(),
                dashOffset = style.getDashOffset(),
                fillRule = style.getFillRule();
            this._setPaint(item, node, 'fill', fillColor);
            this._setPaint(item, node, 'stroke', strokeColor);
            var rule = fillRule && fillRule !== 'nonzero' ? fillRule : null;
            setAttr(node, 'fill-rule', rule);
            // Inside a <clipPath>, SVG resolves the winding with clip-rule;
            // fill-rule has no effect there, so a clip item that asks for
            // even-odd - a compound path with a hole, the usual way to punch
            // one - would clip as non-zero and lose the hole. The canvas
            // renderer passes the same value to ctx.clip(), see Item#draw().
            // Written here rather than where the clip is set up, so that it
            // stays current when the rule changes later: that is a style
            // change, and style changes do not reach #_setClip(). It is inert
            // on a node that is not inside a <clipPath>.
            setAttr(node, 'clip-rule', rule);
            // Written even without a stroke, so that clearing the stroke color
            // does not leave a stale width or dash pattern behind.
            setAttr(node, 'stroke-width',
                    strokeColor && strokeWidth !== 1 ? num(strokeWidth) : null);
            setAttr(node, 'stroke-linecap',
                    strokeColor && strokeCap && strokeCap !== 'butt'
                        ? strokeCap : null);
            setAttr(node, 'stroke-linejoin',
                    strokeColor && strokeJoin && strokeJoin !== 'miter'
                        ? strokeJoin : null);
            setAttr(node, 'stroke-miterlimit',
                    strokeColor && miterLimit !== 10 ? num(miterLimit) : null);
            setAttr(node, 'stroke-dasharray',
                    strokeColor && dashArray && dashArray.length
                        ? dashArray.join(',') : null);
            setAttr(node, 'stroke-dashoffset',
                    strokeColor && dashOffset ? num(dashOffset) : null);
            // Non-scaling strokes keep their width no matter the view's zoom,
            // which is exactly what vector-effect describes.
            setAttr(node, 'vector-effect',
                    strokeColor && !style.getStrokeScaling()
                        ? 'non-scaling-stroke' : null);
            this._updateShadow(item, node, style);
            if (item._class === 'PointText') {
                var justification = style.getJustification(),
                    weight = style.getFontWeight(),
                    // Paper carries the whole CSS font-weight / font-style
                    // fragment in fontWeight, e.g. 'italic bold'.
                    italic = /\b(italic|oblique)\b/i.exec(String(weight || ''));
                setAttr(node, 'font-family', style.getFontFamily());
                setAttr(node, 'font-style', italic ? italic[0] : null);
                setAttr(node, 'font-weight', italic
                        ? String(weight).replace(italic[0], '').trim() || null
                        : weight);
                setAttr(node, 'font-size', num(style.getFontSize()));
                setAttr(node, 'text-anchor', justification === 'center'
                        ? 'middle'
                        : justification === 'right' ? 'end' : null);
            }
        },

        /**
         * Canvas draws shadows as part of the paint; SVG needs a filter, so one
         * is kept per item that defines a shadow and removed again when it
         * stops. The blur radii match: canvas's shadowBlur is twice the
         * standard deviation of the gaussian feDropShadow applies.
         */
        _updateShadow: function(item, node, style) {
            var color = style.getShadowColor(),
                blur = style.getShadowBlur(),
                offset = style.getShadowOffset(),
                def = node.__shadowDef;
            if (!color || color.getAlpha() === 0) {
                if (def) {
                    if (def.parentNode === this._defs)
                        this._defs.removeChild(def);
                    node.__shadowDef = null;
                    setAttr(node, 'filter', null);
                }
                return;
            }
            var id = this._id + '-shadow-' + item._id;
            if (!def) {
                def = node.__shadowDef = SvgElement.create('filter', {
                    id: id,
                    // Room for the blur to spread past the item's own box.
                    x: '-50%', y: '-50%', width: '200%', height: '200%'
                });
                def.appendChild(SvgElement.create('feDropShadow'));
                this._defs.appendChild(def);
                setAttr(node, 'filter', 'url(#' + id + ')');
            }
            SvgElement.set(def.firstChild, {
                dx: offset ? offset.x : 0,
                dy: offset ? offset.y : 0,
                stdDeviation: (blur || 0) / 2,
                'flood-color': color.toCSS(true),
                'flood-opacity': color.getAlpha()
            }, formatter);
        },

        _setPaint: function(item, node, key, color) {
            var paint = 'none',
                alpha = 1;
            if (color) {
                if (color._type === 'gradient') {
                    paint = 'url(#' + this._updateGradient(item, node, key,
                            color) + ')';
                    alpha = color.getAlpha();
                } else {
                    // SVG 1.1 has no rgba() support, so the alpha channel goes
                    // into the separate fill- / stroke-opacity attribute.
                    paint = color.toCSS(true);
                    alpha = color.getAlpha();
                }
            } else if (key === 'stroke') {
                // Not painting a stroke is the SVG default, so leave it out.
                paint = null;
            }
            setAttr(node, key, paint);
            setAttr(node, key + '-opacity', alpha < 1 ? num(alpha) : null);
        },

        /**
         * Creates or refreshes the gradient definition used by one paint role
         * of one item. There is one definition per item and role, which is
         * updated in place, so that changing a gradient does not leak nodes
         * into the defs element.
         */
        _updateGradient: function(item, node, key, color) {
            var gradient = color.getGradient(),
                radial = gradient._radial,
                origin = color.getOrigin(),
                destination = color.getDestination(),
                highlight = color.getHighlight(),
                matrix = item._matrix,
                // Gradient points are defined in the item's parent coordinate
                // system, while the definition is used in the coordinate
                // system of the node, which the item's matrix transforms. So
                // the points need to be inverse transformed, the same way
                // Color#toCanvasStyle() does it for CanvasView.
                inverse = !matrix.isIdentity() && matrix.isInvertible()
                    && matrix.inverted(),
                id = this._id + '-' + key + '-' + item._id,
                cache = key === 'fill' ? '__fillDef' : '__strokeDef',
                def = node[cache],
                tag = (radial ? 'radial' : 'linear') + 'Gradient';
            if (def && def.nodeName.toLowerCase() !== tag.toLowerCase()) {
                this._defs.removeChild(def);
                def = null;
            }
            if (!def) {
                def = node[cache] = SvgElement.create(tag, { id: id });
                this._defs.appendChild(def);
            }
            if (inverse) {
                origin = inverse._transformPoint(origin);
                destination = inverse._transformPoint(destination);
                if (highlight)
                    highlight = inverse._transformPoint(highlight);
            }
            var attrs = { gradientUnits: 'userSpaceOnUse' };
            if (radial) {
                var radius = destination.getDistance(origin);
                attrs.cx = origin.x;
                attrs.cy = origin.y;
                attrs.r = radius;
                if (highlight) {
                    // Keep the focal point inside the circle, as
                    // Color#toCanvasStyle() does.
                    var vector = highlight.subtract(origin);
                    if (vector.getLength() > radius)
                        highlight = origin.add(vector.normalize(radius - 0.1));
                    attrs.fx = highlight.x;
                    attrs.fy = highlight.y;
                }
            } else {
                attrs.x1 = origin.x;
                attrs.y1 = origin.y;
                attrs.x2 = destination.x;
                attrs.y2 = destination.y;
            }
            SvgElement.set(def, attrs, formatter);
            while (def.firstChild)
                def.removeChild(def.firstChild);
            var stops = gradient._stops;
            for (var i = 0, l = stops.length; i < l; i++) {
                var stop = stops[i],
                    stopColor = stop._color,
                    stopAlpha = stopColor.getAlpha(),
                    offset = stop._offset,
                    stopAttrs = {
                        offset: offset == null ? i / (l - 1) : offset
                    };
                stopAttrs['stop-color'] = stopColor.toCSS(true);
                if (stopAlpha < 1)
                    stopAttrs['stop-opacity'] = stopAlpha;
                def.appendChild(SvgElement.create('stop', stopAttrs,
                        formatter));
            }
            return id;
        },

        /**
         * Brings the DOM children of `node` in sync with the children of the
         * item or project `owner`, creating, moving and removing nodes as
         * needed. With `deep` set, the items that already have nodes are
         * updated and descended into as well, which is the path taken for the
         * initial rendering of a scene.
         */
        _syncChildren: function(owner, node, deep) {
            var children = owner._children,
                nodes = this._nodes,
                childNodes = node.childNodes,
                // The position that the next child is expected at. Nodes that
                // turn up elsewhere are moved here, which handles reordering
                // as well as items that moved in from another parent.
                index = 0,
                clipItem = null;
            for (var i = 0, l = children.length; i < l; i++) {
                var child = children[i],
                    childNode = nodes[child._id];
                if (!childNode) {
                    childNode = this._createItem(child);
                    if (!childNode)
                        continue;
                } else if (deep) {
                    updateMatrix(child, childNode);
                    this._updateGeometry(child, childNode);
                    this._updateStyle(child, childNode);
                    if (child instanceof Group)
                        this._syncChildren(child, childNode, true);
                }
                if (child._clipMask) {
                    // Clipping children live inside a clipPath in the defs,
                    // not among their siblings, but are otherwise kept up to
                    // date like any other item.
                    clipItem = child;
                    continue;
                }
                // Read the current node at this position on each iteration:
                // creating a child's node can have moved nodes around, e.g.
                // when an item is moved into a newly created group.
                var current = childNodes[index];
                if (current !== childNode)
                    node.insertBefore(childNode, current || null);
                index++;
            }
            // Anything left after the last child is no longer part of the
            // scene graph.
            while (childNodes.length > index)
                this._disposeNode(childNodes[index]);
            this._setClip(owner, node, clipItem);
        },

        _setClip: function(owner, node, clipItem) {
            var def = node.__clipDef;
            if (!clipItem) {
                if (def) {
                    this._defs.removeChild(def);
                    node.__clipDef = null;
                    setAttr(node, 'clip-path', null);
                }
                return;
            }
            var id = this._id + '-clip-' + owner._id;
            if (!def) {
                def = node.__clipDef = SvgElement.create('clipPath',
                        { id: id });
                this._defs.appendChild(def);
                setAttr(node, 'clip-path', 'url(#' + id + ')');
            }
            var clipNode = this._nodes[clipItem._id];
            if (clipNode && clipNode.parentNode !== def) {
                while (def.firstChild)
                    def.removeChild(def.firstChild);
                def.appendChild(clipNode);
            }
        },

        _removeItem: function(item) {
            var node = this._nodes[item._id];
            if (node)
                this._disposeNode(node);
        },

        /**
         * Removes a node from the tree and forgets about it and everything
         * below it, so that items which were removed from the project do not
         * keep their nodes alive.
         */
        _disposeNode: function(node) {
            var nodes = this._nodes,
                defs = this._defs,
                stack = [node];
            while (stack.length) {
                var current = stack.pop(),
                    children = current.childNodes;
                if (current.__paperId != null)
                    delete nodes[current.__paperId];
                for (var i = 0, l = children.length; i < l; i++)
                    stack.push(children[i]);
                var refs = ['__fillDef', '__strokeDef', '__clipDef',
                        '__shadowDef'];
                for (var i = 0; i < refs.length; i++) {
                    var def = current[refs[i]];
                    if (def) {
                        if (def.parentNode === defs)
                            defs.removeChild(def);
                        current[refs[i]] = null;
                    }
                }
            }
            if (node.parentNode)
                node.parentNode.removeChild(node);
        },

        /**
         * Draws the selection handles of all selected items into the overlay
         * group, in view coordinates. The drawing itself is delegated to the
         * same Item#_drawSelection() implementation that CanvasView uses,
         * through a recorder that turns its context calls into path data.
         */
        _updateSelection: function() {
            var project = this._project,
                overlay = this._overlay,
                count = project._selectionCount;
            if (!count) {
                if (overlay.firstChild) {
                    while (overlay.firstChild)
                        overlay.removeChild(overlay.firstChild);
                }
                return;
            }
            // Item#_drawSelection() only draws items that were part of the
            // last draw-loop. In SVG the whole scene graph is rendered, so
            // marking the visible layers is enough: Item#_isUpdated() walks up
            // to them through the parents of each selected item.
            var version = ++project._updateVersion,
                layers = project._children;
            for (var i = 0, l = layers.length; i < l; i++) {
                if (layers[i]._visible)
                    layers[i]._updateVersion = version;
            }
            var items = project._selectionItems,
                size = this._scope.settings.handleSize,
                matrix = this._matrix,
                recorder = new Recorder(this._getMeasureContext());
            for (var id in items) {
                items[id]._drawSelection(recorder, matrix, size, items,
                        version);
            }
            var parts = recorder.parts,
                children = overlay.childNodes;
            while (children.length > parts.length)
                overlay.removeChild(overlay.lastChild);
            for (var i = 0, l = parts.length; i < l; i++) {
                var part = parts[i],
                    path = children[i];
                if (!path) {
                    path = SvgElement.create('path');
                    overlay.appendChild(path);
                }
                setAttr(path, 'd', part.d);
                setAttr(path, 'fill', part.fill || 'none');
                setAttr(path, 'stroke', part.stroke || 'none');
                setAttr(path, 'stroke-width',
                        part.stroke && part.width != null && part.width !== 1
                            ? num(part.width) : null);
            }
        }
    };
});
