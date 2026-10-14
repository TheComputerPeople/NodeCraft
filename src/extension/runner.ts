// Runs generated code with the project's own toolchain (node, python, ...), as a language pack's
// runner describes. Kept free of the vscode API so the conformance tests use the same code.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodeRunner, RunContext } from '../core/language-pack';

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
  // Absolute folders where the runtime finds imported project modules (GeneratedCode.importRoots).
  importRoots?: string[];
  // Project source files compiled with the generated file (RunContext.sources).
  sources?: string[];
  // Used instead of the runner's candidates, e.g. from a setting.
  command?: string[];
  timeoutMs?: number;
  // Aborting kills the process (e.g. when the same graph is run again).
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export async function runGeneratedCode(runner: CodeRunner, filePath: string, className: string, options: RunOptions): Promise<RunOutcome> {
  const file = { path: filePath, url: pathToFileURL(filePath).href };
  const candidates = options.command?.length ? [options.command] : runner.commands(process.platform);
  for (const candidate of candidates) {
    const context: RunContext = { importRoots: options.importRoots, sources: options.sources };
    if (runner.probe) {
      const probe = await runCommand([...candidate, ...runner.probe.args], { cwd: options.cwd, env: runner.env, timeoutMs: 30000 });
      if (!probe) continue;
      Object.assign(context, runner.probe.parse(probe.stdout) ?? {});
    }
    if (runner.scaffold) {
      context.scaffoldDir = scaffoldDir(filePath);
      writeScaffold(context.scaffoldDir, runner.scaffold(file, className, context));
    }
    const outcome = await runCommand([...candidate, ...runner.args(file, className, context)], { ...options, env: runner.env });
    if (outcome) return outcome;
  }
  throw new ToolNotFoundError(runner.missingToolMessage);
}

// A scratch folder per generated file, kept between runs so builds stay incremental.
function scaffoldDir(filePath: string): string {
  const hash = createHash('sha1').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'blueprint-visual-scripting', 'run', hash);
}

// Writes the files that changed, so an unchanged project isn't rebuilt.
export function writeScaffold(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  }
}

// Resolves undefined when the executable doesn't exist, so the next candidate can be tried.
export function runCommand(command: string[], options: RunOptions & { env?: Record<string, string> }): Promise<RunOutcome | undefined> {
  return new Promise((resolve) => {
    const [executable, ...args] = command;
    // Python on Windows otherwise writes in the console code page, garbling non-ASCII output.
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(options.env ?? {}) };
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
