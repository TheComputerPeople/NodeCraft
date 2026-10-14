// Objects (docs/program-structure.md, "Classes"): their rules. The conformance suite runs a class
// using another on every target.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, GraphNode } from '../../src/core/model';
import { classDefinitions, declaredClass } from '../../src/core/objects';
import { NodeRegistry } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
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
