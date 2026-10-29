// Metadata tags in code (docs/node-authoring.md, gap 6): @keywords, @compactTitle, @deprecated (and
// each language's own deprecation marker), @advanced, @pinName and @execs, in every scanner.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDocument } from '../../src/core/compiler';
import { scanCpp } from '../../src/core/importing/cpp-scanner';
import { scanCSharp } from '../../src/core/importing/csharp-scanner';
import { scanGdscript } from '../../src/core/importing/gdscript-scanner';
import { scanJava } from '../../src/core/importing/java-scanner';
import { scanSymbols } from '../../src/core/importing/language-server';
import { scanLua } from '../../src/core/importing/lua-scanner';
import { scanPhp } from '../../src/core/importing/php-scanner';
import { scanPython } from '../../src/core/importing/python-scanner';
import { scanRuby } from '../../src/core/importing/ruby-scanner';
import { scanRust } from '../../src/core/importing/rust-scanner';
import { ModuleScan, exposeFunctions } from '../../src/core/importing/symbols';
import { scanTypeScript } from '../../src/core/importing/typescript-scanner';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';

const expose = (scan: ModuleScan, language = 'typescript', path = 'lib/a.ts'): NodeDefinition[] => exposeFunctions(scan, { language, path, exposeAll: false }).definitions;
const byName = (defs: NodeDefinition[], name: string): NodeDefinition => defs.find((d) => d.displayName === name)!;

describe('metadata tags', () => {
  test('@keywords, @compactTitle, @deprecated, @advanced and @pinName', () => {
    const [def] = expose(scanTypeScript([
      '/**',
      ' * @blueprint pure',
      ' * @keywords add sum',
      ' * @compactTitle +',
      ' * @deprecated Use Plus instead.',
      ' * @advanced scale',
      ' * @pinName a First Value',
      ' * @pinName returnValue Total',
      ' */',
      'export function add(a: number, b: number, scale = 1): number { return (a + b) * scale; }',
      ''
    ].join('\n')));
    assert.deepEqual([def.keywords, def.compactTitle, def.deprecated], [['add', 'sum'], '+', { message: 'Use Plus instead.' }]);
    assert.deepEqual(def.inputs.map((p) => [p.id, p.name, !!p.advanced]), [['a', 'First Value', false], ['b', 'B', false], ['scale', 'Scale', true]]);
    assert.deepEqual(def.outputs.map((p) => p.name), ['Total']);
  });

  test('@execs turns a bool result into True and False exec outputs, even when marked pure', () => {
    const defs = expose(scanTypeScript([
      '/**',
      ' * @blueprint pure',
      ' * @execs',
      ' */',
      'export function isEven(n: number): boolean { return n % 2 === 0; }',
      '/**',
      ' * @blueprint',
      ' * @execs',
      ' */',
      'export function count(n: number): number { return n; }',
      ''
    ].join('\n')));
    const even = byName(defs, 'Is Even');
    assert.deepEqual(even.inputs.map((p) => p.id), ['execIn', 'n']);
    assert.deepEqual(even.outputs.map((p) => [p.id, p.name, p.kind]), [['true', 'True', 'exec'], ['false', 'False', 'exec']]);
    assert.equal((even.implementation as { execs?: string }).execs, 'bool');
    // Not a bool: @execs is ignored.
    assert.deepEqual(byName(defs, 'Count').outputs.map((p) => p.id), ['execOut', 'returnValue']);
  });

  test("@execs compiles to the call, then a branch on its result", () => {
    const defs = expose(scanTypeScript('/**\n * @blueprint\n * @execs\n */\nexport function isEven(n: number): boolean { return n % 2 === 0; }\n'));
    const registry = new NodeRegistry();
    registry.registerMany(defs);
    const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
    const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}`, fromNode, fromPin, toNode, toPin });
    const document: GraphDocument = {
      schemaVersion: 3, name: 'Parity', kind: 'class', language: 'typescript', variables: [],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [n('s', 'core:event.start'), n('e', defs[0].type, { 'pin:n': 4 }), n('yes', 'core:console.print', { 'pin:value': 'even' }), n('no', 'core:console.print', { 'pin:value': 'odd' })],
        connections: [w('s', 'execOut', 'e', 'execIn'), w('e', 'true', 'yes', 'execIn'), w('e', 'false', 'no', 'execIn')]
      }]
    };
    const result = compileDocument(document, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'parity.vgraph' } });
    assert.deepEqual(result.diagnostics, []);
    const text = result.output!.text;
    assert.ok(text.includes('this.e_result = isEven(4);') && text.includes('if (this.e_result) {'), text);
    assert.ok(text.indexOf('console.log("even")') < text.indexOf('} else {') && text.indexOf('} else {') < text.indexOf('console.log("odd")'), text);
  });
});

describe("each language's deprecation markers", () => {
  const deprecated = (defs: NodeDefinition[]) => Object.fromEntries(defs.map((d) => [d.displayName, d.deprecated]));

  test('C#: [Obsolete], with the documentation written before it', () => {
    const defs = expose(scanCSharp([
      'public static class Tools',
      '{',
      '    /// <summary>Old.</summary>',
      '    /// @blueprint',
      '    [Obsolete("Use Twice.")]',
      '    public static int Double(int x) => x * 2;',
      '    /// @blueprint',
      '    [System.Obsolete]',
      '    public static int Triple(int x) => x * 3;',
      '}',
      'public class Player',
      '{',
      '    /// @blueprint',
      '    [Obsolete("Use Health.")]',
      '    public int Hp { get; set; }',
      '}',
      ''
    ].join('\n')), 'csharp', 'Tools.cs');
    assert.deepEqual(deprecated(defs), { Double: { message: 'Use Twice.' }, Triple: {}, 'Get Hp': { message: 'Use Health.' }, 'Set Hp': { message: 'Use Health.' } });
    assert.equal(byName(defs, 'Double').description, 'Old.');
  });

  test('C++: [[deprecated]]; Rust: #[deprecated]', () => {
    assert.deepEqual(deprecated(expose(scanCpp('/// @blueprint\n[[deprecated("Use twice.")]] int dbl(int x);\n/// @blueprint\n[[nodiscard, deprecated]] int triple(int x);\n'), 'cpp', 'a.h')), { Dbl: { message: 'Use twice.' }, Triple: {} });
    assert.deepEqual(deprecated(expose(scanRust([
      '/// @blueprint',
      '#[deprecated(since = "1.2", note = "Use twice.")]',
      'pub fn dbl(x: i64) -> i64 { x * 2 }',
      '/// @blueprint',
      '#[deprecated = "Gone."]',
      'pub fn triple(x: i64) -> i64 { x * 3 }',
      '/// @blueprint',
      '#[deprecated]',
      'pub fn quad(x: i64) -> i64 { x * 4 }',
      ''
    ].join('\n')), 'rust', 'src/a.rs')), { Dbl: { message: 'Use twice.' }, Triple: { message: 'Gone.' }, Quad: {} });
  });

  test("Java: @Deprecated, with Javadoc's @deprecated message; Python: @deprecated(...)", () => {
    assert.deepEqual(deprecated(expose(scanJava([
      'package game;',
      'public final class Tools {',
      '    /**',
      '     * @blueprint',
      '     * @deprecated Use twice.',
      '     */',
      '    @Deprecated',
      '    public static long dbl(long x) { return x * 2; }',
      '    /** @blueprint */',
      '    @java.lang.Deprecated(since = "2")',
      '    public static long triple(long x) { return x * 3; }',
      '}',
      ''
    ].join('\n')), 'java', 'Tools.java')), { Dbl: { message: 'Use twice.' }, Triple: {} });
    assert.deepEqual(deprecated(expose(scanPython([
      'from warnings import deprecated',
      '',
      '@deprecated("Use twice.")',
      'def dbl(x: int) -> int:',
      '    """@blueprint"""',
      '    return x * 2',
      '',
      '@typing_extensions.deprecated(\'Gone.\')',
      'def triple(x: int) -> int:',
      '    """@blueprint"""',
      '    return x * 3',
      ''
    ].join('\n')), 'python', 'a.py')), { Dbl: { message: 'Use twice.' }, Triple: { message: 'Gone.' } });
  });

  test("Go: a \"Deprecated:\" paragraph; Lua, GDScript, Ruby and PHP: @deprecated", () => {
    const go = 'package a\n\n// Dbl doubles.\n//\n// Deprecated: Use Twice.\n// @blueprint\nfunc Dbl(x int) int { return x * 2 }\n';
    const goSpec = builtinLanguagePacks().get('go')!;
    const scan = scanSymbols(go, [{ name: 'Dbl', line: 6, nameLine: 6, containers: [], hover: '```go\nfunc Dbl(x int) int\n```' }], goSpec.importer!.languageServer!, (t) => goSpec.mapType(t));
    assert.deepEqual(deprecated(expose(scan, 'go', 'a/a.go')), { Dbl: { message: 'Use Twice.' } });
    assert.deepEqual(deprecated(expose(scanLua('local M = {}\n---@blueprint\n---@deprecated Use twice.\nfunction M.dbl(x) return x * 2 end\nreturn M\n'), 'lua', 'a.lua')), { Dbl: { message: 'Use twice.' } });
    assert.deepEqual(deprecated(expose(scanGdscript('extends RefCounted\n\n## @blueprint\n## @deprecated\nstatic func dbl(x: int) -> int:\n\treturn x * 2\n'), 'gdscript', 'a.gd')), { Dbl: {} });
    assert.deepEqual(deprecated(expose(scanRuby('module A\n  # @blueprint\n  # @deprecated Use twice.\n  def self.dbl(x)\n    x * 2\n  end\nend\n'), 'ruby', 'a.rb')), { Dbl: { message: 'Use twice.' } });
    assert.deepEqual(deprecated(expose(scanPhp('<?php\n/**\n * @blueprint\n * @deprecated Use twice.\n */\nfunction dbl(int $x): int { return $x * 2; }\n'), 'php', 'a.php')), { Dbl: { message: 'Use twice.' } });
  });
});
