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

  test('a node runs every time execution reaches it, as in Unreal', () => {
    const events = run(doc(
      [node('s', 'core:event.start'), node('q', 'core:flow.sequence'), node('p', 'core:console.print', { 'pin:value': 'again' })],
      [wire('s', 'execOut', 'q', 'execIn'), wire('q', 'then0', 'p', 'execIn'), wire('q', 'then1', 'p', 'execIn')]
    ));
    assert.deepEqual(logs(events), ['again', 'again']);
  });

  test('an exec output wired to several inputs runs them in connection order', () => {
    const events = run(doc(
      [node('s', 'core:event.start'), node('a', 'core:console.print', { 'pin:value': 'a' }), node('b', 'core:console.print', { 'pin:value': 'b' })],
      [wire('s', 'execOut', 'b', 'execIn'), wire('s', 'execOut', 'a', 'execIn')]
    ));
    assert.deepEqual(logs(events), ['b', 'a']);
  });

  test('Branch treats 0, NaN, empty strings and null as false', () => {
    const branchOn = (condition: unknown) => logs(run(doc(
      [node('s', 'core:event.start'), node('br', 'core:flow.branch', { 'pin:condition': condition }),
        node('t', 'core:console.print', { 'pin:value': 'T' }), node('f', 'core:console.print', { 'pin:value': 'F' })],
      [wire('s', 'execOut', 'br', 'execIn'), wire('br', 'true', 't', 'execIn'), wire('br', 'false', 'f', 'execIn')]
    )))[0];
    assert.deepEqual([0, Number.NaN, '', null, false].map(branchOn), ['F', 'F', 'F', 'F', 'F']);
    assert.deepEqual([1, 'false', true].map(branchOn), ['T', 'T', 'T']);
  });

  for (const [label, connections] of [
    ['a Sequence wired to itself', [wire('s', 'execOut', 'q', 'execIn'), wire('q', 'then0', 'q', 'execIn')]],
    ['two Sequences wired in a loop', [wire('s', 'execOut', 'q', 'execIn'), wire('q', 'then0', 'q2', 'execIn'), wire('q2', 'then0', 'q', 'execIn')]]
  ] as const) {
    test(`stops and reports ${label}`, () => {
      const events = run(doc([node('s', 'core:event.start'), node('q', 'core:flow.sequence'), node('q2', 'core:flow.sequence')], [...connections]));
      assert.ok(events.some((e) => e.kind === 'error' && /cycle/.test(e.message ?? '')));
      assert.equal(events.at(-1)?.message, 'Graph execution stopped by an error.');
    });
  }
});

describe('GraphRuntime: variables', () => {
  const score = { id: 'v_score', name: 'Score', type: { id: 'int' }, defaultValue: 0 };

  test('Set and Get nodes read and write the variable they are bound to', () => {
    const events = run(doc(
      [node('s', 'core:event.start'), node('set', 'core:variable.set', { variable: 'v_score', 'pin:value': 42 }),
        node('get', 'core:variable.get', { variable: 'v_score' }), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'set', 'execIn'), wire('set', 'execOut', 'p', 'execIn'), wire('get', 'value', 'p', 'value')],
      [score]
    ));
    assert.deepEqual(logs(events), ['42']);
  });

  test("a Set node's output is the variable's new value", () => {
    const events = run(doc(
      [node('s', 'core:event.start'), node('set', 'core:variable.set', { variable: 'v_score', 'pin:value': 7 }), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'set', 'execIn'), wire('set', 'execOut', 'p', 'execIn'), wire('set', 'result', 'p', 'value')],
      [score]
    ));
    assert.deepEqual(logs(events), ['7']);
  });

  test('nodes stay bound when the variable is renamed', () => {
    const d = doc(
      [node('s', 'core:event.start'), node('get', 'core:variable.get', { variable: 'v_score' }), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'p', 'execIn'), wire('get', 'value', 'p', 'value')],
      [{ ...score, name: 'Points', defaultValue: 5 }]
    );
    assert.deepEqual(logs(run(d)), ['5']);
  });

  test('declared variables start at their default, else their type default', () => {
    const events = run(doc(
      [node('s', 'core:event.start'), node('g1', 'core:variable.get', { variable: 'v1' }), node('g2', 'core:variable.get', { variable: 'v2' }),
        node('p1', 'core:console.print'), node('p2', 'core:console.print')],
      [wire('s', 'execOut', 'p1', 'execIn'), wire('p1', 'execOut', 'p2', 'execIn'), wire('g1', 'value', 'p1', 'value'), wire('g2', 'value', 'p2', 'value')],
      [{ id: 'v1', name: 'Lives', type: { id: 'int' }, defaultValue: 3 }, { id: 'v2', name: 'Alive', type: { id: 'bool' } }]
    ));
    assert.deepEqual(logs(events), ['3', 'false']);
  });

  test('a variable node without a variable stops the run with an error', () => {
    const events = run(doc(
      [node('s', 'core:event.start'), node('get', 'core:variable.get'), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'p', 'execIn'), wire('get', 'value', 'p', 'value')]
    ));
    assert.ok(events.some((e) => e.kind === 'error' && /has no variable/.test(e.message ?? '')));
    assert.deepEqual(logs(events), []);
  });
});

describe('GraphRuntime: data flow and values', () => {
  test('an impure node output holds its type default until the node runs', () => {
    const events = run(doc(
      [node('s', 'core:event.start'), node('add', 'core:math.add'), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'p', 'execIn'), wire('add', 'result', 'p', 'value')]
    ));
    assert.deepEqual(logs(events), ['0']);
  });

  test('unconnected inputs fall back to the pin definition default', () => {
    // No pin:a / pin:b stored on the node: Add's definition defaults are 10 and 20.
    const events = run(doc(
      [node('s', 'core:event.start'), node('add', 'core:math.add'), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'add', 'execIn'), wire('add', 'execOut', 'p', 'execIn'), wire('add', 'result', 'p', 'value')]
    ));
    assert.deepEqual(logs(events), ['30']);
  });

  test('Print formats values by the shared rules', () => {
    const printed = (value: unknown) => logs(run(doc(
      [node('s', 'core:event.start'), node('p', 'core:console.print', { 'pin:value': value })],
      [wire('s', 'execOut', 'p', 'execIn')]
    )))[0];
    assert.deepEqual([true, false, null, 0.1, 30, 1e21, 1e-7, 'text'].map(printed), ['true', 'false', '', '0.1', '30', '1e+21', '1e-7', 'text']);
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
    assert.ok(run(python, registry).some((e) => e.kind === 'error' && /Python code can't run inside the editor/.test(e.message ?? '')));
  });
});

describe('GraphRuntime: pure nodes and project functions', () => {
  // A pure code node: no exec pins, so it runs each time its output is read.
  const counter: NodeDefinition = {
    type: 't.counter', version: 1, displayName: 'Counter', category: 'Test', inputs: [],
    outputs: [{ id: 'result', name: 'Result', kind: 'data', direction: 'output', type: { id: 'int' } }],
    implementation: { kind: 'code', languages: { javascript: 'globalThis.__vgraphCount = (globalThis.__vgraphCount ?? 0) + 1; return globalThis.__vgraphCount;' } }
  };
  const project: NodeDefinition = {
    type: 'fn:typescript:lib/save.ts#save', version: 1, displayName: 'Save', category: 'Project',
    inputs: [{ id: 'execIn', name: '', kind: 'exec', direction: 'input' }],
    outputs: [{ id: 'execOut', name: '', kind: 'exec', direction: 'output' }],
    implementation: { kind: 'function', language: 'typescript', path: 'lib/save.ts', name: 'save' }
  };
  const registry = new NodeRegistry();
  registry.registerMany([counter, project]);

  test('a pure node runs again for every read', () => {
    delete (globalThis as { __vgraphCount?: number }).__vgraphCount;
    const events = run(doc(
      [node('s', 'core:event.start'), node('c', 't.counter'), node('p1', 'core:console.print'), node('p2', 'core:console.print')],
      [wire('s', 'execOut', 'p1', 'execIn'), wire('p1', 'execOut', 'p2', 'execIn'), wire('c', 'result', 'p1', 'value'), wire('c', 'result', 'p2', 'value')]
    ), registry);
    assert.deepEqual(logs(events), ['1', '2']);
  });

  test('a project function stops Simulate with a pointer to Run', () => {
    const events = run(doc([node('s', 'core:event.start'), node('f', project.type)], [wire('s', 'execOut', 'f', 'execIn')]), registry);
    const error = events.find((e) => e.kind === 'error');
    assert.equal(error?.nodeId, 'f');
    assert.match(error?.message ?? '', /Simulate can't run your project's code \("Save" is save in lib\/save\.ts\)\. Use Run/);
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
    const d = doc([node('s', 'core:event.start'), node('set', 'core:variable.set', { variable: 'v_score', 'pin:value': 7 })], [wire('s', 'execOut', 'set', 'execIn')],
      [{ id: 'v_score', name: 'Score', type: { id: 'int' } }]);
    d.graphs.push({
      id: 'Reader', name: 'Reader', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('get', 'core:variable.get', { variable: 'v_score' }), node('p', 'core:console.print')],
      connections: [wire('s', 'execOut', 'p', 'execIn'), wire('get', 'value', 'p', 'value')]
    });
    assert.deepEqual(logs(run(d)), ['7']);
  });
});
