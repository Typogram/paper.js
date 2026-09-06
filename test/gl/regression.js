// Renders every scene through the *canvas* renderer using two different
// builds and requires the results to be identical, pixel for pixel.
//
// The library's own QUnit suite (test/index.html) does not run under modern
// Chromium on this commit — it fails the same way on unmodified HEAD — so this
// stands in as the guard that adding the GPU backend left the default
// rendering path untouched.
//
//   node test/gl/regression.js <baseline-bundle> [<candidate-bundle>]
var path = require('path'),
    { chromium } = require('playwright');

(async function() {
    var baseline = path.resolve(process.argv[2]),
        candidate = path.resolve(process.argv[3]
            || path.join(__dirname, '..', '..', 'dist', 'paper-gl.js')),
        browser = await chromium.launch({
            executablePath: process.env.CHROMIUM_PATH
                || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
            args: ['--use-gl=angle', '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader']
        }),
        page = await browser.newPage(),
        base = 'file://' + path.resolve(__dirname, 'compare.html');

    async function capture(bundle, name) {
        await page.goto(base + '?bundle=' + encodeURIComponent(
                'file://' + bundle));
        return await page.evaluate(function(name) {
            // Only the 2D canvas matters here; both builds must agree on it.
            return window.renderAndRead(name)[0];
        }, name);
    }

    await page.goto(base + '?bundle=' + encodeURIComponent(
            'file://' + candidate));
    var sceneNames = await page.evaluate('Object.keys(scenes)'),
        failures = [];
    for (var i = 0; i < sceneNames.length; i++) {
        var name = sceneNames[i],
            before = await capture(baseline, name),
            after = await capture(candidate, name),
            differing = 0;
        for (var j = 0; j < before.length; j++) {
            if (before[j] !== after[j])
                differing++;
        }
        if (differing)
            failures.push(name);
        console.log((differing ? 'FAIL ' : 'ok   ') + name.padEnd(18)
                + (differing ? differing + ' channel values differ'
                    : 'identical'));
    }
    await browser.close();
    console.log('\n' + (sceneNames.length - failures.length) + '/'
            + sceneNames.length + ' scenes unchanged on the canvas renderer');
    process.exit(failures.length ? 1 : 0);
})();
