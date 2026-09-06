// Times the canvas and GL renderers against each other over a range of item
// counts. Run before deciding whether to invest in the later phases: the GPU
// backend only earns its complexity where it is actually faster.
//
// Note that headless Chromium here runs WebGL through SwiftShader, a software
// rasterizer, so the GL numbers are a floor and not representative of real
// hardware. Compare shapes of curves, not absolute values.
//
//   node test/gl/bench.js
var path = require('path'),
    { chromium } = require('playwright');

var COUNTS = {
        circle: [100, 500, 2000, 8000],
        // Stroke expansion is CPU work on top of the draw calls, so keep the
        // counts lower or a single measurement runs into minutes.
        stroke: [100, 500, 2000]
    },
    FRAMES = 30;

(async function() {
    var browser = await chromium.launch({
            executablePath: process.env.CHROMIUM_PATH
                || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
            args: ['--use-gl=angle', '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader']
        }),
        page = await browser.newPage(),
        url = 'file://' + path.resolve(__dirname, 'bench.html');
    // Software-rasterized WebGL makes the slow cases very slow indeed.
    page.setDefaultTimeout(600000);
    page.setDefaultNavigationTimeout(600000);
    page.on('pageerror', function(error) {
        console.log('pageerror: ' + error.message);
    });

    for (var k = 0; k < 2; k++) {
        var kind = ['circle', 'stroke'][k];
        console.log('\n' + kind + ' items, ' + FRAMES
                + ' full redraws per measurement');
        console.log('  items    canvas       webgl     ratio');
        var counts = COUNTS[kind];
        for (var i = 0; i < counts.length; i++) {
            var count = counts[i],
                results = {};
            for (var r = 0; r < 2; r++) {
                var renderer = ['canvas', 'webgl'][r];
                await page.goto(url);
                results[renderer] = await page.evaluate(function(args) {
                    return window.bench(args[0], args[1], args[2], args[3]);
                }, [renderer, count, FRAMES, kind]);
            }
            if (results.canvas.error || results.webgl.error) {
                console.log('  ' + count + ' error: '
                        + (results.canvas.error || results.webgl.error));
                continue;
            }
            var a = results.canvas.perFrame,
                b = results.webgl.perFrame;
            console.log('  ' + String(count).padStart(5)
                    + (a.toFixed(2) + ' ms').padStart(11)
                    + (b.toFixed(2) + ' ms').padStart(12)
                    + ((a / b).toFixed(2) + 'x').padStart(10));
        }
    }
    await browser.close();
})();
