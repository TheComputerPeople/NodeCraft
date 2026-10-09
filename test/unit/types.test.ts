import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { TypeRef, canConnect, formatType, normalizeTypeRef, parseTypeId } from '../../src/core/types';

const t = (id: string, extra: Partial<TypeRef> = {}): TypeRef => ({ id, ...extra });

describe('parseTypeId', () => {
  test('classifies primitives, any, wildcard and prefixed names', () => {
    assert.deepEqual(parseTypeId('float'), { category: 'primitive', name: 'float' });
    assert.deepEqual(parseTypeId('any'), { category: 'any', name: 'any' });
    assert.deepEqual(parseTypeId('wildcard'), { category: 'wildcard', name: 'wildcard' });
    assert.deepEqual(parseTypeId('struct:Vector'), { category: 'struct', name: 'Vector' });
    assert.deepEqual(parseTypeId('native:System.IO.Stream'), { category: 'native', name: 'System.IO.Stream' });
    assert.deepEqual(parseTypeId('mystery'), { category: 'unknown', name: 'mystery' });
  });
});

describe('normalizeTypeRef', () => {
  test('maps the legacy number id to float, including inside map values', () => {
    assert.deepEqual(normalizeTypeRef(t('number')), t('float'));
    assert.deepEqual(normalizeTypeRef(t('string', { container: 'map', valueType: t('number') })), t('string', { container: 'map', valueType: t('float') }));
  });

  test('returns canonical types unchanged', () => {
    const type = t('int', { container: 'array' });
    assert.equal(normalizeTypeRef(type), type);
  });
});

describe('canConnect', () => {
  test('same types connect; different primitives do not', () => {
    assert.equal(canConnect(t('string'), t('string')), true);
    assert.equal(canConnect(t('string'), t('bool')), false);
  });

  test('any and missing types connect to everything', () => {
    assert.equal(canConnect(t('any'), t('bool')), true);
    assert.equal(canConnect(t('struct:Vector', { container: 'array' }), t('any')), true);
    assert.equal(canConnect(undefined, t('bool')), true);
  });

  test('int and float connect both ways', () => {
    assert.equal(canConnect(t('int'), t('float')), true);
    assert.equal(canConnect(t('float'), t('int')), true);
  });

  test('wildcard connects to any element type', () => {
    assert.equal(canConnect(t('wildcard'), t('struct:Vector')), true);
  });

  test('containers must match, and so must map value types', () => {
    assert.equal(canConnect(t('int', { container: 'array' }), t('int', { container: 'array' })), true);
    assert.equal(canConnect(t('int', { container: 'array' }), t('int')), false);
    assert.equal(canConnect(t('int', { container: 'array' }), t('int', { container: 'set' })), false);
    assert.equal(canConnect(t('string', { container: 'map', valueType: t('int') }), t('string', { container: 'map', valueType: t('bool') })), false);
  });

  test('named types connect only to the same name', () => {
    assert.equal(canConnect(t('object:Player'), t('object:Player')), true);
    assert.equal(canConnect(t('object:Player'), t('object:Enemy')), false);
  });
});

describe('formatType', () => {
  test('renders containers, maps, prefixes and nullability', () => {
    assert.equal(formatType(undefined), 'any');
    assert.equal(formatType(t('float', { container: 'array' })), 'array<float>');
    assert.equal(formatType(t('string', { container: 'map', valueType: t('int') })), 'map<string, int>');
    assert.equal(formatType(t('object:Player', { nullable: true })), 'Player?');
  });
});

describe('legacy type ids in node definitions', () => {
  test('are normalized when a definition is registered', () => {
    const def = parseNodeDefinition(JSON.stringify({
      type: 'legacy.node', version: 1, displayName: 'Legacy', category: 'Test',
      inputs: [{ id: 'v', name: 'V', kind: 'data', direction: 'input', type: { id: 'number' } }], outputs: []
    }));
    assert.ok(def);
    const registry = new NodeRegistry();
    registry.register(def);
    assert.equal(registry.get('legacy.node')?.inputs[0].type?.id, 'float');
  });
});
