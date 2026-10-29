// Reading C++ headers for functions that become nodes (src/core/importing/cpp-scanner.ts).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mapCppType, scanCpp } from '../../src/core/importing/cpp-scanner';
import { exposeFunctions } from '../../src/core/importing/symbols';

const HEADER = `#pragma once
#include <string>
#include <vector>
#define TWICE(x) ((x) * 2) // { a macro's braces don't count }

namespace game {
namespace combat {

/// How much damage a hit does.
/// @blueprint
/// @category Combat|Damage
double damage(double strength, int level = 1);

/** @blueprint pure
 *  @displayName Is Critical */
[[nodiscard]] inline bool isCritical(const std::string& weapon, double roll = 0.5) {
    return weapon == "{axe}" && roll > 0.9;
}

}  // namespace combat

/// @blueprint
std::vector<long long> scores(const std::vector<long long>& points);

}  // namespace game

/// @blueprint
void log(const char* message);

/// @blueprint
void bump(int& counter);

/// @blueprint
template <class T> T twice(T value);

/// @blueprint
static int hidden();

class Player {
public:
    /// @blueprint
    int level() const;
};

/// Not marked.
std::string greeting(std::string name);
`;

describe('C++ scanner', () => {
  const scan = scanCpp(HEADER);

  test('marked free functions, in their namespaces, with parameters, defaults and docs', () => {
    const fns = Object.fromEntries(scan.functions.map((f) => [`${f.container ? `${f.container}::` : ''}${f.name}`, f]));
    assert.deepEqual(Object.keys(fns).sort(), ['bump', 'game::combat::damage', 'game::combat::isCritical', 'game::scores', 'greeting']);
    assert.deepEqual(fns['game::combat::damage'].params, [{ name: 'strength', type: { id: 'float' } }, { name: 'level', type: { id: 'int' }, defaultValue: 1 }]);
    assert.deepEqual(fns['game::combat::damage'].returns, { id: 'float' });
    assert.equal(fns['game::combat::damage'].doc.description, 'How much damage a hit does.');
    assert.deepEqual(fns['game::combat::isCritical'].params, [{ name: 'weapon', type: { id: 'string' } }, { name: 'roll', type: { id: 'float' }, defaultValue: 0.5 }]);
    assert.deepEqual(fns['game::scores'].returns, { id: 'int', container: 'array' });
    assert.equal(fns.greeting.returns && fns.greeting.returns.id, 'string');
  });

  test('functions that can\'t be nodes are reported with the reason; class members aren\'t free functions', () => {
    const skipped = Object.fromEntries(scan.skipped.map((s) => [s.name, s.reason]));
    assert.match(skipped.log, /pointer parameters/);
    assert.match(skipped.twice, /templates/);
    assert.match(skipped.hidden, /static functions/);
    assert.equal(skipped.level, undefined);
    assert.ok(!scan.functions.some((f) => f.name === 'level'));
  });

  test('marked functions become nodes that generated code calls by their namespace', () => {
    const exposed = exposeFunctions(scan, { language: 'cpp', path: 'src/combat.h', exposeAll: false });
    const damage = exposed.definitions.find((d) => d.displayName === 'Damage')!;
    assert.equal(damage.category, 'Combat / Damage');
    assert.deepEqual(damage.implementation, { kind: 'function', language: 'cpp', path: 'src/combat.h', name: 'damage', module: 'game::combat' });
    const critical = exposed.definitions.find((d) => d.displayName === 'Is Critical')!;
    assert.ok(!critical.inputs.some((p) => p.kind === 'exec'), 'pure');
    assert.ok(!exposed.definitions.some((d) => d.displayName === 'Greeting'), 'not marked');
  });

  test('types map to canonical types where generated code passes them exactly', () => {
    assert.deepEqual(mapCppType('long long'), { id: 'int' });
    assert.deepEqual(mapCppType('std::set<double>'), { id: 'float', container: 'set' });
    assert.deepEqual(mapCppType('std::map<std::string, int>'), { id: 'native:std::map<std::string, int>' });
    assert.deepEqual(mapCppType('std::vector<std::vector<int>>'), { id: 'native:std::vector<std::vector<int>>' });
  });
});

// Classes (docs/node-authoring.md, gap 2): public constructors (with initializer lists), member
// functions and data members of a class or struct become nodes with a Target pin.
describe('C++ classes', () => {
  const source = [
    'namespace game {',
    'class Counter : public Base {',
    'public:',
    '    /// @blueprint',
    '    double count = 0;',
    '    /// @blueprint',
    '    const std::string label{"x"};',
    '    /// @blueprint',
    '    explicit Counter(double start) : count(start), label{"y"} {}',
    '    virtual ~Counter() = default;',
    '    /// @blueprint',
    '    double add(double amount) { count += amount; return count; }',
    '    /// @blueprint',
    '    static int twice(int x) { return x * 2; }',
    'private:',
    '    /// @blueprint',
    '    int secret = 1;',
    '};',
    '}',
    ''
  ].join('\n');

  test('reads public constructors, member functions and data members', () => {
    const scan = scanCpp(source);
    const [cls] = scan.classes!;
    assert.deepEqual([cls.name, cls.type, cls.base], ['game::Counter', { id: 'native:Counter' }, { id: 'native:Base' }]);
    assert.deepEqual(cls.init!.params, [{ name: 'start', type: { id: 'float' } }]);
    assert.deepEqual(cls.methods.map((m) => m.name), ['add']);
    assert.deepEqual(cls.properties.map((p) => [p.name, p.readonly]), [['count', false], ['label', true]]);
    assert.deepEqual(scan.skipped.filter((s) => s.marked).map((s) => s.name), ['game::Counter::twice', 'game::Counter::secret']);
  });

  test('marked members become nodes', () => {
    const { definitions } = exposeFunctions(scanCpp(source), { language: 'cpp', path: 'include/counter.h', exposeAll: false });
    assert.deepEqual(definitions.map((d) => [d.type.slice(d.type.indexOf('#') + 1), d.displayName]), [
      ['game::Counter:new', 'Construct Counter'], ['game::Counter:add', 'Add'], ['game::Counter:get:count', 'Get Count'],
      ['game::Counter:set:count', 'Set Count'], ['game::Counter:get:label', 'Get Label']
    ]);
  });
});

// Several outputs (docs/node-authoring.md, gap 3): non-const reference parameters are out
// parameters, after the value returned; a std::tuple or std::pair is named by @outputs.
describe('C++ several outputs', () => {
  const scan = scanCpp([
    '/// @blueprint',
    'void bump(int& counter);',
    '/// @blueprint',
    'bool tryParse(const std::string& text, double& value);',
    '/// @blueprint',
    '/// @outputs low high',
    'std::pair<int, double> range(int n);',
    '/// @blueprint',
    'std::tuple<int, int> unnamed();',
    ''
  ].join('\n'));
  const fns = Object.fromEntries(scan.functions.map((f) => [f.name, f]));

  test('out parameters follow the value returned, with their types as written', () => {
    assert.deepEqual(fns.bump.params, []);
    assert.deepEqual(fns.bump.outputs, [{ name: 'counter', type: { id: 'int' } }]);
    assert.deepEqual(fns.bump.results, { kind: 'out', names: ['counter'], types: ['int'] });
    assert.deepEqual(fns.tryParse.params, [{ name: 'text', type: { id: 'string' } }]);
    assert.deepEqual(fns.tryParse.outputs, [{ name: 'returnValue', type: { id: 'bool' } }, { name: 'value', type: { id: 'float' } }]);
    assert.deepEqual(fns.tryParse.results, { kind: 'out', names: ['value'], types: ['double'], returnValue: true });
  });

  test('a tuple or pair named by @outputs; without names it stays one native value', () => {
    assert.deepEqual(fns.range.outputs, [{ name: 'low', type: { id: 'int' } }, { name: 'high', type: { id: 'float' } }]);
    assert.deepEqual(fns.range.results, { kind: 'tuple', names: ['low', 'high'] });
    assert.equal(fns.unnamed.outputs, undefined);
    assert.equal(fns.unnamed.returns?.id, 'native:std::tuple<int, int>');
  });

  test('a node with several outputs runs where execution reaches it, even when marked pure', () => {
    const def = exposeFunctions(scanCpp('/// @blueprint pure\nvoid split(double v, int& whole, double& part);\n'), { language: 'cpp', path: 'm.h', exposeAll: false }).definitions[0];
    assert.deepEqual(def.outputs.map((p) => p.id), ['execOut', 'whole', 'part']);
    assert.deepEqual((def.implementation as { results?: unknown }).results, { kind: 'out', names: ['whole', 'part'], types: ['int', 'double'] });
  });
});
