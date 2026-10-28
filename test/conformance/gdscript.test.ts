// The GDScript pack in a Godot project (docs/more-languages.md, "GDScript"): placement warns about a
// graph outside one, and a graph calls a ## @blueprint function whose script preloads another by its
// res:// path, which works because Run uses the graph's project.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { scanGdscript } from '../../src/core/importing/gdscript-scanner';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';
import { gdscriptPack, gdscriptPlacement } from '../../src/core/languages/gdscript';
import { NodeRegistry } from '../../src/core/registry';
import { ToolNotFoundError, runGeneratedCode } from '../../src/extension/runner';
import { doc, node, wire } from '../unit/helpers';
import { CODE_CLASS_OUTPUT, codeClassGraph } from './code-classes';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-gdscript-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

describe('GDScript projects', () => {
  test('placement warns about a graph outside a Godot project', () => {
    const files = new Set(['game/project.godot']);
    const context = (outputFile: string) => ({ outputFile, generatedFiles: [outputFile], readFile: () => undefined, exists: (file: string) => files.has(file) });
    assert.deepEqual(gdscriptPlacement(context('game/scenes/level_vgraph.gd')), {});
    assert.deepEqual(gdscriptPlacement(context('tools/report_vgraph.gd')).diagnostics?.map((d) => d.code), ['godot-outside-project']);
  });

  test("a graph calls a project function, in its project's res:// paths", async (t) => {
    const game = path.join(workDir, 'game');
    fs.mkdirSync(path.join(game, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(game, 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(game, 'project.godot'), 'config_version=5\n');
    fs.writeFileSync(path.join(game, 'lib', 'util.gd'), 'extends RefCounted\n\nstatic func three() -> float:\n\treturn 3.0\n');
    const scores = ['extends RefCounted', '', 'const Util = preload("res://lib/util.gd")', '', '## @blueprint', 'static func triple(value: float) -> float:', '\treturn value * Util.three()', ''].join('\n');
    fs.writeFileSync(path.join(game, 'lib', 'scores.gd'), scores);
    const registry = new NodeRegistry();
    registry.registerMany(exposeFunctions(scanGdscript(scores), { language: 'gdscript', path: 'game/lib/scores.gd', exposeAll: false }).definitions);
    const graph = {
      ...doc([node('s', 'core:event.start'), node('t', 'fn:gdscript:game/lib/scores.gd#triple', { 'pin:value': 14 }), node('p', 'core:console.print')],
        [wire('s', 'execOut', 't', 'execIn'), wire('t', 'execOut', 'p', 'execIn'), wire('t', 'returnValue', 'p', 'value')]),
      name: 'Level', language: 'gdscript'
    };
    const result = compileDocument(graph, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Level.vgraph', outputDir: 'game/scenes' } });
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.output!.text, /^const _Scores = preload\("\.\.\/lib\/scores\.gd"\)$/m);
    const file = path.join(game, 'scenes', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    for (const companion of result.output!.companionFiles ?? []) fs.writeFileSync(path.join(game, 'scenes', companion.fileName), companion.text);

    let run;
    try {
      run = await runGeneratedCode(gdscriptPack.generator!.runner!, file, result.output!.className, { cwd: game, projectDir: game, timeoutMs: 60000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.equal(run.stdout.trim(), '42', run.stderr);
  });
});

// Script classes (docs/node-authoring.md, gap 2): a class_name script's _init, methods and variables,
// used through Target pins. Run doesn't import the project, so class_name globals aren't registered
// and `extends Counter` wouldn't resolve: BigCounter is a script of its own with its own Add.
describe('GDScript code classes', () => {
  test('a graph constructs them and uses their members', async (t) => {
    const game = path.join(workDir, 'classes');
    fs.mkdirSync(path.join(game, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(game, 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(game, 'project.godot'), 'config_version=5\n');
    const counter = [
      'class_name Counter',
      'extends RefCounted',
      '',
      '## @blueprint',
      'var count: float = 0',
      '',
      '## @blueprint',
      'func _init(start: float) -> void:',
      '\tcount = start',
      '',
      '## @blueprint',
      'func add(amount: float) -> float:',
      '\tcount += amount',
      '\treturn count',
      '',
      '## @blueprint pure',
      'func doubled() -> float:',
      '\treturn count * 2',
      ''
    ].join('\n');
    const bigCounter = [
      'class_name BigCounter',
      'extends RefCounted',
      '',
      'var count: float = 0',
      '',
      '## @blueprint',
      'func _init(start: float) -> void:',
      '\tcount = start * 10',
      '',
      '## @blueprint',
      'func add(amount: float) -> float:',
      '\tcount += amount',
      '\treturn count',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(game, 'lib', 'counter.gd'), counter);
    fs.writeFileSync(path.join(game, 'lib', 'big_counter.gd'), bigCounter);
    const definitions = [
      ...exposeFunctions(scanGdscript(counter), { language: 'gdscript', path: 'classes/lib/counter.gd', exposeAll: false }).definitions,
      ...exposeFunctions(scanGdscript(bigCounter), { language: 'gdscript', path: 'classes/lib/big_counter.gd', exposeAll: false }).definitions
    ];
    const registry = new NodeRegistry();
    registry.registerMany(definitions);
    const result = compileDocument(codeClassGraph(definitions, 'gdscript'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Counting.vgraph', outputDir: 'classes/scenes' } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(game, 'scenes', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    for (const companion of result.output!.companionFiles ?? []) fs.writeFileSync(path.join(game, 'scenes', companion.fileName), companion.text);
    let run;
    try {
      run = await runGeneratedCode(gdscriptPack.generator!.runner!, file, result.output!.className, { cwd: game, projectDir: game, timeoutMs: 60000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.deepEqual(run.stdout.trim().split(/\r?\n/), CODE_CLASS_OUTPUT, run.stderr);
  });
});
