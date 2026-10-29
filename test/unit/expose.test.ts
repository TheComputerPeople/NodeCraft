// Feedback in code (src/core/importing/expose.ts, docs/node-authoring.md gap 7): the Expose quick
// fixes add the marker in each language's documentation style, and each scanner then reads it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LineEdit, docStyle, exposeCandidates, markerEdit } from '../../src/core/importing/expose';
import { ModuleScan, exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';

const languages = builtinLanguagePacks();
const scan = (language: string, text: string): ModuleScan => languages.get(language)!.importer!.scan!(text);
const apply = (text: string, edit: LineEdit): string => {
  const lines = text.split('\n');
  lines.splice(edit.start, edit.end - edit.start, ...edit.lines);
  return lines.join('\n');
};

// Marks every candidate, one at a time, rescanning after each: what's left, and the nodes made.
function exposeAll(language: string, text: string, marker = '@blueprint'): { text: string; left: number; nodes: string[] } {
  for (let guard = 0; guard < 20; guard++) {
    const [first] = exposeCandidates(scan(language, text));
    if (!first) break;
    const edit = markerEdit(text, first.line, marker, docStyle(language)!, first.kind);
    assert.ok(edit, `${language}: no edit for ${first.name}`);
    text = apply(text, edit);
  }
  const after = scan(language, text);
  const nodes = exposeFunctions(after, { language, path: 'x', exposeAll: false }).definitions.map((d) => d.displayName);
  return { text, left: exposeCandidates(after).length, nodes };
}

const SOURCES: Record<string, { text: string; nodes: string[] }> = {
  typescript: {
    text: [
      'export function plain(a: number): number { return a; }',
      '/** Doubles. */',
      'export function double(a: number): number { return a * 2; }',
      '/**',
      ' * Triples.',
      ' * @param a the value',
      ' */',
      'export function triple(a: number): number { return a * 3; }',
      'export class Counter {',
      '  count = 0;',
      '  add(n: number): number { return (this.count += n); }',
      '}',
      ''
    ].join('\n'),
    nodes: ['Plain', 'Double', 'Triple', 'Add', 'Get Count', 'Set Count']
  },
  python: {
    text: [
      'def plain(a: int) -> int:',
      '    return a',
      '',
      'def double(a: int) -> int:',
      '    """Doubles."""',
      '    return a * 2',
      '',
      'def triple(',
      '    a: int,',
      ') -> int:',
      '    """Triples.',
      '',
      '    More.',
      '    """',
      '    return a * 3',
      '',
      'class Counter:',
      '    count: int = 0',
      '',
      '    def add(self, n: int) -> int:',
      '        return n',
      ''
    ].join('\n'),
    nodes: ['Plain', 'Double', 'Triple', 'Add', 'Get Count', 'Set Count']
  },
  csharp: {
    text: [
      'public static class Tools',
      '{',
      '    public static int Plain(int a) => a;',
      '    /// <summary>Doubles.</summary>',
      '    [Obsolete]',
      '    public static int Double(int a) => a * 2;',
      '}',
      ''
    ].join('\n'),
    nodes: ['Plain', 'Double']
  },
  cpp: { text: 'namespace m {\n[[nodiscard]] int plain(int a);\n/// Doubles.\nint twice(int a);\n}\n', nodes: ['Plain', 'Twice'] },
  rust: { text: 'pub fn plain(a: i64) -> i64 { a }\n/// Doubles.\n#[inline]\npub fn twice(a: i64) -> i64 { a * 2 }\n', nodes: ['Plain', 'Twice'] },
  java: { text: 'package m;\npublic final class Tools {\n    public static long plain(long a) { return a; }\n    /** Doubles. */\n    @SuppressWarnings("x")\n    public static long twice(long a) { return a * 2; }\n}\n', nodes: ['Plain', 'Twice'] },
  lua: { text: 'local M = {}\nfunction M.plain(a) return a end\n--- Doubles.\nfunction M.twice(a) return a * 2 end\nreturn M\n', nodes: ['Plain', 'Twice'] },
  gdscript: { text: 'extends RefCounted\n\nstatic func plain(a: int) -> int:\n\treturn a\n\n## Doubles.\nstatic func twice(a: int) -> int:\n\treturn a * 2\n', nodes: ['Plain', 'Twice'] },
  ruby: { text: 'module M\n  def self.plain(a)\n    a\n  end\n\n  # Doubles.\n  # @param [Integer] a\n  def self.twice(a)\n    a * 2\n  end\nend\n', nodes: ['Plain', 'Twice'] },
  php: { text: '<?php\nfunction plain(int $a): int { return $a; }\n/**\n * Doubles.\n */\nfunction twice(int $a): int { return $a * 2; }\n', nodes: ['Plain', 'Twice'] }
};

describe('Expose as Blueprint node', () => {
  for (const [language, source] of Object.entries(SOURCES)) {
    test(`${language}: each declaration gets the marker in the language's own comments, which the scanner reads`, () => {
      const result = exposeAll(language, source.text);
      assert.equal(result.left, 0, result.text);
      assert.deepEqual(result.nodes.sort(), [...source.nodes].sort(), result.text);
    });
  }

  test('the marker joins an existing comment, keeping its text', () => {
    const ts = exposeAll('typescript', SOURCES.typescript.text).text;
    assert.ok(ts.includes('/**\n * Doubles.\n * @blueprint\n */\nexport function double'), ts);
    assert.ok(ts.includes(' * @param a the value\n * @blueprint\n */\nexport function triple'), ts);
    assert.ok(ts.includes('/** @blueprint */\nexport function plain'), ts);
    const py = exposeAll('python', SOURCES.python.text).text;
    assert.ok(py.includes('def plain(a: int) -> int:\n    """@blueprint"""\n    return a'), py);
    assert.ok(py.includes('    """Doubles.\n    @blueprint"""'), py);
    assert.ok(py.includes('    More.\n    @blueprint\n    """'), py);
    assert.ok(py.includes('    count: int = 0\n    """@blueprint"""'), py);
    const cs = exposeAll('csharp', SOURCES.csharp.text).text;
    assert.ok(cs.includes('    /// <summary>Doubles.</summary>\n    /// @blueprint\n    [Obsolete]\n    public static int Double'), cs);
    assert.ok(exposeAll('lua', SOURCES.lua.text).text.includes('--- Doubles.\n---@blueprint\nfunction M.twice'));
  });

  test('Expose as pure Blueprint node makes a pure node; a one-line Python def has no room', () => {
    const { text } = exposeAll('rust', 'pub fn plain(a: i64) -> i64 { a }\n', '@blueprint pure');
    const [def] = exposeFunctions(scan('rust', text), { language: 'rust', path: 'x', exposeAll: false }).definitions;
    assert.ok(!def.inputs.some((p) => p.kind === 'exec'), text);
    assert.equal(markerEdit('def f(a: int) -> int: return a\n', 1, '@blueprint', docStyle('python')!), undefined);
  });

  test('candidates leave out marked declarations', () => {
    const marked = scan('typescript', '/** @blueprint */\nexport function done(): void {}\nexport function todo(): void {}\n');
    assert.deepEqual(exposeCandidates(marked).map((c) => c.name), ['todo']);
  });

  test('a Lua field is marked on its own ---@field line', () => {
    const text = 'local M = {}\n---@class Box\n---@field size number The size.\nlocal Box = {}\nBox.__index = Box\n---@blueprint\nfunction Box.new() return setmetatable({}, Box) end\nM.Box = Box\nreturn M\n';
    const { text: after, left, nodes } = exposeAll('lua', text);
    assert.ok(after.includes('---@field size number The size. @blueprint\n'), after);
    assert.equal(left, 0);
    assert.deepEqual(nodes.sort(), ['Construct Box', 'Get Size', 'Set Size']);
  });
});

describe('exposeAllFunctions in every language', () => {
  test('public functions become nodes, and private ones are not reported', () => {
    const cases: [string, string, string[]][] = [
      ['csharp', 'public static class T {\n    public static int A() => 1;\n    private static int B() => 2;\n}\n', ['A']],
      ['java', 'package m;\npublic final class T {\n    public static long a() { return 1; }\n    private static long b() { return 2; }\n}\n', ['A']],
      ['rust', 'pub fn a() -> i64 { 1 }\nfn b() -> i64 { 2 }\n', ['A']],
      ['ruby', 'module M\n  def self.a\n    1\n  end\n  def self._b\n    2\n  end\nend\n', ['A']],
      ['lua', 'local M = {}\nfunction M.a() return 1 end\nlocal function b() return 2 end\nreturn M\n', ['A']],
      ['gdscript', 'extends RefCounted\n\nstatic func a() -> int:\n\treturn 1\n\nstatic func _b() -> int:\n\treturn 2\n', ['A']],
      ['php', '<?php\nfunction a(): int { return 1; }\n', ['A']],
      ['cpp', 'int a();\nstatic int b();\n', ['A']]
    ];
    for (const [language, text, nodes] of cases) {
      const exposed = exposeFunctions(scan(language, text), { language, path: 'x', exposeAll: true });
      assert.deepEqual(exposed.definitions.map((d) => d.displayName), nodes, language);
      assert.deepEqual(exposed.skipped.map((s) => `${s.name}: ${s.reason}`), [], language);
    }
  });
});
