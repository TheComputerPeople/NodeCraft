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
    assert.deepEqual(fn.nodes.map((n) => n.type), ['core:function.entry'], 'the function keeps its entry node');
  });
});

describe('function signatures', () => {
  const withCall = () => {
    const doc = fresh();
    const fn = edits.addGraph(doc, 'function');
    const input = edits.addSignaturePin(doc, fn.id, 'inputs', { id: 'float' })!;
    doc.graphs[0].nodes.push(node('call', 'core:function.call', { graph: fn.id, [`pin:${input.id}`]: 3 }), node('s', 'core:event.start'), node('n', 'core:math.add'));
    doc.graphs[0].connections.push(wire('s', 'execOut', 'call', 'execIn'), wire('n', 'result', 'call', input.id));
    return { doc, fn, input };
  };

  test('a new function starts with its entry node; its first output adds a wired Return Node', () => {
    const { doc, fn } = withCall();
    assert.deepEqual(fn.nodes.map((n) => n.type), ['core:function.entry']);
    edits.addSignaturePin(doc, fn.id, 'outputs');
    assert.deepEqual(fn.nodes.map((n) => n.type), ['core:function.entry', 'core:function.return']);
    assert.deepEqual(fn.connections.map((c) => `${c.fromNode}.${c.fromPin}->${c.toNode}.${c.toPin}`), ['entry.execOut->return.execIn']);
    edits.addSignaturePin(doc, fn.id, 'outputs');
    assert.equal(fn.nodes.length, 2, 'only the first output adds one');
  });

  test('renaming keeps names unique; retyping or removing a parameter drops its wires and values', () => {
    const { doc, fn, input } = withCall();
    edits.addSignaturePin(doc, fn.id, 'inputs');
    assert.match(edits.renameSignaturePin(doc, fn.id, 'inputs', input.id, 'NewParam_1') ?? '', /already a parameter/);
    assert.equal(edits.renameSignaturePin(doc, fn.id, 'inputs', input.id, 'Amount'), undefined);
    edits.setSignaturePinType(doc, fn.id, 'inputs', input.id, { id: 'int' });
    assert.deepEqual(doc.graphs[0].connections.map((c) => c.toPin), ['execIn'], 'the data wire is gone');
    assert.equal(doc.graphs[0].nodes[0].properties[`pin:${input.id}`], undefined);
    edits.removeSignaturePin(doc, fn.id, 'inputs', input.id);
    assert.deepEqual(fn.signature!.inputs.map((p) => p.name), ['NewParam_1']);
  });

  test('making a function pure removes its calls\' exec wires', () => {
    const { doc, fn } = withCall();
    edits.setFunctionPure(doc, fn.id, true);
    assert.equal(fn.signature!.pure, true);
    assert.deepEqual(doc.graphs[0].connections.map((c) => c.toPin), ['NewParam']);
    assert.equal(edits.functionUses(doc, fn.id), 1);
  });

  test('local variables belong to their function and are found, renamed and deleted like members', () => {
    const doc = fresh();
    const fn = edits.addGraph(doc, 'function');
    const local = edits.addLocalVariable(doc, fn.id, { id: 'int' });
    assert.equal(edits.findVariable(doc, local.id)?.graph, fn);
    assert.equal(edits.renameVariable(doc, local.id, 'Total'), undefined);
    edits.setVariableType(doc, local.id, { id: 'float' });
    assert.deepEqual([fn.localVariables![0].name, fn.localVariables![0].type], ['Total', { id: 'float' }]);
    fn.nodes.push(node('get', 'core:variable.get', { variable: local.id }));
    assert.equal(edits.deleteVariable(doc, local.id), 1);
    assert.deepEqual(fn.localVariables, []);
    assert.throws(() => edits.addLocalVariable(doc, doc.graphs[0].id), /Only functions/);
  });
});
