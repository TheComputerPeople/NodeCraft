// Code classes as parents (docs/code-classes-as-parents.md), in TypeScript, JavaScript, Python and
// C#: an Actor from the project's code, with a constructor taking a name, a health property, a
// method (greet), an overridable method (hit), an abstract one (describe) and a template method
// (turn) calling both. A Knight graph extends it: its Start sets health and greets on Self, Event
// hit says so and calls Parent: hit, and describe is a function. A Game graph constructs a Knight
// and runs turn.
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
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { CodeClassInfo, OVERRIDE_EVENT, PARENT_CALL, classDefinitions, declaredClass } from '../../src/core/objects';
import { NodeRegistry } from '../../src/core/registry';
import { ToolNotFoundError, runGeneratedCode } from '../../src/extension/runner';
import { PYTHON } from './corpus';

const repoRoot = path.resolve(__dirname, '../../..');
const languages = builtinLanguagePacks();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-code-parents-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

const EXPECTED = ['Bors has 50', 'Bors is a knight', 'Knight blocks', 'Bors takes 3', 'Bors has 47'];

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
  }
};

const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });

interface Code {
  info: CodeClassInfo;
  definitions: NodeDefinition[];
}

// An Actor member node's type, by its name in any case ("greet", "set:health").
function member(code: Code, name: string): string {
  const found = code.definitions.find((d) => d.type.toLowerCase().endsWith(`actor:${name}`));
  assert.ok(found, `no Actor:${name} in ${code.definitions.map((d) => d.type).join(', ')}`);
  return found.type;
}

function method(code: Code, name: string) {
  const found = code.info.overridable.find((m) => m.name.toLowerCase() === name);
  assert.ok(found, `${name} isn't overridable`);
  return found;
}

function knight(language: string, code: Code): GraphDocument {
  const hit = method(code, 'hit');
  const describe = method(code, 'describe').name;
  return {
    schemaVersion: 3, name: 'Knight', kind: 'class', language, parent: code.info.id, variables: [],
    graphs: [
      {
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          // Start: health = 50 and greet, both on Self (their Target unwired).
          n('s', 'core:event.start'), n('set', member(code, 'set:health'), { 'pin:value': 50 }), n('greet', member(code, 'greet')), n('p1', 'core:console.print'),
          // Event hit: says so, then runs the code's hit.
          n('hit', OVERRIDE_EVENT, { method: hit.name }), n('p2', 'core:console.print', { 'pin:value': 'Knight blocks' }), n('parent', PARENT_CALL, { function: hit.name })
        ],
        connections: [
          w('s', 'execOut', 'set', 'execIn'), w('set', 'execOut', 'greet', 'execIn'), w('greet', 'execOut', 'p1', 'execIn'), w('greet', 'returnValue', 'p1', 'value'),
          w('hit', 'execOut', 'p2', 'execIn'), w('p2', 'execOut', 'parent', 'execIn'), w('hit', hit.inputs[0].id, 'parent', hit.inputs[0].id)
        ]
      },
      {
        id: 'Describe', name: describe, kind: 'function', comments: [],
        signature: { inputs: [], outputs: [{ id: 'returnValue', name: 'Return Value', kind: 'data', type: { id: 'string' } }] },
        nodes: [n('entry', 'core:function.entry', { graph: 'Describe' }), n('return', 'core:function.return', { graph: 'Describe', 'pin:returnValue': 'a knight' })],
        connections: [w('entry', 'execOut', 'return', 'execIn')]
      }
    ]
  };
}

function game(language: string, code: Code): GraphDocument {
  return {
    schemaVersion: 3, name: 'Game', kind: 'class', language, variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [n('s', 'core:event.start'), n('make', 'object:Knight.construct', { 'pin:name': 'Bors' }), n('turn', member(code, 'turn'))],
      connections: [w('s', 'execOut', 'make', 'execIn'), w('make', 'execOut', 'turn', 'execIn'), w('make', 'object', 'turn', 'target')]
    }]
  };
}

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
  const module = language === 'python' ? file.replace(/\.py$/, '') : language === 'csharp' ? 'Arena' : undefined;
  r.registerMany(classDefinitions(declaredClass(knight(language, code), { document: 'graphs/Knight.vgraph', generatedPath: `graphs/${file}`, ...(module ? { module } : {}) })!));
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
  const code = scan(language, key);
  const r = registryFor(language, code);
  const texts: Record<string, string> = {};
  const files: string[] = [];
  let last: { file: string; className: string; importRoots?: string[] } | undefined;
  for (const doc of [knight(language, code), game(language, code)]) {
    const result = compileDocument(doc, { registry: r, languages, generate: { sourceFileName: `${doc.name}.vgraph`, outputDir: 'graphs', namespace: 'Arena', ...generate } });
    assert.deepEqual(result.diagnostics, [], doc.name);
    const file = path.join(dir, 'graphs', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    texts[doc.name] = result.output!.text;
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
  { label: 'C#', key: 'csharp', language: 'csharp' }
];

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
  });

  // Squire extends Knight: a variable of its own, and hit overridden again, its Parent call
  // reaching Knight's version through the code's name.
  test('a graph class extending the graph class: the constructor passes the name on, Parent: hit is the nearest', () => {
    const texts: Record<string, string> = {};
    for (const language of ['typescript', 'python', 'csharp']) {
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
    }
    assert.match(texts.typescript, /^export class Squire extends Knight \{$/m);
    assert.match(texts.typescript, /^ {2}override hit\(damage: number\): void \{\n {4}\/\/ Parent: hit \(parent\)\n {4}super\.hit\(damage\);$/m);
    assert.doesNotMatch(texts.typescript, /start\(\)/, "Knight's start is Squire's");
    assert.match(texts.python, /^ {4}def __init__\(self, name: str\) -> None:\n {8}super\(\)\.__init__\(name\)\n {8}self\.Pride: int = 1$/m);
    assert.match(texts.csharp, /^ {4}public Squire\(string name\) : base\(name\)$/m);
    assert.match(texts.csharp, /^ {4}public override void Hit\(int damage\)$/m);
  });

  test('a class leaving an abstract method is abstract (TypeScript, C#)', () => {
    for (const [language, key, pattern] of [['typescript', 'typescript', /^export abstract class Knight extends Actor \{$/m], ['csharp', 'csharp', /^public abstract class Knight : global::Game\.Actor$/m]] as const) {
      const code = scan(language, key);
      const doc = knight(language, code);
      doc.graphs = doc.graphs.filter((g) => g.kind === 'event');
      const result = compileDocument(doc, { registry: registryFor(language, code), languages, generate: { sourceFileName: 'Knight.vgraph', namespace: 'Arena' } });
      assert.deepEqual(result.diagnostics.map((d) => d.code), ['abstract-left']);
      assert.match(result.output!.text, pattern);
    }
  });

  test("the graph's own members can't take the code's names", () => {
    const code = scan('typescript', 'typescript');
    const doc = { ...knight('typescript', code), variables: [{ id: 'h', name: 'Health', type: { id: 'int' } }] };
    const result = compileDocument(doc, { registry: registryFor('typescript', code), languages, generate: { sourceFileName: 'Knight.vgraph' } });
    assert.deepEqual(result.diagnostics.map((d) => d.message), ['Actor already has a member named "health", so "Health" needs another name.']);
  });

  for (const target of TARGETS) {
    test(`${target.label}: constructing a Knight and running the code's template method`, async (t) => {
      const built = build(target.key, target.key, target.language, { moduleFormat: target.moduleFormat });
      let outcome;
      try {
        const sources = target.language === 'csharp' ? built.files.filter((f) => f !== built.file) : undefined;
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, built.file, built.className, { cwd: path.join(built.dir, 'graphs'), importRoots: built.importRoots, sources, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').split('\n').filter(Boolean), EXPECTED, `stderr:\n${outcome.stderr}`);
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
