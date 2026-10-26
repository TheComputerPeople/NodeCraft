// Reading Rust files for functions that become nodes (src/core/importing/rust-scanner.ts).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mapRustType, scanRust } from '../../src/core/importing/rust-scanner';
import { exposeFunctions } from '../../src/core/importing/symbols';

const SOURCE = `//! Combat rules.
use std::collections::HashMap;

/// How much damage a hit does.
/// @blueprint
/// @category Combat|Damage
pub fn damage(strength: f64, level: i64) -> f64 {
    let s = "{ not a brace }";
    let c = '}';
    strength * level as f64
}

/** @blueprint pure
 *  @displayName Is Critical */
#[inline]
pub(crate) fn is_critical(weapon: String, roll: f64) -> bool {
    weapon == r#"axe "}" "# && roll > 0.9
}

pub mod scores {
    /// @blueprint
    pub fn best(points: Vec<i64>) -> Vec<i64> {
        points
    }

    /// @blueprint
    pub fn label<'a>(name: &'a str) -> &'a str { name }
}

/// @blueprint
pub fn shout(text: &str) -> String { text.to_uppercase() }

/// @blueprint
fn private_helper() {}

/// @blueprint
pub async fn later() {}

/// @blueprint
pub fn twice<T: Clone>(value: T) -> (T, T) { (value.clone(), value) }

pub struct Player { level: i64 }

impl Player {
    /// @blueprint
    pub fn level(&self) -> i64 { self.level }
}

#[cfg(test)]
mod tests {
    /// @blueprint
    pub fn helper() {}
}

/// Not marked.
pub fn greeting(name: String) -> String { format!("hi {name}") }

/// @blueprint
pub fn lookup(table: HashMap<String, i64>) {}
`;

describe('Rust scanner', () => {
  const scan = scanRust(SOURCE);

  test('pub functions, in inline modules, with parameters, types and docs', () => {
    const fns = Object.fromEntries(scan.functions.map((f) => [`${f.container ? `${f.container}::` : ''}${f.name}`, f]));
    assert.deepEqual(Object.keys(fns).sort(), ['damage', 'greeting', 'is_critical', 'lookup', 'scores::best']);
    assert.deepEqual(fns.damage.params, [{ name: 'strength', type: { id: 'float' } }, { name: 'level', type: { id: 'int' } }]);
    assert.deepEqual(fns.damage.returns, { id: 'float' });
    assert.equal(fns.damage.doc.description, 'How much damage a hit does.');
    assert.equal(fns.damage.line, 7);
    assert.deepEqual(fns.is_critical.params, [{ name: 'weapon', type: { id: 'string' } }, { name: 'roll', type: { id: 'float' } }]);
    assert.deepEqual(fns['scores::best'].returns, { id: 'int', container: 'array' });
    assert.equal(fns.lookup.returns, null);
    assert.deepEqual(fns.lookup.params[0].type, { id: 'native:HashMap<String, i64>' });
  });

  test('functions that can\'t be nodes are reported with the reason; methods and test code aren\'t free functions', () => {
    const skipped = Object.fromEntries(scan.skipped.map((s) => [s.name, s.reason]));
    assert.match(skipped.shout, /reference parameters/);
    assert.match(skipped.label, /generic/);
    assert.match(skipped.private_helper, /isn't pub/);
    assert.match(skipped.later, /async/);
    assert.match(skipped.twice, /generic/);
    assert.equal(skipped.level, undefined);
    assert.equal(skipped.helper, undefined);
    assert.ok(!scan.functions.some((f) => f.name === 'level' || f.name === 'helper'));
  });

  test('marked functions become nodes that generated code calls through their module in the crate', () => {
    const exposed = exposeFunctions(scan, { language: 'rust', path: 'src/game/combat.rs', module: 'game::combat', exposeAll: false });
    const damage = exposed.definitions.find((d) => d.displayName === 'Damage')!;
    assert.equal(damage.category, 'Combat / Damage');
    assert.deepEqual(damage.implementation, { kind: 'function', language: 'rust', path: 'src/game/combat.rs', name: 'damage', module: 'game::combat' });
    const best = exposed.definitions.find((d) => d.displayName === 'Best')!;
    assert.equal((best.implementation as { module?: string }).module, 'game::combat::scores');
    const critical = exposed.definitions.find((d) => d.displayName === 'Is Critical')!;
    assert.ok(!critical.inputs.some((p) => p.kind === 'exec'), 'pure');
    assert.ok(!exposed.definitions.some((d) => d.displayName === 'Greeting'), 'not marked');
    const atRoot = exposeFunctions(scan, { language: 'rust', path: 'src/main.rs', module: '', exposeAll: false });
    assert.equal((atRoot.definitions.find((d) => d.displayName === 'Damage')!.implementation as { module?: string }).module, undefined);
  });

  test('types map to canonical types where generated code passes them exactly', () => {
    assert.deepEqual(mapRustType('std::string::String'), { id: 'string' });
    assert.deepEqual(mapRustType('Vec< f64 >'), { id: 'float', container: 'array' });
    assert.deepEqual(mapRustType('i32'), { id: 'native:i32' });
    assert.deepEqual(mapRustType('Vec<Vec<i64>>'), { id: 'native:Vec<Vec<i64>>' });
  });
});
