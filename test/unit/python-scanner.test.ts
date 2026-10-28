// The Python declaration scanner (docs/code-as-nodes.md), checked by example and against Python's
// own `ast` module on real modules when Python is installed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { ExposeOptions, exposeFunctions } from '../../src/core/importing/symbols';
import { mapPythonType, scanPython } from '../../src/core/importing/python-scanner';
import { NodeDefinition } from '../../src/core/model';

const PY: ExposeOptions = { language: 'python', path: 'game/combat.py', module: 'game.combat', exposeAll: false };

function nodes(source: string, exposeAll = false): NodeDefinition[] {
  return exposeFunctions(scanPython(source), { ...PY, exposeAll }).definitions;
}

function only(source: string, exposeAll = false): NodeDefinition {
  const found = nodes(source, exposeAll);
  assert.equal(found.length, 1, `expected one node, got ${found.map((n) => n.type).join(', ') || 'none'}`);
  return found[0];
}

const pins = (def: NodeDefinition) => ({
  inputs: def.inputs.map((p) => `${p.id}:${p.kind === 'exec' ? 'exec' : p.type ? JSON.stringify(p.type) : 'any'}${p.defaultValue !== undefined ? `=${JSON.stringify(p.defaultValue)}` : ''}`),
  outputs: def.outputs.map((p) => `${p.id}:${p.kind === 'exec' ? 'exec' : p.type ? JSON.stringify(p.type) : 'any'}`)
});

const skipped = (source: string) => exposeFunctions(scanPython(source), { ...PY, exposeAll: true }).skipped.map((s) => `${s.name}: ${s.reason}`);

describe('Python scanner: exposure', () => {
  test('a function whose docstring says @blueprint becomes a callable node', () => {
    const def = only([
      'def apply_damage(health: float, amount: int = 10) -> float:',
      '    """Subtracts damage from health.',
      '',
      '    @blueprint',
      '    @category Combat',
      '    """',
      '    return max(0.0, health - amount)'
    ].join('\n'));
    assert.equal(def.type, 'fn:python:game/combat.py#apply_damage');
    assert.equal(def.displayName, 'Apply Damage');
    assert.equal(def.category, 'Combat');
    assert.equal(def.description, 'Subtracts damage from health.');
    assert.deepEqual(pins(def), {
      inputs: ['execIn:exec', 'health:{"id":"float"}', 'amount:{"id":"int"}=10'],
      outputs: ['execOut:exec', 'returnValue:{"id":"float"}']
    });
    assert.deepEqual(def.implementation, { kind: 'function', language: 'python', path: 'game/combat.py', name: 'apply_damage', module: 'game.combat' });
  });

  test('"@blueprint pure" in a one-line docstring', () => {
    const def = only("def double(value: float) -> float:\n    '@blueprint pure'\n    return value * 2\n");
    assert.deepEqual(pins(def), { inputs: ['value:{"id":"float"}'], outputs: ['returnValue:{"id":"float"}'] });
  });

  test('only marked functions unless everything is exposed; private names count when marked', () => {
    const source = 'def a(): pass\n\ndef _b():\n    """@blueprint"""\n';
    assert.deepEqual(nodes(source).map((n) => n.displayName), ['B']);
    assert.deepEqual(nodes(source, true).map((n) => n.displayName), ['A', 'B']);
  });
});

describe('Python scanner: declarations', () => {
  test('only top-level defs: not methods, nested functions or defs under if', () => {
    const found = nodes([
      'import os',
      '@decorator(1)',
      'def top(x):',
      '    def inner(): pass',
      '    return x',
      'class Game:',
      '    def run(self): pass',
      'if os.name == "nt":',
      '    def windows_only(): pass',
      'def last(): pass'
    ].join('\n'), true);
    assert.deepEqual(found.map((n) => n.displayName), ['Top', 'Last']);
  });

  test('parameters across lines, with comments and tricky strings', () => {
    const def = only([
      'def f(',
      '    a: dict[str, int],  # a comment with ) and :',
      "    b: str = 'x: (y) # z',",
      '    c: "Vector" = None,',
      '    d=-1.5e3,',
      ') -> None:',
      '    pass'
    ].join('\n'), true);
    assert.deepEqual(pins(def).inputs.slice(1), [
      'a:{"id":"string","container":"map","valueType":{"id":"int"}}',
      'b:{"id":"string"}="x: (y) # z"',
      'c:{"id":"native:Vector"}=null',
      'd:any=-1500'
    ]);
    assert.deepEqual(pins(def).outputs, ['execOut:exec']);
  });

  test('a def inside a docstring or string is not a function', () => {
    const found = nodes('TEXT = """\ndef fake():\n    pass\n"""\ndef real(): pass\n', true);
    assert.deepEqual(found.map((n) => n.displayName), ['Real']);
  });

  test('backslash continuations', () => {
    assert.deepEqual(pins(only('def f(a: int, \\\n      b: int) -> int:\n    return a\n', true)).inputs.slice(1), ['a:{"id":"int"}', 'b:{"id":"int"}']);
  });

  test('keyword-only parameters with defaults are left off; positional-only markers are ignored', () => {
    assert.deepEqual(pins(only('def f(a: int, /, b: int, *, verbose: bool = False) -> None: pass', true)).inputs.slice(1), ['a:{"id":"int"}', 'b:{"id":"int"}']);
  });

  test('functions that cannot be nodes are reported with the reason', () => {
    assert.deepEqual(skipped([
      'async def load(): pass',
      'def ids():\n    yield 1',
      'def total(*values): pass',
      'def opts(**kw): pass',
      'def need(*, key): pass',
      'def first[T](items: list[T]) -> T: pass',
      'def later() -> Awaitable[int]: pass',
      'def gen() -> Iterator[int]: pass'
    ].join('\n')), [
      "load: async functions become latent nodes with Phase 4's latent actions",
      "ids: generator functions can't be nodes",
      "total: variadic parameters (*args, **kwargs) can't be pins",
      "opts: variadic parameters (*args, **kwargs) can't be pins",
      "need: keyword-only parameters without defaults can't be pins yet",
      "first: generic functions can't be nodes yet",
      "later: async functions become latent nodes with Phase 4's latent actions",
      "gen: generator functions can't be nodes"
    ]);
  });

  test('without a return annotation, the body decides whether there is an output', () => {
    const found = nodes([
      'def gives(a):\n    if a: return a + 1\n    return 0',
      'def none(a):\n    print(a)\n    return',
      'def nested():\n    def g():\n        return 2\n    g()',
      'def one_line(a): return a'
    ].join('\n'), true);
    assert.deepEqual(found.map((n) => [n.displayName, n.outputs.filter((p) => p.kind === 'data').length]), [['Gives', 1], ['None', 0], ['Nested', 0], ['One Line', 1]]);
  });

  test('literal defaults', () => {
    const def = only("def f(a=1_000, b='it\\'s', c=r'\\d', d=True, e=None, g=b'x', h=f'{x}', i=len('x'), j=\"\"\"x\"\"\"): pass", true);
    assert.deepEqual(def.inputs.slice(1).map((p) => p.defaultValue), [1000, "it's", '\\d', true, null, undefined, undefined, undefined, 'x']);
  });

  test('declaration lines are 1-based', () => {
    assert.equal(scanPython('\n\n# c\ndef f(): pass').functions[0].line, 4);
  });
});

describe('Python types', () => {
  const cases: [string, unknown][] = [
    ['int', { id: 'int' }],
    ['float', { id: 'float' }],
    ['str', { id: 'string' }],
    ['bool', { id: 'bool' }],
    ['Any', undefined],
    ['typing.Any', undefined],
    ['list[int]', { id: 'int', container: 'array' }],
    ['List[str]', { id: 'string', container: 'array' }],
    ['typing.Sequence[float]', { id: 'float', container: 'array' }],
    ['set[str]', { id: 'string', container: 'set' }],
    ['dict[str, float]', { id: 'string', container: 'map', valueType: { id: 'float' } }],
    ['Mapping[str, list[int]]', { id: 'native:Mapping[str, list[int]]' }],
    ['Optional[int]', { id: 'int', nullable: true }],
    ['int | None', { id: 'int', nullable: true }],
    ['Union[str, None]', { id: 'string', nullable: true }],
    ['int | str', { id: 'native:int | str' }],
    ["Literal['a', 'b']", { id: 'string' }],
    ['Literal[1, 2]', { id: 'int' }],
    ['"Vector"', { id: 'native:Vector' }],
    ['list[int | None]', { id: 'native:list[int | None]' }],
    ['tuple[int, int]', { id: 'native:tuple[int, int]' }],
    ['game.Vector', { id: 'native:game.Vector' }]
  ];
  for (const [text, expected] of cases) {
    test(text, () => assert.deepEqual(mapPythonType(text), expected));
  }
});

// Python's ast is the reference: on real modules, every top-level def it finds must be found here,
// with the same parameter names and literal defaults.
describe('Python scanner against ast', () => {
  const python = ['python3', 'python', 'py'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);
  const AST_SCRIPT = `
import ast, json, sys, importlib, inspect
out = []
for name in sys.argv[1:]:
    path = inspect.getsourcefile(importlib.import_module(name))
    src = open(path, encoding="utf-8").read()
    fns = []
    for node in ast.parse(src).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            a = node.args
            pos = a.posonlyargs + a.args
            defaults = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
            params = []
            for arg, d in zip(pos, defaults):
                value = None
                if isinstance(d, ast.Constant) and isinstance(d.value, (int, float, str, bool)) and not isinstance(d.value, complex):
                    value = d.value
                params.append([arg.arg, value])
            fns.append({"name": node.name, "line": node.lineno, "params": params, "async": isinstance(node, ast.AsyncFunctionDef)})
    out.append({"module": name, "path": path, "functions": fns})
print(json.dumps(out))
`;

  test('top-level functions, parameters and defaults match on standard library modules', (t) => {
    if (!python) return t.skip('Python is not installed');
    const modules = ['textwrap', 'shlex', 'string', 'json.encoder', 'fnmatch', 'colorsys', 'bisect', 'heapq', 'statistics', 'difflib'];
    const result = spawnSync(python, ['-c', AST_SCRIPT, ...modules], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const reference = JSON.parse(result.stdout) as { module: string; path: string; functions: { name: string; line: number; params: [string, unknown][]; async: boolean }[] }[];
    let compared = 0;
    for (const mod of reference) {
      const scan = scanPython(fs.readFileSync(mod.path, 'utf8'));
      const ours = new Map(scan.functions.map((f) => [f.name, f]));
      const seen = new Set([...scan.functions, ...scan.skipped].map((f) => `${f.name}@${f.line}`));
      for (const fn of mod.functions) {
        assert.ok(seen.has(`${fn.name}@${fn.line}`), `${mod.module}.${fn.name} (line ${fn.line}) was not found`);
        const found = ours.get(fn.name);
        if (!found || found.line !== fn.line) continue;
        // Keyword-only parameters are left off, as are positional ones after a skipped function.
        assert.deepEqual(found.params.map((p) => p.name), fn.params.map(([name]) => name), `${mod.module}.${fn.name} parameters`);
        const literal = (v: unknown) => (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : undefined);
        assert.deepEqual(found.params.map((p) => (p.defaultValue === null ? undefined : p.defaultValue)), fn.params.map(([, v]) => literal(v)), `${mod.module}.${fn.name} defaults`);
        compared++;
      }
    }
    t.diagnostic(`compared ${compared} functions`);
    assert.ok(compared > 50);
  });
});

// Classes (docs/node-authoring.md, gap 2): __init__, public methods, @property (writable with a
// setter) and annotated attributes documented by the string after them.
describe('Python classes', () => {
  const source = [
    'class Player(Entity):',
    '    health: float = 100',
    '    """@blueprint"""',
    '',
    '    def __init__(self, name: str, start: float = 10) -> None:',
    '        """@blueprint"""',
    '        self.name = name',
    '',
    '    def heal(self, amount: float) -> float:',
    '        """@blueprint"""',
    '        return self.health + amount',
    '',
    '    @property',
    '    def alive(self) -> bool:',
    '        """@blueprint"""',
    '        return self.health > 0',
    '',
    '    @property',
    '    def label(self) -> str:',
    '        """@blueprint"""',
    '        return self.name',
    '',
    '    @label.setter',
    '    def label(self, value: str) -> None:',
    '        self.name = value',
    '',
    '    @staticmethod',
    '    def make() -> "Player":',
    '        """@blueprint"""',
    '        return Player("x")',
    '',
    '    def _hidden(self):',
    '        """@blueprint"""',
    ''
  ].join('\n');

  test('reads __init__, methods, properties and attributes', () => {
    const [cls] = scanPython(source).classes!;
    assert.deepEqual([cls.name, cls.base], ['Player', { id: 'native:Entity' }]);
    assert.deepEqual(cls.init!.params, [{ name: 'name', type: { id: 'string' } }, { name: 'start', type: { id: 'float' }, defaultValue: 10 }]);
    assert.deepEqual(cls.methods.map((m) => [m.name, m.params.map((p) => p.name)]), [['heal', ['amount']]]);
    assert.deepEqual(cls.properties.map((p) => [p.name, p.readonly, p.type]), [['health', false, { id: 'float' }], ['alive', true, { id: 'bool' }], ['label', false, { id: 'string' }]]);
    assert.deepEqual(scanPython(source).skipped.map((s) => s.name), ['Player.make', 'Player._hidden']);
  });

  test('marked members become nodes with a Target', () => {
    const { definitions } = exposeFunctions(scanPython(source), { language: 'python', path: 'game/player.py', module: 'game.player', exposeAll: false });
    assert.deepEqual(definitions.map((d) => d.type.slice(d.type.indexOf('#') + 1)), ['Player:new', 'Player:heal', 'Player:get:health', 'Player:set:health', 'Player:get:alive', 'Player:get:label', 'Player:set:label']);
  });
});
