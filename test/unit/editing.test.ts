import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as editing from '../../src/core/editing';
import { GraphNode } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { parseDocument, primaryGraph } from '../../src/core/serializer';
import { doc, graphOf, node, readRepoFile, wire } from './helpers';

const registry = new NodeRegistry();
const lookup = (n: GraphNode) => registry.get(n.type);
const sample = () => primaryGraph(parseDocument(readRepoFile('sample/demo.vgraph')).document);
let nextId = 0;
const id = () => `id${nextId++}`;

describe('resolveConnection', () => {
  test('orders a drag that starts on the input pin into output → input', () => {
    const g = sample();
    assert.deepEqual(
      editing.resolveConnection(g, lookup, { node: 'print_false', pin: 'value' }, { node: 'add_1', pin: 'result' }),
      { fromNode: 'add_1', fromPin: 'result', toNode: 'print_false', toPin: 'value' }
    );
  });

  test('rejects exec-to-data, input-to-input, self and unknown pins', () => {
    const g = sample();
    assert.equal(editing.resolveConnection(g, lookup, { node: 'start_1', pin: 'execOut' }, { node: 'print_false', pin: 'value' }), undefined);
    assert.equal(editing.resolveConnection(g, lookup, { node: 'add_1', pin: 'a' }, { node: 'print_false', pin: 'value' }), undefined);
    assert.equal(editing.resolveConnection(g, lookup, { node: 'add_1', pin: 'a' }, { node: 'add_1', pin: 'a' }), undefined);
    assert.equal(editing.resolveConnection(g, lookup, { node: 'add_1', pin: 'nope' }, { node: 'print_false', pin: 'value' }), undefined);
  });

  test('rejects incompatible data types', () => {
    const g = graphOf(doc([node('get', 'core:variable.get'), node('branch', 'core:flow.branch'), node('add', 'core:math.add')], []));
    // Branch.condition is bool; Add.result is number.
    assert.equal(editing.resolveConnection(g, lookup, { node: 'add', pin: 'result' }, { node: 'branch', pin: 'condition' }), undefined);
    // Get Variable's value is `any`, which connects to anything.
    assert.ok(editing.resolveConnection(g, lookup, { node: 'get', pin: 'value' }, { node: 'branch', pin: 'condition' }));
  });
});

describe('connect: Unreal wiring rules', () => {
  test('a data input takes one wire: a new one replaces the old', () => {
    const g = sample();
    editing.connect(g, lookup, { fromNode: 'add_1', fromPin: 'result', toNode: 'print_true', toPin: 'value' }, 'fresh');
    const into = g.connections.filter((c) => c.toNode === 'print_true' && c.toPin === 'value');
    assert.deepEqual(into.map((c) => c.id), ['fresh']);
  });

  test('a data output feeds many inputs', () => {
    const g = sample();
    editing.connect(g, lookup, { fromNode: 'add_1', fromPin: 'result', toNode: 'print_false', toPin: 'value' }, 'second');
    assert.equal(g.connections.filter((c) => c.fromNode === 'add_1' && c.fromPin === 'result').length, 2);
  });

  test('an exec output drives one input: a new wire replaces the old', () => {
    const g = sample();
    // c3: branch_1.true → print_true. Rewiring the True output elsewhere replaces it.
    editing.connect(g, lookup, { fromNode: 'branch_1', fromPin: 'true', toNode: 'end_false', toPin: 'execIn' }, 'fresh');
    assert.deepEqual(g.connections.filter((c) => c.fromNode === 'branch_1' && c.fromPin === 'true').map((c) => c.id), ['fresh']);
  });

  test('an exec input accepts many wires', () => {
    const g = sample();
    // print_false already has c4 coming in; adding another keeps both.
    editing.connect(g, lookup, { fromNode: 'print_true', fromPin: 'execOut', toNode: 'print_false', toPin: 'execIn' }, 'fresh');
    assert.deepEqual(g.connections.filter((c) => c.toNode === 'print_false' && c.toPin === 'execIn').map((c) => c.id).sort(), ['c4', 'fresh']);
  });
});

describe('rewire', () => {
  test('moves the target end of a connection', () => {
    const g = sample();
    assert.equal(editing.rewire(g, lookup, 'c7', 'to', { node: 'print_false', pin: 'value' }), true);
    const c7 = g.connections.find((c) => c.id === 'c7');
    assert.equal(c7?.toNode, 'print_false');
  });

  test('refuses invalid targets and leaves the graph unchanged', () => {
    const g = sample();
    const before = JSON.stringify(g.connections);
    assert.equal(editing.rewire(g, lookup, 'c7', 'to', { node: 'start_1', pin: 'execOut' }), false);
    assert.equal(editing.rewire(g, lookup, 'missing', 'to', { node: 'print_false', pin: 'value' }), false);
    assert.equal(JSON.stringify(g.connections), before);
  });

  test('moving a wire onto an exec input keeps the wires already there', () => {
    const g = sample();
    // c4 feeds branch.false → print_false.execIn; move c3's target there too.
    assert.equal(editing.rewire(g, lookup, 'c3', 'to', { node: 'print_false', pin: 'execIn' }), true);
    assert.ok(g.connections.some((c) => c.id === 'c4'));
  });

  test('moving a wire onto a data input displaces the wire already there', () => {
    const g = sample();
    editing.connect(g, lookup, { fromNode: 'add_1', fromPin: 'result', toNode: 'print_false', toPin: 'value' }, 'other');
    assert.equal(editing.rewire(g, lookup, 'c7', 'to', { node: 'print_false', pin: 'value' }), true);
    assert.ok(!g.connections.some((c) => c.id === 'other'));
  });
});

describe('disconnect helpers', () => {
  test('report how many connections they removed', () => {
    const g = sample();
    assert.equal(editing.disconnectPin(g, { node: 'add_1', pin: 'execOut' }), 1);
    assert.equal(editing.disconnectConnection(g, 'c7'), 1);
    assert.equal(editing.disconnectConnection(g, 'c7'), 0);
    assert.equal(editing.disconnectNodes(g, new Set(['branch_1'])), 2);
  });
});

describe('createNode', () => {
  test('fills data-input defaults from the definition', () => {
    const n = editing.createNode('core:math.add', registry.get('core:math.add'), { x: 1, y: 2 }, 'n1');
    assert.deepEqual(n, { id: 'n1', type: 'core:math.add', position: { x: 1, y: 2 }, properties: { 'pin:a': 10, 'pin:b': 20 } });
  });

  test('creates an empty node for unknown types', () => {
    assert.deepEqual(editing.createNode('x.unknown', undefined, { x: 0, y: 0 }, 'n2').properties, {});
  });
});

describe('deleteNodes / duplicateNodes', () => {
  test('deleting removes the nodes and every connection touching them', () => {
    const g = sample();
    editing.deleteNodes(g, new Set(['print_true']));
    assert.ok(!g.nodes.some((n) => n.id === 'print_true'));
    assert.ok(!g.connections.some((c) => c.fromNode === 'print_true' || c.toNode === 'print_true'));
    assert.equal(g.connections.length, 4);
  });

  test('duplicating copies internal connections only, with offset positions', () => {
    const g = sample();
    const copies = editing.duplicateNodes(g, new Set(['add_1', 'print_true']), { x: 35, y: 35 }, (n) => `${n.id}_copy`, id);
    assert.deepEqual(copies.map((n) => n.id), ['add_1_copy', 'print_true_copy']);
    assert.deepEqual(copies[0].position, { x: 425, y: 180 });
    const copied = g.connections.filter((c) => c.fromNode.endsWith('_copy') || c.toNode.endsWith('_copy'));
    assert.deepEqual(copied.map((c) => `${c.fromNode}.${c.fromPin}->${c.toNode}.${c.toPin}`), ['add_1_copy.result->print_true_copy.value']);
  });

  test('duplicates are deep copies', () => {
    const g = sample();
    const [copy] = editing.duplicateNodes(g, new Set(['add_1']), { x: 0, y: 0 }, () => 'copy', id);
    copy.properties['pin:a'] = 999;
    assert.equal(g.nodes.find((n) => n.id === 'add_1')?.properties['pin:a'], 10);
  });
});

describe('connectedNodeIds', () => {
  test('walks connections in both directions', () => {
    const g = graphOf(doc(
      [node('a', 'x'), node('b', 'x'), node('c', 'x'), node('lonely', 'x')],
      [wire('a', 'o', 'b', 'i'), wire('c', 'o', 'b', 'i2')]
    ));
    assert.deepEqual([...editing.connectedNodeIds(g, 'a')].sort(), ['a', 'b', 'c']);
    assert.deepEqual([...editing.connectedNodeIds(g, 'lonely')], ['lonely']);
  });
});

describe('matchingPin / compatibleDefinitions', () => {
  test('finds the first pin that can take a dragged wire', () => {
    const result = registry.get('core:math.add')!.outputs.find((p) => p.id === 'result')!;
    assert.equal(editing.matchingPin(registry.get('core:console.print')!, result)?.id, 'value');
    const offered = editing.compatibleDefinitions(registry.all(), result).map((d) => d.type);
    assert.ok(offered.includes('core:console.print'));
    assert.ok(!offered.includes('core:event.start'));
    assert.ok(!offered.includes('core:flow.branch'), 'a number cannot feed a bool input');
  });
});

describe('nodeIdFor', () => {
  test('slugs the type and appends a random suffix', () => {
    assert.match(editing.nodeIdFor('core:math.add', () => 0.5), /^core_math_add_[a-z0-9]+$/);
  });
});

describe('reroute nodes', () => {
  test('splitting a data wire inserts a typed knot that passes the value through', () => {
    const g = sample();
    const knot = editing.insertReroute(g, lookup, 'c7', { x: 700, y: 300 }, { node: 'knot', connections: ['k1', 'k2'] })!;
    assert.deepEqual(knot.properties, { kind: 'data', type: { id: 'float' } });
    assert.ok(!g.connections.some((c) => c.id === 'c7'));
    assert.deepEqual(g.connections.filter((c) => c.id.startsWith('k')).map((c) => `${c.fromNode}.${c.fromPin}->${c.toNode}.${c.toPin}`),
      ['add_1.result->knot.in', 'knot.out->print_true.value']);
  });

  test('splitting an exec wire makes an exec knot', () => {
    const g = sample();
    assert.deepEqual(editing.insertReroute(g, lookup, 'c1', { x: 0, y: 0 }, { node: 'k', connections: ['a', 'b'] })?.properties, { kind: 'exec' });
  });
});

describe('Sequence pins', () => {
  test('adding and removing pins renumbers later outputs and keeps their wires', () => {
    const g = graphOf(doc([node('q', 'core:flow.sequence'), node('a', 'x'), node('b', 'x'), node('c', 'x')],
      [wire('q', 'then0', 'a', 'in'), wire('q', 'then1', 'b', 'in'), wire('q', 'then2', 'c', 'in')]));
    const q = g.nodes[0];
    editing.addSequencePin(q);
    assert.equal(q.properties.pins, 4);
    assert.equal(editing.removeSequencePin(g, q, 'then1'), true);
    assert.equal(q.properties.pins, 3);
    assert.deepEqual(g.connections.map((c) => `${c.fromPin}->${c.toNode}`), ['then0->a', 'then1->c']);
  });

  test('a Sequence keeps at least one output', () => {
    const g = graphOf(doc([node('q', 'core:flow.sequence', { pins: 1 })], []));
    assert.equal(editing.removeSequencePin(g, g.nodes[0], 'then0'), false);
  });
});
