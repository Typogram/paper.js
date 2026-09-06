// Renders each scene in test/gl/compare.html through both the canvas and the
// GL renderer and reports how far apart they are. This is the ruler the GPU
// backend is built against: fidelity, not speed, is the risk.
//
//   node test/gl/run.js [--write-images]
var path = require('path'),
    fs = require('fs'),
    { chromium } = require('playwright');

// Per-channel difference below which two pixels count as equal. Antialiasing
// will never match Canvas2D exactly, so the interesting number is the share of
// pixels that differ, not whether any do.
var CHANNEL_TOLERANCE = 24,
    // Share of differing pixels a scene may have before it is reported failed.
    MAX_DIFF_RATIO = 0.035;

function compare(a, b) {
    var differing = 0,
        opaque = 0,
        maxDelta = 0;
    for (var i = 0; i < a.length; i += 4) {
        var delta = 0;
        for (var j = 0; j < 4; j++)
            delta = Math.max(delta, Math.abs(a[i + j] - b[i + j]));
        if (a[i + 3] > 8 || b[i + 3] > 8)
            opaque++;
        if (delta > CHANNEL_TOLERANCE)
            differing++;
        maxDelta = Math.max(maxDelta, delta);
    }
    return {
        differing: differing,
        total: a.length / 4,
        opaque: opaque,
        maxDelta: maxDelta,
        ratio: differing / (a.length / 4)
    };
}

(async function() {
    var writeImages = process.argv.indexOf('--write-images') !== -1,
        browser = await chromium.launch({
            // Pinned to the Chromium already present in this environment,
            // which may not match the version the npm package expects.
            executablePath: process.env.CHROMIUM_PATH
                || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
            args: [
                // Headless Chromium needs a software GL implementation.
                '--use-gl=angle',
                '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader'
            ]
        }),
        page = await browser.newPage(),
        messages = [];
    page.on('console', function(message) {
        messages.push(message.type() + ': ' + message.text());
    });
    page.on('pageerror', function(error) {
        messages.push('pageerror: ' + error.message);
    });
    await page.goto('file://' + path.resolve(__dirname, 'compare.html'));

    var renderers = await page.evaluate(function() {
        // Force one render so the views exist, then report what they are.
        window.runScene('fill');
        return [window.rendererOf('canvas2d'), window.rendererOf('canvasgl')];
    });
    console.log('renderers:', renderers.join(' / '));
    if (renderers[1] !== 'GLView') {
        console.error('FAIL: the GL canvas did not get a GLView. Messages:');
        messages.forEach(function(m) { console.error('  ' + m); });
        await browser.close();
        process.exit(1);
    }

    var sceneNames = await page.evaluate('Object.keys(scenes)'),
        failures = [];
    for (var i = 0; i < sceneNames.length; i++) {
        var name = sceneNames[i];
        // Reload for each scene so scopes never interfere with one another.
        await page.goto('file://' + path.resolve(__dirname, 'compare.html'));
        var pixels = await page.evaluate(function(name) {
                return window.renderAndRead(name);
            }, name),
            result = compare(pixels[0], pixels[1]),
            percent = (result.ratio * 100).toFixed(2),
            ok = result.ratio <= MAX_DIFF_RATIO;
        if (!ok)
            failures.push(name);
        console.log((ok ? 'ok   ' : 'FAIL ') + name.padEnd(16)
                + percent.padStart(6) + '% of pixels differ'
                + '   (max channel delta ' + result.maxDelta + ')');
        if (writeImages) {
            var dir = path.resolve(__dirname, 'output');
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir);
            await page.locator('#canvas2d').screenshot(
                    { path: path.join(dir, name + '-canvas.png') });
            await page.locator('#canvasgl').screenshot(
                    { path: path.join(dir, name + '-gl.png') });
        }
    }

    if (messages.length) {
        console.log('\nbrowser messages:');
        messages.forEach(function(m) { console.log('  ' + m); });
    }
    await browser.close();
    console.log('\n' + (sceneNames.length - failures.length) + '/'
            + sceneNames.length + ' scenes within tolerance');
    if (failures.length)
        console.log('failed: ' + failures.join(', '));
    process.exit(failures.length ? 1 : 0);
})();
