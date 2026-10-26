// What a graph's language can't express is a compile error on the node that uses it
// (docs/language-breadth.md, "Capabilities, enforced").
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeRequirements } from '../../src/core/capabilities';
import { compileDocument } from '../../src/core/compiler';
import { LanguagePackRegistry } from '../../src/core/language-pack';
import { builtinLanguagePacks } from '../../src/core/languages';
import { javascriptPack } from '../../src/core/languages/javascript';
import { NodeRegistry } from '../../src/core/registry';
import { doc, node, wire } from './helpers';

// JavaScript's generator, but a language without latent actions, sets, maps, dispatchers or inheritance.
const limited = new LanguagePackRegistry([{
  ...javascriptPack, id: 'limited', displayName: 'Limited',
  capabilities: { ...javascriptPack.capabilities, async: false, inheritance: false, containers: ['array'], delegates: false }
}]);

describe('capabilities', () => {
  test('nodes need what their kind and pin types say', () => {
    const registry = new NodeRegistry();
    const needs = (type: string) => nodeRequirements(registry.get(type)!);
    assert.deepEqual(needs('core:latent.delay'), ['async']);
    assert.deepEqual(needs('core:set.make'), ['set']);
    assert.deepEqual(needs('core:console.print'), []);
    assert.deepEqual(needs('core:dispatcher.bind'), ['delegates']);
  });

  test("a graph using what its language can't express gets an error on each such node", () => {
    const d = doc(
      [node('s', 'core:event.start'), node('delay', 'core:latent.delay', { 'pin:duration': 1 }), node('set', 'core:set.make'), node('arr', 'core:array.make'), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'delay', 'execIn'), wire('delay', 'completed', 'p', 'execIn')],
      [{ id: 'v_m', name: 'Scores', type: { id: 'int', container: 'map', valueType: { id: 'int' } } }]
    );
    d.language = 'limited';
    d.parent = 'object:Base';
    const result = compileDocument(d, { registry: new NodeRegistry(), languages: limited, generate: { sourceFileName: 'T.vgraph' } });
    assert.equal(result.output, undefined);
    const errors = result.diagnostics.map((x) => [x.code, x.nodeId ?? '', x.message]);
    assert.ok(errors.every(([code]) => code === 'unsupported'), JSON.stringify(errors));
    assert.deepEqual(errors.map(([, nodeId]) => nodeId).sort(), ['', '', 'delay', 'set']);
    assert.ok(errors.some(([, , m]) => m === 'Limited has no latent actions such as Delay, so "Delay" can\'t be compiled to it.'));
    assert.ok(errors.some(([, , m]) => /no maps, so the variable "Scores"/.test(m)));
    assert.ok(errors.some(([, , m]) => /no inheritance, so a Parent Class/.test(m)));
  });

  test('the built-in languages express everything the editor offers', () => {
    for (const pack of builtinLanguagePacks().all()) {
      const caps = pack.capabilities;
      assert.ok(caps.classes && caps.inheritance && caps.interfaces && caps.async && caps.delegates !== false, pack.id);
      assert.deepEqual(caps.containers, ['array', 'set', 'map'], pack.id);
    }
  });
});
