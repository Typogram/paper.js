// Minimal stand-in for `gulp build`, which does not run under modern Node.
// Produces dist/paper-gl.js from src/paper.js using the same Prepro.js setup as
// gulp/tasks/build.js.
//
// Note the output name: `gulp load` symlinks dist/paper-full.js to src/load.js
// for development, so writing there would follow the symlink and overwrite that
// source file.
var fs = require('fs'),
    path = require('path'),
    Prepro = require('prepro'),
    options = require('../src/options.js');

var prepro = new Prepro();
prepro.evaluate(path.resolve(__dirname, '../src/constants.js'));
prepro.setup(function() {
    return {
        __options: Object.assign({}, options, { paperScript: true })
    };
});
var output = prepro.process(path.resolve(__dirname, '../src/paper.js')),
    dir = path.resolve(__dirname, '..', 'dist'),
    file = path.join(dir, 'paper-gl.js');
if (!fs.existsSync(dir))
    fs.mkdirSync(dir);
fs.writeFileSync(file, output);
console.log('dist/paper-gl.js: ' + output.length + ' bytes');
