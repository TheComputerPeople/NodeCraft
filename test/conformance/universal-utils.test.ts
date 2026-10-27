// The universal-utils node package (libraries/universal-utils): its fixtures print the same in
// Simulate and in every built-in language, and Simulate prints what each fixture expects.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FixtureSet, formatReport, runConformance } from '../../src/conformance/conformance';
import { builtinLanguagePacks } from '../../src/core/languages';
import { RuntimeLogEvent } from '../../src/core/model';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { GraphRuntime } from '../../src/core/runtime';
import { parseDocument } from '../../src/core/serializer';
import { repoRoot } from '../unit/helpers';

const library = path.join(repoRoot, 'libraries/universal-utils');
const fixtureFiles = fs.readdirSync(path.join(library, 'fixtures')).filter((f) => f.endsWith('.vgraph')).sort();
const nodeFiles = fs.readdirSync(path.join(library, 'nodes')).sort().map((f) => path.join(library, 'nodes', f));
const fixtures: FixtureSet = {
  fixtures: fixtureFiles.map((f) => ({ name: f, kind: 'graph', files: [path.join(library, 'fixtures', f)] })),
  nodes: nodeFiles
};

describe('universal-utils', () => {
  test('Simulate prints what each fixture expects', () => {
    const registry = new NodeRegistry();
    registry.registerMany(nodeFiles.map((f) => parseNodeDefinition(fs.readFileSync(f, 'utf8'))!));
    for (const file of fixtureFiles) {
      const doc = parseDocument(fs.readFileSync(path.join(library, 'fixtures', file), 'utf8')).document;
      const events: RuntimeLogEvent[] = [];
      new GraphRuntime(registry, (e) => events.push(e), builtinLanguagePacks()).run(doc);
      assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.message), doc.metadata?.expectedOutput, file);
      assert.equal(events.find((e) => e.kind === 'error')?.message, doc.metadata?.expectedError, file);
    }
  });

  for (const pack of builtinLanguagePacks().all()) {
    test(`${pack.displayName} prints the same`, async (t) => {
      const report = await runConformance(pack, { fixtures });
      if (report.skipped === report.results.length) return t.skip(report.results[0]?.message ?? 'no toolchain');
      assert.equal(report.failed, 0, formatReport(report));
      assert.equal(report.passed, fixtureFiles.length, formatReport(report));
    });
  }
});
