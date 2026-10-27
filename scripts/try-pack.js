// Runs the published conformance suite on one pack with the repository's fixtures, while a pack is
// being written: node scripts/try-pack.js <module in out/src/core/languages> <export> [filter], or
// node scripts/try-pack.js <definition.json> [filter] for a declarative pack.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { runConformance, formatReport } = require(path.join(root, 'out/src/conformance/conformance'));
const { repoFixtures } = require(path.join(root, 'out/test/conformance/fixtures'));
const { declarativePack } = require(path.join(root, 'out/src/core/declarative'));

const args = process.argv.slice(2);
const declarative = args[0].endsWith('.json');
const pack = declarative
  ? declarativePack(JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8')))
  : require(path.join(root, 'out/src/core/languages', args[0]))[args[1]];
const filter = declarative ? args[1] : args[2];
runConformance(pack, { fixtures: repoFixtures(), filter, workDir: path.join(root, 'out/try-pack', pack.id) }).then((report) => {
  console.log(formatReport(report));
  process.exit(report.failed ? 1 : 0);
});
