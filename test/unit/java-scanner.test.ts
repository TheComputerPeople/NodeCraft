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
    assert.match(skipped.instance, /isn't public static/);
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
