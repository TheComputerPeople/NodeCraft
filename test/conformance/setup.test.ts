// Set Up in This Project (docs/project-integration.md, part 5) on the corpus: it reports each
// project, and its changes do what they say. The exit check's part: applying its hooks makes the
// C++ and Rust layouts build, and a project declaring an older version than generated code needs is
// reported.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LanguagePackRegistry } from '../../src/core/language-pack';
import { builtinLanguagePacks } from '../../src/core/languages';
import { ProjectSetup, SetupChange, setupReport } from '../../src/extension/setup';
import { CorpusStep, PYTHON, corpusWorkDir, prepareLayout, runSteps } from './corpus';
import { LAYOUTS } from './corpus-layouts';

const workDir = corpusWorkDir();
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const languages = new LanguagePackRegistry(builtinLanguagePacks().all());
const layout = (name: string) => LAYOUTS.find((l) => l.name === name)!;

// The layout as a project with its graphs compiled but nothing registered yet, and its report.
async function unregistered(name: string): Promise<{ root: string; report: ProjectSetup[] }> {
  const { root, result } = await prepareLayout(layout(name), workDir, { register: false });
  assert.deepEqual(result.compileErrors, []);
  return { root, report: setupReport(root, languages) };
}

function apply(root: string, change: SetupChange): void {
  for (const file of change.files) {
    fs.mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
    fs.writeFileSync(path.join(root, file.path), file.text);
  }
}

const items = (report: ProjectSetup[], kind: string) => report.flatMap((p) => p.items.filter((i) => i.kind === kind));

async function assertPasses(steps: CorpusStep[], root: string, t: { skip(message: string): void }): Promise<void> {
  const results = await runSteps(steps, root);
  const failed = results.filter((s) => s.status === 'failed');
  assert.deepEqual(failed.map((s) => s.step), [], failed.map((s) => s.message).join('\n\n'));
  if (results.every((s) => s.status === 'skipped')) t.skip(results.map((s) => s.message).join('; '));
}

describe('Set Up in This Project', { concurrency: 3 }, () => {
  for (const name of ['cpp-cmake', 'cpp-vcxproj', 'rust-bin', 'rust-workspace']) {
    test(`${name}: its hooks are the report's needs, and applying them makes it build`, async (t) => {
      const { root, report } = await unregistered(name);
      const needs = items(report, 'needs');
      assert.ok(needs.length >= 1, JSON.stringify(report, null, 1));
      assert.ok(needs.every((n) => n.change?.files.length), 'each with its change');
      for (const need of needs) apply(root, need.change!);
      assert.deepEqual(items(setupReport(root, languages), 'needs'), [], 'and then nothing more is needed');
      await assertPasses(layout(name).steps.filter((s) => !/clippy|fmt|staticcheck/.test(s.name)), root, t);
    });
  }

  test('a project declaring an older version than generated code needs is reported, with what to do', async () => {
    const { root } = await prepareLayout(layout('java-maven'), workDir);
    const pom = path.join(root, 'pom.xml');
    fs.writeFileSync(pom, fs.readFileSync(pom, 'utf8').replace(/<maven\.compiler\.release>\d+</, '<maven.compiler.release>11<'));
    const cant = items(setupReport(root, languages), 'cant');
    assert.ok(cant.some((i) => /Java: 11 declared in pom\.xml/.test(i.title) && /Java 17/.test(i.detail ?? '') && /Raise it in pom\.xml/.test(i.detail ?? '')), JSON.stringify(cant));
  });

  test('what it finds: the build, the version, where graphs generate and the checkers', async () => {
    const { root } = await prepareLayout(layout('py-src-layout'), workDir);
    const found = items(setupReport(root, languages), 'found').map((i) => `${i.title}: ${i.detail ?? ''}`);
    assert.ok(found.some((f) => /^Build: python/.test(f)), found.join('\n'));
    assert.ok(found.some((f) => /Python graphs: \d+ in the project/.test(f) && /generates src\/corpus_game\/blueprint\/countdown\/example_vgraph\.py, which other code imports as corpus_game\.blueprint\.countdown\.example_vgraph/.test(f) && /and graphs in \d+ more folders/.test(f)), found.join('\n'));
    assert.ok(found.some((f) => /^Checkers: .*Ruff/.test(f)), found.join('\n'));
  });

  test("Ruff's exclude leaves the generated files out, and Ruff still passes", async (t) => {
    const { root } = await prepareLayout(layout('py-src-layout'), workDir);
    const ruff = items(setupReport(root, languages), 'optional').find((i) => /Ruff/.test(i.title));
    assert.ok(ruff?.change);
    apply(root, ruff.change);
    assert.match(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'), /^\[tool\.ruff\]\nextend-exclude = \["\*_vgraph\.py"/m);
    await assertPasses([{ name: 'Ruff', command: [PYTHON, '-m', 'ruff', 'check', '.'], probe: [PYTHON, '-m', 'ruff', '--version'] }], root, t);
  });

  test("ESLint: how to add the generated files to its ignores", async () => {
    const { root } = await prepareLayout(layout('ts-vite-app'), workDir);
    const eslint = items(setupReport(root, languages), 'optional').find((i) => /ESLint/.test(i.title));
    assert.match(eslint?.detail ?? '', /ignores: \['\*\*\/\*\.vgraph\.\*'/);
  });

  test("PHP: a classmap lets Composer's autoloader find the generated classes", async (t) => {
    const { root } = await prepareLayout(layout('php-composer-lib'), workDir);
    const classmap = items(setupReport(root, languages), 'optional').find((i) => /Composer/.test(i.title));
    assert.ok(classmap?.change);
    apply(root, classmap.change);
    assert.deepEqual((JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf8')) as { autoload: { classmap: string[] } }).autoload.classmap.sort(), ['src/Blueprint/audit/', 'src/Blueprint/countdown/', 'src/Blueprint/graphs/', 'src/Blueprint/pair/', 'src/Blueprint/tests/', 'src/Graphs/']);
    await assertPasses([
      { name: 'composer dump-autoload', command: ['phar/composer.phar', 'dump-autoload', '--no-interaction'], env: { XDEBUG_MODE: 'off' } },
      { name: 'autoloaded', command: ['php', '-r', "require 'vendor/autoload.php'; echo \\Corpus\\Graphs\\Greeting::greet('ada'), PHP_EOL;"], probe: ['php', '--version'], env: { XDEBUG_MODE: 'off' }, stdout: ['Hello, Ada!'] }
    ], root, t);
  });

  test('a project without graphs: a first graph to create, and .gitattributes', () => {
    const root = path.join(workDir, 'no-graphs');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "app", "type": "module" }\n');
    fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export const x = 1;\n');
    const report = setupReport(root, languages);
    const optional = items(report, 'optional');
    const first = optional.find((i) => /first graph/.test(i.title));
    assert.equal(first?.change?.open, 'src/Hello.vgraph');
    assert.equal((JSON.parse(first!.change!.files[0].text) as { name: string; language: string }).language, 'javascript');
    const attributes = optional.find((i) => /gitattributes/.test(i.title));
    assert.match(attributes?.change?.files[0].text ?? '', /^\*\.vgraph\.\* linguist-generated$/m);
    assert.deepEqual(items(report, 'needs'), [], 'no graphs: no hooks');
  });
});
