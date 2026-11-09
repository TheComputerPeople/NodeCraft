// Expose Functions as Nodes (docs/code-as-nodes.md) in every built-in language: a file's unmarked
// functions are its candidates; marking them (each in its language's documentation style) makes
// them nodes. A C or C++ source's functions become nodes through its header: declared and marked
// there, or marked where the header declares them, in a header that's made when there's none.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { headerFor, sourceFunctions, withDeclarations } from '../../src/core/importing/c-sources';
import { scanCpp } from '../../src/core/importing/cpp-scanner';
import { docStyle, exposeCandidates, withMarkers } from '../../src/core/importing/expose';
import { scanSymbols, symbolCandidates } from '../../src/core/importing/language-server';
import { ModuleScan, exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';
import { goSymbols } from './corpus';

const packs = builtinLanguagePacks();

// A file of each language with one function, Add, that isn't a node yet.
const FILES: Record<string, { path: string; text: string }> = {
  typescript: { path: 'src/calc.ts', text: 'export function add(a: number, b: number): number {\n  return a + b;\n}\n' },
  javascript: { path: 'src/calc.js', text: '/**\n * @param {number} a\n * @param {number} b\n * @returns {number}\n */\nexport function add(a, b) {\n  return a + b;\n}\n' },
  python: { path: 'calc.py', text: 'def add(a: float, b: float) -> float:\n    return a + b\n' },
  csharp: { path: 'Calc.cs', text: 'namespace Game;\n\npublic static class Calc\n{\n    public static double Add(double a, double b) => a + b;\n}\n' },
  cpp: { path: 'calc.h', text: '#pragma once\n\ndouble add(double a, double b);\n' },
  rust: { path: 'src/calc.rs', text: 'pub fn add(a: f64, b: f64) -> f64 {\n    a + b\n}\n' },
  java: { path: 'src/main/java/game/Calc.java', text: 'package game;\n\npublic final class Calc {\n    public static double add(double a, double b) {\n        return a + b;\n    }\n}\n' },
  go: { path: 'calc/calc.go', text: 'package calc\n\n// Add adds.\nfunc Add(a, b float64) float64 {\n\treturn a + b\n}\n' },
  lua: { path: 'calc.lua', text: 'local M = {}\n\n---@param a number\n---@param b number\n---@return number\nfunction M.add(a, b)\n  return a + b\nend\n\nreturn M\n' },
  gdscript: { path: 'calc.gd', text: 'extends RefCounted\n\n\nstatic func add(a: float, b: float) -> float:\n\treturn a + b\n' },
  ruby: { path: 'lib/calc.rb', text: 'module Calc\n  # @param [Float] a\n  # @param [Float] b\n  # @return [Float]\n  def self.add(a, b)\n    a + b\n  end\nend\n' },
  php: { path: 'src/Calc.php', text: '<?php\nnamespace App;\n\nfinal class Calc\n{\n    public static function add(float $a, float $b): float\n    {\n        return $a + $b;\n    }\n}\n' }
};

// The file read as the extension reads it: its pack's scanner, or (Go) gopls's symbols.
function scan(language: string, text: string): { scan: ModuleScan; candidates: ReturnType<typeof exposeCandidates> } {
  const pack = packs.get(language)!;
  if (pack.importer?.scan) {
    const result = pack.importer.scan(text);
    return { scan: result, candidates: exposeCandidates(result) };
  }
  const symbols = goSymbols(text);
  const spec = pack.importer!.languageServer!;
  return { scan: scanSymbols(text, symbols, spec, (t) => pack.mapType(t)), candidates: symbolCandidates(text, symbols, spec) };
}

describe('Expose Functions as Nodes', () => {
  test('every built-in language has a file to expose', () => {
    assert.deepEqual(packs.all().map((p) => p.id).filter((id) => !FILES[id]), []);
  });

  for (const [language, file] of Object.entries(FILES)) {
    test(`${language}: the unmarked function is a candidate, and marking it makes it a node`, () => {
      const before = scan(language, file.text);
      assert.deepEqual(before.candidates.map((c) => c.name.toLowerCase()), ['add'], JSON.stringify(before.scan.skipped));
      assert.equal(exposeFunctions(before.scan, { language, path: file.path, exposeAll: false }).definitions.length, 0);
      const marked = withMarkers(file.text, before.candidates, '@blueprint pure', docStyle(language)!);
      const after = scan(language, marked);
      const nodes = exposeFunctions(after.scan, { language, path: file.path, exposeAll: false }).definitions;
      assert.deepEqual(nodes.map((n) => n.displayName), ['Add'], marked);
      assert.ok(nodes[0].inputs.every((p) => p.kind === 'data'), `pure: no exec pins\n${marked}`);
      assert.deepEqual(after.candidates, [], 'nothing left to expose');
    });
  }

  test('CRLF files keep their line endings', () => {
    const text = FILES.rust.text.replace(/\n/g, '\r\n');
    const marked = withMarkers(text, scan('rust', text).candidates, '@blueprint', docStyle('rust')!);
    assert.ok(!/[^\r]\n/.test(marked), JSON.stringify(marked));
  });
});

describe('Expose Functions as Nodes on C and C++ sources', () => {
  const C_SOURCE = [
    '#include <stdio.h>', '', 'static int helper(int x) { return x; }', '', '/* Adds. */', 'double add(double a, double b)', '{', '    return a + b;', '}', '',
    'int twice(int v) {', '    return helper(v) * 2;', '}', '', 'int main(void) { return 0; }', ''
  ].join('\n');

  test('a C file without a header: a header with extern "C", the functions declared and marked, and the source including it', () => {
    const functions = sourceFunctions(C_SOURCE, undefined);
    assert.deepEqual(functions.map((f) => [f.name, f.declaration, f.header.state]), [['add', 'double add(double a, double b);', 'missing'], ['twice', 'int twice(int v);', 'missing']]);
    assert.equal(headerFor('src/function.c', () => false), 'src/function.h');
    const result = withDeclarations({ path: 'src/function.c', text: C_SOURCE }, { path: 'src/function.h' }, functions, '@blueprint', true);
    assert.match(result.header, /#ifdef __cplusplus\nextern "C" \{\n#endif\n\n\/\/\/ @blueprint\ndouble add\(double a, double b\);\n\/\/\/ @blueprint\nint twice\(int v\);\n\n#ifdef __cplusplus\n\}\n#endif/);
    assert.ok(result.source?.startsWith('#include "function.h"\n#include <stdio.h>'), result.source);
    const nodes = exposeFunctions(scanCpp(result.header), { language: 'cpp', path: 'src/function.h', exposeAll: false }).definitions;
    assert.deepEqual(nodes.map((n) => n.displayName), ['Add', 'Twice']);
  });

  test('a C++ file whose header declares one function: it is marked there, the other declared in its namespace', () => {
    const source = '#include "calc.hpp"\n\nnamespace game {\n\nint twice(int v) { return v * 2; }\n\nint thrice(int v) { return v * 3; }\n\n}  // namespace game\n';
    const header = '#ifndef CALC_HPP\n#define CALC_HPP\n\nnamespace game {\nint twice(int v);\n}\n\n#endif\n';
    assert.equal(headerFor('calc.cpp', (f) => f === 'calc.hpp'), 'calc.hpp');
    const functions = sourceFunctions(source, header);
    assert.deepEqual(functions.map((f) => [f.name, f.container, f.header.state]), [['twice', 'game', 'declared'], ['thrice', 'game', 'missing']]);
    const result = withDeclarations({ path: 'calc.cpp', text: source }, { path: 'calc.hpp', text: header }, functions, '@blueprint', false);
    assert.equal(result.source, undefined, 'an existing header: the source is left as it is');
    assert.match(result.header, /namespace game \{\n\/\/\/ @blueprint\nint twice\(int v\);\n\}/);
    assert.match(result.header, /namespace game \{\n\/\/\/ @blueprint\nint thrice\(int v\);\n\}  \/\/ namespace game\n\n#endif/, 'before the include guard\'s #endif');
    const nodes = exposeFunctions(scanCpp(result.header), { language: 'cpp', path: 'calc.hpp', exposeAll: false }).definitions;
    assert.deepEqual(nodes.map((n) => n.type).sort(), ['fn:cpp:calc.hpp#game.thrice', 'fn:cpp:calc.hpp#game.twice']);
  });

  test('a function its header marks already is no candidate', () => {
    const functions = sourceFunctions('int one(void) { return 1; }\n', '/// @blueprint\nint one(void);\n');
    assert.equal(functions[0].header.state, 'marked');
  });
});
