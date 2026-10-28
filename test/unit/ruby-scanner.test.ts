// Ruby symbol import (src/core/importing/ruby-scanner.ts, docs/more-languages.md "Ruby"): functions
// callable without an object, marked @blueprint, become nodes typed by their YARD tags.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { mapRubyType, scanRuby } from '../../src/core/importing/ruby-scanner';

const SOURCE = [
  'module Game',
  '  module Scores',
  '    # Triples a value.',
  '    # @blueprint',
  '    # @category Scores',
  '    # @param [Float] value',
  '    # @return [Float]',
  '    def self.triple(value)',
  '      value * 3',
  '    end',
  '  end',
  '',
  '  module Labels',
  '    module_function',
  '',
  '    # @blueprint pure',
  '    # @param name [String]',
  '    # @param [Integer] points',
  '    # @return [String]',
  '    def label(name, points = 5)',
  '      "#{name}: #{points}"',
  '    end',
  '  end',
  '',
  '  class Player',
  '    # @blueprint',
  '    def heal(amount)',
  '    end',
  '',
  '    # @blueprint',
  '    def self.spawn(*names, key:)',
  '    end',
  '  end',
  'end',
  '',
  '# @blueprint',
  '# @param [Array<Integer>] values',
  'def total(values)',
  '  values.sum',
  'end',
  '',
  '# @blueprint',
  'def ready?',
  '  true',
  'end',
  ''
].join('\n');

describe('Ruby scanner', () => {
  test('finds module methods, module functions and top-level methods, with their types', () => {
    const scan = scanRuby(SOURCE);
    assert.deepEqual(scan.functions.map((f) => [f.container, f.name, f.line, f.params, f.returns]), [
      ['Game::Scores', 'triple', 8, [{ name: 'value', type: { id: 'float' } }], { id: 'float' }],
      ['Game::Labels', 'label', 20, [{ name: 'name', type: { id: 'string' } }, { name: 'points', type: { id: 'int' }, defaultValue: 5 }], { id: 'string' }],
      [undefined, 'total', 38, [{ name: 'values', type: { id: 'int', container: 'array' } }], null]
    ]);
    assert.equal(scan.functions[0].doc.description, 'Triples a value.');
  });

  test("says why marked functions can't be nodes", () => {
    assert.deepEqual(scanRuby(SOURCE).skipped.filter((s) => s.marked).map((s) => [s.name, s.reason]), [
      ['heal', "It's an instance method: generated code calls module methods (def self.name, module_function) and top-level methods."],
      ['spawn', 'It takes splat, keyword or block arguments.'],
      ['ready?', "Its name ends with ? or !, which other languages' nodes can't call."]
    ]);
  });

  test('marked functions become nodes called on their module', () => {
    const { definitions } = exposeFunctions(scanRuby(SOURCE), { language: 'ruby', path: 'lib/game.rb', exposeAll: false });
    assert.deepEqual(definitions.map((d) => [d.type, d.displayName, d.implementation?.kind === 'function' ? d.implementation.module : undefined]), [
      ['fn:ruby:lib/game.rb#Game::Scores.triple', 'Triple', 'Game::Scores'],
      ['fn:ruby:lib/game.rb#Game::Labels.label', 'Label', 'Game::Labels'],
      ['fn:ruby:lib/game.rb#total', 'Total', undefined]
    ]);
  });

  test('maps YARD types to pin types', () => {
    assert.deepEqual(['Integer', 'Float', 'Numeric', 'String', 'Boolean', 'Object', 'nil', 'Array', 'Array<String>', 'Set<Integer>', 'Hash{String => Float}', 'Player'].map(mapRubyType), [
      { id: 'int' }, { id: 'float' }, { id: 'float' }, { id: 'string' }, { id: 'bool' }, { id: 'any' }, null, { id: 'any', container: 'array' },
      { id: 'string', container: 'array' }, { id: 'int', container: 'set' }, { id: 'string', container: 'map', valueType: { id: 'float' } }, { id: 'native:Player' }
    ]);
  });
});
