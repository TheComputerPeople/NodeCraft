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
    assert.deepEqual(Object.keys(fns).sort(), ['game::combat::damage', 'game::combat::isCritical', 'game::scores', 'greeting']);
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
    assert.match(skipped.bump, /non-const reference/);
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
