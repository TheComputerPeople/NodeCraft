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
