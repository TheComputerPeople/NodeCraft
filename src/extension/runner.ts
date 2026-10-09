// Runs generated code with the project's own toolchain (node, python, ...), as a language pack's
// runner describes. Kept free of the vscode API so the conformance tests use the same code.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CodeRunner } from '../core/language-pack';

export interface RunOutcome {
  // The command that ran, with its arguments.
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

// None of the runner's candidate commands could be started.
export class ToolNotFoundError extends Error {}

export interface RunOptions {
  cwd: string;
  // Used instead of the runner's candidates, e.g. from a setting.
  command?: string[];
  timeoutMs?: number;
  // Aborting kills the process (e.g. when the same graph is run again).
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export async function runGeneratedCode(runner: CodeRunner, filePath: string, className: string, options: RunOptions): Promise<RunOutcome> {
  const args = runner.args({ path: filePath, url: pathToFileURL(filePath).href }, className);
  const candidates = options.command?.length ? [options.command] : runner.commands(process.platform);
  for (const candidate of candidates) {
    const outcome = await runCommand([...candidate, ...args], options);
    if (outcome) return outcome;
  }
  throw new ToolNotFoundError(runner.missingToolMessage);
}

// Resolves undefined when the executable doesn't exist, so the next candidate can be tried.
function runCommand(command: string[], options: RunOptions): Promise<RunOutcome | undefined> {
  return new Promise((resolve) => {
    const [executable, ...args] = command;
    // Python on Windows otherwise writes in the console code page, garbling non-ASCII output.
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, args, { cwd: options.cwd, env, windowsHide: true, signal: options.signal });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs) : undefined;

    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
      options.onStderr?.(text);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') resolve(undefined);
      else if (error.name === 'AbortError') resolve({ command, exitCode: null, stdout, stderr, timedOut, aborted: true });
      else resolve({ command, exitCode: null, stdout, stderr: stderr + error.message, timedOut, aborted: false });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ command, exitCode, stdout, stderr, timedOut, aborted: options.signal?.aborted ?? false });
    });
  });
}
