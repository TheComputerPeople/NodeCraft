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
import { SEVERAL_OUTPUTS_OUTPUT, severalOutputsGraph } from './several-outputs';
import { LATENT_CODE_OUTPUT, latentCodeGraph } from './latent-code';

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
    // A float parameter gets a float literal.
    assert.match(text, /\\App\\Util\\Scores::triple\(14\.0\)/);
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
    assert.match(result.output!.text, /new \\App\\Count\\Counter\(5\.0\)/);
    // A reference that may be empty is checked where it's used ("Accessed None").
    assert.match(result.output!.text, /Vg::object\(\$this->_cReturnValue\)->add\(3\.0\)/);
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

// Several outputs (docs/node-authoring.md, gap 3): parameters by reference, and an array shape's
// keys.
describe('PHP several outputs', () => {
  const VARIANTS: Record<string, string[]> = {
    'parameters by reference': [
      '    /** @blueprint */',
      '    public static function divide(int $a, int $b, int &$quotient, int &$remainder): void',
      '    {',
      '        $quotient = intdiv($a, $b);',
      '        $remainder = $a % $b;',
      '    }'
    ],
    'an array shape': [
      '    /**',
      '     * @blueprint',
      '     * @return array{quotient: int, remainder: int}',
      '     */',
      '    public static function divide(int $a, int $b): array',
      '    {',
      "        return ['quotient' => intdiv($a, $b), 'remainder' => $a % $b];",
      '    }'
    ]
  };
  for (const [label, method] of Object.entries(VARIANTS)) {
    test(`a graph reads each output (${label})`, async (t) => {
      const dir = path.join(workDir, `outputs-${label.replace(/ /g, '-')}`);
      fs.mkdirSync(path.join(dir, 'src', 'Math'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src', 'Game'), { recursive: true });
      const arithmetic = ['<?php', 'namespace App\\Math;', '', 'final class Arithmetic', '{', ...method, '}', ''].join('\n');
      fs.writeFileSync(path.join(dir, 'src', 'Math', 'Arithmetic.php'), arithmetic);
      const definitions = exposeFunctions(scanPhp(arithmetic), { language: 'php', path: 'src/Math/Arithmetic.php', exposeAll: false }).definitions;
      const registry = new NodeRegistry();
      registry.registerMany(definitions);
      const result = compileDocument(severalOutputsGraph(definitions, 'php'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Dividing.vgraph', outputDir: 'src/Game' } });
      assert.deepEqual(result.diagnostics, []);
      if (label === 'parameters by reference') assert.match(result.output!.text, /\$vgOut1_0 = 0;\n\s*\$vgOut1_1 = 0;\n\s*\\App\\Math\\Arithmetic::divide\(17, 5, \$vgOut1_0, \$vgOut1_1\);/);
      else assert.match(result.output!.text, /\['quotient' => [^,]+, 'remainder' => [^\]]+\] = /);
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
      assert.deepEqual(run.stdout.trim().split(/\r?\n/), SEVERAL_OUTPUTS_OUTPUT, run.stderr);
    });
  }
});

// Async functions (docs/node-authoring.md, gap 4): a function returning a Fiber is a latent node; the
// latent queue resumes the Fiber until it ends, and Completed runs with what it returned.
describe('PHP async functions', () => {
  const remote = (result: string) => [
    '<?php',
    'namespace App\\Remote;',
    '',
    'final class Remote',
    '{',
    '    /**',
    '     * @blueprint',
    '     * @return \\Fiber<int>',
    '     */',
    '    public static function fetchDouble(int $value): \\Fiber',
    '    {',
    '        return new \\Fiber(function () use ($value) {',
    '            $ready = hrtime(true) + 10000000;',
    '            while (hrtime(true) < $ready) {',
    '                \\Fiber::suspend();',
    '            }',
    `            ${result};`,
    '        });',
    '    }',
    '}',
    ''
  ].join('\n');

  async function run(name: string, code: string): Promise<{ run?: Awaited<ReturnType<typeof runGeneratedCode>>; skipped?: string; text: string }> {
    const dir = path.join(workDir, name);
    fs.mkdirSync(path.join(dir, 'src', 'Remote'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'Game'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'Remote', 'Remote.php'), code);
    const definitions = exposeFunctions(scanPhp(code), { language: 'php', path: 'src/Remote/Remote.php', exposeAll: false }).definitions;
    const registry = new NodeRegistry();
    registry.registerMany(definitions);
    const result = compileDocument(latentCodeGraph(definitions, 'php'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Fetching.vgraph', outputDir: 'src/Game' } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'src', 'Game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    for (const companion of result.output!.companionFiles ?? []) fs.writeFileSync(path.join(dir, 'src', 'Game', companion.fileName), companion.text);
    try {
      return { run: await runGeneratedCode(phpPack.generator!.runner!, file, result.output!.className, { cwd: dir, timeoutMs: 60000 }), text: result.output!.text };
    } catch (error) {
      if (error instanceof ToolNotFoundError) return { skipped: error.message, text: result.output!.text };
      throw error;
    }
  }

  test('a graph waits for a Fiber and reads its value on Completed', async (t) => {
    const { run: outcome, skipped, text } = await run('latent', remote('return $value * 2'));
    assert.match(text, /Vg::awaitLatent\(.*fetchDouble\(4\), function \(int \$value\): void \{/);
    if (!outcome) return t.skip(skipped);
    assert.deepEqual(outcome.stdout.trim().split(/\r?\n/), LATENT_CODE_OUTPUT, outcome.stderr);
  });

  test("an exception in the Fiber stops the run, and Completed doesn't run", async (t) => {
    const { run: outcome, skipped } = await run('latent-fails', remote('throw new \\RuntimeException("no double for $value")'));
    if (!outcome) return t.skip(skipped);
    assert.notEqual(outcome.exitCode, 0);
    assert.match(`${outcome.stdout}\n${outcome.stderr}`, /no double for 4/);
    assert.equal(outcome.stdout.trim().split(/\r?\n/)[0], 'started');
  });
});
