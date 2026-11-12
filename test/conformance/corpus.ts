// The corpus of project layouts (docs/project-integration.md, part 3): small but real-shaped
// projects in test/fixtures/projects, each with graphs put where a user would put them. The harness
// copies a layout, scans its code for @blueprint functions, writes and compiles its graphs through
// the extension's own compile (src/extension/graph-compile.ts: placement, shared types' other
// languages, build registration as if the user accepted it, the project's checks), then runs the
// project's own build, checkers, tests and entry point. A tool that isn't installed is skipped, by
// name.
//
// In one layout of each language, the generated code of every node (the node audit's program) and of
// the conformance fixtures goes into the project too, so the checkers see all of it.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditCases, auditGraph } from '../../src/conformance/audit';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { SymbolFunction, scanSymbols } from '../../src/core/importing/language-server';
import { ModuleScan, exposeFunctions } from '../../src/core/importing/symbols';
import { LanguagePack, LanguagePackRegistry } from '../../src/core/language-pack';
import { libraryNodeType } from '../../src/core/libraries';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { GraphCompileHost, applyAcceptedPlan, compileGraphFile } from '../../src/extension/graph-compile';
import { codeModuleFor, cppHeaderLinkage, graphFileNodes } from '../../src/extension/placement';
import { repoRoot } from '../unit/helpers';
import { CODE_CLASS_OUTPUT, codeClassGraph } from './code-classes';
import { CODE_PARENTS_OUTPUT, actorCode, gameGraph, knightGraph } from './code-parents';
import { GENERICS_OUTPUT, genericsGraph } from './generics';
import { LATENT_CODE_OUTPUT, latentCodeGraph } from './latent-code';
import { SEVERAL_OUTPUTS_OUTPUT, severalOutputsGraph } from './several-outputs';

// The folder scripts/corpus-tools.js installs the Node.js tools into.
export function corpusToolsFolder(): string {
  if (process.env.BLUEPRINT_CORPUS_TOOLS) return process.env.BLUEPRINT_CORPUS_TOOLS;
  return process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'blueprint-corpus', 'node')
    : path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'blueprint-corpus', 'node');
}

export interface CorpusStep {
  // What it is, as the test reports it: "tsc", "ESLint", "mypy --strict", "run".
  name: string;
  // The command. "node_modules/..." runs a script of the corpus's Node.js tools with Node.js, and
  // "./..." a program the project built, in the step's folder.
  command: string[];
  // Its folder, relative to the project (the project by default).
  cwd?: string;
  env?: Record<string, string>;
  // The lines its output must have, in order (an entry point's).
  stdout?: string[];
  // Text its output (stdout and stderr) must have: a test runner's count of passed tests.
  includes?: string[];
  // Its stderr must be empty: an interpreter's warnings (Ruby's -w, PHP's E_ALL) fail it.
  quiet?: boolean;
  // It only checks (a linter, a type checker): the steps after it need nothing it makes, so they
  // still run when its tool is missing.
  check?: boolean;
  // Whether its tool is there: a command that succeeds when it is (the command's first word with
  // --version by default).
  probe?: string[];
  timeoutMs?: number;
}

export interface CorpusGraph {
  // Where a user would put it, relative to the project.
  path: string;
  // The graph, given the project code's nodes and the graphs before it.
  build: (context: GraphContext) => GraphDocument;
  // Its language, when it isn't the layout's (a layout of two languages).
  language?: string;
}

export interface GraphContext {
  // A node of the project's code, by function name.
  code: (name: string) => NodeDefinition;
  // Every node of the project's code.
  definitions: NodeDefinition[];
  // The node type of a function of a library graph before this one (its path in the layout).
  library: (graphPath: string, graphId: string) => string;
}

export interface Layout {
  // Its folder in test/fixtures/projects.
  name: string;
  language: string;
  // Files of the project's code with @blueprint functions, relative to the project.
  code: string[];
  graphs: CorpusGraph[];
  // Where the node audit's program and the conformance fixtures go, relative to the project: one
  // folder for each (audit, graphs, programs, tests).
  body?: string;
  // The body's programs (PROGRAMS by default): in C++, one target can't have both, whose classes
  // share names in the global namespace.
  programs?: string[];
  steps: CorpusStep[];
}

// Python's command.
export const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

export interface StepResult {
  step: string;
  status: 'passed' | 'failed' | 'skipped';
  // Why it was skipped, or what it printed when it failed.
  message?: string;
}

export interface LayoutResult {
  // Graphs that didn't compile (they fail the layout).
  compileErrors: string[];
  // Compile's warnings: placement, the project's version, build registration (they fail it too).
  warnings: string[];
  // Graphs of the body that use what the language doesn't have, and why.
  notApplicable: string[];
  // Generated files, relative to the project.
  generated: string[];
  steps: StepResult[];
}

const languages = builtinLanguagePacks();

// A folder for the layouts: the corpus's Node.js tools are its node_modules, which Node.js, tsc and
// ESLint find from each project below it, as a project finds its installed devDependencies (and a
// project's own node_modules, from pnpm install, comes first).
export function corpusWorkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-corpus-'));
  const tools = path.join(corpusToolsFolder(), 'node_modules');
  if (fs.existsSync(tools)) fs.symlinkSync(tools, path.join(dir, 'node_modules'), 'junction');
  return dir;
}

// Copies the layout into `workDir` and generates its graphs; then runs its steps.
export async function runLayout(layout: Layout, workDir: string): Promise<LayoutResult> {
  const { root, result } = await prepareLayout(layout, workDir);
  if (result.compileErrors.length) return result;
  result.steps = await runSteps(layout.steps, root);
  return result;
}

// Copies the layout into `workDir` and compiles its graphs into it, registering the generated files
// with the build as if every hook were accepted, or (register false) as if none had been answered
// yet: what Set Up in This Project finds in a project.
export async function prepareLayout(layout: Layout, workDir: string, options: { register?: boolean } = {}): Promise<{ root: string; result: LayoutResult }> {
  const root = path.join(workDir, layout.name);
  const source = path.join(repoRoot, 'test/fixtures/projects', layout.name);
  fs.cpSync(source, root, { recursive: true, filter: (file) => !buildOutput(file) });
  const result: LayoutResult = { compileErrors: [], warnings: [], notApplicable: [], generated: [], steps: [] };
  await generate(layout, root, result, options.register ?? true);
  return { root, result };
}

// Runs a project's steps in its folder. A step after one that didn't pass needs what that one makes
// (a build before its run), unless that one only checks and its tool is missing.
export async function runSteps(steps: CorpusStep[], root: string): Promise<StepResult[]> {
  const tools = corpusToolsFolder();
  const results: StepResult[] = [];
  for (const [i, step] of steps.entries()) {
    const before = results.find((s, j) => s.status === 'failed' || (s.status === 'skipped' && !steps[j].check));
    results.push(before && i > 0 ? { step: step.name, status: 'skipped', message: `${step.name}: ${before.step} didn't pass` } : await runStep(step, root, tools));
  }
  return results;
}

// Build output a tool or IDE may have left in the repository's copy of a layout: a folder named as
// a build system names its output, beside that build system's file (a C# restore's obj/ and bin/,
// Gradle's .gradle/ and build/, CMake's build/, Cargo's and Maven's target/, Godot's .godot/, Visual Studio's x64/ and .vs/). A Ruby
// project's bin/ is its own.
const BUILD_OUTPUT: Record<string, RegExp> = {
  obj: /\.csproj$/, bin: /\.csproj$/, '.gradle': /^(build|settings)\.gradle(\.kts)?$/,
  build: /^(build\.gradle(\.kts)?|CMakeLists\.txt)$/, target: /^(Cargo\.toml|pom\.xml)$/, '.godot': /^project\.godot$/, x64: /\.vcxproj$/, '.vs': /\.(sln|vcxproj)$/
};
function buildOutput(file: string): boolean {
  const beside = BUILD_OUTPUT[path.basename(file)];
  return !!beside && fs.statSync(file).isDirectory() && fs.readdirSync(path.dirname(file)).some((f) => beside.test(f));
}

// The layout's graphs and body, compiled as Compile compiles them.
async function generate(layout: Layout, root: string, result: LayoutResult, register: boolean): Promise<void> {
  const pack = languages.get(layout.language)!;
  const registry = new NodeRegistry();
  for (const file of ['sample/visual-nodes/Math/Double.node.json', 'test/fixtures/nodes/Fail.node.json']) registry.register(parseNodeDefinition(fs.readFileSync(path.join(repoRoot, file), 'utf8'))!);
  const code: NodeDefinition[] = [];
  for (const file of layout.code) {
    const scan = scanCode(layout.language, fs.readFileSync(path.join(root, file), 'utf8'));
    const linkage = pack.id === 'cpp' ? cppHeaderLinkage(path.join(root, file)) : undefined;
    // Its functions and members, and its classes (which graph classes may extend).
    const exposed = exposeFunctions(scan, { language: pack.id, path: file, module: codeModuleFor(pack.id, path.join(root, file), root), exposeAll: false, ...(linkage ? { linkage } : {}) });
    code.push(...exposed.definitions, ...exposed.classes);
  }
  registry.registerMany(code);
  const byName = (name: string): NodeDefinition => {
    const found = code.find((d) => d.implementation?.kind === 'function' && d.implementation.name.split('.').pop() === name);
    if (!found) throw new Error(`${layout.name}: no @blueprint function "${name}" in ${layout.code.join(', ')}`);
    return found;
  };
  const context: GraphContext = { code: byName, definitions: code, library: (graphPath, graphId) => libraryNodeType(graphPath, graphId) };
  const graphs: { file: string; doc: GraphDocument; body?: boolean }[] = layout.graphs.map((g) => ({ file: path.join(root, g.path), doc: { ...g.build(context), language: g.language ?? layout.language } }));
  if (layout.body) graphs.push(...body(layout, root).map((g) => ({ ...g, body: true })));
  // Types and libraries first, as the workspace knows them, then each graph compiled.
  const all = new LanguagePackRegistry(languages.all());
  for (const { file, doc } of graphs) registry.registerMany(graphFileNodes(doc, file, root, all) ?? []);
  const host: GraphCompileHost = {
    registry,
    languages: all,
    write: async (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      const relative = posix(path.relative(root, file));
      if (!result.generated.includes(relative)) result.generated.push(relative);
    },
    remove: async (file) => fs.rmSync(file, { force: true }),
    // As OutputPlans lists them: each graph of the pack's language, by its output file.
    register: async (other, folder, outputFile) => applyAcceptedPlan(other, folder, outputsOf(other), outputFile, register)
  };
  // Graphs left out: not applicable, or in a program that isn't.
  const dropped = new Set<string>();
  const outputsOf = (other: LanguagePack): string[] => graphs.filter((g) => g.doc.language === other.id && !dropped.has(g.file))
    .map((g) => path.join(path.dirname(g.file), other.generator!.outputFileName(path.basename(g.file))));
  for (const { file, doc, body: inBody } of graphs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    const compiled = await compileGraphFile(doc, file, root, host);
    const where = posix(path.relative(root, file));
    const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
    // A conformance fixture using what the language doesn't have (inheritance in Go) isn't
    // applicable, as the conformance suite reports it.
    if (inBody && errors.length && errors.every((d) => d.code === 'unsupported' || d.code === 'missing-snippet')) {
      result.notApplicable.push(`${where}: ${errors[0].message}`);
      dropped.add(file);
      continue;
    }
    if (errors.length || !compiled.outputPath) result.compileErrors.push(`${where}: ${errors.map((d) => d.message).join('; ')}`);
    result.warnings.push(...compiled.diagnostics.filter((d) => d.severity === 'warning').map((d) => `${where}: ${d.message}`));
  }
  // A program of the body (its classes use each other) with a graph that isn't applicable isn't
  // either: its folder goes.
  for (const program of PROGRAMS) {
    const folder = layout.body && posix(path.join(layout.body, program));
    if (!folder || !result.notApplicable.some((g) => g.startsWith(`${folder}/`))) continue;
    fs.rmSync(path.join(root, folder), { recursive: true, force: true });
    result.generated = result.generated.filter((f) => !f.startsWith(`${folder}/`));
    result.notApplicable.push(`${folder}: a program with a graph that isn't applicable`);
    for (const g of graphs) if (posix(path.relative(root, g.file)).startsWith(`${folder}/`)) dropped.add(g.file);
    // Nor do warnings about its files (Rust's modules of one name, beside another program's).
    result.warnings = result.warnings.filter((w) => !w.includes(`${folder}/`));
    // The build no longer lists its files.
    result.warnings.push(...applyAcceptedPlan(pack, root, outputsOf(pack), undefined, register).map((d) => `${folder}: ${d.message}`));
  }
}

// The body's programs, whose graphs use each other (the others' graphs stand alone).
const PROGRAMS = ['arena', 'duel'];

// A file of the project's code as the extension reads it: with the pack's scanner, or (Go) from what
// the language server reports, which goSymbols reads from the text as gopls would give it.
function scanCode(language: string, text: string): ModuleScan {
  const pack = languages.get(language)!;
  if (pack.importer?.scan) return pack.importer.scan(text);
  if (language === 'go') return scanSymbols(text, goSymbols(text), pack.importer!.languageServer!, (type) => pack.mapType(type));
  throw new Error(`the corpus can't read ${language} code`);
}

// gopls's document symbols and hovers for a Go file: its functions, its methods (their owner the
// receiver's type) and its structs' fields. A hover writes each parameter and named result with its
// type, as gopls does ("a, b int" is "a int, b int").
export function goSymbols(text: string): SymbolFunction[] {
  const symbols: SymbolFunction[] = [];
  let struct: string | undefined;
  const typed = (list: string): string => {
    const parts = list.split(',').map((p) => p.trim()).filter((p) => p);
    if (parts.every((p) => !/\s/.test(p))) return parts.join(', ');
    let type = '';
    return parts.reverse().map((p) => {
      const named = /^(\w+)\s+(.+)$/.exec(p);
      if (named) type = named[2];
      return named ? p : `${p} ${type}`;
    }).reverse().join(', ');
  };
  text.split(/\r?\n/).forEach((line, i) => {
    const at = { line: i, nameLine: i, containers: [] };
    const start = /^type (\w+) struct \{$/.exec(line);
    if (start) struct = start[1];
    else if (struct && line === '}') struct = undefined;
    else if (struct) {
      const field = /^\t(\w+)\s+(\S.*)$/.exec(line);
      if (field) symbols.push({ name: field[1], owner: struct, field: { type: field[2] }, ...at });
    } else {
      const fn = /^func (?:\((\w+) (\*?\w+)\) )?(\w+)\(([^)]*)\)\s*(.*?)\s*\{$/.exec(line);
      if (!fn) return;
      const [, receiver, owner, name, params, results] = fn;
      const result = results.startsWith('(') ? `(${typed(results.slice(1, -1))})` : results;
      const signature = `func ${owner ? `(${receiver} ${owner}) ` : ''}${name}(${typed(params)})${result ? ` ${result}` : ''}`;
      symbols.push({ name, ...(owner ? { owner } : {}), ...at, hover: '```go\n' + signature + '\n```' });
    }
  });
  return symbols;
}

// The node audit's program and the conformance fixtures, each in a folder of the layout's body (a
// package in Python).
function body(layout: Layout, root: string): { file: string; doc: GraphDocument }[] {
  const dir = path.join(root, layout.body!);
  const pack = languages.get(layout.language)!;
  const read = (file: string) => ({ name: path.basename(file), doc: parseDocument(fs.readFileSync(file, 'utf8'), path.basename(file, '.vgraph')).document });
  const vgraphs = (folder: string) => fs.readdirSync(path.join(repoRoot, folder)).filter((f) => f.endsWith('.vgraph')).sort().map((f) => read(path.join(repoRoot, folder, f)));
  const groups: Record<string, { name: string; doc: GraphDocument }[]> = {
    audit: [{ name: 'Audit.vgraph', doc: auditGraph(auditCases(builtinNodeDefinitions(), pack), layout.language) }],
    graphs: [read(path.join(repoRoot, 'sample/demo.vgraph')), ...vgraphs('test/fixtures/graphs')],
    ...((layout.programs ?? PROGRAMS).includes('arena') ? { arena: vgraphs('sample/arena') } : {}),
    ...((layout.programs ?? PROGRAMS).includes('duel') ? { duel: vgraphs('test/fixtures/programs/duel') } : {}),
    tests: vgraphs('test/fixtures/tests')
  };
  if (layout.language === 'python') {
    for (const folder of [dir, ...Object.keys(groups).map((g) => path.join(dir, g))]) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, '__init__.py'), '');
    }
  }
  return Object.entries(groups).flatMap(([group, docs]) => docs.map(({ name, doc }) => ({ file: path.join(dir, group, name), doc: { ...doc, language: layout.language } })));
}

const available = new Map<string, boolean>();

async function runStep(step: CorpusStep, root: string, tools: string): Promise<StepResult> {
  const command = step.command[0].startsWith('node_modules/') ? [process.execPath, path.join(tools, step.command[0]), ...step.command.slice(1)]
    : step.command[0] === 'node' ? [process.execPath, ...step.command.slice(1)]
    // A program the project built ("./build/corpus"), in the step's folder.
    : step.command[0].startsWith('./') ? [path.join(root, step.cwd ?? '', step.command[0]), ...step.command.slice(1)]
    // One of the corpus's PHP tools ("phar/phpstan.phar"), which PHP runs.
    : step.command[0].startsWith('phar/') ? ['php', ...phpExtensions(), path.join(tools, step.command[0]), ...step.command.slice(1)] : step.command;
  const probe = step.probe ?? (step.command[0].startsWith('node_modules/') ? [process.execPath, path.join(tools, step.command[0]), '--version']
    : step.command[0].startsWith('phar/') ? ['php', ...phpExtensions(), path.join(tools, step.command[0]), '--version'] : [step.command[0], '--version']);
  const key = probe.join(' ');
  if (!available.has(key)) available.set(key, (await run(probe, root, {}, 120000)).exitCode === 0);
  if (!available.get(key)) return { step: step.name, status: 'skipped', message: `${step.name}: ${probe[1]?.startsWith(tools) ? `${posix(path.relative(tools, probe[1]))} isn't installed (npm run corpus:tools)` : `${probe.slice(0, -1).join(' ')} isn't installed`}` };
  const outcome = await run(command, path.join(root, step.cwd ?? ''), step.env ?? {}, step.timeoutMs ?? 600000);
  const text = `${outcome.stdout}\n${outcome.stderr}`.trim();
  if (outcome.timedOut) return { step: step.name, status: 'failed', message: `${step.name} timed out.\n${text.slice(-4000)}` };
  if (outcome.exitCode !== 0) return { step: step.name, status: 'failed', message: `${step.name} exited with ${outcome.exitCode}:\n${text.slice(0, 8000)}` };
  if (step.stdout) {
    const lines = outcome.stdout.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).filter((l) => l);
    if (JSON.stringify(lines) !== JSON.stringify(step.stdout)) return { step: step.name, status: 'failed', message: `${step.name} printed ${JSON.stringify(lines)}, not ${JSON.stringify(step.stdout)}.\n${outcome.stderr.slice(0, 4000)}` };
  }
  if (step.quiet && outcome.stderr.trim()) return { step: step.name, status: 'failed', message: `${step.name} warned:\n${outcome.stderr.slice(0, 4000)}` };
  const missing = (step.includes ?? []).filter((t) => !text.includes(t));
  if (missing.length) return { step: step.name, status: 'failed', message: `${step.name} didn't print ${missing.map((m) => JSON.stringify(m)).join(', ')}:\n${text.slice(0, 4000)}` };
  return { step: step.name, status: 'passed' };
}

// What PHP's tools need loaded that the installed PHP has but doesn't load: Composer won't start
// without openssl (even to write the autoloader, which needs no network). The php.ini stays as it is.
let phpExtensionArgs: string[] | undefined;
function phpExtensions(): string[] {
  if (!phpExtensionArgs) {
    const loaded = (args: string[]) => spawnSync('php', [...args, '-r', 'echo extension_loaded("openssl") ? 1 : 0;'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, XDEBUG_MODE: 'off' } }).stdout?.trim() === '1';
    phpExtensionArgs = !loaded([]) && loaded(['-d', 'extension=openssl']) ? ['-d', 'extension=openssl'] : [];
  }
  return phpExtensionArgs;
}

interface Outcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Runs a command; a Windows .cmd (npm, mvn, gradle) through the shell. A timeout ends the whole
// process tree, not only the shell.
function run(command: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const [executable, ...args] = command;
    const shell = process.platform === 'win32' && !path.isAbsolute(executable) && windowsScript(executable);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.ELECTRON_RUN_AS_NODE;
    // Elsewhere than Windows, the command leads a process group of its own, so killTree reaches
    // what it starts (a build's compiler, a test runner's workers).
    const detached = process.platform !== 'win32';
    const child = shell
      ? spawn([executable, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '), { cwd, env: childEnv, shell: true, windowsHide: true })
      : spawn(executable, args, { cwd, env: childEnv, windowsHide: true, detached });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (t: string) => (stdout += t));
    child.stderr.setEncoding('utf8').on('data', (t: string) => (stderr += t));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + error.message, timedOut });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

// Whether a command on Windows is a .cmd or .bat on the PATH (which Node.js won't start directly).
const scripts = new Map<string, boolean>();
function windowsScript(name: string): boolean {
  if (!scripts.has(name)) {
    // `where` also lists a tool's extensionless shell script (for Git Bash), which Windows can't run.
    const where = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
    const found = where.status === 0 ? where.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /\.(exe|cmd|bat)$/i.test(l)) : [];
    scripts.set(name, /\.(cmd|bat)$/i.test(found[0] ?? ''));
  }
  return scripts.get(name)!;
}

// The whole process tree: taskkill /T on Windows, the process group elsewhere (run starts each command
// detached, as its group's leader).
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}

function posix(p: string): string {
  return p.split(path.sep).join('/');
}

// ---- Graphs a user would put in a project ---------------------------------------------------------

const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
const text = (id: string, name: string) => ({ id, name, kind: 'data' as const, type: { id: 'string' } });

// A function library the project's code calls, which calls the project's code: Greet(Name) is
// "Hello, " + the project's `title`(Name) + "!".
export function greetingLibrary(title: NodeDefinition): GraphDocument {
  const input = title.inputs.find((p) => p.kind === 'data')!.id;
  const output = title.outputs.find((p) => p.kind === 'data')!.id;
  return {
    schemaVersion: 3, name: 'Greeting', kind: 'functionLibrary', language: '', variables: [],
    graphs: [{
      id: 'Greet', name: 'Greet', kind: 'function', comments: [],
      signature: { pure: true, inputs: [text('name', 'Name')], outputs: [text('text', 'Text')] },
      nodes: [
        n('entry', 'core:function.entry', { graph: 'Greet' }), n('title', title.type),
        n('hello', 'core:string.append', { 'pin:a': 'Hello, ' }), n('bang', 'core:string.append', { 'pin:b': '!' }),
        n('return', 'core:function.return', { graph: 'Greet' })
      ],
      connections: [
        w('entry', 'execOut', 'return', 'execIn'), w('entry', 'name', 'title', input), w('title', output, 'hello', 'b'),
        w('hello', 'returnValue', 'bang', 'a'), w('bang', 'returnValue', 'return', 'text')
      ]
    }]
  };
}

// What the project's code offers beyond plain functions (docs/code-as-nodes.md), each with the
// shared conformance builder's graph and what it prints. A language has those its pack supports. A
// feature's graph is the class the entry point starts; `before` are other graphs it uses.
type FeatureBuild = (definitions: NodeDefinition[], language: string) => GraphDocument;
const FEATURES: Record<string, { file: string; build: FeatureBuild; output: string[]; before?: { file: string; build: FeatureBuild }[] }> = {
  classes: { file: 'Counting', build: codeClassGraph, output: CODE_CLASS_OUTPUT },
  outputs: { file: 'Dividing', build: severalOutputsGraph, output: SEVERAL_OUTPUTS_OUTPUT },
  generics: { file: 'Firsts', build: genericsGraph, output: GENERICS_OUTPUT },
  // A graph class extending the code's Actor (docs/code-classes-as-parents.md), named Paladin: the
  // body's arena has a Knight, and C++'s classes share the global namespace.
  parents: {
    file: 'Questing', build: (definitions, language) => gameGraph(language, actorCode(definitions), 'Questing', 'Paladin'), output: CODE_PARENTS_OUTPUT,
    before: [{ file: 'Paladin', build: (definitions, language) => knightGraph(language, actorCode(definitions), 'Paladin') }]
  },
  latent: { file: 'Fetching', build: latentCodeGraph, output: LATENT_CODE_OUTPUT }
};
export type Feature = 'classes' | 'outputs' | 'generics' | 'parents' | 'latent';
export const ALL_FEATURES: Feature[] = ['classes', 'outputs', 'generics', 'parents', 'latent'];

// The graphs of the project's code's features, each in `dir`: a class and its subclass, several
// outputs, a generic function, a graph class extending a class of the code, and an async function.
export function featureGraphs(dir: string, language: string, features: Feature[] = ALL_FEATURES): CorpusGraph[] {
  return features.flatMap((f) => [...(FEATURES[f].before ?? []), FEATURES[f]]
    .map((g) => ({ path: `${dir}/${g.file}.vgraph`, build: ({ definitions }: GraphContext) => g.build(definitions, language) })));
}

// What an entry point that starts each feature graph in turn prints: Fetching's Completed comes
// last, after the code that started it.
export function featuresOutput(features: Feature[] = ALL_FEATURES): string[] {
  return features.flatMap((f) => FEATURES[f].output);
}

// A graph of tests for the project's test runner: its Test Case calls the Greeting library (at
// `library`) and asserts what it gives.
export function greetingTests(library: string): CorpusGraph {
  return {
    path: library.replace(/Greeting\.vgraph$/, 'GreetingTests.vgraph'),
    build: (context) => ({
      schemaVersion: 3, name: 'Greeting Tests', kind: 'class', language: '', variables: [],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          n('case', 'core:test.case', { name: 'Greets by title' }), n('greet', context.library(library, 'Greet'), { 'pin:name': 'ada' }),
          n('equal', 'core:test.assert-equal', { wildcards: { wildcard: 'string' }, 'pin:expected': 'Hello, Ada!' })
        ],
        connections: [w('case', 'execOut', 'equal', 'execIn'), w('greet', 'text', 'equal', 'actual')]
      }]
    })
  };
}

// A struct shared by two languages (docs/multi-language.md, gap 2): Score (Name, Points), in
// `language` and also generated for `other`, next to the graph.
export function sharedScore(file: string, language: string, other: string): CorpusGraph {
  return {
    path: file, language,
    build: () => ({
      schemaVersion: 3, name: 'Score', kind: 'structure', language, languages: [other], graphs: [],
      variables: [{ id: 'name', name: 'Name', type: { id: 'string' }, defaultValue: '' }, { id: 'points', name: 'Points', type: { id: 'int' }, defaultValue: 0 }]
    })
  };
}

// A class in `language` that makes a Score and prints it: {"Name":"ada","Points":3}.
export function showScore(file: string, language: string): CorpusGraph {
  return {
    path: file, language,
    build: () => ({
      schemaVersion: 3, name: 'Show Score', kind: 'class', language, variables: [],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [n('start', 'core:event.start'), n('make', 'struct:Score.make', { 'pin:name': 'ada', 'pin:points': 3 }), n('print', 'core:console.print')],
        connections: [w('start', 'execOut', 'print', 'execIn'), w('make', 'struct', 'print', 'value')]
      }]
    })
  };
}
