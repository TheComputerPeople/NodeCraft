import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeDefinition } from '../../src/core/model';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { readRepoFile } from './helpers';

const custom = (type: string, displayName = type): NodeDefinition => ({
  type, version: 1, displayName, category: 'Test', inputs: [], outputs: []
});

describe('NodeRegistry', () => {
  test('starts with the builtin nodes', () => {
    const registry = new NodeRegistry();
    for (const type of ['core:event.start', 'core:flow.branch', 'core:math.add', 'core:console.print']) {
      assert.ok(registry.get(type), `missing builtin ${type}`);
    }
  });

  test("setSource swaps a source's nodes but keeps builtins", () => {
    const registry = new NodeRegistry();
    registry.setSource('libraries', [custom('lib.a')]);
    registry.setSource('libraries', [custom('lib.b')]);
    assert.equal(registry.get('lib.a'), undefined);
    assert.ok(registry.get('lib.b'));
    assert.ok(registry.get('core:event.start'));
  });

  test('a library can override a builtin, and the override is dropped on reload', () => {
    const registry = new NodeRegistry();
    registry.setSource('libraries', [custom('core:math.add', 'Custom Add')]);
    assert.equal(registry.get('core:math.add')?.displayName, 'Custom Add');
    registry.setSource('libraries', []);
    assert.equal(registry.get('core:math.add')?.displayName, 'Add');
  });

  test('sources are independent: reloading one keeps the others', () => {
    const registry = new NodeRegistry();
    registry.setSource('libraries', [custom('lib.a')]);
    registry.setSource('functions', [custom('fn.a')]);
    registry.setSource('libraries', []);
    assert.equal(registry.get('lib.a'), undefined);
    assert.ok(registry.get('fn.a'));
  });

  test('notifies listeners on reload until disposed', () => {
    const registry = new NodeRegistry();
    let calls = 0;
    const subscription = registry.onDidChange(() => calls++);
    registry.setSource('libraries', []);
    subscription.dispose();
    registry.setSource('libraries', []);
    assert.equal(calls, 1);
  });
});

describe('parseNodeDefinition', () => {
  test('accepts the sample library node', () => {
    assert.equal(parseNodeDefinition(readRepoFile('sample/visual-nodes/Math/Double.node.json'))?.type, 'user.math.double');
  });

  test('rejects JSON that is not a node definition', () => {
    assert.equal(parseNodeDefinition('{"type":"x"}'), undefined);
    assert.equal(parseNodeDefinition('null'), undefined);
  });
});

describe('built-in node definitions', () => {
  test('every pin id is unique within its node, so wires are unambiguous', () => {
    for (const def of new NodeRegistry().all()) {
      const ids = [...def.inputs, ...def.outputs].map((p) => p.id);
      assert.equal(new Set(ids).size, ids.length, `${def.type} repeats a pin id: ${ids.join(', ')}`);
    }
  });
});
