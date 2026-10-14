// What happens when a project function's code changes (docs/code-as-nodes.md, "When the code
// changes"): stored signatures, status, Refresh Node and Replace with.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyNodes, pasteNodes } from '../../src/core/clipboard';
import { lowerDocument } from '../../src/core/compiler/lower';
import { functionStatus, rebindFunctionNode, signatureChanges, syncImportedFunctions } from '../../src/core/imported-functions';
import { NodeDefinition, PinDefinition } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
import { doc, node, wire } from './helpers';

const data = (id: string, direction: 'input' | 'output', type = 'float'): PinDefinition => ({ id, name: id, kind: 'data', direction, type: { id: type } });

// A project function: impure unless `pure`, with the given parameters and an optional return.
function fn(name: string, params: [string, string][], returns: string | null = 'float', options: { pure?: boolean; path?: string; title?: string } = {}): NodeDefinition {
  const path = options.path ?? 'lib/score.ts';
  return {
    type: `fn:typescript:${path}#${name}`, version: 1, displayName: options.title ?? name, category: 'Project / score',
    inputs: [...(options.pure ? [] : [{ id: 'execIn', name: '', kind: 'exec' as const, direction: 'input' as const }]), ...params.map(([id, type]) => data(id, 'input', type))],
    outputs: [...(options.pure ? [] : [{ id: 'execOut', name: '', kind: 'exec' as const, direction: 'output' as const }]), ...(returns ? [data('returnValue', 'output', returns)] : [])],
    implementation: { kind: 'function', language: 'typescript', path, name }
  };
}

describe('signature changes', () => {
  const base = fn('score', [['a', 'float'], ['b', 'string']]);

  test('titles, categories and descriptions are not changes', () => {
    assert.deepEqual(signatureChanges(base, { ...fn('score', [['a', 'float'], ['b', 'string']], 'float', { title: 'New Title' }), description: 'New' }), []);
  });

  test('parameters added, removed, retyped and reordered', () => {
    assert.deepEqual(signatureChanges(base, fn('score', [['a', 'float'], ['c', 'int']])), ['parameter "b" was removed', 'parameter "c" was added']);
    assert.deepEqual(signatureChanges(base, fn('score', [['a', 'int'], ['b', 'string']])), ['parameter "a" is now int (was float)']);
    assert.deepEqual(signatureChanges(base, fn('score', [['b', 'string'], ['a', 'float']])), ['its parameters were reordered']);
  });

  test('return value and purity', () => {
    assert.deepEqual(signatureChanges(base, fn('score', [['a', 'float'], ['b', 'string']], null)), ['it no longer returns a value']);
    assert.deepEqual(signatureChanges(base, fn('score', [['a', 'float'], ['b', 'string']], 'string')), ['it now returns string (was float)']);
    assert.deepEqual(signatureChanges(base, fn('score', [['a', 'float'], ['b', 'string']], 'float', { pure: true })), ['it is now pure (no exec pins)']);
  });
});

describe('function status', () => {
  const stored = fn('applyDamage', [['amount', 'float']]);
  const all = (...defs: NodeDefinition[]) => () => defs;

  test('current, changed, or missing', () => {
    assert.equal(functionStatus(stored, stored, all()).state, 'current');
    assert.equal(functionStatus(undefined, stored, all()).state, 'current', 'nothing stored yet');
    const changed = functionStatus(stored, fn('applyDamage', [['amount', 'int']]), all());
    assert.ok(changed.state === 'changed' && changed.changes.length === 1);
    assert.deepEqual(functionStatus(stored, undefined, all()), { state: 'missing', candidates: [] });
  });

  test('a renamed or moved function with the same signature is offered as a replacement', () => {
    const renamed = fn('dealDamage', [['amount', 'float']]);
    const moved = fn('applyDamage', [['amount', 'float']], 'float', { path: 'lib/combat.ts' });
    const unrelated = fn('heal', [['amount', 'float']], 'float', { path: 'lib/other.ts' });
    const different = fn('dealMore', [['amount', 'int']]);
    const status = functionStatus(stored, undefined, all(renamed, moved, unrelated, different));
    assert.deepEqual(status.state === 'missing' && status.candidates.map((c) => c.type), [renamed.type, moved.type]);
  });
});

describe('stored signatures', () => {
  const old = fn('score', [['a', 'float']]);
  const changed = fn('score', [['a', 'float'], ['bonus', 'int']]);

  test('the resolver keeps the stored pins while the code differs, and follows cosmetic changes', () => {
    const registry = new NodeRegistry();
    registry.register(changed);
    const resolve = createResolver(registry, { variables: [], importedFunctions: { [old.type]: old } });
    assert.deepEqual(resolve(node('n', old.type))?.inputs.map((p) => p.id), ['execIn', 'a']);
    const retitled = { ...old, displayName: 'Score It' };
    registry.register(retitled);
    assert.equal(resolve(node('n', old.type))?.displayName, 'Score It');
  });

  test('a missing function still resolves to its stored signature', () => {
    assert.ok(createResolver(new NodeRegistry(), { variables: [], importedFunctions: { [old.type]: old } })(node('n', old.type)));
  });

  test('sync records used functions, drops unused ones, keeps stale ones and takes cosmetic updates', () => {
    const unused = fn('unused', []);
    const d = doc([node('n', old.type), node('m', 'fn:typescript:lib/new.ts#fresh')], []);
    d.importedFunctions = { [old.type]: old, [unused.type]: unused };
    const fresh = fn('fresh', [], null, { path: 'lib/new.ts' });
    const current = new Map([[old.type, changed], [fresh.type, fresh]]);
    assert.equal(syncImportedFunctions(d, (t) => current.get(t)), true);
    assert.deepEqual(Object.keys(d.importedFunctions ?? {}).sort(), [fresh.type, old.type].sort());
    assert.equal(d.importedFunctions![old.type], old, 'kept, so the node keeps its pins until refreshed');
    current.set(old.type, { ...old, displayName: 'Renamed' });
    syncImportedFunctions(d, (t) => current.get(t));
    assert.equal(d.importedFunctions![old.type].displayName, 'Renamed');
    assert.equal(syncImportedFunctions(d, (t) => current.get(t)), false, 'nothing left to change');
  });

  test('a document without project functions stores none', () => {
    const d = doc([node('s', 'core:event.start')], []);
    assert.equal(syncImportedFunctions(d, () => undefined), false);
    assert.equal(d.importedFunctions, undefined);
  });
});

describe('Refresh Node and Replace with', () => {
  test('wires on pins that still fit are kept; the rest, and typed values on removed pins, go', () => {
    const old = fn('score', [['a', 'float'], ['b', 'float']]);
    const next = fn('score', [['a', 'float'], ['b', 'string']]);
    const registry = new NodeRegistry();
    registry.register(next);
    const d = doc([node('s', 'core:event.start'), node('add', 'core:math.add'), node('f', old.type, { 'pin:b': 2, 'pin:gone': 1 }), node('p', 'core:console.print')], [
      wire('s', 'execOut', 'f', 'execIn'), wire('add', 'result', 'f', 'a'), wire('add', 'result', 'f', 'b'), wire('f', 'returnValue', 'p', 'value')
    ]);
    const graph = d.graphs[0];
    const removed = rebindFunctionNode(graph, graph.nodes[2], next, createResolver(registry, { variables: [] }));
    assert.deepEqual(removed, ['add.result->f.b'], 'a float wire into what is now a string pin');
    assert.equal(graph.connections.length, 3);
    assert.deepEqual(graph.nodes[2].properties, { 'pin:b': 2 });
  });

  test('replacing points the node at the new function', () => {
    const old = fn('applyDamage', [['amount', 'float']]);
    const renamed = fn('dealDamage', [['amount', 'float']]);
    const d = doc([node('s', 'core:event.start'), node('f', old.type)], [wire('s', 'execOut', 'f', 'execIn')]);
    const registry = new NodeRegistry();
    registry.register(renamed);
    assert.deepEqual(rebindFunctionNode(d.graphs[0], d.graphs[0].nodes[1], renamed, createResolver(registry, { variables: [] })), []);
    assert.equal(d.graphs[0].nodes[1].type, renamed.type);
  });
});

describe('compiling nodes whose function changed', () => {
  const lower = (registry: NodeRegistry, stored: NodeDefinition) => {
    const d = doc([node('s', 'core:event.start'), node('f', stored.type)], [wire('s', 'execOut', 'f', 'execIn')]);
    d.importedFunctions = { [stored.type]: stored };
    return lowerDocument(d, { registry, languageName: 'TypeScript', snippetLanguages: ['typescript'], importLanguages: ['typescript', 'javascript'] });
  };
  const old = fn('applyDamage', [['amount', 'float']]);

  test('a changed signature is an error until the node is refreshed', () => {
    const registry = new NodeRegistry();
    registry.register(fn('applyDamage', [['amount', 'float'], ['crit', 'bool']]));
    const result = lower(registry, old);
    assert.deepEqual(result.diagnostics.map((d) => [d.code, d.nodeId]), [['function-changed', 'f']]);
    assert.match(result.diagnostics[0].message, /applyDamage in lib\/score\.ts changed: parameter "crit" was added\. Right-click the node and choose Refresh Node\./);
  });

  test('a missing function is an error that names a likely replacement', () => {
    const registry = new NodeRegistry();
    registry.register(fn('dealDamage', [['amount', 'float']], 'float', { title: 'Deal Damage' }));
    const result = lower(registry, old);
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['function-missing']);
    assert.match(result.diagnostics[0].message, /no longer exists, or is no longer marked @blueprint\. Was it renamed or moved to dealDamage in lib\/score\.ts\? Right-click the node and choose Replace with Deal Damage\./);
  });

  test('an unchanged function compiles', () => {
    const registry = new NodeRegistry();
    registry.register(old);
    assert.deepEqual(lower(registry, old).diagnostics, []);
  });
});

describe('copying nodes that call project functions', () => {
  test('the stored signature travels with them', () => {
    const old = fn('score', [['a', 'float']]);
    const from = doc([node('f', old.type)], []);
    from.importedFunctions = { [old.type]: old };
    const text = copyNodes(from, from.graphs[0], new Set(['f']))!;
    const to = doc([], []);
    pasteNodes(to, to.graphs[0], text, { x: 0, y: 0 }, { node: () => 'n1', connection: () => 'c1' });
    assert.deepEqual(to.importedFunctions, { [old.type]: old });
  });
});
