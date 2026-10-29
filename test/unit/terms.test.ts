// A language's terms (src/core/terms.ts, docs/language-context.md part 2): its words for containers
// in node names, and its spelling of types.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { builtinLanguagePacks } from '../../src/core/languages';
import { DEFAULT_TERMS, LANGUAGE_TERMS, NAME_TEMPLATES, localizeDefinition, typeText } from '../../src/core/terms';
import { TypeRef, formatType } from '../../src/core/types';

const types: TypeRef[] = [
  { id: 'int' }, { id: 'float' }, { id: 'string' }, { id: 'bool' }, { id: 'any' }, { id: 'int', nullable: true },
  { id: 'int', container: 'array' }, { id: 'string', container: 'set' }, { id: 'string', container: 'map', valueType: { id: 'float' } },
  { id: 'struct:Point' }, { id: 'object:Enemy', container: 'array' }
];

describe('language terms', () => {
  test("without terms, types and names are the editor's own", () => {
    for (const type of types) assert.equal(typeText(type), formatType(type), JSON.stringify(type));
    for (const definition of builtinNodeDefinitions()) assert.equal(localizeDefinition(definition, DEFAULT_TERMS), definition, definition.type);
  });

  test('every name template gives the node its own name in Unreal terms', () => {
    const byType = new Map(builtinNodeDefinitions().map((d) => [d.type, d]));
    for (const type of Object.keys(NAME_TEMPLATES)) {
      assert.ok(byType.has(type), type);
      assert.equal(localizeDefinition(byType.get(type)!, { ...DEFAULT_TERMS, array: 'Array' }).displayName, byType.get(type)!.displayName);
    }
  });

  test('each language writes types its own way', () => {
    const spell = (language: string) => types.map((t) => typeText(t, LANGUAGE_TERMS[language].types));
    assert.deepEqual(spell('python'), ['int', 'float', 'str', 'bool', 'Any', 'int | None', 'list[int]', 'set[str]', 'dict[str, float]', 'Point', 'list[Enemy]']);
    assert.deepEqual(spell('csharp').slice(6, 9), ['List<int>', 'HashSet<string>', 'Dictionary<string, double>']);
    // Java boxes basic types inside containers.
    assert.deepEqual(spell('java').slice(6, 9), ['ArrayList<Long>', 'LinkedHashSet<String>', 'LinkedHashMap<String, Double>']);
    assert.deepEqual(spell('go').slice(6, 9), ['[]int', 'VgSet[string]', 'VgMap[string, float64]']);
    assert.equal(typeText({ id: 'string', container: 'map', valueType: { id: 'int' } }, LANGUAGE_TERMS.ruby.types), 'Hash{String => Integer}');
  });

  test('every built-in language has terms, and its basic types are spelled as its generator writes them', () => {
    for (const pack of builtinLanguagePacks().all()) {
      assert.ok(pack.terms, pack.id);
      for (const id of ['int', 'float', 'string', 'bool']) {
        // TypeScript and JavaScript write both numbers as number; the editor says integer, so the type
        // picker tells them apart.
        const expected = id === 'int' && (pack.id === 'typescript' || pack.id === 'javascript') ? 'integer' : pack.mapType({ id });
        assert.equal(typeText({ id }, pack.terms.types), expected, `${pack.id} ${id}`);
      }
    }
  });

  test("a node that names a container takes the language's word, and keeps its Unreal name for search", () => {
    const make = builtinNodeDefinitions().find((d) => d.type === 'core:array.make')!;
    const python = localizeDefinition(make, LANGUAGE_TERMS.python);
    assert.deepEqual([python.displayName, python.category], ['Make List', 'Utilities / List']);
    assert.ok(python.keywords?.includes('Make Array'));
    const fromArrays = builtinNodeDefinitions().find((d) => d.type === 'core:map.from-arrays')!;
    assert.equal(localizeDefinition(fromArrays, LANGUAGE_TERMS.python).displayName, 'Make Dict From Lists');
    // A category only: the name stays.
    const length = builtinNodeDefinitions().find((d) => d.type === 'core:map.length')!;
    assert.deepEqual([localizeDefinition(length, LANGUAGE_TERMS.ruby).displayName, localizeDefinition(length, LANGUAGE_TERMS.ruby).category], ['Length', 'Utilities / Hash']);
    // Set and Map as verbs aren't containers.
    for (const type of ['core:variable.set', 'core:math.map-range-clamped']) {
      const definition = builtinNodeDefinitions().find((d) => d.type === type)!;
      assert.equal(localizeDefinition(definition, LANGUAGE_TERMS.python).displayName, definition.displayName);
    }
  });
});
