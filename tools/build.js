// Builds src/paper.js the way `gulp build` does, without gulp.
//
//   node tools/build.js          -> dist/paper-full.js (the package's `main`)
//   node tools/build.js --core   -> dist/paper-core.js (without PaperScript)
//   node tools/build.js --out some/other/path.js
//
// `gulp build` itself does still run under modern Node, as long as the tree was
// installed with yarn: gulp 3 pulls in graceful-fs 3, which monkey-patches
// internals removed in Node 12, and package.json pins it back to 4.2.2 through
// yarn's `resolutions`. npm ignores `resolutions`, so an npm-installed tree
// gets graceful-fs 3 and gulp dies on `primordials is not defined`. This script
// avoids the question, and needs `prepro` rather than the whole gulp chain.
//
// It runs the same three steps gulp/tasks/build.js does - prepro, uncomment,
// whitespace - so the output matches what upstream publishes. Skipping the last
// two leaves every JSDoc block in the bundle, which is a 3x difference: 1.36MB
// against 475KB, and 318KB against 122KB gzipped.
//
// One deliberate difference: gulp/utils/options.js appends the branch name to
// the version for any branch but master, so `gulp build` stamps the banner
// `0.12.18-<branch>` and relies on its publish task to undo that. Here the
// banner stays at the plain version, which is what the dist-only package.json
// declares.
//
// On this branch the resulting bundles are committed, so that the fork can be
// installed straight from git (`npm i github:Typogram/paper.js#branch`) with no
// build step. On `develop` those same paths are symlinks to src/load.js - the
// development loader, which pulls sources in at runtime through Prepro and
// document.write and cannot be bundled - so re-run this after changing src/.
var fs = require('fs'),
    path = require('path'),
    Prepro = require('prepro'),
    uncomment = require('uncomment'),
    options = require('../src/options.js');

// What gulp-whitespace does with the options gulp/tasks/build.js passes it
// ({ spacesToTabs: 4, removeTrailing: true }), inlined so this does not need
// the plugin - it is a gulp stream wrapper around exactly these two replaces.
function whitespace(str) {
    return str
        .replace(/^((?: {4})+)/gm, function(all, spaces) {
            return new Array(spaces.length / 4 + 1).join('\t');
        })
        .replace(/[ \t]+$/gm, '');
}

var argv = process.argv.slice(2),
    outIndex = argv.indexOf('--out'),
    core = argv.indexOf('--core') !== -1,
    out = outIndex !== -1 && argv[outIndex + 1]
        || (core ? 'dist/paper-core.js' : 'dist/paper-full.js');

// src/options.js carries no date - gulp/utils/options.js fills it in from the
// last commit, and without it the banner reads `Date: undefined`.
//
// Taken from the last commit that touched src/, rather than the last commit
// outright as gulp does. The bundles are committed on this branch, so a banner
// tracking every commit would leave dist/ dirty after any docs or tooling
// change, and the date means the same thing either way: when these sources
// last moved.
var date;
try {
    date = require('child_process')
            .execSync('git log -1 --pretty=format:%ad -- src/',
                { cwd: path.resolve(__dirname, '..') })
            .toString().trim();
} catch (e) {}

var prepro = new Prepro();
prepro.evaluate(path.resolve(__dirname, '../src/constants.js'));
prepro.setup(function() {
    return {
        __options: Object.assign({}, options, {
            paperScript: !core,
            date: date || options.date
        })
    };
});
// The same pipeline as gulp/tasks/build.js: prepro -> uncomment -> whitespace.
var output = whitespace(uncomment(
        prepro.process(path.resolve(__dirname, '../src/paper.js')),
        { mergeEmptyLines: true })),
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

// The bundle requires './node/extend.js' relative to itself when it runs on
// Node, so the package is broken there without these. This is what the
// `build:copy` gulp task does.
if (outIndex === -1) {
    var nodeSrc = path.resolve(__dirname, '../src/node'),
        nodeDir = path.resolve(path.dirname(file), 'node');
    if (!fs.existsSync(nodeDir))
        fs.mkdirSync(nodeDir, { recursive: true });
    fs.readdirSync(nodeSrc).filter(function(name) {
        return /\.js$/.test(name);
    }).forEach(function(name) {
        fs.copyFileSync(path.resolve(nodeSrc, name),
                path.resolve(nodeDir, name));
        console.log('dist/node/' + name);
    });
}
