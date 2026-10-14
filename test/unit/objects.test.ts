// Objects (docs/program-structure.md, "Classes"): their rules. The conformance suite runs a class
// using another on every target.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, GraphNode } from '../../src/core/model';
import { classDefinitions, declaredClass, declaredInterface, interfaceDefinitions } from '../../src/core/objects';
import { NodeRegistry } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
import { GraphRuntime } from '../../src/core/runtime';
import { RuntimeLogEvent } from '../../src/core/model';
import { logs, node, run, wire } from './helpers';

const other: GraphDocument = {
  schemaVersion: 3, name: 'Other', kind: 'class', language: 'javascript', variables: [{ id: 'score', name: 'Score', type: { id: 'int' }, defaultValue: 7 }],
  graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [], connections: [] }]
};

function registry(): NodeRegistry {
  const r = new NodeRegistry();
  r.registerMany(classDefinitions(declaredClass(other, { document: 'Other.vgraph', generatedPath: 'Other.vgraph.js' })!));
  return r;
}

function doc(nodes: GraphNode[], connections: GraphDocument['graphs'][number]['connections'], variables: GraphDocument['variables'] = []): GraphDocument {
  return { schemaVersion: 3, name: 'Game', kind: 'class', language: 'javascript', variables, graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes, connections }] };
}

const errors = (d: GraphDocument) => compileDocument(d, { registry: registry(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'Game.vgraph' } }).diagnostics
  .filter((x) => x.severity === 'error').map((x) => `${x.code}@${x.nodeId}`);

describe('objects', () => {
  test('Self has the class\'s type; a member node takes a Target of its class', () => {
    const d = doc([node('self', 'core:object.self'), node('get', 'core:object.get', { class: 'object:Other', variable: 'score' })], []);
    const resolve = createResolver(registry(), d);
    assert.deepEqual(resolve(d.graphs[0].nodes[0])!.outputs[0].type, { id: 'object:Game' });
    const get = resolve(d.graphs[0].nodes[1])!;
    assert.deepEqual([get.displayName, get.inputs.map((p) => [p.id, p.type?.id]), get.outputs.map((p) => [p.id, p.type?.id])], ['Score', [['target', 'object:Other']], [['value', 'int']]]);
  });

  test('another class\'s member needs a Target; the own class\'s defaults to Self', () => {
    const d = doc([
      node('s', 'core:event.start'), node('get', 'core:object.get', { class: 'object:Other', variable: 'score' }), node('p', 'core:console.print'),
      node('own', 'core:object.get', { class: 'object:Game', variable: 'mine' }), node('p2', 'core:console.print')
    ], [wire('s', 'execOut', 'p', 'execIn'), wire('get', 'value', 'p', 'value'), wire('p', 'execOut', 'p2', 'execIn'), wire('own', 'value', 'p2', 'value')], [{ id: 'mine', name: 'Mine', type: { id: 'int' }, defaultValue: 4 }]);
    assert.deepEqual(errors(d), ['target-missing@get']);
    d.graphs[0].connections = d.graphs[0].connections.filter((c) => c.toNode !== 'p');
    d.graphs[0].connections.push(wire('s', 'execOut', 'p2', 'execIn'));
    assert.deepEqual(errors(d), []);
    assert.deepEqual(logs(run(d, registry())), ['4']);
  });

  test('a missing class and printing an object are errors', () => {
    const d = doc([
      node('s', 'core:event.start'), node('self', 'core:object.self'), node('p', 'core:console.print'),
      node('gone', 'core:object.set', { class: 'object:Gone', variable: 'x' })
    ], [wire('s', 'execOut', 'p', 'execIn'), wire('self', 'self', 'p', 'value'), wire('p', 'execOut', 'gone', 'execIn')]);
    assert.deepEqual(errors(d), ['class-missing@gone']);
    d.graphs[0].nodes.pop();
    assert.deepEqual(errors(d), ['print-object@p']);
  });

  test('Simulate stops on an empty Target, as Unreal does on "Accessed None"', () => {
    const d = doc([node('s', 'core:event.start'), node('get', 'core:variable.get', { variable: 'o' }), node('set', 'core:object.set', { class: 'object:Other', variable: 'score' })],
      [wire('s', 'execOut', 'set', 'execIn'), wire('get', 'value', 'set', 'target')], [{ id: 'o', name: 'O', type: { id: 'object:Other' } }]);
    const error = run(d, registry()).find((e) => e.kind === 'error');
    assert.deepEqual([error?.nodeId, error?.message], ['set', 'Accessed None: Target has no Other.']);
  });

  test('Construct makes an object of the own class, and Is Valid tells set from empty', () => {
    const d = doc([
      node('s', 'core:event.start'), node('c', 'object:Game.construct'), node('set', 'core:variable.set', { variable: 'o' }),
      node('get', 'core:variable.get', { variable: 'o' }), node('valid', 'core:object.is-valid'), node('p', 'core:console.print')
    ], [wire('s', 'execOut', 'p', 'execIn'), wire('get', 'value', 'valid', 'object'), wire('valid', 'returnValue', 'p', 'value')], [{ id: 'o', name: 'O', type: { id: 'object:Game' } }]);
    const r = registry();
    r.registerMany(classDefinitions(declaredClass(d)!));
    assert.deepEqual(logs(run(d, r)), ['false']);
  });
});

describe('inheritance', () => {
  const base: GraphDocument = {
    schemaVersion: 3, name: 'Base', kind: 'class', language: 'javascript', variables: [{ id: 'hp', name: 'HP', type: { id: 'int' } }],
    graphs: [
      // Start calls Greet: the subclass's Greet runs, as calls are virtual.
      { id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [node('s', 'core:event.start'), node('g', 'core:function.call', { graph: 'Greet' })], connections: [wire('s', 'execOut', 'g', 'execIn')] },
      {
        id: 'Greet', name: 'Greet', kind: 'function', comments: [], signature: { inputs: [], outputs: [] },
        nodes: [node('entry', 'core:function.entry', { graph: 'Greet' }), node('p', 'core:console.print', { 'pin:value': 'base' })], connections: [wire('entry', 'execOut', 'p', 'execIn')]
      }
    ]
  };
  const child = (graphs: GraphDocument['graphs'], variables: GraphDocument['variables'] = []): GraphDocument => ({
    schemaVersion: 3, name: 'Child', kind: 'class', language: 'javascript', parent: 'object:Base', variables, graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [], connections: [] }, ...graphs]
  });
  const withBase = (): NodeRegistry => {
    const r = new NodeRegistry();
    r.registerMany(classDefinitions(declaredClass(base, { document: 'Base.vgraph', generatedPath: 'Base.vgraph.js' })!));
    return r;
  };
  const errorsOf = (d: GraphDocument, r = withBase()) => compileDocument(d, { registry: r, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Child.vgraph' } }).diagnostics
    .filter((x) => x.severity === 'error').map((x) => x.code);

  test('the parent must exist; members must not take its names; overrides keep its signature', () => {
    assert.deepEqual(errorsOf(child([]), new NodeRegistry()), ['parent-missing']);
    assert.deepEqual(errorsOf(child([], [{ id: 'hp2', name: 'HP', type: { id: 'int' } }])), ['inherited-name']);
    const greet = (inputs: GraphDocument['graphs'][number]['signature']) => ({ id: 'Greet2', name: 'Greet', kind: 'function' as const, comments: [], signature: inputs, nodes: [node('entry', 'core:function.entry', { graph: 'Greet2' })], connections: [] });
    assert.deepEqual(errorsOf(child([greet({ inputs: [], outputs: [] })])), []);
    assert.deepEqual(errorsOf(child([greet({ inputs: [{ id: 'x', name: 'X', kind: 'data', type: { id: 'int' } }], outputs: [] })])), ['override-mismatch']);
  });

  test('a class can\'t inherit from itself', () => {
    const r = new NodeRegistry();
    const a = { ...base, name: 'A', parent: 'object:B' };
    const b = { ...base, name: 'B', parent: 'object:A' };
    r.registerMany([...classDefinitions(declaredClass(a)!), ...classDefinitions(declaredClass(b)!)]);
    assert.ok(errorsOf(a, r).includes('parent-loop'));
  });

  test('the parent\'s own calls run the override; Parent runs the parent\'s version', () => {
    const r = withBase();
    const d = child([{
      id: 'Greet2', name: 'Greet', kind: 'function', comments: [], signature: { inputs: [], outputs: [] },
      nodes: [node('entry', 'core:function.entry', { graph: 'Greet2' }), node('p', 'core:console.print', { 'pin:value': 'child' }), node('parent', 'core:object.parent', { function: 'Greet' })],
      connections: [wire('entry', 'execOut', 'p', 'execIn'), wire('p', 'execOut', 'parent', 'execIn')]
    }]);
    const events: RuntimeLogEvent[] = [];
    new GraphRuntime(r, (e) => events.push(e), undefined, (file) => (file === 'Base.vgraph' ? base : undefined)).run(d);
    assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.message), ['child', 'base']);
    assert.match(compileDocument(d, { registry: r, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Child.vgraph' } }).output!.text, /class Child extends Base \{[\s\S]*greet\(\) \{[\s\S]*super\.greet\(\);/);
  });
});

describe('interfaces', () => {
  const usable: GraphDocument = {
    schemaVersion: 3, name: 'Usable', kind: 'interface', language: 'javascript', variables: [],
    graphs: [{ id: 'Use', name: 'Use', kind: 'function', comments: [], signature: { inputs: [], outputs: [{ id: 'ok', name: 'OK', kind: 'data', type: { id: 'bool' } }] }, nodes: [], connections: [] }]
  };
  const withUsable = (): NodeRegistry => {
    const r = new NodeRegistry();
    r.registerMany(interfaceDefinitions(declaredInterface(usable)!));
    return r;
  };
  const errorsOf = (d: GraphDocument) => compileDocument(d, { registry: withUsable(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'T.vgraph' } }).diagnostics
    .filter((x) => x.severity === 'error').map((x) => x.code);

  test('an implemented interface must exist, and its functions keep their signatures', () => {
    const d = doc([], []);
    d.interfaces = ['interface:Gone'];
    assert.deepEqual(errorsOf(d), ['interface-missing']);
    d.interfaces = ['interface:Usable'];
    d.graphs.push({ id: 'Use', name: 'Use', kind: 'function', comments: [], signature: { inputs: [], outputs: [] }, nodes: [node('entry', 'core:function.entry', { graph: 'Use' })], connections: [] });
    assert.deepEqual(errorsOf(d), ['interface-mismatch']);
  });

  test('an unimplemented interface function gets an empty body that returns defaults', () => {
    const d = doc([], []);
    d.interfaces = ['interface:Usable'];
    const { output } = compileDocument(d, { registry: withUsable(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'Game.vgraph' } });
    assert.match(output!.text, /\[UsableTag\] = true;[\s\S]*use\(\) \{\s*return false;\s*\}/);
  });

  test('an object of a class that implements it wires into an interface pin', () => {
    const r = withUsable();
    const d = doc([node('self', 'core:object.self'), node('call', 'core:interface.call', { interface: 'interface:Usable', function: 'Use' })], [wire('self', 'self', 'call', 'target')]);
    d.interfaces = ['interface:Usable'];
    r.registerMany(classDefinitions(declaredClass(d)!));
    assert.deepEqual(compileDocument(d, { registry: r, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Game.vgraph' } }).diagnostics.filter((x) => x.code === 'type-mismatch'), []);
    delete d.interfaces;
    assert.ok(compileDocument(d, { registry: withUsable(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'Game.vgraph' } }).diagnostics.some((x) => x.code === 'type-mismatch'));
  });
});
