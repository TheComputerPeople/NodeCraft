// The corpus's layouts (docs/project-integration.md, part 3; run by corpus.test.ts): each a folder of
// test/fixtures/projects, the graphs a user would put in it, and the project's own build, checkers,
// tests and entry point.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { GraphDocument } from '../../src/core/model';
import { CorpusGraph, CorpusStep, Feature, Layout, PYTHON, featureGraphs, featuresOutput, greetingLibrary, greetingTests, sharedScore, showScore } from './corpus';

const HELLO = ['Hello, Ada!'];
const tsc = (project = '.'): CorpusStep => ({ name: 'tsc', command: ['node_modules/typescript/bin/tsc', '-p', project] });
const eslint: CorpusStep = { name: 'ESLint', command: ['node_modules/eslint/bin/eslint.js', '.'], check: true };
// Node.js's test runner on a generated test file, which has one passing test.
const nodeTest = (file: string): CorpusStep => ({ name: 'node --test', command: ['node', '--test', '--test-reporter=tap', file], includes: ['# pass 1', '# fail 0'] });
const python = (name: string, ...args: string[]): CorpusStep => ({ name, command: [PYTHON, '-m', ...args], probe: [PYTHON, '-m', args[0], '--version'], check: true });
// dotnet without the build servers that outlive the build.
const dotnet = (...args: string[]): string[] => ['dotnet', ...args, '-nologo', '-nodeReuse:false', '-p:UseSharedCompilation=false'];
// The Greeting library at `file`, calling the project's `title` function.
const greeting = (file: string, title: string): CorpusGraph => ({ path: file, build: ({ code }) => greetingLibrary(code(title)) });
// Go with the installed toolchain, the module's own requirements, and no go.work from above.
const GO_ENV = { GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod', GOWORK: 'off' };
const go = (...args: string[]): CorpusStep => ({ name: `go ${args[0]}`, command: ['go', ...args], probe: ['go', 'version'], env: GO_ENV });
// In a go.work, which takes no -mod flag.
const GO_WORK_ENV = { GOTOOLCHAIN: 'local' };
const cargo = (...args: string[]): CorpusStep => ({ name: `cargo ${args[0]}`, command: ['cargo', ...args], probe: ['cargo', '--version'], env: { CARGO_TERM_COLOR: 'never' } });
// CMake's Makefiles with MinGW's make on Windows, its default elsewhere; and a program's file.
const CMAKE_GENERATOR = process.platform === 'win32' ? ['-G', 'MinGW Makefiles'] : [];
const MAKE = process.platform === 'win32' ? 'mingw32-make' : 'make';
const exe = (file: string) => `./${file}${process.platform === 'win32' ? '.exe' : ''}`;
// Visual Studio's MSBuild, found by its installer's vswhere (Windows); elsewhere `msbuild` on the
// PATH, if any.
const MSBUILD = msbuildPath();
function msbuildPath(): string {
  if (process.platform !== 'win32') return 'msbuild';
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const found = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], { encoding: 'utf8', windowsHide: true });
  return found.status === 0 && found.stdout.trim() ? found.stdout.trim().split(/\r?\n/)[0] : 'msbuild';
}
// A class graph whose Start prints a project function's result.
function printCall(name: string, type: string, pins: Record<string, unknown>): GraphDocument {
  const n = (id: string, nodeType: string, properties: Record<string, unknown> = {}) => ({ id, type: nodeType, position: { x: 0, y: 0 }, properties });
  return {
    schemaVersion: 3, name, kind: 'class', language: '', variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [n('start', 'core:event.start'), n('call', type, pins), n('print', 'core:console.print')],
      connections: [
        { id: 'a', fromNode: 'start', fromPin: 'execOut', toNode: 'print', toPin: 'execIn' },
        { id: 'b', fromNode: 'call', fromPin: 'returnValue', toNode: 'print', toPin: 'value' }
      ]
    }]
  };
}
// C++ has no generics in its pack yet.
const CPP_FEATURES: Feature[] = ['classes', 'outputs', 'parents', 'latent'];
// PHP without Xdebug's messages; its tools from the corpus's tools (npm run corpus:tools). Composer
// only writes the autoloader, which the project's own entry point then loads.
const PHP_ENV = { XDEBUG_MODE: 'off' };
const composer: CorpusStep[] = [{ name: 'composer dump-autoload', command: ['phar/composer.phar', 'dump-autoload', '--no-interaction'], env: PHP_ENV }];
const phpstan: CorpusStep = { name: 'PHPStan (level 9)', command: ['phar/phpstan.phar', 'analyse', '--no-progress', '--memory-limit=2G'], env: PHP_ENV, check: true };
const phpcs: CorpusStep = { name: 'PHP_CodeSniffer', command: ['phar/phpcs.phar'], env: PHP_ENV, check: true };
// With every error, warning and deprecation reported, which must be none.
const php = (...args: string[]): CorpusStep => ({ name: 'run', command: ['php', '-d', 'error_reporting=-1', '-d', 'display_errors=stderr', ...args], probe: ['php', '--version'], env: PHP_ENV, quiet: true });
// Lua's linter on the project (the generated files mark themselves to be left alone), and Lua.
const luacheck: CorpusStep = { name: 'luacheck', command: ['luacheck', '.'], probe: ['luacheck', '--version'], check: true };
const LUA_PROBE = ['lua', '-v'];
// Godot: the GDScript tests' GODOT, else on the PATH. Its pack has classes and async functions.
const GODOT = process.env.GODOT ?? 'godot';
const GDSCRIPT_FEATURES: Feature[] = ['classes', 'parents', 'latent'];
// Ruby, Lua and PHP have no generics to speak of.
const DYNAMIC_FEATURES: Feature[] = ['classes', 'outputs', 'parents', 'latent'];
// Go has no generics in its pack yet, and neither it nor Rust has inheritance.
const GO_FEATURES: Feature[] = ['classes', 'outputs', 'latent'];
const RUST_FEATURES: Feature[] = ['classes', 'outputs', 'generics', 'latent'];

export const LAYOUTS: Layout[] = [
  // ---- TypeScript ----
  {
    // A browser app: no Node.js types, so the generated test file must type-check without them.
    name: 'ts-vite-app', language: 'typescript', code: ['src/text/format.ts', 'src/game/features.ts', 'src/game/actor.ts'], body: 'src/blueprint',
    graphs: [greeting('src/graphs/Greeting.vgraph', 'title'), greetingTests('src/graphs/Greeting.vgraph'), ...featureGraphs('src/graphs', 'typescript')],
    steps: [tsc(), eslint, nodeTest('src/graphs/GreetingTests.vgraph.test.ts'), { name: 'run', command: ['node', 'src/main.ts'], stdout: [...HELLO, ...featuresOutput()] }]
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
    name: 'js-esm', language: 'javascript', code: ['lib/format.js', 'lib/features.js', 'lib/actor.js'], body: 'src/blueprint',
    graphs: [greeting('src/graphs/Greeting.vgraph', 'title'), greetingTests('src/graphs/Greeting.vgraph'), ...featureGraphs('src/graphs', 'javascript')],
    steps: [tsc('jsconfig.json'), eslint, nodeTest('src/graphs/GreetingTests.vgraph.test.js'), { name: 'run', command: ['node', 'src/index.js'], stdout: [...HELLO, ...featuresOutput()] }]
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
    name: 'py-src-layout', language: 'python', code: ['src/corpus_game/text.py', 'src/corpus_game/features.py', 'src/corpus_game/actor.py'], body: 'src/corpus_game/blueprint',
    graphs: [greeting('src/corpus_game/graphs/Greeting.vgraph', 'title'), greetingTests('src/corpus_game/graphs/Greeting.vgraph'), ...featureGraphs('src/corpus_game/graphs', 'python')],
    steps: [
      python('mypy --strict', 'mypy'), python('Pyright (strict)', 'pyright'), python('Ruff', 'ruff', 'check', '.'),
      { name: 'unittest', command: [PYTHON, '-m', 'unittest', 'discover', '-v', '-s', 'src/corpus_game/graphs', '-t', 'src'], env: { PYTHONPATH: 'src' }, includes: ['Ran 1 test', 'OK'] },
      { name: 'run', command: [PYTHON, '-m', 'corpus_game'], env: { PYTHONPATH: 'src' }, stdout: [...HELLO, ...featuresOutput()] }
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
    name: 'cs-console', language: 'csharp', code: ['Names.cs', 'Features.cs', 'Actor.cs'], body: 'Blueprint',
    graphs: [greeting('Graphs/Greeting.vgraph', 'Title'), ...featureGraphs('Graphs', 'csharp')],
    steps: [
      { name: 'dotnet build', command: dotnet('build'), probe: ['dotnet', '--version'] },
      { name: 'run', command: ['dotnet', 'run', '--no-build'], probe: ['dotnet', '--version'], stdout: [...HELLO, ...featuresOutput()] }
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
    code: ['src/main/java/corpus/game/Text.java', 'src/main/java/corpus/game/Calculations.java', 'src/main/java/corpus/game/count/Counter.java', 'src/main/java/corpus/game/count/BigCounter.java', 'src/main/java/corpus/game/Actor.java'],
    graphs: [greeting('src/main/java/corpus/game/graphs/Greeting.vgraph', 'title'), ...featureGraphs('src/main/java/corpus/game/graphs', 'java')],
    steps: [
      { name: 'mvn compile', command: ['mvn', '-q', '-o', '-B', 'compile'], probe: ['mvn', '-v'] },
      { name: 'run', command: ['java', '-cp', 'target/classes', 'corpus.game.Main'], probe: ['java', '-version'], stdout: [...HELLO, ...featuresOutput()] }
    ]
  },
  {
    name: 'java-gradle-multi', language: 'java', code: ['core/src/main/java/corpus/core/Text.java'],
    graphs: [greeting('app/src/main/java/corpus/app/graphs/Greeting.vgraph', 'title')],
    steps: [{ name: 'gradle build and run', command: ['gradle', '--no-daemon', '-q', '--offline', 'build', ':app:run'], probe: ['gradle', '-v'], stdout: HELLO, timeoutMs: 900000 }]
  },
  // ---- Go ----
  {
    name: 'go-module', language: 'go', body: 'internal/blueprint',
    code: ['internal/text/text.go', 'internal/features/count.go', 'internal/features/divide.go', 'internal/features/fetch.go'],
    graphs: [greeting('internal/graphs/Greeting.vgraph', 'Title'), ...featureGraphs('internal/graphs', 'go', GO_FEATURES)],
    steps: [
      go('build', './...'), go('vet', './...'),
      { name: 'staticcheck', command: ['staticcheck', './...'], probe: ['staticcheck', '-version'], env: GO_ENV, check: true },
      { ...go('run', './cmd/corpus'), name: 'run', stdout: [...HELLO, ...featuresOutput(GO_FEATURES)] }
    ]
  },
  {
    // The app's graph calls the other module's code, found through go.work.
    name: 'go-workspace', language: 'go', code: ['lib/text/text.go'],
    graphs: [greeting('app/graphs/Greeting.vgraph', 'Title')],
    steps: [
      { ...go('build', './...'), cwd: 'app', env: GO_WORK_ENV }, { ...go('vet', './...'), cwd: 'app', env: GO_WORK_ENV },
      { name: 'staticcheck', command: ['staticcheck', './...'], probe: ['staticcheck', '-version'], cwd: 'app', env: GO_WORK_ENV, check: true },
      { ...go('run', '.'), name: 'run', cwd: 'app', env: GO_WORK_ENV, stdout: HELLO }
    ]
  },
  // ---- Rust ----
  {
    name: 'rust-bin', language: 'rust', body: 'src/blueprint',
    code: ['src/text.rs', 'src/features/count.rs', 'src/features/divide.rs', 'src/features/lists.rs', 'src/features/fetch.rs'],
    graphs: [greeting('src/graphs/Greeting.vgraph', 'title'), ...featureGraphs('src/graphs', 'rust', RUST_FEATURES)],
    steps: [
      cargo('build'), cargo('clippy', '--all-targets', '--', '-D', 'warnings'),
      // rustfmt leaves @generated files alone.
      { ...cargo('fmt', '--check'), probe: ['cargo', 'fmt', '--version'] },
      { ...cargo('run', '--quiet'), name: 'run', stdout: [...HELLO, ...featuresOutput(RUST_FEATURES)] }
    ]
  },
  {
    // The app's graph calls the library crate's code.
    name: 'rust-workspace', language: 'rust', code: ['crates/core/src/text.rs'],
    graphs: [greeting('crates/app/src/graphs/Greeting.vgraph', 'title')],
    steps: [
      cargo('build'), cargo('clippy', '--all-targets', '--', '-D', 'warnings'),
      { ...cargo('fmt', '--check'), probe: ['cargo', 'fmt', '--version'] },
      { ...cargo('run', '--quiet', '-p', 'corpus_app'), name: 'run', stdout: HELLO }
    ]
  },
  // ---- C++ ----
  {
    // A library subproject the graphs call, and warnings as errors.
    name: 'cpp-cmake', language: 'cpp', body: 'src/blueprint', programs: ['countdown'],
    code: ['lib/include/corpus/text.h', 'src/features/count.h', 'src/features/divide.h', 'src/features/fetch.h', 'src/features/actor.h'],
    graphs: [greeting('src/graphs/Greeting.vgraph', 'title'), ...featureGraphs('src/graphs', 'cpp', CPP_FEATURES)],
    steps: [
      { name: 'cmake', command: ['cmake', '-S', '.', '-B', 'build', ...CMAKE_GENERATOR, '-DCMAKE_CXX_COMPILER=g++'], probe: ['cmake', '--version'] },
      { name: 'cmake --build', command: ['cmake', '--build', 'build', '--parallel'], probe: ['cmake', '--version'], timeoutMs: 1200000 },
      { name: 'run', command: [exe('build/corpus')], probe: ['cmake', '--version'], stdout: [...HELLO, ...featuresOutput(CPP_FEATURES)] }
    ]
  },
  {
    // A Makefile whose $(wildcard) sources take in the generated files.
    name: 'cpp-make', language: 'cpp', code: ['src/names.h'],
    graphs: [greeting('src/graphs/Greeting.vgraph', 'title')],
    steps: [
      { name: 'make', command: [MAKE], probe: [MAKE, '--version'] },
      { name: 'run', command: [exe('corpus')], probe: [MAKE, '--version'], stdout: HELLO }
    ]
  },
  {
    // A graph calls a C file's function, whose header has no extern "C" of its own.
    name: 'cpp-c-sources', language: 'cpp', code: ['src/measure.h'],
    graphs: [{ path: 'src/graphs/Room.vgraph', build: ({ code }) => printCall('Room', code('area').type, { 'pin:width': 3, 'pin:height': 2.5 }) }],
    steps: [
      { name: 'cmake', command: ['cmake', '-S', '.', '-B', 'build', ...CMAKE_GENERATOR, '-DCMAKE_C_COMPILER=gcc', '-DCMAKE_CXX_COMPILER=g++'], probe: ['cmake', '--version'] },
      { name: 'cmake --build', command: ['cmake', '--build', 'build'], probe: ['cmake', '--version'] },
      { name: 'run', command: [exe('build/corpus')], probe: ['cmake', '--version'], stdout: ['7.5'] }
    ]
  },
  {
    // A Visual Studio project, built by MSBuild at warning level 4 with warnings as errors.
    name: 'cpp-vcxproj', language: 'cpp', code: ['names.h'], body: 'blueprint', programs: ['countdown'],
    graphs: [greeting('graphs/Greeting.vgraph', 'title')],
    steps: [
      { name: 'MSBuild', command: [MSBUILD, 'Game.vcxproj', '/p:Configuration=Debug', '/p:Platform=x64', '/nologo', '/v:minimal', '/nodeReuse:false'], probe: [MSBUILD, '-version'], timeoutMs: 900000 },
      { name: 'run', command: ['./x64/Debug/Game.exe'], probe: [MSBUILD, '-version'], stdout: HELLO }
    ]
  },
  // ---- Ruby ----
  {
    name: 'ruby-gem', language: 'ruby', body: 'lib/corpus_game/blueprint',
    code: ['lib/corpus_game/text.rb', 'lib/corpus_game/features.rb', 'lib/corpus_game/actor.rb'],
    graphs: [greeting('lib/corpus_game/graphs/Greeting.vgraph', 'title'), ...featureGraphs('lib/corpus_game/graphs', 'ruby', DYNAMIC_FEATURES)],
    steps: [
      { name: 'RuboCop', command: ['rubocop', '--format', 'quiet'], probe: ['rubocop', '--version'], check: true },
      { name: 'gem build', command: ['gem', 'build', 'corpus_game.gemspec'], probe: ['gem', '--version'] },
      // With Ruby's warnings, which must be none.
      { name: 'run', command: ['ruby', '-w', '-Ilib', 'exe/corpus_game'], probe: ['ruby', '--version'], quiet: true, stdout: [...HELLO, ...featuresOutput(DYNAMIC_FEATURES)] }
    ]
  },
  {
    // Rails' folders, loaded as its autoloader would: a graph in app/graphs calls a service.
    name: 'ruby-rails-shaped', language: 'ruby', code: ['app/services/name_formatter.rb'],
    graphs: [greeting('app/graphs/Greeting.vgraph', 'title')],
    steps: [
      { name: 'RuboCop', command: ['rubocop', '--format', 'quiet'], probe: ['rubocop', '--version'], check: true },
      { name: 'run', command: ['ruby', '-w', 'bin/greet', 'ada'], probe: ['ruby', '--version'], quiet: true, stdout: HELLO }
    ]
  },
  // ---- PHP ----
  {
    // PSR-4 autoloading from Composer; PHPStan at level 9 and PSR-12.
    name: 'php-composer-lib', language: 'php', body: 'src/Blueprint',
    code: ['src/Text/Names.php', 'src/Features/Counter.php', 'src/Features/BigCounter.php', 'src/Features/Arithmetic.php', 'src/Features/Remote.php', 'src/Features/Actor.php'],
    graphs: [greeting('src/Graphs/Greeting.vgraph', 'title'), ...featureGraphs('src/Graphs', 'php', DYNAMIC_FEATURES)],
    steps: [...composer, phpstan, phpcs, { ...php('bin/corpus'), stdout: [...HELLO, ...featuresOutput(DYNAMIC_FEATURES)] }]
  },
  {
    // Laravel's folders and console entry: a graph in app/Graphs calls a service.
    name: 'php-laravel-shaped', language: 'php', code: ['app/Services/NameFormatter.php'],
    graphs: [greeting('app/Graphs/Greeting.vgraph', 'title')],
    steps: [...composer, phpstan, phpcs, { ...php('artisan', 'greet', 'ada'), stdout: HELLO }]
  },
  // ---- Lua ----
  {
    // A rock whose modules are required from src/ (.luarc.json's runtime.path).
    name: 'lua-rock', language: 'lua', body: 'src/corpus_game/blueprint',
    code: ['src/corpus_game/text.lua', 'src/corpus_game/features.lua', 'src/corpus_game/actor.lua'],
    graphs: [greeting('src/corpus_game/graphs/Greeting.vgraph', 'title'), ...featureGraphs('src/corpus_game/graphs', 'lua', DYNAMIC_FEATURES)],
    steps: [luacheck, { name: 'run', command: ['lua', 'bin/corpus_game.lua'], probe: LUA_PROBE, quiet: true, stdout: [...HELLO, ...featuresOutput(DYNAMIC_FEATURES)] }]
  },
  {
    // A folder of scripts with a .luarc.json, the graph beside them.
    name: 'lua-scripts', language: 'lua', code: ['names.lua'],
    graphs: [greeting('Greeting.vgraph', 'title')],
    steps: [luacheck, { name: 'run', command: ['lua', 'main.lua', 'ada'], probe: LUA_PROBE, quiet: true, stdout: HELLO }]
  },
  // ---- GDScript ----
  {
    // A Godot project whose addon has the code the graphs call, with its warnings as errors.
    name: 'gd-addon', language: 'gdscript', body: 'scenes/blueprint',
    code: ['addons/corpus_tools/text.gd', 'addons/corpus_tools/counter.gd', 'addons/corpus_tools/big_counter.gd', 'addons/corpus_tools/remote.gd', 'addons/corpus_tools/actor.gd'],
    graphs: [greeting('scenes/graphs/Greeting.vgraph', 'title'), ...featureGraphs('scenes/graphs', 'gdscript', GDSCRIPT_FEATURES)],
    steps: [
      // As a CI job does first: the import registers the class_name scripts.
      { name: 'godot --import', command: [GODOT, '--headless', '--path', '.', '--import'], probe: [GODOT, '--version'], timeoutMs: 300000 },
      // A script that doesn't compile can leave Godot running; the timeout ends it.
      { name: 'scripts compile', command: [GODOT, '--headless', '--no-header', '--path', '.', '--script', 'res://tools/check_scripts.gd'], probe: [GODOT, '--version'], timeoutMs: 120000 },
      { name: 'run', command: [GODOT, '--headless', '--no-header', '--path', '.'], probe: [GODOT, '--version'], timeoutMs: 120000, stdout: [...HELLO, ...featuresOutput(GDSCRIPT_FEATURES)] }
    ]
  }
];
