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
 * These tests cover the SVG renderer, which mirrors the scene graph into a
 * native SVG DOM tree instead of rasterizing it into a canvas. They are
 * browser-only, since they inspect the rendered DOM.
 */
QUnit.module('SvgView');

function createSvgScope(size) {
    var scope = new paper.PaperScope();
    scope.settings.renderer = 'svg';
    scope.setup(size || new paper.Size(200, 200));
    return scope;
}

// Returns the item nodes inside the view's content group, ignoring the defs
// and the selection overlay.
function getItemNodes(scope, selector) {
    var content = scope.view.element.childNodes[1];
    return content.querySelectorAll(
            selector || 'path,rect,circle,ellipse,text,image,use');
}

test('View.create() selects the renderer', function() {
    var defaultScope = new paper.PaperScope();
    defaultScope.setup(new paper.Size(100, 100));
    equals(defaultScope.view._class, 'SvgView',
            'The SVG renderer is the default');
    equals(defaultScope.view.element.nodeName.toLowerCase(), 'svg',
            'The view renders into an svg element');

    var canvasScope = new paper.PaperScope();
    canvasScope.settings.renderer = 'canvas';
    canvasScope.setup(new paper.Size(100, 100));
    equals(canvasScope.view._class, 'CanvasView',
            'paper.settings.renderer opts back into the canvas renderer');

    var element = document.createElement('canvas');
    element.setAttribute('data-paper-renderer', 'canvas');
    var attributeScope = new paper.PaperScope();
    attributeScope.setup(element);
    equals(attributeScope.view._class, 'CanvasView',
            'A data-paper-renderer attribute opts one view out');
    equals(attributeScope.view.element, element,
            'That view keeps the canvas element it was given');
});

test('The view takes over the element it replaces', function() {
    var element = document.createElement('canvas');
    element.id = 'svg-view-test';
    element.className = 'stage';
    element.setAttribute('width', '120');
    element.setAttribute('height', '90');
    document.body.appendChild(element);
    var scope = new paper.PaperScope();
    scope.settings.renderer = 'svg';
    scope.setup(element);
    var svg = scope.view.element;
    equals(svg.nodeName.toLowerCase(), 'svg', 'The canvas was replaced');
    equals(svg.id, 'svg-view-test', 'The id is carried over');
    equals(svg.getAttribute('class'), 'stage', 'The classes are carried over');
    equals(document.body.contains(svg), true, 'The svg is in the document');
    equals(document.body.contains(element), false,
            'The canvas is no longer in the document');
    equals(scope.view.viewSize.toString(), new paper.Size(120, 90).toString(),
            'The size is carried over');
    svg.parentNode.removeChild(svg);
});

test('Setting up twice on the same element', function() {
    var element = document.createElement('canvas');
    element.setAttribute('width', '80');
    element.setAttribute('height', '60');
    var host = document.createElement('div');
    host.appendChild(element);
    document.body.appendChild(host);

    var scope = new paper.PaperScope();
    scope.settings.renderer = 'svg';
    scope.setup(element);
    var first = scope.view.element;
    equals(first.parentNode, host, 'The svg replaced the canvas in the DOM');
    equals(host.contains(element), false, 'The canvas was taken out');

    // What deserializing an artboard does: drop the project, set up again on
    // the same element reference the caller still holds.
    scope.project.remove();
    equals(host.contains(element), true,
            'Removing the project puts the original element back');
    equals(host.contains(first), false, 'And takes the svg out again');

    scope.setup(element);
    var second = scope.view.element;
    equals(second.parentNode, host, 'The second setup renders into the DOM');
    new scope.Path.Circle({ center: [20, 20], radius: 10, fillColor: 'red' });
    scope.view.update();
    equals(second.querySelectorAll('path').length, 1,
            'And its items are rendered');

    // Setting up again without removing the project first: the element is
    // detached, so the svg standing in for it is reused rather than orphaned.
    scope.setup(element);
    equals(scope.view.element, second, 'A repeat setup reuses the same svg');
    equals(scope.view.element.parentNode, host, 'Which is still in the DOM');
    equals(second.querySelectorAll('path').length, 0,
            'And starts from an empty tree');
    scope.project.remove();
    host.parentNode.removeChild(host);
});

test('Setting up twice on an <svg> the caller owns', function() {
    // An <svg> is adopted in place rather than replaced, so the nodes of a
    // previous view are still in it when the next one starts - they have to
    // go, or both scenes are drawn at once.
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '80');
    svg.setAttribute('height', '60');
    document.body.appendChild(svg);

    var scope = new paper.PaperScope();
    scope.setup(svg);
    equals(scope.view.element, svg, 'The <svg> is adopted, not replaced');
    new scope.Path.Circle({ center: [20, 20], radius: 10, fillColor: 'red' });
    scope.view.update();
    equals(svg.childNodes.length, 3, 'defs, content and overlay');
    equals(svg.querySelectorAll('path').length, 1, 'The item is rendered');

    // What deserializing an artboard over a live view does, an undo for
    // instance: drop the project and set the same element up again.
    scope.project.remove();
    equals(svg.childNodes.length, 0,
            'Removing the project takes this view\'s nodes back out');

    scope.setup(svg);
    new scope.Path.Circle({ center: [20, 20], radius: 10, fillColor: 'red' });
    scope.view.update();
    equals(svg.childNodes.length, 3, 'The second view renders one scene');
    equals(svg.querySelectorAll('path').length, 1, 'With one copy of the item');

    // And again without removing the project first, which is the shape that
    // leaves a view's nodes behind for the next one to find.
    scope.setup(svg);
    new scope.Path.Circle({ center: [40, 30], radius: 5, fillColor: 'blue' });
    scope.view.update();
    equals(svg.childNodes.length, 3, 'A repeat setup starts from a clean tree');
    equals(svg.querySelectorAll('path').length, 1, 'And draws only its own item');

    scope.project.remove();
    svg.parentNode.removeChild(svg);
});

test('Items are rendered as nodes', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Rectangle({
        point: [10, 10],
        size: [50, 30],
        fillColor: 'red',
        strokeColor: 'black',
        strokeWidth: 2
    });
    scope.view.update();
    var nodes = getItemNodes(scope);
    equals(nodes.length, 1, 'One node was created');
    var node = nodes[0];
    equals(node.nodeName.toLowerCase(), 'path', 'A path node is used');
    equals(node.getAttribute('d'), path.getPathData(null, 5),
            'The path data matches the item');
    equals(node.getAttribute('fill'), '#ff0000', 'The fill is set');
    equals(node.getAttribute('stroke'), '#000000', 'The stroke is set');
    equals(node.getAttribute('stroke-width'), '2', 'The stroke width is set');
});

test('Shapes are rendered as their SVG equivalents', function() {
    var scope = createSvgScope();
    new scope.Shape.Circle({ center: [50, 50], radius: 20, fillColor: 'red' });
    new scope.Shape.Rectangle({
        point: [10, 10], size: [40, 20], radius: 5, fillColor: 'blue'
    });
    scope.view.update();
    var circle = getItemNodes(scope, 'circle')[0],
        rect = getItemNodes(scope, 'rect')[0];
    equals(circle.getAttribute('r'), '20', 'The circle radius is set');
    equals(circle.getAttribute('transform'), 'matrix(1,0,0,1,50,50)',
            'The circle is placed by its matrix');
    equals(rect.getAttribute('width'), '40', 'The rectangle width is set');
    equals(rect.getAttribute('rx'), '5', 'The corner radius is set');
});

test('Changes are mirrored into the nodes', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Circle({
        center: [50, 50], radius: 20, fillColor: 'red'
    });
    scope.view.update();
    var node = getItemNodes(scope)[0];
    path.fillColor = 'blue';
    scope.view.update();
    equals(node.getAttribute('fill'), '#0000ff', 'The fill was updated');
    equals(getItemNodes(scope).length, 1, 'No node was added');
    path.opacity = 0.5;
    scope.view.update();
    equals(node.getAttribute('opacity'), '0.5', 'The opacity was updated');
    path.visible = false;
    scope.view.update();
    equals(node.getAttribute('visibility'), 'hidden', 'The item was hidden');
    var data = node.getAttribute('d');
    path.position = path.position.add([10, 0]);
    scope.view.update();
    equals(node.getAttribute('d') !== data, true, 'The geometry was updated');
    equals(node.parentNode != null, true, 'The same node is still in use');
});

test('Inserting, removing and reordering items', function() {
    var scope = createSvgScope();
    var a = new scope.Path.Circle({ center: [20, 20], radius: 5,
            fillColor: 'red' }),
        b = new scope.Path.Circle({ center: [40, 40], radius: 5,
            fillColor: 'blue' });
    scope.view.update();
    var nodes = getItemNodes(scope);
    equals(nodes.length, 2, 'Both items were rendered');
    equals(nodes[0].getAttribute('fill'), '#ff0000',
            'The items are in insertion order');
    b.sendToBack();
    scope.view.update();
    equals(getItemNodes(scope)[0].getAttribute('fill'), '#0000ff',
            'The nodes follow the item order');
    a.remove();
    scope.view.update();
    equals(getItemNodes(scope).length, 1, 'The removed item is gone');
    var group = new scope.Group([b]);
    scope.view.update();
    equals(getItemNodes(scope).length, 1,
            'Moving an item into a group keeps one node');
    equals(getItemNodes(scope)[0].parentNode.nodeName.toLowerCase(), 'g',
            'The node moved into the group node');
    group.remove();
    scope.view.update();
    equals(getItemNodes(scope).length, 0, 'The group was removed');
});

test('Panning and zooming only change the root transform', function() {
    var scope = createSvgScope();
    for (var i = 0; i < 20; i++) {
        new scope.Path.Circle({ center: [i * 5, 20], radius: 4,
                fillColor: 'red' });
    }
    scope.view.update();
    var content = scope.view.element.childNodes[1],
        data = getItemNodes(scope)[0].getAttribute('d');
    scope.view.zoom = 2;
    scope.view.center = [40, 40];
    scope.view.update();
    equals(content.getAttribute('transform'),
            'matrix(' + scope.view.matrix.values.join(',') + ')',
            'The view matrix is applied to the content group');
    equals(getItemNodes(scope)[0].getAttribute('d'), data,
            'The item nodes are left untouched');
});

test('Groups, clipping and compound paths', function() {
    var scope = createSvgScope();
    var group = new scope.Group([
        new scope.Path.Circle({ center: [50, 50], radius: 20 }),
        new scope.Path.Rectangle({ point: [30, 30], size: [40, 40],
            fillColor: 'red' })
    ]);
    group.clipped = true;
    var compound = new scope.CompoundPath({
        children: [
            new scope.Path.Circle({ center: [50, 50], radius: 20 }),
            new scope.Path.Circle({ center: [50, 50], radius: 10 })
        ],
        fillColor: 'blue'
    });
    scope.view.update();
    var svg = scope.view.element,
        // The content group holds the layer node, which holds the group.
        groupNode = svg.childNodes[1].childNodes[0].childNodes[0],
        clipPath = svg.querySelector('clipPath');
    equals(clipPath != null, true, 'A clipPath was created');
    equals(clipPath.childNodes.length, 1, 'The clip item is inside it');
    equals(groupNode.getAttribute('clip-path'),
            'url(#' + clipPath.id + ')', 'The group references the clipPath');
    equals(groupNode.childNodes.length, 1,
            'The clip item is not a child of the group node');
    equals(getItemNodes(scope, 'path').length, 2,
            'The compound path is rendered as a single node');
    equals(getItemNodes(scope, 'path')[1].getAttribute('d'),
            compound.getPathData(null, 5),
            'The compound path data matches the item');
    group.clipped = false;
    scope.view.update();
    equals(groupNode.getAttribute('clip-path'), null,
            'The clip-path reference is removed again');
    equals(svg.querySelectorAll('clipPath').length, 0,
            'The clipPath definition is removed again');
    equals(groupNode.childNodes.length, 2,
            'The clip item became a regular child again');
});

test('A CompoundPath stays a single node', function() {
    var scope = createSvgScope();
    var compound = new scope.CompoundPath({
        children: [
            new scope.Path.Circle({ center: [50, 50], radius: 20 }),
            new scope.Path.Circle({ center: [50, 50], radius: 10 })
        ],
        fillColor: 'red'
    });
    scope.view.update();
    var node = getItemNodes(scope, 'path')[0];
    equals(node.childNodes.length, 0, 'It has no child nodes');
    // Mutating it after creation is what put nodes inside the <path> before.
    compound.addChild(new scope.Path.Circle({ center: [50, 50], radius: 5 }));
    scope.view.update();
    equals(node.childNodes.length, 0, 'Adding a child adds no node inside it');
    equals(getItemNodes(scope, 'path').length, 1, 'And none beside it');
    equals(node.getAttribute('d'), compound.getPathData(null, 5),
            'The path data covers the new child');
});

test('Rasters only re-encode when their pixels change', function(assert) {
    var done = assert.async();
    var scope = createSvgScope();
    var source = document.createElement('canvas');
    source.width = source.height = 8;
    var context = source.getContext('2d');
    context.fillStyle = 'red';
    context.fillRect(0, 0, 8, 8);
    var raster = new scope.Raster(source);
    raster.position = [50, 50];
    scope.view.update();
    var node = getItemNodes(scope, 'image')[0],
        href = node.getAttribute('href') || node.getAttributeNS(
            'http://www.w3.org/1999/xlink', 'href'),
        encodes = 0,
        toDataURL = raster.toDataURL;
    equals(!!href, true, 'The raster is rendered with a source');
    raster.toDataURL = function() {
        encodes++;
        return toDataURL.apply(this, arguments);
    };
    for (var i = 0; i < 10; i++) {
        raster.position = raster.position.add([1, 1]);
        scope.view.update();
    }
    equals(encodes, 0, 'Moving it does not re-encode the pixels');
    context.fillStyle = 'blue';
    context.fillRect(0, 0, 8, 8);
    raster.setImageData(raster.getImageData());
    scope.view.update();
    equals(encodes > 0, true, 'Changing its pixels does');
    raster.toDataURL = toDataURL;
    done();
});

test('Drop shadows are rendered as a filter', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Circle({
        center: [50, 50],
        radius: 20,
        fillColor: 'red',
        shadowColor: new scope.Color(0, 0, 0, 0.5),
        shadowBlur: 12,
        shadowOffset: [3, 4]
    });
    scope.view.update();
    var svg = scope.view.element,
        node = getItemNodes(scope)[0],
        filter = svg.querySelector('filter'),
        shadow = filter && filter.firstChild;
    equals(filter != null, true, 'A filter definition was created');
    equals(node.getAttribute('filter'), 'url(#' + filter.id + ')',
            'The item references it');
    equals(shadow.nodeName.toLowerCase(), 'fedropshadow',
            'It is an feDropShadow');
    equals(shadow.getAttribute('dx'), '3', 'The offset is carried over');
    equals(shadow.getAttribute('stdDeviation'), '6',
            'The blur radius is half of shadowBlur');
    path.shadowColor = null;
    scope.view.update();
    equals(svg.querySelectorAll('filter').length, 0,
            'Clearing the shadow removes the definition');
    equals(node.getAttribute('filter'), null, 'And the reference');
});

test('Blend modes CSS cannot express fall back to normal', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Circle({
        center: [50, 50], radius: 20, fillColor: 'red', blendMode: 'multiply'
    });
    scope.view.update();
    var node = getItemNodes(scope)[0];
    equals(node.getAttribute('style'), 'mix-blend-mode:multiply',
            'A mode CSS knows is written');
    path.blendMode = 'add';
    scope.view.update();
    equals(node.getAttribute('style'), 'mix-blend-mode:plus-lighter',
            'add maps to the CSS name for the same operation');
    path.blendMode = 'subtract';
    scope.view.update();
    equals(node.getAttribute('style'), null,
            'A mode CSS has no name for writes nothing, rather than a name ' +
            'the browser would drop');
});

test('Stroke attributes do not go stale', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Circle({
        center: [50, 50],
        radius: 20,
        strokeColor: 'black',
        strokeWidth: 5,
        dashArray: [4, 2]
    });
    scope.view.update();
    var node = getItemNodes(scope)[0];
    equals(node.getAttribute('stroke-width'), '5', 'The width is written');
    path.strokeColor = null;
    scope.view.update();
    equals(node.getAttribute('stroke-width'), null,
            'Clearing the stroke clears the width');
    equals(node.getAttribute('stroke-dasharray'), null,
            'And the dash pattern');
});

test('Gradients are rendered through definitions', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Circle({
        center: [50, 50],
        radius: 20,
        fillColor: {
            gradient: { stops: ['yellow', 'red'] },
            origin: [30, 50],
            destination: [70, 50]
        }
    });
    scope.view.update();
    var svg = scope.view.element,
        node = getItemNodes(scope)[0],
        gradient = svg.querySelector('linearGradient');
    equals(gradient != null, true, 'A gradient definition was created');
    equals(node.getAttribute('fill'), 'url(#' + gradient.id + ')',
            'The item references the gradient');
    equals(gradient.childNodes.length, 2, 'Both stops were created');
    equals(gradient.getAttribute('x1'), '30', 'The origin is set');
    path.remove();
    scope.view.update();
    equals(svg.querySelectorAll('linearGradient').length, 0,
            'The definition is removed with the item');
});

test('Text is rendered as tspans', function() {
    var scope = createSvgScope();
    var text = new scope.PointText({
        point: [10, 20],
        content: 'one\ntwo',
        fillColor: 'black',
        fontSize: 20
    });
    scope.view.update();
    var node = getItemNodes(scope, 'text')[0];
    equals(node.getAttribute('font-size'), '20', 'The font size is set');
    equals(node.childNodes.length, 2, 'One tspan per line');
    equals(node.childNodes[0].textContent, 'one', 'The first line is set');
    equals(node.childNodes[1].getAttribute('y'),
            String(text.leading), 'The lines are placed by their leading');
});

test('Selections are drawn into the overlay', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Rectangle({
        point: [10, 10], size: [40, 40], fillColor: 'red'
    });
    scope.view.update();
    var overlay = scope.view.element.childNodes[2];
    equals(overlay.childNodes.length, 0, 'The overlay starts out empty');
    path.selected = true;
    scope.view.update();
    equals(overlay.childNodes.length > 0, true,
            'The selection is drawn into the overlay');
    path.selected = false;
    scope.view.update();
    equals(overlay.childNodes.length, 0, 'The overlay is cleared again');
});
