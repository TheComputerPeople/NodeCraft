// Reading Java files for methods that become nodes (src/core/importing/java-scanner.ts).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mapJavaType, scanJava } from '../../src/core/importing/java-scanner';
import { exposeFunctions } from '../../src/core/importing/symbols';

const SOURCE = `package game.combat;

import java.util.ArrayList;

/** Combat rules. */
public final class Rules {
    private Rules() {}

    /**
     * How much damage a hit does.
     * @blueprint
     * @category Combat|Damage
     * @param strength how hard
     */
    public static double damage(double strength, long level) {
        String brace = "{ not a brace }";
        return strength * level;
    }

    /** @blueprint pure
     *  @displayName Is Critical */
    @Deprecated
    public static boolean isCritical(final String weapon, double roll) {
        return weapon.equals("axe") && roll > 0.9;
    }

    /** @blueprint */
    public static ArrayList<Long> best(ArrayList<Long> points) { return points; }

    /** @blueprint */
    public static int small(int value) { return value; }

    /** @blueprint */
    public double instance() { return 1; }

    /** @blueprint */
    public static <T> T first(ArrayList<T> items) { return items.get(0); }

    /** @blueprint */
    public static void log(String... parts) {}

    /** @blueprint */
    public static String read(String path) throws java.io.IOException { return ""; }

    /** Not marked. */
    public static String greeting(String name) { return "hi " + name; }

    public static class Scores {
        /** @blueprint */
        public static void reset() {}
    }

    enum Kind {
        A, B;

        /** @blueprint */
        public static Kind pick() { return A; }
    }
}
`;

describe('Java scanner', () => {
  const scan = scanJava(SOURCE);

  test('public static methods, in nested classes, with parameters, types and docs', () => {
    const fns = Object.fromEntries(scan.functions.map((f) => [`${f.container}.${f.name}`, f]));
    assert.deepEqual(Object.keys(fns).sort(), [
      'game.combat.Rules.Kind.pick', 'game.combat.Rules.Scores.reset', 'game.combat.Rules.best', 'game.combat.Rules.damage',
      'game.combat.Rules.greeting', 'game.combat.Rules.isCritical', 'game.combat.Rules.small'
    ]);
    const damage = fns['game.combat.Rules.damage'];
    assert.deepEqual(damage.params, [{ name: 'strength', type: { id: 'float' } }, { name: 'level', type: { id: 'int' } }]);
    assert.deepEqual(damage.returns, { id: 'float' });
    assert.equal(damage.doc.description, 'How much damage a hit does.');
    assert.deepEqual(fns['game.combat.Rules.isCritical'].params, [{ name: 'weapon', type: { id: 'string' } }, { name: 'roll', type: { id: 'float' } }]);
    assert.deepEqual(fns['game.combat.Rules.best'].returns, { id: 'int', container: 'array' });
    assert.deepEqual(fns['game.combat.Rules.small'].params[0].type, { id: 'native:int' }, 'Java won\'t narrow a long to an int');
    assert.equal(fns['game.combat.Rules.Scores.reset'].returns, null);
  });

  test('methods that can\'t be nodes are reported with the reason', () => {
    const skipped = Object.fromEntries(scan.skipped.map((s) => [s.name, s.reason]));
    // An instance method of a public class is a member node with a Target pin (docs/node-authoring.md, gap 2).
    assert.equal(skipped.instance, undefined);
    assert.deepEqual(scan.classes!.find((c) => c.name === 'game.combat.Rules')?.methods.map((m) => m.name), ['instance']);
    assert.match(skipped.first, /generic/);
    assert.match(skipped.log, /varargs/);
    assert.match(skipped.read, /checked exceptions/);
  });

  test('marked methods become nodes that generated code calls by their qualified class', () => {
    const exposed = exposeFunctions(scan, { language: 'java', path: 'src/main/java/game/combat/Rules.java', exposeAll: false });
    const damage = exposed.definitions.find((d) => d.displayName === 'Damage')!;
    assert.equal(damage.category, 'Combat / Damage');
    assert.deepEqual(damage.implementation, { kind: 'function', language: 'java', path: 'src/main/java/game/combat/Rules.java', name: 'damage', module: 'game.combat.Rules' });
    assert.ok(!exposed.definitions.find((d) => d.displayName === 'Is Critical')!.inputs.some((p) => p.kind === 'exec'), 'pure');
    assert.ok(!exposed.definitions.some((d) => d.displayName === 'Greeting'), 'not marked');
  });

  test('types', () => {
    assert.deepEqual(mapJavaType('java.lang.String'), { id: 'string' });
    assert.deepEqual(mapJavaType('java.util.ArrayList< Double >'), { id: 'float', container: 'array' });
    assert.deepEqual(mapJavaType('List<Long>'), { id: 'native:List<Long>' });
  });
});

// Classes (docs/node-authoring.md, gap 2): a public class's public constructors, instance methods
// and fields (final ones read-only) become nodes with a Target pin.
describe('Java classes', () => {
  const source = [
    'package game;',
    'public class Counter extends Base implements Comparable<Counter> {',
    '    /** @blueprint */',
    '    public double count;',
    '    /** @blueprint */',
    '    public final String label = "x";',
    '    /** @blueprint */',
    '    private int secret;',
    '    /** @blueprint */',
    '    public Counter(double start) { count = start; }',
    '    /** @blueprint */',
    '    public double add(double amount) { count += amount; return count; }',
    '    /** @blueprint */',
    '    public static int twice(int x) { return x * 2; }',
    '    public int compareTo(Counter other) { return 0; }',
    '}',
    ''
  ].join('\n');

  test('reads public constructors, instance methods and fields', () => {
    const scan = scanJava(source);
    const [cls] = scan.classes!;
    assert.deepEqual([cls.name, cls.type, cls.base], ['game.Counter', { id: 'native:Counter' }, { id: 'native:Base' }]);
    assert.deepEqual(cls.init!.params, [{ name: 'start', type: { id: 'float' } }]);
    assert.deepEqual(cls.methods.map((m) => m.name), ['add', 'compareTo']);
    assert.deepEqual(cls.properties.map((p) => [p.name, p.readonly]), [['count', false], ['label', true]]);
    assert.deepEqual(scan.functions.map((f) => f.name), ['twice']);
    assert.deepEqual(scan.skipped.filter((s) => s.marked).map((s) => s.name), ['secret']);
  });

  test('marked members become nodes', () => {
    const { definitions } = exposeFunctions(scanJava(source), { language: 'java', path: 'src/main/java/game/Counter.java', exposeAll: false });
    assert.deepEqual(definitions.map((d) => d.type.slice(d.type.indexOf('#') + 1)), [
      'game.Counter.twice', 'game.Counter:new', 'game.Counter:add', 'game.Counter:get:count', 'game.Counter:set:count', 'game.Counter:get:label'
    ]);
  });
});

// Async methods (docs/node-authoring.md, gap 4): a CompletableFuture or CompletionStage is a latent
// node, whose value is the future's (unboxed).
describe('Java async methods', () => {
  test('futures are latent, with Completed and the unboxed value; a record in a future stays one value', () => {
    const scan = scanJava([
      'package game;',
      'import java.util.concurrent.*;',
      'public final class Remote {',
      '    public record Pair(long a, long b) {}',
      '    /** @blueprint */',
      '    public static CompletableFuture<Long> load(String key) { return null; }',
      '    /** @blueprint */',
      '    public static CompletionStage<Void> save() { return null; }',
      '    /** @blueprint */',
      '    public static java.util.concurrent.CompletableFuture<Pair> pair() { return null; }',
      '}',
      ''
    ].join('\n'));
    const fns = Object.fromEntries(scan.functions.map((f) => [f.name, [f.latent, f.returns, f.outputs]]));
    assert.deepEqual(fns.load, [true, { id: 'int' }, undefined]);
    assert.deepEqual(fns.save, [true, null, undefined]);
    assert.deepEqual(fns.pair, [true, { id: 'native:Pair' }, undefined]);
  });
});
