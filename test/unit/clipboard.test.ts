import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyNodes, pasteNodes } from '../../src/core/clipboard';
import { parseDocument, primaryGraph, createEmptyDocument } from '../../src/core/serializer';
import { node, readRepoFile, wire } from './helpers';

let n = 0;
const ids = { node: (type: string) => `${type}#${n++}`, connection: () => `c#${n++}` };
const sample = () => parseDocument(readRepoFile('sample/demo.vgraph')).document;

describe('copying and pasting nodes', () => {
  test('copies the selected nodes with only the wires between them', () => {
    const doc = sample();
    const data = JSON.parse(copyNodes(doc, primaryGraph(doc), new Set(['add_1', 'print_true']))!);
    assert.deepEqual(data.nodes.map((x: { id: string }) => x.id), ['add_1', 'print_true']);
    assert.deepEqual(data.connections.map((c: { id: string }) => c.id), ['c7']);
  });

  test('pastes with new ids at the given position, keeping layout and wires', () => {
    const doc = sample();
    const graph = primaryGraph(doc);
    const text = copyNodes(doc, graph, new Set(['add_1', 'print_true']))!;
    const pasted = pasteNodes(doc, graph, text, { x: 1000, y: 1000 }, ids)!;
    assert.equal(pasted.length, 2);
    const [add, print] = pasted.map((id) => graph.nodes.find((x) => x.id === id)!);
    // add_1 was at (390,145) and print_true at (1010,80): the group's top-left lands at (1000,1000).
    assert.deepEqual(add.position, { x: 1000, y: 1065 });
    assert.deepEqual(print.position, { x: 1620, y: 1000 });
    assert.ok(graph.connections.some((c) => c.fromNode === add.id && c.toNode === print.id));
  });

  test('pasting into another document binds variables by name or creates them', () => {
    const source = createEmptyDocument('A');
    source.variables.push({ id: 'v_hp', name: 'Health', type: { id: 'float' } }, { id: 'v_ammo', name: 'Ammo', type: { id: 'int' } });
    source.graphs[0].nodes.push(node('g1', 'core:variable.get', { variable: 'v_hp' }), node('g2', 'core:variable.get', { variable: 'v_ammo' }));
    const text = copyNodes(source, source.graphs[0], new Set(['g1', 'g2']))!;

    const target = createEmptyDocument('B');
    target.variables.push({ id: 'other_id', name: 'Health', type: { id: 'float' } });
    const pasted = pasteNodes(target, target.graphs[0], text, { x: 0, y: 0 }, ids)!;
    const bound = pasted.map((id) => target.graphs[0].nodes.find((x) => x.id === id)!.properties.variable);
    assert.equal(bound[0], 'other_id', 'Health binds to the existing variable');
    assert.equal(target.variables.find((v) => v.name === 'Ammo')?.id, bound[1], 'Ammo is created');
  });

  test('ignores text that is not copied nodes', () => {
    const doc = sample();
    assert.equal(pasteNodes(doc, primaryGraph(doc), 'hello', { x: 0, y: 0 }, ids), undefined);
    assert.equal(pasteNodes(doc, primaryGraph(doc), '{"format":"other"}', { x: 0, y: 0 }, ids), undefined);
  });

  test('copying nothing returns undefined', () => {
    const doc = sample();
    assert.equal(copyNodes(doc, primaryGraph(doc), new Set()), undefined);
  });

  test('wires to nodes outside the copy are dropped', () => {
    const doc = createEmptyDocument('C');
    doc.graphs[0].nodes.push(node('a', 'core:event.start'), node('b', 'core:console.print'));
    doc.graphs[0].connections.push(wire('a', 'execOut', 'b', 'execIn'));
    const data = JSON.parse(copyNodes(doc, doc.graphs[0], new Set(['b']))!);
    assert.deepEqual(data.connections, []);
  });
});
