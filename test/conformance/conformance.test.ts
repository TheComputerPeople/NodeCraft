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
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, RuntimeLogEvent } from '../../src/core/model';
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
