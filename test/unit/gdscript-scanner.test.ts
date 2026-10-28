// GDScript symbol import (src/core/importing/gdscript-scanner.ts, docs/more-languages.md "GDScript"):
// static functions marked ## @blueprint become nodes, typed by their annotations.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { mapGdscriptType, scanGdscript } from '../../src/core/importing/gdscript-scanner';

const SCRIPT = [
  'extends RefCounted',
  '',
  '## Triples a value.',
  '## @blueprint',
  '## @category Scores',
  'static func triple(value: float) -> float:',
  '\treturn value * 3',
  '',
  '## @blueprint pure',
  '@warning_ignore("unused_parameter")',
  'static func label(name: String, points: int = 5, tags: Array[String] = []) -> String:',
  '\treturn name + ": " + str(points)',
  '',
  '## @blueprint',
  'func heal(amount: int) -> void:',
  '\tpass',
  '',
  '## @blueprint',
  'static func _secret() -> void:',
  '\tpass',
  '',
  'static func untyped(x, y := 2):',
  '\treturn x',
  '',
  'class Inner:',
  '\t## @blueprint',
  '\tstatic func hidden() -> void:',
  '\t\tpass',
  ''
].join('\n');

describe('GDScript scanner', () => {
  test('finds static functions, with their types and defaults', () => {
    const scan = scanGdscript(SCRIPT);
    assert.deepEqual(scan.functions.map((f) => [f.name, f.line, f.params, f.returns]), [
      ['triple', 6, [{ name: 'value', type: { id: 'float' } }], { id: 'float' }],
      ['label', 11, [{ name: 'name', type: { id: 'string' } }, { name: 'points', type: { id: 'int' }, defaultValue: 5 }, { name: 'tags', type: { id: 'string', container: 'array' } }], { id: 'string' }],
      ['untyped', 22, [{ name: 'x' }, { name: 'y', defaultValue: 2 }], undefined]
    ]);
    assert.equal(scan.functions[0].doc.description, 'Triples a value.');
    assert.deepEqual(scan.functions[1].doc.tags.map((t) => t.name), ['blueprint'], 'annotations between the comment and the function are skipped');
  });

  test("says why marked functions can't be nodes", () => {
    assert.deepEqual(scanGdscript(SCRIPT).skipped.filter((s) => s.marked).map((s) => [s.name, s.reason]), [
      ['heal', "It isn't static: generated code calls functions on the script, without an object."],
      ['_secret', 'Its name starts with _ (private).']
    ]);
  });

  test('marked functions become nodes, pure ones without exec pins', () => {
    const { definitions } = exposeFunctions(scanGdscript(SCRIPT), { language: 'gdscript', path: 'lib/scores.gd', exposeAll: false });
    assert.deepEqual(definitions.map((d) => [d.type, d.displayName, d.category, d.inputs.filter((p) => p.kind === 'exec').length]), [
      ['fn:gdscript:lib/scores.gd#triple', 'Triple', 'Scores', 1],
      ['fn:gdscript:lib/scores.gd#label', 'Label', 'Project / scores', 0]
    ]);
  });

  test('maps GDScript types to pin types', () => {
    assert.deepEqual(['int', 'float', 'bool', 'String', 'StringName', 'Variant', 'void', 'Array', 'Array[int]', 'Dictionary[String, float]', 'Node2D'].map(mapGdscriptType), [
      { id: 'int' }, { id: 'float' }, { id: 'bool' }, { id: 'string' }, { id: 'string' }, { id: 'any' }, null, { id: 'any', container: 'array' },
      { id: 'int', container: 'array' }, { id: 'string', container: 'map', valueType: { id: 'float' } }, { id: 'native:Node2D' }
    ]);
  });
});
