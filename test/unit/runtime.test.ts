import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeDefinition } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { doc, exitCounts, logs, node, readRepoFile, run, wire } from './helpers';

function codeNode(type: string, pinId: string, code: string): NodeDefinition {
  return {
    type, version: 1, displayName: type, category: 'Test',
    inputs: [
      { id: 'execIn', name: '', kind: 'exec', direction: 'input' },
      { id: pinId, name: 'Value', kind: 'data', direction: 'input', type: { id: 'number' } }
    ],
    outputs: [
      { id: 'execOut', name: '', kind: 'exec', direction: 'output' },
      { id: 'result', name: 'Result', kind: 'data', direction: 'output', type: { id: 'number' } }
    ],
    implementation: { kind: 'code', languages: { javascript: code } }
  };
}

describe('GraphRuntime: sample graph', () => {
  const events = run(parseDocument(readRepoFile('sample/demo.vgraph')).document);

  test('prints the Add result on the true branch only', () => {
    assert.deepEqual(logs(events), ['30']);
  });

  test('completes', () => {
    assert.equal(events.at(-1)?.kind, 'graph.complete');
  });

  test('every executed node exits exactly once', () => {
    for (const [id, count] of Object.entries(exitCounts(events))) assert.equal(count, 1, id);
  });
});

describe('GraphRuntime: control flow', () => {
  test('reports a graph without a Start node', () => {
    const events = run(doc([node('p', 'core:console.print')], []));
    assert.deepEqual(events.map((e) => e.kind), ['error']);
  });

  test('Sequence runs outputs in order', () => {
    const events = run(doc(
      [node('s', 'core:event.start'), node('q', 'core:flow.sequence'),
        node('a', 'core:console.print', { 'pin:value': 'first' }), node('b', 'core:console.print', { 'pin:value': 'second' })],
      [wire('s', 'execOut', 'q', 'execIn'), wire('q', 'then1', 'b', 'execIn'), wire('q', 'then0', 'a', 'execIn')]
    ));
    assert.deepEqual(logs(events), ['first', 'second']);
  });

  test('a node reached by two paths runs once', () => {
    const events = run(doc(
      [node('s', 'core:event.start'), node('q', 'core:flow.sequence'), node('p', 'core:console.print', { 'pin:value': 'once' })],
      [wire('s', 'execOut', 'q', 'execIn'), wire('q', 'then0', 'p', 'execIn'), wire('q', 'then1', 'p', 'execIn')]
    ));
    assert.deepEqual(logs(events), ['once']);
  });

  for (const [label, connections] of [
    ['a Sequence wired to itself', [wire('s', 'execOut', 'q', 'execIn'), wire('q', 'then0', 'q', 'execIn')]],
    ['two Sequences wired in a loop', [wire('s', 'execOut', 'q', 'execIn'), wire('q', 'then0', 'q2', 'execIn'), wire('q2', 'then0', 'q', 'execIn')]]
  ] as const) {
    test(`stops and reports ${label}`, () => {
      const events = run(doc([node('s', 'core:event.start'), node('q', 'core:flow.sequence'), node('q2', 'core:flow.sequence')], [...connections]));
      assert.ok(events.some((e) => e.kind === 'error' && /cycle/.test(e.message ?? '')));
      assert.equal(events.at(-1)?.kind, 'graph.complete');
    });
  }
});

describe('GraphRuntime: variables', () => {
  test('Get Variable follows a wired Name pin', () => {
    const events = run(doc(
      [node('s', 'core:event.start'), node('set', 'core:variable.set', { 'pin:name': 'Score', 'pin:value': 42 }),
        node('key', 'core:variable.get', { 'pin:name': 'Key' }), node('get', 'core:variable.get', { 'pin:name': 'Wrong' }),
        node('p', 'core:console.print')],
      [wire('s', 'execOut', 'set', 'execIn'), wire('set', 'execOut', 'p', 'execIn'),
        wire('key', 'value', 'get', 'name'), wire('get', 'value', 'p', 'value')],
      [{ id: 'v1', name: 'Key', type: { id: 'string' }, defaultValue: 'Score' }]
    ));
    assert.deepEqual(logs(events), ['42']);
  });

  test('a data cycle between Get Variable nodes terminates', () => {
    const events = run(doc(
      [node('s', 'core:event.start'), node('a', 'core:variable.get'), node('b', 'core:variable.get'), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'p', 'execIn'), wire('a', 'value', 'b', 'name'), wire('b', 'value', 'a', 'name'), wire('a', 'value', 'p', 'value')]
    ));
    assert.equal(events.at(-1)?.kind, 'graph.complete');
  });
});

describe('GraphRuntime: code nodes', () => {
  const registry = new NodeRegistry();
  registry.register(codeNode('t.double', 'value', 'return value * 2;'));
  registry.register(codeNode('t.dash', 'my-value', 'return ${my-value} + 1;'));
  registry.register(codeNode('t.reserved', 'class', 'return ${class} * 10;'));
  const events = run(doc(
    [node('s', 'core:event.start'), node('d', 't.double', { 'pin:value': 4 }), node('m', 't.dash', { 'pin:my-value': 1 }),
      node('r', 't.reserved', { 'pin:class': 3 }), node('p', 'core:console.print')],
    [wire('s', 'execOut', 'd', 'execIn'), wire('d', 'execOut', 'm', 'execIn'), wire('m', 'execOut', 'r', 'execIn'),
      wire('r', 'execOut', 'p', 'execIn'), wire('r', 'result', 'p', 'value')]
  ), registry);

  test('run without errors, including pin ids that are not JS identifiers', () => {
    assert.deepEqual(events.filter((e) => e.kind === 'error'), []);
  });

  test('produce the expected results', () => {
    const results = events.filter((e) => e.kind === 'node.exit' && e.values && 'result' in e.values).map((e) => e.values?.result);
    assert.deepEqual(results, [8, 2, 30]);
    assert.deepEqual(logs(events), ['30']);
  });

  test('each exits exactly once', () => {
    for (const [id, count] of Object.entries(exitCounts(events))) assert.equal(count, 1, id);
  });

  test('refuse to run when the graph targets a language without an in-process adapter', () => {
    const python = doc([node('s', 'core:event.start'), node('d', 't.double')], [wire('s', 'execOut', 'd', 'execIn')]);
    python.language = 'python';
    assert.ok(run(python, registry).some((e) => e.kind === 'error' && /python/.test(e.message ?? '')));
  });
});

describe('GraphRuntime: documents', () => {
  test('runs the Start nodes of every event graph, tagging events with their graph', () => {
    const d = doc([node('s', 'core:event.start'), node('p', 'core:console.print', { 'pin:value': 'first graph' })], [wire('s', 'execOut', 'p', 'execIn')]);
    // The second graph reuses the same node ids: ids only need to be unique within a graph.
    d.graphs.push({
      id: 'Second', name: 'Second', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('p', 'core:console.print', { 'pin:value': 'second graph' })],
      connections: [wire('s', 'execOut', 'p', 'execIn')]
    });
    const events = run(d);
    assert.deepEqual(logs(events), ['first graph', 'second graph']);
    assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.graphId), ['EventGraph', 'Second']);
    assert.equal(events.at(-1)?.graphId, undefined, 'graph.complete belongs to the whole run');
  });

  test('ignores Start nodes outside event graphs', () => {
    const d = doc([], []);
    d.graphs.push({
      id: 'Helper', name: 'Helper', kind: 'function', signature: { inputs: [], outputs: [] }, comments: [],
      nodes: [node('s', 'core:event.start')], connections: []
    });
    assert.deepEqual(run(d).map((e) => e.kind), ['error']);
  });

  test('member variables are shared across event graphs', () => {
    const d = doc([node('s', 'core:event.start'), node('set', 'core:variable.set', { 'pin:name': 'Score', 'pin:value': 7 })], [wire('s', 'execOut', 'set', 'execIn')]);
    d.graphs.push({
      id: 'Reader', name: 'Reader', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('get', 'core:variable.get', { 'pin:name': 'Score' }), node('p', 'core:console.print')],
      connections: [wire('s', 'execOut', 'p', 'execIn'), wire('get', 'value', 'p', 'value')]
    });
    assert.deepEqual(logs(run(d)), ['7']);
  });
});
