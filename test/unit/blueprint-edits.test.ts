import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as edits from '../../src/core/blueprint-edits';
import { GraphDocument } from '../../src/core/model';
import { createEmptyDocument } from '../../src/core/serializer';
import { node, wire } from './helpers';

const fresh = (): GraphDocument => createEmptyDocument('Test');

describe('uniqueName', () => {
  test('appends _1, _2, ... like Unreal', () => {
    assert.equal(edits.uniqueName('NewVar', []), 'NewVar');
    assert.equal(edits.uniqueName('NewVar', ['NewVar']), 'NewVar_1');
    assert.equal(edits.uniqueName('NewVar', ['NewVar', 'NewVar_1']), 'NewVar_2');
  });
});

describe('graphs', () => {
  test('adding names graphs uniquely by kind', () => {
    const doc = fresh();
    assert.deepEqual([edits.addGraph(doc, 'function').name, edits.addGraph(doc, 'function').name, edits.addGraph(doc, 'macro').name], ['NewFunction', 'NewFunction_1', 'NewMacro']);
    assert.deepEqual(doc.graphs.find((g) => g.name === 'NewFunction')?.signature, { inputs: [], outputs: [] });
  });

  test('libraries only take their own graph kind', () => {
    const doc = { ...fresh(), kind: 'functionLibrary' as const, graphs: [] };
    assert.deepEqual(edits.allowedGraphKinds(doc), ['function']);
    assert.throws(() => edits.addGraph(doc, 'event'), /can't contain event graphs/);
  });

  test('renaming rejects empty and duplicate names', () => {
    const doc = fresh();
    const fn = edits.addGraph(doc, 'function');
    assert.equal(edits.renameGraph(doc, fn.id, '  '), 'A graph needs a name.');
    assert.match(edits.renameGraph(doc, fn.id, 'EventGraph') ?? '', /already a graph/);
    assert.equal(edits.renameGraph(doc, fn.id, 'Heal'), undefined);
    assert.equal(fn.name, 'Heal');
  });

  test('the last graph cannot be deleted', () => {
    const doc = fresh();
    assert.match(edits.deleteGraph(doc, 'EventGraph') ?? '', /at least one graph/);
    const fn = edits.addGraph(doc, 'function');
    assert.equal(edits.deleteGraph(doc, fn.id), undefined);
    assert.equal(doc.graphs.length, 1);
  });
});

describe('variables', () => {
  test('new variables are bool NewVar, NewVar_1, ... with a default', () => {
    const doc = fresh();
    const a = edits.addVariable(doc);
    const b = edits.addVariable(doc);
    assert.deepEqual([a.name, b.name], ['NewVar', 'NewVar_1']);
    assert.deepEqual(a.type, { id: 'bool' });
    assert.equal(a.defaultValue, false);
    assert.notEqual(a.id, b.id);
  });

  test('libraries have no variables', () => {
    assert.throws(() => edits.addVariable({ ...fresh(), kind: 'functionLibrary' }), /Only classes/);
  });

  test('renaming validates; changing type resets the default', () => {
    const doc = fresh();
    const a = edits.addVariable(doc);
    const b = edits.addVariable(doc);
    assert.match(edits.renameVariable(doc, b.id, 'NewVar') ?? '', /already a variable/);
    assert.equal(edits.renameVariable(doc, b.id, 'Health'), undefined);
    edits.setVariableType(doc, b.id, { id: 'float' });
    assert.deepEqual([b.name, b.type, b.defaultValue], ['Health', { id: 'float' }, 0]);
    edits.setVariableType(doc, a.id, { id: 'int', container: 'array' });
    assert.deepEqual(a.defaultValue, []);
  });

  test('deleting removes its Get/Set nodes and their wires everywhere', () => {
    const doc = fresh();
    const v = edits.addVariable(doc);
    const keep = edits.addVariable(doc);
    doc.graphs[0].nodes.push(node('get', 'core:variable.get', { variable: v.id }), node('other', 'core:variable.get', { variable: keep.id }), node('p', 'core:console.print'));
    doc.graphs[0].connections.push(wire('get', 'value', 'p', 'value'));
    const fn = edits.addGraph(doc, 'function');
    fn.nodes.push(node('set', 'core:variable.set', { variable: v.id }));
    assert.equal(edits.variableUses(doc, v.id), 2);
    assert.equal(edits.deleteVariable(doc, v.id), 2);
    assert.deepEqual(doc.variables.map((x) => x.id), [keep.id]);
    assert.deepEqual(doc.graphs[0].nodes.map((n) => n.id), ['other', 'p']);
    assert.deepEqual(doc.graphs[0].connections, []);
    assert.deepEqual(fn.nodes, []);
  });
});
