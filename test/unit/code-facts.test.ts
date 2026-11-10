// What each language's files declare and import (src/core/codemap/facts.ts, run by the parser in
// src/extension/code-parser.ts): declarations with their containers, imports as written, packages and
// entry points, in all 12 languages.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { FileFacts, phpUses, rustUsePaths } from '../../src/core/codemap/facts';
import { GrammarId } from '../../src/core/parsing/grammars';
import { CodeParser } from '../../src/extension/code-parser';
import { repoRoot } from './helpers';

// "kind Container.name" for each declaration, "kind source" for each import, "kind name" for each entry.
function summary(facts: FileFacts): { declarations: string[]; imports: string[]; entries: string[]; package?: string } {
  return {
    declarations: facts.declarations.map((d) => `${d.kind} ${[...d.container, d.name].join('.')}`),
    imports: facts.imports.map((i) => `${i.kind} ${i.source}${i.names ? ` [${i.names.join(',')}]` : ''}${i.level ? ` ^${i.level}` : ''}${i.path ? ` @${i.path}` : ''}`),
    entries: facts.entries.map((e) => `${e.kind}${e.name ? ` ${e.name}` : ''}`),
    ...(facts.package ? { package: facts.package } : {})
  };
}

const CASES: { grammar: GrammarId; code: string; expected: ReturnType<typeof summary> }[] = [
  {
    grammar: 'typescript',
    code: 'import { a } from "./a";\nexport * from "./b";\nconst c = require("c");\nconst d = await import("./d");\nexport class A { m() {} }\nexport function f() {}\nexport const g = () => 1;\ninterface I {}\nenum E { X }\ntype T = number;\nnamespace N { export function h() {} }\ntest("adds", () => {});\n',
    expected: {
      declarations: ['class A', 'method A.m', 'function f', 'function g', 'interface I', 'enum E', 'type T', 'namespace N', 'function N.h'],
      imports: ['module ./a', 'module ./b', 'module c', 'module ./d'],
      entries: ['test adds']
    }
  },
  {
    grammar: 'tsx',
    code: 'import React from "react";\nexport function App() { return <div />; }\n',
    expected: { declarations: ['function App'], imports: ['module react'], entries: [] }
  },
  {
    grammar: 'javascript',
    code: 'const { b } = require("./b");\nclass A { f() {} }\nfunction* gen() {}\nmodule.exports = { A };\ndescribe("A", () => {});\n',
    expected: { declarations: ['class A', 'method A.f', 'function gen'], imports: ['module ./b'], entries: ['test A'] }
  },
  {
    grammar: 'python',
    code: 'import os.path, sys as s\nfrom . import x, y\nfrom ..pkg.mod import (f as g,\n  h)\nclass A:\n    def m(self): pass\ndef main(): pass\ndef test_it(): pass\nif __name__ == "__main__":\n    main()\n',
    expected: {
      declarations: ['class A', 'method A.m', 'function main', 'function test_it'],
      imports: ['module os.path', 'module sys', 'module  [x,y] ^1', 'module pkg.mod [f,h] ^2'],
      entries: ['main main', 'test test_it', 'script']
    }
  },
  {
    grammar: 'c_sharp',
    code: 'using System.IO;\nusing A = B.C;\nusing static System.Math;\nnamespace N.M;\nConsole.WriteLine(1);\nConsole.WriteLine(2);\nclass P { static void Main(){} P(){} [Fact] public void T(){} }\ninterface I {}\nrecord R(int X);\n',
    expected: {
      declarations: ['class P', 'method P.Main', 'constructor P.P', 'method P.T', 'interface I', 'class R'],
      imports: ['module System.IO', 'module B.C', 'module System.Math'],
      entries: ['script', 'test T', 'main Main'],
      package: 'N.M'
    }
  },
  {
    grammar: 'c',
    code: '#include "a.h"\n#include <stdio.h>\nstruct s { int a; };\nstatic int *f(void) { return 0; }\nint main(void) { return 0; }\n',
    expected: { declarations: ['struct s', 'function f', 'function main'], imports: ['include a.h', 'system stdio.h'], entries: ['main main'] }
  },
  {
    grammar: 'cpp',
    code: '#include "a.h"\nnamespace n { class A { void f(); int g() { return 1; } }; }\nint* A::h() { return 0; }\nauto& k() { static int x; return x; }\ntemplate<class T> T id(T t) { return t; }\nint main() {}\n',
    expected: {
      declarations: ['namespace n', 'class n.A', 'method n.A.g', 'method A.h', 'function k', 'function id', 'function main'],
      imports: ['include a.h'],
      entries: ['main main']
    }
  },
  {
    grammar: 'rust',
    code: 'use crate::a::{b, c::d as e, self};\nuse super::x;\npub use std::io::*;\nmod m;\n#[path = "gen/n.rs"]\n#[rustfmt::skip]\npub mod n;\nmod inline { fn q() {} }\nimpl<T> Foo<T> { fn n(&self) {} }\npub trait Tr { fn t(&self); }\n#[test]\nfn tt() {}\nfn main() {}\n',
    expected: {
      declarations: ['namespace inline', 'function inline.q', 'method Foo.n', 'trait Tr', 'function tt', 'function main'],
      imports: ['module crate::a::b', 'module crate::a::c::d', 'module crate::a', 'module super::x', 'module std::io', 'mod m', 'mod n @gen/n.rs'],
      entries: ['test tt', 'main main']
    }
  },
  {
    grammar: 'java',
    code: 'package a.b;\nimport java.util.*;\nimport static a.B.c;\nimport a.c.D;\npublic class A { @Test void t() {} public static void main(String[] a) {} A() {} interface I {} }\n',
    expected: {
      declarations: ['class A', 'method A.t', 'method A.main', 'constructor A.A', 'interface A.I'],
      imports: ['module java.util.*', 'module a.B', 'module a.c.D'],
      entries: ['test t', 'main main'],
      package: 'a.b'
    }
  },
  {
    grammar: 'go',
    code: 'package main\nimport (\n\t"fmt"\n\tx "example.com/m/x"\n)\ntype S struct{}\ntype I interface{}\nfunc (s *S) M() {}\nfunc (g G[T]) N() {}\nfunc main() {}\nfunc TestX(t *testing.T) {}\n',
    expected: {
      declarations: ['struct S', 'interface I', 'method S.M', 'method G.N', 'function main', 'function TestX'],
      imports: ['module fmt', 'module example.com/m/x'],
      entries: ['main main', 'test TestX'],
      package: 'main'
    }
  },
  {
    grammar: 'lua',
    code: 'local m = require("a.b")\nlocal n = require "c"\nlocal function f() end\nfunction M.g() end\nfunction M:h() end\nM.k = function() end\n',
    expected: { declarations: ['function f', 'function M.g', 'function M.h', 'function M.k'], imports: ['module a.b', 'module c'], entries: [] }
  },
  {
    grammar: 'gdscript',
    code: 'class_name A\nextends "res://b.gd"\nconst B = preload("res://c.gd")\nvar d = load("res://d.gd")\nenum E { X }\nclass Inner:\n\tfunc g(): pass\nfunc _init():\n\tpass\nfunc _ready():\n\tpass\n',
    expected: {
      declarations: ['enum E', 'class Inner', 'method Inner.g', 'constructor _init', 'function _ready'],
      imports: ['file res://b.gd', 'file res://c.gd', 'file res://d.gd'],
      entries: ['engine _ready'],
      package: 'A'
    }
  },
  {
    grammar: 'ruby',
    code: 'require "json"\nrequire_relative "../b"\nmodule M::N\n  class A < Base\n    def f; end\n    def self.g; end\n  end\nend\n',
    expected: { declarations: ['namespace M::N', 'class M::N.A', 'method M::N.A.f', 'method M::N.A.g'], imports: ['module json', 'file ../b'], entries: [] }
  },
  {
    grammar: 'php',
    code: '<?php\nnamespace App\\Http;\nuse App\\Models\\{User, Post};\nuse Foo\\Bar as Baz, function Q\\f;\nrequire_once __DIR__ . "/x.php";\ninclude "y.php";\nfunction f() {}\nenum S { case A; }\ntrait T {}\nclass C extends B implements I { public function m() {} #[Test] public function t() {} }\n',
    expected: {
      declarations: ['function f', 'enum S', 'trait T', 'class C', 'method C.m', 'method C.t'],
      imports: ['module App\\Models\\User', 'module App\\Models\\Post', 'module Foo\\Bar', 'module Q\\f', 'file /x.php', 'file y.php'],
      entries: ['test t'],
      package: 'App\\Http'
    }
  }
];

describe('file facts', () => {
  let parser: CodeParser;
  before(async () => {
    parser = await CodeParser.create(path.join(repoRoot, 'grammars'));
  });
  after(() => parser.dispose());

  for (const { grammar, code, expected } of CASES) {
    test(`${grammar}: declarations, imports, package and entry points`, async () => {
      const facts = await parser.facts(grammar, code);
      assert.equal(facts.errors, 0);
      assert.deepEqual(summary(facts), expected);
    });
  }

  test('declarations carry their lines', async () => {
    const facts = await parser.facts('python', 'class A:\n    def m(self):\n        pass\n\n    def n(self):\n        pass\n');
    assert.deepEqual(facts.declarations.map((d) => [d.name, d.line, d.endLine]), [['A', 1, 6], ['m', 2, 3], ['n', 5, 6]]);
  });

  test('a file with a syntax error still has its other declarations', async () => {
    const facts = await parser.facts('typescript', 'interface A { abstract?: boolean; }\nexport function f() {}\nexport class B {}\n');
    assert.ok(facts.errors > 0);
    assert.deepEqual(facts.declarations.map((d) => d.name).filter((n) => n !== 'A'), ['f', 'B']);
  });
});

describe('import forms', () => {
  test("Rust's use trees", () => {
    assert.deepEqual(rustUsePaths('crate::a::{b, c::{d, e as f}, self}'), ['crate::a::b', 'crate::a::c::d', 'crate::a::c::e', 'crate::a']);
    assert.deepEqual(rustUsePaths('std::io::*'), ['std::io']);
    assert.deepEqual(rustUsePaths('x as y'), ['x']);
  });

  test("PHP's use declarations", () => {
    assert.deepEqual(phpUses('use App\\Models\\{User, Post as P};'), ['App\\Models\\User', 'App\\Models\\Post']);
    assert.deepEqual(phpUses('use \\Foo\\Bar as Baz, function Q\\f;'), ['Foo\\Bar', 'Q\\f']);
    assert.deepEqual(phpUses('use const A\\B;'), ['A\\B']);
  });
});
