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
import { GenerateOptions } from '../../src/core/language-pack';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, NodeDefinition, RuntimeLogEvent } from '../../src/core/model';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { GraphRuntime } from '../../src/core/runtime';
import { parseDocument } from '../../src/core/serializer';
import { ToolNotFoundError, runGeneratedCode } from '../../src/extension/runner';

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
  const MODULES: Record<string, { path: string; text: string }> = {
    typescript: {
      path: 'lib/score.ts',
      text: 'let total = 0;\nexport function addToTotal(amount: number): number {\n  total += amount;\n  return total;\n}\nexport function double(value: number): number {\n  return value * 2;\n}\n'
    },
    'javascript-esm': {
      path: 'lib/score.mjs',
      text: 'let total = 0;\n/** @param {number} amount @returns {number} */\nexport function addToTotal(amount) {\n  total += amount;\n  return total;\n}\n/** @param {number} value @returns {number} */\nexport function double(value) {\n  return value * 2;\n}\n'
    },
    'javascript-commonjs': {
      path: 'lib/score.cjs',
      text: 'let total = 0;\n/** @param {number} amount @returns {number} */\nfunction addToTotal(amount) {\n  total += amount;\n  return total;\n}\n/** @param {number} value @returns {number} */\nfunction double(value) {\n  return value * 2;\n}\nmodule.exports = { addToTotal, double };\n'
    },
    // Next to the generated file: its folder is the working directory, so it is on sys.path.
    python: {
      path: 'graphs/score.py',
      text: 'total = 0\n\n\ndef add_to_total(amount: float) -> float:\n    global total\n    total += amount\n    return total\n\n\ndef double(value: float) -> float:\n    return value * 2\n'
    }
  };

  function project(language: string, key: string): { registry: NodeRegistry; document: GraphDocument } {
    const modulePath = MODULES[key].path;
    const fn = (name: string, pure: boolean): NodeDefinition => ({
      type: `fn:${language}:${modulePath}#${name}`, version: 1, displayName: name, category: 'Project',
      inputs: [
        ...(pure ? [] : [{ id: 'execIn', name: '', kind: 'exec' as const, direction: 'input' as const }]),
        { id: 'value', name: 'Value', kind: 'data', direction: 'input', type: { id: 'float' } }
      ],
      outputs: [
        ...(pure ? [] : [{ id: 'execOut', name: '', kind: 'exec' as const, direction: 'output' as const }]),
        { id: 'returnValue', name: 'Return Value', kind: 'data', direction: 'output', type: { id: 'float' } }
      ],
      implementation: { kind: 'function', language, path: modulePath, name, ...(language === 'python' ? { module: 'score' } : {}) }
    });
    const add = fn(language === 'python' ? 'add_to_total' : 'addToTotal', false);
    const double = fn('double', true);
    const r = registry();
    r.registerMany([add, double]);
    const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
    const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}`, fromNode, fromPin, toNode, toPin });
    const document: GraphDocument = {
      schemaVersion: 3, name: 'Score', kind: 'class', language, variables: [],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          n('s', 'core:event.start'), n('a1', add.type, { 'pin:value': 5 }), n('d', double.type), n('p1', 'core:console.print'),
          n('a2', add.type, { 'pin:value': 7 }), n('p2', 'core:console.print')
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
  function build(language: string, key: string, generate: Partial<GenerateOptions> = {}): { file: string; className: string; dir: string } {
    const { registry: r, document } = project(language, key);
    const dir = path.join(workDir, `project-${key}`);
    const module = MODULES[key];
    fs.mkdirSync(path.join(dir, path.dirname(module.path)), { recursive: true });
    fs.mkdirSync(path.join(dir, 'graphs'), { recursive: true });
    fs.writeFileSync(path.join(dir, module.path), module.text);
    const result = compileDocument(document, { registry: r, languages, generate: { sourceFileName: 'score.vgraph', outputDir: 'graphs', ...generate } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'graphs', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    return { file, className: result.output!.className, dir };
  }

  test('Simulate stops at the first project function', () => {
    const { registry: r, document } = project('typescript', 'typescript');
    const events: RuntimeLogEvent[] = [];
    new GraphRuntime(r, (e) => events.push(e)).run(document);
    assert.equal(events.find((e) => e.kind === 'error')?.nodeId, 'a1');
  });

  for (const target of [
    { label: 'TypeScript', language: 'typescript', key: 'typescript' },
    { label: 'JavaScript (ES modules)', language: 'javascript', key: 'javascript-esm', moduleFormat: 'esm' as const },
    { label: 'JavaScript (CommonJS)', language: 'javascript', key: 'javascript-commonjs', moduleFormat: 'commonjs' as const },
    { label: 'Python', language: 'python', key: 'python' }
  ]) {
    test(`${target.label} imports and calls them`, async (t) => {
      const { file, className, dir } = build(target.language, target.key, { moduleFormat: target.moduleFormat });
      let outcome;
      try {
        outcome = await runGeneratedCode(languages.get(target.language)!.generator!.runner!, file, className, { cwd: path.join(dir, 'graphs'), timeoutMs: 30000 });
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
