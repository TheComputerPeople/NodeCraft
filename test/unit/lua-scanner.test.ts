// Lua symbol import (src/core/importing/lua-scanner.ts, docs/more-languages.md "Lua"): the returned
// table's functions marked ---@blueprint become nodes, typed by their LuaLS annotations.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { mapLuaType, scanLua } from '../../src/core/importing/lua-scanner';

const MODULE = [
  'local M = {}',
  '',
  '--- Triples a value.',
  '---@blueprint',
  '---@category Scores',
  '---@param value number',
  '---@return number',
  'function M.triple(value)',
  '  return value * 3',
  'end',
  '',
  '---@blueprint pure',
  '---@param name string',
  '---@param points integer',
  '---@return string',
  'M.label = function(name, points)',
  '  return name .. ": " .. points',
  'end',
  '',
  '---@blueprint',
  '---@param ... number',
  'function M.sum(...) end',
  '',
  '---@blueprint',
  'function M:reset() end',
  '',
  '---@blueprint',
  '---@return integer',
  '---@return string',
  'function M.pair() return 1, "a" end',
  '',
  '--- Not marked.',
  'function M.helper(x) return x end',
  '',
  'local Other = {}',
  '---@blueprint',
  'function Other.hidden() end',
  '',
  'return M',
  ''
].join('\n');

describe('Lua scanner', () => {
  test("finds the returned table's functions, with their annotations", () => {
    const scan = scanLua(MODULE);
    assert.deepEqual(scan.functions.map((f) => [f.name, f.line, f.params, f.returns]), [
      ['triple', 8, [{ name: 'value', type: { id: 'float' } }], { id: 'float' }],
      ['label', 16, [{ name: 'name', type: { id: 'string' } }, { name: 'points', type: { id: 'int' } }], { id: 'string' }],
      ['helper', 33, [{ name: 'x' }], null]
    ]);
    assert.equal(scan.functions[0].doc.description, 'Triples a value.');
  });

  test('says why marked functions can\'t be nodes', () => {
    assert.deepEqual(scanLua(MODULE).skipped.filter((s) => s.marked).map((s) => [s.name, s.reason]), [
      ['sum', 'It takes any number of arguments (...).'],
      ['reset', 'It takes self (a method): only module functions can be nodes.'],
      ['pair', 'It returns several values without names: name each (`---@return int sum`) or list them with @outputs.'],
      ['hidden', 'It belongs to Other, not the table the module returns (M).']
    ]);
  });

  test("marked functions become nodes (unmarked ones don't), pure ones without exec pins", () => {
    const { definitions } = exposeFunctions(scanLua(MODULE), { language: 'lua', path: 'lib/scores.lua', exposeAll: false });
    assert.deepEqual(definitions.map((d) => [d.type, d.displayName, d.category, d.inputs.filter((p) => p.kind === 'exec').length]), [
      ['fn:lua:lib/scores.lua#triple', 'Triple', 'Scores', 1],
      ['fn:lua:lib/scores.lua#label', 'Label', 'Project / scores', 0]
    ]);
  });

  test('maps LuaLS types to pin types', () => {
    assert.deepEqual(['integer', 'number', 'string?', 'boolean', 'any', 'nil', 'string[]', 'table<string, integer>', 'Player'].map(mapLuaType), [
      { id: 'int' }, { id: 'float' }, { id: 'string' }, { id: 'bool' }, { id: 'any' }, null,
      { id: 'string', container: 'array' }, { id: 'string', container: 'map', valueType: { id: 'int' } }, { id: 'native:Player' }
    ]);
  });
});

// ---@class tables (docs/node-authoring.md, gap 2): their `:` methods, `.new` constructor and
// @blueprint ---@fields, when the module's table reaches them.
describe('Lua classes', () => {
  const source = [
    'local M = {}',
    '',
    '---@class Counter',
    '---@field count number The count. @blueprint',
    '---@field label string',
    'local Counter = {}',
    '',
    '---@blueprint',
    '---@param start number',
    'function Counter.new(start) end',
    '',
    '---@blueprint',
    '---@param amount number',
    '---@return number',
    'function Counter:add(amount) end',
    '',
    '---@class Hidden',
    'local Hidden = {}',
    '',
    '---@blueprint',
    'function Hidden:go() end',
    '',
    'M.Counter = Counter',
    'return M',
    ''
  ].join('\n');

  test('reads a class the module reaches; reports one it does not', () => {
    const scan = scanLua(source);
    const [cls] = scan.classes!;
    assert.deepEqual([cls.name, cls.title, cls.type], ['Counter', 'Counter', { id: 'native:Counter' }]);
    assert.deepEqual(cls.init!.params, [{ name: 'start', type: { id: 'float' } }]);
    assert.deepEqual(cls.methods.map((m) => [m.name, m.returns]), [['add', { id: 'float' }]]);
    assert.deepEqual(cls.properties.map((p) => [p.name, p.doc.tags.map((t) => t.name)]), [['count', ['blueprint']], ['label', []]]);
    assert.match(scan.skipped.find((s) => s.name === 'Hidden.go')!.reason, /isn't in the table the module returns/);
  });

  test('a module that returns the class itself names it by the module', () => {
    const scan = scanLua(['---@class Counter', 'local Counter = {}', '---@blueprint', 'function Counter:add() end', 'return Counter', ''].join('\n'));
    const { definitions } = exposeFunctions(scan, { language: 'lua', path: 'lib/counter.lua', exposeAll: false });
    assert.deepEqual(definitions.map((d) => [d.type, d.category]), [['fn:lua:lib/counter.lua#:add', 'Project / Counter']]);
  });
});

// Several values returned (docs/node-authoring.md, gap 3): named in `---@return type name`, or by
// @outputs.
describe('Lua several outputs', () => {
  test('each ---@return is an output, in order', () => {
    const scan = scanLua([
      'local M = {}',
      '---@blueprint',
      '---@return integer quotient',
      '---@return integer remainder',
      'function M.divide(a, b) return a // b, a % b end',
      '---@blueprint',
      '---@return number',
      '---@return string',
      '---@outputs score label',
      'function M.rate() return 1, "a" end',
      'return M',
      ''
    ].join('\n'));
    const fns = Object.fromEntries(scan.functions.map((f) => [f.name, f]));
    assert.deepEqual(fns.divide.outputs, [{ name: 'quotient', type: { id: 'int' } }, { name: 'remainder', type: { id: 'int' } }]);
    assert.deepEqual(fns.divide.results, { kind: 'tuple', names: ['quotient', 'remainder'] });
    assert.deepEqual(fns.rate.outputs, [{ name: 'score', type: { id: 'float' } }, { name: 'label', type: { id: 'string' } }]);
  });
});
