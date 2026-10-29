// The node audit (src/conformance/audit.ts, docs/language-context.md part 1): its cases, its graph,
// and how it reads what the languages print; and the map order it found Simulate getting wrong.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auditCases, auditGraph, caseOfNode, caseSegments, errorLines, sameLines } from '../../src/conformance/audit';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { NodeRegistry } from '../../src/core/registry';
import { formatValue } from '../../src/core/values';

const languages = builtinLanguagePacks();

describe('node audit', () => {
  test('a case for each node the palette offers, each wildcard type its own, and structural nodes left out', () => {
    const cases = auditCases(builtinNodeDefinitions(), languages.get('typescript')!);
    const labels = cases.map((c) => c.label);
    for (const label of ['core:array.sort<int>', 'core:array.sort<bool>', 'core:map.pick<int, string>', 'core:string.reverse', 'core:flow.branch']) assert.ok(labels.includes(label), label);
    for (const type of ['core:event.start', 'core:function.return', 'core:test.assert-true']) assert.ok(!cases.some((c) => c.definition.type === type), type);
    // Random and file nodes are built, not run.
    assert.equal(cases.find((c) => c.label === 'core:utilities.new-uuid')?.run, false);
    assert.equal(cases.find((c) => c.label === 'core:string.reverse')?.run, true);
  });

  test("a language's cases leave out the nodes it can't compile", () => {
    const lua = auditCases(builtinNodeDefinitions(), languages.get('lua')!);
    const typescript = auditCases(builtinNodeDefinitions(), languages.get('typescript')!);
    assert.ok(lua.length > 300 && lua.length <= typescript.length);
  });

  for (const pack of languages.all().filter((p) => p.generator)) {
    test(`the audit's graph compiles in ${pack.displayName}`, () => {
      const doc = auditGraph(auditCases(builtinNodeDefinitions(), pack), pack.id);
      const result = compileDocument(doc, { registry: new NodeRegistry(), languages, generate: { sourceFileName: 'Audit.vgraph', outputDir: '' } });
      assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
      // Every case's node has a line, so a build error can be traced to it.
      const placed = new Set(result.output!.nodeLines.map((l) => caseOfNode(l.nodeId)));
      assert.ok(doc.graphs[0].nodes.filter((n) => n.id.startsWith('n')).every((n) => placed.has(caseOfNode(n.id))));
    });
  }

  test("markers split the output into each case's lines", () => {
    assert.deepEqual([...caseSegments(['noise', '@@case 0', 'a', 'b', '@@case 3', '@@case 4', 'c'])], [[0, ['a', 'b']], [3, []], [4, ['c']]]);
  });

  test("build errors are read as lines of the generated file, in each toolchain's format", () => {
    assert.deepEqual(errorLines('audit.cpp:12:5: error: no match\naudit.cpp:40:1: note: here', 'audit.cpp'), [12, 40]);
    assert.deepEqual(errorLines('Audit.vgraph.cs(7,13): error CS0029', 'Audit.vgraph.cs'), [7]);
    assert.deepEqual(errorLines('  File "/tmp/x/audit_vgraph.py", line 9, in start', 'audit_vgraph.py'), [9]);
    assert.deepEqual(errorLines('PHP Parse error: syntax error in /tmp/Audit.vgraph.php on line 21', 'Audit.vgraph.php'), [21]);
    assert.deepEqual(errorLines('error in other.rs:3:1', 'audit.rs'), []);
  });

  test('numbers may differ in their last bits, written the same way', () => {
    assert.ok(sameLines(['-0.7470222972386603'], ['-0.7470222972386602']));
    assert.ok(!sameLines(['2.5'], ['2.50']), 'formatting still counts');
    assert.ok(!sameLines(['0.1'], ['0.2']));
    assert.ok(!sameLines(['a'], ['a', 'b']));
  });

  test("Print writes a map's keys in the order they were added, integer keys too", () => {
    assert.equal(formatValue(new Map([[3, 'c'], [1, 'a'], [2, 'b']])), '{"3":"c","1":"a","2":"b"}');
    assert.equal(formatValue([new Map([['10', 1], ['2', 2]]), new Set([2, 1])]), '[{"10":1,"2":2},[1,2]]');
    assert.equal(formatValue({ name: 'x', items: new Map([[2, true], [1, false]]) }), '{"name":"x","items":{"2":true,"1":false}}');
  });
});
