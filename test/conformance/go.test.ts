// Go graphs in a module (docs/language-breadth.md, "Go"): placement writes the package's support
// code, a function found through the language server becomes a node that generated code calls
// through its package's import, the project builds with the generated code, and Run builds the
// graph with the project's module.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { scanSymbols } from '../../src/core/importing/language-server';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';
import { goPlacement } from '../../src/core/languages/go';
import { goRuntime } from '../../src/core/languages/go-runtime';
import { NodeRegistry } from '../../src/core/registry';
import { goPackage, goRunSources } from '../../src/extension/placement';
import { ToolNotFoundError, runCommand, runGeneratedCode } from '../../src/extension/runner';
import { doc, node, wire } from '../unit/helpers';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-go-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

const SCORES = [
  'package scores',
  '',
  'import "example.com/game/util"',
  '',
  '// Triple multiplies by three.',
  '// @blueprint',
  'func Triple(value float64) float64 {',
  '\treturn value * util.Three()',
  '}',
  '',
  '// @blueprint pure',
  'func Label(name string, points int) string {',
  '\treturn name + ": " + util.Itoa(points)',
  '}',
  ''
].join('\n');
const UTIL = 'package util\n\nimport "strconv"\n\nfunc Three() float64 { return 3 }\n\nfunc Itoa(n int) string { return strconv.Itoa(n) }\n';

describe('Go placement', () => {
  test('each package folder with generated files gets the support code, in its package', () => {
    const files: Record<string, string> = { 'graphs/duel_vgraph.go': 'package graphs\n', 'graphs/team_vgraph.go': 'package graphs\n', 'tools/fix_vgraph.go': '// x\npackage tools\n' };
    const plan = goPlacement({ generatedFiles: Object.keys(files), readFile: (f) => files[f], exists: (f) => f in files });
    assert.deepEqual(plan.ownedFiles?.map((f) => f.path), ['graphs/vgraph_runtime.go', 'tools/vgraph_runtime.go']);
    assert.equal(plan.ownedFiles![0].text, goRuntime('graphs'));
    assert.match(plan.ownedFiles![1].text, /^package tools$/m);
  });
});

describe('Go project functions', () => {
  test('a graph in a module calls a package\'s functions; the project builds, and so does Run', async (t) => {
    const project = path.join(workDir, 'game');
    const files: Record<string, string> = { 'go.mod': 'module example.com/game\n\ngo 1.22\n', 'scores/scores.go': SCORES, 'util/util.go': UTIL, 'graphs/doc.go': '// Package graphs holds the graphs.\npackage graphs\n' };
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
      fs.writeFileSync(path.join(project, name), text);
    }
    const graphDir = path.join(project, 'graphs');
    const pkg = goPackage(graphDir, project);
    assert.deepEqual(pkg, { name: 'graphs', path: 'example.com/game/graphs', module: { path: 'example.com/game', dir: project } });
    assert.deepEqual(goPackage(path.join(project, 'scores'), project).path, 'example.com/game/scores');

    // As gopls describes them.
    const hover = (signature: string) => `\`\`\`go\n${signature}\n\`\`\``;
    const scan = scanSymbols(SCORES, [
      { name: 'Triple', line: 6, nameLine: 6, containers: [], hover: hover('func Triple(value float64) float64') },
      { name: 'Label', line: 11, nameLine: 11, containers: [], hover: hover('func Label(name string, points int) string') }
    ], builtinLanguagePacks().get('go')!.importer!.languageServer!, (type) => builtinLanguagePacks().get('go')!.mapType(type));
    const registry = new NodeRegistry();
    registry.registerMany(exposeFunctions(scan, { language: 'go', path: 'scores/scores.go', module: 'example.com/game/scores', exposeAll: false }).definitions);
    const d = doc(
      [
        node('s', 'core:event.start'),
        node('triple', 'fn:go:scores/scores.go#Triple', { 'pin:value': 14 }),
        node('p1', 'core:console.print'),
        node('label', 'fn:go:scores/scores.go#Label', { 'pin:name': 'Red', 'pin:points': 3 }),
        node('p2', 'core:console.print')
      ],
      [wire('s', 'execOut', 'triple', 'execIn'), wire('triple', 'execOut', 'p1', 'execIn'), wire('triple', 'returnValue', 'p1', 'value'), wire('p1', 'execOut', 'p2', 'execIn'), wire('label', 'returnValue', 'p2', 'value')]
    );
    const result = compileDocument({ ...doc([], []), ...d, name: 'Uses', language: 'go' }, {
      registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Uses.vgraph', outputDir: 'graphs', namespace: pkg.name, packagePath: pkg.path }
    });
    assert.deepEqual(result.diagnostics, []);
    const output = result.output!;
    assert.match(output.text, /^\tscores "example\.com\/game\/scores"$/m);
    assert.match(output.text, /scores\.Triple\(14\)/);
    const file = path.join(graphDir, output.fileName);
    fs.writeFileSync(file, output.text);
    // The support code, as the output plan writes it.
    const plan = goPlacement({ generatedFiles: [`graphs/${output.fileName}`], readFile: (f) => fs.readFileSync(path.join(project, f), 'utf8'), exists: (f) => fs.existsSync(path.join(project, f)) });
    for (const owned of plan.ownedFiles ?? []) fs.writeFileSync(path.join(project, owned.path), owned.text);

    const env = { GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod', GOWORK: 'off' };
    const build = await runCommand(['go', 'build', './...'], { cwd: project, env, timeoutMs: 300000 });
    if (!build) return t.skip('Go isn\'t available here');
    assert.equal(build.exitCode, 0, `${build.stdout}${build.stderr}`);

    assert.deepEqual(goRunSources(file), [path.join(graphDir, 'doc.go')], 'the package\'s other files, not its support code');
    let outcome;
    try {
      outcome = await runGeneratedCode(builtinLanguagePacks().get('go')!.generator!.runner!, file, output.className, { cwd: project, sources: goRunSources(file), goModule: pkg.module, timeoutMs: 300000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.equal(outcome.stderr, '');
    assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').trim().split('\n'), ['42', 'Red: 3']);
  });
});
