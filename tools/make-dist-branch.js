// Regenerates the `dist` branch: the built package and nothing else.
//
//   node tools/make-dist-branch.js
//   node tools/make-dist-branch.js --branch some-other-name
//
// The fork cannot be installed as a git dependency from a source branch. npm
// installs a git dependency's dependencies AND devDependencies and runs its
// prepare before packing it, whatever the package needs - and paper.js's
// devDependencies include canvas and resemblejs, which build native binaries.
// The install dies there, --ignore-scripts does not survive into the lockfile,
// and consumers cannot set it project-wide without breaking their own
// dependencies' install scripts.
//
// So this writes a branch whose package.json has no devDependencies, no
// workspaces and no scripts: nothing for npm to install or run, leaving it
// nothing to do but pack dist/. An app then installs the fork with
//
//   npm i github:Typogram/paper.js#dist-only
//
// The branch is built with git plumbing, against a temporary index, so it never
// touches the working tree or the checked-out branch. Each commit records the
// source commit it was built from, and the previous tip is kept as its parent,
// so the branch has a history and fast-forwards for anyone who installed it.
//
// Re-run after changing anything under src/, then push the branch.

var fs = require('fs'),
    os = require('os'),
    path = require('path'),
    execFileSync = require('child_process').execFileSync;

var ROOT = path.resolve(__dirname, '..'),
    argv = process.argv.slice(2),
    branchIndex = argv.indexOf('--branch'),
    // Not 'dist': that collides with the dist/ directory, and every
    // `git log dist` would need disambiguating.
    BRANCH = branchIndex !== -1 && argv[branchIndex + 1] || 'dist-only';

function git(args, options) {
    return execFileSync('git', args, Object.assign({
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 1 << 28
    }, options)).trim();
}

// The bundles are what this branch exists to ship, so always build them fresh
// rather than trusting whatever is in dist/ right now.
execFileSync(process.execPath, [path.join(__dirname, 'build.js')],
        { cwd: ROOT, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(__dirname, 'build.js'), '--core'],
        { cwd: ROOT, stdio: 'inherit' });

var source = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Only what describes the package. No scripts, devDependencies or workspaces:
// their absence is the entire point of the branch.
var pkg = {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    homepage: source.homepage,
    repository: source.repository,
    bugs: source.bugs,
    contributors: source.contributors,
    main: source.main,
    types: source.types,
    browser: source.browser,
    engines: source.engines,
    files: ['dist/', 'LICENSE.txt', 'README.md']
};

function collect(rel) {
    var abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs))
        return [];
    if (fs.statSync(abs).isDirectory()) {
        return fs.readdirSync(abs).reduce(function(all, entry) {
            return all.concat(collect(path.join(rel, entry)));
        }, []);
    }
    return [rel];
}

var files = collect('dist').filter(function(rel) {
    // Packing rules that apply to the source branch's dist/, kept here so the
    // branch ships the same thing `npm pack` would have.
    return !/(^|\/)\.npmignore$/.test(rel) && !/\.min\.js$/.test(rel);
});

// site/README.md is written as the package's readme - what someone installing
// it should read - rather than paper.js's own project readme. It documents the
// published @typogram/paper.js, though, so say up front what this branch is and
// how it is installed and imported, which differ.
var readme = fs.existsSync(path.join(ROOT, 'site/README.md'))
    ? 'site/README.md' : 'README.md',
    preamble = [
        '<!-- Generated branch. Do not edit: see tools/make-dist-branch.js. -->',
        '',
        '> **This branch is the built package and nothing else**, so that the',
        '> fork can be installed straight from git:',
        '>',
        '> ```sh',
        '> npm i github:Typogram/paper.js#' + BRANCH,
        '> ```',
        '>',
        '> It installs under the name `paper`, so it is imported as',
        '> `import paper from \'paper\'` and drops into an app already using',
        '> upstream Paper.js with no other change. The rest of this readme',
        '> describes the same library published as `@typogram/paper.js`.',
        '',
        ''
    ].join('\n');

var index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'paper-dist-')),
        'index'),
    env = Object.assign({}, process.env, { GIT_INDEX_FILE: index });

function add(repoPath, contents) {
    var hash = contents == null
        ? git(['hash-object', '-w', '--', repoPath])
        : git(['hash-object', '-w', '--stdin'], { input: contents });
    var mode = contents == null
            && (fs.statSync(path.join(ROOT, repoPath)).mode & 0o111)
        ? '100755' : '100644';
    git(['update-index', '--add', '--cacheinfo',
            mode + ',' + hash + ',' + repoPath], { env: env });
}

files.forEach(function(rel) { add(rel, null); });
add('LICENSE.txt', null);
add('README.md', preamble + fs.readFileSync(path.join(ROOT, readme), 'utf8'));
add('package.json', JSON.stringify(pkg, null, 2) + '\n');

var tree = git(['write-tree'], { env: env }),
    head = git(['rev-parse', 'HEAD']),
    subject = git(['log', '-1', '--format=%s', 'HEAD']),
    parents = [];
try {
    parents = ['-p', git(['rev-parse', '--verify', 'refs/heads/' + BRANCH],
            { stdio: ['pipe', 'pipe', 'ignore'] })];
} catch (e) {
    // First time: the branch starts here.
}

var message = 'Build ' + head.slice(0, 8) + '\n\n'
        + subject + '\n\n'
        + 'Generated by tools/make-dist-branch.js. Everything here is built\n'
        + 'output; edit src/ on the source branch and re-run it.\n',
    commit = git(['commit-tree', tree].concat(parents), { input: message });

git(['update-ref', 'refs/heads/' + BRANCH, commit]);
fs.rmSync(path.dirname(index), { recursive: true, force: true });

console.log(BRANCH + ' -> ' + commit.slice(0, 8) + ' ('
        + (files.length + 3) + ' files, from ' + head.slice(0, 8) + ')');
