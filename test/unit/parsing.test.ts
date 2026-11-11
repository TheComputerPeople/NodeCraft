// Parsing with tree-sitter (docs/codebase-map.md, step 2): the grammars in grammars/, the parser and
// its worker, on a snippet of each language, the corpus of project layouts, every fixture's
// generated code in every language, and this repository's own source.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GRAMMAR_IDS, GrammarId, grammarFileName, grammarForFile, grammarForLanguage, grammarForShebang, mayBeScript } from '../../src/core/parsing/grammars';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { CodeParser } from '../../src/extension/code-parser';
import { ParseService } from '../../src/extension/parse-service';
import { repoRoot } from './helpers';

const grammarDir = path.join(repoRoot, 'grammars');

describe('grammars', () => {
  test('each file is parsed by its language\'s grammar', () => {
    const cases: [string, GrammarId | undefined][] = [
      ['src/a.ts', 'typescript'], ['a.d.ts', 'typescript'], ['a.mts', 'typescript'], ['App.tsx', 'tsx'], ['a.jsx', 'javascript'], ['a.cjs', 'javascript'],
      ['a.py', 'python'], ['A.cs', 'c_sharp'], ['a.c', 'c'], ['a.h', 'cpp'], ['A.HPP', 'cpp'], ['a.cc', 'cpp'], ['lib.rs', 'rust'], ['A.java', 'java'],
      ['main.go', 'go'], ['init.lua', 'lua'], ['player.gd', 'gdscript'], ['a.rb', 'ruby'], ['Rakefile', 'ruby'], ['x.gemspec', 'ruby'], ['index.php', 'php'],
      ['C:\\code\\Main.java', 'java'], ['README.md', undefined], ['Makefile', undefined], ['.gitignore', undefined]
    ];
    for (const [file, grammar] of cases) assert.equal(grammarForFile(file), grammar, file);
    for (const language of ['typescript', 'javascript', 'python', 'csharp', 'cpp', 'rust', 'java', 'go', 'lua', 'gdscript', 'ruby', 'php']) {
      assert.ok(grammarForLanguage(language), `every language the extension supports has a grammar: ${language}`);
    }
    assert.equal(grammarForLanguage('cobol'), undefined);
  });

  test("a script without an extension is parsed by the grammar its #! line names", () => {
    const cases: [string, GrammarId | undefined][] = [
      ['#!/usr/bin/env ruby', 'ruby'], ['#!/usr/bin/env php', 'php'], ['#!/usr/bin/python3.12', 'python'], ['#! /usr/bin/env -S node --no-warnings', 'javascript'],
      ['#!/usr/bin/env lua5.4', 'lua'], ['#!/bin/sh', undefined], ['# not a shebang', undefined], ['', undefined]
    ];
    for (const [line, grammar] of cases) assert.equal(grammarForShebang(line), grammar, line);
    // Only where a program would be: a bin/, exe/ or scripts/ folder, or artisan.
    assert.deepEqual(['bin/greet', 'app/exe/run', 'scripts/build', 'artisan', 'README', 'bin/tool.sh', 'src/greet'].map(mayBeScript), [true, true, true, true, false, false, false]);
  });

  test('the built grammars are the ones the manifest names, with their notices', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(grammarDir, 'grammars.json'), 'utf8')) as {
      runtime: string;
      grammars: { id: string; file: string; package: string; version: string; cli: string; license: string; bytes: number; sha256: string }[];
    };
    const runtime = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['web-tree-sitter'];
    assert.equal(manifest.runtime, `web-tree-sitter@${runtime}`, 'the grammars were built for the runtime the extension uses');
    assert.deepEqual(manifest.grammars.map((g) => g.id).sort(), [...GRAMMAR_IDS].sort());
    const notices = fs.readFileSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    for (const grammar of manifest.grammars) {
      assert.equal(grammar.file, grammarFileName(grammar.id as GrammarId));
      assert.equal(grammar.cli, runtime, `${grammar.id} was built by the runtime's own CLI version`);
      const bytes = fs.readFileSync(path.join(grammarDir, grammar.file));
      assert.equal(bytes.length, grammar.bytes, grammar.file);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), grammar.sha256, grammar.file);
      assert.ok(notices.includes(`### ${grammar.package} ${grammar.version}`), `${grammar.package}'s license is in THIRD_PARTY_NOTICES.md`);
    }
    assert.ok(notices.includes(`### web-tree-sitter ${runtime}`));
  });
});

// A few lines of each language: a type, a function with a loop, a branch and a call.
const SNIPPETS: Record<GrammarId, string> = {
  typescript: 'import { b } from "./b";\nexport class A<T> { f(x: T[]): number { for (const v of x) { if (!v) break; } return b(x.length); } }\n',
  tsx: 'export function App(props: { name: string }) { return <div className="a">{props.name}</div>; }\n',
  javascript: 'const { b } = require("./b");\nclass A { f(x) { for (const v of x) { if (!v) break; } return b(x.length); } }\nexport const C = () => <p>hi</p>;\n',
  python: 'from .b import b\n\nclass A:\n    def f(self, x: list[int]) -> int:\n        for v in x:\n            if not v:\n                break\n        return b(len(x))\n',
  c_sharp: 'using System;\nnamespace N;\npublic record P(int X);\npublic class A { public int F(int[] x) { foreach (var v in x) { if (v == 0) break; } return x.Length switch { 0 => 1, _ => 2 }; } }\n',
  c: '#include "b.h"\nstruct s { int a; };\nint f(int n) { for (int i = 0; i < n; i++) { if (i == 3) break; } return b(n); }\n',
  cpp: '#include <vector>\nnamespace n { template <typename T> class A { public: auto f(std::vector<T> x) -> int { for (auto& v : x) { if (!v) break; } return [&]{ return 1; }(); } }; }\n',
  rust: 'use crate::b::b;\npub struct A;\nimpl A { pub fn f(&self, x: &[i32]) -> i32 { for v in x { if *v == 0 { break; } } match x.len() { 0 => 1, n => b(n) } } }\n',
  java: 'package a;\nimport java.util.List;\npublic class A { public int f(List<Integer> x) { for (int v : x) { if (v == 0) break; } return switch (x.size()) { case 0 -> 1; default -> 2; }; } }\n',
  go: 'package a\n\nimport "fmt"\n\nfunc F[T any](x []T) int {\n\tfor _, v := range x {\n\t\tfmt.Println(v)\n\t}\n\treturn len(x)\n}\n',
  lua: 'local b <const> = require("b")\nlocal A = {}\nfunction A.f(x)\n  for _, v in ipairs(x) do\n    if not v then break end\n  end\n  return b(#x)\nend\nreturn A\n',
  gdscript: 'class_name A\nextends Node\n\nconst B = preload("res://b.gd")\n\nfunc f(x: Array[int]) -> int:\n\tfor v in x:\n\t\tif v == 0:\n\t\t\tbreak\n\tawait get_tree().process_frame\n\treturn B.b(x.size())\n',
  ruby: 'require_relative "b"\nmodule M\n  class A < Base\n    def f(x)\n      x.each { |v| break unless v }\n      b(x.length)\n    end\n  end\nend\n',
  php: '<?php\ndeclare(strict_types=1);\nnamespace A;\nuse B\\C;\nfinal class A { public function f(array $x): int { foreach ($x as $v) { if (!$v) { break; } } return match (count($x)) { 0 => 1, default => C::b() }; } }\n'
};

describe('the parser', () => {
  let parser: CodeParser;
  before(async () => {
    parser = await CodeParser.create(grammarDir);
  });
  after(() => parser.dispose());

  for (const grammar of GRAMMAR_IDS) {
    test(`${grammar} parses its language`, async () => {
      const summary = await parser.summarize(grammar, SNIPPETS[grammar]);
      assert.deepEqual(summary.errors, [], `${grammar}: ${JSON.stringify(summary.errors)}`);
      assert.ok(summary.nodes > 20, `${grammar}: ${summary.nodes} nodes`);
    });
  }

  test('a syntax error is reported where it is', async () => {
    const summary = await parser.summarize('python', 'def f(:\n    return 1\n\nx = (1, 2\n');
    assert.ok(summary.errors.length > 0);
    assert.equal(summary.errors[0].line, 1);
  });

  test('a missing grammar fails, and loads once it is there', async () => {
    const empty = fs.mkdtempSync(path.join(repoRoot, 'out', 'grammars-'));
    try {
      const other = await CodeParser.create(empty);
      await assert.rejects(other.summarize('go', 'package a\n'));
      fs.copyFileSync(path.join(grammarDir, grammarFileName('go')), path.join(empty, grammarFileName('go')));
      assert.deepEqual((await other.summarize('go', 'package a\n')).errors, []);
      other.dispose();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

// Bugs of the grammars in grammars/: valid code each parses with an error, and where this
// repository has such code ("file:line").
// `line`: the lines of this repository's source the bug gives errors on.
const KNOWN_GRAMMAR_BUGS: { what: string; grammar: GrammarId; example: string; line: RegExp }[] = [
  {
    what: 'tree-sitter-typescript 0.23.2 takes a member named `abstract` for the modifier',
    grammar: 'typescript',
    example: 'interface A { abstract?: boolean; }\n',
    line: /^\s*abstract\?: /
  }
];

// Every file under `dir` a grammar parses, skipping dependencies and build output.
function sourceFiles(dir: string, skip = /^(node_modules|out|dist|\.git|\.vscode-test|target|build|bin|obj|vendor|\.godot)$/): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.test(entry.name)) found.push(...sourceFiles(full, skip));
    } else if (grammarForFile(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

describe('the parsing worker', () => {
  let service: ParseService;
  before(() => {
    service = new ParseService(grammarDir);
  });
  after(() => service.dispose());

  // `known`: errors a grammar's own bug gives on valid code (KNOWN_GRAMMAR_BUGS), by the line's text.
  async function assertParses(files: { name: string; text: string }[], known: RegExp[] = []): Promise<void> {
    const failures: string[] = [];
    await Promise.all(files.map(async ({ name, text }) => {
      const summary = await service.summarizeFile(name, text);
      const lines = text.split('\n');
      const errors = summary?.errors.filter((e) => !known.some((line) => line.test(lines[e.line - 1] ?? '')));
      if (!summary) failures.push(`${name}: no grammar`);
      else if (errors?.length) failures.push(`${name} (${summary.grammar}): ${errors.slice(0, 3).map((e) => `${e.missing ? 'missing token' : 'error'} at ${e.line}:${e.column}`).join(', ')}`);
    }));
    assert.deepEqual(failures, []);
  }

  test('every source file of the corpus of project layouts parses without errors', async () => {
    const files = sourceFiles(path.join(repoRoot, 'test/fixtures/projects'));
    assert.ok(files.length > 100, `${files.length} files`);
    const languages = new Set(files.map((f) => grammarForFile(f)));
    for (const grammar of GRAMMAR_IDS.filter((g) => g !== 'tsx')) assert.ok(languages.has(grammar), `the corpus has ${grammar} code`);
    await assertParses(files.map((file) => ({ name: path.relative(repoRoot, file), text: fs.readFileSync(file, 'utf8') })));
  });

  test("every fixture's generated code, in every language, parses without errors", async () => {
    const languages = builtinLanguagePacks();
    const registry = new NodeRegistry();
    for (const file of ['sample/visual-nodes/Math/Double.node.json', 'test/fixtures/nodes/Fail.node.json']) {
      registry.register(parseNodeDefinition(fs.readFileSync(path.join(repoRoot, file), 'utf8'))!);
    }
    const fixtures = [path.join(repoRoot, 'sample/demo.vgraph'), ...fs.readdirSync(path.join(repoRoot, 'test/fixtures/graphs')).filter((f) => f.endsWith('.vgraph')).map((f) => path.join(repoRoot, 'test/fixtures/graphs', f))];
    const files: { name: string; text: string }[] = [];
    for (const language of ['typescript', 'javascript', 'python', 'csharp', 'cpp', 'rust', 'java', 'go', 'lua', 'gdscript', 'ruby', 'php']) {
      for (const fixture of fixtures) {
        const document = parseDocument(fs.readFileSync(fixture, 'utf8')).document;
        const output = compileDocument({ ...document, language }, { registry, languages, generate: { sourceFileName: path.basename(fixture) } }).output;
        // A fixture using what a language lacks doesn't compile in it.
        if (!output) continue;
        files.push({ name: `${language}/${output.fileName}`, text: output.text });
        for (const companion of output.companionFiles ?? []) files.push({ name: `${language}/${companion.fileName}`, text: companion.text });
      }
    }
    assert.ok(files.length > 300, `${files.length} generated files`);
    await assertParses(files);
  });

  test("this repository's own source parses without errors", async () => {
    const files = [...sourceFiles(path.join(repoRoot, 'src')), ...sourceFiles(path.join(repoRoot, 'test'), /^(fixtures|node_modules)$/), ...sourceFiles(path.join(repoRoot, 'sample')), ...sourceFiles(path.join(repoRoot, 'scripts'))];
    assert.ok(files.length > 200, `${files.length} files`);
    await assertParses(files.map((file) => ({ name: path.relative(repoRoot, file), text: fs.readFileSync(file, 'utf8') })), KNOWN_GRAMMAR_BUGS.map((bug) => bug.line));
  });

  // Valid code a grammar gets wrong. Each stays here while its example still fails, so an update of
  // the grammar that fixes it is noticed (and the entry removed).
  for (const bug of KNOWN_GRAMMAR_BUGS) {
    test(`known grammar bug: ${bug.what}`, async () => {
      const summary = await service.summarize(bug.grammar, bug.example);
      assert.ok(summary.errors.length > 0, `fixed in this grammar version: remove it from KNOWN_GRAMMAR_BUGS`);
    });
  }

  test('a file no grammar parses has no summary; a stopped worker refuses work', async () => {
    assert.equal(service.summarizeFile('notes.md', '# hi'), undefined);
    const stopped = new ParseService(grammarDir);
    await stopped.dispose();
    await assert.rejects(stopped.summarize('go', 'package a\n'), /stopped/);
  });
});
