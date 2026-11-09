// Runs generated code with the project's own toolchain (node, python, ...), as a language pack's
// runner describes. Kept free of the vscode API so the conformance tests use the same code.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodeDebugger, CodeRunner, RunContext } from '../core/language-pack';

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
  // The project crate the code calls into (RunContext.crate, Rust).
  crate?: { src: string; modules: string[]; name?: string };
  // The project's module (RunContext.goModule, Go).
  goModule?: { path: string; dir: string };
  // The graph's Godot project (RunContext.projectDir, GDScript).
  projectDir?: string;
  // The class's Main method, and the program's command-line arguments for it.
  mainMethod?: string;
  args?: string[];
  // Used instead of the runner's candidates, e.g. from a setting.
  command?: string[];
  timeoutMs?: number;
  // Aborting kills the process (e.g. when the same graph is run again).
  signal?: AbortSignal;
  // Runs the class's tests (CodeRunner.testArgs) instead of Start and Main.
  tests?: { testFile?: string; cases: { name: string; method: string }[] };
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export async function runGeneratedCode(runner: CodeRunner, filePath: string, className: string, options: RunOptions): Promise<RunOutcome> {
  const file = { path: filePath, url: pathToFileURL(filePath).href };
  const candidates = options.command?.length ? [options.command] : runner.commands(process.platform);
  for (const candidate of candidates) {
    const context: RunContext = { importRoots: options.importRoots, sources: options.sources, crate: options.crate, goModule: options.goModule, projectDir: options.projectDir, mainMethod: options.mainMethod, args: options.args, platform: process.platform };
    if (runner.probe) {
      const probe = await runCommand([...candidate, ...runner.probe.args], { cwd: options.cwd, env: runner.env, timeoutMs: 30000 });
      if (!probe) continue;
      Object.assign(context, runner.probe.parse(probe.stdout) ?? {});
    }
    if (runner.scaffold) {
      context.scaffoldDir = scaffoldDir(filePath);
      writeScaffold(context.scaffoldDir, runner.scaffold(file, className, context));
    }
    // A language that builds first: a failed build is the run's outcome, with the compiler's output.
    let program = candidate;
    if (runner.build) {
      const built = await runCommand([...candidate, ...runner.build(file, className, context)], { cwd: options.cwd, env: runner.env, timeoutMs: options.timeoutMs, signal: options.signal });
      if (!built) continue;
      if (built.exitCode !== 0 || built.aborted) {
        options.onStderr?.(built.stdout + built.stderr);
        return { ...built, stdout: '', stderr: built.stdout + built.stderr };
      }
      if (runner.executable) program = [runner.executable(file, className, context)];
    }
    const args = options.tests
      ? runner.testArgs?.(file, className, { ...context, testFile: options.tests.testFile, tests: options.tests.cases }) ?? []
      : runner.args(file, className, context);
    const outcome = await runCommand([...program, ...args], { ...options, env: runner.env });
    if (outcome) return outcome;
  }
  throw new ToolNotFoundError(runner.missingToolMessage);
}

// Building the code for the debugger failed; the message is the build's output.
export class BuildError extends Error {}

// Gets generated code ready for a debugger as Run would run it (the runner's probe and scaffold),
// building it first when the debugger needs that (C#). Returns what the launch configuration needs.
export async function prepareDebugging(runner: CodeRunner, codeDebugger: CodeDebugger, filePath: string, className: string, options: RunOptions): Promise<RunContext> {
  const file = { path: filePath, url: pathToFileURL(filePath).href };
  const base: RunContext = { importRoots: options.importRoots, sources: options.sources, crate: options.crate, goModule: options.goModule, projectDir: options.projectDir, mainMethod: options.mainMethod, args: options.args };
  if (!runner.probe && !runner.scaffold && !codeDebugger.build) return base;
  const candidates = options.command?.length ? [options.command] : runner.commands(process.platform);
  for (const candidate of candidates) {
    const context: RunContext = { ...base, platform: process.platform };
    if (runner.probe) {
      const probe = await runCommand([...candidate, ...runner.probe.args], { cwd: options.cwd, env: runner.env, timeoutMs: 30000 });
      if (!probe) continue;
      Object.assign(context, runner.probe.parse(probe.stdout) ?? {});
    }
    if (runner.scaffold) {
      context.scaffoldDir = scaffoldDir(filePath);
      writeScaffold(context.scaffoldDir, runner.scaffold(file, className, context));
    }
    if (!codeDebugger.build) return context;
    const built = await runCommand([...candidate, ...codeDebugger.build(file, className, context)], { ...options, env: runner.env });
    if (!built) continue;
    if (built.exitCode !== 0) throw new BuildError(`${built.stdout}${built.stderr}`.trim() || `The build failed (exit code ${built.exitCode}).`);
    return context;
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
    // Set inside a node --test run; it makes a nested node --test report to it instead of printing.
    delete env.NODE_TEST_CONTEXT;
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
