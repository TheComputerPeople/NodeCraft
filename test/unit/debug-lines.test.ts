// Mapping between graph nodes and generated lines, for debugging generated code.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDocument } from '../../src/core/compiler';
import { breakpointLines, nodeAtLine } from '../../src/core/debug-lines';
import { builtinLanguagePacks } from '../../src/core/languages';
import { NodeRegistry } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
import { parseDocument } from '../../src/core/serializer';
import { doc, node, readRepoFile, wire } from './helpers';

describe('debug lines', () => {
  const nodeLines = [
    { graphId: 'G', nodeId: 'a', line: 10 },
    { graphId: 'G', nodeId: 'b', line: 12 },
    { graphId: 'G', nodeId: 'a', line: 20 }
  ];

  test('a line belongs to the nearest node starting at or before it', () => {
    assert.equal(nodeAtLine(nodeLines, 9), undefined);
    assert.equal(nodeAtLine(nodeLines, 10)?.nodeId, 'a');
    assert.equal(nodeAtLine(nodeLines, 13)?.nodeId, 'b');
    assert.equal(nodeAtLine(nodeLines, 25)?.nodeId, 'a');
    // A method opening at line 14 ends b's code: line 15 is in that method, before its first node.
    assert.equal(nodeAtLine(nodeLines, 15, [14])?.nodeId, 'a');
    assert.equal(nodeAtLine(nodeLines, 13, [14])?.nodeId, 'b');
    assert.equal(nodeAtLine(nodeLines, 25, [14])?.nodeId, 'a');
    // Lines 15 to 19 are a method's prologue (it opens at 14): about to run its first node, a@20.
    assert.equal(nodeAtLine(nodeLines, 17, [14])?.nodeId, 'a');
    // Before any method (imports, fields) there's none; in a method opened at 3, a@10 is next.
    assert.equal(nodeAtLine(nodeLines, 5, []), undefined);
    assert.equal(nodeAtLine(nodeLines, 5, [3])?.nodeId, 'a');
    // A helper method (opened at 14) before another method (opened at 18): none.
    assert.equal(nodeAtLine(nodeLines, 16, [14, 18]), undefined);
  });

  test('a breakpoint is at every place its node\'s code starts; a pure node\'s at the nodes reading it', () => {
    const d = doc(
      [node('s', 'core:event.start'), node('gt', 'core:math.greater'), node('not', 'core:math.not'), node('p1', 'core:console.print'), node('p2', 'core:console.print')],
      [wire('s', 'execOut', 'p1', 'execIn'), wire('p1', 'execOut', 'p2', 'execIn'), wire('gt', 'returnValue', 'p1', 'value'), wire('gt', 'returnValue', 'not', 'a'), wire('not', 'returnValue', 'p2', 'value')]
    );
    const registry = new NodeRegistry();
    const resolver = createResolver(registry, d);
    const graph = d.graphs[0];
    const resolve = (id: string) => { const n = graph.nodes.find((x) => x.id === id); return n && resolver(n); };
    const lines = [{ graphId: 'EventGraph', nodeId: 'p1', line: 5 }, { graphId: 'EventGraph', nodeId: 'p2', line: 7 }, { graphId: 'EventGraph', nodeId: 'p2', line: 30 }];
    assert.deepEqual(breakpointLines(graph, 'p2', lines, resolve), [7, 30]);
    assert.deepEqual(breakpointLines(graph, 'gt', lines, resolve), [5, 7, 30], 'through the pure Not too');
    assert.deepEqual(breakpointLines(graph, 's', lines, resolve), [], 'Start has no code of its own here');
  });

  test('generators report how to read stored pins', () => {
    const d = parseDocument(readRepoFile('sample/demo.vgraph')).document;
    const expressions = (language: string) => {
      d.language = language;
      const out = compileDocument(d, { registry: new NodeRegistry(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'demo.vgraph' } }).output!;
      return Object.fromEntries((out.pinExpressions ?? []).map((p) => [`${p.nodeId}.${p.pinId}`, p.expression]));
    };
    assert.equal(expressions('javascript')['add_1.result'], 'this._add_1_result');
    assert.equal(expressions('javascript')['print_true.value'], 'this._add_1_result');
    assert.equal(expressions('python')['add_1.result'], 'self._add_1_result');
    assert.equal(expressions('csharp')['add_1.result'], '_add_1_result');
    assert.equal(expressions('typescript')['add_1.a'], '10');
  });
});
