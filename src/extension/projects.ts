// The project model (docs/project-integration.md, part 1): each project in a workspace folder, by
// the project files of its language, with its build system, the workspace it belongs to, the
// language versions it declares and the checkers it configures. Free of the vscode API, like
// placement.ts, so it can be tested against folders.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CompileDiagnostic } from '../core/compiler/diagnostics';
import { LanguagePack } from '../core/language-pack';
import { lowestVersion, versionWarning } from '../core/versions';

export type BuildSystem = 'npm' | 'python' | 'dotnet' | 'cmake' | 'make' | 'msbuild' | 'cargo' | 'maven' | 'gradle' | 'go' | 'lua' | 'godot' | 'bundler' | 'composer';

export interface DeclaredVersion {
  // As the project writes it: "11", "^8.0", ">=3.8", "ES2020", "Lua 5.4".
  declared: string;
  // The lowest version it allows, as the version comparison reads it ("11", "8.0", "3.8").
  lowest: string;
  // The file that declares it, relative to the project's root.
  source: string;
}

export interface ProjectWorkspace {
  kind: 'npm' | 'pnpm' | 'cargo' | 'go' | 'maven' | 'gradle' | 'cmake' | 'dotnet';
  root: string;
}

export interface Project {
  root: string;
  buildSystems: BuildSystem[];
  // The languages of the graphs it can hold (pack ids).
  languages: string[];
  // The project files that make it one, relative to its root.
  files: string[];
  // The language versions it declares, by pack id.
  versions: Record<string, DeclaredVersion>;
  workspace?: ProjectWorkspace;
  // The checkers it configures, by name: "tsc strict", "ESLint", "mypy", "Ruff", ...
  checkers: string[];
}

// Folders that hold no projects of the user's own: dependencies, build output, tools' state.
const SKIP = new Set(['node_modules', '.git', 'vendor', 'target', 'build', 'dist', 'out', 'bin', 'obj', '.venv', 'venv', 'env', '__pycache__', '.godot', '.gradle', '.idea', '.vs', '.vscode-test', '.tox', 'site-packages', 'blueprint-packages']);
const MAX_DEPTH = 8;

const read = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};
const json = (file: string): Record<string, unknown> | undefined => {
  const text = read(file);
  if (text === undefined) return undefined;
  try {
    // Configs often have comments and trailing commas (tsconfig.json, .luarc.json).
    return JSON.parse(text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s: string | undefined) => s ?? '').replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};
const entries = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const exists = (file: string): boolean => fs.existsSync(file);

// A version as a declaration gives it, for display and comparison.
function declared(declaredText: string, source: string, lowest = lowestVersion(declaredText)): DeclaredVersion | undefined {
  return lowest ? { declared: declaredText.trim(), lowest, source } : undefined;
}

// The project that `dir` is (not its parents), or undefined.
export function projectAt(dir: string): Project | undefined {
  const names = entries(dir).filter((e) => e.isFile()).map((e) => e.name);
  const has = (name: string) => names.includes(name);
  const project: Project = { root: dir, buildSystems: [], languages: [], files: [], versions: {}, checkers: [] };
  const add = (build: BuildSystem, languages: string[], files: string[]) => {
    if (!project.buildSystems.includes(build)) project.buildSystems.push(build);
    for (const l of languages) if (!project.languages.includes(l)) project.languages.push(l);
    project.files.push(...files.filter((f) => !project.files.includes(f)));
  };
  const version = (language: string, v: DeclaredVersion | undefined) => {
    if (v && !project.versions[language]) project.versions[language] = v;
  };

  // JavaScript and TypeScript.
  if (has('package.json') || has('tsconfig.json') || has('jsconfig.json')) {
    const pkg = json(path.join(dir, 'package.json'));
    const deps = { ...(pkg?.dependencies as object | undefined), ...(pkg?.devDependencies as object | undefined) };
    const typescript = has('tsconfig.json') || 'typescript' in deps;
    add('npm', typescript ? ['typescript', 'javascript'] : ['javascript'], ['package.json', 'tsconfig.json', 'jsconfig.json'].filter(has));
    const tsconfig = has('tsconfig.json') ? tsconfigOptions(path.join(dir, 'tsconfig.json')) : undefined;
    if (tsconfig) {
      const lib = Array.isArray(tsconfig.lib) ? (tsconfig.lib as string[]).find((l) => /^es(\d{4}|next|\d)$/i.test(l)) : undefined;
      const target = lib ?? (typeof tsconfig.target === 'string' ? tsconfig.target : undefined);
      if (target) version('typescript', declared(target, 'tsconfig.json', esYear(target)));
      if (tsconfig.strict === true) project.checkers.push('tsc strict');
    }
    const jsTarget = has('jsconfig.json') ? (json(path.join(dir, 'jsconfig.json'))?.compilerOptions as Record<string, unknown> | undefined)?.target : undefined;
    if (typeof jsTarget === 'string') version('javascript', declared(jsTarget, 'jsconfig.json', esYear(jsTarget)));
    // Node.js, which runs the JavaScript and TypeScript.
    const node = (pkg?.engines as Record<string, unknown> | undefined)?.node;
    version('node', typeof node === 'string' ? declared(node, 'package.json') : undefined);
  }
  // Python.
  if (has('pyproject.toml') || has('setup.py') || has('setup.cfg')) {
    add('python', ['python'], ['pyproject.toml', 'setup.py', 'setup.cfg'].filter(has));
    const pyproject = read(path.join(dir, 'pyproject.toml')) ?? '';
    const requires = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1];
    if (requires) version('python', declared(requires, 'pyproject.toml'));
    const cfg = /python_requires\s*=\s*([^\n]+)/.exec(read(path.join(dir, 'setup.cfg')) ?? '')?.[1];
    if (cfg) version('python', declared(cfg, 'setup.cfg'));
    const setup = /python_requires\s*=\s*["']([^"']+)["']/.exec(read(path.join(dir, 'setup.py')) ?? '')?.[1];
    if (setup) version('python', declared(setup, 'setup.py'));
    if (/^\[tool\.mypy\]/m.test(pyproject)) project.checkers.push('mypy');
    if (/^\[tool\.ruff/m.test(pyproject)) project.checkers.push('Ruff');
    if (/^\[tool\.pyright\]/m.test(pyproject)) project.checkers.push('Pyright');
  }
  if (has('.python-version') && project.languages.includes('python')) version('python', declared((read(path.join(dir, '.python-version')) ?? '').split('\n')[0], '.python-version'));
  // C#.
  const csproj = names.filter((n) => n.endsWith('.csproj'));
  if (csproj.length) {
    add('dotnet', ['csharp'], csproj);
    const text = read(path.join(dir, csproj[0])) ?? '';
    const lang = /<LangVersion>\s*([^<]+?)\s*<\/LangVersion>/.exec(text)?.[1];
    const framework = /<TargetFrameworks?>\s*([^<;]+)/.exec(text)?.[1];
    if (lang) version('csharp', declared(lang, csproj[0], csharpVersion(lang)));
    else if (framework) version('csharp', declared(framework, csproj[0], defaultCsharp(framework)));
    if (/<TreatWarningsAsErrors>\s*true/i.test(text)) project.checkers.push('warnings as errors');
    if (/<Nullable>\s*enable/i.test(text)) project.checkers.push('nullable');
  }
  // C++.
  if (has('CMakeLists.txt')) {
    add('cmake', ['cpp'], ['CMakeLists.txt']);
    const cmake = read(path.join(dir, 'CMakeLists.txt')) ?? '';
    const std = /CMAKE_CXX_STANDARD\s+(\d+)/.exec(cmake)?.[1] ?? /cxx_std_(\d+)/.exec(cmake)?.[1];
    if (std) version('cpp', declared(`C++${std}`, 'CMakeLists.txt', std));
    if (/-Werror\b|COMPILE_WARNING_AS_ERROR\s+ON/.test(cmake)) project.checkers.push('warnings as errors');
  }
  const vcxproj = names.filter((n) => n.endsWith('.vcxproj'));
  if (vcxproj.length) {
    add('msbuild', ['cpp'], vcxproj);
    const std = /<LanguageStandard>\s*stdcpp(\d+|latest)/.exec(read(path.join(dir, vcxproj[0])) ?? '')?.[1];
    if (std) version('cpp', declared(`C++${std}`, vcxproj[0], std === 'latest' ? '99' : std));
  }
  if ((has('Makefile') || has('makefile')) && !project.buildSystems.length && hasSources(dir, /\.(cpp|cc|cxx|hpp|h)$/)) add('make', ['cpp'], [has('Makefile') ? 'Makefile' : 'makefile']);
  if (project.languages.includes('cpp') && !project.versions.cpp) {
    const commands = json(path.join(dir, 'compile_commands.json')) as unknown as { command?: string; arguments?: string[] }[] | undefined;
    const std = Array.isArray(commands) ? /-std=(?:c|gnu)\+\+(\d+|2a|2b|1z)/.exec(commands.map((c) => c.command ?? (c.arguments ?? []).join(' ')).join(' '))?.[1] : undefined;
    if (std) version('cpp', declared(`C++${std}`, 'compile_commands.json', cppStandard(std)));
  }
  // Rust.
  if (has('Cargo.toml')) {
    const cargo = read(path.join(dir, 'Cargo.toml')) ?? '';
    if (/^\[package\]/m.test(cargo)) {
      add('cargo', ['rust'], ['Cargo.toml']);
      const edition = /^\s*edition\s*=\s*["'](\d{4})["']/m.exec(cargo)?.[1];
      // Without one, Cargo uses edition 2015.
      version('rust', declared(edition ? `edition ${edition}` : 'edition 2015 (none declared)', 'Cargo.toml', edition ?? '2015'));
    }
    if (exists(path.join(dir, 'clippy.toml')) || exists(path.join(dir, '.clippy.toml'))) project.checkers.push('Clippy');
  }
  // Java.
  if (has('pom.xml')) {
    add('maven', ['java'], ['pom.xml']);
    const pom = read(path.join(dir, 'pom.xml')) ?? '';
    const release = /<maven\.compiler\.release>\s*([\d.]+)/.exec(pom)?.[1] ?? /<release>\s*([\d.]+)\s*<\/release>/.exec(pom)?.[1] ?? /<maven\.compiler\.source>\s*([\d.]+)/.exec(pom)?.[1] ?? /<source>\s*([\d.]+)\s*<\/source>/.exec(pom)?.[1];
    if (release) version('java', declared(release, 'pom.xml', javaVersion(release)));
  }
  const gradle = ['build.gradle', 'build.gradle.kts'].filter(has);
  if (gradle.length) {
    add('gradle', ['java'], gradle);
    const text = read(path.join(dir, gradle[0])) ?? '';
    const java = /languageVersion(?:\.set\()?\s*[=(]?\s*JavaLanguageVersion\.of\(\s*(\d+)/.exec(text)?.[1] ?? /sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_|['"])?([\d._]+)/.exec(text)?.[1];
    if (java) version('java', declared(java.replace('_', '.'), gradle[0], javaVersion(java.replace('_', '.'))));
  }
  // Go.
  if (has('go.mod')) {
    add('go', ['go'], ['go.mod']);
    const go = /^go\s+([\d.]+)/m.exec(read(path.join(dir, 'go.mod')) ?? '')?.[1];
    if (go) version('go', declared(go, 'go.mod'));
  }
  if (has('.golangci.yml') || has('.golangci.yaml')) project.checkers.push('golangci-lint');
  // Lua.
  const rockspec = names.filter((n) => n.endsWith('.rockspec'));
  if (has('.luarc.json') || rockspec.length) {
    add('lua', ['lua'], [...(has('.luarc.json') ? ['.luarc.json'] : []), ...rockspec]);
    const runtime = (json(path.join(dir, '.luarc.json')) ?? {}) as Record<string, unknown>;
    const luarc = (runtime['runtime.version'] ?? (runtime.runtime as Record<string, unknown> | undefined)?.version) as string | undefined;
    if (typeof luarc === 'string') version('lua', declared(luarc, '.luarc.json', luaVersion(luarc)));
    const rock = rockspec.length ? /["']lua\s*([<>=~ ]*[\d.]+[^"']*)["']/.exec(read(path.join(dir, rockspec[0])) ?? '')?.[1] : undefined;
    if (rock) version('lua', declared(`lua ${rock}`, rockspec[0], lowestVersion(rock)));
  }
  if (has('.luacheckrc')) project.checkers.push('luacheck');
  // GDScript.
  if (has('project.godot')) {
    add('godot', ['gdscript'], ['project.godot']);
    const godot = read(path.join(dir, 'project.godot')) ?? '';
    const feature = /config\/features\s*=\s*PackedStringArray\(\s*"(\d+\.\d+)"/.exec(godot)?.[1];
    if (feature) version('gdscript', declared(`Godot ${feature}`, 'project.godot', feature));
    if (/treat_warnings_as_errors\s*=\s*true/.test(godot)) project.checkers.push('warnings as errors');
  }
  // Ruby.
  const gemspec = names.filter((n) => n.endsWith('.gemspec'));
  if (has('Gemfile') || gemspec.length) {
    add('bundler', ['ruby'], [...(has('Gemfile') ? ['Gemfile'] : []), ...gemspec]);
    const rubyVersion = has('.ruby-version') ? (read(path.join(dir, '.ruby-version')) ?? '').trim().replace(/^ruby-/, '') : undefined;
    if (rubyVersion) version('ruby', declared(rubyVersion, '.ruby-version'));
    const gemfile = /^\s*ruby\s+["']([^"']+)["']/m.exec(read(path.join(dir, 'Gemfile')) ?? '')?.[1];
    if (gemfile) version('ruby', declared(gemfile, 'Gemfile'));
    const required = gemspec.length ? /required_ruby_version\s*=\s*["']([^"']+)["']/.exec(read(path.join(dir, gemspec[0])) ?? '')?.[1] : undefined;
    if (required) version('ruby', declared(required, gemspec[0]));
  }
  if (has('.rubocop.yml')) project.checkers.push('RuboCop');
  // PHP.
  if (has('composer.json')) {
    add('composer', ['php'], ['composer.json']);
    const php = ((json(path.join(dir, 'composer.json'))?.require ?? {}) as Record<string, unknown>).php;
    if (typeof php === 'string') version('php', declared(php, 'composer.json'));
  }
  if (has('phpstan.neon') || has('phpstan.neon.dist')) project.checkers.push('PHPStan');
  if (has('psalm.xml') || has('psalm.xml.dist')) project.checkers.push('Psalm');

  if (!project.buildSystems.length) return undefined;
  // Checkers any language's project may configure.
  if (names.some((n) => /^\.eslintrc(\.\w+)?$|^eslint\.config\.\w+$/.test(n))) project.checkers.push('ESLint');
  if (has('mypy.ini') || has('.mypy.ini')) project.checkers.push('mypy');
  if (has('ruff.toml') || has('.ruff.toml')) project.checkers.push('Ruff');
  if (has('pyrightconfig.json')) project.checkers.push('Pyright');
  if (has('.editorconfig')) project.checkers.push('EditorConfig');
  if (/<TreatWarningsAsErrors>\s*true/i.test(read(path.join(dir, 'Directory.Build.props')) ?? '')) project.checkers.push('warnings as errors');
  project.checkers = [...new Set(project.checkers)];
  return project;
}

function hasSources(dir: string, pattern: RegExp, depth = 2): boolean {
  return entries(dir).some((e) => (e.isFile() ? pattern.test(e.name) : depth > 0 && e.isDirectory() && !SKIP.has(e.name) && hasSources(path.join(dir, e.name), pattern, depth - 1)));
}

// A tsconfig.json's compiler options, over those of the relative configs it extends.
function tsconfigOptions(file: string, seen = new Set<string>()): Record<string, unknown> {
  if (seen.has(file)) return {};
  seen.add(file);
  const config = json(file);
  const own = (config?.compilerOptions ?? {}) as Record<string, unknown>;
  const extended = typeof config?.extends === 'string' && config.extends.startsWith('.') ? tsconfigOptions(path.resolve(path.dirname(file), config.extends.endsWith('.json') ? config.extends : `${config.extends}.json`), seen) : {};
  return { ...extended, ...own };
}

// ES targets as years: ES6 is 2015, ESNext the newest.
export function esYear(target: string): string | undefined {
  const t = target.toLowerCase();
  if (t === 'esnext' || t === 'latest') return '9999';
  if (t === 'es3') return '1999';
  if (t === 'es5') return '2009';
  if (t === 'es6') return '2015';
  return /^es(\d{4})$/.exec(t)?.[1];
}

function csharpVersion(lang: string): string | undefined {
  const l = lang.toLowerCase();
  if (l === 'latest' || l === 'preview' || l === 'latestmajor') return '99';
  if (l === 'default') return undefined;
  return /^(\d+(?:\.\d+)?)/.exec(l)?.[1];
}

// The C# version a target framework uses by default.
export function defaultCsharp(framework: string): string | undefined {
  const f = framework.toLowerCase().trim();
  const net = /^net(\d+)\.\d+/.exec(f)?.[1];
  if (net) return String(Math.min(99, Number(net) + 4));
  if (/^netcoreapp3/.test(f) || f === 'netstandard2.1') return '8';
  if (/^netcoreapp2|^netstandard|^net4\d+$|^net3|^net2/.test(f)) return '7.3';
  return undefined;
}

function cppStandard(std: string): string {
  return ({ '1z': '17', '2a': '20', '2b': '23' } as Record<string, string>)[std] ?? std;
}

function javaVersion(release: string): string {
  return release.startsWith('1.') ? release.slice(2) : release;
}

function luaVersion(runtime: string): string | undefined {
  if (/luajit/i.test(runtime)) return '5.1';
  return /(\d+\.\d+)/.exec(runtime)?.[1];
}

// The workspace a project belongs to: the nearest folder above it (up to `stopDir`) that groups
// projects, or the project itself when it does.
function workspaceOf(dir: string, stopDir: string): ProjectWorkspace | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    const pkg = json(path.join(current, 'package.json'));
    if (exists(path.join(current, 'pnpm-workspace.yaml'))) return { kind: 'pnpm', root: current };
    if (pkg && 'workspaces' in pkg) return { kind: 'npm', root: current };
    if (/^\[workspace\]/m.test(read(path.join(current, 'Cargo.toml')) ?? '')) return { kind: 'cargo', root: current };
    if (exists(path.join(current, 'go.work'))) return { kind: 'go', root: current };
    if (/<modules>/.test(read(path.join(current, 'pom.xml')) ?? '')) return { kind: 'maven', root: current };
    if (exists(path.join(current, 'settings.gradle')) || exists(path.join(current, 'settings.gradle.kts'))) return { kind: 'gradle', root: current };
    if (current !== dir && /add_subdirectory\s*\(/.test(read(path.join(current, 'CMakeLists.txt')) ?? '')) return { kind: 'cmake', root: current };
    if (entries(current).some((e) => e.isFile() && e.name.endsWith('.sln'))) return { kind: 'dotnet', root: current };
    const parent = path.dirname(current);
    if (current === path.resolve(stopDir) || parent === current) return undefined;
  }
}

// Every project in `root` and below, outermost first.
export function findProjects(root: string): Project[] {
  const found: Project[] = [];
  const walk = (dir: string, depth: number) => {
    const project = projectAt(dir);
    if (project) found.push(project);
    if (depth >= MAX_DEPTH) return;
    for (const e of entries(dir)) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  for (const project of found) {
    const workspace = workspaceOf(project.root, root);
    if (workspace) project.workspace = workspace;
  }
  return found;
}

// The nearest project at or above `dir` (up to `stopDir`) that holds graphs in `language`.
export function nearestProject(dir: string, stopDir: string, language: string): Project | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    const project = projectAt(current);
    if (project?.languages.includes(language)) {
      const workspace = workspaceOf(current, stopDir);
      return workspace ? { ...project, workspace } : project;
    }
    const parent = path.dirname(current);
    if (current === path.resolve(stopDir) || parent === current) return undefined;
  }
}

// A warning when the graph's project declares an older version of its language than generated code
// needs (docs/project-integration.md, part 2). Generation goes on: the project may build with a
// newer toolchain than it declares.
export function projectVersionDiagnostics(pack: LanguagePack, graphDir: string, stopDir: string): CompileDiagnostic[] {
  const declaredVersion = pack.requires && nearestProject(graphDir, stopDir, pack.id)?.versions[pack.id];
  const message = declaredVersion && versionWarning(pack.displayName, pack.requires!, declaredVersion);
  return message ? [{ severity: 'warning', code: 'project-version', message }] : [];
}
