// Code classes as parents (docs/code-classes-as-parents.md), in every language with inheritance
// (TypeScript, JavaScript, Python, C#, Java, C++, PHP, Ruby, Lua and GDScript): the Actor below, in
// each language, and the Knight and Game graphs of code-parents.ts.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { GenerateOptions } from '../../src/core/language-pack';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument } from '../../src/core/model';
import { OVERRIDE_EVENT, PARENT_CALL, classDefinitions, declaredClass } from '../../src/core/objects';
import { NodeRegistry } from '../../src/core/registry';
import { ToolNotFoundError, runGeneratedCode } from '../../src/extension/runner';
import { CODE_PARENTS_OUTPUT, Code, gameGraph, knightGraph, method } from './code-parents';
import { PYTHON, corpusToolsFolder } from './corpus';

const repoRoot = path.resolve(__dirname, '../../..');
const languages = builtinLanguagePacks();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-code-parents-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

// The Actor in TypeScript, or in JavaScript (JSDoc types; with no abstract methods, describe has a
// body the Knight replaces).
function jsActor(exports: 'esm' | 'commonjs' | 'typescript'): string {
  const typed = exports === 'typescript';
  const t = (text: string) => (typed ? text : '');
  const doc = (...tags: string[]) => ['  /**', ...tags.map((tag) => `   * ${tag}`), '   */'];
  return [
    '/** @blueprint */',
    `${exports === 'commonjs' ? '' : 'export '}${typed ? 'abstract ' : ''}class Actor {`,
    ...doc('@blueprint', ...(typed ? [] : ['@type {number}'])),
    `  health${t(': number')} = 100;`,
    ...(typed ? ['  readonly name: string;'] : ['  /** @type {string} */', '  name;']),
    ...doc('@blueprint', ...(typed ? [] : ['@param {string} name'])),
    `  constructor(name${t(': string')}) {`,
    '    this.name = name;',
    '  }',
    ...doc('@blueprint', ...(typed ? [] : ['@returns {string}'])),
    `  greet()${t(': string')} {`,
    '    return `${this.name} has ${this.health}`;',
    '  }',
    ...doc('@blueprint overridable', ...(typed ? [] : ['@param {number} damage'])),
    `  hit(damage${t(': number')})${t(': void')} {`,
    '    this.health -= damage;',
    '    console.log(`${this.name} takes ${damage}`);',
    '  }',
    ...(typed
      ? [...doc('@blueprint'), '  abstract describe(): string;']
      : [...doc('@blueprint overridable', '@returns {string}'), '  describe() {', "    return 'someone';", '  }']),
    ...doc('@blueprint'),
    `  turn()${t(': void')} {`,
    '    console.log(`${this.name} is ${this.describe()}`);',
    '    this.hit(3);',
    '    console.log(this.greet());',
    '  }',
    '}',
    ...(exports === 'commonjs' ? ['module.exports = { Actor };'] : []),
    ''
  ].join('\n');
}

const MODULES: Record<string, { path: string; text: string; module?: string }> = {
  typescript: { path: 'lib/actor.ts', text: jsActor('typescript') },
  'javascript-esm': { path: 'lib/actor.mjs', text: jsActor('esm') },
  'javascript-commonjs': { path: 'lib/actor.cjs', text: jsActor('commonjs') },
  python: {
    path: 'lib/game/actor.py',
    module: 'game.actor',
    text: [
      'from abc import ABC, abstractmethod',
      '',
      '',
      'class Actor(ABC):',
      '    """@blueprint"""',
      '',
      '    health: int = 100',
      '    """@blueprint"""',
      '',
      '    def __init__(self, name: str) -> None:',
      '        """@blueprint"""',
      '        self.name = name',
      '        self.health = 100',
      '',
      '    def greet(self) -> str:',
      '        """@blueprint"""',
      '        return f"{self.name} has {self.health}"',
      '',
      '    def hit(self, damage: int) -> None:',
      '        """@blueprint overridable"""',
      '        self.health -= damage',
      '        print(f"{self.name} takes {damage}")',
      '',
      '    @abstractmethod',
      '    def describe(self) -> str:',
      '        """@blueprint"""',
      '',
      '    def turn(self) -> None:',
      '        """@blueprint"""',
      '        print(f"{self.name} is {self.describe()}")',
      '        self.hit(3)',
      '        print(self.greet())',
      ''
    ].join('\n')
  },
  csharp: {
    path: 'lib/Actor.cs',
    text: [
      'namespace Game;',
      '',
      '/// @blueprint',
      'public abstract class Actor',
      '{',
      '    /// @blueprint',
      '    public int Health { get; set; } = 100;',
      '',
      '    public string Name { get; }',
      '',
      '    /// @blueprint',
      '    public Actor(string name) { Name = name; }',
      '',
      '    /// @blueprint',
      '    public string Greet() => $"{Name} has {Health}";',
      '',
      '    /// @blueprint overridable',
      '    public virtual void Hit(int damage) { Health -= damage; System.Console.WriteLine($"{Name} takes {damage}"); }',
      '',
      '    /// @blueprint',
      '    public abstract string Describe();',
      '',
      '    /// @blueprint',
      '    public void Turn() { System.Console.WriteLine($"{Name} is {Describe()}"); Hit(3); System.Console.WriteLine(Greet()); }',
      '}',
      ''
    ].join('\n')
  },
  // hit takes an int (the graph's ints are longs) and describe is protected: the override repeats
  // the code's types and access.
  java: {
    path: 'lib/game/Actor.java',
    module: 'game',
    text: [
      'package game;',
      '',
      '/** @blueprint */',
      'public abstract class Actor {',
      '    /** @blueprint */',
      '    public long health = 100;',
      '',
      '    private final String name;',
      '',
      '    /** @blueprint */',
      '    public Actor(String name) {',
      '        this.name = name;',
      '    }',
      '',
      '    /** @blueprint */',
      '    public String greet() {',
      '        return name + " has " + health;',
      '    }',
      '',
      '    /** @blueprint overridable */',
      '    public void hit(int damage) {',
      '        health -= damage;',
      '        System.out.println(name + " takes " + damage);',
      '    }',
      '',
      '    protected abstract String describe();',
      '',
      '    /** @blueprint */',
      '    public void turn() {',
      '        System.out.println(name + " is " + describe());',
      '        hit(3);',
      '        System.out.println(greet());',
      '    }',
      '}',
      ''
    ].join('\n')
  },
  // describe is const and protected: the override is too.
  cpp: {
    path: 'lib/actor.h',
    text: [
      '#pragma once',
      '#include <iostream>',
      '#include <string>',
      '#include <utility>',
      '',
      'namespace game {',
      '',
      '/** @blueprint */',
      'class Actor {',
      'public:',
      '    /** @blueprint */',
      '    int health = 100;',
      '',
      '    /** @blueprint */',
      '    explicit Actor(std::string name) : name_(std::move(name)) {}',
      '    virtual ~Actor() = default;',
      '',
      '    /** @blueprint */',
      '    std::string greet() const { return name_ + " has " + std::to_string(health); }',
      '',
      '    /** @blueprint overridable */',
      '    virtual void hit(int damage) {',
      '        health -= damage;',
      '        std::cout << name_ << " takes " << damage << std::endl;',
      '    }',
      '',
      '    /** @blueprint */',
      '    void turn() {',
      '        std::cout << name_ << " is " << describe() << std::endl;',
      '        hit(3);',
      '        std::cout << greet() << std::endl;',
      '    }',
      '',
      'protected:',
      '    virtual std::string describe() const = 0;',
      '',
      'private:',
      '    std::string name_;',
      '};',
      '',
      '}  // namespace game',
      ''
    ].join('\n')
  },
  // describe is protected.
  php: {
    path: 'lib/Actor.php',
    text: [
      '<?php',
      '',
      'declare(strict_types=1);',
      '',
      'namespace Game;',
      '',
      '/** @blueprint */',
      'abstract class Actor',
      '{',
      '    /** @blueprint */',
      '    public int $health = 100;',
      '',
      '    private string $name;',
      '',
      '    /** @blueprint */',
      '    public function __construct(string $name)',
      '    {',
      '        $this->name = $name;',
      '    }',
      '',
      '    /** @blueprint */',
      '    public function greet(): string',
      '    {',
      '        return "{$this->name} has {$this->health}";',
      '    }',
      '',
      '    /** @blueprint overridable */',
      '    public function hit(int $damage): void',
      '    {',
      '        $this->health -= $damage;',
      '        echo "{$this->name} takes {$damage}\\n";',
      '    }',
      '',
      '    abstract protected function describe(): string;',
      '',
      '    /** @blueprint */',
      '    public function turn(): void',
      '    {',
      '        echo "{$this->name} is {$this->describe()}\\n";',
      '        $this->hit(3);',
      '        echo $this->greet(), "\\n";',
      '    }',
      '}',
      ''
    ].join('\n')
  },
  // Ruby has no abstract methods: describe has a body the Knight replaces. (Its module isn't Game,
  // the graph's top-level class.)
  ruby: {
    path: 'lib/guild/actor.rb',
    text: [
      '# frozen_string_literal: true',
      '',
      'module Guild',
      '  # @blueprint',
      '  class Actor',
      '    # @blueprint',
      '    # @return [Integer]',
      '    attr_accessor :health',
      '',
      '    # @blueprint',
      '    # @param name [String]',
      '    def initialize(name)',
      '      @name = name',
      '      @health = 100',
      '    end',
      '',
      '    # @blueprint',
      '    # @return [String]',
      '    def greet',
      '      "#{@name} has #{@health}"',
      '    end',
      '',
      '    # @blueprint overridable',
      '    # @param damage [Integer]',
      '    def hit(damage)',
      '      @health -= damage',
      '      puts "#{@name} takes #{damage}"',
      '    end',
      '',
      '    # @blueprint overridable',
      '    # @return [String]',
      '    def describe',
      "      'someone'",
      '    end',
      '',
      '    # @blueprint',
      '    def turn',
      '      puts "#{@name} is #{describe}"',
      '      hit(3)',
      '      puts greet',
      '    end',
      '  end',
      'end',
      ''
    ].join('\n')
  },
  // A module returning the class, made by Actor.new. (Lua has no abstract methods either.)
  lua: {
    path: 'lib/actor.lua',
    text: [
      '---@class Actor',
      '---@field health integer Its health. @blueprint',
      'local Actor = {}',
      'Actor.__index = Actor',
      '',
      '---@blueprint',
      '---@param name string',
      'function Actor.new(name)',
      '  local self = setmetatable({}, Actor)',
      '  self.name = name',
      '  self.health = 100',
      '  return self',
      'end',
      '',
      '---@blueprint',
      '---@return string',
      'function Actor:greet()',
      '  return self.name .. " has " .. self.health',
      'end',
      '',
      '---@blueprint overridable',
      '---@param damage integer',
      'function Actor:hit(damage)',
      '  self.health = self.health - damage',
      '  print(self.name .. " takes " .. damage)',
      'end',
      '',
      '---@blueprint overridable',
      '---@return string',
      'function Actor:describe()',
      '  return "someone"',
      'end',
      '',
      '---@blueprint',
      'function Actor:turn()',
      '  print(self.name .. " is " .. self:describe())',
      '  self:hit(3)',
      '  print(self:greet())',
      'end',
      '',
      'return Actor',
      ''
    ].join('\n')
  },
  // A script class; Godot has no abstract methods.
  gdscript: {
    path: 'lib/actor.gd',
    text: [
      'class_name Actor',
      'extends RefCounted',
      '',
      '## @blueprint',
      'var health: int = 100',
      '',
      'var _name: String',
      '',
      '',
      '## @blueprint',
      'func _init(name: String) -> void:',
      '\t_name = name',
      '',
      '',
      '## @blueprint',
      'func greet() -> String:',
      '\treturn "%s has %d" % [_name, health]',
      '',
      '',
      '## @blueprint overridable',
      'func hit(damage: int) -> void:',
      '\thealth -= damage',
      '\tprint("%s takes %d" % [_name, damage])',
      '',
      '',
      '## @blueprint overridable',
      'func describe() -> String:',
      '\treturn "someone"',
      '',
      '',
      '## @blueprint',
      'func turn() -> void:',
      '\tprint("%s is %s" % [_name, describe()])',
      '\thit(3)',
      '\tprint(greet())',
      ''
    ].join('\n')
  }
};

const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });

function scan(language: string, key: string): Code {
  const module = MODULES[key];
  const exposed = exposeFunctions(languages.get(language)!.importer!.scan!(module.text), { language, path: module.path, module: module.module, exposeAll: false });
  const info = exposed.classes.find((d) => d.implementation?.kind === 'code-class')?.implementation;
  assert.ok(info?.kind === 'code-class', 'the Actor is a class graphs may extend');
  return { info: info.type, definitions: [...exposed.definitions, ...exposed.classes] };
}

function registryFor(language: string, code: Code): NodeRegistry {
  const r = new NodeRegistry();
  r.registerMany(code.definitions);
  const generator = languages.get(language)!.generator!;
  const file = generator.outputFileName('Knight.vgraph');
  const module = language === 'python' ? file.replace(/\.py$/, '') : ['csharp', 'java', 'php'].includes(language) ? 'Arena' : undefined;
  r.registerMany(classDefinitions(declaredClass(knightGraph(language, code), { document: 'graphs/Knight.vgraph', generatedPath: `graphs/${file}`, ...(module ? { module } : {}) })!));
  return r;
}

interface Built {
  dir: string;
  files: string[];
  file: string;
  className: string;
  importRoots?: string[];
  texts: Record<string, string>;
}

function build(name: string, key: string, language: string, generate: Partial<GenerateOptions> = {}): Built {
  const dir = path.join(workDir, name);
  const module = MODULES[key];
  fs.mkdirSync(path.join(dir, path.dirname(module.path)), { recursive: true });
  fs.mkdirSync(path.join(dir, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(dir, module.path), module.text);
  if (language === 'python') fs.writeFileSync(path.join(dir, path.dirname(module.path), '__init__.py'), '');
  if (language === 'gdscript') fs.writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n');
  const code = scan(language, key);
  const r = registryFor(language, code);
  const texts: Record<string, string> = {};
  const files: string[] = [];
  let last: { file: string; className: string; importRoots?: string[] } | undefined;
  for (const doc of [knightGraph(language, code), gameGraph(language, code)]) {
    const result = compileDocument(doc, { registry: r, languages, generate: { sourceFileName: `${doc.name}.vgraph`, outputDir: 'graphs', namespace: 'Arena', ...generate } });
    assert.deepEqual(result.diagnostics, [], doc.name);
    const file = path.join(dir, 'graphs', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    texts[doc.name] = result.output!.text;
    // C++'s header.
    for (const companion of result.output!.companionFiles ?? []) {
      fs.writeFileSync(path.join(dir, 'graphs', companion.fileName), companion.text);
      texts[`${doc.name}.h`] = companion.text;
    }
    files.push(file);
    last = { file, className: result.output!.className, importRoots: result.output!.importRoots?.map((root) => path.join(dir, root)) };
  }
  return { dir, files: [path.join(dir, module.path), ...files], texts, ...last! };
}

const TARGETS = [
  { label: 'TypeScript', key: 'typescript', language: 'typescript' },
  { label: 'JavaScript (ES modules)', key: 'javascript-esm', language: 'javascript', moduleFormat: 'esm' as const },
  { label: 'JavaScript (CommonJS)', key: 'javascript-commonjs', language: 'javascript', moduleFormat: 'commonjs' as const },
  { label: 'Python', key: 'python', language: 'python' },
  { label: 'C#', key: 'csharp', language: 'csharp' },
  { label: 'Java', key: 'java', language: 'java' },
  { label: 'C++', key: 'cpp', language: 'cpp' },
  { label: 'PHP', key: 'php', language: 'php' },
  { label: 'Ruby', key: 'ruby', language: 'ruby' },
  { label: 'Lua', key: 'lua', language: 'lua' },
  { label: 'GDScript', key: 'gdscript', language: 'gdscript' }
];

// The sources a compiled language's Run builds besides the program's own file: the code's, and the
// other graph's (C++ includes the code's header).
const otherSources = (built: Built) => built.files.filter((f) => f !== built.file && !/\.h$/.test(f));

describe('code classes as parents', () => {
  test('the generated subclass: extends, overrides with the code\'s names, Parent calls, members on Self, the constructor', () => {
    const ts = build('typescript-text', 'typescript', 'typescript').texts;
    assert.match(ts.Knight, /^import \{ Actor \} from "\.\.\/lib\/actor\.ts";$/m);
    assert.match(ts.Knight, /^export class Knight extends Actor \{$/m);
    assert.match(ts.Knight, /^ {2}override hit\(damage: number\): void \{$/m);
    assert.match(ts.Knight, /^ {4}super\.hit\(damage\);$/m);
    assert.match(ts.Knight, /^ {2}override describe\(\): string \{$/m);
    assert.match(ts.Knight, /^ {4}this\.health = 50;$/m);
    assert.match(ts.Knight, /^ {2}start\(\): void \{$/m, 'a start of its own: the code has none');
    assert.match(ts.Game, /new Knight\("Bors"\)/);
    const py = build('python-text', 'python', 'python').texts;
    assert.match(py.Knight, /^from game\.actor import Actor$/m);
    assert.match(py.Knight, /^class Knight\(Actor\):$/m);
    assert.match(py.Knight, /^ {4}def __init__\(self, name: str\) -> None:\n {8}super\(\)\.__init__\(name\)$/m);
    assert.match(py.Knight, /^ {4}def hit\(self, damage: int\) -> None:$/m);
    assert.match(py.Knight, /^ {8}super\(\)\.hit\(damage\)$/m);
    const cs = build('csharp-text', 'csharp', 'csharp').texts;
    assert.match(cs.Knight, /^public class Knight : global::Game\.Actor$/m);
    assert.match(cs.Knight, /^ {4}public Knight\(string name\) : base\(name\)$/m);
    assert.match(cs.Knight, /^ {4}public override void Hit\(int damage\)$/m);
    assert.match(cs.Knight, /^ {8}base\.Hit\(damage\);$/m);
    assert.match(cs.Knight, /^ {4}public override string Describe\(\)$/m);
    assert.match(cs.Knight, /^ {4}public virtual void Start\(\)$/m);
    const java = build('java-text', 'java', 'java').texts;
    assert.match(java.Knight, /^public class Knight extends game\.Actor \{$/m);
    assert.match(java.Knight, /^ {4}public Knight\(String name\) \{\n {8}super\(name\);\n {4}\}$/m);
    assert.match(java.Knight, /^ {4}@Override\n {4}public void hit\(int damage\) \{$/m, "the code's int, not the graph's long");
    assert.match(java.Knight, /^ {8}super\.hit\(damage\);$/m);
    assert.match(java.Knight, /^ {4}@Override\n {4}protected String describe\(\) \{$/m);
    assert.match(java.Knight, /^ {8}this\.health = 50L;$/m);
    assert.match(java.Game, /^ {8}_make_object = new Knight\("Bors"\);$/m);
    assert.match(java.Game, /^ {8}_make_object\.turn\(\);$/m, 'a Knight is an Actor: no cast');
    const cpp = build('cpp-text', 'cpp', 'cpp').texts;
    assert.match(cpp['Knight.h'], /^#include "\.\.\/lib\/actor\.h"$/m);
    assert.match(cpp['Knight.h'], /^class Knight : public ::game::Actor, public vgraph::Object \{$/m);
    assert.match(cpp['Knight.h'], /^ {4}using ::game::Actor::Actor;$/m);
    assert.match(cpp['Knight.h'], /^ {4}void hit\(int damage\) override;$/m);
    assert.match(cpp['Knight.h'], /^protected:\n {4}std::string describe\(\) const override;$/m);
    assert.match(cpp.Knight, /^ {4}::game::Actor::hit\(damage\);$/m);
    assert.match(cpp.Knight, /^std::string Knight::describe\(\) const \{\n {4}return const_cast<Knight\*>\(this\)->describeGraph\(\);\n\}$/m);
    assert.match(cpp.Knight, /^ {4}\(\*this\)\.health = 50;$/m);
    assert.match(cpp.Game, /std::make_shared<::Knight>\(std::string\("Bors"\)\)/);
    const php = build('php-text', 'php', 'php').texts;
    assert.match(php.Knight, /^require_once __DIR__ \. '\/\.\.\/lib\/Actor\.php';$/m);
    assert.match(php.Knight, /^class Knight extends \\Game\\Actor$/m);
    assert.match(php.Knight, /^ {4}public function __construct\(string \$name\)\n {4}\{\n {8}parent::__construct\(\$name\);$/m);
    assert.match(php.Knight, /^ {4}public function hit\(int \$damage\): void$/m);
    assert.match(php.Knight, /^ {8}parent::hit\(\$damage\);$/m);
    assert.match(php.Knight, /^ {4}protected function describe\(\): string$/m);
    assert.match(php.Knight, /^ {8}\$this->health = 50;$/m);
    assert.match(php.Game, / = new \\Arena\\Knight\('Bors'\);$/m);
    const ruby = build('ruby-text', 'ruby', 'ruby').texts;
    assert.match(ruby.Knight, /^class Knight < Guild::Actor$/m);
    assert.match(ruby.Knight, /^ {2}def initialize\(name\)\n {4}super\(name\)$/m);
    assert.match(ruby.Knight, /^ {2}def hit\(damage\)$/m);
    assert.match(ruby.Knight, /^ {4}Guild::Actor\.instance_method\(:hit\)\.bind_call\(self, damage\)$/m);
    assert.match(ruby.Knight, /^ {2}def describe$/m);
    assert.match(ruby.Knight, /^ {4}self\.health = 50$/m);
    assert.match(ruby.Game, /Knight\.new\("Bors"\)/);
    const lua = build('lua-text', 'lua', 'lua').texts;
    assert.match(lua.Knight, /^setmetatable\(Knight, \{ __index = actor \}\)$/m);
    assert.match(lua.Knight, /^function Knight\.__vg_new\(name\)\n {2}return actor\.new\(name\)\nend$/m);
    assert.match(lua.Knight, /^function Knight\.new\(name\)\n {2}local self = setmetatable\(Knight\.__vg_new\(name\), Knight\)$/m);
    assert.match(lua.Knight, /^function Knight:hit\(damage\)$/m);
    assert.match(lua.Knight, /^ {2}actor\.hit\(self, damage\)$/m);
    assert.match(lua.Knight, /^function Knight:describe\(\)$/m);
    assert.match(lua.Game, /Knight\.new\("Bors"\)/);
    const gd = build('gdscript-text', 'gdscript', 'gdscript').texts;
    assert.match(gd.Knight, /^extends "\.\.\/lib\/actor\.gd"$/m);
    assert.match(gd.Knight, /^const vg = preload\(/m, "the code's script has no vg");
    assert.match(gd.Knight, /^func _init\(name: String\) -> void:\n\tsuper\(name\)$/m);
    assert.match(gd.Knight, /^func hit\(damage: int\) -> void:$/m);
    assert.match(gd.Knight, /^\tsuper\.hit\(damage\)$/m);
    assert.match(gd.Knight, /^func describe\(\) -> String:$/m, "Godot checks the return type against the code's");
    assert.match(gd.Game, /\.new\("Bors"\)/);
  });

  // Squire extends Knight: a variable of its own, and hit overridden again, its Parent call
  // reaching Knight's version through the code's name.
  test('a graph class extending the graph class: the constructor passes the name on, Parent: hit is the nearest', () => {
    const texts: Record<string, string> = {};
    for (const language of ['typescript', 'python', 'csharp', 'java', 'cpp', 'php', 'ruby', 'lua', 'gdscript']) {
      const code = scan(language, language);
      const hit = method(code, 'hit');
      const r = registryFor(language, code);
      const squire: GraphDocument = {
        schemaVersion: 3, name: 'Squire', kind: 'class', language, parent: 'object:Knight', variables: [{ id: 'pride', name: 'Pride', type: { id: 'int' }, defaultValue: 1 }],
        graphs: [{
          id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
          nodes: [n('hit', OVERRIDE_EVENT, { method: hit.name }), n('parent', PARENT_CALL, { function: hit.name })],
          connections: [w('hit', 'execOut', 'parent', 'execIn'), w('hit', hit.inputs[0].id, 'parent', hit.inputs[0].id)]
        }]
      };
      const result = compileDocument(squire, { registry: r, languages, generate: { sourceFileName: 'Squire.vgraph', outputDir: 'graphs', namespace: 'Arena' } });
      assert.deepEqual(result.diagnostics, [], language);
      texts[language] = result.output!.text;
      for (const companion of result.output!.companionFiles ?? []) texts[`${language}.h`] = companion.text;
    }
    assert.match(texts.typescript, /^export class Squire extends Knight \{$/m);
    assert.match(texts.typescript, /^ {2}override hit\(damage: number\): void \{\n {4}\/\/ Parent: hit \(parent\)\n {4}super\.hit\(damage\);$/m);
    assert.doesNotMatch(texts.typescript, /start\(\)/, "Knight's start is Squire's");
    assert.match(texts.python, /^ {4}def __init__\(self, name: str\) -> None:\n {8}super\(\)\.__init__\(name\)\n {8}self\.Pride: int = 1$/m);
    assert.match(texts.csharp, /^ {4}public Squire\(string name\) : base\(name\)$/m);
    assert.match(texts.csharp, /^ {4}public override void Hit\(int damage\)$/m);
    assert.match(texts.java, /^ {4}public Squire\(String name\) \{\n {8}super\(name\);$/m);
    assert.match(texts.java, /^ {8}super\.hit\(damage\);$/m);
    assert.match(texts['cpp.h'], /^class Squire : public ::Knight \{$/m);
    assert.match(texts['cpp.h'], /^ {4}using ::Knight::Knight;$/m);
    assert.match(texts.cpp, /^ {4}::Knight::hit\(damage\);$/m);
    assert.match(texts.php, /^ {4}public function __construct\(string \$name\)\n {4}\{\n {8}parent::__construct\(\$name\);$/m);
    assert.match(texts.php, /^ {8}parent::hit\(\$damage\);$/m);
    assert.match(texts.ruby, /^ {2}def initialize\(name\)\n {4}super\(name\)$/m);
    assert.match(texts.ruby, /^ {4}Knight\.instance_method\(:hit\)\.bind_call\(self, damage\)$/m);
    // Lua: Knight's __vg_new is Squire's, through its metatable; its __init is Knight's first.
    assert.match(texts.lua, /^function Squire\.new\(name\)\n {2}local self = setmetatable\(Squire\.__vg_new\(name\), Squire\)$/m);
    assert.doesNotMatch(texts.lua, /__vg_new\(name\)\n {2}return/);
    assert.match(texts.lua, /^ {2}Knight\.hit\(self, damage\)$/m);
    assert.match(texts.gdscript, /^func _init\(name: String\) -> void:\n\tsuper\(name\)$/m);
    assert.doesNotMatch(texts.gdscript, /^const vg = /m, "Knight's vg is Squire's");
  });

  test('a class leaving an abstract method is abstract (TypeScript, C#, Java, PHP)', () => {
    for (const [language, key, pattern] of [
      ['typescript', 'typescript', /^export abstract class Knight extends Actor \{$/m],
      ['csharp', 'csharp', /^public abstract class Knight : global::Game\.Actor$/m],
      ['java', 'java', /^public abstract class Knight extends game\.Actor \{$/m],
      ['php', 'php', /^abstract class Knight extends \\Game\\Actor$/m]
    ] as const) {
      const code = scan(language, key);
      const doc = knightGraph(language, code);
      doc.graphs = doc.graphs.filter((g) => g.kind === 'event');
      const result = compileDocument(doc, { registry: registryFor(language, code), languages, generate: { sourceFileName: 'Knight.vgraph', namespace: 'Arena' } });
      assert.deepEqual(result.diagnostics.map((d) => d.code), ['abstract-left']);
      assert.match(result.output!.text, pattern);
    }
  });

  test("the graph's own members can't take the code's names", () => {
    const code = scan('typescript', 'typescript');
    const doc = { ...knightGraph('typescript', code), variables: [{ id: 'h', name: 'Health', type: { id: 'int' } }] };
    const result = compileDocument(doc, { registry: registryFor('typescript', code), languages, generate: { sourceFileName: 'Knight.vgraph' } });
    assert.deepEqual(result.diagnostics.map((d) => d.message), ['Actor already has a member named "health", so "Health" needs another name.']);
  });

  for (const target of TARGETS) {
    test(`${target.label}: constructing a Knight and running the code's template method`, async (t) => {
      const built = build(target.key, target.key, target.language, { moduleFormat: target.moduleFormat });
      let outcome;
      try {
        const sources = ['csharp', 'java', 'cpp'].includes(target.language) ? otherSources(built) : undefined;
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, built.file, built.className, {
          cwd: path.join(built.dir, 'graphs'), importRoots: built.importRoots, sources, timeoutMs: 180000, ...(target.language === 'gdscript' ? { projectDir: built.dir } : {})
        });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').split('\n').filter(Boolean), CODE_PARENTS_OUTPUT, `stderr:\n${outcome.stderr}`);
      // Godot reports a script's errors and warnings as it loads it (the override's signature among them).
      if (target.language === 'gdscript') assert.doesNotMatch(outcome.stderr, /SCRIPT ERROR|WARNING/, outcome.stderr);
    });
  }

  // Phase 11's strictest settings: override where required, no unused locals or parameters.
  for (const { language, key, flags } of [
    { language: 'typescript', key: 'typescript', flags: { allowImportingTsExtensions: true } },
    { language: 'javascript', key: 'javascript-esm', flags: { allowJs: true, checkJs: true } }
  ]) {
    test(`${language}: the subclass type-checks under --strict with noImplicitOverride`, () => {
      const built = build(`typecheck-${key}`, key, language);
      fs.writeFileSync(path.join(built.dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'], types: [],
          noImplicitOverride: true, noUnusedLocals: true, noUnusedParameters: true, exactOptionalPropertyTypes: true, noPropertyAccessFromIndexSignature: true, ...flags
        },
        files: built.files.map((f) => path.relative(built.dir, f))
      }));
      const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
      const result = spawnSync(process.execPath, [tsc, '-p', built.dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }

  // The corpus's Java and C++ projects' settings (test/fixtures/projects): every lint, as errors.
  test('Java: the subclass compiles with -Xlint:all -Werror', (t) => {
    if (spawnSync('javac', ['-version'], { encoding: 'utf8' }).error) return t.skip("javac isn't installed");
    const built = build('lint-java', 'java', 'java');
    const result = spawnSync('javac', ['-Xlint:all', '-Werror', '-encoding', 'UTF-8', '-d', path.join(built.dir, 'classes'), ...built.files], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test('C++: the subclass compiles with -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Werror', (t) => {
    if (spawnSync('g++', ['--version'], { encoding: 'utf8' }).error) return t.skip("g++ isn't installed");
    const built = build('lint-cpp', 'cpp', 'cpp');
    for (const file of otherSources(built).concat(built.file)) {
      const result = spawnSync('g++', ['-std=c++20', '-Wall', '-Wextra', '-Wpedantic', '-Wshadow', '-Wconversion', '-Werror', '-fsyntax-only', file], { cwd: path.dirname(file), encoding: 'utf8' });
      assert.equal(result.status, 0, `${path.basename(file)}:\n${result.stdout}${result.stderr}`);
    }
  });

  // The corpus's PHP projects' PHPStan level, over the code, the generated files and the runtime.
  test('PHP: the subclass passes PHPStan at level 9', (t) => {
    const phpstan = path.join(corpusToolsFolder(), 'phar', 'phpstan.phar');
    if (!fs.existsSync(phpstan)) return t.skip("PHPStan isn't installed (npm run corpus:tools)");
    const built = build('phpstan', 'php', 'php');
    const result = spawnSync('php', [phpstan, 'analyse', '--level', '9', '--no-progress', '--memory-limit=2G', 'lib', 'graphs'], { cwd: built.dir, encoding: 'utf8', env: { ...process.env, XDEBUG_MODE: 'off' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  // The corpus's Ruby runs (-w): warnings fail it.
  test('Ruby: the program runs under -w without a warning', (t) => {
    if (spawnSync('ruby', ['--version'], { encoding: 'utf8' }).error) return t.skip("Ruby isn't installed");
    const built = build('ruby-w', 'ruby', 'ruby');
    const result = spawnSync('ruby', ['-w', '-e', `require './graphs/${path.basename(built.file)}'; ${built.className}.new.start`], { cwd: built.dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.stdout.replace(/\r\n/g, '\n').split('\n').filter(Boolean), CODE_PARENTS_OUTPUT);
  });

  for (const checker of [{ name: 'mypy --strict', args: ['mypy', '--strict'] }, { name: 'Pyright (strict)', args: ['pyright'] }]) {
    test(`Python: the subclass passes ${checker.name}`, (t) => {
      if (spawnSync(PYTHON, ['-m', checker.args[0], '--version'], { encoding: 'utf8' }).status !== 0) return t.skip(`${checker.args[0]} isn't installed`);
      const built = build(`check-${checker.args[0]}`, 'python', 'python');
      fs.writeFileSync(path.join(built.dir, 'pyrightconfig.json'), JSON.stringify({ typeCheckingMode: 'strict', extraPaths: ['lib'] }));
      const result = spawnSync(PYTHON, ['-m', ...checker.args, ...built.files.map((f) => path.relative(built.dir, f))], {
        cwd: built.dir, encoding: 'utf8', env: { ...process.env, MYPYPATH: path.join(built.dir, 'lib') }
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
});
