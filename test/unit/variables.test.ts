import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateV2ToV3 } from '../../src/core/migrations';
import { GraphDocument } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { VARIABLE_GET, VARIABLE_SET, createResolver } from '../../src/core/resolve';
import { node, wire } from './helpers';

const registry = new NodeRegistry();

function v2(nodes: GraphDocument['graphs'][0]['nodes'], connections: GraphDocument['graphs'][0]['connections'] = [], extra: Partial<GraphDocument> = {}): GraphDocument {
  return {
    schemaVersion: 2, name: 'Old', kind: 'class', language: 'javascript', variables: [],
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', nodes, connections, comments: [] }],
    ...extra
  };
}

describe('variable nodes resolve from their variable', () => {
  const resolve = createResolver(registry, [{ id: 'v1', name: 'Health', type: { id: 'float' }, description: 'Hit points' }]);

  test('Get shows the variable name and type, drawn compact', () => {
    const def = resolve(node('g', VARIABLE_GET, { variable: 'v1' }))!;
    assert.equal(def.displayName, 'Health');
    assert.equal(def.compact, true);
    assert.deepEqual(def.outputs.map((p) => [p.name, p.type]), [['Health', { id: 'float' }]]);
    assert.equal(def.description, 'Hit points');
  });

  test('Set takes and returns the variable type', () => {
    const def = resolve(node('s', VARIABLE_SET, { variable: 'v1' }))!;
    assert.equal(def.displayName, 'Set Health');
    assert.deepEqual(def.inputs.filter((p) => p.kind === 'data').map((p) => p.type), [{ id: 'float' }]);
    assert.deepEqual(def.outputs.filter((p) => p.kind === 'data').map((p) => p.type), [{ id: 'float' }]);
  });

  test('a node without its variable says so', () => {
    assert.equal(resolve(node('g', VARIABLE_GET, { variable: 'gone' }))?.displayName, 'Missing variable');
  });

  test('other nodes resolve to their registered definition', () => {
    assert.equal(resolve(node('a', 'core:math.add')), registry.get('core:math.add'));
    assert.equal(resolve(node('x', 'lib.unknown')), undefined);
  });
});

describe('migrating schema 2 to 3', () => {
  test('binds each node to the variable it named, declaring missing ones as any', () => {
    const doc = migrateV2ToV3(v2(
      [node('set', VARIABLE_SET, { 'pin:name': 'Score', 'pin:value': 1 }), node('get', VARIABLE_GET, { 'pin:name': 'Lives' })],
      [],
      { variables: [{ id: 'v_lives', name: 'Lives', type: { id: 'int' } }] }
    ));
    assert.equal(doc.schemaVersion, 3);
    assert.deepEqual(doc.variables, [{ id: 'v_lives', name: 'Lives', type: { id: 'int' } }, { id: 'var_Score', name: 'Score', type: { id: 'any' } }]);
    const [set, get] = doc.graphs[0].nodes;
    assert.deepEqual(set.properties, { 'pin:value': 1, variable: 'var_Score' });
    assert.deepEqual(get.properties, { variable: 'v_lives' });
  });

  test('uses the old default name when the node had none', () => {
    const doc = migrateV2ToV3(v2([node('get', VARIABLE_GET)]));
    assert.equal(doc.variables[0].name, 'Score');
    assert.equal(doc.graphs[0].nodes[0].properties.variable, doc.variables[0].id);
  });

  test('leaves nodes with a wired name unbound and removes the wire', () => {
    const doc = migrateV2ToV3(v2(
      [node('key', VARIABLE_GET, { 'pin:name': 'Key' }), node('get', VARIABLE_GET)],
      [wire('key', 'value', 'get', 'name')]
    ));
    assert.deepEqual(doc.graphs[0].connections, []);
    assert.equal(doc.graphs[0].nodes[1].properties.variable, undefined);
  });

  test('does not declare variables in libraries', () => {
    const doc = migrateV2ToV3({
      ...v2([]), kind: 'functionLibrary',
      graphs: [{ id: 'F', name: 'F', kind: 'function', signature: { inputs: [], outputs: [] }, nodes: [node('get', VARIABLE_GET, { 'pin:name': 'X' })], connections: [], comments: [] }]
    });
    assert.deepEqual(doc.variables, []);
    assert.equal(doc.graphs[0].nodes[0].properties.variable, undefined);
  });
});
