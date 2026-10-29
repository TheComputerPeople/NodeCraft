// Ruby graphs calling project code (docs/more-languages.md, "Ruby"): a graph in game/ calls a module
// method and a top-level method marked @blueprint in lib/scores.rb, which generated code requires
// relatively, and runs with Run.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { scanRuby } from '../../src/core/importing/ruby-scanner';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';
import { rubyPack } from '../../src/core/languages/ruby';
import { NodeRegistry } from '../../src/core/registry';
import { ToolNotFoundError, runGeneratedCode } from '../../src/extension/runner';
import { doc, node, wire } from '../unit/helpers';
import { CODE_CLASS_OUTPUT, codeClassGraph } from './code-classes';
import { SEVERAL_OUTPUTS_OUTPUT, severalOutputsGraph } from './several-outputs';
import { LATENT_CODE_OUTPUT, latentCodeGraph } from './latent-code';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-ruby-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

describe('Ruby projects', () => {
  test('a graph calls a module method and a top-level method', async (t) => {
    fs.mkdirSync(path.join(workDir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'game'), { recursive: true });
    const scores = [
      'module Scores',
      '  # @blueprint',
      '  # @param [Float] value',
      '  # @return [Float]',
      '  def self.triple(value)',
      '    value * 3',
      '  end',
      'end',
      '',
      '# @blueprint pure',
      '# @param [String] name',
      '# @return [String]',
      'def shout(name)',
      '  name.upcase + "!"',
      'end',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(workDir, 'lib', 'scores.rb'), scores);
    const registry = new NodeRegistry();
    registry.registerMany(exposeFunctions(scanRuby(scores), { language: 'ruby', path: 'lib/scores.rb', exposeAll: false }).definitions);
    const graph = {
      ...doc([
        node('s', 'core:event.start'), node('t', 'fn:ruby:lib/scores.rb#Scores.triple', { 'pin:value': 14 }), node('p', 'core:console.print'),
        node('shout', 'fn:ruby:lib/scores.rb#shout', { 'pin:name': 'done' }), node('p2', 'core:console.print')
      ], [
        wire('s', 'execOut', 't', 'execIn'), wire('t', 'execOut', 'p', 'execIn'), wire('t', 'returnValue', 'p', 'value'),
        wire('p', 'execOut', 'p2', 'execIn'), wire('shout', 'returnValue', 'p2', 'value')
      ]),
      name: 'Level', language: 'ruby'
    };
    const result = compileDocument(graph, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Level.vgraph', outputDir: 'game' } });
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.output!.text, /^require_relative "\.\.\/lib\/scores"$/m);
    assert.match(result.output!.text, /Scores\.triple\(14\)/);
    const file = path.join(workDir, 'game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    for (const companion of result.output!.companionFiles ?? []) fs.writeFileSync(path.join(workDir, 'game', companion.fileName), companion.text);

    let run;
    try {
      run = await runGeneratedCode(rubyPack.generator!.runner!, file, result.output!.className, { cwd: workDir, timeoutMs: 60000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.deepEqual(run.stdout.trim().split(/\r?\n/), ['42', 'DONE!'], run.stderr);
  });
});

// Classes (docs/node-authoring.md, gap 2): initialize, instance methods and attr_accessor, used
// through Target pins; a subclass's object where its base is expected.
describe('Ruby code classes', () => {
  test('a graph constructs them and uses their members', async (t) => {
    const dir = path.join(workDir, 'classes');
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
    const counter = [
      'class Counter',
      '  # @blueprint',
      '  # @return [Float]',
      '  attr_accessor :count',
      '',
      '  # @blueprint',
      '  # @param [Float] start',
      '  def initialize(start)',
      '    @count = start',
      '  end',
      '',
      '  # @blueprint',
      '  # @param [Float] amount',
      '  # @return [Float]',
      '  def add(amount)',
      '    @count += amount',
      '  end',
      '',
      '  # @blueprint pure',
      '  # @return [Float]',
      '  def doubled',
      '    @count * 2',
      '  end',
      'end',
      '',
      'class BigCounter < Counter',
      '  # @blueprint',
      '  # @param [Float] start',
      '  def initialize(start)',
      '    super(start * 10)',
      '  end',
      'end',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'lib', 'counter.rb'), counter);
    const definitions = exposeFunctions(scanRuby(counter), { language: 'ruby', path: 'lib/counter.rb', exposeAll: false }).definitions;
    const registry = new NodeRegistry();
    registry.registerMany(definitions);
    const result = compileDocument(codeClassGraph(definitions, 'ruby'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Counting.vgraph', outputDir: 'game' } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    for (const companion of result.output!.companionFiles ?? []) fs.writeFileSync(path.join(dir, 'game', companion.fileName), companion.text);
    let run;
    try {
      run = await runGeneratedCode(rubyPack.generator!.runner!, file, result.output!.className, { cwd: dir, timeoutMs: 60000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.deepEqual(run.stdout.trim().split(/\r?\n/), CODE_CLASS_OUTPUT, run.stderr);
  });
});

// Several outputs (docs/node-authoring.md, gap 3): a fixed array, named by @outputs.
describe('Ruby several outputs', () => {
  test('a graph reads each element of a returned array', async (t) => {
    const dir = path.join(workDir, 'outputs');
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
    const arithmetic = [
      'module Arithmetic',
      '  # @blueprint',
      '  # @param [Integer] a',
      '  # @param [Integer] b',
      '  # @return [Array(Integer, Integer)]',
      '  # @outputs quotient remainder',
      '  def self.divide(a, b)',
      '    [a / b, a % b]',
      '  end',
      'end',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'lib', 'arithmetic.rb'), arithmetic);
    const definitions = exposeFunctions(scanRuby(arithmetic), { language: 'ruby', path: 'lib/arithmetic.rb', exposeAll: false }).definitions;
    const registry = new NodeRegistry();
    registry.registerMany(definitions);
    const result = compileDocument(severalOutputsGraph(definitions, 'ruby'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Dividing.vgraph', outputDir: 'game' } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    for (const companion of result.output!.companionFiles ?? []) fs.writeFileSync(path.join(dir, 'game', companion.fileName), companion.text);
    let run;
    try {
      run = await runGeneratedCode(rubyPack.generator!.runner!, file, result.output!.className, { cwd: dir, timeoutMs: 60000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.deepEqual(run.stdout.trim().split(/\r?\n/), SEVERAL_OUTPUTS_OUTPUT, run.stderr);
  });
});

// Async functions (docs/node-authoring.md, gap 4): a method returning a Thread is a latent node; the
// latent queue waits for the thread, and Completed runs with its value.
describe('Ruby async functions', () => {
  const remote = (result: string) => [
    'module Remote',
    '  # @blueprint',
    '  # @param [Integer] value',
    '  # @return [Thread<Integer>]',
    '  def self.fetch_double(value)',
    '    Thread.new do',
    '      sleep(0.01)',
    `      ${result}`,
    '    end',
    '  end',
    'end',
    ''
  ].join('\n');

  async function run(name: string, code: string): Promise<{ run?: Awaited<ReturnType<typeof runGeneratedCode>>; skipped?: string; text: string }> {
    const dir = path.join(workDir, name);
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'remote.rb'), code);
    const definitions = exposeFunctions(scanRuby(code), { language: 'ruby', path: 'lib/remote.rb', exposeAll: false }).definitions;
    const registry = new NodeRegistry();
    registry.registerMany(definitions);
    const result = compileDocument(latentCodeGraph(definitions, 'ruby'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Fetching.vgraph', outputDir: 'game' } });
    assert.deepEqual(result.diagnostics, []);
    const file = path.join(dir, 'game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    for (const companion of result.output!.companionFiles ?? []) fs.writeFileSync(path.join(dir, 'game', companion.fileName), companion.text);
    try {
      return { run: await runGeneratedCode(rubyPack.generator!.runner!, file, result.output!.className, { cwd: dir, timeoutMs: 60000 }), text: result.output!.text };
    } catch (error) {
      if (error instanceof ToolNotFoundError) return { skipped: error.message, text: result.output!.text };
      throw error;
    }
  }

  test('a graph waits for a Thread and reads its value on Completed', async (t) => {
    const { run: outcome, skipped, text } = await run('latent', remote('value * 2'));
    assert.match(text, /Vg\.await_latent\(.*fetch_double\(4\)\) do \|vg_value\|/);
    if (!outcome) return t.skip(skipped);
    assert.deepEqual(outcome.stdout.trim().split(/\r?\n/), LATENT_CODE_OUTPUT, outcome.stderr);
  });

  test("an exception in the Thread stops the run, and Completed doesn't run", async (t) => {
    const { run: outcome, skipped } = await run('latent-fails', remote('raise "no double for #{value}"'));
    if (!outcome) return t.skip(skipped);
    assert.notEqual(outcome.exitCode, 0);
    assert.match(`${outcome.stdout}\n${outcome.stderr}`, /no double for 4/);
    assert.deepEqual(outcome.stdout.trim().split(/\r?\n/), ['started']);
  });
});
