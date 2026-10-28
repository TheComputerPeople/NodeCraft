// The Lua pack's support module (src/core/languages/lua-runtime.ts, docs/more-languages.md): numbers
// print as JavaScript prints them, the one rule the conformance fixtures can't cover case by case.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { scanLua } from '../../src/core/importing/lua-scanner';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';
import { luaPack, luaPlacement } from '../../src/core/languages/lua';
import { LUA_RUNTIME_FILE, luaRuntime } from '../../src/core/languages/lua-runtime';
import { NodeRegistry } from '../../src/core/registry';
import { ToolNotFoundError, runCommand, runGeneratedCode } from '../../src/extension/runner';
import { doc, node, wire } from '../unit/helpers';
import { CODE_CLASS_OUTPUT, codeClassGraph } from './code-classes';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-lua-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

const NUMBERS = [0, 1, -1, 0.1, 0.30000000000000004, 1 / 3, -2 / 3, 100, 123.456, 1e-6, 1e-7, 1.5e-7, 1e20, 1e21, 1.25e21, 2 ** 53, 2 ** 53 + 2, 5e-324, 1.7976931348623157e308, 123456789.123];

describe('Lua runtime', () => {
  test('formats numbers as JavaScript does', async (t) => {
    fs.writeFileSync(path.join(workDir, LUA_RUNTIME_FILE), luaRuntime());
    // Integers stay Lua integers, as generated code keeps them; the rest are floats.
    const literal = (x: number) => (Number.isInteger(x) && Math.abs(x) < 2 ** 63 && !Object.is(x, -0) ? String(BigInt(x)) : `${x.toPrecision(17)}`);
    const script = [
      `package.path = ${JSON.stringify(`${workDir.replace(/\\/g, '/')}/?.lua`)} .. ";" .. package.path`,
      'local vg = require("vgraph_runtime")',
      ...NUMBERS.map((x) => `print(vg.format_number(${literal(x)}))`),
      'print(vg.format_number(-0.0), vg.format_number(0 / 0), vg.format_number(-math.huge), vg.format_number(1e308 * 10))'
    ].join('\n');
    fs.writeFileSync(path.join(workDir, 'numbers.lua'), script);
    const outcome = await runCommand(['lua', path.join(workDir, 'numbers.lua')], { cwd: workDir, timeoutMs: 30000 });
    if (!outcome) return t.skip('Lua was not found');
    assert.equal(outcome.stderr, '');
    const lines = outcome.stdout.replace(/\r\n/g, '\n').trimEnd().split('\n');
    assert.deepEqual(lines, [...NUMBERS.map((x) => String(x)), ['0', 'NaN', '-Infinity', 'Infinity'].join('\t')]);
  });
});

// Placement and symbol import: a graph in game/ calls a ---@blueprint function of lib/scores.lua.
describe('Lua projects', () => {
  test('placement keeps the support module at the workspace folder while it has Lua graphs', () => {
    const files = new Map<string, string>();
    const context = (generatedFiles: string[]) => ({ generatedFiles, readFile: (file: string) => files.get(file), exists: (file: string) => files.has(file) });
    assert.deepEqual(luaPlacement(context(['game/score_vgraph.lua'])).ownedFiles, [{ path: LUA_RUNTIME_FILE, text: luaRuntime() }]);
    files.set(LUA_RUNTIME_FILE, luaRuntime());
    assert.deepEqual(luaPlacement(context([])).ownedFiles, [{ path: LUA_RUNTIME_FILE, text: '' }], 'the last Lua graph gone: it goes too');
    files.set(LUA_RUNTIME_FILE, '-- the project\'s own\n');
    assert.deepEqual(luaPlacement(context([])), {}, "a file of that name that isn't the extension's stays");
  });

  test('a graph calls a project function, and runs with Run and with a plain lua', async (t) => {
    const root = path.join(workDir, 'project');
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'game'), { recursive: true });
    const scores = ['local M = {}', '', '---@blueprint', '---@param value number', '---@return number', 'function M.triple(value)', '  return value * 3', 'end', '', 'return M', ''].join('\n');
    fs.writeFileSync(path.join(root, 'lib', 'scores.lua'), scores);
    const registry = new NodeRegistry();
    registry.registerMany(exposeFunctions(scanLua(scores), { language: 'lua', path: 'lib/scores.lua', exposeAll: false }).definitions);
    const graph = {
      ...doc([node('s', 'core:event.start'), node('t', 'fn:lua:lib/scores.lua#triple', { 'pin:value': 14 }), node('p', 'core:console.print')],
        [wire('s', 'execOut', 't', 'execIn'), wire('t', 'execOut', 'p', 'execIn'), wire('t', 'returnValue', 'p', 'value')]),
      name: 'Score', language: 'lua'
    };
    const result = compileDocument(graph, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Score.vgraph', outputDir: 'game' } });
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.output!.text, /^local scores = require\("lib\.scores"\)$/m);
    const file = path.join(root, 'game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    for (const owned of luaPlacement({ generatedFiles: ['game/score_vgraph.lua'], readFile: () => undefined, exists: () => false }).ownedFiles ?? []) fs.writeFileSync(path.join(root, owned.path), owned.text);

    const run = await runGeneratedCode(luaPack.generator!.runner!, file, result.output!.className, { cwd: root, importRoots: [root], timeoutMs: 30000 }).catch(() => undefined);
    if (!run) return t.skip('Lua was not found');
    assert.equal(run.stdout.trim(), '42', run.stderr);
    // Without the extension: the support module placement keeps, and the modules' paths from the folder.
    const plain = await runCommand(['lua', '-e', 'package.path = "./?.lua;" .. package.path; require("game.score_vgraph").new():start()'], { cwd: root, timeoutMs: 30000 });
    assert.equal(plain?.stdout.trim(), '42', plain?.stderr);
  });
});

// Classes (docs/node-authoring.md, gap 2): ---@class tables in the module's table, their `:` methods,
// `.new` constructor and @blueprint ---@fields. Lua has no inheritance here, so BigCounter is a
// class of its own with its own Add.
describe('Lua code classes', () => {
  test('a graph constructs them and uses their members', async (t) => {
    const root = path.join(workDir, 'classes');
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'game'), { recursive: true });
    const counter = [
      'local M = {}',
      '',
      '---@class Counter',
      '---@field count number @blueprint',
      'local Counter = {}',
      'Counter.__index = Counter',
      '',
      '---@blueprint',
      '---@param start number',
      '---@return Counter',
      'function Counter.new(start)',
      '  return setmetatable({ count = start }, Counter)',
      'end',
      '',
      '---@blueprint',
      '---@param amount number',
      '---@return number',
      'function Counter:add(amount)',
      '  self.count = self.count + amount',
      '  return self.count',
      'end',
      '',
      '---@blueprint pure',
      '---@return number',
      'function Counter:doubled()',
      '  return self.count * 2',
      'end',
      '',
      '---@class BigCounter',
      'local BigCounter = {}',
      'BigCounter.__index = BigCounter',
      '',
      '---@blueprint',
      '---@param start number',
      'function BigCounter.new(start)',
      '  return setmetatable({ count = start * 10 }, BigCounter)',
      'end',
      '',
      '---@blueprint',
      '---@param amount number',
      '---@return number',
      'function BigCounter:add(amount)',
      '  self.count = self.count + amount',
      '  return self.count',
      'end',
      '',
      'M.Counter = Counter',
      'M.BigCounter = BigCounter',
      'return M',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(root, 'lib', 'counter.lua'), counter);
    const definitions = exposeFunctions(scanLua(counter), { language: 'lua', path: 'lib/counter.lua', exposeAll: false }).definitions;
    const registry = new NodeRegistry();
    registry.registerMany(definitions);
    const result = compileDocument(codeClassGraph(definitions, 'lua'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Counting.vgraph', outputDir: 'game' } });
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.output!.text, /counter\.Counter\.new\(5\)/);
    const file = path.join(root, 'game', result.output!.fileName);
    fs.writeFileSync(file, result.output!.text);
    for (const owned of luaPlacement({ generatedFiles: [`game/${result.output!.fileName}`], readFile: () => undefined, exists: () => false }).ownedFiles ?? []) fs.writeFileSync(path.join(root, owned.path), owned.text);
    let run;
    try {
      run = await runGeneratedCode(luaPack.generator!.runner!, file, result.output!.className, { cwd: root, timeoutMs: 60000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.deepEqual(run.stdout.trim().split(/\r?\n/), CODE_CLASS_OUTPUT, run.stderr);
  });
});
