// The conformance suite: every fixture graph must print the same lines in Simulate and in the
// generated code of every language pack, run with the real toolchain (docs/semantics.md).
// Fixtures live in test/fixtures/graphs and declare `metadata.expectedOutput` (and
// `metadata.expectedError` when the run should stop with an error).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { libraryDefinitions } from '../../src/core/libraries';
import { declaredType, userTypeDefinitions } from '../../src/core/user-types';
import { classDefinitions, declaredClass, declaredInterface, interfaceDefinitions } from '../../src/core/objects';
import { GenerateOptions } from '../../src/core/language-pack';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, NodeDefinition, RuntimeLogEvent } from '../../src/core/model';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { GraphRuntime } from '../../src/core/runtime';
import { parseDocument } from '../../src/core/serializer';
import { RUN_PROJECT_FILE, csharpRunProject } from '../../src/core/languages/csharp';
import { ToolNotFoundError, runCommand, runGeneratedCode, writeScaffold } from '../../src/extension/runner';

const repoRoot = path.resolve(__dirname, '../../..');
const languages = builtinLanguagePacks();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-conformance-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

function registry(): NodeRegistry {
  const r = new NodeRegistry();
  for (const file of ['sample/visual-nodes/Math/Double.node.json', 'test/fixtures/nodes/Fail.node.json']) {
    r.register(parseNodeDefinition(fs.readFileSync(path.join(repoRoot, file), 'utf8'))!);
  }
  return r;
}

interface Fixture {
  name: string;
  document: GraphDocument;
  expectedOutput: string[];
  expectedError: boolean;
}

function loadFixtures(): Fixture[] {
  const files = [
    path.join(repoRoot, 'sample/demo.vgraph'),
    ...fs.readdirSync(path.join(repoRoot, 'test/fixtures/graphs')).filter((f) => f.endsWith('.vgraph')).map((f) => path.join(repoRoot, 'test/fixtures/graphs', f))
  ];
  return files.map((file) => {
    const document = parseDocument(fs.readFileSync(file, 'utf8')).document;
    const meta = document.metadata ?? {};
    return {
      name: path.basename(file),
      document,
      // The sample predates fixture metadata; its expected output is part of the README walkthrough.
      expectedOutput: (meta.expectedOutput as string[] | undefined) ?? ['30'],
      expectedError: meta.expectedError === true
    };
  });
}

// Each generated-code target: a language and, for JavaScript, a module format.
const TARGETS = [
  { label: 'TypeScript', language: 'typescript' },
  { label: 'JavaScript (ES modules)', language: 'javascript', moduleFormat: 'esm' as const },
  { label: 'JavaScript (CommonJS)', language: 'javascript', moduleFormat: 'commonjs' as const },
  { label: 'Python', language: 'python' }
];

// C# builds before it runs, so every fixture's class is compiled into one project, with warnings as
// errors (C#'s counterpart of the TypeScript --strict check), and each test runs its class from it.
type CSharpBuild = { dir: string; dll: string; classes: Map<string, string> } | { skip: string } | { error: string };
let csharpBuild: Promise<CSharpBuild> | undefined;
const DOTNET_ENV = { DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };

async function buildCSharp(): Promise<CSharpBuild> {
  const version = await runCommand(['dotnet', '--version'], { cwd: workDir, env: DOTNET_ENV, timeoutMs: 30000 });
  const major = version && /^(\d+)\./.exec(version.stdout.trim())?.[1];
  if (!major) return { skip: 'The .NET SDK is not installed' };
  const dir = path.join(workDir, 'csharp');
  fs.mkdirSync(dir, { recursive: true });
  const classes = new Map<string, string>();
  const sources = loadFixtures().map((fixture, i) => {
    const result = compileDocument({ ...fixture.document, language: 'csharp' }, { registry: registry(), languages, generate: { sourceFileName: fixture.name, namespace: `Fixture${i}` } });
    if (!result.output) throw new Error(`${fixture.name} didn't compile to C#: ${JSON.stringify(result.diagnostics)}`);
    const file = path.join(dir, result.output.fileName);
    fs.writeFileSync(file, result.output.text);
    classes.set(fixture.name, result.output.className);
    return file;
  });
  const tfm = `net${major}.0`;
  writeScaffold(dir, csharpRunProject(tfm, sources));
  const build = await runCommand(['dotnet', 'build', path.join(dir, RUN_PROJECT_FILE), '-nologo', '-v', 'q', '-p:TreatWarningsAsErrors=true'], { cwd: dir, env: DOTNET_ENV, timeoutMs: 300000 });
  if (!build || build.exitCode !== 0) return { error: `dotnet build failed:\n${build?.stdout}\n${build?.stderr}` };
  return { dir, dll: path.join(dir, 'bin', 'Debug', tfm, 'BlueprintRun.dll'), classes };
}

function outputLines(stdout: string): string[] {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

for (const fixture of loadFixtures()) {
  describe(fixture.name, () => {
    test('Simulate', () => {
      const events: RuntimeLogEvent[] = [];
      new GraphRuntime(registry(), (e) => events.push(e)).run(fixture.document);
      assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.message), fixture.expectedOutput);
      assert.equal(events.some((e) => e.kind === 'error'), fixture.expectedError, 'stopped by an error');
    });

    for (const target of TARGETS) {
      test(target.label, async (t) => {
        const result = compileDocument({ ...fixture.document, language: target.language }, {
          registry: registry(),
          languages,
          generate: { sourceFileName: fixture.name, moduleFormat: target.moduleFormat }
        });
        assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
        const output = result.output!;
        const dir = path.join(workDir, `${target.language}-${target.moduleFormat ?? 'default'}`);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, output.fileName);
        fs.writeFileSync(file, output.text);

        let outcome;
        try {
          outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, output.className, { cwd: dir, timeoutMs: 30000 });
        } catch (error) {
          if (error instanceof ToolNotFoundError) return t.skip(error.message);
          throw error;
        }
        assert.deepEqual(outputLines(outcome.stdout), fixture.expectedOutput, `stderr:\n${outcome.stderr}`);
        assert.equal(outcome.exitCode !== 0, fixture.expectedError, `exit code ${outcome.exitCode}; stderr:\n${outcome.stderr}`);
      });
    }

    test('C#', async (t) => {
      const build = await (csharpBuild ??= buildCSharp());
      if ('skip' in build) return t.skip(build.skip);
      if ('error' in build) assert.fail(build.error);
      const outcome = (await runCommand(['dotnet', build.dll, build.classes.get(fixture.name)!], { cwd: build.dir, env: DOTNET_ENV, timeoutMs: 30000 }))!;
      assert.deepEqual(outputLines(outcome.stdout), fixture.expectedOutput, `stderr:\n${outcome.stderr}`);
      assert.equal(outcome.exitCode !== 0, fixture.expectedError, `exit code ${outcome.exitCode}; stderr:\n${outcome.stderr}`);
    });
  });
}

describe('generated code type-checks', () => {
  for (const { language, flags } of [
    { language: 'typescript', flags: {} },
    { language: 'javascript', flags: { allowJs: true, checkJs: true } }
  ]) {
    test(`${language} under --strict`, () => {
      const dir = path.join(workDir, `typecheck-${language}`);
      fs.mkdirSync(dir, { recursive: true });
      const files = loadFixtures().map((fixture) => {
        const output = compileDocument({ ...fixture.document, language }, { registry: registry(), languages, generate: { sourceFileName: fixture.name } }).output!;
        fs.writeFileSync(path.join(dir, output.fileName), output.text);
        return output.fileName;
      });
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'], types: [], ...flags },
        files
      }));
      const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
      const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
});

// Graphs calling the project's own functions (docs/code-as-nodes.md): the generated code imports
// real modules, runs with the real toolchain and type-checks. Simulate can't run project code.
describe('project functions', () => {
  // Start → Add To Total(5) → Print(Double(its result)) → Add To Total(7) → Print(its result).
  // Add To Total keeps a running total, so an extra call would show up in the output.
  const jsModule = (exports: string, typed: boolean): string => [
    'let total = 0;',
    '/**',
    ' * @blueprint',
    ...(typed ? [] : [' * @param {number} amount', ' * @returns {number}']),
    ' */',
    `${exports === 'esm' ? 'export ' : ''}function addToTotal(amount${typed ? ': number): number' : ')'} {`,
    '  total += amount;',
    '  return total;',
    '}',
    '/**',
    ' * @blueprint pure',
    ...(typed ? [] : [' * @param {number} value', ' * @returns {number}']),
    ' */',
    `${exports === 'esm' ? 'export ' : ''}function double(value${typed ? ': number): number' : ')'} {`,
    '  return value * 2;',
    '}',
    ...(exports === 'commonjs' ? ['module.exports = { addToTotal, double };'] : []),
    ''
  ].join('\n');
  const MODULES: Record<string, { path: string; text: string }> = {
    typescript: { path: 'lib/score.ts', text: jsModule('esm', true) },
    'javascript-esm': { path: 'lib/score.mjs', text: jsModule('esm', false) },
    'javascript-commonjs': { path: 'lib/score.cjs', text: jsModule('commonjs', false) },
    // In a package in another folder: Run must put the package's root (lib) on sys.path.
    // C#: a static class; Run compiles it with the generated file.
    csharp: {
      path: 'lib/Score.cs',
      text: [
        'public static class Score',
        '{',
        '    private static double total;',
        '',
        '    /// @blueprint',
        '    public static double AddToTotal(double amount)',
        '    {',
        '        total += amount;',
        '        return total;',
        '    }',
        '',
        '    /// @blueprint pure',
        '    public static double Double(double value) => value * 2;',
        '}',
        ''
      ].join('\n')
    },
    python: {
      path: 'lib/game/score.py',
      text: [
        'total = 0', '', '',
        'def add_to_total(amount: float) -> float:', '    """@blueprint"""', '    global total', '    total += amount', '    return total', '', '',
        'def double(value: float) -> float:', '    """@blueprint pure"""', '    return value * 2', ''
      ].join('\n')
    }
  };

  // Node definitions for the module, as the workspace importer makes them: scanned from the code.
  function definitions(language: string, key: string): NodeDefinition[] {
    const importer = languages.get(language)!.importer!;
    const module = language === 'python' ? 'game.score' : undefined;
    return exposeFunctions(importer.scan!(MODULES[key].text), { language, path: MODULES[key].path, module, exposeAll: false }).definitions;
  }

  function project(language: string, key: string): { registry: NodeRegistry; document: GraphDocument } {
    const defs = definitions(language, key);
    const isDouble = (d: NodeDefinition) => /[#.]double$/i.test(d.type);
    const add = defs.find((d) => !isDouble(d));
    const double = defs.find(isDouble);
    assert.ok(add && double, `the module exposes both functions: ${defs.map((d) => d.type).join(', ')}`);
    const r = registry();
    r.registerMany([add, double]);
    const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
    const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}`, fromNode, fromPin, toNode, toPin });
    const document: GraphDocument = {
      schemaVersion: 3, name: 'ScoreBoard', kind: 'class', language, variables: [],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          n('s', 'core:event.start'), n('a1', add.type, { 'pin:amount': 5 }), n('d', double.type), n('p1', 'core:console.print'),
          n('a2', add.type, { 'pin:amount': 7 }), n('p2', 'core:console.print')
        ],
        connections: [
          w('s', 'execOut', 'a1', 'execIn'), w('a1', 'execOut', 'p1', 'execIn'), w('p1', 'execOut', 'a2', 'execIn'), w('a2', 'execOut', 'p2', 'execIn'),
          w('a1', 'returnValue', 'd', 'value'), w('d', 'returnValue', 'p1', 'value'), w('a2', 'returnValue', 'p2', 'value')
        ]
      }]
    };
    return { registry: r, document };
  }

  // Writes the module and the generated file into a fresh project folder.
  function build(language: string, key: string, generate: Partial<GenerateOptions> = {}): { file: string; className: string; dir: string; importRoots?: string[] } {
    const { registry: r, document } = project(language, key);
    const dir = path.join(workDir, `project-${key}`);
    const module = MODULES[key];
    fs.mkdirSync(path.join(dir, path.dirname(module.path)), { recursive: true });
    fs.mkdirSync(path.join(dir, 'graphs'), { recursive: true });
    fs.writeFileSync(path.join(dir, module.path), module.text);
    if (language === 'python') fs.writeFileSync(path.join(dir, path.dirname(module.path), '__init__.py'), '');
    const result = compileDocument(document, { registry: r, languages, generate: { sourceFileName: 'score.vgraph', outputDir: 'graphs', ...generate } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'graphs', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    return { file, className: result.output!.className, dir, importRoots: result.output!.importRoots?.map((r) => path.join(dir, r)) };
  }

  test('Simulate stops at the first project function', () => {
    const { registry: r, document } = project('typescript', 'typescript');
    const events: RuntimeLogEvent[] = [];
    new GraphRuntime(r, (e) => events.push(e)).run(document);
    assert.equal(events.find((e) => e.kind === 'error')?.nodeId, 'a1');
  });

  for (const target of [
    { label: 'TypeScript', language: 'typescript', key: 'typescript' },
    // Imports spelled for node16/nodenext and bundler projects: Run's resolve hook finds the .ts file.
    { label: 'TypeScript (".js" imports)', language: 'typescript', key: 'typescript', importExtension: 'js' as const },
    { label: 'TypeScript (extensionless imports)', language: 'typescript', key: 'typescript', importExtension: 'none' as const },
    { label: 'JavaScript (ES modules)', language: 'javascript', key: 'javascript-esm', moduleFormat: 'esm' as const },
    { label: 'JavaScript (CommonJS)', language: 'javascript', key: 'javascript-commonjs', moduleFormat: 'commonjs' as const },
    { label: 'Python', language: 'python', key: 'python' },
    { label: 'C#', language: 'csharp', key: 'csharp' }
  ]) {
    test(`${target.label} imports and calls them`, async (t) => {
      const { file, className, dir, importRoots } = build(target.language, target.key, { moduleFormat: target.moduleFormat, importExtension: target.importExtension });
      let outcome;
      try {
        const sources = target.language === 'csharp' ? [path.join(dir, MODULES[target.key].path)] : undefined;
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, className, { cwd: path.join(dir, 'graphs'), importRoots, sources, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), ['10', '12'], `stderr:\n${outcome.stderr}`);
    });
  }

  for (const { language, key, flags } of [
    { language: 'typescript', key: 'typescript', flags: { allowImportingTsExtensions: true } },
    { language: 'javascript', key: 'javascript-esm', flags: { allowJs: true, checkJs: true } }
  ]) {
    test(`${language} calling them type-checks under --strict`, () => {
      const { file, dir } = build(language, key);
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'], types: [], ...flags },
        files: [path.relative(dir, file)]
      }));
      const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
      const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
});

// Classes in the project's code (docs/node-authoring.md, gap 2): a constructor, a method, a
// property's Set and a getter's Get, called through Target pins, and a subclass's object where the
// base class is expected.
describe('code classes', () => {
  const jsClasses = (exports: 'esm' | 'commonjs', typed: boolean): string => [
    `${exports === 'esm' ? 'export ' : ''}class Counter {`,
    '  /**',
    '   * @blueprint',
    ...(typed ? [] : ['   * @type {number}']),
    '   */',
    `  count${typed ? ': number' : ''} = 0;`,
    '  /**',
    '   * @blueprint',
    ...(typed ? [] : ['   * @param {number} start']),
    '   */',
    `  constructor(start${typed ? ': number' : ''}) {`,
    '    this.count = start;',
    '  }',
    '  /**',
    '   * @blueprint',
    ...(typed ? [] : ['   * @param {number} amount', '   * @returns {number}']),
    '   */',
    `  add(amount${typed ? ': number): number' : ')'} {`,
    '    this.count += amount;',
    '    return this.count;',
    '  }',
    '  /**',
    '   * @blueprint pure',
    ...(typed ? [] : ['   * @returns {number}']),
    '   */',
    `  get doubled()${typed ? ': number' : ''} {`,
    '    return this.count * 2;',
    '  }',
    '}',
    `${exports === 'esm' ? 'export ' : ''}class BigCounter extends Counter {`,
    '  /**',
    '   * @blueprint',
    ...(typed ? [] : ['   * @param {number} start']),
    '   */',
    `  constructor(start${typed ? ': number' : ''}) {`,
    '    super(start * 10);',
    '  }',
    '}',
    ...(exports === 'commonjs' ? ['module.exports = { Counter, BigCounter };'] : []),
    ''
  ].join('\n');
  const MODULES: Record<string, { path: string; text: string }> = {
    typescript: { path: 'lib/counter.ts', text: jsClasses('esm', true) },
    'javascript-esm': { path: 'lib/counter.mjs', text: jsClasses('esm', false) },
    'javascript-commonjs': { path: 'lib/counter.cjs', text: jsClasses('commonjs', false) },
    python: {
      path: 'lib/game/counter.py',
      text: [
        'class Counter:',
        '    count: float = 0',
        '    """@blueprint"""',
        '',
        '    def __init__(self, start: float) -> None:',
        '        """@blueprint"""',
        '        self.count = start',
        '',
        '    def add(self, amount: float) -> float:',
        '        """@blueprint"""',
        '        self.count += amount',
        '        return self.count',
        '',
        '    @property',
        '    def doubled(self) -> float:',
        '        """@blueprint pure"""',
        '        return self.count * 2',
        '',
        '',
        'class BigCounter(Counter):',
        '    def __init__(self, start: float) -> None:',
        '        """@blueprint"""',
        '        super().__init__(start * 10)',
        ''
      ].join('\n')
    },
    csharp: {
      path: 'lib/Counter.cs',
      text: [
        'namespace Game;',
        '',
        'public class Counter',
        '{',
        '    /// @blueprint',
        '    public double Count { get; set; }',
        '',
        '    /// @blueprint',
        '    public Counter(double start) { Count = start; }',
        '',
        '    /// @blueprint',
        '    public double Add(double amount) { Count += amount; return Count; }',
        '',
        '    /// @blueprint',
        '    public double Doubled => Count * 2;',
        '}',
        '',
        'public class BigCounter : Counter',
        '{',
        '    /// @blueprint',
        '    public BigCounter(double start) : base(start * 10) { }',
        '}',
        ''
      ].join('\n')
    }
  };

  // Start → c = Construct Counter(5) → Print(c.Add(3)) → c.Count = 20 → Print(c.Doubled) →
  // b = Construct BigCounter(1) → Print(Add(Target b, 1)), with Add's Target a Counter.
  function project(language: string, key: string): { registry: NodeRegistry; document: GraphDocument } {
    const importer = languages.get(language)!.importer!;
    const module = language === 'python' ? 'game.counter' : undefined;
    const defs = exposeFunctions(importer.scan!(MODULES[key].text), { language, path: MODULES[key].path, module, exposeAll: false }).definitions;
    const find = (suffix: string) => {
      // "#Counter:new", or "#Game.Counter:new" in C# (with its namespace).
      const found = defs.find((d) => d.type.toLowerCase().endsWith(suffix.toLowerCase()) || d.type.toLowerCase().endsWith(`.${suffix.slice(1)}`.toLowerCase()));
      assert.ok(found, `no ${suffix} in ${defs.map((d) => d.type).join(', ')}`);
      return found;
    };
    const r = registry();
    r.registerMany(defs);
    const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
    const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
    const document: GraphDocument = {
      schemaVersion: 3, name: 'Counting', kind: 'class', language, variables: [],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          n('s', 'core:event.start'), n('c', find('#Counter:new').type, { 'pin:start': 5 }), n('add', find('#Counter:add').type, { 'pin:amount': 3 }), n('p1', 'core:console.print'),
          n('set', find('#Counter:set:count').type, { 'pin:value': 20 }), n('get', find('#Counter:get:doubled').type), n('p2', 'core:console.print'),
          n('b', find('#BigCounter:new').type, { 'pin:start': 1 }), n('add2', find('#Counter:add').type, { 'pin:amount': 1 }), n('p3', 'core:console.print')
        ],
        connections: [
          w('s', 'execOut', 'c', 'execIn'), w('c', 'execOut', 'add', 'execIn'), w('add', 'execOut', 'p1', 'execIn'), w('p1', 'execOut', 'set', 'execIn'),
          w('set', 'execOut', 'p2', 'execIn'), w('p2', 'execOut', 'b', 'execIn'), w('b', 'execOut', 'add2', 'execIn'), w('add2', 'execOut', 'p3', 'execIn'),
          w('c', 'returnValue', 'add', 'target'), w('add', 'returnValue', 'p1', 'value'), w('c', 'returnValue', 'set', 'target'),
          w('c', 'returnValue', 'get', 'target'), w('get', 'returnValue', 'p2', 'value'), w('b', 'returnValue', 'add2', 'target'), w('add2', 'returnValue', 'p3', 'value')
        ]
      }]
    };
    return { registry: r, document };
  }

  function build(language: string, key: string, generate: Partial<GenerateOptions> = {}): { file: string; className: string; dir: string; importRoots?: string[] } {
    const { registry: r, document } = project(language, key);
    const dir = path.join(workDir, `classes-${key}`);
    const module = MODULES[key];
    fs.mkdirSync(path.join(dir, path.dirname(module.path)), { recursive: true });
    fs.mkdirSync(path.join(dir, 'graphs'), { recursive: true });
    fs.writeFileSync(path.join(dir, module.path), module.text);
    if (language === 'python') fs.writeFileSync(path.join(dir, path.dirname(module.path), '__init__.py'), '');
    const result = compileDocument(document, { registry: r, languages, generate: { sourceFileName: 'counting.vgraph', outputDir: 'graphs', namespace: 'Game', ...generate } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'graphs', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    return { file, className: result.output!.className, dir, importRoots: result.output!.importRoots?.map((root) => path.join(dir, root)) };
  }

  test('a subclass object wires where its base class is expected, and nothing else does', () => {
    const { registry: r, document } = project('typescript', 'typescript');
    assert.deepEqual(compileDocument(document, { registry: r, languages, generate: { sourceFileName: 'counting.vgraph' } }).diagnostics, []);
    // Add's result (a number) isn't a Counter.
    document.graphs[0].connections.push({ id: 'bad', fromNode: 'add', fromPin: 'returnValue', toNode: 'get', toPin: 'target' });
    document.graphs[0].connections = document.graphs[0].connections.filter((c) => c.id === 'bad' || !(c.toNode === 'get' && c.toPin === 'target'));
    assert.ok(compileDocument(document, { registry: r, languages, generate: { sourceFileName: 'counting.vgraph' } }).diagnostics.some((d) => d.severity === 'error'));
  });

  for (const target of [
    { label: 'TypeScript', language: 'typescript', key: 'typescript' },
    { label: 'JavaScript (ES modules)', language: 'javascript', key: 'javascript-esm', moduleFormat: 'esm' as const },
    { label: 'JavaScript (CommonJS)', language: 'javascript', key: 'javascript-commonjs', moduleFormat: 'commonjs' as const },
    { label: 'Python', language: 'python', key: 'python' },
    { label: 'C#', language: 'csharp', key: 'csharp' }
  ]) {
    test(`${target.label} constructs them and calls their members`, async (t) => {
      const { file, className, dir, importRoots } = build(target.language, target.key, { moduleFormat: target.moduleFormat });
      let outcome;
      try {
        const sources = target.language === 'csharp' ? [path.join(dir, MODULES[target.key].path)] : undefined;
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, className, { cwd: path.join(dir, 'graphs'), importRoots, sources, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), ['8', '40', '11'], `stderr:\n${outcome.stderr}`);
    });
  }

  for (const { language, key, flags } of [
    { language: 'typescript', key: 'typescript', flags: { allowImportingTsExtensions: true } },
    { language: 'javascript', key: 'javascript-esm', flags: { allowJs: true, checkJs: true } }
  ]) {
    test(`${language} using them type-checks under --strict`, () => {
      const { file, dir } = build(`${language}`, key);
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'], types: [], ...flags },
        files: [path.relative(dir, file)]
      }));
      const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
      const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
});

// A function library made of graphs (docs/program-structure.md, "Functions"), called from a graph
// in another folder: its generated file is imported like project code, and Simulate runs the
// library's graphs.
describe('function libraries', () => {
  const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
  const pin = (id: string, name: string, defaultValue?: number) => ({ id, name, kind: 'data' as const, type: { id: 'float' }, ...(defaultValue !== undefined ? { defaultValue } : {}) });

  // Difference And Product(A, B) prints "computing" and returns both; Scale(Value, Factor = 2) is pure.
  function library(language: string): GraphDocument {
    return {
      schemaVersion: 3, name: 'MathTools', kind: 'functionLibrary', language, variables: [],
      graphs: [
        {
          id: 'DiffProduct', name: 'Difference And Product', kind: 'function', comments: [],
          signature: { inputs: [pin('a', 'A'), pin('b', 'B')], outputs: [pin('difference', 'Difference'), pin('product', 'Product')] },
          nodes: [
            n('entry', 'core:function.entry', { graph: 'DiffProduct' }), n('print', 'core:console.print', { 'pin:value': 'computing' }),
            n('sub', 'core:math.subtract'), n('mul', 'core:math.multiply'), n('return', 'core:function.return', { graph: 'DiffProduct' })
          ],
          connections: [
            w('entry', 'execOut', 'print', 'execIn'), w('print', 'execOut', 'return', 'execIn'),
            w('entry', 'a', 'sub', 'a'), w('entry', 'b', 'sub', 'b'), w('entry', 'a', 'mul', 'a'), w('entry', 'b', 'mul', 'b'),
            w('sub', 'returnValue', 'return', 'difference'), w('mul', 'returnValue', 'return', 'product')
          ]
        },
        {
          id: 'Scale', name: 'Scale', kind: 'function', comments: [],
          signature: { pure: true, inputs: [pin('value', 'Value'), pin('factor', 'Factor', 2)], outputs: [pin('result', 'Result')] },
          nodes: [n('entry', 'core:function.entry', { graph: 'Scale' }), n('mul', 'core:math.multiply'), n('return', 'core:function.return', { graph: 'Scale' })],
          connections: [w('entry', 'execOut', 'return', 'execIn'), w('entry', 'value', 'mul', 'a'), w('entry', 'factor', 'mul', 'b'), w('mul', 'returnValue', 'return', 'result')]
        }
      ]
    };
  }

  // Where a language generates the library, compiled into lib/.
  function output(lib: GraphDocument, language: string) {
    const generator = languages.get(language)!.generator!;
    return {
      generatedPath: `lib/${generator.outputFileName('MathTools.vgraph')}`,
      exports: generator.libraryExports(lib.name, lib.graphs.map((g) => ({ id: g.id, name: g.name }))),
      module: language === 'python' ? 'math_tools_vgraph' : language === 'csharp' ? 'Lib' : undefined
    };
  }

  // The library's nodes as the workspace service makes them; `others` are its other languages.
  function definitions(language: string, others: string[] = []): NodeDefinition[] {
    const lib = library(language);
    return libraryDefinitions(lib, {
      documentPath: 'lib/MathTools.vgraph',
      ...output(lib, language),
      ...(others.length ? { others: Object.fromEntries(others.map((other) => [other, output(lib, other)])) } : {})
    });
  }

  // Start → Difference And Product(10, 4) → Print(Difference) → Print(Scale(Product)), in
  // `language`, calling a library whose first language is `libraryLanguage` (and has `others`).
  function caller(language: string, libraryLanguage = language, others: string[] = []): { registry: NodeRegistry; document: GraphDocument } {
    const defs = definitions(libraryLanguage, others);
    const diff = defs.find((d) => d.displayName === 'Difference And Product')!;
    const scale = defs.find((d) => d.displayName === 'Scale')!;
    const r = registry();
    r.registerMany(defs);
    const document: GraphDocument = {
      schemaVersion: 3, name: 'Caller', kind: 'class', language, variables: [],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          n('s', 'core:event.start'), n('d', diff.type, { 'pin:a': 10, 'pin:b': 4 }), n('p1', 'core:console.print'),
          n('scale', scale.type), n('p2', 'core:console.print')
        ],
        connections: [
          w('s', 'execOut', 'd', 'execIn'), w('d', 'execOut', 'p1', 'execIn'), w('p1', 'execOut', 'p2', 'execIn'),
          w('d', 'difference', 'p1', 'value'), w('d', 'product', 'scale', 'value'), w('scale', 'result', 'p2', 'value')
        ]
      }]
    };
    return { registry: r, document };
  }

  test('the library makes a node per function, named by the library, not a language', () => {
    const defs = definitions('typescript');
    assert.deepEqual(defs.map((d) => [d.type, d.displayName, d.category]), [
      ['lib:lib/MathTools.vgraph#DiffProduct', 'Difference And Product', 'MathTools'],
      ['lib:lib/MathTools.vgraph#Scale', 'Scale', 'MathTools']
    ]);
    assert.deepEqual(defs[1].inputs.map((p) => [p.id, p.defaultValue]), [['value', undefined], ['factor', 2]]);
    assert.ok(defs[0].inputs.some((p) => p.kind === 'exec') && !defs[1].inputs.some((p) => p.kind === 'exec'));
    // Graphs made before libraries had several languages used the generated file's functions.
    assert.deepEqual(defs.map((d) => d.aliases), [['fn:typescript:lib/MathTools.vgraph.ts#differenceAndProduct'], ['fn:typescript:lib/MathTools.vgraph.ts#scale']]);
    assert.deepEqual(definitions('csharp').map((d) => d.aliases), [
      ['fn:csharp:lib/MathTools.vgraph.cs#Lib.MathTools.DifferenceAndProduct'],
      ['fn:csharp:lib/MathTools.vgraph.cs#Lib.MathTools.Scale']
    ]);
  });

  test('a library for several languages names its function in each', () => {
    const [diff] = definitions('typescript', ['python', 'csharp']);
    assert.deepEqual(diff.implementation?.kind === 'function' && diff.implementation.variants, {
      python: { path: 'lib/math_tools_vgraph.py', name: 'difference_and_product', module: 'math_tools_vgraph' },
      csharp: { path: 'lib/MathTools.vgraph.cs', name: 'DifferenceAndProduct', module: 'Lib.MathTools' }
    });
  });

  test('a graph in a language the library isn\'t generated for can\'t call it', () => {
    const { registry: r, document } = caller('go', 'typescript', ['python']);
    const result = compileDocument(document, { registry: r, languages, generate: { sourceFileName: 'Caller.vgraph' } });
    assert.deepEqual(result.diagnostics.filter((d) => d.nodeId === 'd').map((d) => d.message), [
      '"Difference And Product" is in a TypeScript and Python function library (lib/MathTools.vgraph); add Go to its languages to call it from this graph.'
    ]);
  });

  test('a graph made with the generated file\'s functions still calls them', () => {
    const { registry: r, document } = caller('typescript');
    for (const node of document.graphs[0].nodes) node.type = r.get(node.type)?.aliases?.[0] ?? node.type;
    assert.ok(document.graphs[0].nodes.some((node) => node.type.startsWith('fn:')));
    const result = compileDocument(document, { registry: r, languages, generate: { sourceFileName: 'Caller.vgraph' } });
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.output!.text, /differenceAndProduct\(/);
  });

  test('Simulate runs the library\'s graphs', () => {
    const { registry: r, document } = caller('typescript');
    const events: RuntimeLogEvent[] = [];
    const loaded: string[] = [];
    new GraphRuntime(r, (e) => events.push(e), languages, (file) => (loaded.push(file), library('typescript'))).run(document);
    assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.message), ['computing', '6', '80']);
    assert.ok(loaded.every((f) => f === 'lib/MathTools.vgraph'));
    // Nodes inside the library are reported with its file.
    assert.ok(events.some((e) => e.kind === 'node.enter' && e.document === 'lib/MathTools.vgraph'));
  });

  test('Simulate reports a library it can\'t read', () => {
    const { registry: r, document } = caller('typescript');
    const events: RuntimeLogEvent[] = [];
    new GraphRuntime(r, (e) => events.push(e), languages, () => undefined).run(document);
    const error = events.find((e) => e.kind === 'error');
    assert.equal(error?.nodeId, 'd');
    assert.match(error?.message ?? '', /lib\/MathTools\.vgraph/);
  });

  // Compiles the library into lib/ and the caller into graphs/. A library for several languages
  // (`libraryLanguage` first, then `others`) is compiled in the caller's language, as the
  // extension writes a file for each.
  function build(key: string, language: string, generate: Partial<GenerateOptions> = {}, libraryLanguage = language, others: string[] = []): { file: string; className: string; dir: string; libFile: string; importRoots?: string[] } {
    const dir = path.join(workDir, `library-${key}`);
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'graphs'), { recursive: true });
    const lib = compileDocument({ ...library(libraryLanguage), language }, { registry: registry(), languages, generate: { sourceFileName: 'MathTools.vgraph', outputDir: 'lib', namespace: 'Lib', ...generate } });
    assert.deepEqual(lib.diagnostics, []);
    const libFile = path.join(dir, 'lib', lib.output!.fileName);
    fs.writeFileSync(libFile, lib.output!.text);
    const { registry: r, document } = caller(language, libraryLanguage, others);
    const result = compileDocument(document, { registry: r, languages, generate: { sourceFileName: 'Caller.vgraph', outputDir: 'graphs', namespace: 'Game', ...generate } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'graphs', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    return { file, className: result.output!.className, dir, libFile, importRoots: result.output!.importRoots?.map((root) => path.join(dir, root)) };
  }

  for (const target of [
    { label: 'TypeScript', key: 'typescript', language: 'typescript' },
    { label: 'JavaScript (ES modules)', key: 'javascript-esm', language: 'javascript', moduleFormat: 'esm' as const },
    { label: 'JavaScript (CommonJS)', key: 'javascript-commonjs', language: 'javascript', moduleFormat: 'commonjs' as const },
    { label: 'Python', key: 'python', language: 'python' },
    { label: 'C#', key: 'csharp', language: 'csharp' }
  ]) {
    test(`${target.label} imports and calls them`, async (t) => {
      const { file, className, dir, libFile, importRoots } = build(target.key, target.language, { moduleFormat: target.moduleFormat });
      let outcome;
      try {
        const sources = target.language === 'csharp' ? [libFile] : undefined;
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, className, { cwd: path.join(dir, 'graphs'), importRoots, sources, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), ['computing', '6', '80'], `stderr:\n${outcome.stderr}`);
    });
  }

  // One library for TypeScript and Python: a graph in each calls its own language's file.
  for (const language of ['typescript', 'python']) {
    test(`a TypeScript and Python library is called from ${language === 'python' ? 'Python' : 'TypeScript'}`, async (t) => {
      const { file, className, dir, importRoots } = build(`shared-${language}`, language, {}, 'typescript', ['python']);
      let outcome;
      try {
        outcome = await runGeneratedCode(languages.get(language)!.generator!.runner!, file, className, { cwd: path.join(dir, 'graphs'), importRoots, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), ['computing', '6', '80'], `stderr:\n${outcome.stderr}`);
    });
  }

  for (const { language, flags } of [
    { language: 'typescript', flags: { allowImportingTsExtensions: true } },
    { language: 'javascript', flags: { allowJs: true, checkJs: true } }
  ]) {
    test(`${language} library and caller type-check under --strict`, () => {
      const { file, dir, libFile } = build(`typecheck-${language}`, language);
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'], types: [], ...flags },
        files: [path.relative(dir, libFile), path.relative(dir, file)]
      }));
      const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
      const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
});

// Structs and enums (docs/program-structure.md, "Structs and enums"), each in its own file in
// another folder, used by a class: defaults, Make, Break, Set Members (written back to the
// variable, without changing a copy), Switch on, ==, and printing.
describe('structs and enums', () => {
  const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
  const STATS = 'struct:Player Stats';
  const TEAM = 'enum:Team';

  function team(language: string): GraphDocument {
    return {
      schemaVersion: 3, name: 'Team', kind: 'enumeration', language, variables: [], graphs: [],
      enumerators: [{ id: 'red', name: 'Red' }, { id: 'blue', name: 'Light Blue' }, { id: 'green', name: 'Green' }]
    };
  }

  function stats(language: string): GraphDocument {
    return {
      schemaVersion: 3, name: 'Player Stats', kind: 'structure', language, graphs: [],
      variables: [
        { id: 'name', name: 'Name', type: { id: 'string' }, defaultValue: 'Hero' },
        { id: 'health', name: 'Health', type: { id: 'float' }, defaultValue: 100 },
        { id: 'team', name: 'Team', type: { id: TEAM }, defaultValue: 'blue' },
        { id: 'scores', name: 'Scores', type: { id: 'int', container: 'array' }, defaultValue: [1, 2] }
      ]
    };
  }

  const generated = (language: string, file: string) => `types/${languages.get(language)!.generator!.outputFileName(file)}`;
  const moduleOf = (language: string, file: string) => (language === 'python' ? languages.get('python')!.generator!.outputFileName(file).replace(/\.py$/, '') : language === 'csharp' ? 'Types' : undefined);

  function definitions(language: string): NodeDefinition[] {
    return [[team(language), 'Team.vgraph'], [stats(language), 'PlayerStats.vgraph']].flatMap(([doc, file]) => {
      const module = moduleOf(language, file as string);
      const type = declaredType(doc as GraphDocument, { document: `types/${file}`, generatedPath: generated(language, file as string), ...(module ? { module } : {}) })!;
      return userTypeDefinitions(type);
    });
  }

  // Start → Print(Stats) → Set Copy = Stats → Set members in Stats (Health 42) → Print(Stats.Health)
  // → Print(Copy.Health) → Print(Make(Mage, 7, Red)) → Switch on Stats.Team → Print → Print(Stats.Team == Green).
  function game(language: string): { registry: NodeRegistry; document: GraphDocument } {
    const r = registry();
    r.registerMany(definitions(language));
    const document: GraphDocument = {
      schemaVersion: 3, name: 'Game', kind: 'class', language,
      variables: [{ id: 'stats', name: 'Stats', type: { id: STATS }, defaultValue: {} }, { id: 'copy', name: 'Copy', type: { id: STATS } }],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          n('s', 'core:event.start'), n('get', 'core:variable.get', { variable: 'stats' }), n('getCopy', 'core:variable.get', { variable: 'copy' }),
          n('p1', 'core:console.print'), n('setCopy', 'core:variable.set', { variable: 'copy' }),
          n('members', `${STATS}.set-members`, { members: ['health'], 'pin:health': 42 }),
          n('break', `${STATS}.break`), n('breakCopy', `${STATS}.break`), n('p2', 'core:console.print'), n('p3', 'core:console.print'),
          n('make', `${STATS}.make`, { 'pin:name': 'Mage', 'pin:health': 7, 'pin:team': 'red' }), n('p4', 'core:console.print'),
          n('switch', `${TEAM}.switch`), n('isRed', 'core:console.print', { 'pin:value': 'is red' }), n('isBlue', 'core:console.print', { 'pin:value': 'is blue' }),
          n('eq', `${TEAM}.equal`, { 'pin:b': 'green' }), n('p5', 'core:console.print'),
          // Split struct pins: Stats' Name from a split Get; Copy set from split fields.
          n('getSplit', 'core:variable.get', { variable: 'stats', split: ['value'] }), n('p6', 'core:console.print'),
          n('setSplit', 'core:variable.set', { variable: 'copy', split: ['value'], 'pin:value.name': 'Split', 'pin:value.team': 'green' }),
          n('getCopy2', 'core:variable.get', { variable: 'copy' }), n('p7', 'core:console.print')
        ],
        connections: [
          w('s', 'execOut', 'p1', 'execIn'), w('get', 'value', 'p1', 'value'),
          w('p1', 'execOut', 'setCopy', 'execIn'), w('get', 'value', 'setCopy', 'value'),
          w('setCopy', 'execOut', 'members', 'execIn'), w('get', 'value', 'members', 'struct'),
          w('members', 'execOut', 'p2', 'execIn'), w('get', 'value', 'break', 'struct'), w('break', 'health', 'p2', 'value'),
          w('p2', 'execOut', 'p3', 'execIn'), w('getCopy', 'value', 'breakCopy', 'struct'), w('breakCopy', 'health', 'p3', 'value'),
          w('p3', 'execOut', 'p4', 'execIn'), w('make', 'struct', 'p4', 'value'),
          w('p4', 'execOut', 'switch', 'execIn'), w('break', 'team', 'switch', 'selection'),
          w('switch', 'red', 'isRed', 'execIn'), w('switch', 'blue', 'isBlue', 'execIn'),
          w('isBlue', 'execOut', 'p5', 'execIn'), w('break', 'team', 'eq', 'a'), w('eq', 'returnValue', 'p5', 'value'),
          w('p5', 'execOut', 'p6', 'execIn'), w('getSplit', 'value.name', 'p6', 'value'),
          w('p6', 'execOut', 'setSplit', 'execIn'), w('getSplit', 'value.health', 'setSplit', 'value.health'),
          w('setSplit', 'execOut', 'p7', 'execIn'), w('getCopy2', 'value', 'p7', 'value')
        ]
      }]
    };
    return { registry: r, document };
  }

  const EXPECTED = [
    '{"Name":"Hero","Health":100,"Team":"Light Blue","Scores":[1,2]}',
    '42',
    '100',
    '{"Name":"Mage","Health":7,"Team":"Red","Scores":[1,2]}',
    'is blue',
    'false',
    'Hero',
    '{"Name":"Split","Health":42,"Team":"Green","Scores":[1,2]}'
  ];

  test('Simulate', () => {
    const { registry: r, document } = game('typescript');
    const events: RuntimeLogEvent[] = [];
    new GraphRuntime(r, (e) => events.push(e)).run(document);
    assert.deepEqual(events.filter((e) => e.kind === 'error'), []);
    assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.message), EXPECTED);
  });

  // Compiles the types into types/ and the class into game/.
  function build(key: string, language: string, generate: Partial<GenerateOptions> = {}): { file: string; className: string; dir: string; typeFiles: string[]; importRoots?: string[] } {
    const dir = path.join(workDir, `types-${key}`);
    fs.mkdirSync(path.join(dir, 'types'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
    const typeRegistry = registry();
    typeRegistry.registerMany(definitions(language));
    const typeFiles = ([[team(language), 'Team.vgraph'], [stats(language), 'PlayerStats.vgraph']] as const).map(([doc, file]) => {
      const result = compileDocument(doc, { registry: typeRegistry, languages, generate: { sourceFileName: file, outputDir: 'types', namespace: 'Types', ...generate } });
      assert.deepEqual(result.diagnostics, [], `${file}: ${JSON.stringify(result.diagnostics)}`);
      const out = path.join(dir, 'types', result.output!.fileName);
      fs.writeFileSync(out, result.output!.text);
      return out;
    });
    const { registry: r, document } = game(language);
    const result = compileDocument(document, { registry: r, languages, generate: { sourceFileName: 'Game.vgraph', outputDir: 'game', namespace: 'Game', ...generate } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    return { file, className: result.output!.className, dir, typeFiles, importRoots: result.output!.importRoots?.map((root) => path.join(dir, root)) };
  }

  for (const target of [
    { label: 'TypeScript', key: 'typescript', language: 'typescript' },
    { label: 'JavaScript (ES modules)', key: 'javascript-esm', language: 'javascript', moduleFormat: 'esm' as const },
    { label: 'JavaScript (CommonJS)', key: 'javascript-commonjs', language: 'javascript', moduleFormat: 'commonjs' as const },
    { label: 'Python', key: 'python', language: 'python' },
    { label: 'C#', key: 'csharp', language: 'csharp' }
  ]) {
    test(target.label, async (t) => {
      const { file, className, dir, typeFiles, importRoots } = build(target.key, target.language, { moduleFormat: target.moduleFormat });
      let outcome;
      try {
        const sources = target.language === 'csharp' ? typeFiles : undefined;
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, className, { cwd: path.join(dir, 'game'), importRoots, sources, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), EXPECTED, `stderr:\n${outcome.stderr}`);
    });
  }

  for (const { language, flags } of [
    { language: 'typescript', flags: { allowImportingTsExtensions: true } },
    { language: 'javascript', flags: { allowJs: true, checkJs: true } }
  ]) {
    test(`${language} types and their use type-check under --strict`, () => {
      const { file, dir, typeFiles } = build(`typecheck-${language}`, language);
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'], types: [], ...flags },
        files: [...typeFiles, file].map((f) => path.relative(dir, f))
      }));
      const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
      const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
});

// Objects (docs/program-structure.md, "Classes"): a Game class constructs an Enemy (a class in
// another folder), reads and sets its variables, calls its functions (impure, with an output, and
// pure), runs its custom event, and binds an event of its own to the Enemy's event dispatcher.
describe('objects', () => {
  const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
  const ENEMY = 'object:Enemy';
  const nameInput = { id: 'name', name: 'Name', kind: 'data' as const, type: { id: 'string' } };

  function enemy(language: string): GraphDocument {
    const get = (id: string, variable: string) => n(id, 'core:variable.get', { variable });
    return {
      schemaVersion: 3, name: 'Enemy', kind: 'class', language,
      variables: [{ id: 'health', name: 'Health', type: { id: 'int' }, defaultValue: 3 }, { id: 'name', name: 'Name', type: { id: 'string' }, defaultValue: 'Goblin' }],
      dispatchers: [{ id: 'died', name: 'Died', inputs: [nameInput] }],
      graphs: [
        {
          id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
          nodes: [
            n('s', 'core:event.start'), n('ready', 'core:console.print', { 'pin:value': 'enemy ready' }),
            n('taunt', 'core:event.custom', { name: 'Taunt' }), n('grr', 'core:string.append', { 'pin:a': 'Grr from ' }), get('name', 'name'), n('p', 'core:console.print')
          ],
          connections: [w('s', 'execOut', 'ready', 'execIn'), w('taunt', 'execOut', 'p', 'execIn'), w('name', 'value', 'grr', 'b'), w('grr', 'returnValue', 'p', 'value')]
        },
        {
          // Take Damage(Amount) -> Remaining: Health -= Amount; Died(Name) when it reaches 0.
          id: 'TakeDamage', name: 'Take Damage', kind: 'function', comments: [],
          signature: { inputs: [{ id: 'amount', name: 'Amount', kind: 'data', type: { id: 'int' } }], outputs: [{ id: 'remaining', name: 'Remaining', kind: 'data', type: { id: 'int' } }] },
          nodes: [
            n('entry', 'core:function.entry', { graph: 'TakeDamage' }), get('health', 'health'), n('sub', 'core:math.subtract'), n('set', 'core:variable.set', { variable: 'health' }),
            get('health2', 'health'), n('dead', 'core:math.less-equal', { 'pin:b': 0 }), n('branch', 'core:flow.branch'), get('name', 'name'),
            n('died', 'core:dispatcher.call', { dispatcher: 'died' }), n('r1', 'core:function.return', { graph: 'TakeDamage' }), n('r2', 'core:function.return', { graph: 'TakeDamage' })
          ],
          connections: [
            w('entry', 'execOut', 'set', 'execIn'), w('health', 'value', 'sub', 'a'), w('entry', 'amount', 'sub', 'b'), w('sub', 'returnValue', 'set', 'value'),
            w('set', 'execOut', 'branch', 'execIn'), w('health2', 'value', 'dead', 'a'), w('dead', 'returnValue', 'branch', 'condition'),
            w('branch', 'true', 'died', 'execIn'), w('name', 'value', 'died', 'name'), w('died', 'execOut', 'r1', 'execIn'), w('branch', 'false', 'r2', 'execIn'),
            w('health2', 'value', 'r1', 'remaining'), w('health2', 'value', 'r2', 'remaining')
          ]
        },
        {
          id: 'IsAlive', name: 'Is Alive', kind: 'function', comments: [],
          signature: { pure: true, inputs: [], outputs: [{ id: 'alive', name: 'Alive', kind: 'data', type: { id: 'bool' } }] },
          nodes: [n('entry', 'core:function.entry', { graph: 'IsAlive' }), get('health', 'health'), n('gt', 'core:math.greater', { 'pin:b': 0 }), n('ret', 'core:function.return', { graph: 'IsAlive' })],
          connections: [w('entry', 'execOut', 'ret', 'execIn'), w('health', 'value', 'gt', 'a'), w('gt', 'returnValue', 'ret', 'alive')]
        }
      ]
    };
  }

  function game(language: string): GraphDocument {
    const enemyRef = (id: string) => n(id, 'core:variable.get', { variable: 'enemy' });
    const on = (id: string, type: string, properties: Record<string, unknown>) => n(id, type, { class: ENEMY, ...properties });
    const nodes = [
      n('s', 'core:event.start'), n('construct', `${ENEMY}.construct`), n('setEnemy', 'core:variable.set', { variable: 'enemy' }),
      n('valid', 'core:object.is-valid'), n('p1', 'core:console.print'),
      on('bind', 'core:object.dispatcher', { dispatcher: 'died', action: 'bind' }), n('onDied', 'core:event.custom', { name: 'On Enemy Died', inputs: [nameInput] }),
      n('died', 'core:string.append', { 'pin:b': ' died' }), n('pDied', 'core:console.print'),
      on('taunt', 'core:object.event', { event: 'Taunt' }), on('td1', 'core:object.call', { function: 'TakeDamage', 'pin:amount': 2 }), n('p2', 'core:console.print'),
      on('alive1', 'core:object.call', { function: 'IsAlive' }), n('p3', 'core:console.print'),
      on('setHealth', 'core:object.set', { variable: 'health', 'pin:value': 1 }), on('td2', 'core:object.call', { function: 'TakeDamage', 'pin:amount': 5 }),
      on('health', 'core:object.get', { variable: 'health' }), n('p4', 'core:console.print'), on('alive2', 'core:object.call', { function: 'IsAlive' }), n('p5', 'core:console.print'),
      ...['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9'].map(enemyRef)
    ];
    const chain = ['s', 'construct', 'setEnemy', 'p1', 'bind', 'taunt', 'td1', 'p2', 'p3', 'setHealth', 'td2', 'p4', 'p5'];
    const connections = [
      ...chain.slice(1).map((id, i) => w(chain[i], 'execOut', id, 'execIn')),
      w('construct', 'object', 'setEnemy', 'value'), w('e1', 'value', 'valid', 'object'), w('valid', 'returnValue', 'p1', 'value'),
      w('e2', 'value', 'bind', 'target'), w('onDied', 'delegate', 'bind', 'event'), w('onDied', 'execOut', 'pDied', 'execIn'), w('onDied', 'name', 'died', 'a'), w('died', 'returnValue', 'pDied', 'value'),
      w('e3', 'value', 'taunt', 'target'), w('e4', 'value', 'td1', 'target'), w('td1', 'remaining', 'p2', 'value'),
      w('e5', 'value', 'alive1', 'target'), w('alive1', 'alive', 'p3', 'value'),
      w('e6', 'value', 'setHealth', 'target'), w('e7', 'value', 'td2', 'target'),
      w('e8', 'value', 'health', 'target'), w('health', 'value', 'p4', 'value'), w('e9', 'value', 'alive2', 'target'), w('alive2', 'alive', 'p5', 'value')
    ];
    return {
      schemaVersion: 3, name: 'Game', kind: 'class', language, variables: [{ id: 'enemy', name: 'Enemy', type: { id: ENEMY } }],
      graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes, connections }]
    };
  }

  const EXPECTED = ['enemy ready', 'true', 'Grr from Goblin', '1', 'true', 'Goblin died', '-4', 'false'];
  const generated = (language: string) => `actors/${languages.get(language)!.generator!.outputFileName('Enemy.vgraph')}`;

  function registryFor(language: string): NodeRegistry {
    const r = registry();
    const module = language === 'python' ? languages.get('python')!.generator!.outputFileName('Enemy.vgraph').replace(/\.py$/, '') : language === 'csharp' ? 'Actors' : undefined;
    r.registerMany(classDefinitions(declaredClass(enemy(language), { document: 'actors/Enemy.vgraph', generatedPath: generated(language), ...(module ? { module } : {}) })!));
    return r;
  }

  test('Simulate', () => {
    const events: RuntimeLogEvent[] = [];
    new GraphRuntime(registryFor('typescript'), (e) => events.push(e), languages, (file) => (file === 'actors/Enemy.vgraph' ? enemy('typescript') : undefined)).run(game('typescript'));
    assert.deepEqual(events.filter((e) => e.kind === 'error'), []);
    assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.message), EXPECTED);
  });

  function build(key: string, language: string, generate: Partial<GenerateOptions> = {}): { file: string; className: string; dir: string; enemyFile: string; importRoots?: string[] } {
    const dir = path.join(workDir, `objects-${key}`);
    fs.mkdirSync(path.join(dir, 'actors'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
    const r = registryFor(language);
    const enemyResult = compileDocument(enemy(language), { registry: r, languages, generate: { sourceFileName: 'Enemy.vgraph', outputDir: 'actors', namespace: 'Actors', ...generate } });
    assert.deepEqual(enemyResult.diagnostics, []);
    const enemyFile = path.join(dir, 'actors', enemyResult.output!.fileName);
    fs.writeFileSync(enemyFile, enemyResult.output!.text);
    const result = compileDocument(game(language), { registry: r, languages, generate: { sourceFileName: 'Game.vgraph', outputDir: 'game', namespace: 'App', ...generate } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    return { file, className: result.output!.className, dir, enemyFile, importRoots: result.output!.importRoots?.map((root) => path.join(dir, root)) };
  }

  for (const target of [
    { label: 'TypeScript', key: 'typescript', language: 'typescript' },
    { label: 'JavaScript (ES modules)', key: 'javascript-esm', language: 'javascript', moduleFormat: 'esm' as const },
    { label: 'JavaScript (CommonJS)', key: 'javascript-commonjs', language: 'javascript', moduleFormat: 'commonjs' as const },
    { label: 'Python', key: 'python', language: 'python' },
    { label: 'C#', key: 'csharp', language: 'csharp' }
  ]) {
    test(target.label, async (t) => {
      const { file, className, dir, enemyFile, importRoots } = build(target.key, target.language, { moduleFormat: target.moduleFormat });
      let outcome;
      try {
        const sources = target.language === 'csharp' ? [enemyFile] : undefined;
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, className, { cwd: path.join(dir, 'game'), importRoots, sources, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), EXPECTED, `stderr:\n${outcome.stderr}`);
    });
  }

  for (const { language, flags } of [
    { language: 'typescript', flags: { allowImportingTsExtensions: true } },
    { language: 'javascript', flags: { allowJs: true, checkJs: true } }
  ]) {
    test(`${language} classes type-check under --strict`, () => {
      const { file, dir, enemyFile } = build(`typecheck-${language}`, language);
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'], types: [], ...flags },
        files: [enemyFile, file].map((f) => path.relative(dir, f))
      }));
      const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
      const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
});

// Inheritance (docs/program-structure.md, "Classes"): Dog extends Animal, overrides Speak (calling
// the parent's version) and Start (calling Parent: Start); a Game holds the Dog in an Animal
// variable and calls its functions and reads its inherited variable through it.
describe('inheritance', () => {
  const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
  const ANIMAL = 'object:Animal';
  const speak = (id: string) => ({ id, name: 'Speak', kind: 'function' as const, comments: [], signature: { inputs: [], outputs: [] } });

  function animal(language: string): GraphDocument {
    return {
      schemaVersion: 3, name: 'Animal', kind: 'class', language,
      variables: [{ id: 'name', name: 'Name', type: { id: 'string' }, defaultValue: 'animal' }, { id: 'sound', name: 'Sound', type: { id: 'string' }, defaultValue: ' makes a sound', access: 'protected' }],
      graphs: [
        {
          id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
          nodes: [n('s', 'core:event.start'), n('p', 'core:console.print', { 'pin:value': 'animal start' })], connections: [w('s', 'execOut', 'p', 'execIn')]
        },
        {
          ...speak('Speak'),
          nodes: [n('entry', 'core:function.entry', { graph: 'Speak' }), n('name', 'core:variable.get', { variable: 'name' }), n('sound', 'core:variable.get', { variable: 'sound' }), n('say', 'core:string.append'), n('p', 'core:console.print')],
          connections: [w('entry', 'execOut', 'p', 'execIn'), w('name', 'value', 'say', 'a'), w('sound', 'value', 'say', 'b'), w('say', 'returnValue', 'p', 'value')]
        },
        {
          id: 'Legs', name: 'Legs', kind: 'function', comments: [], signature: { pure: true, inputs: [], outputs: [{ id: 'legs', name: 'Legs', kind: 'data', type: { id: 'int' } }] },
          nodes: [n('entry', 'core:function.entry', { graph: 'Legs' }), n('ret', 'core:function.return', { graph: 'Legs', 'pin:legs': 4 })], connections: [w('entry', 'execOut', 'ret', 'execIn')]
        }
      ]
    };
  }

  function dog(language: string): GraphDocument {
    return {
      schemaVersion: 3, name: 'Dog', kind: 'class', language, parent: ANIMAL, variables: [],
      graphs: [
        {
          id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
          // The parent's protected Sound, read from the subclass.
          nodes: [
            n('s', 'core:event.start'), n('p', 'core:console.print', { 'pin:value': 'dog start' }), n('sound', 'core:object.get', { class: ANIMAL, variable: 'sound' }),
            n('p2', 'core:console.print'), n('parent', 'core:object.parent', { function: 'Start' })
          ],
          connections: [w('s', 'execOut', 'p', 'execIn'), w('p', 'execOut', 'p2', 'execIn'), w('sound', 'value', 'p2', 'value'), w('p2', 'execOut', 'parent', 'execIn')]
        },
        {
          ...speak('DogSpeak'),
          nodes: [n('entry', 'core:function.entry', { graph: 'DogSpeak' }), n('p', 'core:console.print', { 'pin:value': 'woof' }), n('parent', 'core:object.parent', { function: 'Speak' })],
          connections: [w('entry', 'execOut', 'p', 'execIn'), w('p', 'execOut', 'parent', 'execIn')]
        }
      ]
    };
  }

  function game(language: string): GraphDocument {
    const pet = (id: string) => n(id, 'core:variable.get', { variable: 'pet' });
    return {
      schemaVersion: 3, name: 'Game', kind: 'class', language, variables: [{ id: 'pet', name: 'Pet', type: { id: ANIMAL } }],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          n('s', 'core:event.start'), n('make', 'object:Dog.construct'), n('set', 'core:variable.set', { variable: 'pet' }),
          n('speak', 'core:object.call', { class: ANIMAL, function: 'Speak' }), n('legs', 'core:object.call', { class: ANIMAL, function: 'Legs' }), n('p1', 'core:console.print'),
          n('name', 'core:object.get', { class: ANIMAL, variable: 'name' }), n('p2', 'core:console.print'), pet('a'), pet('b'), pet('c')
        ],
        connections: [
          w('s', 'execOut', 'make', 'execIn'), w('make', 'execOut', 'set', 'execIn'), w('make', 'object', 'set', 'value'),
          w('set', 'execOut', 'speak', 'execIn'), w('a', 'value', 'speak', 'target'), w('speak', 'execOut', 'p1', 'execIn'),
          w('b', 'value', 'legs', 'target'), w('legs', 'legs', 'p1', 'value'), w('p1', 'execOut', 'p2', 'execIn'), w('c', 'value', 'name', 'target'), w('name', 'value', 'p2', 'value')
        ]
      }]
    };
  }

  const EXPECTED = ['dog start', ' makes a sound', 'animal start', 'woof', 'animal makes a sound', '4', 'animal'];
  const DOCS = [['Animal', animal], ['Dog', dog]] as const;

  function registryFor(language: string): NodeRegistry {
    const r = registry();
    const generator = languages.get(language)!.generator!;
    for (const [name, make] of DOCS) {
      const module = language === 'python' ? generator.outputFileName(`${name}.vgraph`).replace(/\.py$/, '') : language === 'csharp' ? 'Animals' : undefined;
      r.registerMany(classDefinitions(declaredClass(make(language), { document: `animals/${name}.vgraph`, generatedPath: `animals/${generator.outputFileName(`${name}.vgraph`)}`, ...(module ? { module } : {}) })!));
    }
    return r;
  }

  test('Simulate', () => {
    const events: RuntimeLogEvent[] = [];
    const load = (file: string) => DOCS.find(([name]) => file === `animals/${name}.vgraph`)?.[1]('typescript');
    new GraphRuntime(registryFor('typescript'), (e) => events.push(e), languages, load).run(game('typescript'));
    assert.deepEqual(events.filter((e) => e.kind === 'error'), []);
    assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.message), EXPECTED);
  });

  function build(key: string, language: string, generate: Partial<GenerateOptions> = {}): { file: string; className: string; dir: string; classFiles: string[]; importRoots?: string[] } {
    const dir = path.join(workDir, `inheritance-${key}`);
    fs.mkdirSync(path.join(dir, 'animals'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
    const r = registryFor(language);
    const classFiles = DOCS.map(([name, make]) => {
      const result = compileDocument(make(language), { registry: r, languages, generate: { sourceFileName: `${name}.vgraph`, outputDir: 'animals', namespace: 'Animals', ...generate } });
      assert.deepEqual(result.diagnostics, [], name);
      const file = path.join(dir, 'animals', result.output!.fileName);
      fs.writeFileSync(file, result.output!.text);
      return file;
    });
    const result = compileDocument(game(language), { registry: r, languages, generate: { sourceFileName: 'Game.vgraph', outputDir: 'game', namespace: 'App', ...generate } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    return { file, className: result.output!.className, dir, classFiles, importRoots: result.output!.importRoots?.map((root) => path.join(dir, root)) };
  }

  for (const target of [
    { label: 'TypeScript', key: 'typescript', language: 'typescript' },
    { label: 'JavaScript (ES modules)', key: 'javascript-esm', language: 'javascript', moduleFormat: 'esm' as const },
    { label: 'JavaScript (CommonJS)', key: 'javascript-commonjs', language: 'javascript', moduleFormat: 'commonjs' as const },
    { label: 'Python', key: 'python', language: 'python' },
    { label: 'C#', key: 'csharp', language: 'csharp' }
  ]) {
    test(target.label, async (t) => {
      const { file, className, dir, classFiles, importRoots } = build(target.key, target.language, { moduleFormat: target.moduleFormat });
      let outcome;
      try {
        const sources = target.language === 'csharp' ? classFiles : undefined;
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, className, { cwd: path.join(dir, 'game'), importRoots, sources, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), EXPECTED, `stderr:\n${outcome.stderr}`);
    });
  }

  for (const { language, flags } of [
    { language: 'typescript', flags: { allowImportingTsExtensions: true } },
    { language: 'javascript', flags: { allowJs: true, checkJs: true } }
  ]) {
    test(`${language} subclasses type-check under --strict`, () => {
      const { file, dir, classFiles } = build(`typecheck-${language}`, language);
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'], types: [], ...flags },
        files: [...classFiles, file].map((f) => path.relative(dir, f))
      }));
      const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
      const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
});

// Interfaces and Cast To (docs/program-structure.md, "Classes"): Crate implements Damageable (one
// function with a body, one left to its empty stub); Rock doesn't. A Game casts both, calls the
// interface through the cast and through an interface-typed variable, and casts to a class.
describe('interfaces', () => {
  const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
  const DAMAGEABLE = 'interface:Damageable';
  const amount = { id: 'amount', name: 'Amount', kind: 'data' as const, type: { id: 'int' } };
  const remaining = { id: 'remaining', name: 'Remaining', kind: 'data' as const, type: { id: 'int' } };
  const emptyEvents = (): GraphDocument['graphs'][number] => ({ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [], connections: [] });

  function damageable(language: string): GraphDocument {
    return {
      schemaVersion: 3, name: 'Damageable', kind: 'interface', language, variables: [],
      graphs: [
        { id: 'TakeDamage', name: 'Take Damage', kind: 'function', comments: [], signature: { inputs: [amount], outputs: [remaining] }, nodes: [n('entry', 'core:function.entry', { graph: 'TakeDamage' })], connections: [] },
        { id: 'Describe', name: 'Describe', kind: 'function', comments: [], signature: { inputs: [], outputs: [] }, nodes: [n('entry', 'core:function.entry', { graph: 'Describe' })], connections: [] }
      ]
    };
  }

  function crate(language: string): GraphDocument {
    return {
      schemaVersion: 3, name: 'Crate', kind: 'class', language, interfaces: [DAMAGEABLE], variables: [{ id: 'hp', name: 'HP', type: { id: 'int' }, defaultValue: 5 }],
      graphs: [emptyEvents(), {
        id: 'TakeDamage', name: 'Take Damage', kind: 'function', comments: [], signature: { inputs: [amount], outputs: [remaining] },
        nodes: [
          n('entry', 'core:function.entry', { graph: 'TakeDamage' }), n('hp', 'core:variable.get', { variable: 'hp' }), n('sub', 'core:math.subtract'),
          n('set', 'core:variable.set', { variable: 'hp' }), n('ret', 'core:function.return', { graph: 'TakeDamage' })
        ],
        connections: [
          w('entry', 'execOut', 'set', 'execIn'), w('hp', 'value', 'sub', 'a'), w('entry', 'amount', 'sub', 'b'), w('sub', 'returnValue', 'set', 'value'),
          w('set', 'execOut', 'ret', 'execIn'), w('set', 'result', 'ret', 'remaining')
        ]
      }]
    };
  }

  const rock = (language: string): GraphDocument => ({ schemaVersion: 3, name: 'Rock', kind: 'class', language, variables: [], graphs: [emptyEvents()] });

  function game(language: string): GraphDocument {
    const call = (id: string, fn: string, properties: Record<string, unknown> = {}) => n(id, 'core:interface.call', { interface: DAMAGEABLE, function: fn, ...properties });
    return {
      schemaVersion: 3, name: 'Game', kind: 'class', language, variables: [{ id: 'target', name: 'Target', type: { id: DAMAGEABLE } }],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          n('s', 'core:event.start'), n('crate', 'object:Crate.construct'), n('cast', `${DAMAGEABLE}.cast`), call('hit', 'TakeDamage', { 'pin:amount': 2 }), n('p1', 'core:console.print'),
          call('describe', 'Describe'), n('p2', 'core:console.print', { 'pin:value': 'described' }),
          n('rock', 'object:Rock.construct'), n('castRock', `${DAMAGEABLE}.cast`), n('p3', 'core:console.print', { 'pin:value': 'rock is not damageable' }),
          n('castCrate', 'object:Crate.cast'), n('p4', 'core:console.print', { 'pin:value': 'crate' }),
          n('set', 'core:variable.set', { variable: 'target' }), n('get', 'core:variable.get', { variable: 'target' }), call('hit2', 'TakeDamage', { 'pin:amount': 1 }), n('p5', 'core:console.print')
        ],
        connections: [
          w('s', 'execOut', 'crate', 'execIn'), w('crate', 'execOut', 'cast', 'execIn'), w('crate', 'object', 'cast', 'object'),
          w('cast', 'succeeded', 'hit', 'execIn'), w('cast', 'as', 'hit', 'target'), w('hit', 'execOut', 'p1', 'execIn'), w('hit', 'remaining', 'p1', 'value'),
          w('p1', 'execOut', 'describe', 'execIn'), w('cast', 'as', 'describe', 'target'), w('describe', 'execOut', 'p2', 'execIn'),
          w('p2', 'execOut', 'rock', 'execIn'), w('rock', 'execOut', 'castRock', 'execIn'), w('rock', 'object', 'castRock', 'object'), w('castRock', 'failed', 'p3', 'execIn'),
          w('p3', 'execOut', 'castCrate', 'execIn'), w('crate', 'object', 'castCrate', 'object'), w('castCrate', 'succeeded', 'p4', 'execIn'),
          w('p4', 'execOut', 'set', 'execIn'), w('crate', 'object', 'set', 'value'), w('set', 'execOut', 'hit2', 'execIn'), w('get', 'value', 'hit2', 'target'),
          w('hit2', 'execOut', 'p5', 'execIn'), w('hit2', 'remaining', 'p5', 'value')
        ]
      }]
    };
  }

  const EXPECTED = ['3', 'described', 'rock is not damageable', 'crate', '2'];
  const DOCS = [['Damageable', damageable], ['Crate', crate], ['Rock', rock]] as const;

  function registryFor(language: string): NodeRegistry {
    const r = registry();
    const generator = languages.get(language)!.generator!;
    for (const [name, make] of DOCS) {
      const module = language === 'python' ? generator.outputFileName(`${name}.vgraph`).replace(/\.py$/, '') : language === 'csharp' ? 'Things' : undefined;
      const source = { document: `things/${name}.vgraph`, generatedPath: `things/${generator.outputFileName(`${name}.vgraph`)}`, ...(module ? { module } : {}) };
      const doc = make(language);
      r.registerMany(doc.kind === 'interface' ? interfaceDefinitions(declaredInterface(doc, source)!) : classDefinitions(declaredClass(doc, source)!));
    }
    return r;
  }

  test('Simulate', () => {
    const events: RuntimeLogEvent[] = [];
    const load = (file: string) => DOCS.find(([name]) => file === `things/${name}.vgraph`)?.[1]('typescript');
    new GraphRuntime(registryFor('typescript'), (e) => events.push(e), languages, load).run(game('typescript'));
    assert.deepEqual(events.filter((e) => e.kind === 'error'), []);
    assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.message), EXPECTED);
  });

  function build(key: string, language: string, generate: Partial<GenerateOptions> = {}): { file: string; className: string; dir: string; files: string[]; importRoots?: string[] } {
    const dir = path.join(workDir, `interfaces-${key}`);
    fs.mkdirSync(path.join(dir, 'things'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
    const r = registryFor(language);
    const files = DOCS.map(([name, make]) => {
      const result = compileDocument(make(language), { registry: r, languages, generate: { sourceFileName: `${name}.vgraph`, outputDir: 'things', namespace: 'Things', ...generate } });
      assert.deepEqual(result.diagnostics, [], name);
      const file = path.join(dir, 'things', result.output!.fileName);
      fs.writeFileSync(file, result.output!.text);
      return file;
    });
    const result = compileDocument(game(language), { registry: r, languages, generate: { sourceFileName: 'Game.vgraph', outputDir: 'game', namespace: 'App', ...generate } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    return { file, className: result.output!.className, dir, files, importRoots: result.output!.importRoots?.map((root) => path.join(dir, root)) };
  }

  for (const target of [
    { label: 'TypeScript', key: 'typescript', language: 'typescript' },
    { label: 'JavaScript (ES modules)', key: 'javascript-esm', language: 'javascript', moduleFormat: 'esm' as const },
    { label: 'JavaScript (CommonJS)', key: 'javascript-commonjs', language: 'javascript', moduleFormat: 'commonjs' as const },
    { label: 'Python', key: 'python', language: 'python' },
    { label: 'C#', key: 'csharp', language: 'csharp' }
  ]) {
    test(target.label, async (t) => {
      const { file, className, dir, files, importRoots } = build(target.key, target.language, { moduleFormat: target.moduleFormat });
      let outcome;
      try {
        const sources = target.language === 'csharp' ? files : undefined;
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, className, { cwd: path.join(dir, 'game'), importRoots, sources, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), EXPECTED, `stderr:\n${outcome.stderr}`);
    });
  }

  for (const { language, flags } of [
    { language: 'typescript', flags: { allowImportingTsExtensions: true } },
    { language: 'javascript', flags: { allowJs: true, checkJs: true } }
  ]) {
    test(`${language} interfaces type-check under --strict`, () => {
      const { file, dir, files } = build(`typecheck-${language}`, language);
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'], types: [], ...flags },
        files: [...files, file].map((f) => path.relative(dir, f))
      }));
      const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
      const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
});

// Main (docs/program-structure.md, "Entry points and framework packs"): Run calls it after Start
// with the program's arguments.
describe('Main', () => {
  const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
  const ARGS = ['alpha', 'beta'];
  const EXPECTED = ['start', '2', 'alpha', 'beta'];

  function program(language: string): GraphDocument {
    return {
      schemaVersion: 3, name: 'Tool', kind: 'class', language, variables: [],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          n('s', 'core:event.start'), n('p0', 'core:console.print', { 'pin:value': 'start' }),
          n('main', 'core:event.main'), n('length', 'core:array.length', { wildcards: { wildcard: 'string' } }), n('p1', 'core:console.print'),
          n('each', 'core:flow.for-each-loop', { wildcards: { wildcard: 'string' } }), n('p2', 'core:console.print')
        ],
        connections: [
          w('s', 'execOut', 'p0', 'execIn'),
          w('main', 'execOut', 'p1', 'execIn'), w('main', 'args', 'length', 'target'), w('length', 'returnValue', 'p1', 'value'),
          w('p1', 'execOut', 'each', 'execIn'), w('main', 'args', 'each', 'array'), w('each', 'loopBody', 'p2', 'execIn'), w('each', 'element', 'p2', 'value')
        ]
      }]
    };
  }

  test('Simulate', () => {
    const events: RuntimeLogEvent[] = [];
    new GraphRuntime(registry(), (e) => events.push(e)).run(program('typescript'), ARGS);
    assert.deepEqual(events.filter((e) => e.kind === 'error'), []);
    assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.message), EXPECTED);
  });

  for (const target of [...TARGETS, { label: 'C# (through Run)', language: 'csharp', moduleFormat: undefined }]) {
    test(target.label, async (t) => {
      const dir = path.join(workDir, `main-${target.language}-${target.moduleFormat ?? 'default'}`);
      fs.mkdirSync(dir, { recursive: true });
      const result = compileDocument(program(target.language), { registry: registry(), languages, generate: { sourceFileName: 'tool.vgraph', moduleFormat: target.moduleFormat } });
      assert.deepEqual(result.diagnostics, []);
      assert.ok(result.output!.mainMethod, 'the generated class reports its Main method');
      const file = path.join(dir, result.output!.fileName);
      fs.writeFileSync(file, result.output!.text);
      let outcome;
      try {
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, result.output!.className, { cwd: dir, mainMethod: result.output!.mainMethod, args: ARGS, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), EXPECTED, `stderr:\n${outcome.stderr}`);
    });
  }
});

// Phase 4's exit program (docs/program-structure.md, "Exit check"): sample/arena, built only in
// graphs, in each language from the same files.
describe('exit program (sample/arena)', () => {
  const FILES = ['Team', 'Stats', 'Fighter', 'Knight', 'Game'];
  const read = (name: string, language: string): GraphDocument => ({ ...parseDocument(fs.readFileSync(path.join(repoRoot, 'sample/arena', `${name}.vgraph`), 'utf8')).document, language });
  const EXPECTED = read('Game', 'typescript').metadata!.expectedOutput as string[];

  // The workspace as the extension sees it: each file's types and classes, generated into arena/.
  function registryFor(language: string): NodeRegistry {
    const r = registry();
    const generator = languages.get(language)!.generator!;
    for (const name of FILES) {
      const doc = read(name, language);
      const fileName = generator.outputFileName(`${name}.vgraph`);
      const module = language === 'python' ? fileName.replace(/\.py$/, '') : language === 'csharp' ? 'Arena' : undefined;
      const source = { document: `arena/${name}.vgraph`, generatedPath: `arena/${fileName}`, ...(module ? { module } : {}) };
      const type = declaredType(doc, source);
      if (type) r.registerMany(userTypeDefinitions(type));
      const cls = declaredClass(doc, source);
      if (cls) r.registerMany(classDefinitions(cls));
    }
    return r;
  }

  test('Simulate', () => {
    const events: RuntimeLogEvent[] = [];
    const load = (file: string) => (file.startsWith('arena/') ? read(path.basename(file, '.vgraph'), 'typescript') : undefined);
    new GraphRuntime(registryFor('typescript'), (e) => events.push(e), languages, load).run(read('Game', 'typescript'));
    assert.deepEqual(events.filter((e) => e.kind === 'error'), []);
    assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.message), EXPECTED);
  });

  function build(key: string, language: string, generate: Partial<GenerateOptions> = {}): { file: string; className: string; dir: string; files: string[]; importRoots?: string[] } {
    const dir = path.join(workDir, `arena-${key}`, 'arena');
    fs.mkdirSync(dir, { recursive: true });
    const r = registryFor(language);
    let game: { file: string; className: string; importRoots?: string[] } | undefined;
    const files = FILES.map((name) => {
      const result = compileDocument(read(name, language), { registry: r, languages, generate: { sourceFileName: `${name}.vgraph`, outputDir: 'arena', namespace: 'Arena', ...generate } });
      assert.deepEqual(result.diagnostics, [], name);
      const file = path.join(dir, result.output!.fileName);
      fs.writeFileSync(file, result.output!.text);
      if (name === 'Game') game = { file, className: result.output!.className, importRoots: result.output!.importRoots?.map((root) => path.join(dir, '..', root)) };
      return file;
    });
    return { ...game!, dir, files };
  }

  for (const target of [
    { label: 'TypeScript', key: 'typescript', language: 'typescript' },
    { label: 'JavaScript (ES modules)', key: 'javascript-esm', language: 'javascript', moduleFormat: 'esm' as const },
    { label: 'JavaScript (CommonJS)', key: 'javascript-commonjs', language: 'javascript', moduleFormat: 'commonjs' as const },
    { label: 'Python', key: 'python', language: 'python' },
    { label: 'C#', key: 'csharp', language: 'csharp' }
  ]) {
    test(target.label, async (t) => {
      const { file, className, dir, files, importRoots } = build(target.key, target.language, { moduleFormat: target.moduleFormat });
      let outcome;
      try {
        const sources = target.language === 'csharp' ? files.filter((f) => f !== file) : undefined;
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, className, { cwd: dir, importRoots, sources, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), EXPECTED, `stderr:\n${outcome.stderr}`);
    });
  }

  for (const { language, flags } of [
    { language: 'typescript', flags: { allowImportingTsExtensions: true } },
    { language: 'javascript', flags: { allowJs: true, checkJs: true } }
  ]) {
    test(`${language} type-checks under --strict`, () => {
      const { dir, files } = build(`typecheck-${language}`, language);
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'], types: [], ...flags },
        files: files.map((f) => path.relative(dir, f))
      }));
      const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
      const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
});

// Save String to File then Load File to String, in a scratch folder, on every target.
describe('file nodes', () => {
  function fileGraph(file: string, language: string): GraphDocument {
    const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
    const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}`, fromNode, fromPin, toNode, toPin });
    return {
      schemaVersion: 3, name: 'Files', kind: 'class', language, variables: [],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          n('s', 'core:event.start'),
          n('save', 'core:file.save-string', { 'pin:text': 'saved: héllo', 'pin:filename': file }),
          n('load', 'core:file.load-to-string', { 'pin:filename': file }),
          n('p', 'core:console.print')
        ],
        connections: [w('s', 'execOut', 'save', 'execIn'), w('save', 'execOut', 'load', 'execIn'), w('load', 'execOut', 'p', 'execIn'), w('load', 'returnValue', 'p', 'value')]
      }]
    };
  }

  test('Simulate', () => {
    const file = path.join(workDir, 'simulate.txt');
    const events: RuntimeLogEvent[] = [];
    new GraphRuntime(registry(), (e) => events.push(e)).run(fileGraph(file, 'javascript'));
    assert.deepEqual(events.filter((e) => e.kind === 'log').map((e) => e.message), ['saved: héllo']);
  });

  for (const target of [...TARGETS, { label: 'C# (through Run)', language: 'csharp', moduleFormat: undefined }]) {
    test(target.label, async (t) => {
      const dir = path.join(workDir, `files-${target.language}-${target.moduleFormat ?? 'default'}`);
      fs.mkdirSync(dir, { recursive: true });
      const result = compileDocument(fileGraph(path.join(dir, 'out.txt'), target.language), { registry: registry(), languages, generate: { sourceFileName: 'files.vgraph', moduleFormat: target.moduleFormat } });
      assert.deepEqual(result.diagnostics, []);
      const file = path.join(dir, result.output!.fileName);
      fs.writeFileSync(file, result.output!.text);
      let outcome;
      try {
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, result.output!.className, { cwd: dir, timeoutMs: 180000 });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), ['saved: héllo'], `stderr:\n${outcome.stderr}`);
    });
  }
});
