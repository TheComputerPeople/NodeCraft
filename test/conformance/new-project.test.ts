// New Project (docs/project-integration.md, part 4) in each of the 12 languages: the project it
// writes compiles its graph without warnings, declares versions the project model reads back without
// a warning, marks its generated files in .gitattributes, passes its checkers and runs from its own
// entry point, printing "Hello from Blueprint". A tool that isn't installed is skipped, by name, as
// in the corpus; with BLUEPRINT_CORPUS_REQUIRE_TOOLS set it fails.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { builtinLanguagePacks } from '../../src/core/languages';
import { HELLO, createProject, detectToolVersion, newProjectFiles, projectNames } from '../../src/extension/new-project';
import { projectVersionCheck } from '../../src/extension/projects';
import { CorpusStep, PYTHON, corpusWorkDir, runSteps } from './corpus';

const workDir = corpusWorkDir();
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const requireTools = !!process.env.BLUEPRINT_CORPUS_REQUIRE_TOOLS;

const NAME = 'Hello Game';
const names = projectNames(NAME);
const exe = (file: string) => `./${file}${process.platform === 'win32' ? '.exe' : ''}`;
const GODOT = process.env.GODOT ?? 'godot';
const run = (command: string[], extra: Partial<CorpusStep> = {}): CorpusStep => ({ name: 'run', command, stdout: [HELLO], ...extra });

// Each language's checkers, then its entry point.
const STEPS: Record<string, CorpusStep[]> = {
  typescript: [{ name: 'tsc', command: ['node_modules/typescript/bin/tsc', '-p', '.'], check: true }, run(['node', 'src/main.ts'])],
  javascript: [run(['node', 'src/main.js'])],
  python: [
    { name: 'mypy --strict', command: [PYTHON, '-m', 'mypy', '--strict', 'src'], probe: [PYTHON, '-m', 'mypy', '--version'], check: true },
    run([PYTHON, '-m', names.snake], { env: { PYTHONPATH: 'src' } })
  ],
  csharp: [
    { name: 'dotnet build', command: ['dotnet', 'build', '-warnaserror', '-nologo', '-nodeReuse:false', '-p:UseSharedCompilation=false'], probe: ['dotnet', '--version'] },
    run(['dotnet', 'run', '--no-build'], { probe: ['dotnet', '--version'] })
  ],
  cpp: [
    { name: 'cmake', command: ['cmake', '-S', '.', '-B', 'build', ...(process.platform === 'win32' ? ['-G', 'MinGW Makefiles'] : []), '-DCMAKE_CXX_COMPILER=g++', '-DCMAKE_CXX_FLAGS=-Wall -Wextra -Werror'], probe: ['cmake', '--version'] },
    { name: 'cmake --build', command: ['cmake', '--build', 'build'], probe: ['cmake', '--version'] },
    run([exe(`build/${names.snake}`)], { probe: ['cmake', '--version'] })
  ],
  rust: [
    { name: 'cargo clippy', command: ['cargo', 'clippy', '--', '-D', 'warnings'], probe: ['cargo', '--version'], env: { CARGO_TERM_COLOR: 'never' } },
    { name: 'cargo fmt --check', command: ['cargo', 'fmt', '--check'], probe: ['cargo', 'fmt', '--version'], check: true },
    run(['cargo', 'run', '--quiet'], { probe: ['cargo', '--version'] })
  ],
  java: [
    { name: 'mvn compile', command: ['mvn', '-q', '-o', '-B', 'compile'], probe: ['mvn', '-v'] },
    run(['java', '-cp', 'target/classes', `${names.lower}.App`], { probe: ['java', '-version'] })
  ],
  go: [
    { name: 'go vet', command: ['go', 'vet', './...'], probe: ['go', 'version'], env: { GOTOOLCHAIN: 'local', GOWORK: 'off' } },
    run(['go', 'run', '.'], { probe: ['go', 'version'], env: { GOTOOLCHAIN: 'local', GOWORK: 'off' } })
  ],
  lua: [run(['lua', 'main.lua'], { probe: ['lua', '-v'], quiet: true })],
  gdscript: [
    { name: 'godot --import', command: [GODOT, '--headless', '--path', '.', '--import'], probe: [GODOT, '--version'], timeoutMs: 300000 },
    run([GODOT, '--headless', '--no-header', '--path', '.'], { probe: [GODOT, '--version'], timeoutMs: 120000 })
  ],
  ruby: [run(['ruby', '-w', 'lib/main.rb'], { probe: ['ruby', '--version'], quiet: true })],
  php: [
    { name: 'PHPStan (level 9)', command: ['phar/phpstan.phar', 'analyse', '--level=9', '--no-progress', 'src', 'bin'], env: { XDEBUG_MODE: 'off' }, check: true },
    run(['php', '-d', 'error_reporting=-1', '-d', 'display_errors=stderr', 'bin/main.php'], { probe: ['php', '--version'], env: { XDEBUG_MODE: 'off' }, quiet: true })
  ]
};
// Java with Gradle, as New Project makes it when Gradle is on the PATH and Maven isn't.
const GRADLE: CorpusStep[] = [run(['gradle', '--no-daemon', '-q', '--offline', 'run'], { probe: ['gradle', '-v'], timeoutMs: 900000 })];

describe('New Project', () => {
  test('every built-in language has a layout and steps', () => {
    assert.deepEqual(builtinLanguagePacks().all().map((p) => p.id).filter((id) => !STEPS[id]), []);
  });

  test('versions: what generated code needs, or the installed toolchain\'s when newer', () => {
    assert.match(newProjectFiles('csharp', NAME).files['HelloGame.csproj'], /<TargetFramework>net8\.0</);
    assert.match(newProjectFiles('csharp', NAME, { toolVersion: '10.0.100' }).files['HelloGame.csproj'], /<TargetFramework>net10\.0</);
    assert.match(newProjectFiles('java', NAME, { toolVersion: '11.0.2' }).files['pom.xml'], /<maven\.compiler\.release>17</, 'older than needed: what generated code needs');
    assert.match(newProjectFiles('go', NAME, { toolVersion: '1.24.3' }).files['go.mod'], /^go 1\.24$/m);
    assert.equal(newProjectFiles('ruby', NAME, { toolVersion: '4.0.9' }).files['.ruby-version'], '4.0.9\n');
  });

  test('.gitattributes marks each language\'s generated files', () => {
    assert.match(newProjectFiles('python', NAME).files['.gitattributes'], /^\*_vgraph\.py linguist-generated$/m);
    assert.match(newProjectFiles('typescript', NAME).files['.gitattributes'], /^\*\.vgraph\.\* linguist-generated$/m);
    assert.match(newProjectFiles('cpp', NAME).files['.gitattributes'], /^vgraph\.cmake linguist-generated$/m);
  });

  const cases = [...Object.keys(STEPS).map((language) => ({ language, java: undefined as 'gradle' | undefined })), { language: 'java', java: 'gradle' as const }];
  for (const { language, java } of cases) {
    test(`${language}${java ? ` (${java})` : ''}: it builds, passes its checkers and runs`, { concurrency: true }, async (t) => {
      const folder = path.join(workDir, `${language}${java ? `-${java}` : ''}`);
      const toolVersion = await detectToolVersion(language);
      const { graph, project, diagnostics } = await createProject(folder, language, NAME, { toolVersion, ...(java ? { javaBuild: java } : {}) });
      assert.deepEqual(diagnostics, [], 'the graph compiles without warnings');
      assert.ok(fs.existsSync(graph));
      const pack = builtinLanguagePacks().get(language)!;
      assert.equal(projectVersionCheck(pack, path.dirname(graph), folder)?.diagnostics.length ?? 0, 0, 'the project declares a version generated code works with');
      const output = pack.generator!.outputFileName('Main.vgraph');
      assert.ok(fs.readdirSync(path.dirname(graph)).includes(output), `${output} is next to the graph`);
      assert.ok(project.files['README.md'].includes(project.run));
      const results = await runSteps(java ? GRADLE : STEPS[language], folder);
      for (const step of results) t.diagnostic(step.status === 'skipped' ? `skipped: ${step.message}` : `${step.step}: ${step.status}`);
      const failed = results.filter((s) => s.status === 'failed');
      assert.deepEqual(failed.map((s) => s.step), [], failed.map((s) => s.message).join('\n\n'));
      const skipped = results.filter((s) => s.status === 'skipped');
      if (requireTools) assert.deepEqual(skipped.map((s) => s.message), [], 'BLUEPRINT_CORPUS_REQUIRE_TOOLS: every tool is installed');
      if (skipped.length === results.length) t.skip(skipped.map((s) => s.message).join('; '));
      else if (skipped.length) t.todo(`partly checked: ${skipped.map((s) => s.message).join('; ')}`);
    });
  }
});
