// Ending a run (src/extension/runner.ts, docs/audit.md step 2): Stop, a re-run and a timeout end
// the program, not only the launcher that started it, as `dotnet run`, `cargo run`, `py -3`, `cmd /c`
// and Godot's console executable start the program as their child. The launcher here is node
// starting a node that sleeps. On Windows node, like dotnet, cargo, py and Godot, ends what it
// started when it's killed, which `cmd` doesn't; there the launcher starts the program outside its
// job (detached), as `cmd` would leave it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand } from '../../src/extension/runner';

// A launcher whose child (the "program") sleeps for 30 seconds; the child's pid goes to `pidFile`.
function launcher(pidFile: string): string[] {
  const program = 'setTimeout(() => {}, 30000)';
  const script = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(program)}], { stdio: 'ignore', detached: ${process.platform === 'win32'} });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
c.on('exit', (code) => process.exit(code ?? 1));`;
  return [process.execPath, '-e', script];
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(condition: () => boolean, what: string, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function ended(how: 'abort' | 'timeout'): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-runner-'));
  const pidFile = path.join(dir, 'pid');
  let pid: number | undefined;
  try {
    const controller = new AbortController();
    const running = runCommand(launcher(pidFile), { cwd: dir, ...(how === 'abort' ? { signal: controller.signal } : { timeoutMs: 1500 }) });
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', 'the program to start');
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(alive(pid), 'the program is running');
    if (how === 'abort') controller.abort();
    const outcome = await running;
    assert.ok(outcome, 'node ran');
    assert.equal(how === 'abort' ? outcome.aborted : outcome.timedOut, true);
    await until(() => !alive(pid!), 'the program to end');
  } finally {
    if (pid !== undefined && alive(pid)) process.kill(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("aborting a run (Stop, or running again) ends the launcher's program too", () => ended('abort'));

test("a run's timeout ends the launcher's program too", () => ended('timeout'));

test('a run aborted before it starts starts nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = await runCommand([process.execPath, '-e', 'process.exit(3)'], { cwd: os.tmpdir(), signal: controller.signal });
  assert.deepEqual(outcome && { aborted: outcome.aborted, exitCode: outcome.exitCode }, { aborted: true, exitCode: null });
});

test('a missing executable is undefined, so the next candidate is tried', async () => {
  assert.equal(await runCommand(['vg-no-such-tool-anywhere'], { cwd: os.tmpdir() }), undefined);
});
