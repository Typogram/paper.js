// Runs the library's own QUnit suite (test/index.html) in headless Chromium,
// so that changes to the shared code paths can be checked against the existing
// behaviour of the default canvas renderer.
//
//   node test/gl/qunit.js
var path = require('path'),
    { chromium } = require('playwright');

(async function() {
    var browser = await chromium.launch({
            executablePath: process.env.CHROMIUM_PATH
                || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
            args: [
                '--use-gl=angle',
                '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader',
                '--allow-file-access-from-files'
            ]
        }),
        page = await browser.newPage(),
        errors = [];
    page.on('pageerror', function(error) {
        errors.push(error.message);
    });
    await page.goto('file://'
            + path.resolve(__dirname, '..', 'index.html'));
    // The suite loads its sources through Prepro at runtime, so give it room.
    await page.waitForFunction(
            'document.getElementById("qunit-testresult") && '
            + '/completed|Tests completed/.test('
            + 'document.getElementById("qunit-testresult").textContent)',
            { timeout: 600000 });
    var result = await page.evaluate(function() {
        var failed = [];
        Array.prototype.forEach.call(
                document.querySelectorAll('#qunit-tests > li.fail'),
                function(item) {
                    var name = item.querySelector('.test-name'),
                        module = item.querySelector('.module-name');
                    failed.push((module ? module.textContent + ': ' : '')
                            + (name ? name.textContent : '?'));
                });
        return {
            summary: document.getElementById('qunit-testresult').textContent,
            failed: failed
        };
    });
    console.log(result.summary);
    if (result.failed.length) {
        console.log('\nfailed tests:');
        result.failed.slice(0, 40).forEach(function(name) {
            console.log('  ' + name);
        });
        if (result.failed.length > 40)
            console.log('  ... and ' + (result.failed.length - 40) + ' more');
    }
    if (errors.length) {
        console.log('\npage errors:');
        errors.slice(0, 10).forEach(function(error) {
            console.log('  ' + error);
        });
    }
    await browser.close();
    process.exit(result.failed.length ? 1 : 0);
})();
