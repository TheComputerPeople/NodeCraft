// Each language's debugger launch configuration runs the generated code as Run does
// (docs/debugging.md, "Debugging generated code"). The debuggers themselves are exercised by
// `npm run test:integration:debuggers`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinLanguagePacks } from '../../src/core/languages';

const file = { path: '/work/game/Game.vgraph.x', url: 'file:///work/game/Game.vgraph.x' };
const context = { cwd: '/work/game', mainMethod: 'main', args: ['--fast'], importRoots: ['/work/lib'] };

function debuggerFor(language: string) {
  const generator = builtinLanguagePacks().get(language)?.generator;
  assert.ok(generator?.debugger, `${language} has a debugger`);
  return { generator, debugger: generator.debugger };
}

describe('debug configurations', () => {
  for (const language of ['javascript', 'typescript']) {
    test(`${language}: js-debug runs Run's node command`, () => {
      const { generator, debugger: d } = debuggerFor(language);
      const config = d.configuration(file, 'Game', context);
      assert.equal(d.type, 'node');
      assert.equal(d.extension, undefined, 'js-debug is built into VS Code');
      assert.deepEqual(config.runtimeArgs, generator.runner!.args(file, 'Game', context));
      assert.equal(config.runtimeExecutable, 'node');
      assert.equal(config.cwd, '/work/game');
      assert.deepEqual(d.configuration(file, 'Game', { ...context, command: ['/opt/node22', '--no-warnings'] }).runtimeExecutable, '/opt/node22');
    });
  }

  test('python: debugpy runs the code Run passes to python -c', () => {
    const { generator, debugger: d } = debuggerFor('python');
    const config = d.configuration(file, 'Game', context);
    assert.equal(d.extension?.id, 'ms-python.debugpy');
    assert.equal(config.type, 'debugpy');
    assert.equal(config.code, generator.runner!.args(file, 'Game', context)[1]);
    assert.match(String(config.code), /sys\.path\[:0\] = \["\/work\/lib"\]/);
    assert.match(String(config.code), /o\.main\(\["--fast"\]\)/);
    assert.equal(config.python, undefined, 'the Python extension picks the interpreter');
    assert.equal(d.configuration(file, 'Game', { ...context, command: ['/usr/bin/python3.12'] }).python, '/usr/bin/python3.12');
  });

  test('cpp: cppdbg runs the scaffold Run builds, with gdb (lldb on macOS)', () => {
    const { generator, debugger: d } = debuggerFor('cpp');
    const scaffold = { ...context, scaffoldDir: '/tmp/run', platform: 'linux' };
    assert.equal(d.extension?.id, 'ms-vscode.cpptools');
    assert.deepEqual(d.build!(file, 'Game', scaffold), generator.runner!.build!(file, 'Game', scaffold));
    assert.ok(d.build!(file, 'Game', scaffold).includes('-g'), 'with debug information');
    const config = d.configuration(file, 'Game', scaffold);
    assert.equal(config.type, 'cppdbg');
    assert.equal(config.program, '/tmp/run/run');
    assert.equal(config.MIMode, 'gdb');
    assert.deepEqual(config.args, ['--fast']);
    assert.equal(d.configuration(file, 'Game', { ...scaffold, platform: 'darwin' }).MIMode, 'lldb');
    assert.equal(d.configuration(file, 'Game', { ...scaffold, platform: 'win32' }).program, '/tmp/run/run.exe');
  });

  test('csharp: coreclr runs Run\'s project, built in Debug first', () => {
    const { debugger: d } = debuggerFor('csharp');
    const scaffold = { ...context, scaffoldDir: '/tmp/run', targetFramework: 'net9.0' };
    assert.equal(d.extension?.id, 'ms-dotnettools.csharp');
    assert.deepEqual(d.build!(file, 'Game', scaffold).slice(0, 4), ['build', '/tmp/run/BlueprintRun.csproj', '-c', 'Debug']);
    const config = d.configuration(file, 'Game', scaffold);
    assert.equal(config.type, 'coreclr');
    assert.equal(config.program, '/tmp/run/bin/Debug/net9.0/BlueprintRun.dll');
    assert.deepEqual(config.args, ['Game', 'main', '--fast']);
  });
});
