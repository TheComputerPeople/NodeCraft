// The project model (src/extension/projects.ts, docs/project-integration.md part 1) and language
// versions (src/core/versions.ts, part 2), against folders written for each test.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { builtinLanguagePacks } from '../../src/core/languages';
import { compareVersionNumbers, lowestVersion, versionWarning } from '../../src/core/versions';
import { defaultCsharp, findProjects, nearestProject, projectAt, projectVersionCheck, projectVersionDiagnostics } from '../../src/extension/projects';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-projects-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let next = 0;
// A folder with these files (paths relative to it), for one test.
function tree(files: Record<string, string>): string {
  const dir = path.join(root, String(next++));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

describe('language versions', () => {
  test('the lowest version a declaration allows', () => {
    const cases: [string, string | undefined][] = [
      ['>=3.8', '3.8'], ['>=3.8,<4', '3.8'], ['^8.0', '8.0'], ['~> 3.1', '3.1'], ['3.8.*', '3.8'], ['^7.4 || ^8.0', '7.4'],
      ['3.11.4', '3.11.4'], ['>= 3.0, < 4', '3.0'], ['<4', undefined], ['v18', '18'], ['>=18.0.0', '18.0.0']
    ];
    for (const [spec, lowest] of cases) assert.equal(lowestVersion(spec), lowest, spec);
  });

  test('versions compare by their numbers', () => {
    assert.ok(compareVersionNumbers('3.10', '3.9') > 0);
    assert.equal(compareVersionNumbers('8', '8.0'), 0);
    assert.ok(compareVersionNumbers('1.21', '1.21.3') < 0);
  });

  test('a declared version older than generated code needs is a warning that says why', () => {
    const java = builtinLanguagePacks().get('java')!;
    assert.equal(
      versionWarning(java.displayName, java.requires!, { declared: '11', lowest: '11', source: 'pom.xml' }),
      'This project declares 11 in pom.xml, but generated Java needs Java 17 (switch rules, pattern matching in instanceof and HexFormat). Older versions may not build or run it.'
    );
    assert.equal(versionWarning(java.displayName, java.requires!, { declared: '21', lowest: '21', source: 'pom.xml' }), undefined);
    const ruby = builtinLanguagePacks().get('ruby')!;
    assert.match(versionWarning(ruby.displayName, ruby.requires!, { declared: '~> 3.1', lowest: '3.1', source: 'Gemfile' })!, /declares ~> 3\.1 in Gemfile, which allows 3\.1, but generated Ruby is tested with Ruby 3\.3 and later/);
  });

  test('every built-in language says what its generated code needs', () => {
    for (const pack of builtinLanguagePacks().all()) assert.ok(pack.requires?.version && pack.requires.label, pack.id);
  });

  test("a target framework's default C# version", () => {
    assert.deepEqual(['net8.0', 'net6.0', 'netcoreapp3.1', 'netstandard2.1', 'netstandard2.0', 'net48'].map(defaultCsharp), ['12', '10', '8', '8', '7.3', '7.3']);
  });
});

describe('the project model', () => {
  test("each language's project, with its declared version", () => {
    const projects: [Record<string, string>, string, string, string][] = [
      [{ 'package.json': '{"engines":{"node":">=18"},"devDependencies":{"typescript":"^5"}}', 'tsconfig.json': '{ // a comment\n "compilerOptions": { "target": "ES2019", "strict": true, }, }' }, 'typescript', '2019', 'tsconfig.json'],
      [{ 'package.json': '{}', 'jsconfig.json': '{"compilerOptions":{"target":"es2021"}}' }, 'javascript', '2021', 'jsconfig.json'],
      [{ 'pyproject.toml': '[project]\nname = "game"\nrequires-python = ">=3.9"\n' }, 'python', '3.9', 'pyproject.toml'],
      [{ 'Game.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>' }, 'csharp', '10', 'Game.csproj'],
      [{ 'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\nproject(game)\nset(CMAKE_CXX_STANDARD 17)\n' }, 'cpp', '17', 'CMakeLists.txt'],
      [{ 'Cargo.toml': '[package]\nname = "game"\nversion = "0.1.0"\nedition = "2021"\n' }, 'rust', '2021', 'Cargo.toml'],
      [{ 'pom.xml': '<project><properties><maven.compiler.release>11</maven.compiler.release></properties></project>' }, 'java', '11', 'pom.xml'],
      [{ 'build.gradle.kts': 'java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }' }, 'java', '21', 'build.gradle.kts'],
      [{ 'go.mod': 'module example.com/game\n\ngo 1.20\n' }, 'go', '1.20', 'go.mod'],
      [{ '.luarc.json': '{"runtime.version": "LuaJIT"}' }, 'lua', '5.1', '.luarc.json'],
      [{ 'project.godot': 'config_version=5\n[application]\nconfig/features=PackedStringArray("4.2", "Forward Plus")\n' }, 'gdscript', '4.2', 'project.godot'],
      [{ Gemfile: 'source "https://rubygems.org"\nruby "~> 3.2"\n' }, 'ruby', '3.2', 'Gemfile'],
      [{ 'composer.json': '{"require":{"php":"^8.0 || ^8.1"}}' }, 'php', '8.0', 'composer.json']
    ];
    for (const [files, language, lowest, source] of projects) {
      const project = projectAt(tree(files));
      assert.ok(project?.languages.includes(language), `${language}: ${JSON.stringify(project)}`);
      assert.deepEqual([project!.versions[language]?.lowest, project!.versions[language]?.source], [lowest, source], language);
    }
  });

  test('a TypeScript project from its package.json too; tsconfig extends; Node.js from engines', () => {
    const dir = tree({ 'package.json': '{"engines":{"node":">=20.10"}}', 'tsconfig.base.json': '{"compilerOptions":{"lib":["ES2022","DOM"]}}', 'tsconfig.json': '{"extends":"./tsconfig.base.json"}' });
    const project = projectAt(dir)!;
    assert.deepEqual([project.versions.typescript?.lowest, project.versions.node?.lowest], ['2022', '20.10']);
  });

  test('no declaration, no version; Cargo without an edition is edition 2015', () => {
    assert.deepEqual(projectAt(tree({ 'go.mod': 'module m\n' }))!.versions, {});
    assert.equal(projectAt(tree({ 'Cargo.toml': '[package]\nname = "x"\n' }))!.versions.rust?.lowest, '2015');
  });

  test('a folder without project files is no project; a Makefile only with C++ sources', () => {
    assert.equal(projectAt(tree({ 'notes.txt': 'hi' })), undefined);
    assert.equal(projectAt(tree({ Makefile: 'all:\n\techo' })), undefined);
    assert.deepEqual(projectAt(tree({ Makefile: 'all:\n\tg++ src/main.cpp', 'src/main.cpp': 'int main() {}' }))?.buildSystems, ['make']);
  });

  test('the checkers a project configures', () => {
    const dir = tree({
      'pyproject.toml': '[project]\nname = "x"\n[tool.mypy]\nstrict = true\n[tool.ruff]\nline-length = 100\n',
      '.editorconfig': 'root = true', 'eslint.config.js': 'export default []'
    });
    assert.deepEqual(projectAt(dir)!.checkers.sort(), ['ESLint', 'EditorConfig', 'Ruff', 'mypy']);
    assert.deepEqual(projectAt(tree({ 'A.csproj': '<Project><PropertyGroup><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors></PropertyGroup></Project>' }))!.checkers, ['warnings as errors', 'nullable']);
  });

  test('projects in a tree, with the workspaces they belong to, leaving out dependencies and build output', () => {
    const dir = tree({
      'package.json': '{"private":true,"workspaces":["packages/*"]}',
      'packages/game/package.json': '{"name":"game"}',
      'packages/game/node_modules/dep/package.json': '{"name":"dep"}',
      'packages/engine/package.json': '{"name":"engine"}',
      'crates/Cargo.toml': '[workspace]\nmembers = ["core"]\n',
      'crates/core/Cargo.toml': '[package]\nname = "core"\nedition = "2021"\n',
      'crates/target/debug/build/x/Cargo.toml': '[package]\nname = "x"\n',
      'services/go.work': 'go 1.22\nuse ./api\n',
      'services/api/go.mod': 'module example.com/api\ngo 1.22\n'
    });
    const found = findProjects(dir).map((p) => [path.relative(dir, p.root).replace(/\\/g, '/'), p.workspace?.kind, p.workspace && path.relative(dir, p.workspace.root).replace(/\\/g, '/')]);
    assert.deepEqual(found, [
      ['', 'npm', ''],
      ['crates/core', 'cargo', 'crates'],
      ['packages/engine', 'npm', ''],
      ['packages/game', 'npm', ''],
      ['services/api', 'go', 'services']
    ]);
  });

  test("a graph's project: the nearest one above it for its language", () => {
    const dir = tree({ 'package.json': '{}', 'tools/pyproject.toml': '[project]\nname = "t"\n', 'tools/scripts/x.txt': '' });
    assert.equal(nearestProject(path.join(dir, 'tools', 'scripts'), dir, 'python')?.root, path.join(dir, 'tools'));
    assert.equal(nearestProject(path.join(dir, 'tools', 'scripts'), dir, 'javascript')?.root, dir);
    assert.equal(nearestProject(path.join(dir, 'tools', 'scripts'), dir, 'go'), undefined);
  });

  test("compiling warns when the graph's project declares an older version", () => {
    const java = builtinLanguagePacks().get('java')!;
    const old = tree({ 'pom.xml': '<project><properties><maven.compiler.source>1.8</maven.compiler.source></properties></project>', 'src/main/java/game/x.txt': '' });
    const graphDir = path.join(old, 'src', 'main', 'java', 'game');
    const [warning] = projectVersionDiagnostics(java, graphDir, old);
    assert.equal(warning?.code, 'project-version');
    assert.match(warning.message, /declares 1\.8 in pom\.xml, but generated Java needs Java 17/);
    const current = tree({ 'pom.xml': '<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>' });
    assert.deepEqual(projectVersionDiagnostics(java, current, current), []);
    assert.deepEqual(projectVersionDiagnostics(java, root, root), [], 'no project, no warning');
  });

  test('the version warning names the file and line that declare the version, to show once per project', () => {
    const java = builtinLanguagePacks().get('java')!;
    const old = tree({ 'pom.xml': '<project>\n  <properties>\n    <maven.compiler.release>11</maven.compiler.release>\n  </properties>\n</project>\n', 'src/main/java/game/x.txt': '' });
    const check = projectVersionCheck(java, path.join(old, 'src', 'main', 'java', 'game'), old);
    assert.equal(check?.root, old);
    assert.equal(check?.file, path.join(old, 'pom.xml'));
    assert.equal(check?.line, 2);
    const current = tree({ 'pom.xml': '<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>' });
    assert.deepEqual(projectVersionCheck(java, current, current), { root: current, diagnostics: [] }, 'a project without the problem: its warning is cleared');
  });
});
