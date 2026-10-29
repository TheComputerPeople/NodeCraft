// Testing node libraries (docs/node-authoring.md, gap 8): a node's examples run in Simulate and in
// a language pack's generated code; nodes without examples only have to compile; the SDK's
// blueprint-conformance --nodes does the same for any pack.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from '../../src/conformance/cli';
import { formatReport, loadNodeFiles, runNodeExamples, simulateNodeExamples } from '../../src/conformance/conformance';
import { builtinLanguagePacks } from '../../src/core/languages';
import { NodeDefinition } from '../../src/core/model';
import { exampleGraph, exampleMismatches } from '../../src/core/node-examples';
import { repoRoot } from '../unit/helpers';

const languages = builtinLanguagePacks();
const double = loadNodeFiles(path.join(repoRoot, 'sample/visual-nodes/Math/Double.node.json'))[0];
// A pure snippet node with two outputs, and an example that's wrong on purpose.
const split: NodeDefinition = {
  type: 'test.split', version: 1, displayName: 'Split', category: 'Test',
  inputs: [{ id: 'text', name: 'Text', kind: 'data', direction: 'input', type: { id: 'string' } }],
  outputs: [{ id: 'length', name: 'Length', kind: 'data', direction: 'output', type: { id: 'int' } }],
  implementation: { kind: 'code', languages: { typescript: 'return ${text}.length;', javascript: 'return ${text}.length;', python: 'return len(${text})' } },
  examples: [{ inputs: { text: 'abc' }, outputs: { length: 3 } }, { description: 'wrong', inputs: { text: 'ab' }, outputs: { length: 5 } }]
};
const plain: NodeDefinition = { ...double, type: 'test.plain', displayName: 'Plain', examples: undefined };
const pythonOnly: NodeDefinition = { ...plain, type: 'test.python-only', displayName: 'Python Only', implementation: { kind: 'code', languages: { python: 'return ${value}' } } };

describe('node examples', () => {
  test("the example graph calls the node once per example and prints each output it lists", () => {
    const { document, expected } = exampleGraph(double, 'typescript');
    assert.deepEqual(expected, [['10'], ['-3']]);
    const calls = document.graphs[0].nodes.filter((n) => n.type === double.type);
    assert.deepEqual(calls.map((n) => n.properties['pin:value']), [5, -1.5]);
    assert.equal(document.graphs[0].nodes.filter((n) => n.type === 'core:console.print').length, 2);
    assert.deepEqual(exampleMismatches(split, [['3'], ['5']], ['3', '2']), ['Example 2 (wrong), inputs {"text":"ab"}: expected ["5"], printed ["2"]']);
  });

  test('Simulate runs the examples', () => {
    const report = simulateNodeExamples([double, split, plain], 'typescript');
    assert.deepEqual(report.results.map((r) => [r.fixture, r.status]), [[double.type, 'passed'], ['test.split', 'failed'], ['test.plain', 'not-applicable']], formatReport(report));
    assert.match(report.results[1].message ?? '', /Example 2 \(wrong\)/);
  });

  for (const id of ['typescript', 'python']) {
    test(`${id}: examples run in generated code; a node without examples compiles; one without a snippet isn't applicable`, async (t) => {
      const report = await runNodeExamples(languages.get(id)!, [double, split, plain, pythonOnly]);
      if (report.skipped) return t.skip(report.results.find((r) => r.status === 'skipped')?.message);
      assert.deepEqual(report.results.map((r) => [r.fixture, r.status]), [
        [double.type, 'passed'], ['test.split', 'failed'], ['test.plain', 'passed'], ['test.python-only', id === 'python' ? 'passed' : 'not-applicable']
      ], formatReport(report));
      assert.match(report.results[1].message ?? '', /Example 2 \(wrong\), inputs \{"text":"ab"\}: expected \["5"\], printed \["2"\]/);
      assert.equal(report.results[2].message, 'It compiles; it has no examples to run.');
    });
  }

  test('blueprint-conformance --nodes tests a node library and exits with 1 when an example fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-nodes-cli-'));
    const log = console.log;
    const printed: string[] = [];
    console.log = (text: string) => printed.push(text);
    try {
      fs.writeFileSync(path.join(dir, 'Double.node.json'), JSON.stringify(double));
      assert.equal(await main(['typescript', '--nodes', dir]), 0);
      fs.writeFileSync(path.join(dir, 'Split.node.json'), JSON.stringify(split));
      assert.equal(await main(['typescript', '--nodes', dir]), 1);
    } finally {
      console.log = log;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.match(printed[0], /typescript: 1 passed, 0 failed/);
    assert.match(printed[1], /✖ test\.split/);
  });
});
