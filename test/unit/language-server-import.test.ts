// Tier 2 symbol import (src/core/importing/language-server.ts): functions the language server
// reports, read from their hovers and the doc comments above them, as other servers word them.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findSignature, parseSignature, scanSymbols } from '../../src/core/importing/language-server';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { LanguageServerImport } from '../../src/core/language-pack';
import { TypeRef } from '../../src/core/types';

const spelling = (map: Record<string, string>) => (type: TypeRef) => (type.container ? `${map[type.id]}[]` : map[type.id] ?? 'any');
const JS = spelling({ bool: 'boolean', int: 'number', float: 'number', string: 'string' });
const C = spelling({ bool: 'bool', int: 'long long', float: 'double', string: 'const char*' });

const TS_SPEC: LanguageServerImport = { comments: ['/**', '*', '//'], parameters: 'name: type', returns: 'after', ignore: ['function', 'export'] };
const C_SPEC: LanguageServerImport = { comments: ['///', '//', '/**', '*'], parameters: 'type name', returns: 'before', ignore: ['static', 'inline', 'extern'], namespaceSeparator: '::' };
const RUST_SPEC: LanguageServerImport = { comments: ['///'], parameters: 'name: type', returns: 'after', ignore: ['pub', 'fn'], void: ['()'] };

describe('language server symbol import', () => {
  test('the TypeScript server: JSDoc tags, a code block signature, and number as float', () => {
    const text = ['/**', ' * Triples a value.', ' * @blueprint pure', ' * @category Math|Scaling', ' */', 'function triple(value) {', '  return value * 3;', '}'].join('\n');
    const scan = scanSymbols(text, [{ name: 'triple', line: 5, nameLine: 5, containers: [], hover: '```typescript\nfunction triple(value: number): number\n```\nTriples a value.' }], TS_SPEC, JS);
    assert.deepEqual(scan.functions[0].params, [{ name: 'value', type: { id: 'float' } }]);
    assert.deepEqual(scan.functions[0].returns, { id: 'float' });
    assert.equal(scan.functions[0].line, 6);
    const exposed = exposeFunctions(scan, { language: 'minijs', path: 'tools/score.js', exposeAll: false });
    assert.equal(exposed.definitions[0].displayName, 'Triple');
    assert.equal(exposed.definitions[0].category, 'Math / Scaling');
    assert.equal(exposed.definitions[0].description, 'Triples a value.');
    assert.ok(!exposed.definitions[0].inputs.some((p) => p.kind === 'exec'), 'pure');
  });

  test('clangd: the signature after the summary, a namespace, defaults, and types it doesn\'t know', () => {
    const hover = '### function `damage`\n\n---\n→ `double`\nParameters:\n- `double strength`\n\n---\n```cpp\n// In namespace game::combat\nstatic double damage(double strength, long long level = 1, const Vec2 &at)\n```';
    const text = ['namespace game { namespace combat {', '/// How hard it hits.', '/// @blueprint', '[[nodiscard]]', 'static double', 'damage(double strength, long long level, const Vec2 &at);', '} }'].join('\n');
    const scan = scanSymbols(text, [{ name: 'damage', line: 4, nameLine: 5, containers: ['game', 'combat'], hover }], C_SPEC, C);
    const fn = scan.functions[0];
    assert.equal(fn.container, 'game::combat');
    assert.equal(fn.doc.description, 'How hard it hits.', 'the doc above the attribute and the return type\'s line');
    assert.deepEqual(fn.params, [
      { name: 'strength', type: { id: 'float' } },
      { name: 'level', type: { id: 'int' }, defaultValue: 1 },
      { name: 'at', type: { id: 'native:const Vec2&' } }
    ]);
    assert.deepEqual(fn.returns, { id: 'float' });
    const exposed = exposeFunctions(scan, { language: 'c', path: 'src/combat.h', exposeAll: false });
    assert.equal((exposed.definitions[0].implementation as { module?: string }).module, 'game::combat');
  });

  test('rust-analyzer: the module block is passed over; unit returns nothing', () => {
    const hover = '```rust\ngame::combat\n```\n\n```rust\npub fn heal(\n    amount: f64,\n) -> ()\n```';
    const parsed = parseSignature(findSignature(hover, 'heal')!, 'heal', RUST_SPEC);
    assert.deepEqual(parsed, { params: [{ name: 'amount', type: 'f64' }], returns: null });
  });

  test('gopls: grouped parameters share their type', () => {
    const spec: LanguageServerImport = { comments: ['//'], parameters: 'name type', returns: 'after', ignore: ['func'] };
    assert.deepEqual(parseSignature('func Hit(a, b float64, name string) (float64, error)', 'Hit', spec), {
      params: [{ name: 'a', type: 'float64' }, { name: 'b', type: 'float64' }, { name: 'name', type: 'string' }], returns: '(float64, error)'
    });
    assert.deepEqual(parseSignature('func Reset()', 'Reset', spec), { params: [], returns: null });
  });

  test('functions that can\'t be nodes are skipped with the reason', () => {
    const text = ['// @blueprint', 'void log(const char* format, ...);', '// @blueprint', 'void tick(void);', '// @blueprint', 'void lost();'].join('\n');
    const scan = scanSymbols(text, [
      { name: 'log', line: 1, nameLine: 1, containers: [], hover: '```c\nvoid log(const char *format, ...)\n```' },
      { name: 'tick', line: 3, nameLine: 3, containers: [], hover: '```c\nvoid tick(void)\n```' },
      { name: 'lost', line: 5, nameLine: 5, containers: [] }
    ], C_SPEC, C);
    assert.deepEqual(scan.functions.map((f) => [f.name, f.params, f.returns]), [['tick', [], null]]);
    assert.deepEqual(scan.skipped.map((s) => [s.name, s.marked, s.reason]), [
      ['log', true, 'variadic functions can\'t be nodes'],
      ['lost', true, 'the language server gave no signature for it']
    ]);
    assert.deepEqual(parseSignature('function pick<T>(items: T[]): T', 'pick', TS_SPEC), { reason: 'generic functions can\'t be nodes yet' });
  });
});

// Members of classes and structs (docs/node-authoring.md, gap 2): a method's symbol names its owner
// (Go's receiver), a field's carries its type; Go's objects are pointers.
describe('class members through the language server', () => {
  const GO: LanguageServerImport = { comments: ['//'], parameters: 'name type', returns: 'after', ignore: ['func'], objectsByPointer: true };
  const goSpelling = spelling({ bool: 'bool', int: 'int', float: 'float64', string: 'string' });
  const source = ['package counter', '', 'type Counter struct {', '\t// @blueprint', '\tCount float64', '}', '', '// @blueprint', 'func (c *Counter) Add(amount float64) float64 { return 0 }', ''].join('\n');

  test("a struct's fields and methods become its class, typed as a pointer", () => {
    const scan = scanSymbols(source, [
      { name: 'Count', owner: 'Counter', field: { type: 'float64' }, line: 4, nameLine: 4, containers: [] },
      { name: 'Add', owner: '*Counter', line: 8, nameLine: 8, containers: [], hover: '```go\nfunc (c *Counter) Add(amount float64) float64\n```' }
    ], GO, goSpelling);
    assert.deepEqual(scan.functions, []);
    const [cls] = scan.classes!;
    assert.deepEqual([cls.name, cls.type], ['Counter', { id: 'native:*Counter' }]);
    assert.deepEqual(cls.properties.map((p) => [p.name, p.type]), [['Count', { id: 'float' }]]);
    assert.deepEqual(cls.methods.map((m) => [m.name, m.params, m.returns]), [['Add', [{ name: 'amount', type: { id: 'float' } }], { id: 'float' }]]);
    const { definitions } = exposeFunctions(scan, { language: 'go', path: 'counter/counter.go', module: 'example.com/counter', exposeAll: false });
    assert.deepEqual(definitions.map((d) => d.type.slice(d.type.indexOf('#') + 1)), ['Counter:Add', 'Counter:get:Count', 'Counter:set:Count']);
  });
});

// Several results (docs/node-authoring.md, gap 3): Go's parenthesised results are outputs, named in
// the signature or by @outputs; a last error result isn't one.
describe('several results through the language server', () => {
  const GO: LanguageServerImport = { comments: ['//'], parameters: 'name type', returns: 'after', ignore: ['func'], severalResults: { error: 'error' } };
  const goSpelling = spelling({ bool: 'bool', int: 'int', float: 'float64', string: 'string' });
  const scanOne = (signature: string, doc = '// @blueprint') => {
    const source = ['package demo', '', doc, `${signature} {}`, ''].join('\n');
    const name = /^func (\w+)/.exec(signature)![1];
    const line = source.split('\n').findIndex((l) => l.startsWith('func '));
    return scanSymbols(source, [{ name, line, nameLine: line, containers: [], hover: `\`\`\`go\n${signature}\n\`\`\`` }], GO, goSpelling);
  };

  test('named results, grouped names taking the next type, and a last error', () => {
    const [fn] = scanOne('func Divide(a, b int) (quotient, remainder int, err error)').functions;
    assert.deepEqual(fn.outputs, [{ name: 'quotient', type: { id: 'int' } }, { name: 'remainder', type: { id: 'int' } }]);
    assert.deepEqual(fn.results, { kind: 'tuple', names: ['quotient', 'remainder'], error: true });
  });

  test('one value and an error, an error alone, and unnamed results named by @outputs', () => {
    assert.deepEqual(scanOne('func Load(path string) ([]byte, error)').functions[0].outputs, [{ name: 'returnValue', type: { id: 'native:[]byte' } }]);
    const [save] = scanOne('func Save(path string) error').functions;
    assert.deepEqual([save.outputs, save.results], [[], { kind: 'tuple', names: [], error: true }]);
    assert.deepEqual(scanOne('func Bounds() (int, *Box)', '// @blueprint\n// @outputs size box').functions[0].outputs?.map((o) => o.name), ['size', 'box']);
    assert.deepEqual(scanOne('func Bounds() (int, int)').skipped.map((s) => s.reason), ['its results need names: name them in the signature or with @outputs']);
  });
});

// Go: only capitalized names are exported, so only they are nodes (docs/node-authoring.md, gap 7).
describe("Go's exported names", () => {
  const GO: LanguageServerImport = { comments: ['//'], parameters: 'name type', returns: 'after', ignore: ['func'], exportedNames: 'capitalized' };
  const goSpelling = spelling({ bool: 'bool', int: 'int', float: 'float64', string: 'string' });

  test('lowercase functions are left out, and reported only when marked', () => {
    const source = 'package a\n\nfunc Open() int { return 1 }\n\n// @blueprint\nfunc hidden() int { return 2 }\n\nfunc helper() int { return 3 }\n';
    const fn = (name: string, line: number) => ({ name, line, nameLine: line, containers: [], hover: `\`\`\`go\nfunc ${name}() int\n\`\`\`` });
    const scan = scanSymbols(source, [fn('Open', 2), fn('hidden', 5), fn('helper', 7)], GO, goSpelling);
    assert.deepEqual(scan.functions.map((f) => f.name), ['Open']);
    const exposed = exposeFunctions(scan, { language: 'go', path: 'a/a.go', exposeAll: true });
    assert.deepEqual(exposed.definitions.map((d) => d.displayName), ['Open']);
    assert.deepEqual(exposed.skipped.map((s) => `${s.name}: ${s.reason}`), ["hidden: it isn't exported (capitalized), so generated code can't use it"]);
  });
});
