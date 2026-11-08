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
import { exposeFunctions } from '../../src/core/importing/symbols';
import { LanguagePackRegistry } from '../../src/core/language-pack';
import { libraryNodeType } from '../../src/core/libraries';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { GraphCompileHost, applyAcceptedPlan, compileGraphFile } from '../../src/extension/graph-compile';
import { codeModuleFor, graphFileNodes } from '../../src/extension/placement';
import { repoRoot } from '../unit/helpers';
import { CODE_CLASS_OUTPUT, codeClassGraph } from './code-classes';
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
  // The command. "node_modules/..." runs a script of the corpus's Node.js tools with Node.js.
  command: string[];
  // Its folder, relative to the project (the project by default).
  cwd?: string;
  env?: Record<string, string>;
  // The lines its output must have, in order (an entry point's).
  stdout?: string[];
  // Text its output (stdout and stderr) must have: a test runner's count of passed tests.
  includes?: string[];
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
  const root = path.join(workDir, layout.name);
  // Without build output a tool or IDE may have left in the repository's copy (a C# restore's obj/).
  const source = path.join(repoRoot, 'test/fixtures/projects', layout.name);
  fs.cpSync(source, root, { recursive: true, filter: (file) => !['obj', 'bin'].includes(path.basename(file)) || !fs.statSync(file).isDirectory() });
  const tools = corpusToolsFolder();
  const result: LayoutResult = { compileErrors: [], warnings: [], generated: [], steps: [] };
  await generate(layout, root, result);
  if (result.compileErrors.length) return result;
  // A step after one that didn't pass needs what that one makes (a build before its run).
  for (const step of layout.steps) {
    const before = result.steps.find((s) => s.status !== 'passed');
    result.steps.push(before ? { step: step.name, status: 'skipped', message: `${step.name}: ${before.step} didn't pass` } : await runStep(step, root, tools));
  }
  return result;
}

// The layout's graphs and body, compiled as Compile compiles them.
async function generate(layout: Layout, root: string, result: LayoutResult): Promise<void> {
  const pack = languages.get(layout.language)!;
  const registry = new NodeRegistry();
  for (const file of ['sample/visual-nodes/Math/Double.node.json', 'test/fixtures/nodes/Fail.node.json']) registry.register(parseNodeDefinition(fs.readFileSync(path.join(repoRoot, file), 'utf8'))!);
  const code: NodeDefinition[] = [];
  for (const file of layout.code) {
    const scan = pack.importer!.scan!(fs.readFileSync(path.join(root, file), 'utf8'));
    code.push(...exposeFunctions(scan, { language: pack.id, path: file, module: codeModuleFor(pack.id, path.join(root, file), root), exposeAll: false }).definitions);
  }
  registry.registerMany(code);
  const byName = (name: string): NodeDefinition => {
    const found = code.find((d) => d.implementation?.kind === 'function' && d.implementation.name.split('.').pop() === name);
    if (!found) throw new Error(`${layout.name}: no @blueprint function "${name}" in ${layout.code.join(', ')}`);
    return found;
  };
  const context: GraphContext = { code: byName, definitions: code, library: (graphPath, graphId) => libraryNodeType(graphPath, graphId) };
  const graphs: { file: string; doc: GraphDocument }[] = layout.graphs.map((g) => ({ file: path.join(root, g.path), doc: { ...g.build(context), language: g.language ?? layout.language } }));
  if (layout.body) graphs.push(...body(layout, root));
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
    register: async (other, folder, outputFile) => applyAcceptedPlan(other, folder, graphs.filter((g) => g.doc.language === other.id).map((g) => path.join(path.dirname(g.file), other.generator!.outputFileName(path.basename(g.file)))), outputFile)
  };
  for (const { file, doc } of graphs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    const compiled = await compileGraphFile(doc, file, root, host);
    const where = posix(path.relative(root, file));
    const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length || !compiled.outputPath) result.compileErrors.push(`${where}: ${errors.map((d) => d.message).join('; ')}`);
    result.warnings.push(...compiled.diagnostics.filter((d) => d.severity === 'warning').map((d) => `${where}: ${d.message}`));
  }
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
    arena: vgraphs('sample/arena'),
    duel: vgraphs('test/fixtures/programs/duel'),
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
    : step.command[0] === 'node' ? [process.execPath, ...step.command.slice(1)] : step.command;
  const probe = step.probe ?? (step.command[0].startsWith('node_modules/') ? [process.execPath, path.join(tools, step.command[0]), '--version'] : [step.command[0], '--version']);
  const key = probe.join(' ');
  if (!available.has(key)) available.set(key, (await run(probe, root, {}, 120000)).exitCode === 0);
  if (!available.get(key)) return { step: step.name, status: 'skipped', message: `${step.name}: ${probe[0] === process.execPath ? `${probe[1]} isn't installed (npm run corpus:tools)` : `${probe.slice(0, -1).join(' ')} isn't installed`}` };
  const outcome = await run(command, path.join(root, step.cwd ?? ''), step.env ?? {}, step.timeoutMs ?? 600000);
  const text = `${outcome.stdout}\n${outcome.stderr}`.trim();
  if (outcome.timedOut) return { step: step.name, status: 'failed', message: `${step.name} timed out.\n${text.slice(-4000)}` };
  if (outcome.exitCode !== 0) return { step: step.name, status: 'failed', message: `${step.name} exited with ${outcome.exitCode}:\n${text.slice(0, 8000)}` };
  if (step.stdout) {
    const lines = outcome.stdout.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).filter((l) => l);
    if (JSON.stringify(lines) !== JSON.stringify(step.stdout)) return { step: step.name, status: 'failed', message: `${step.name} printed ${JSON.stringify(lines)}, not ${JSON.stringify(step.stdout)}.\n${outcome.stderr.slice(0, 4000)}` };
  }
  const missing = (step.includes ?? []).filter((t) => !text.includes(t));
  if (missing.length) return { step: step.name, status: 'failed', message: `${step.name} didn't print ${missing.map((m) => JSON.stringify(m)).join(', ')}:\n${text.slice(0, 4000)}` };
  return { step: step.name, status: 'passed' };
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

// The graphs of what the project's code offers beyond plain functions (docs/code-as-nodes.md): a
// class and its subclass, several outputs, a generic function and an async one, from the shared
// conformance builders, each in `dir`. Each class prints as its builder says.
export function featureGraphs(dir: string, language: string): CorpusGraph[] {
  return [
    { path: `${dir}/Counting.vgraph`, build: ({ definitions }) => codeClassGraph(definitions, language) },
    { path: `${dir}/Dividing.vgraph`, build: ({ definitions }) => severalOutputsGraph(definitions, language) },
    { path: `${dir}/Firsts.vgraph`, build: ({ definitions }) => genericsGraph(definitions, language) },
    { path: `${dir}/Fetching.vgraph`, build: ({ definitions }) => latentCodeGraph(definitions, language) }
  ];
}

// What an entry point that greets, then starts each feature graph in turn, prints: Fetching's
// Completed comes last, after the code that started it.
export const FEATURES_OUTPUT = [...CODE_CLASS_OUTPUT, ...SEVERAL_OUTPUTS_OUTPUT, ...GENERICS_OUTPUT, ...LATENT_CODE_OUTPUT];

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
