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
      ['spawn', 'It takes splat, keyword or block arguments.'],
      ['ready?', "Its name ends with ? or !, which other languages' nodes can't call."]
    ]);
  });

  test('marked functions become nodes called on their module', () => {
    const { definitions } = exposeFunctions(scanRuby(SOURCE), { language: 'ruby', path: 'lib/game.rb', exposeAll: false });
    assert.deepEqual(definitions.map((d) => [d.type, d.displayName, d.implementation?.kind === 'function' ? d.implementation.module : undefined]), [
      ['fn:ruby:lib/game.rb#Game::Scores.triple', 'Triple', 'Game::Scores'],
      ['fn:ruby:lib/game.rb#Game::Labels.label', 'Label', 'Game::Labels'],
      ['fn:ruby:lib/game.rb#total', 'Total', undefined],
      // A class's instance method is a member node (docs/node-authoring.md, gap 2).
      ['fn:ruby:lib/game.rb#Game::Player:heal', 'Heal', undefined]
    ]);
  });

  test('maps YARD types to pin types', () => {
    assert.deepEqual(['Integer', 'Float', 'Numeric', 'String', 'Boolean', 'Object', 'nil', 'Array', 'Array<String>', 'Set<Integer>', 'Hash{String => Float}', 'Player'].map(mapRubyType), [
      { id: 'int' }, { id: 'float' }, { id: 'float' }, { id: 'string' }, { id: 'bool' }, { id: 'any' }, null, { id: 'any', container: 'array' },
      { id: 'string', container: 'array' }, { id: 'int', container: 'set' }, { id: 'string', container: 'map', valueType: { id: 'float' } }, { id: 'native:Player' }
    ]);
  });
});

// Classes (docs/node-authoring.md, gap 2): initialize, public instance methods and attributes.
describe('Ruby classes', () => {
  const source = [
    'class Counter < Base',
    '  # @blueprint',
    '  attr_reader :count',
    '  # @blueprint',
    '  attr_accessor :label',
    '',
    '  # @blueprint',
    '  def initialize(start)',
    '  end',
    '',
    '  # @blueprint',
    '  def add(amount)',
    '  end',
    '',
    '  private',
    '',
    '  # @blueprint',
    '  def secret',
    '  end',
    'end',
    ''
  ].join('\n');

  test('reads initialize, public methods and attributes (attr_reader read-only)', () => {
    const scan = scanRuby(source);
    const [cls] = scan.classes!;
    assert.deepEqual([cls.name, cls.base], ['Counter', { id: 'native:Base' }]);
    assert.deepEqual(cls.init!.params.map((p) => p.name), ['start']);
    assert.deepEqual(cls.methods.map((m) => m.name), ['add']);
    assert.deepEqual(cls.properties.map((p) => [p.name, p.readonly]), [['count', true], ['label', false]]);
    assert.deepEqual(scan.skipped.filter((s) => s.marked).map((s) => [s.name, s.reason]), [['secret', "it isn't public"]]);
  });

  // An async method (docs/node-authoring.md, gap 4): a returned Thread makes a latent node.
  test('methods returning a Thread are latent, valued by its type', () => {
    const scan = scanRuby([
      'module Remote',
      '  # @blueprint',
      '  # @return [Thread<Integer>]',
      '  def self.fetch_count',
      '    Thread.new { 3 }',
      '  end',
      '',
      '  # @blueprint',
      '  # @return [Thread]',
      '  def self.warm_up',
      '    Thread.new { nil }',
      '  end',
      'end',
      ''
    ].join('\n'));
    const fns = Object.fromEntries(scan.functions.map((f) => [f.name, f]));
    assert.deepEqual([fns.fetch_count.latent, fns.fetch_count.returns], [true, { id: 'int' }]);
    assert.deepEqual([fns.warm_up.latent, fns.warm_up.returns], [true, undefined]);
    const node = exposeFunctions(scan, { language: 'ruby', path: 'lib/remote.rb', exposeAll: false }).definitions.find((d) => d.displayName === 'Fetch Count')!;
    assert.equal(node.latent, true);
    assert.deepEqual(node.outputs.map((p) => p.id), ['completed', 'returnValue']);
  });
});
