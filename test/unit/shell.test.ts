// Arguments for a command line a shell reads (src/core/shell.ts): godot-tools starts Godot through
// one (docs/audit.md, third pass).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { safeInDoubleQuotes, shellArgument } from '../../src/core/shell';

// Text a shell would change if it weren't quoted, or that's hard to quote.
const ARGUMENTS = ['plain', 'two words', "it's", '$HOME', '`echo hi`', '$(echo hi)', 'a & b', 'x | y', '<in>', '^caret', '!bang', '(paren)', 'C:@dir@', 'C:@dir@@', 'tab' + String.fromCharCode(9) + 'here', '*.ts', ''].map((a) => a.replace(/@/g, String.fromCharCode(92)));

describe('shell arguments', () => {
  test('sh: each in single quotes, a quote in it closed and escaped', () => {
    assert.equal(shellArgument("it's", 'linux'), "'it'@''s'".replace('@', String.fromCharCode(92)));
    assert.equal(shellArgument('$HOME', 'darwin'), "'$HOME'");
  });

  test("cmd: double quotes; a double quote, a percent sign or a line break can't be passed", () => {
    assert.equal(shellArgument('a & b', 'win32'), '"a & b"');
    assert.equal(shellArgument('say "hi"', 'win32'), undefined);
    assert.equal(shellArgument('50%', 'win32'), undefined);
    assert.equal(shellArgument('a' + String.fromCharCode(10) + 'b', 'win32'), undefined);
  });

  test('cmd: backslashes before the closing quote are doubled', () => {
    const bs = String.fromCharCode(92);
    assert.equal(shellArgument(`C:${bs}dir${bs}`, 'win32'), `"C:${bs}dir${bs}${bs}"`);
    assert.equal(shellArgument(`a${bs}b`, 'win32'), `"a${bs}b"`);
  });

  test("this platform's shell passes each argument as it is", () => {
    const quote = (text: string): string => shellArgument(text, process.platform)!;
    const line = [process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...ARGUMENTS].map(quote).join(' ');
    const result = spawnSync(line, { shell: true, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ARGUMENTS);
  });

  test('text between double quotes is read as it is only without what the shell reads there', () => {
    assert.equal(safeInDoubleQuotes('C:/Program Files/Godot.exe', 'win32'), true);
    assert.equal(safeInDoubleQuotes('C:/50%/Godot.exe', 'win32'), false);
    assert.equal(safeInDoubleQuotes('/opt/godot', 'linux'), true);
    assert.equal(safeInDoubleQuotes('/home/me/$(touch x)/project', 'linux'), false);
    assert.equal(safeInDoubleQuotes('/home/me/`id`/project', 'linux'), false);
  });
});
