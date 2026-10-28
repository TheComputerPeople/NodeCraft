import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as edits from '../../src/core/blueprint-edits';
import { GraphDocument, RuntimeLogEvent } from '../../src/core/model';
import { libraryDefinitions } from '../../src/core/libraries';
import { GraphRuntime } from '../../src/core/runtime';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { NodeRegistry } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
import { createEmptyDocument } from '../../src/core/serializer';
import { logs, node, run, wire } from './helpers';

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

describe('Collapse to Function', () => {
  // Start → Add(10, 20) → Print(Add) → Print(Max(Add, 25)) → End.
  const program = (): GraphDocument => {
    const doc = fresh();
    doc.language = 'typescript';
    const g = doc.graphs[0];
    g.nodes = [
      node('s', 'core:event.start'), node('add', 'core:math.add'), node('p1', 'core:console.print'),
      node('max', 'core:math.max', { 'pin:b': 25 }), node('p2', 'core:console.print'), node('end', 'core:flow.end')
    ];
    g.connections = [
      wire('s', 'execOut', 'add', 'execIn'), wire('add', 'execOut', 'p1', 'execIn'), wire('p1', 'execOut', 'p2', 'execIn'), wire('p2', 'execOut', 'end', 'execIn'),
      wire('add', 'result', 'p1', 'value'), wire('add', 'result', 'max', 'a'), wire('max', 'returnValue', 'p2', 'value')
    ];
    return doc;
  };
  const registry = new NodeRegistry();
  let n = 0;
  const ids = () => `c${++n}`;
  const collapse = (doc: GraphDocument, selection: string[]) => edits.collapseToFunction(doc, doc.graphs[0], new Set(selection), createResolver(registry, doc), ids);
  const runs = (doc: GraphDocument) => logs(run(doc, registry));
  const compiles = (doc: GraphDocument) => compileDocument(doc, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'x.vgraph' } }).diagnostics.filter((d) => d.severity === 'error');

  test('a chain with exec in and out: the program does the same', () => {
    const doc = program();
    const before = runs(doc);
    const result = collapse(doc, ['add', 'p1']);
    assert.ok(typeof result !== 'string', String(result));
    assert.deepEqual(result.function.signature!.inputs, []);
    assert.deepEqual(result.function.signature!.outputs.map((p) => p.name), ['Result'], 'Add feeds Max outside');
    assert.deepEqual(doc.graphs[0].nodes.map((x) => x.id).sort(), ['call_NewFunction', 'end', 'max', 'p2', 's']);
    assert.deepEqual(runs(doc), before);
    assert.deepEqual(compiles(doc), []);
  });

  test('pure nodes become a pure function with an input per outside value', () => {
    const doc = program();
    const before = runs(doc);
    const result = collapse(doc, ['max']);
    assert.ok(typeof result !== 'string', String(result));
    assert.equal(result.function.signature!.pure, true);
    assert.deepEqual(result.function.signature!.inputs.map((p) => p.name), ['A']);
    assert.deepEqual(runs(doc), before);
    assert.deepEqual(compiles(doc), []);
  });

  test('selections that cannot be collapsed say why', () => {
    assert.match(String(collapse(program(), ['s', 'add'])), /Events/);
    const branchy = program();
    branchy.graphs[0].nodes.push(node('q', 'core:flow.sequence', { pins: 2 }));
    branchy.graphs[0].connections = branchy.graphs[0].connections.filter((c) => c.toNode !== 'p2' || c.toPin !== 'execIn');
    branchy.graphs[0].connections.push(wire('q', 'then0', 'add', 'execIn'), wire('q', 'then1', 'p2', 'execIn'));
    assert.match(String(collapse(branchy, ['add', 'p2'])), /more than one place/);
  });

  // Collapse to Function in Library (docs/node-authoring.md, gap 10): the function goes into a
  // library, and the call is its library node, whose pins are the new function's.
  test('into a library: the function moves there and its library node is called', () => {
    const doc = program();
    const library: GraphDocument = { ...edits.newDocument('Tools', 'typescript', 'functionLibrary'), graphs: [] };
    const result = edits.collapseToLibraryFunction(doc, doc.graphs[0], new Set(['max']), createResolver(registry, doc), ids, library, 'lib/Tools.vgraph');
    assert.ok(typeof result !== 'string', String(result));
    assert.deepEqual(library.graphs.map((g) => g.id), [result.function.id]);
    assert.ok(!doc.graphs.some((g) => g.id === result.function.id), 'the blueprint gains no function');
    assert.equal(result.call.type, `lib:lib/Tools.vgraph#${result.function.id}`);
    // Calling it through the library gives the same program.
    const r = new NodeRegistry();
    r.registerMany(libraryDefinitions(library, { documentPath: 'lib/Tools.vgraph', generatedPath: 'lib/Tools.vgraph.ts', exports: { names: new Map([[result.function.id, 'newFunction']]) } }));
    const events: RuntimeLogEvent[] = [];
    new GraphRuntime(r, (e) => events.push(e), undefined, () => library).run(doc);
    assert.deepEqual(logs(events), runs(program()));
  });

  test("into a library: a selection using the blueprint's members can't move", () => {
    const doc = program();
    const health = edits.addVariable(doc);
    doc.graphs[0].nodes.push(node('get', 'core:variable.get', { variable: health.id }));
    const library: GraphDocument = { ...edits.newDocument('Tools', 'typescript', 'functionLibrary'), graphs: [] };
    const result = edits.collapseToLibraryFunction(doc, doc.graphs[0], new Set(['get', 'max']), createResolver(registry, doc), ids, library, 'lib/Tools.vgraph');
    assert.match(String(result), /own variables, functions, macros or events/);
    assert.deepEqual(library.graphs, []);
  });
});
