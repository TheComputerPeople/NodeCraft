// The corpus of project layouts (docs/project-integration.md, part 3): small but real-shaped
// projects in test/fixtures/projects, each with graphs put where a user would put them. The harness
// copies a layout, scans its code for @blueprint functions, writes and compiles its graphs as the
// extension does (src/extension/placement.ts), then runs the project's own build, checkers and entry
// point. A tool that isn't installed is skipped, by name.
//
// In one layout of each language, the generated code of every node (the node audit's program) and of
// the conformance fixtures goes into the project too, so the checkers see all of it.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditCases, auditGraph } from '../../src/conformance/audit';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { compileDocument } from '../../src/core/compiler';
import { graphFileDefinitions } from '../../src/core/graph-files';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { LanguagePackRegistry } from '../../src/core/language-pack';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { codeModuleFor, generateOptionsFor, graphOutputFor } from '../../src/extension/placement';
import { repoRoot } from '../unit/helpers';

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
  // Whether its tool is there: a command that succeeds when it is (the command's first word with
  // --version by default).
  probe?: string[];
  timeoutMs?: number;
}

export interface CorpusGraph {
  // Where a user would put it, relative to the project.
  path: string;
  // The graph, given the project code's nodes (by function name).
  build: (code: (name: string) => NodeDefinition) => GraphDocument;
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
  fs.cpSync(path.join(repoRoot, 'test/fixtures/projects', layout.name), root, { recursive: true });
  const tools = corpusToolsFolder();
  const result: LayoutResult = { compileErrors: [], generated: [], steps: [] };
  generate(layout, root, result);
  if (result.compileErrors.length) return result;
  // A step after one that didn't pass needs what that one makes (a build before its run).
  for (const step of layout.steps) {
    const before = result.steps.find((s) => s.status !== 'passed');
    result.steps.push(before ? { step: step.name, status: 'skipped', message: `${step.name}: ${before.step} didn't pass` } : await runStep(step, root, tools));
  }
  return result;
}

// The layout's graphs and body, generated where the extension would put them.
function generate(layout: Layout, root: string, result: LayoutResult): void {
  const pack = languages.get(layout.language)!;
  const generator = pack.generator!;
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
  const graphs: { file: string; doc: GraphDocument }[] = layout.graphs.map((g) => ({ file: path.join(root, g.path), doc: { ...g.build(byName), language: layout.language } }));
  if (layout.body) graphs.push(...body(layout, root));
  // Types and libraries first, as the workspace knows them, then each graph compiled.
  for (const { file, doc } of graphs) {
    const own = graphOutputFor(layout.language, file, root, generator);
    registry.registerMany(graphFileDefinitions(doc, { document: posix(path.relative(root, file)), ...own }, generator) ?? []);
  }
  for (const { file, doc } of graphs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    const compiled = compileDocument(doc, { registry, languages: new LanguagePackRegistry(languages.all()), generate: generateOptionsFor(layout.language, path.basename(file), path.dirname(file), root, generator) });
    const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length || !compiled.output) {
      result.compileErrors.push(`${posix(path.relative(root, file))}: ${errors.map((d) => d.message).join('; ')}`);
      continue;
    }
    const out = (name: string, text: string) => {
      fs.writeFileSync(path.join(path.dirname(file), name), text);
      result.generated.push(posix(path.relative(root, path.join(path.dirname(file), name))));
    };
    out(compiled.output.fileName, compiled.output.text);
    for (const companion of compiled.output.companionFiles ?? []) out(companion.fileName, companion.text);
    if (compiled.output.testFile !== undefined && generator.testFileName) out(generator.testFileName(path.basename(file)), compiled.output.testFile);
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
    const child = shell
      ? spawn([executable, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '), { cwd, env: childEnv, shell: true, windowsHide: true })
      : spawn(executable, args, { cwd, env: childEnv, windowsHide: true });
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

function killTree(pid: number | undefined): void {
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
