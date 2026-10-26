// Builds packages/pack-sdk (docs/language-breadth.md, "The public API and the pack SDK"): the
// bundled SDK and conformance command, their type declarations, and the conformance fixtures.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'packages/pack-sdk/dist');
fs.rmSync(dist, { recursive: true, force: true });

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true, logLevel: 'warning' };
esbuild.buildSync({ ...common, entryPoints: [path.join(root, 'src/sdk/index.ts')], outfile: path.join(dist, 'index.js') });
esbuild.buildSync({ ...common, entryPoints: [path.join(root, 'src/conformance/cli.ts')], outfile: path.join(dist, 'cli.js'), banner: { js: '#!/usr/bin/env node' } });
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'src/sdk/tsconfig.json')], { stdio: 'inherit' });

// The fixtures, in the layout loadFixtureSet reads.
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};
const fixtures = path.join(dist, 'fixtures');
const vgraphs = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.vgraph'));
copy(path.join(root, 'sample/demo.vgraph'), path.join(fixtures, 'graphs/demo.vgraph'));
for (const f of vgraphs(path.join(root, 'test/fixtures/graphs'))) copy(path.join(root, 'test/fixtures/graphs', f), path.join(fixtures, 'graphs', f));
for (const f of vgraphs(path.join(root, 'sample/arena'))) copy(path.join(root, 'sample/arena', f), path.join(fixtures, 'programs/arena', f));
for (const f of vgraphs(path.join(root, 'test/fixtures/tests'))) copy(path.join(root, 'test/fixtures/tests', f), path.join(fixtures, 'tests', f));
copy(path.join(root, 'sample/visual-nodes/Math/Double.node.json'), path.join(fixtures, 'nodes/Double.node.json'));
copy(path.join(root, 'test/fixtures/nodes/Fail.node.json'), path.join(fixtures, 'nodes/Fail.node.json'));
console.log(`Built ${path.relative(root, dist)}`);
