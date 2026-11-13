// Each language's debugger launch configuration runs the generated code as Run does
// (docs/debugging.md, "Debugging generated code"). The debuggers themselves are exercised by
// `npm run test:integration:debuggers`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { debuggerOn } from '../../src/core/language-pack';
import { builtinLanguagePacks } from '../../src/core/languages';
import { unsubstituted } from '../../src/core/debug-configuration';

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

  test('java: the Debugger for Java runs the launcher Run builds, with debug information', () => {
    const { generator, debugger: d } = debuggerFor('java');
    const scaffold = { ...context, scaffoldDir: '/tmp/run', platform: 'linux', importRoots: ['/work/src/main/java'] };
    assert.equal(d.extension?.id, 'vscjava.vscode-java-debug');
    assert.deepEqual(d.build!(file, 'game.Game', scaffold), generator.runner!.build!(file, 'game.Game', scaffold));
    assert.ok(d.build!(file, 'game.Game', scaffold).includes('-g'), 'with debug information');
    assert.deepEqual(d.build!(file, 'game.Game', scaffold).slice(7, 9), ['-sourcepath', '/work/src/main/java']);
    const config = d.configuration(file, 'game.Game', scaffold);
    assert.equal(config.type, 'java');
    assert.equal(config.mainClass, 'BlueprintRun');
    assert.deepEqual(config.classPaths, ['/tmp/run/classes']);
    assert.deepEqual(config.sourcePaths, ['/work/game', '/work/src/main/java'], "the generated file's folder and the source roots");
    assert.deepEqual(config.args, ['game.Game', 'main', '--fast']);
    assert.equal(d.displayValue!('30.0'), '30');
    assert.equal(d.displayValue!('0.5'), '0.5');
  });

  test('go: Delve runs the program Run builds without optimizations, mapped back to the generated file', () => {
    const { debugger: d } = debuggerFor('go');
    const scaffold = { ...context, scaffoldDir: '/tmp/run', platform: 'linux' };
    assert.equal(d.extension?.id, 'golang.go');
    assert.ok(d.build!(file, 'game.Game', scaffold).includes('-gcflags=all=-N -l'));
    const config = d.configuration(file, 'game.Game', scaffold);
    assert.equal(config.type, 'go');
    assert.equal(config.mode, 'exec');
    assert.equal(config.program, '/tmp/run/run');
    assert.deepEqual(config.substitutePath, [{ from: '/work/game', to: '/tmp/run/vg' }]);
  });

  test("rust: CodeLLDB (the Visual Studio debugger on Windows) runs the program Run's Cargo project builds", () => {
    const { debugger: d } = debuggerFor('rust');
    const scaffold = { ...context, scaffoldDir: '/tmp/run', platform: 'linux' };
    assert.deepEqual(debuggerOn(d, 'linux'), { type: 'lldb', extension: { id: 'vadimcn.vscode-lldb', name: 'CodeLLDB' } });
    assert.deepEqual(debuggerOn(d, 'win32'), { type: 'cppvsdbg', extension: { id: 'ms-vscode.cpptools', name: 'C/C++' } });
    assert.deepEqual(d.build!(file, 'Game', scaffold), ['build', '--quiet', '--manifest-path', '/tmp/run/Cargo.toml']);
    const config = d.configuration(file, 'Game', scaffold);
    assert.equal(config.type, 'lldb');
    assert.equal(config.program, '/tmp/run/target/debug/blueprint_run');
    assert.deepEqual(config.args, ['--fast']);
    const windows = d.configuration(file, 'Game', { ...scaffold, platform: 'win32' });
    assert.equal(windows.type, 'cppvsdbg');
    assert.equal(windows.program, '/tmp/run/target/debug/blueprint_run.exe');
  });

  // docs/audit.md, third pass: godot-tools starts Godot through a shell, with the options as given.
  test('gdscript: the options are quoted for the shell, and what cmd can\'t take is refused', () => {
    const { debugger: d } = debuggerFor('gdscript');
    const godot = { ...context, scaffoldDir: '/tmp/run', projectDir: '/work/game', command: ['/opt/godot'] };
    const posix = d.configuration(file, 'Game', { ...godot, args: ["it's", '$HOME'], platform: 'linux' });
    assert.equal(posix.additional_options, "--headless --no-header --script '/tmp/run/run.gd' -- 'it'@''s' '$HOME'".replace('@', String.fromCharCode(92)));
    const windows = d.configuration(file, 'Game', { ...godot, args: ['a & b'], platform: 'win32' });
    assert.equal(windows.additional_options, '--headless --no-header --script "/tmp/run/run.gd" -- "a & b"');
    assert.throws(() => d.configuration(file, 'Game', { ...godot, args: ['50%'], platform: 'win32' }), /can't pass the argument "50%"/);
    assert.throws(() => d.configuration(file, 'Game', { ...godot, projectDir: '/work/$(id)', platform: 'linux' }), /can't use the Godot project's folder/);
  });

  // docs/audit.md, third pass: VS Code substitutes ${...}; Debug passes what Run does.
  test('the strings written with ${...} are put back after VS Code resolves them', () => {
    const written = { type: 'php', args: ['${userHome}', 'plain'], env: { XDEBUG_CONFIG: 'client_port=${port}', OTHER: 'x' }, cwd: '/work/${dir}' };
    const resolved = { type: 'php', args: ['/home/me', 'plain'], env: { XDEBUG_CONFIG: 'client_port=${port}', OTHER: 'x' }, cwd: '/work/', added: 'by the debugger' };
    assert.deepEqual(unsubstituted(resolved, written), { ...written, added: 'by the debugger' });
  });
});
