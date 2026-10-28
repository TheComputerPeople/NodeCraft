// The Lua pack's support module (src/core/languages/lua-runtime.ts, docs/more-languages.md): numbers
// print as JavaScript prints them, the one rule the conformance fixtures can't cover case by case.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LUA_RUNTIME_FILE, luaRuntime } from '../../src/core/languages/lua-runtime';
import { runCommand } from '../../src/extension/runner';

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
