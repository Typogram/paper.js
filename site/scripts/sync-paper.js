// Generates src/lib from the library build one directory up, so the package
// ships exactly the bundle this repository produces.
//
//   src/lib/index.js    the UMD bundle plus an ESM default export
//   src/lib/index.d.ts  paper's own types, with its ambient `declare module
//                       'paper'` blocks removed - those would declare the
//                       upstream package's module from inside this one - and a
//                       default export in their place
//
// Both are generated, and both are gitignored: `npm run build`, `package` and
// `dev` re-run this first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const lib = path.resolve(here, '..', 'src', 'lib');

const bundlePath = path.join(root, 'dist', 'paper-full.js');
const typesPath = path.join(root, 'dist', 'paper.d.ts');

for (const file of [bundlePath, typesPath]) {
  if (!fs.existsSync(file)) {
    console.error(
      `Missing ${path.relative(root, file)} - run \`node tools/build.js\` ` +
        'in the repository root first.'
    );
    process.exit(1);
  }
}

fs.mkdirSync(lib, { recursive: true });

// The bundle declares `var paper` at the top level and only assigns
// module.exports when a CommonJS `module` exists, which it does not here, so
// appending the export is most of what an ESM entry needs.
//
// The one thing that does need rewriting is `this`. The bundle is written for
// a classic script, where top-level `this` is the global object; in a module it
// is `undefined`, and PaperScript reads `this.acorn` off it as it initializes.
// Binding the two top-level calls to globalThis restores classic semantics.
const bundle = fs
  .readFileSync(bundlePath, 'utf8')
  .replace(/\}\.call\(this(,|\))/g, '}.call(globalThis$1');
fs.writeFileSync(
  path.join(lib, 'index.js'),
  bundle +
    '\n// Added by scripts/sync-paper.js: the ESM entry point of this package.\n' +
    'export default paper;\n'
);

const types = fs
  .readFileSync(typesPath, 'utf8')
  .replace(/declare module 'paper(?:\/[^']*)?'\s*\{[^}]*\}\s*/g, '');
fs.writeFileSync(
  path.join(lib, 'index.d.ts'),
  types +
    `
// Added by scripts/sync-paper.js. Upstream's types end in ambient
// \`declare module 'paper'\` blocks, which would declare that package's module
// from inside this one; they are stripped above and replaced with the default
// export this package actually has. The global \`paper\` namespace they rely on
// is declared above and stays available, so \`paper.Path\`, \`paper.Point\` and
// the rest are usable as types.
declare const paperScope: paper.PaperScope;
export default paperScope;
`
);

const version = /Paper\.js v([\d.]+)/.exec(bundle);
console.log(
  `src/lib/index.js: ${(bundle.length / 1024).toFixed(0)}kb` +
    (version ? ` (paper.js ${version[1]})` : '')
);
