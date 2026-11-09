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
pub fn twice<A: Clone, B, C>(value: A, b: B, c: C) -> (A, A) { (value.clone(), value) }

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
    assert.deepEqual(Object.keys(fns).sort(), ['damage', 'greeting', 'is_critical', 'later', 'lookup', 'scores::best', 'shout']);
    // A shared borrow of a text or a list is a pin of it, which generated code passes borrowed.
    assert.deepEqual(fns.shout.params, [{ name: 'text', type: { id: 'string' }, borrowed: true }]);
    // An async fn is a latent node (docs/node-authoring.md, gap 4).
    assert.deepEqual([fns.later.latent, fns.later.returns], [true, null]);
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
    // A lifetime isn't a type parameter: the returned reference is why.
    assert.match(skipped.label, /returning references/);
    assert.match(skipped.private_helper, /isn't pub/);
    assert.match(skipped.twice, /more than two type parameters/);
    assert.equal(skipped.level, undefined);
    assert.equal(skipped.helper, undefined);
    assert.ok(!scan.functions.some((f) => f.name === 'level' || f.name === 'helper'));
  });

  test('slices and Vec references are borrowed lists; other references, and &mut, aren\'t pins yet', () => {
    const borrowed = scanRust('/// @blueprint\npub fn total(items: &[i64], more: &Vec<f64>, name: &String) -> i64 { 0 }\n/// @blueprint\npub fn bump(x: &mut i64) {}\n/// @blueprint\npub fn count(c: &Counter) {}\n');
    assert.deepEqual(borrowed.functions[0].params, [
      { name: 'items', type: { id: 'int', container: 'array' }, borrowed: true },
      { name: 'more', type: { id: 'float', container: 'array' }, borrowed: true },
      { name: 'name', type: { id: 'string' }, borrowed: true }
    ]);
    assert.deepEqual(borrowed.skipped.map((s) => s.name), ['bump', 'count']);
    assert.ok(borrowed.skipped.every((s) => /reference parameters/.test(s.reason)));
    const exposed = exposeFunctions(borrowed, { language: 'rust', path: 'src/sum.rs', module: 'sum', exposeAll: false });
    assert.deepEqual((exposed.definitions[0].implementation as { borrowed?: string[] }).borrowed, ['items', 'more', 'name']);
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

// Structs as classes (docs/node-authoring.md, gap 2): pub fields, and the impl block's methods
// (taking &self or &mut self) and constructor (returning Self).
describe('Rust structs', () => {
  const source = [
    'pub struct Counter {',
    '    /// @blueprint',
    '    pub count: f64,',
    '    /// @blueprint',
    '    secret: i64,',
    '}',
    '',
    'impl Counter {',
    '    /// @blueprint',
    '    pub fn new(start: f64) -> Self { Counter { count: start, secret: 0 } }',
    '    /// @blueprint',
    '    pub fn add(&mut self, amount: f64) -> f64 { self.count += amount; self.count }',
    '    /// @blueprint',
    '    pub fn total(&self) -> f64 { self.count }',
    '    /// @blueprint',
    '    pub fn helper(x: i64) -> i64 { x }',
    '    /// @blueprint',
    '    pub fn into_count(self) -> f64 { self.count }',
    '}',
    ''
  ].join('\n');

  test('reads pub fields, methods and the constructor', () => {
    const scan = scanRust(source);
    const [cls] = scan.classes!;
    assert.deepEqual([cls.name, cls.type], ['Counter', { id: 'native:Counter' }]);
    assert.deepEqual(cls.init!.name, 'new');
    assert.deepEqual(cls.methods.map((m) => [m.name, m.params.map((p) => p.name)]), [['add', ['amount']], ['total', []]]);
    assert.deepEqual(cls.properties.map((p) => p.name), ['count']);
    assert.deepEqual(scan.skipped.filter((s) => s.marked).map((s) => s.name), ['Counter.secret', 'Counter.helper', 'Counter.into_count']);
  });

  test('marked members become nodes', () => {
    const { definitions } = exposeFunctions(scanRust(source), { language: 'rust', path: 'src/counter.rs', module: 'counter', exposeAll: false });
    assert.deepEqual(definitions.map((d) => d.type.slice(d.type.indexOf('#') + 1)), ['Counter:new', 'Counter:add', 'Counter:total', 'Counter:get:count', 'Counter:set:count']);
  });
});
