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
    return exposeFunctions(importer.scan(MODULES[key].text), { language, path: MODULES[key].path, module, exposeAll: false }).definitions;
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

  // The library's nodes as the workspace service makes them, for a library compiled into lib/.
  function definitions(language: string): NodeDefinition[] {
    const lib = library(language);
    const generator = languages.get(language)!.generator!;
    const generated = `lib/${generator.outputFileName('MathTools.vgraph')}`;
    return libraryDefinitions(lib, {
      documentPath: 'lib/MathTools.vgraph',
      generatedPath: generated,
      exports: generator.libraryExports(lib.name, lib.graphs.map((g) => ({ id: g.id, name: g.name }))),
      module: language === 'python' ? 'math_tools_vgraph' : language === 'csharp' ? 'Lib' : undefined
    });
  }

  // Start → Difference And Product(10, 4) → Print(Difference) → Print(Scale(Product)).
  function caller(language: string): { registry: NodeRegistry; document: GraphDocument } {
    const defs = definitions(language);
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

  test('the library makes a node per function', () => {
    const defs = definitions('typescript');
    assert.deepEqual(defs.map((d) => [d.type, d.displayName, d.category]), [
      ['fn:typescript:lib/MathTools.vgraph.ts#differenceAndProduct', 'Difference And Product', 'MathTools'],
      ['fn:typescript:lib/MathTools.vgraph.ts#scale', 'Scale', 'MathTools']
    ]);
    assert.deepEqual(defs[1].inputs.map((p) => [p.id, p.defaultValue]), [['value', undefined], ['factor', 2]]);
    assert.ok(defs[0].inputs.some((p) => p.kind === 'exec') && !defs[1].inputs.some((p) => p.kind === 'exec'));
    assert.deepEqual(definitions('csharp').map((d) => d.type), [
      'fn:csharp:lib/MathTools.vgraph.cs#Lib.MathTools.DifferenceAndProduct',
      'fn:csharp:lib/MathTools.vgraph.cs#Lib.MathTools.Scale'
    ]);
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

  // Compiles the library into lib/ and the caller into graphs/.
  function build(key: string, language: string, generate: Partial<GenerateOptions> = {}): { file: string; className: string; dir: string; libFile: string; importRoots?: string[] } {
    const dir = path.join(workDir, `library-${key}`);
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'graphs'), { recursive: true });
    const lib = compileDocument(library(language), { registry: registry(), languages, generate: { sourceFileName: 'MathTools.vgraph', outputDir: 'lib', namespace: 'Lib', ...generate } });
    assert.deepEqual(lib.diagnostics, []);
    const libFile = path.join(dir, 'lib', lib.output!.fileName);
    fs.writeFileSync(libFile, lib.output!.text);
    const { registry: r, document } = caller(language);
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
          n('eq', `${TEAM}.equal`, { 'pin:b': 'green' }), n('p5', 'core:console.print')
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
          w('isBlue', 'execOut', 'p5', 'execIn'), w('break', 'team', 'eq', 'a'), w('eq', 'returnValue', 'p5', 'value')
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
    'false'
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
