// The corpus of project layouts (docs/project-integration.md, part 3): in each, graphs a user would
// write compile into the project, which builds, passes its own type checkers and linters, and runs
// from its own entry point, calling the generated code that calls its code. A tool that isn't
// installed is reported as skipped, by name (npm run corpus:tools installs the Node.js ones).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { CorpusStep, Layout, PYTHON, corpusWorkDir, greetingLibrary, runLayout } from './corpus';

const workDir = corpusWorkDir();
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

const HELLO = ['Hello, Ada!'];
const tsc = (project = '.'): CorpusStep => ({ name: 'tsc', command: ['node_modules/typescript/bin/tsc', '-p', project] });
const eslint: CorpusStep = { name: 'ESLint', command: ['node_modules/eslint/bin/eslint.js', '.'] };
const python = (name: string, ...args: string[]): CorpusStep => ({ name, command: [PYTHON, '-m', ...args], probe: [PYTHON, '-m', args[0], '--version'] });
// dotnet without the build servers that outlive the build.
const dotnet = (...args: string[]): string[] => ['dotnet', ...args, '-nologo', '-nodeReuse:false', '-p:UseSharedCompilation=false'];

export const LAYOUTS: Layout[] = [
  // ---- TypeScript ----
  {
    name: 'ts-vite-app', language: 'typescript', code: ['src/text/format.ts'], body: 'src/blueprint',
    graphs: [{ path: 'src/graphs/Greeting.vgraph', build: (code) => greetingLibrary(code('title')) }],
    steps: [tsc(), eslint, { name: 'run', command: ['node', 'src/main.ts'], stdout: HELLO }]
  },
  {
    name: 'ts-node-library', language: 'typescript', code: ['src/text/format.ts'], body: 'src/blueprint',
    graphs: [{ path: 'src/graphs/Greeting.vgraph', build: (code) => greetingLibrary(code('title')) }],
    steps: [tsc(), { name: 'run', command: ['node', 'dist/index.js'], stdout: HELLO }]
  },
  {
    name: 'ts-pnpm-monorepo', language: 'typescript', code: ['packages/shared/src/text.ts'],
    graphs: [{ path: 'packages/app/src/graphs/Greeting.vgraph', build: (code) => greetingLibrary(code('title')) }],
    steps: [
      { name: 'pnpm install', command: ['pnpm', 'install', '--offline', '--silent'] },
      tsc('packages/shared'), tsc('packages/app'),
      { name: 'run', command: ['node', 'packages/app/src/main.ts'], stdout: [...HELLO, 'From the app'] }
    ]
  },
  // ---- JavaScript ----
  {
    name: 'js-commonjs', language: 'javascript', code: ['lib/format.js'],
    graphs: [{ path: 'src/graphs/Greeting.vgraph', build: (code) => greetingLibrary(code('title')) }],
    steps: [tsc('jsconfig.json'), eslint, { name: 'run', command: ['node', 'src/index.js'], stdout: HELLO }]
  },
  {
    name: 'js-esm', language: 'javascript', code: ['lib/format.js'], body: 'src/blueprint',
    graphs: [{ path: 'src/graphs/Greeting.vgraph', build: (code) => greetingLibrary(code('title')) }],
    steps: [tsc('jsconfig.json'), eslint, { name: 'run', command: ['node', 'src/index.js'], stdout: HELLO }]
  },
  // ---- Python ----
  {
    name: 'py-src-layout', language: 'python', code: ['src/corpus_game/text.py'], body: 'src/corpus_game/blueprint',
    graphs: [{ path: 'src/corpus_game/graphs/Greeting.vgraph', build: (code) => greetingLibrary(code('title')) }],
    steps: [
      python('mypy --strict', 'mypy'), python('Pyright (strict)', 'pyright'), python('Ruff', 'ruff', 'check', '.'),
      { name: 'run', command: [PYTHON, '-m', 'corpus_game'], env: { PYTHONPATH: 'src' }, stdout: HELLO }
    ]
  },
  {
    name: 'py-scripts', language: 'python', code: ['scripts/score.py'],
    graphs: [{ path: 'scripts/Greeting.vgraph', build: (code) => greetingLibrary(code('title')) }],
    steps: [
      python('mypy --strict', 'mypy', 'scripts/main.py', 'scripts/greeting_vgraph.py', 'scripts/score.py'), python('Ruff', 'ruff', 'check', '.'),
      { name: 'run', command: [PYTHON, 'scripts/main.py'], stdout: HELLO }
    ]
  },
  {
    name: 'py-django-shaped', language: 'python', code: ['game/services.py'],
    graphs: [{ path: 'game/graphs/Greeting.vgraph', build: (code) => greetingLibrary(code('title')) }],
    steps: [python('mypy --strict', 'mypy', '.'), { name: 'run', command: [PYTHON, 'manage.py', 'greet', 'ada'], stdout: HELLO }]
  },
  // ---- C# ----
  {
    name: 'cs-console', language: 'csharp', code: ['Names.cs'], body: 'Blueprint',
    graphs: [{ path: 'Graphs/Greeting.vgraph', build: (code) => greetingLibrary(code('Title')) }],
    steps: [
      { name: 'dotnet build', command: dotnet('build'), probe: ['dotnet', '--version'] },
      { name: 'run', command: ['dotnet', 'run', '--no-build'], probe: ['dotnet', '--version'], stdout: HELLO }
    ]
  },
  {
    name: 'cs-solution', language: 'csharp', code: ['src/Corpus.Core/Text.cs'],
    graphs: [{ path: 'src/Corpus.App/Graphs/Greeting.vgraph', build: (code) => greetingLibrary(code('Title')) }],
    steps: [
      { name: 'dotnet build', command: dotnet('build', 'Corpus.sln'), probe: ['dotnet', '--version'] },
      { name: 'run', command: ['dotnet', 'run', '--no-build', '--project', 'src/Corpus.App'], probe: ['dotnet', '--version'], stdout: HELLO }
    ]
  },
  // ---- Java ----
  {
    name: 'java-maven', language: 'java', code: ['src/main/java/corpus/game/Text.java'], body: 'src/main/java/corpus/game/blueprint',
    graphs: [{ path: 'src/main/java/corpus/game/graphs/Greeting.vgraph', build: (code) => greetingLibrary(code('title')) }],
    steps: [
      { name: 'mvn compile', command: ['mvn', '-q', '-o', '-B', 'compile'], probe: ['mvn', '-v'] },
      { name: 'run', command: ['java', '-cp', 'target/classes', 'corpus.game.Main'], probe: ['java', '-version'], stdout: HELLO }
    ]
  },
  {
    name: 'java-gradle-multi', language: 'java', code: ['core/src/main/java/corpus/core/Text.java'],
    graphs: [{ path: 'app/src/main/java/corpus/app/graphs/Greeting.vgraph', build: (code) => greetingLibrary(code('title')) }],
    steps: [{ name: 'gradle build and run', command: ['gradle', '--no-daemon', '-q', '--offline', 'build', ':app:run'], probe: ['gradle', '-v'], stdout: HELLO, timeoutMs: 900000 }]
  }
];

describe('the corpus of project layouts', { concurrency: 4 }, () => {
  for (const layout of LAYOUTS) {
    test(`${layout.name} (${layout.language})`, async (t) => {
      const result = await runLayout(layout, workDir);
      assert.deepEqual(result.compileErrors, [], 'every graph compiles');
      if (layout.body) assert.ok(result.generated.some((f) => f.startsWith(`${layout.body}/audit/`)), 'the node audit is in the project');
      for (const step of result.steps) t.diagnostic(step.status === 'skipped' ? `skipped: ${step.message}` : `${step.step}: ${step.status}`);
      const failed = result.steps.filter((s) => s.status === 'failed');
      assert.deepEqual(failed.map((s) => s.step), [], failed.map((s) => s.message).join('\n\n'));
      if (result.steps.every((s) => s.status === 'skipped')) t.skip(result.steps.map((s) => s.message).join('; '));
    });
  }
});
