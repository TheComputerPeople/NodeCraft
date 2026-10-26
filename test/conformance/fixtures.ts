// The repository's conformance fixtures in the published suite's shape (src/conformance): the SDK
// ships copies of the same files.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FixtureSet, programFiles } from '../../src/conformance/conformance';
import { repoRoot } from '../unit/helpers';

export function repoFixtures(): FixtureSet {
  const graphsDir = path.join(repoRoot, 'test/fixtures/graphs');
  const graphs = [path.join(repoRoot, 'sample/demo.vgraph'), ...fs.readdirSync(graphsDir).filter((f) => f.endsWith('.vgraph')).sort().map((f) => path.join(graphsDir, f))];
  const testsDir = path.join(repoRoot, 'test/fixtures/tests');
  return {
    fixtures: [
      ...graphs.map((file) => ({ name: `graphs/${path.basename(file)}`, kind: 'graph' as const, files: [file] })),
      { name: 'programs/arena', kind: 'program', files: programFiles(path.join(repoRoot, 'sample/arena')) },
      ...fs.readdirSync(testsDir).filter((f) => f.endsWith('.vgraph')).sort().map((f) => ({ name: `tests/${f}`, kind: 'tests' as const, files: [path.join(testsDir, f)] }))
    ],
    nodes: [path.join(repoRoot, 'sample/visual-nodes/Math/Double.node.json'), path.join(repoRoot, 'test/fixtures/nodes/Fail.node.json')]
  };
}

