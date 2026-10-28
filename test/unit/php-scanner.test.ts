// PHP symbol import (src/core/importing/php-scanner.ts, docs/more-languages.md "PHP"): functions and
// public static methods marked @blueprint become nodes, typed by their declared types.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { mapPhpType, scanPhp } from '../../src/core/importing/php-scanner';

const SOURCE = [
  '<?php',
  'namespace App\\Util;',
  '',
  'final class Scores',
  '{',
  '    /**',
  '     * Triples a value.',
  '     * @blueprint',
  '     * @category Scores',
  '     */',
  '    public static function triple(float $value): float',
  '    {',
  "        return $value * 3; // a comment with function in it",
  '    }',
  '',
  '    /** @blueprint */',
  '    public function heal(int $amount): void',
  '    {',
  '    }',
  '',
  '    /** @blueprint */',
  '    public static function many(int ...$values): int',
  '    {',
  '        return 0;',
  '    }',
  '}',
  '',
  '/**',
  ' * @blueprint pure',
  ' */',
  "function label(string $name, ?int $points = 5, $extra = 'x'): string",
  '{',
  "    return \"{$name}: {$points}\";",
  '}',
  ''
].join('\n');

describe('PHP scanner', () => {
  test('finds public static methods and functions, with their types and defaults', () => {
    const scan = scanPhp(SOURCE);
    assert.deepEqual(scan.functions.map((f) => [f.container, f.name, f.line, f.params, f.returns]), [
      ['App\\Util\\Scores', 'triple', 11, [{ name: 'value', type: { id: 'float' } }], { id: 'float' }],
      ['App\\Util\\', 'label', 31, [{ name: 'name', type: { id: 'string' } }, { name: 'points', type: { id: 'int', nullable: true }, defaultValue: 5 }, { name: 'extra', defaultValue: 'x' }], { id: 'string' }]
    ]);
    assert.equal(scan.functions[0].doc.description, 'Triples a value.');
  });

  test("says why marked functions can't be nodes", () => {
    assert.deepEqual(scanPhp(SOURCE).skipped.filter((s) => s.marked).map((s) => [s.name, s.reason]), [
      ['heal', "It isn't public static: generated code calls static methods and functions, without an object."],
      ['many', 'It takes any number of arguments, or an argument by reference.']
    ]);
  });

  test('marked functions become nodes, named and called by their class or namespace', () => {
    const { definitions } = exposeFunctions(scanPhp(SOURCE), { language: 'php', path: 'src/Util/Scores.php', exposeAll: false });
    assert.deepEqual(definitions.map((d) => [d.displayName, d.category, d.implementation?.kind === 'function' ? d.implementation.module : undefined]), [
      ['Triple', 'Scores', 'App\\Util\\Scores'],
      ['Label', 'Project / Scores', 'App\\Util\\']
    ]);
  });

  test('maps PHP types to pin types', () => {
    assert.deepEqual(['int', 'float', 'string', 'bool', 'mixed', 'void', '?string', 'int|null', 'array', '\\App\\Player'].map(mapPhpType), [
      { id: 'int' }, { id: 'float' }, { id: 'string' }, { id: 'bool' }, { id: 'any' }, null, { id: 'string', nullable: true },
      { id: 'int', nullable: true }, { id: 'native:array' }, { id: 'native:App\\Player' }
    ]);
  });
});
