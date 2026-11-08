// The corpus of project layouts (docs/project-integration.md, part 3): in each, graphs a user would
// write compile into the project, which builds, passes its own type checkers and linters, runs its
// tests and runs from its own entry point, calling the generated code that calls its code. A tool
// that isn't installed is skipped, by name (npm run corpus:tools installs the Node.js ones): a layout
// that skipped some of its steps is reported as todo, not passed, and with
// BLUEPRINT_CORPUS_REQUIRE_TOOLS set (a machine that should have every tool) it fails.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { CorpusGraph, CorpusStep, FEATURES_OUTPUT, Layout, PYTHON, corpusWorkDir, featureGraphs, greetingLibrary, greetingTests, runLayout, sharedScore, showScore } from './corpus';

const workDir = corpusWorkDir();
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const requireTools = !!process.env.BLUEPRINT_CORPUS_REQUIRE_TOOLS;

const HELLO = ['Hello, Ada!'];
const tsc = (project = '.'): CorpusStep => ({ name: 'tsc', command: ['node_modules/typescript/bin/tsc', '-p', project] });
const eslint: CorpusStep = { name: 'ESLint', command: ['node_modules/eslint/bin/eslint.js', '.'] };
// Node.js's test runner on a generated test file, which has one passing test.
const nodeTest = (file: string): CorpusStep => ({ name: 'node --test', command: ['node', '--test', '--test-reporter=tap', file], includes: ['# pass 1', '# fail 0'] });
const python = (name: string, ...args: string[]): CorpusStep => ({ name, command: [PYTHON, '-m', ...args], probe: [PYTHON, '-m', args[0], '--version'] });
// dotnet without the build servers that outlive the build.
const dotnet = (...args: string[]): string[] => ['dotnet', ...args, '-nologo', '-nodeReuse:false', '-p:UseSharedCompilation=false'];
// The Greeting library at `file`, calling the project's `title` function.
const greeting = (file: string, title: string): CorpusGraph => ({ path: file, build: ({ code }) => greetingLibrary(code(title)) });

export const LAYOUTS: Layout[] = [
  // ---- TypeScript ----
  {
    // A browser app: no Node.js types, so the generated test file must type-check without them.
    name: 'ts-vite-app', language: 'typescript', code: ['src/text/format.ts', 'src/game/features.ts'], body: 'src/blueprint',
    graphs: [greeting('src/graphs/Greeting.vgraph', 'title'), greetingTests('src/graphs/Greeting.vgraph'), ...featureGraphs('src/graphs', 'typescript')],
    steps: [tsc(), eslint, nodeTest('src/graphs/GreetingTests.vgraph.test.ts'), { name: 'run', command: ['node', 'src/main.ts'], stdout: [...HELLO, ...FEATURES_OUTPUT] }]
  },
  {
    name: 'ts-node-library', language: 'typescript', code: ['src/text/format.ts'],
    graphs: [greeting('src/graphs/Greeting.vgraph', 'title')],
    steps: [tsc(), { name: 'run', command: ['node', 'dist/index.js'], stdout: HELLO }]
  },
  {
    name: 'ts-pnpm-monorepo', language: 'typescript', code: ['packages/shared/src/text.ts'],
    graphs: [greeting('packages/app/src/graphs/Greeting.vgraph', 'title')],
    steps: [
      { name: 'pnpm install', command: ['pnpm', 'install', '--offline', '--silent'] },
      tsc('packages/shared'), tsc('packages/app'),
      { name: 'run', command: ['node', 'packages/app/src/main.ts'], stdout: [...HELLO, 'From the app'] }
    ]
  },
  // ---- JavaScript ----
  {
    name: 'js-commonjs', language: 'javascript', code: ['lib/format.js'],
    graphs: [greeting('src/graphs/Greeting.vgraph', 'title')],
    steps: [tsc('jsconfig.json'), eslint, { name: 'run', command: ['node', 'src/index.js'], stdout: HELLO }]
  },
  {
    name: 'js-esm', language: 'javascript', code: ['lib/format.js', 'lib/features.js'], body: 'src/blueprint',
    graphs: [greeting('src/graphs/Greeting.vgraph', 'title'), greetingTests('src/graphs/Greeting.vgraph'), ...featureGraphs('src/graphs', 'javascript')],
    steps: [tsc('jsconfig.json'), eslint, nodeTest('src/graphs/GreetingTests.vgraph.test.js'), { name: 'run', command: ['node', 'src/index.js'], stdout: [...HELLO, ...FEATURES_OUTPUT] }]
  },
  // ---- Two languages ----
  {
    // A struct shared by a TypeScript web app and a Python API, each with a graph that uses it.
    name: 'ts-py-shared', language: 'typescript', code: [],
    graphs: [sharedScore('shared/Score.vgraph', 'typescript', 'python'), showScore('web/src/graphs/ShowScore.vgraph', 'typescript'), showScore('api/graphs/ShowScore.vgraph', 'python')],
    steps: [
      tsc('web'),
      python('mypy --strict', 'mypy', '--strict', 'api', 'shared'),
      { name: 'run (web)', command: ['node', 'web/src/main.ts'], stdout: ['{"Name":"ada","Points":3}'] },
      { name: 'run (api)', command: [PYTHON, '-m', 'api.main'], stdout: ['{"Name":"ada","Points":3}'] }
    ]
  },
  // ---- Python ----
  {
    name: 'py-src-layout', language: 'python', code: ['src/corpus_game/text.py', 'src/corpus_game/features.py'], body: 'src/corpus_game/blueprint',
    graphs: [greeting('src/corpus_game/graphs/Greeting.vgraph', 'title'), greetingTests('src/corpus_game/graphs/Greeting.vgraph'), ...featureGraphs('src/corpus_game/graphs', 'python')],
    steps: [
      python('mypy --strict', 'mypy'), python('Pyright (strict)', 'pyright'), python('Ruff', 'ruff', 'check', '.'),
      { name: 'unittest', command: [PYTHON, '-m', 'unittest', 'discover', '-v', '-s', 'src/corpus_game/graphs', '-t', 'src'], env: { PYTHONPATH: 'src' }, includes: ['Ran 1 test', 'OK'] },
      { name: 'run', command: [PYTHON, '-m', 'corpus_game'], env: { PYTHONPATH: 'src' }, stdout: [...HELLO, ...FEATURES_OUTPUT] }
    ]
  },
  {
    name: 'py-scripts', language: 'python', code: ['scripts/score.py'],
    graphs: [greeting('scripts/Greeting.vgraph', 'title')],
    steps: [
      python('mypy --strict', 'mypy', 'scripts/main.py', 'scripts/greeting_vgraph.py', 'scripts/score.py'), python('Ruff', 'ruff', 'check', '.'),
      { name: 'run', command: [PYTHON, 'scripts/main.py'], stdout: HELLO }
    ]
  },
  {
    name: 'py-django-shaped', language: 'python', code: ['game/services.py'],
    graphs: [greeting('game/graphs/Greeting.vgraph', 'title')],
    steps: [python('mypy --strict', 'mypy', '.'), { name: 'run', command: [PYTHON, 'manage.py', 'greet', 'ada'], stdout: HELLO }]
  },
  // ---- C# ----
  {
    name: 'cs-console', language: 'csharp', code: ['Names.cs', 'Features.cs'], body: 'Blueprint',
    graphs: [greeting('Graphs/Greeting.vgraph', 'Title'), ...featureGraphs('Graphs', 'csharp')],
    steps: [
      { name: 'dotnet build', command: dotnet('build'), probe: ['dotnet', '--version'] },
      { name: 'run', command: ['dotnet', 'run', '--no-build'], probe: ['dotnet', '--version'], stdout: [...HELLO, ...FEATURES_OUTPUT] }
    ]
  },
  {
    name: 'cs-solution', language: 'csharp', code: ['src/Corpus.Core/Text.cs'],
    graphs: [greeting('src/Corpus.App/Graphs/Greeting.vgraph', 'Title')],
    steps: [
      { name: 'dotnet build', command: dotnet('build', 'Corpus.sln'), probe: ['dotnet', '--version'] },
      { name: 'run', command: ['dotnet', 'run', '--no-build', '--project', 'src/Corpus.App'], probe: ['dotnet', '--version'], stdout: HELLO }
    ]
  },
  // ---- Java ----
  {
    name: 'java-maven', language: 'java', body: 'src/main/java/corpus/game/blueprint',
    code: ['src/main/java/corpus/game/Text.java', 'src/main/java/corpus/game/Calculations.java', 'src/main/java/corpus/game/count/Counter.java', 'src/main/java/corpus/game/count/BigCounter.java'],
    graphs: [greeting('src/main/java/corpus/game/graphs/Greeting.vgraph', 'title'), ...featureGraphs('src/main/java/corpus/game/graphs', 'java')],
    steps: [
      { name: 'mvn compile', command: ['mvn', '-q', '-o', '-B', 'compile'], probe: ['mvn', '-v'] },
      { name: 'run', command: ['java', '-cp', 'target/classes', 'corpus.game.Main'], probe: ['java', '-version'], stdout: [...HELLO, ...FEATURES_OUTPUT] }
    ]
  },
  {
    name: 'java-gradle-multi', language: 'java', code: ['core/src/main/java/corpus/core/Text.java'],
    graphs: [greeting('app/src/main/java/corpus/app/graphs/Greeting.vgraph', 'title')],
    steps: [{ name: 'gradle build and run', command: ['gradle', '--no-daemon', '-q', '--offline', 'build', ':app:run'], probe: ['gradle', '-v'], stdout: HELLO, timeoutMs: 900000 }]
  }
];

describe('the corpus of project layouts', { concurrency: 4 }, () => {
  for (const layout of LAYOUTS) {
    test(`${layout.name} (${layout.language})`, async (t) => {
      const result = await runLayout(layout, workDir);
      assert.deepEqual(result.compileErrors, [], 'every graph compiles');
      assert.deepEqual(result.warnings, [], 'and without warnings: placement, the project, the build registration');
      if (layout.body) assert.ok(result.generated.some((f) => f.startsWith(`${layout.body}/audit/`)), 'the node audit is in the project');
      for (const step of result.steps) t.diagnostic(step.status === 'skipped' ? `skipped: ${step.message}` : `${step.step}: ${step.status}`);
      const failed = result.steps.filter((s) => s.status === 'failed');
      assert.deepEqual(failed.map((s) => s.step), [], failed.map((s) => s.message).join('\n\n'));
      const skipped = result.steps.filter((s) => s.status === 'skipped');
      if (requireTools) assert.deepEqual(skipped.map((s) => s.message), [], 'BLUEPRINT_CORPUS_REQUIRE_TOOLS: every tool is installed');
      if (skipped.length === result.steps.length) t.skip(skipped.map((s) => s.message).join('; '));
      else if (skipped.length) t.todo(`partly checked: ${skipped.map((s) => s.message).join('; ')}`);
    });
  }
});
