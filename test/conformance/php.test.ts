// PHP graphs in a Composer project (docs/more-languages.md, "PHP"): a graph under a PSR-4 root takes
// its namespace, and calls a public static method and a namespaced function marked @blueprint.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { scanPhp } from '../../src/core/importing/php-scanner';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';
import { phpPack } from '../../src/core/languages/php';
import { NodeRegistry } from '../../src/core/registry';
import { phpNamespace } from '../../src/extension/placement';
import { ToolNotFoundError, runGeneratedCode } from '../../src/extension/runner';
import { doc, node, wire } from '../unit/helpers';
import { CODE_CLASS_OUTPUT, codeClassGraph } from './code-classes';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-php-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

describe('PHP projects', () => {
  test("a graph takes its PSR-4 namespace and calls the project's functions", async (t) => {
    fs.mkdirSync(path.join(workDir, 'src', 'Util'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'src', 'Game'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'composer.json'), JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }, null, 2));
    assert.equal(phpNamespace(path.join(workDir, 'src', 'Game'), workDir), 'App\\Game');
    assert.equal(phpNamespace(path.join(workDir, 'tools'), workDir), undefined, 'outside every PSR-4 root: the global namespace');

    const scores = [
      '<?php',
      'namespace App\\Util;',
      '',
      'final class Scores',
      '{',
      '    /** @blueprint */',
      '    public static function triple(float $value): float',
      '    {',
      '        return $value * 3;',
      '    }',
      '}',
      '',
      '/** @blueprint pure */',
      'function shout(string $name): string',
      '{',
      "    return strtoupper($name) . '!';",
      '}',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(workDir, 'src', 'Util', 'Scores.php'), scores);
    const registry = new NodeRegistry();
    registry.registerMany(exposeFunctions(scanPhp(scores), { language: 'php', path: 'src/Util/Scores.php', exposeAll: false }).definitions);
    const triple = registry.all().find((d) => d.displayName === 'Triple')!.type;
    const shout = registry.all().find((d) => d.displayName === 'Shout')!.type;
    const graph = {
      ...doc([
        node('s', 'core:event.start'), node('t', triple, { 'pin:value': 14 }), node('p', 'core:console.print'),
        node('shout', shout, { 'pin:name': 'done' }), node('p2', 'core:console.print')
      ], [
        wire('s', 'execOut', 't', 'execIn'), wire('t', 'execOut', 'p', 'execIn'), wire('t', 'returnValue', 'p', 'value'),
        wire('p', 'execOut', 'p2', 'execIn'), wire('shout', 'returnValue', 'p2', 'value')
      ]),
      name: 'Level', language: 'php'
    };
    const result = compileDocument(graph, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Level.vgraph', outputDir: 'src/Game', namespace: 'App\\Game' } });
    assert.deepEqual(result.diagnostics, []);
    const text = result.output!.text;
    assert.match(text, /^namespace App\\Game;$/m);
    assert.match(text, /\\App\\Util\\Scores::triple\(14\)/);
    assert.match(text, /\\App\\Util\\shout\('done'\)/);
    assert.match(text, /^require_once __DIR__ \. '\/\.\.\/Util\/Scores\.php';$/m);
    const file = path.join(workDir, 'src', 'Game', result.output!.fileName);
    fs.writeFileSync(file, text);
    for (const companion of result.output!.companionFiles ?? []) fs.writeFileSync(path.join(workDir, 'src', 'Game', companion.fileName), companion.text);

    let run;
    try {
      run = await runGeneratedCode(phpPack.generator!.runner!, file, result.output!.className, { cwd: workDir, timeoutMs: 60000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.deepEqual(run.stdout.trim().split(/\r?\n/), ['42', 'DONE!'], run.stderr);
  });
});

// Classes (docs/node-authoring.md, gap 2): a constructor, instance methods and public properties,
// used through Target pins; a subclass's object where its base is expected.
describe('PHP code classes', () => {
  test('a graph constructs them and uses their members', async (t) => {
    const dir = path.join(workDir, 'classes');
    fs.mkdirSync(path.join(dir, 'src', 'Count'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'Game'), { recursive: true });
    const counter = [
      '<?php',
      'namespace App\\Count;',
      '',
      'class Counter',
      '{',
      '    /** @blueprint */',
      '    public float $count = 0;',
      '',
      '    /** @blueprint */',
      '    public function __construct(float $start)',
      '    {',
      '        $this->count = $start;',
      '    }',
      '',
      '    /** @blueprint */',
      '    public function add(float $amount): float',
      '    {',
      '        $this->count += $amount;',
      '        return $this->count;',
      '    }',
      '',
      '    /** @blueprint pure */',
      '    public function doubled(): float',
      '    {',
      '        return $this->count * 2;',
      '    }',
      '}',
      '',
      'class BigCounter extends Counter',
      '{',
      '    /** @blueprint */',
      '    public function __construct(float $start)',
      '    {',
      '        parent::__construct($start * 10);',
      '    }',
      '}',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'src', 'Count', 'Counter.php'), counter);
    const definitions = exposeFunctions(scanPhp(counter), { language: 'php', path: 'src/Count/Counter.php', exposeAll: false }).definitions;
    const registry = new NodeRegistry();
    registry.registerMany(definitions);
    const result = compileDocument(codeClassGraph(definitions, 'php'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Counting.vgraph', outputDir: 'src/Game' } });
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.output!.text, /new \\App\\Count\\Counter\(5\)/);
    const file = path.join(dir, 'src', 'Game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    for (const companion of result.output!.companionFiles ?? []) fs.writeFileSync(path.join(dir, 'src', 'Game', companion.fileName), companion.text);
    let run;
    try {
      run = await runGeneratedCode(phpPack.generator!.runner!, file, result.output!.className, { cwd: dir, timeoutMs: 60000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.deepEqual(run.stdout.trim().split(/\r?\n/), CODE_CLASS_OUTPUT, run.stderr);
  });
});
