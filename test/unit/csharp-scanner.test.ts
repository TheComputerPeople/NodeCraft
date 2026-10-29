// The C# declaration scanner: static methods marked /// @blueprint become nodes
// (docs/program-structure.md, "C# language pack").
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mapCSharpType, scanCSharp } from '../../src/core/importing/csharp-scanner';
import { ExposeOptions, exposeFunctions } from '../../src/core/importing/symbols';
import { NodeDefinition } from '../../src/core/model';

const CS: ExposeOptions = { language: 'csharp', path: 'Game/Combat.cs', exposeAll: false };

function nodes(source: string, exposeAll = false): NodeDefinition[] {
  return exposeFunctions(scanCSharp(source), { ...CS, exposeAll }).definitions;
}

const pins = (def: NodeDefinition) => def.inputs.filter((p) => p.kind === 'data').map((p) => `${p.id}:${p.type ? JSON.stringify(p.type) : 'any'}${p.defaultValue !== undefined ? `=${JSON.stringify(p.defaultValue)}` : ''}`);
const skipped = (source: string) => exposeFunctions(scanCSharp(source), { ...CS, exposeAll: true }).skipped.map((s) => `${s.name}: ${s.reason}`);

describe('C# scanner: exposure', () => {
  test('a static method whose documentation says @blueprint becomes a node', () => {
    const [def] = nodes(`
      namespace Game;

      public static class Combat
      {
          /// <summary>Subtracts damage from health.</summary>
          /// @blueprint
          /// @category Combat
          public static double ApplyDamage(double health, int amount = 10) => Math.Max(0, health - amount);
      }`);
    assert.equal(def.type, 'fn:csharp:Game/Combat.cs#Game.Combat.ApplyDamage');
    assert.equal(def.displayName, 'Apply Damage');
    assert.equal(def.category, 'Combat');
    assert.equal(def.description, 'Subtracts damage from health.');
    assert.deepEqual(pins(def), ['health:{"id":"float"}', 'amount:{"id":"int"}=10']);
    assert.deepEqual(def.implementation, { kind: 'function', language: 'csharp', path: 'Game/Combat.cs', name: 'ApplyDamage', module: 'Game.Combat' });
    assert.ok(def.inputs.some((p) => p.kind === 'exec'), 'callable: exec pins');
  });

  test('"@blueprint pure", block namespaces, and classes without a namespace', () => {
    const found = nodes(`
      namespace Studio.Tools {
          internal class MathTools {
              /// @blueprint pure
              public static double Twice(double v) { return v * 2; }
          }
      }
      class Loose {
          /// @blueprint
          internal static void Ping() {}
      }`);
    assert.deepEqual(found.map((d) => [d.type, (d.implementation as { module?: string }).module, d.inputs.some((p) => p.kind === 'exec')]), [
      ['fn:csharp:Game/Combat.cs#Studio.Tools.MathTools.Twice', 'Studio.Tools.MathTools', false],
      ['fn:csharp:Game/Combat.cs#Loose.Ping', 'Loose', true]
    ]);
  });

  test('instance methods, constructors, properties and nested types are not static methods', () => {
    const found = nodes(`
      public class Player {
          public int Health { get; set; } = 3;
          public Player() {}
          public void Heal() {}
          public static int Count;
          public class Inner { public static void Hidden() {} }
          public static string Name() => "p";
      }`, true);
    assert.deepEqual(found.map((d) => d.displayName), ['Name']);
  });

  test('methods that cannot be nodes are reported with the reason', () => {
    assert.deepEqual(skipped(`
      public static class S {
          private static void Secret() {}
          public static async void Fire() {}
          public static ValueTask Soon() => default;
          public static T First<T>(List<T> items) => items[0];
          public static void Swap(ref int a, ref int b) {}
          public static int Sum(params int[] values) => 0;
      }
      public static class Box<T> { public static void Put() {} }`), [
      "Secret: it isn't public or internal, so generated code can't call it",
      "Fire: async void methods can't be awaited; return a Task",
      "Soon: ValueTask methods can't be nodes yet; return a Task",
      "First: generic methods can't be nodes yet",
      "Swap: ref, in and params parameters can't be pins yet",
      "Sum: ref, in and params parameters can't be pins yet",
      "Put: methods of generic classes can't be nodes yet"
    ]);
  });
});

describe('C# scanner: tokens and values', () => {
  test('braces in strings, chars, comments and preprocessor lines do not confuse it', () => {
    const found = nodes(`
      #if DEBUG
      #endif
      public static class S {
          const string A = "}{"; const string B = @"""}""{"; const char C = '}';
          static string D(int x) => $"{x}}}{{" + $@"{(x > 0 ? "}" : "{")}" + """
              } raw {
              """;
          /* } */ // {
          /// @blueprint
          public static int After() => 1;
      }`);
    assert.deepEqual(found.map((d) => d.displayName), ['After']);
  });

  test('literal defaults', () => {
    const [def] = nodes(`public static class S {
      /// @blueprint
      public static void F(double a = -2.5, string b = "it's \\"x\\"", bool c = true, string? d = null, double e = 1e3, int f = 1_000, double g = Math.PI, string h = @"C:\\dir") {}
    }`);
    assert.deepEqual(def.inputs.filter((p) => p.kind === 'data').map((p) => p.defaultValue), [-2.5, 'it\'s "x"', true, null, 1000, 1000, undefined, 'C:\\dir']);
  });

  test('files with top-level statements are recognized', () => {
    assert.equal(scanCSharp('using System;\nConsole.WriteLine("hi");\n').topLevelStatements, true);
    assert.equal(scanCSharp('using System;\nnamespace A;\npublic class B {}\n').topLevelStatements, false);
    assert.equal(scanCSharp('[assembly: System.Reflection.AssemblyVersion("1.0")]\nnamespace A { class B {} }').topLevelStatements, false);
  });
});

describe('C# types', () => {
  const cases: [string, unknown][] = [
    ['double', { id: 'float' }],
    ['int', { id: 'int' }],
    ['bool', { id: 'bool' }],
    ['string', { id: 'string' }],
    ['System.String', { id: 'string' }],
    ['object', undefined],
    ['float', { id: 'native:float' }],
    ['long', { id: 'native:long' }],
    ['int?', { id: 'int', nullable: true }],
    ['string?', { id: 'string', nullable: true }],
    ['List<double>', { id: 'float', container: 'array' }],
    ['HashSet<string>', { id: 'string', container: 'set' }],
    ['Dictionary<string, int>', { id: 'string', container: 'map', valueType: { id: 'int' } }],
    ['List<List<int>>', { id: 'native:List<List<int>>' }],
    ['int[]', { id: 'native:int[]' }],
    ['Vector3', { id: 'native:Vector3' }]
  ];
  for (const [text, expected] of cases) {
    test(text, () => assert.deepEqual(mapCSharpType(text), expected));
  }
});

// Classes (docs/node-authoring.md, gap 2): a class's public constructors, instance methods,
// properties and fields; not a struct's (Set would change a copy).
describe('C# classes', () => {
  const source = [
    'namespace Game;',
    'public class Player : Entity, IDisposable',
    '{',
    '    /// @blueprint',
    '    public double Health { get; set; } = 100;',
    '    /// @blueprint',
    '    public string Name { get; private set; }',
    '    /// @blueprint',
    '    public bool Alive => Health > 0;',
    '    /// @blueprint',
    '    public int Level;',
    '    public const int Max = 10;',
    '    /// @blueprint',
    '    public Player(string name, double start = 10) { Name = name; }',
    '    /// @blueprint',
    '    public double Heal(double amount) { Health += amount; return Health; }',
    '    /// @blueprint',
    '    private void Secret() { }',
    '    public void Dispose() { }',
    '}',
    'public struct Point',
    '{',
    '    /// @blueprint',
    '    public int X;',
    '}',
    ''
  ].join('\n');

  test('reads constructors, instance methods, properties and fields of classes', () => {
    const scan = scanCSharp(source);
    assert.deepEqual(scan.classes!.map((c) => c.name), ['Game.Player']);
    const [cls] = scan.classes!;
    assert.deepEqual([cls.type, cls.base], [{ id: 'native:Player' }, { id: 'native:Entity' }]);
    assert.deepEqual(cls.init!.params.map((p) => p.name), ['name', 'start']);
    assert.deepEqual(cls.methods.map((m) => m.name), ['Heal', 'Dispose']);
    assert.deepEqual(cls.properties.map((p) => [p.name, p.readonly]), [['Health', false], ['Name', true], ['Alive', true], ['Level', false]]);
    assert.deepEqual(scan.skipped.filter((s) => s.marked).map((s) => s.name), ['Secret']);
  });

  test('marked members become nodes, named with the namespace', () => {
    const { definitions } = exposeFunctions(scanCSharp(source), CS);
    assert.deepEqual(definitions.map((d) => d.type.slice(d.type.indexOf('#') + 1)), [
      'Game.Player:new', 'Game.Player:Heal', 'Game.Player:get:Health', 'Game.Player:set:Health', 'Game.Player:get:Name', 'Game.Player:get:Alive', 'Game.Player:get:Level', 'Game.Player:set:Level'
    ]);
  });
});

// Several outputs (docs/node-authoring.md, gap 3): out parameters, after the value returned, and
// tuples, named in them or by @outputs.
describe('C# several outputs', () => {
  test('out parameters follow the value returned', () => {
    const [tryParse] = nodes(`
      public static class P {
          /// @blueprint
          public static bool TryParse(string text, out double value) { value = 0; return true; }
      }`);
    assert.deepEqual(tryParse.inputs.filter((p) => p.kind === 'data').map((p) => p.id), ['text']);
    assert.deepEqual(tryParse.outputs.filter((p) => p.kind === 'data').map((p) => [p.id, p.type?.id]), [['returnValue', 'bool'], ['value', 'float']]);
    assert.deepEqual((tryParse.implementation as { results?: unknown }).results, { kind: 'out', names: ['value'], returnValue: true });
  });

  test('a tuple, named in it or by @outputs; an unnamed one without @outputs is one value', () => {
    const found = nodes(`
      public static class T {
          /// @blueprint
          public static (int low, double high) Range(int n) => (0, n);
          /// @blueprint
          /// @outputs first second
          public static (int, int) Pair() => (1, 2);
          /// @blueprint
          public static (int, int) Unnamed() => (1, 2);
      }`);
    const outputs = (name: string) => found.find((d) => d.displayName === name)!.outputs.filter((p) => p.kind === 'data').map((p) => p.id);
    assert.deepEqual(outputs('Range'), ['low', 'high']);
    assert.deepEqual(outputs('Pair'), ['first', 'second']);
    assert.deepEqual(outputs('Unnamed'), ['returnValue']);
  });
});

// Async methods (docs/node-authoring.md, gap 4): a Task or Task<T> is a latent node whose value is T.
describe('C# async methods', () => {
  test('Task and Task<T> methods are latent, with Completed and the task value', () => {
    const found = nodes(`
      public static class Remote {
          /// @blueprint
          public static async Task<int> Load(string key) { await Task.Delay(1); return 1; }
          /// @blueprint
          public static Task Save() => Task.CompletedTask;
          /// @blueprint
          public static System.Threading.Tasks.Task<double> Later() => Task.FromResult(1.0);
          /// @blueprint
          public static async Task<int> TryLoad(out int code) { code = 0; return 1; }
      }
      public class Store {
          /// @blueprint
          public async Task<bool> Fetch(string key) { await Task.Delay(1); return true; }
      }`);
    const shape = (name: string) => {
      const def = found.find((d) => d.displayName === name)!;
      return [def.latent, def.outputs.map((p) => `${p.id}${p.type ? `:${p.type.id}` : ''}`)];
    };
    assert.deepEqual(shape('Load'), [true, ['completed', 'returnValue:int']]);
    assert.deepEqual(shape('Save'), [true, ['completed']]);
    assert.deepEqual(shape('Later'), [true, ['completed', 'returnValue:float']]);
    assert.deepEqual(shape('Fetch'), [true, ['completed', 'returnValue:bool']]);
    assert.ok(!found.some((d) => d.displayName === 'Try Load'));
    assert.deepEqual(skipped(`
      public static class R {
          /// @blueprint
          public static async Task<int> TryLoad(out int code) { code = 0; return 1; }
      }`), ["TryLoad: async methods can't have out parameters"]);
  });
});
