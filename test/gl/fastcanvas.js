// Verifies FastCanvasView (the "9a/9b" Canvas2D optimizations - a
// pre-rendered pan buffer plus a spatial-grid-accelerated cull check)
// against plain CanvasView, step by step through the transitions that
// matter: a small pan (expected to blit), a big pan (expected to exceed the
// buffer's margin and fall back to a real, re-centered redraw), and a zoom
// (always a real redraw). Each step's pixels are compared, not just its
// "blit or redraw" label, so a wrong buffer offset or a grid that silently
// drops items would show up here.
//
//   node test/gl/fastcanvas.js [--write-images]
var path = require('path'),
    fs = require('fs'),
    { chromium } = require('playwright');

var CHANNEL_TOLERANCE = 24,
    MAX_DIFF_RATIO = 0.035;

function compare(a, b) {
    var differing = 0, maxDelta = 0;
    for (var i = 0; i < a.length; i += 4) {
        var delta = 0;
        for (var j = 0; j < 4; j++)
            delta = Math.max(delta, Math.abs(a[i + j] - b[i + j]));
        if (delta > CHANNEL_TOLERANCE)
            differing++;
        maxDelta = Math.max(maxDelta, delta);
    }
    return { ratio: differing / (a.length / 4), maxDelta: maxDelta };
}

(async function() {
    var writeImages = process.argv.indexOf('--write-images') !== -1,
        browser = await chromium.launch({
            executablePath: process.env.CHROMIUM_PATH
                || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
            args: ['--use-gl=angle', '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader']
        }),
        page = await browser.newPage(),
        messages = [];
    page.on('console', function(m) { messages.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', function(e) { messages.push('pageerror: ' + e.message); });
    await page.goto('file://' + path.resolve(__dirname, 'fastcanvas.html'));

    // step -> [expected wasBlit, description]
    var steps = [
        ['initial', false, 'first frame - always a real redraw'],
        ['smallPan', true, 'small pan - within the pre-rendered margin'],
        ['bigPan', false, 'big pan - past the margin, forces a redraw'],
        ['zoom', false, 'zoom - always a redraw, never a blit']
    ];

    var failures = [];
    for (var i = 0; i < steps.length; i++) {
        var name = steps[i][0], expectBlit = steps[i][1], desc = steps[i][2],
            result = await page.evaluate(function(step) {
                return window.runStep(step);
            }, name),
            diff = compare(result.pixels[0], result.pixels[1]),
            percent = (diff.ratio * 100).toFixed(2),
            pixelsOk = diff.ratio <= MAX_DIFF_RATIO,
            blitOk = result.wasBlit === expectBlit,
            ok = pixelsOk && blitOk;
        if (!ok)
            failures.push(name);
        console.log((ok ? 'ok   ' : 'FAIL ') + name.padEnd(10)
                + percent.padStart(6) + '% of pixels differ'
                + '   mode=' + (result.wasBlit ? 'blit' : 'redraw')
                + (blitOk ? '' : ' (expected '
                    + (expectBlit ? 'blit' : 'redraw') + ')')
                + '   indexed=' + result.indexed
                + '   - ' + desc);
        if (writeImages) {
            var dir = path.resolve(__dirname, 'output');
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir);
            await page.locator('#stock').screenshot(
                    { path: path.join(dir, 'fastcanvas-' + name + '-stock.png') });
            await page.locator('#fast').screenshot(
                    { path: path.join(dir, 'fastcanvas-' + name + '-fast.png') });
        }
    }

    if (messages.length) {
        console.log('\nbrowser messages:');
        messages.forEach(function(m) { console.log('  ' + m); });
    }
    await browser.close();
    console.log('\n' + (steps.length - failures.length) + '/' + steps.length
            + ' steps within tolerance');
    if (failures.length)
        console.log('failed: ' + failures.join(', '));
    process.exit(failures.length ? 1 : 0);
})();
