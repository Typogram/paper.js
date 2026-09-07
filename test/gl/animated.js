// Renders an *animated* scene through both renderers and diffs the final
// frame. The static scenes in run.js cannot catch a stale geometry cache:
// they draw one frame, so cached and uncached tessellation agree trivially.
// This drives several frames of per-item transforms first, which is exactly
// where a cache keyed on a stale invalidation signal goes wrong.
//
//   node test/gl/animated.js
var path = require('path'),
    { chromium } = require('playwright');

var CHANNEL_TOLERANCE = 24,
    MAX_DIFF_RATIO = 0.035,
    FRAMES = 12;

function compare(a, b) {
    var differing = 0;
    for (var i = 0; i < a.length; i += 4) {
        var delta = 0;
        for (var j = 0; j < 4; j++)
            delta = Math.max(delta, Math.abs(a[i + j] - b[i + j]));
        if (delta > CHANNEL_TOLERANCE)
            differing++;
    }
    return differing / (a.length / 4);
}

(async function() {
    var browser = await chromium.launch({
            executablePath: process.env.CHROMIUM_PATH
                || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
            args: ['--use-gl=angle', '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader']
        }),
        page = await browser.newPage(),
        failures = [];
    page.on('pageerror', function(error) {
        console.log('pageerror: ' + error.message);
    });
    await page.goto('file://' + path.resolve(__dirname, 'animated.html'));

    // Both applyMatrix modes matter: with it on, Paper.js rewrites the
    // segments in place on every transform, so any geometry cache has to
    // notice. With it off, the item keeps a matrix and the geometry is
    // genuinely reusable.
    for (var m = 0; m < 2; m++) {
        var applyMatrix = m === 0;
        for (var k = 0; k < 2; k++) {
            var kind = ['fill', 'stroke'][k],
                pixels = await page.evaluate(function(args) {
                    return window.renderAnimated(args[0], args[1], args[2]);
                }, [kind, applyMatrix, FRAMES]),
                ratio = compare(pixels[0], pixels[1]),
                ok = ratio <= MAX_DIFF_RATIO,
                label = kind + ' applyMatrix=' + applyMatrix;
            if (!ok)
                failures.push(label);
            console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(28)
                    + (ratio * 100).toFixed(2).padStart(6) + '% of pixels differ');
        }
    }
    await browser.close();
    console.log('\n' + (4 - failures.length) + '/4 animated scenes match');
    process.exit(failures.length ? 1 : 0);
})();
