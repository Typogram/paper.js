// Minimal stand-in for `gulp build`, which does not run under modern Node.
// Builds src/paper.js through the same Prepro.js setup as gulp/tasks/build.js.
//
//   node tools/build.js          -> dist/paper-full.js (the package's `main`)
//   node tools/build.js --core   -> dist/paper-core.js (without PaperScript)
//   node tools/build.js --out some/other/path.js
//
// On this branch the resulting bundles are committed, so that the fork can be
// installed straight from git (`npm i github:Typogram/paper.js#branch`) with no
// build step. On `develop` those same paths are symlinks to src/load.js - the
// development loader, which pulls sources in at runtime through Prepro and
// document.write and cannot be bundled - so re-run this after changing src/.
var fs = require('fs'),
    path = require('path'),
    Prepro = require('prepro'),
    options = require('../src/options.js');

var argv = process.argv.slice(2),
    outIndex = argv.indexOf('--out'),
    core = argv.indexOf('--core') !== -1,
    out = outIndex !== -1 && argv[outIndex + 1]
        || (core ? 'dist/paper-core.js' : 'dist/paper-full.js');

var prepro = new Prepro();
prepro.evaluate(path.resolve(__dirname, '../src/constants.js'));
prepro.setup(function() {
    return {
        __options: Object.assign({}, options, { paperScript: !core })
    };
});
var output = prepro.process(path.resolve(__dirname, '../src/paper.js')),
    file = path.resolve(__dirname, '..', out),
    dir = path.dirname(file);
if (!fs.existsSync(dir))
    fs.mkdirSync(dir, { recursive: true });
// Remove any existing entry first: dist/paper-full.js and dist/paper-core.js
// are committed as symlinks to src/load.js, and writing through one of those
// would overwrite that source file rather than replace the link.
try {
    if (fs.lstatSync(file).isSymbolicLink())
        fs.unlinkSync(file);
} catch (e) {}
fs.writeFileSync(file, output);
console.log(out + ': ' + output.length + ' bytes');
