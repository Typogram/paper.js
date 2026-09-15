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
 *
 * Where the renderer knowingly differs from the canvas one, the divergence is
 * pinned by a test in the 'SvgView divergences' module at the bottom of this
 * file, and written up in test/FINDINGS-svg-renderer.md.
 */
// Every scope createScope() opened during the current test, so that the
// teardown can close them again.
var svgViewScopes = [];

// Item constructors insert into whichever scope is active, and these tests
// open scopes of their own and activate them - so the scope the shared test
// harness set the test up in has to be put back, or every test that runs
// afterwards would build into a scope of ours. currentProject is the project
// helpers.js made for this test, and its scope is the one that was active
// when the test started.
var svgViewTeardown = function() {
    for (var i = 0; i < svgViewScopes.length; i++) {
        var projects = svgViewScopes[i].projects.slice();
        for (var j = 0; j < projects.length; j++)
            projects[j].remove();
    }
    svgViewScopes = [];
    if (currentProject && currentProject._scope)
        currentProject._scope.activate();
};

QUnit.module('SvgView', { teardown: svgViewTeardown });

// A bare scope, tracked so the teardown closes it again. The lifecycle tests
// drive setup() themselves rather than going through createScope().
function newScope() {
    var scope = new paper.PaperScope();
    svgViewScopes.push(scope);
    return scope;
}

// A scope of its own per test, so that the renderer can be chosen per scope
// and the canvas-backed project the shared test harness sets up is left alone.
// Note that item constructors insert into the *active* scope's project, so a
// test that opens more than one scope has to activate the one it is about to
// build into - which is what this returns to, so `createScope()` is safe to
// call repeatedly within a test.
function createScope(renderer, size) {
    var scope = newScope();
    scope.settings.renderer = renderer || 'svg';
    scope.setup(size || new paper.Size(200, 200));
    scope.activate();
    return scope;
}

function createSvgScope(size) {
    return createScope('svg', size);
}

// The three groups a view puts into its <svg>, in the order it appends them.
function defsNode(scope) {
    return scope.view.element.childNodes[0];
}

function contentNode(scope) {
    return scope.view.element.childNodes[1];
}

function overlayNode(scope) {
    return scope.view.element.childNodes[2];
}

// Returns the item nodes inside the view's content group, ignoring the defs
// and the selection overlay.
function getItemNodes(scope, selector) {
    return contentNode(scope).querySelectorAll(
            selector || 'path,rect,circle,ellipse,text,image,use');
}

// All the path data in the selection overlay, as one string: the recorder
// groups its commands by paint, so which part a given handle lands in is an
// implementation detail that a test should not depend on.
function overlayData(scope) {
    var children = overlayNode(scope).childNodes,
        data = '';
    for (var i = 0; i < children.length; i++)
        data += children[i].getAttribute('d') || '';
    return data;
}

// The node the view is holding for an item, which is what tells node reuse
// apart from a node that was thrown away and built again.
function nodeFor(scope, item) {
    return scope.view._nodes[item._id];
}

function nodeCount(scope) {
    var count = 0;
    for (var id in scope.view._nodes)
        count++;
    return count;
}

// Counts the setAttribute() calls a block of code makes on a node, which is
// how the renderer's promise - only what changed is touched - is checked.
function countWrites(node, fn) {
    var writes = 0,
        setAttribute = node.setAttribute;
    node.setAttribute = function() {
        writes++;
        return setAttribute.apply(this, arguments);
    };
    try {
        fn();
    } finally {
        node.setAttribute = setAttribute;
    }
    return writes;
}

// ---------------------------------------------------------------------------
// Renderer selection and element lifecycle
// ---------------------------------------------------------------------------

test('View.create() selects the renderer', function() {
    var defaultScope = newScope();
    defaultScope.setup(new paper.Size(100, 100));
    equals(defaultScope.view._class, 'SvgView',
            'The SVG renderer is the default');
    equals(defaultScope.view.element.nodeName.toLowerCase(), 'svg',
            'The view renders into an svg element');

    var canvasScope = newScope();
    canvasScope.settings.renderer = 'canvas';
    canvasScope.setup(new paper.Size(100, 100));
    equals(canvasScope.view._class, 'CanvasView',
            'paper.settings.renderer opts back into the canvas renderer');

    var element = document.createElement('canvas');
    element.setAttribute('data-paper-renderer', 'canvas');
    var attributeScope = newScope();
    attributeScope.setup(element);
    equals(attributeScope.view._class, 'CanvasView',
            'A data-paper-renderer attribute opts one view out');
    equals(attributeScope.view.element, element,
            'That view keeps the canvas element it was given');

    var plain = document.createElement('canvas');
    plain.setAttribute('renderer', 'canvas');
    var plainScope = newScope();
    plainScope.setup(plain);
    equals(plainScope.view._class, 'CanvasView',
            'The un-prefixed renderer attribute works the same way');
});

test('An <svg> element selects the SVG renderer on its own', function() {
    // The element wins over the setting: there is nothing a CanvasView could
    // do with an <svg>, so honouring 'canvas' here would only fail later.
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '50');
    svg.setAttribute('height', '40');
    var scope = newScope();
    scope.settings.renderer = 'canvas';
    scope.setup(svg);
    equals(scope.view._class, 'SvgView',
            'An <svg> element is rendered by SvgView whatever the setting is');
    equals(scope.view.element, svg, 'And the element itself is adopted');
    equals(scope.view.viewSize.toString(), new paper.Size(50, 40).toString(),
            'Its width and height attributes give the view its size');
    scope.project.remove();
});

test('A scope set up without an element is canvas-backed', function() {
    // Such a scope never paints - it exists for serialization, cloning and
    // export - so mirroring its scene into a detached SVG tree would be pure
    // cost, and Item#rasterize() goes through a canvas either way.
    var scope = newScope();
    scope.settings.renderer = 'svg';
    scope.setup();
    equals(scope.view._class, 'CanvasView',
            'No element means CanvasView, whatever the setting says');
    equals(scope.view.viewSize.toString(), new paper.Size(1, 1).toString(),
            'It gets the nominal 1x1 size it had before');

    // A Size passed deliberately is a different thing: an offscreen view of a
    // known size, which still gets the renderer that was asked for.
    var sized = newScope();
    sized.settings.renderer = 'svg';
    sized.setup(new paper.Size(40, 40));
    equals(sized.view._class, 'SvgView',
            'An explicit size still gets the renderer that was asked for');
});

test('The view takes over the element it replaces', function() {
    var element = document.createElement('canvas');
    element.id = 'svg-view-test';
    element.className = 'stage';
    element.setAttribute('width', '120');
    element.setAttribute('height', '90');
    document.body.appendChild(element);
    var scope = newScope();
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
    scope.project.remove();
    equals(document.body.contains(element), true,
            'Removing the project puts the canvas back');
    element.parentNode.removeChild(element);
});

test('Setting up twice on the same element', function() {
    var element = document.createElement('canvas');
    element.setAttribute('width', '80');
    element.setAttribute('height', '60');
    var host = document.createElement('div');
    host.appendChild(element);
    document.body.appendChild(host);

    var scope = newScope();
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

    var scope = newScope();
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

test('An <svg> the caller owns keeps the nodes it brought itself', function() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '80');
    svg.setAttribute('height', '60');
    var own = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    own.textContent = 'not paper\'s';
    svg.appendChild(own);
    document.body.appendChild(svg);

    var scope = newScope();
    scope.setup(svg);
    scope.view.update();
    equals(svg.childNodes.length, 4, 'The view appends beside what was there');
    equals(svg.firstChild, own, 'The document\'s own node stays first');
    scope.project.remove();
    equals(svg.childNodes.length, 1, 'Only the view\'s nodes are taken out');
    equals(svg.firstChild, own, 'The document\'s own node is left alone');
    svg.parentNode.removeChild(svg);
});

test('The view API is the same in both renderers', function() {
    var svg = createScope('svg'),
        canvas = createScope('canvas'),
        // Everything View declares that an application reaches for. Both
        // subclasses have to answer all of it, or switching renderer is not
        // the configuration change it is documented to be.
        members = ['update', 'requestUpdate', 'remove', 'play', 'pause',
            'isVisible', 'isInserted', 'getSize', 'getBounds', 'getCenter',
            'setCenter', 'getZoom', 'setZoom', 'getRotation', 'setRotation',
            'getScaling', 'setScaling', 'getMatrix', 'setMatrix',
            'getViewSize', 'setViewSize', 'getElement', 'getPixelSize',
            'getTextWidth', 'projectToView', 'viewToProject',
            'getEventPoint', 'on', 'off', 'emit'];
    for (var i = 0; i < members.length; i++) {
        var name = members[i];
        equals(typeof svg.view[name], 'function',
                'SvgView#' + name + '() exists');
        equals(typeof canvas.view[name], typeof svg.view[name],
                'CanvasView#' + name + '() has the same kind of member');
    }
    equals(svg.view.pixelRatio, 1,
            'SVG is resolution independent, so the pixel ratio is always 1');
    equals(svg.view.element.nodeName.toLowerCase(), 'svg',
            'View#element is the <svg> for the SVG renderer');
    equals(canvas.view.element.nodeName.toLowerCase(), 'canvas',
            'And the <canvas> for the canvas one');
});

test('Text measuring agrees between the renderers', function() {
    // SVG cannot measure text without laying it out, so SvgView keeps an
    // offscreen canvas context for it. The numbers have to come out the same,
    // or an item's bounds would depend on the renderer.
    var svg = createScope('svg'),
        canvas = createScope('canvas'),
        font = 'normal normal 20px sans-serif',
        lines = ['Hamburgefonstiv', 'x'];
    equals(svg.view.getTextWidth(font, lines),
            canvas.view.getTextWidth(font, lines),
            'View#getTextWidth() measures the same');
    equals(svg.view.getPixelSize('20px'), canvas.view.getPixelSize('20px'),
            'View#getPixelSize() converts the same');

    canvas.activate();
    var a = new canvas.PointText({ point: [0, 0], content: 'measure me',
            fontSize: 20 });
    svg.activate();
    var b = new svg.PointText({ point: [0, 0], content: 'measure me',
            fontSize: 20 });
    equals(b.bounds.width, a.bounds.width,
            'Which means text bounds do not depend on the renderer');
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

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

test('Every item class gets the node its renderer expects', function() {
    var scope = createSvgScope();
    new scope.Path.Circle({ center: [20, 20], radius: 5, fillColor: 'red' });
    new scope.Shape.Circle({ center: [40, 20], radius: 5, fillColor: 'red' });
    new scope.Shape.Ellipse({ point: [50, 10], size: [20, 10],
            fillColor: 'red' });
    new scope.Shape.Rectangle({ point: [80, 10], size: [20, 10],
            fillColor: 'red' });
    new scope.PointText({ point: [10, 80], content: 'x', fillColor: 'red' });
    var group = new scope.Group([
        new scope.Path.Circle({ center: [20, 50], radius: 5,
            fillColor: 'red' })
    ]);
    new scope.CompoundPath({
        children: [new scope.Path.Circle({ center: [60, 60], radius: 10 })],
        fillColor: 'red'
    });
    scope.view.update();
    var tags = {};
    var nodes = contentNode(scope).querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
        var name = nodes[i].nodeName.toLowerCase();
        tags[name] = (tags[name] || 0) + 1;
    }
    equals(tags.path, 3, 'Path, CompoundPath and the grouped path are <path>');
    equals(tags.circle, 1, 'Shape.Circle is a <circle>');
    equals(tags.ellipse, 1, 'Shape.Ellipse is an <ellipse>');
    equals(tags.rect, 1, 'Shape.Rectangle is a <rect>');
    equals(tags.text, 1, 'PointText is a <text>');
    // The layer, plus the group, plus the tspan inside the text.
    equals(tags.g, 2, 'Layer and Group are both <g>');
    equals(group.children.length, 1, 'The group kept its child');
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

test('Shape geometry is written around the origin', function() {
    // A shape is centred on its own origin and placed by its matrix, which is
    // what makes moving one a single transform attribute write.
    var scope = createSvgScope();
    var rect = new scope.Shape.Rectangle({
            point: [10, 20], size: [40, 20], fillColor: 'red'
        }),
        ellipse = new scope.Shape.Ellipse({
            point: [0, 0], size: [30, 10], fillColor: 'blue'
        });
    scope.view.update();
    var rectNode = getItemNodes(scope, 'rect')[0],
        ellipseNode = getItemNodes(scope, 'ellipse')[0];
    equals(rectNode.getAttribute('x'), '-20', 'x is minus half the width');
    equals(rectNode.getAttribute('y'), '-10', 'y is minus half the height');
    equals(rectNode.getAttribute('rx'), null,
            'A square-cornered rectangle writes no corner radius');
    equals(rectNode.getAttribute('transform'), 'matrix(1,0,0,1,30,30)',
            'The matrix places it at its centre');
    equals(ellipseNode.getAttribute('rx'), '15', 'The ellipse has rx');
    equals(ellipseNode.getAttribute('ry'), '5', 'And ry');
    rect.size = [60, 20];
    scope.view.update();
    equals(rectNode.getAttribute('width'), '60', 'Resizing rewrites the width');
    equals(rectNode.getAttribute('x'), '-30', 'And recentres it');
    equals(ellipse.bounds.width, 30, 'The item itself is unaffected');
});

test('applyMatrix: false items carry a transform attribute', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Rectangle({
            point: [0, 0], size: [10, 10], fillColor: 'red',
            applyMatrix: false
        }),
        applied = new scope.Path.Rectangle({
            point: [0, 0], size: [10, 10], fillColor: 'blue'
        });
    applied.translate(20, 30);
    path.translate(20, 30);
    scope.view.update();
    var node = nodeFor(scope, path),
        appliedNode = nodeFor(scope, applied);
    equals(node.getAttribute('transform'), 'matrix(1,0,0,1,20,30)',
            'The matrix is written out');
    equals(appliedNode.getAttribute('transform'), null,
            'An applied matrix leaves no transform attribute behind');
    path.applyMatrix = true;
    scope.view.update();
    equals(node.getAttribute('transform'), null,
            'Applying the matrix removes the attribute again');
    equals(node.getAttribute('d'), path.getPathData(null, 5),
            'And folds the transform into the path data');
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
    path.visible = true;
    scope.view.update();
    equals(node.getAttribute('visibility'), null,
            'And shown again by dropping the attribute');
    var data = node.getAttribute('d');
    path.position = path.position.add([10, 0]);
    scope.view.update();
    equals(node.getAttribute('d') !== data, true, 'The geometry was updated');
    equals(node.parentNode != null, true, 'The same node is still in use');
});

test('Segment edits reach the path data', function() {
    var scope = createSvgScope();
    var path = new scope.Path([[10, 10], [50, 10], [50, 50]]);
    path.strokeColor = 'black';
    scope.view.update();
    var node = nodeFor(scope, path);
    equals(node.getAttribute('d'), path.getPathData(null, 5),
            'The open path is written out');
    path.segments[1].point = [60, 20];
    scope.view.update();
    equals(node.getAttribute('d'), path.getPathData(null, 5),
            'Moving a segment rewrites it');
    path.segments[1].handleOut = [10, 10];
    scope.view.update();
    equals(node.getAttribute('d'), path.getPathData(null, 5),
            'Moving a handle rewrites it');
    path.add([70, 70]);
    scope.view.update();
    equals(node.getAttribute('d'), path.getPathData(null, 5),
            'Adding a segment rewrites it');
    path.closed = true;
    scope.view.update();
    equals(/z$/i.test(node.getAttribute('d')), true, 'Closing it closes the d');
});

test('update() only reports work it actually did', function() {
    var scope = createSvgScope();
    equals(scope.view.update(), true, 'The first update renders the scene');
    equals(scope.view.update(), false, 'A second one has nothing to do');
    var path = new scope.Path.Circle({
        center: [50, 50], radius: 10, fillColor: 'red'
    });
    equals(scope.view.update(), true, 'A change makes one necessary again');
    equals(scope.view.update(), false, 'And is cleared by it');
    path.fillColor = 'blue';
    equals(scope.view.update(), true, 'A style change counts too');
});

test('An unchanged item is not written to', function() {
    // The point of the change tracking: an update touches the items that
    // changed, not the scene.
    var scope = createSvgScope();
    var a = new scope.Path.Circle({ center: [20, 20], radius: 5,
            fillColor: 'red' }),
        b = new scope.Path.Circle({ center: [60, 60], radius: 5,
            fillColor: 'blue' });
    scope.view.update();
    var writesToB = countWrites(nodeFor(scope, b), function() {
        a.fillColor = 'green';
        scope.view.update();
    });
    equals(writesToB, 0, 'Changing one item does not write to the other');
    var writesToA = countWrites(nodeFor(scope, a), function() {
        a.fillColor = 'green';
        scope.view.update();
    });
    equals(writesToA, 0,
            'And re-setting the same value writes no attribute at all');
});

test('Panning and zooming only change the root transform', function() {
    var scope = createSvgScope();
    for (var i = 0; i < 20; i++) {
        new scope.Path.Circle({ center: [i * 5, 20], radius: 4,
                fillColor: 'red' });
    }
    scope.view.update();
    var content = contentNode(scope),
        first = getItemNodes(scope)[0],
        data = first.getAttribute('d');
    var writes = countWrites(first, function() {
        scope.view.zoom = 2;
        scope.view.center = [40, 40];
        scope.view.update();
    });
    equals(content.getAttribute('transform'),
            'matrix(' + scope.view.matrix.values.join(',') + ')',
            'The view matrix is applied to the content group');
    equals(getItemNodes(scope)[0].getAttribute('d'), data,
            'The item nodes are left untouched');
    equals(writes, 0, 'No item attribute is written at all');
});

test('The view size is mirrored onto the <svg>', function() {
    var scope = createSvgScope(new paper.Size(200, 200));
    var element = scope.view.element;
    equals(element.getAttribute('width'), '200', 'The width is set');
    equals(element.getAttribute('viewBox'), '0 0 200 200',
            'And a matching viewBox, so CSS can scale it freely');
    equals(element.getAttribute('preserveAspectRatio'), 'none',
            'Which is stretched like a canvas rather than letterboxed');
    scope.view.viewSize = [300, 150];
    scope.view.update();
    equals(element.getAttribute('width'), '300', 'Resizing rewrites the width');
    equals(element.getAttribute('height'), '150', 'And the height');
    equals(element.getAttribute('viewBox'), '0 0 300 150',
            'And the viewBox');
    equals(scope.view.bounds.width, 300, 'The view reports the new size');
});

// ---------------------------------------------------------------------------
// Scene graph bookkeeping
// ---------------------------------------------------------------------------

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

test('Reordering reuses the nodes it already has', function() {
    var scope = createSvgScope();
    var a = new scope.Path.Circle({ center: [20, 20], radius: 5,
            fillColor: 'red' }),
        b = new scope.Path.Circle({ center: [40, 40], radius: 5,
            fillColor: 'blue' }),
        c = new scope.Path.Circle({ center: [60, 60], radius: 5,
            fillColor: 'green' });
    scope.view.update();
    var nodeA = nodeFor(scope, a),
        layer = nodeFor(scope, scope.project.activeLayer);
    a.bringToFront();
    scope.view.update();
    equals(nodeFor(scope, a), nodeA, 'The node itself is reused');
    equals(layer.childNodes[2], nodeA, 'And moved to the front of the parent');
    c.insertBelow(b);
    scope.view.update();
    equals(layer.childNodes[0], nodeFor(scope, c),
            'insertBelow() puts the node where the item went');
    equals(layer.childNodes.length, 3, 'And adds none');
});

test('Reparenting reuses the node the item already has', function() {
    // Moving between two owners queues a change on each, and the one the item
    // left is synchronized first - so the node has to be taken out of the old
    // parent when the insertion is seen, or the sweep at the end of
    // #_syncChildren() takes it for a removed item and disposes it, subtree
    // and all.
    var scope = createSvgScope();
    var from = new scope.Group(),
        to = new scope.Group(),
        path = new scope.Path.Circle({ center: [20, 20], radius: 5,
            fillColor: 'red' });
    from.addChild(path);
    scope.view.update();
    var before = nodeFor(scope, path);

    to.addChild(path);
    scope.view.update();
    equals(nodeFor(scope, path), before, 'The same node is reused');
    equals(before.parentNode, nodeFor(scope, to), 'Under the new owner');
    equals(nodeFor(scope, from).childNodes.length, 0,
            'And out of the old one');
    equals(getItemNodes(scope).length, 1, 'It still renders exactly once');

    // A whole subtree keeps its nodes too, not just the item that moved.
    var inner = new scope.Group([
            new scope.Path.Circle({ center: [60, 60], radius: 5,
                fillColor: 'blue' })
        ]),
        leaf = inner.firstChild;
    from.addChild(inner);
    scope.view.update();
    var innerNode = nodeFor(scope, inner),
        leafNode = nodeFor(scope, leaf);
    to.addChild(inner);
    scope.view.update();
    equals(nodeFor(scope, inner), innerNode, 'A moved group keeps its node');
    equals(nodeFor(scope, leaf), leafNode, 'And so does what is inside it');
    equals(leafNode.parentNode, innerNode, 'Still nested as it was');

    // Into a group created in the same batch it already worked, because that
    // group has no node yet when the old owner is swept.
    var fresh = new scope.Group([path]);
    scope.view.update();
    equals(nodeFor(scope, path), before, 'A newly created group reuses it too');
    equals(before.parentNode, nodeFor(scope, fresh), 'And adopts the node');
});

test('Reparenting keeps the order of the new owner\'s children', function() {
    var scope = createSvgScope();
    var from = new scope.Group(),
        a = new scope.Path.Circle({ center: [10, 10], radius: 5,
            fillColor: 'red' }),
        b = new scope.Path.Circle({ center: [30, 30], radius: 5,
            fillColor: 'blue' }),
        to = new scope.Group([a, b]),
        moved = new scope.Path.Circle({ center: [50, 50], radius: 5,
            fillColor: 'green' });
    from.addChild(moved);
    scope.view.update();
    // Insert it between the two, rather than at the end where the move puts
    // it: the owner's synchronization has to walk it back into place.
    to.insertChild(1, moved);
    scope.view.update();
    var children = nodeFor(scope, to).childNodes;
    equals(children.length, 3, 'All three are under the new owner');
    equals(children[0], nodeFor(scope, a), 'The first child is unmoved');
    equals(children[1], nodeFor(scope, moved),
            'The moved node landed at its index, not at the end');
    equals(children[2], nodeFor(scope, b), 'And the last one moved along');
});

test('Nested groups nest their nodes', function() {
    var scope = createSvgScope();
    var leaf = new scope.Path.Circle({ center: [50, 50], radius: 5,
            fillColor: 'red' }),
        inner = new scope.Group([leaf]),
        outer = new scope.Group([inner]);
    scope.view.update();
    var leafNode = nodeFor(scope, leaf);
    equals(leafNode.parentNode, nodeFor(scope, inner),
            'The leaf sits inside the inner group\'s node');
    equals(nodeFor(scope, inner).parentNode, nodeFor(scope, outer),
            'Which sits inside the outer group\'s node');
    equals(nodeFor(scope, outer).parentNode,
            nodeFor(scope, scope.project.activeLayer),
            'Which sits inside the layer\'s node');
    equals(nodeFor(scope, scope.project.activeLayer).parentNode,
            contentNode(scope), 'And the layer in the content group');
    // With the default applyMatrix, a group hands its transform down to its
    // children, so the move shows up in the leaf's own path data.
    var data = leafNode.getAttribute('d');
    outer.translate(10, 10);
    scope.view.update();
    equals(nodeFor(scope, outer).getAttribute('transform'), null,
            'An applied group matrix leaves no transform behind');
    equals(leafNode.getAttribute('d') !== data, true,
            'It reaches the children\'s geometry instead');

    // A group that keeps its matrix writes it on its own node, and its
    // children are not touched at all - which is the cheap way to move a
    // subtree, one attribute rather than one rewrite per item.
    outer.applyMatrix = false;
    var kept = leafNode.getAttribute('d');
    outer.translate(10, 10);
    scope.view.update();
    equals(nodeFor(scope, outer).getAttribute('transform'),
            'matrix(1,0,0,1,10,10)', 'A group is moved by its own transform');
    equals(leafNode.getAttribute('d'), kept, 'Its children are not touched');
});

test('Layers are rendered as groups in the content node', function() {
    var scope = createSvgScope();
    var first = scope.project.activeLayer;
    new scope.Path.Circle({ center: [10, 10], radius: 4, fillColor: 'red' });
    var second = new scope.Layer();
    new scope.Path.Circle({ center: [20, 20], radius: 4, fillColor: 'blue' });
    scope.view.update();
    var content = contentNode(scope);
    equals(content.childNodes.length, 2, 'One node per layer');
    equals(content.childNodes[0].nodeName.toLowerCase(), 'g',
            'Layers render as groups');
    equals(content.childNodes[0], nodeFor(scope, first),
            'In the project\'s child order');
    second.sendToBack();
    scope.view.update();
    equals(content.childNodes[0], nodeFor(scope, second),
            'Reordering layers reorders their nodes');
    second.visible = false;
    scope.view.update();
    equals(nodeFor(scope, second).getAttribute('visibility'), 'hidden',
            'A hidden layer hides its node');
    second.remove();
    scope.view.update();
    equals(content.childNodes.length, 1, 'Removing a layer removes its node');
});

test('Removing items releases their nodes and definitions', function() {
    var scope = createSvgScope();
    var gradient = {
        gradient: { stops: ['red', 'blue'] },
        origin: [0, 0],
        destination: [10, 10]
    };
    var group = new scope.Group([
        new scope.Path.Circle({ center: [50, 50], radius: 20,
            fillColor: gradient, shadowColor: 'black', shadowBlur: 4 }),
        new scope.Group([
            new scope.Path.Rectangle({ point: [0, 0], size: [10, 10],
                fillColor: gradient })
        ])
    ]);
    scope.view.update();
    var defs = defsNode(scope);
    equals(defs.childNodes.length, 3,
            'Two gradients and a shadow filter were defined');
    // The layer, the group, its two children and the inner group.
    equals(nodeCount(scope), 5, 'A node is held for every item');
    group.remove();
    scope.view.update();
    equals(defs.childNodes.length, 0,
            'Removing the subtree removes every definition it owned');
    equals(nodeCount(scope), 1, 'And every node below it, layer aside');
    equals(contentNode(scope).querySelectorAll('*').length, 1,
            'The content group holds nothing but the empty layer');
});

test('project.clear() empties the tree', function() {
    var scope = createSvgScope();
    for (var i = 0; i < 5; i++) {
        new scope.Path.Circle({ center: [i * 10, 10], radius: 4,
                fillColor: 'red' });
    }
    scope.view.update();
    equals(getItemNodes(scope).length, 5, 'The items are rendered');
    scope.project.clear();
    scope.view.update();
    equals(getItemNodes(scope).length, 0, 'Clearing takes them all out');
    equals(nodeCount(scope), 0, 'And forgets every node, layers included');
    equals(contentNode(scope).childNodes.length, 0,
            'The content group is empty');
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
    compound.lastChild.remove();
    scope.view.update();
    equals(node.getAttribute('d'), compound.getPathData(null, 5),
            'Removing one covers the rest');
    equals(getItemNodes(scope, 'path').length, 1, 'Still one node');
    compound.firstChild.segments[0].point =
            compound.firstChild.segments[0].point.add([5, 0]);
    scope.view.update();
    equals(node.getAttribute('d'), compound.getPathData(null, 5),
            'Editing a child\'s geometry rewrites the compound path');
    equals(nodeCount(scope), 2,
            'Only the layer and the compound path itself hold nodes');
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

test('A clip item is kept up to date inside its clipPath', function() {
    var scope = createSvgScope();
    var clip = new scope.CompoundPath({
            children: [
                new scope.Path.Circle({ center: [50, 50], radius: 30 }),
                new scope.Path.Circle({ center: [50, 50], radius: 10 })
            ]
        }),
        group = new scope.Group([
            clip,
            new scope.Path.Rectangle({ point: [0, 0], size: [100, 100],
                fillColor: 'red' })
        ]);
    group.clipped = true;
    scope.view.update();
    var clipPath = scope.view.element.querySelector('clipPath');
    equals(clipPath.childNodes.length, 1,
            'A compound clip item is one node in the clipPath');
    equals(clipPath.firstChild.nodeName.toLowerCase(), 'path',
            'Which is the compound path\'s own <path>');
    clip.firstChild.radius = 15;
    scope.view.update();
    equals(clipPath.firstChild.getAttribute('d'),
            clip.getPathData(null, 5),
            'Changing the clip item\'s geometry rewrites the clip path');
    clip.remove();
    scope.view.update();
    equals(scope.view.element.querySelectorAll('clipPath').length, 0,
            'Removing the clip item removes the definition');
    equals(nodeFor(scope, group).getAttribute('clip-path'), null,
            'And the reference to it');
});

test('A clip item is clipped by the rule it asks for', function() {
    // SVG resolves a <clipPath> child's winding with clip-rule; fill-rule has
    // no effect there. So an even-odd clip mask - a compound path with a hole,
    // the usual way to punch one - needs clip-rule, or the hole is lost. The
    // canvas renderer passes the same value to ctx.clip(), see Item#draw().
    var scope = createSvgScope();
    var clip = new scope.CompoundPath({
            children: [
                new scope.Path.Circle({ center: [50, 50], radius: 30 }),
                new scope.Path.Circle({ center: [50, 50], radius: 10 })
            ],
            fillRule: 'evenodd'
        }),
        group = new scope.Group([
            clip,
            new scope.Path.Rectangle({ point: [0, 0], size: [100, 100],
                fillColor: 'red' })
        ]);
    group.clipped = true;
    scope.view.update();
    var node = scope.view.element.querySelector('clipPath').firstChild;
    equals(node.getAttribute('fill-rule'), 'evenodd', 'fill-rule is written');
    equals(node.getAttribute('clip-rule'), 'evenodd',
            'And clip-rule, which is the one that decides the clip');
    // It is a style property, so it has to stay current afterwards - which is
    // why it is written where fill-rule is, not where the clip is set up.
    clip.fillRule = 'nonzero';
    scope.view.update();
    equals(node.getAttribute('clip-rule'), null,
            'Changing the rule afterwards rewrites it');
    equals(node.getAttribute('fill-rule'), null, 'Along with fill-rule');
});

test('With two clip masks, the first one clips and the rest are drawn',
function() {
    // Group#_getClipItem() takes the first child with _clipMask and leaves
    // every other one to be drawn normally, which is what the canvas renderer
    // paints - so the SVG renderer asks it rather than deciding again.
    var scope = createSvgScope();
    var first = new scope.Path.Circle({ center: [30, 30], radius: 20 }),
        second = new scope.Path.Rectangle({ point: [0, 0], size: [10, 10] }),
        painted = new scope.Path.Rectangle({ point: [50, 50], size: [10, 10],
            fillColor: 'red' }),
        group = new scope.Group([first, second, painted]);
    first.clipMask = true;
    second.clipMask = true;
    scope.view.update();
    equals(group._getClipItem(), first, 'The first of them is the clip item');
    var clipPath = scope.view.element.querySelector('clipPath');
    equals(clipPath.childNodes.length, 1, 'A single clip is defined');
    equals(clipPath.firstChild.getAttribute('d'), first.getPathData(null, 5),
            'Built from that first child');
    equals(nodeFor(scope, group).childNodes.length, 2,
            'And the other two are drawn as ordinary children');
    // Clearing the first hands the role to the next one along, as it does on
    // canvas - Group#_getClipItem() re-reads the children.
    first.clipMask = false;
    scope.view.update();
    equals(group._getClipItem(), second, 'Clearing the first promotes the next');
    equals(scope.view.element.querySelector('clipPath').firstChild
            .getAttribute('d'), second.getPathData(null, 5),
            'Which is what the clipPath is rebuilt from');
    equals(nodeFor(scope, group).childNodes.length, 2,
            'And the demoted one becomes a child again');
});

test('Promoting an existing child to clip mask keeps its node', function() {
    // The clip item is skipped in the walk that positions the siblings, so it
    // ends up trailing them - and the sweep that follows takes whatever is
    // left past the last child for a removed item. It has to be moved into
    // its clipPath before that runs, or its node is thrown away and the group
    // ends up clipped by an empty path, which hides everything.
    var scope = createSvgScope();
    var mask = new scope.Path.Circle({ center: [50, 50], radius: 20 }),
        painted = new scope.Path.Rectangle({ point: [0, 0], size: [100, 100],
            fillColor: 'red' }),
        group = new scope.Group([mask, painted]);
    scope.view.update();
    var maskNode = nodeFor(scope, mask);
    equals(nodeFor(scope, group).childNodes.length, 2,
            'Both start out as ordinary children');

    mask.clipMask = true;
    scope.view.update();
    var clipPath = scope.view.element.querySelector('clipPath');
    equals(clipPath != null, true, 'Setting clipMask defines a clipPath');
    equals(nodeFor(scope, mask), maskNode, 'The item keeps the node it had');
    equals(clipPath.firstChild, maskNode, 'Which moved into the clipPath');
    equals(clipPath.firstChild.getAttribute('d'), mask.getPathData(null, 5),
            'With its geometry intact, rather than an empty path');
    equals(nodeFor(scope, group).childNodes.length, 1,
            'And out of the sibling list');

    mask.clipMask = false;
    scope.view.update();
    equals(nodeFor(scope, mask), maskNode, 'Clearing it again reuses it too');
    equals(nodeFor(scope, group).childNodes[0], maskNode,
            'And puts it back among its siblings, in order');
    equals(scope.view.element.querySelectorAll('clipPath').length, 0,
            'The definition is gone');
});

test('A project is not clipped by a layer', function() {
    // Project#draw() draws its children and nothing else, so a clip-masked
    // layer clips nothing on canvas. The content group follows suit, rather
    // than defining a clipPath keyed on a project, which has no id to key on.
    var scope = createSvgScope();
    var layer = scope.project.activeLayer;
    new scope.Path.Circle({ center: [50, 50], radius: 20, fillColor: 'red' });
    layer.clipMask = true;
    scope.view.update();
    equals(scope.view.element.querySelectorAll('clipPath').length, 0,
            'No clipPath is defined for the project');
    equals(contentNode(scope).getAttribute('clip-path'), null,
            'And the content group references none');
    equals(contentNode(scope).childNodes.length, 1,
            'The layer is still rendered');
});

test('Removing a view leaves nothing behind', function() {
    var scope = createSvgScope();
    new scope.Path.Circle({ center: [50, 50], radius: 20,
            fillColor: { gradient: { stops: ['red', 'blue'] },
                origin: [0, 0], destination: [10, 0] } });
    scope.view.update();
    // #remove() unlinks the view from the scope, so hold on to it.
    var view = scope.view,
        project = scope.project,
        element = view.element;
    equals(element.childNodes.length, 3, 'The view rendered into the element');
    equals(view.remove(), true, 'The view reports it was removed');
    equals(element.childNodes.length, 0, 'Its nodes were taken back out');
    equals(Object.keys(view._nodes).length, 0,
            'It forgot every node it held');
    equals(project._changes, null,
            'And switched the project\'s change tracking off again');
});

test('Two views keep their definitions apart', function() {
    var gradient = {
        gradient: { stops: ['red', 'blue'] },
        origin: [0, 0],
        destination: [10, 0]
    };
    var a = createSvgScope();
    new a.Path.Circle({ center: [50, 50], radius: 10, fillColor: gradient });
    a.view.update();
    var b = createSvgScope();
    new b.Path.Circle({ center: [50, 50], radius: 10, fillColor: gradient });
    b.view.update();
    var idA = a.view.element.querySelector('linearGradient').id,
        idB = b.view.element.querySelector('linearGradient').id;
    equals(idA !== idB, true,
            'Definition ids are namespaced by the view that made them');
    equals(a.view.element.querySelector('path').getAttribute('fill'),
            'url(#' + idA + ')', 'Each item references its own view\'s');
    equals(b.view.element.querySelector('path').getAttribute('fill'),
            'url(#' + idB + ')', 'So two views on one page cannot collide');
});

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

test('The stroke and fill style is mirrored attribute for attribute', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Rectangle({
        point: [10, 10],
        size: [40, 40],
        fillColor: 'red',
        fillRule: 'evenodd',
        strokeColor: 'black',
        strokeWidth: 3,
        strokeCap: 'round',
        strokeJoin: 'bevel',
        miterLimit: 4,
        dashArray: [4, 2],
        dashOffset: 2
    });
    scope.view.update();
    var node = nodeFor(scope, path);
    equals(node.getAttribute('fill'), '#ff0000', 'fill');
    equals(node.getAttribute('fill-rule'), 'evenodd', 'fill-rule');
    equals(node.getAttribute('stroke'), '#000000', 'stroke');
    equals(node.getAttribute('stroke-width'), '3', 'stroke-width');
    equals(node.getAttribute('stroke-linecap'), 'round', 'stroke-linecap');
    equals(node.getAttribute('stroke-linejoin'), 'bevel', 'stroke-linejoin');
    equals(node.getAttribute('stroke-miterlimit'), '4', 'stroke-miterlimit');
    equals(node.getAttribute('stroke-dasharray'), '4,2', 'stroke-dasharray');
    equals(node.getAttribute('stroke-dashoffset'), '2', 'stroke-dashoffset');

    // The SVG defaults are left out, so the markup stays close to what
    // Item#exportSVG() produces.
    path.set({ fillRule: 'nonzero', strokeWidth: 1, strokeCap: 'butt',
            strokeJoin: 'miter', miterLimit: 10, dashArray: [], dashOffset: 0 });
    scope.view.update();
    equals(node.getAttribute('fill-rule'), null, 'nonzero is the SVG default');
    equals(node.getAttribute('stroke-width'), null, 'and a width of 1');
    equals(node.getAttribute('stroke-linecap'), null, 'and a butt cap');
    equals(node.getAttribute('stroke-linejoin'), null, 'and a miter join');
    equals(node.getAttribute('stroke-miterlimit'), null,
            'and a miter limit of 10');
    equals(node.getAttribute('stroke-dasharray'), null, 'and no dashes');
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
    equals(node.getAttribute('stroke'), null,
            'Clearing the stroke leaves no paint behind');
    equals(node.getAttribute('stroke-width'), null,
            'Clearing the stroke clears the width');
    equals(node.getAttribute('stroke-dasharray'), null,
            'And the dash pattern');
    path.strokeColor = 'blue';
    scope.view.update();
    equals(node.getAttribute('stroke-width'), '5',
            'Setting it again brings the width back');
});

test('Colour alpha goes into the opacity attributes', function() {
    // SVG 1.1 has no rgba(), so the alpha channel is split out.
    var scope = createSvgScope();
    var path = new scope.Path.Circle({
        center: [50, 50],
        radius: 20,
        fillColor: new scope.Color(1, 0, 0, 0.25),
        strokeColor: new scope.Color(0, 0, 1, 0.5)
    });
    scope.view.update();
    var node = nodeFor(scope, path);
    equals(node.getAttribute('fill'), '#ff0000', 'The fill is the plain hex');
    equals(node.getAttribute('fill-opacity'), '0.25', 'With a fill-opacity');
    equals(node.getAttribute('stroke'), '#0000ff', 'The same for the stroke');
    equals(node.getAttribute('stroke-opacity'), '0.5', 'With its own opacity');
    path.fillColor.alpha = 1;
    path.fillColor = path.fillColor;
    scope.view.update();
    equals(node.getAttribute('fill-opacity'), null,
            'A fully opaque colour writes no opacity attribute');
    path.fillColor = null;
    scope.view.update();
    equals(node.getAttribute('fill'), 'none', 'No fill is fill="none"');
});

test('Item opacity and visibility', function() {
    var scope = createSvgScope();
    var group = new scope.Group([
        new scope.Path.Circle({ center: [50, 50], radius: 10,
            fillColor: 'red' })
    ]);
    scope.view.update();
    var node = nodeFor(scope, group);
    equals(node.getAttribute('opacity'), null, 'Full opacity writes nothing');
    group.opacity = 0.5;
    scope.view.update();
    equals(node.getAttribute('opacity'), '0.5',
            'A group\'s opacity lands on the group node, so its children ' +
            'composite as one, the way the canvas renderer draws them');
    group.opacity = 0;
    scope.view.update();
    equals(node.getAttribute('opacity'), '0', 'Zero opacity is written out');
    group.opacity = 1;
    group.visible = false;
    scope.view.update();
    equals(node.getAttribute('opacity'), null, 'Which is cleared again');
    equals(node.getAttribute('visibility'), 'hidden', 'And hiding works');
});

test('strokeScaling maps to vector-effect', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Circle({
        center: [50, 50], radius: 20, strokeColor: 'black',
        strokeScaling: false
    });
    scope.view.update();
    var node = nodeFor(scope, path);
    equals(node.getAttribute('vector-effect'), 'non-scaling-stroke',
            'A non-scaling stroke is described by vector-effect');
    path.strokeScaling = true;
    scope.view.update();
    equals(node.getAttribute('vector-effect'), null,
            'A scaling stroke is the SVG default');
    path.strokeScaling = false;
    path.strokeColor = null;
    scope.view.update();
    equals(node.getAttribute('vector-effect'), null,
            'And an item with no stroke needs neither');
});

test('Blend modes map to CSS, or to nothing at all', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Circle({
        center: [50, 50], radius: 20, fillColor: 'red'
    });
    scope.view.update();
    var node = nodeFor(scope, path),
        // The 16 of Paper.js's modes that CSS can express. 'add' is the one
        // whose CSS name differs from Paper's.
        expected = {
            normal: null,
            multiply: 'mix-blend-mode:multiply',
            screen: 'mix-blend-mode:screen',
            overlay: 'mix-blend-mode:overlay',
            'soft-light': 'mix-blend-mode:soft-light',
            'hard-light': 'mix-blend-mode:hard-light',
            'color-dodge': 'mix-blend-mode:color-dodge',
            'color-burn': 'mix-blend-mode:color-burn',
            darken: 'mix-blend-mode:darken',
            lighten: 'mix-blend-mode:lighten',
            difference: 'mix-blend-mode:difference',
            exclusion: 'mix-blend-mode:exclusion',
            hue: 'mix-blend-mode:hue',
            saturation: 'mix-blend-mode:saturation',
            color: 'mix-blend-mode:color',
            luminosity: 'mix-blend-mode:luminosity',
            add: 'mix-blend-mode:plus-lighter',
            // The four BlendMode emulates in JavaScript for the canvas
            // renderer, which a DOM tree cannot do. Writing a name CSS does
            // not know would make an invalid declaration that silently renders
            // as 'normal' - leaving it out does the same thing, visibly.
            subtract: null,
            average: null,
            'pin-light': null,
            negation: null
        };
    for (var mode in expected) {
        path.blendMode = mode;
        scope.view.update();
        equals(node.getAttribute('style'), expected[mode],
                mode + ' renders as ' + (expected[mode] || 'normal'));
    }
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
    equals(gradient.getAttribute('gradientUnits'), 'userSpaceOnUse',
            'In the node\'s own coordinate system');
    path.remove();
    scope.view.update();
    equals(svg.querySelectorAll('linearGradient').length, 0,
            'The definition is removed with the item');
});

test('Radial gradients, highlights and stroke gradients', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Circle({
        center: [50, 50],
        radius: 20,
        fillColor: {
            gradient: { stops: ['yellow', 'red'], radial: true },
            origin: [50, 50],
            destination: [70, 50],
            highlight: [45, 45]
        },
        strokeColor: {
            gradient: { stops: ['black', 'white'] },
            origin: [30, 50],
            destination: [70, 50]
        },
        strokeWidth: 4
    });
    scope.view.update();
    var svg = scope.view.element,
        node = nodeFor(scope, path),
        radial = svg.querySelector('radialGradient'),
        linear = svg.querySelector('linearGradient');
    equals(radial != null, true, 'The fill made a radialGradient');
    equals(radial.getAttribute('cx'), '50', 'Centred on the origin');
    equals(radial.getAttribute('r'), '20',
            'With the origin-to-destination distance as its radius');
    equals(radial.getAttribute('fx'), '45', 'The highlight is the focal point');
    equals(linear != null, true, 'The stroke made its own linearGradient');
    equals(node.getAttribute('fill'), 'url(#' + radial.id + ')',
            'The fill references the radial one');
    equals(node.getAttribute('stroke'), 'url(#' + linear.id + ')',
            'And the stroke the linear one');
    equals(svg.querySelectorAll('defs > *').length, 2,
            'One definition per item and paint role');
});

test('Gradient definitions are updated in place', function() {
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
    var defs = defsNode(scope),
        def = defs.firstChild;
    path.fillColor.gradient.stops = ['red', 'green', 'blue'];
    scope.view.update();
    equals(defs.childNodes.length, 1, 'Changing a gradient leaks no nodes');
    equals(defs.firstChild, def, 'The same definition is reused');
    equals(def.childNodes.length, 3, 'And rewritten with the new stops');
    equals(def.childNodes[1].getAttribute('stop-color'), '#008000',
            'The stop colours are written out');
    path.fillColor.gradient.radial = true;
    scope.view.update();
    equals(defs.childNodes.length, 1, 'Switching to radial leaks nothing');
    equals(defs.firstChild.nodeName.toLowerCase(), 'radialgradient',
            'But does replace the definition with the right tag');
    equals(nodeFor(scope, path).getAttribute('fill'),
            'url(#' + defs.firstChild.id + ')',
            'And the item still references it');
});

test('Gradients are defined in the node\'s coordinate system', function() {
    // A gradient is defined in the item's parent space, while the definition
    // paints in the node's own, which the item's matrix transforms - so the
    // points have to be inverse transformed, as Color#toCanvasStyle() does for
    // the canvas renderer. Note that transforming an item transforms its
    // gradient colour along with it, so the two only come apart when the
    // colour is set on an item that already carries a matrix.
    var scope = createSvgScope();
    var path = new scope.Path.Rectangle({
        point: [0, 0], size: [20, 20], applyMatrix: false
    });
    path.translate(50, 0);
    path.fillColor = {
        gradient: { stops: ['yellow', 'red'] },
        origin: [50, 0],
        destination: [70, 0]
    };
    scope.view.update();
    var def = defsNode(scope).firstChild,
        node = nodeFor(scope, path);
    equals(node.getAttribute('transform'), 'matrix(1,0,0,1,50,0)',
            'The item\'s matrix is on the node');
    equals(def.getAttribute('x1'), '0',
            'So the origin is written inverse transformed by it');
    equals(def.getAttribute('x2'), '20', 'And so is the destination');
    // Which is the invariant that matters: applying the node's transform to
    // the written points has to land back on the colour's own points.
    var placed = path.matrix.transform(
            new scope.Point(+def.getAttribute('x1'), +def.getAttribute('y1')));
    equals(placed.toString(), path.fillColor.origin.toString(),
            'The gradient ends up where the colour says it should');

    // And the same holds once the item is moved again, which redefines both.
    path.translate(0, 30);
    scope.view.update();
    var moved = path.matrix.transform(
            new scope.Point(+def.getAttribute('x1'), +def.getAttribute('y1')));
    equals(moved.toString(), path.fillColor.origin.toString(),
            'Moving the item keeps the gradient on it');
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
    equals(shadow.getAttribute('dy'), '4', 'In both directions');
    equals(shadow.getAttribute('stdDeviation'), '6',
            'The blur radius is half of shadowBlur');
    equals(shadow.getAttribute('flood-opacity'), '0.5',
            'The colour\'s alpha becomes the flood opacity');
    path.shadowBlur = 4;
    path.shadowOffset = [1, 1];
    scope.view.update();
    equals(svg.querySelectorAll('filter').length, 1,
            'Changing it updates the definition in place');
    equals(filter.firstChild.getAttribute('stdDeviation'), '2',
            'With the new blur');
    path.shadowColor = null;
    scope.view.update();
    equals(svg.querySelectorAll('filter').length, 0,
            'Clearing the shadow removes the definition');
    equals(node.getAttribute('filter'), null, 'And the reference');
});

test('A shadow set on a group lands on its children', function() {
    // Group styles are the children's styles in Paper.js, and the canvas
    // renderer never paints the group itself - so the filter has to sit where
    // the paint happens, or a group would shadow twice.
    var scope = createSvgScope();
    var group = new scope.Group([
        new scope.Path.Circle({ center: [50, 50], radius: 10,
            fillColor: 'red' })
    ]);
    group.shadowColor = 'black';
    group.shadowBlur = 5;
    scope.view.update();
    equals(nodeFor(scope, group).getAttribute('filter'), null,
            'The group node carries no filter');
    equals(nodeFor(scope, group.firstChild).getAttribute('filter') != null,
            true, 'Its child does');
    equals(scope.view.element.querySelectorAll('filter').length, 1,
            'And there is exactly one definition');
});

// ---------------------------------------------------------------------------
// Text, rasters and symbols
// ---------------------------------------------------------------------------

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

test('Text style changes reach the node', function() {
    // Style reports the text properties as a geometry change, since they move
    // the text's bounds - so they have to reach the style writer too, or every
    // text would stay frozen at the values it was created with.
    var scope = createSvgScope();
    var text = new scope.PointText({
        point: [10, 20], content: 'hello', fillColor: 'black'
    });
    scope.view.update();
    var node = nodeFor(scope, text);
    text.fontSize = 30;
    scope.view.update();
    equals(node.getAttribute('font-size'), '30', 'The size follows');
    text.fontFamily = 'serif';
    scope.view.update();
    equals(node.getAttribute('font-family'), 'serif', 'The family follows');
    text.justification = 'center';
    scope.view.update();
    equals(node.getAttribute('text-anchor'), 'middle',
            'Centre justification is a middle anchor');
    text.justification = 'right';
    scope.view.update();
    equals(node.getAttribute('text-anchor'), 'end', 'Right is an end anchor');
    text.justification = 'left';
    scope.view.update();
    equals(node.getAttribute('text-anchor'), null, 'Left is the SVG default');
    // Paper carries the whole CSS font-weight / font-style fragment in
    // fontWeight, which SVG wants split across two attributes.
    text.fontWeight = 'italic bold';
    scope.view.update();
    equals(node.getAttribute('font-style'), 'italic', 'The style is split out');
    equals(node.getAttribute('font-weight'), 'bold', 'And the weight kept');
    text.fontWeight = 'bold';
    scope.view.update();
    equals(node.getAttribute('font-style'), null,
            'A plain weight leaves no font-style behind');
    equals(node.getAttribute('font-weight'), 'bold', 'And is written as is');
});

test('Text lines are added and removed with the content', function() {
    var scope = createSvgScope();
    var text = new scope.PointText({
        point: [10, 20], content: 'a', fillColor: 'black', fontSize: 10
    });
    scope.view.update();
    var node = nodeFor(scope, text);
    equals(node.childNodes.length, 1, 'One line, one tspan');
    text.content = 'a\nb\nc';
    scope.view.update();
    equals(node.childNodes.length, 3, 'Three lines, three tspans');
    equals(node.childNodes[2].textContent, 'c', 'In order');
    equals(node.childNodes[2].getAttribute('y'), String(text.leading * 2),
            'Each at its own leading offset');
    text.content = 'only';
    scope.view.update();
    equals(node.childNodes.length, 1, 'The surplus tspans are removed again');
    equals(node.childNodes[0].textContent, 'only', 'And the first rewritten');
    text.content = '  spaced  ';
    scope.view.update();
    equals(node.childNodes[0].getAttribute('xml:space'), 'preserve',
            'Leading and trailing spaces are preserved, not collapsed');
    equals(node.childNodes[0].textContent, '  spaced  ', 'So they survive');
    text.leading = 40;
    text.content = 'a\nb';
    scope.view.update();
    equals(node.childNodes[1].getAttribute('y'), '40',
            'A changed leading re-places the lines');
});

test('Rasters are rendered as images', function() {
    var scope = createSvgScope();
    var source = document.createElement('canvas');
    source.width = 8;
    source.height = 4;
    source.getContext('2d').fillRect(0, 0, 8, 4);
    var raster = new scope.Raster(source);
    raster.position = [50, 50];
    scope.view.update();
    var node = getItemNodes(scope, 'image')[0];
    equals(node.getAttribute('x'), '-4', 'It is placed around its own origin');
    equals(node.getAttribute('y'), '-2', 'In both directions');
    equals(node.getAttribute('width'), '8', 'At its pixel size');
    equals(node.getAttribute('height'), '4', 'In both directions');
    equals(node.getAttribute('preserveAspectRatio'), 'none',
            'Stretched into its size, the way the canvas renderer draws it');
    equals(node.getAttribute('transform'), 'matrix(1,0,0,1,50,50)',
            'And placed by its matrix');
    raster.scale(2, 1);
    scope.view.update();
    equals(node.getAttribute('transform'), 'matrix(2,0,0,1,50,50)',
            'Scaling it is a transform change, not a geometry one');
});

test('Raster#smoothing reaches the node as soon as it is set', function() {
    // Raster#setSmoothing() reports Change.ATTRIBUTE - an appearance change,
    // not a geometric one - so the attribute is written by the style pass. It
    // used to be written by the geometry pass, which attribute changes do not
    // reach, so it lagged until an unrelated move came along.
    var scope = createSvgScope();
    var source = document.createElement('canvas');
    source.width = source.height = 4;
    source.getContext('2d').fillRect(0, 0, 4, 4);
    var raster = new scope.Raster(source);
    raster.position = [50, 50];
    scope.view.update();
    var node = nodeFor(scope, raster);
    equals(node.getAttribute('image-rendering'), null,
            'The default smoothing writes nothing');
    raster.smoothing = 'off';
    scope.view.update();
    equals(node.getAttribute('image-rendering'), 'pixelated',
            'Switching it off is written straight away');
    raster.smoothing = 'low';
    scope.view.update();
    equals(node.getAttribute('image-rendering'), null,
            'And switching it back on clears it again');
    // Set before the first update, it has to be there from the start too.
    var other = new scope.Raster(source);
    other.position = [20, 20];
    other.smoothing = 'off';
    scope.view.update();
    equals(nodeFor(scope, other).getAttribute('image-rendering'), 'pixelated',
            'A raster created with it off is rendered with it off');
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

    // Nor does moving it to another parent: the node is reused, so the source
    // it has already cached is still on it.
    encodes = 0;
    var group = new scope.Group();
    group.addChild(raster);
    scope.view.update();
    equals(encodes, 0, 'And neither does reparenting it');
    raster.toDataURL = toDataURL;
    done();
});

test('A raster backed by an image keeps its own source', function(assert) {
    var done = assert.async();
    var scope = createSvgScope();
    var image = new Image();
    image.onload = function() {
        var raster = new scope.Raster(image);
        raster.position = [50, 50];
        var encodes = 0,
            toDataURL = raster.toDataURL;
        raster.toDataURL = function() {
            encodes++;
            return toDataURL.apply(this, arguments);
        };
        scope.view.update();
        var node = getItemNodes(scope, 'image')[0],
            href = node.getAttribute('href') || node.getAttributeNS(
                'http://www.w3.org/1999/xlink', 'href');
        equals(href, image.src,
                'The image\'s own src is used rather than a re-encode');
        equals(encodes, 0, 'So nothing is serialized at all');
        raster.toDataURL = toDataURL;
        done();
    };
    image.onerror = function() {
        equals(false, true, 'The test image failed to load');
        done();
    };
    image.src = 'assets/paper-js.gif';
});

test('Symbols share one definition', function() {
    var scope = createSvgScope();
    var prototype = new scope.Path.Circle({
            center: [0, 0], radius: 10, fillColor: 'red'
        }),
        definition = new scope.SymbolDefinition(prototype),
        first = new scope.SymbolItem(definition, [50, 50]),
        second = new scope.SymbolItem(definition, [100, 50]);
    scope.view.update();
    var svg = scope.view.element,
        defs = defsNode(scope);
    equals(svg.querySelectorAll('use').length, 2, 'Two placements, two <use>');
    equals(defs.childNodes.length, 1, 'Sharing one definition');
    equals(defs.firstChild.querySelectorAll('path').length, 1,
            'Which holds the definition\'s item');
    equals(nodeFor(scope, first).getAttribute('href')
            || nodeFor(scope, first).getAttributeNS(
                'http://www.w3.org/1999/xlink', 'href'),
            '#' + defs.firstChild.id, 'Both reference it by id');
    equals(nodeFor(scope, first).getAttribute('transform'),
            'matrix(1,0,0,1,50,50)', 'And are placed by their own matrix');

    // The definition's item is a live item like any other, so editing it has
    // to reach the definition node - both placements follow.
    definition.item.fillColor = 'blue';
    scope.view.update();
    equals(defs.firstChild.querySelector('path').getAttribute('fill'),
            '#0000ff', 'Editing the definition\'s item updates the definition');
    second.remove();
    scope.view.update();
    equals(svg.querySelectorAll('use').length, 1,
            'Removing one placement leaves the other');
    equals(defs.childNodes.length, 1, 'And the shared definition');
});

test('A symbol definition goes when its last placement does', function() {
    // Definitions are shared, so one can only be released when the last
    // placement using it is gone - which is what the reference counts beside
    // them are for. Without them a document that creates and discards symbols,
    // an editor with an undo stack say, grows without limit.
    var scope = createSvgScope();
    var definition = new scope.SymbolDefinition(
            new scope.Path.Circle({ center: [0, 0], radius: 10,
                fillColor: 'red' })),
        first = new scope.SymbolItem(definition, [50, 50]),
        second = new scope.SymbolItem(definition, [100, 50]);
    scope.view.update();
    var defs = defsNode(scope);
    equals(defs.childNodes.length, 1, 'One definition for both placements');
    // The layer, the two placements, and the definition's own item.
    equals(nodeCount(scope), 4, 'Whose item holds a node like any other');

    first.remove();
    scope.view.update();
    equals(defs.childNodes.length, 1,
            'Removing one placement keeps the definition for the other');
    equals(nodeCount(scope), 3, 'And only that placement\'s node goes');

    second.remove();
    scope.view.update();
    equals(defs.childNodes.length, 0,
            'Removing the last one releases the definition');
    equals(nodeCount(scope), 1, 'Along with the nodes inside it');

    // And it comes back if the same definition is placed again.
    new scope.SymbolItem(definition, [50, 50]);
    scope.view.update();
    equals(defs.childNodes.length, 1, 'Placing it again defines it again');
    equals(scope.view.element.querySelectorAll('use').length, 1,
            'With a placement referencing it');
});

test('Releasing a symbol releases what it holds', function() {
    // A definition's item is an item like any other: it can carry gradients
    // and shadows of its own, and can itself place further symbols. Releasing
    // it has to take all of that with it.
    var scope = createSvgScope();
    var inner = new scope.SymbolDefinition(
            new scope.Path.Circle({ center: [0, 0], radius: 5,
                fillColor: { gradient: { stops: ['red', 'blue'] },
                    origin: [0, 0], destination: [5, 0] } })),
        outer = new scope.SymbolDefinition(
            new scope.Group([new scope.SymbolItem(inner, [0, 0])])),
        item = new scope.SymbolItem(outer, [50, 50]);
    scope.view.update();
    var defs = defsNode(scope);
    equals(defs.querySelectorAll('linearGradient').length, 1,
            'The nested definition brought a gradient with it');
    equals(scope.view.element.querySelectorAll('use').length, 2,
            'And there are two placements, one nested in the other');

    item.remove();
    scope.view.update();
    equals(defs.childNodes.length, 0,
            'Releasing the outer definition releases the inner one too');
    equals(defs.querySelectorAll('linearGradient').length, 0,
            'And the gradient it held');
    equals(nodeCount(scope), 1, 'Leaving nothing but the layer');
});

test('A symbol placement carries none of the definition\'s style', function() {
    // Writing the merged style of a <use> would override what the definition
    // itself paints with.
    var scope = createSvgScope();
    var definition = new scope.SymbolDefinition(
            new scope.Path.Circle({ center: [0, 0], radius: 10,
                fillColor: 'red' })),
        item = new scope.SymbolItem(definition, [50, 50]);
    item.opacity = 0.5;
    item.visible = false;
    scope.view.update();
    var node = nodeFor(scope, item);
    equals(node.getAttribute('fill'), null, 'No fill is written on the <use>');
    equals(node.getAttribute('stroke'), null, 'Nor a stroke');
    equals(node.getAttribute('opacity'), '0.5',
            'But the placement\'s own opacity is');
    equals(node.getAttribute('visibility'), 'hidden', 'And its visibility');
});

// ---------------------------------------------------------------------------
// Selection overlay
// ---------------------------------------------------------------------------

test('Selections are drawn into the overlay', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Rectangle({
        point: [10, 10], size: [40, 40], fillColor: 'red'
    });
    scope.view.update();
    var overlay = overlayNode(scope);
    equals(overlay.childNodes.length, 0, 'The overlay starts out empty');
    path.selected = true;
    scope.view.update();
    equals(overlay.childNodes.length > 0, true,
            'The selection is drawn into the overlay');
    equals(contentNode(scope).querySelectorAll('*').length, 2,
            'And nothing is added to the content, layer and path aside');
    path.selected = false;
    scope.view.update();
    equals(overlay.childNodes.length, 0, 'The overlay is cleared again');
});

test('The overlay reflects every kind of selection', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Rectangle({
        point: [10, 10], size: [40, 40], fillColor: 'red'
    });
    scope.view.update();
    var overlay = overlayNode(scope);

    path.selected = true;
    scope.view.update();
    equals(overlay.childNodes.length > 0, true, 'An item selection draws');
    path.selected = false;

    path.segments[0].selected = true;
    scope.view.update();
    equals(overlay.childNodes.length > 0, true, 'A segment selection draws');
    path.fullySelected = true;
    scope.view.update();
    equals(overlay.childNodes.length > 0, true, 'And a full selection');
    path.fullySelected = false;

    path.position.selected = true;
    scope.view.update();
    equals(overlay.childNodes.length > 0, true, 'And a position selection');
    path.position.selected = false;

    path.bounds.selected = true;
    scope.view.update();
    equals(overlay.childNodes.length > 0, true, 'And a bounds selection');
    path.bounds.selected = false;
    scope.view.update();
    equals(overlay.childNodes.length, 0, 'Dropping them all clears it');
});

test('The overlay honours the selection colour', function() {
    var scope = createSvgScope();
    var path = new scope.Path.Rectangle({
        point: [10, 10], size: [40, 40], fillColor: 'red',
        selectedColor: 'red'
    });
    path.selected = true;
    scope.view.update();
    var overlay = overlayNode(scope),
        strokes = [];
    for (var i = 0; i < overlay.childNodes.length; i++) {
        var stroke = overlay.childNodes[i].getAttribute('stroke');
        if (stroke && stroke !== 'none')
            strokes.push(stroke);
    }
    equals(strokes.length > 0, true, 'Something in the overlay is stroked');
    equals(/255,\s*0,\s*0/.test(strokes[0]), true,
            'With the item\'s own selectedColor rather than the default blue');
});

test('The overlay is drawn in view coordinates', function() {
    // The overlay is not inside the content group, so the view matrix has to be
    // baked into the path data - which is what lets handles stay the same size
    // at any zoom, exactly as the canvas renderer draws them.
    var scope = createSvgScope();
    var path = new scope.Path.Rectangle({
        point: [10, 10], size: [40, 40], fillColor: 'red'
    });
    path.selected = true;
    scope.view.update();
    var overlay = overlayNode(scope),
        before = overlay.firstChild.getAttribute('d');
    equals(overlay.parentNode, scope.view.element,
            'The overlay is a sibling of the content group');
    equals(overlay.getAttribute('transform'), null,
            'And carries no transform of its own');
    scope.view.zoom = 2;
    scope.view.update();
    equals(overlay.firstChild.getAttribute('d') !== before, true,
            'Zooming redraws the overlay rather than scaling it');
    equals(overlay.getAttribute('pointer-events'), 'none',
            'And it never swallows a pointer event');
});

test('The overlay follows the items it belongs to', function() {
    var scope = createSvgScope();
    var group = new scope.Group([
            new scope.Path.Rectangle({ point: [10, 10], size: [40, 40],
                fillColor: 'red' })
        ]),
        path = group.firstChild;
    path.selected = true;
    scope.view.update();
    var overlay = overlayNode(scope),
        before = overlay.firstChild.getAttribute('d');
    group.translate(20, 0);
    scope.view.update();
    equals(overlay.firstChild.getAttribute('d') !== before, true,
            'Moving the parent moves the handles');

    // A selected item in a hidden layer is not drawn, so neither is its
    // selection - which is what Item#_isUpdated() decides for both renderers.
    scope.project.activeLayer.visible = false;
    scope.view.update();
    equals(overlay.childNodes.length, 0, 'A hidden layer hides the selection');
    scope.project.activeLayer.visible = true;
    scope.view.update();
    equals(overlay.childNodes.length > 0, true, 'Showing it brings it back');

    path.remove();
    scope.view.update();
    equals(overlay.childNodes.length, 0,
            'Removing a selected item clears the overlay');
});

test('The handle size setting reaches the overlay', function() {
    var small = createSvgScope();
    small.settings.handleSize = 4;
    var a = new small.Path.Rectangle({ point: [10, 10], size: [40, 40] });
    a.fullySelected = true;
    small.view.update();
    var smallData = overlayData(small);

    var large = createSvgScope();
    large.settings.handleSize = 12;
    var b = new large.Path.Rectangle({ point: [10, 10], size: [40, 40] });
    b.fullySelected = true;
    large.view.update();
    var largeData = overlayData(large);
    equals(smallData !== largeData, true,
            'A different handleSize draws different handles');
    equals(largeData.length > smallData.length, true,
            'Bigger handles take more path data to describe');
});

// ---------------------------------------------------------------------------
// Interop: the rest of Paper.js does not know which renderer is in use
// ---------------------------------------------------------------------------

test('Hit-testing is renderer independent', function() {
    function build(scope) {
        scope.activate();
        return new scope.Path.Circle({
            center: [50, 50], radius: 20, fillColor: 'red',
            strokeColor: 'black', strokeWidth: 4
        });
    }
    var canvas = createScope('canvas'),
        canvasPath = build(canvas),
        svg = createScope('svg'),
        svgPath = build(svg);
    canvas.view.update();
    svg.view.update();
    var points = [[50, 50], [5, 5], [30, 50], [70, 50]];
    for (var i = 0; i < points.length; i++) {
        var point = points[i],
            a = canvas.project.hitTest(new canvas.Point(point)),
            b = svg.project.hitTest(new svg.Point(point));
        equals(!!b, !!a,
                'hitTest(' + point + ') agrees between the renderers');
        if (a && b)
            equals(b.type, a.type, 'And reports the same hit type');
    }
    equals(svgPath.bounds.toString(), canvasPath.bounds.toString(),
            'Bounds do not depend on the renderer either');
});

test('Pointer events reach the <svg> element', function() {
    // Hit-testing goes through Project#hitTest() in both renderers, so the
    // item nodes must never take a pointer event - the element View binds its
    // handlers to has to be the one that receives them.
    var scope = createSvgScope();
    new scope.Path.Rectangle({ point: [0, 0], size: [200, 200],
            fillColor: 'red' });
    scope.view.update();
    equals(contentNode(scope).getAttribute('pointer-events'), 'none',
            'The content group is transparent to pointer events');
    equals(overlayNode(scope).getAttribute('pointer-events'), 'none',
            'And so is the overlay');
    equals(scope.view.element.getAttribute('pointer-events'), null,
            'While the <svg> itself takes them');
});

test('rasterize() works under the SVG renderer', function() {
    // It makes its own canvas either way, which is what keeps thumbnails and
    // pixel readback working for an app that switched renderer.
    var scope = createSvgScope();
    var path = new scope.Path.Circle({
        center: [50, 50], radius: 20, fillColor: 'red'
    });
    scope.view.update();
    var raster = path.rasterize({ resolution: 72 });
    equals(raster._class, 'Raster', 'It produces a Raster');
    equals(raster.size.toString(), new paper.Size(40, 40).toString(),
            'At the item\'s own size');
    equals(raster.getPixel(20, 20).toCSS(true), '#ff0000',
            'With the item drawn into it');
});

test('importSVG and exportSVG are unaffected', function() {
    var scope = createSvgScope();
    var imported = scope.project.importSVG(
            '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<rect x="5" y="5" width="20" height="10" fill="#00ff00"/>'
            + '</svg>');
    scope.view.update();
    equals(imported != null, true, 'The markup imported');
    var nodes = getItemNodes(scope, 'rect,path');
    equals(nodes.length, 1, 'And is rendered as one node');
    equals(nodes[0].getAttribute('fill'), '#00ff00', 'With its own fill');
    var exported = scope.project.exportSVG({ asString: true });
    equals(/^<svg/.test(exported), true, 'Exporting still produces markup');
    equals(/#00ff00/.test(exported), true, 'Holding the imported item');
});

test('Serializing a project does not mention the renderer', function() {
    var scope = createSvgScope();
    new scope.Path.Circle({ center: [50, 50], radius: 20, fillColor: 'red' });
    scope.view.update();
    var json = scope.project.exportJSON();
    equals(/SvgView|renderer/.test(json), false,
            'The renderer is configuration, not document content');
    var other = createScope('canvas');
    other.project.importJSON(json);
    equals(other.project.activeLayer.children.length, 1,
            'So a project moves between renderers unchanged');
});

// ---------------------------------------------------------------------------
// Known divergences from the canvas renderer
//
// These tests pin behaviour that does NOT match CanvasView, so that the
// difference is executable rather than folklore. Each one names the entry in
// test/FINDINGS-svg-renderer.md that explains it. When one is fixed, its
// assertion here is what has to be turned around - a red test in this module
// means the gap closed, not that something broke.
// ---------------------------------------------------------------------------

QUnit.module('SvgView divergences', { teardown: svgViewTeardown });

test('GAP 7: a singular matrix is written out rather than skipped', function() {
    // Item#draw() bails on a non-invertible global matrix. The renderer writes
    // the matrix as it is; browsers do not render an element under a singular
    // transform, so the two agree on screen - but the node, its definitions and
    // its subtree stay live, where canvas does no work at all.
    var scope = createSvgScope();
    var path = new scope.Path.Rectangle({
        point: [10, 10], size: [20, 20], fillColor: 'red', applyMatrix: false
    });
    path.matrix = new scope.Matrix(1, 0, 2, 0, 0, 0);
    scope.view.update();
    var node = nodeFor(scope, path);
    equals(!path.matrix.isInvertible(), true, 'The matrix collapses the item');
    equals(node.getAttribute('transform'), 'matrix(1,0,2,0,0,0)',
            'GAP: which is written to the node as it is');
    equals(node.getAttribute('visibility'), null,
            'GAP: and the node is left in the tree, not skipped');
});

test('GAP 8: SvgView has no getContext()', function() {
    // CanvasView#getContext() is public API that an application reaching for
    // the 2D context uses directly. There is no SVG equivalent, so code doing
    // that has to go through Item#rasterize() instead.
    var svg = createScope('svg'),
        canvas = createScope('canvas');
    equals(typeof canvas.view.getContext, 'function',
            'The canvas renderer exposes its context');
    equals(typeof svg.view.getContext, 'undefined',
            'GAP: the SVG one has nothing to expose');
    equals(typeof svg.view.getElement, 'function',
            'View#element is what both have in common');
});
