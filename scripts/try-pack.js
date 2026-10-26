// Runs the published conformance suite on one pack with the repository's fixtures, while a pack is
// being written: node scripts/try-pack.js <module in out/src/core/languages> <export> [filter].
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { runConformance, formatReport } = require(path.join(root, 'out/src/conformance/conformance'));
const { repoFixtures } = require(path.join(root, 'out/test/conformance/fixtures'));

const [file, name, filter] = process.argv.slice(2);
const pack = require(path.join(root, 'out/src/core/languages', file))[name];
runConformance(pack, { fixtures: repoFixtures(), filter, workDir: path.join(root, 'out/try-pack', pack.id) }).then((report) => {
  console.log(formatReport(report));
  process.exit(report.failed ? 1 : 0);
});
