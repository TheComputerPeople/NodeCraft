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
