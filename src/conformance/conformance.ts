// The published conformance suite (docs/language-breadth.md): runs fixture graphs in Simulate and
// as a language pack's generated code, with the pack's own runner, and compares what they print.
// Any pack can run it, through the SDK's runConformance or the blueprint-conformance command.
// Needs Node.js, not VS Code.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../core/compiler';
import { CompileDiagnostic } from '../core/compiler/diagnostics';
import { graphFileDefinitions } from '../core/graph-files';
import { GenerateOptions, LanguagePack, LanguagePackRegistry } from '../core/language-pack';
import { DEFAULT_LANGUAGE, builtinLanguagePacks } from '../core/languages';
import { GraphDocument, NodeDefinition, RuntimeLogEvent } from '../core/model';
import { exampleGraph, exampleMismatches } from '../core/node-examples';
import { NodeRegistry, parseNodeDefinition } from '../core/registry';
import { GraphRuntime } from '../core/runtime';
import { parseDocument } from '../core/serializer';
import { ToolNotFoundError, runGeneratedCode } from '../extension/runner';

// A fixture: one graph, or a program of several graph files run from its entry, or a graph whose
// Test Case events are run.
export interface Fixture {
  name: string;
  kind: 'graph' | 'program' | 'tests';
  // The graph files, the entry first.
  files: string[];
}

export interface FixtureSet {
  fixtures: Fixture[];
  // Node libraries (*.node.json) the fixtures use.
  nodes: string[];
}

export type ResultStatus = 'passed' | 'failed' | 'not-applicable' | 'skipped';

export interface FixtureResult {
  fixture: string;
  status: ResultStatus;
  // Why it failed, isn't applicable, or was skipped.
  message?: string;
  expected?: string[];
  actual?: string[];
}

export interface ConformanceReport {
  pack: string;
  results: FixtureResult[];
  passed: number;
  failed: number;
  notApplicable: number;
  skipped: number;
}

export interface ConformanceOptions {
  // The fixtures; the SDK's own set by default.
  fixtures?: FixtureSet;
  // Where generated code is written and run (a new temporary folder by default, removed after).
  workDir?: string;
  // Generate options to add, e.g. { moduleFormat: 'commonjs' } for JavaScript.
  generate?: Partial<GenerateOptions>;
  // Replaces the runner's commands, as the runCommands setting does.
  command?: string[];
  // Runs only the fixtures whose names contain it.
  filter?: string;
  timeoutMs?: number;
  // How many fixtures run at once.
  concurrency?: number;
  onResult?: (result: FixtureResult) => void;
}

// The standard layout, as the SDK ships it: graphs/*.vgraph, programs/<name>/*.vgraph (the entry is
// the file whose metadata has the expected output), tests/*.vgraph and nodes/*.node.json.
export function loadFixtureSet(dir: string): FixtureSet {
  const list = (sub: string, ext: string) => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith(ext)).sort().map((f) => path.join(dir, sub, f)) : []);
  const programs = fs.existsSync(path.join(dir, 'programs')) ? fs.readdirSync(path.join(dir, 'programs')).sort() : [];
  return {
    fixtures: [
      ...list('graphs', '.vgraph').map((file) => ({ name: `graphs/${path.basename(file)}`, kind: 'graph' as const, files: [file] })),
      ...programs.map((name) => ({ name: `programs/${name}`, kind: 'program' as const, files: programFiles(path.join(dir, 'programs', name)) })),
      ...list('tests', '.vgraph').map((file) => ({ name: `tests/${path.basename(file)}`, kind: 'tests' as const, files: [file] }))
    ],
    nodes: list('nodes', '.node.json')
  };
}

// A program folder's graph files, its entry first.
export function programFiles(dir: string): string[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.vgraph')).sort().map((f) => path.join(dir, f));
  const isEntry = (file: string) => parseDocument(fs.readFileSync(file, 'utf8')).document.metadata?.expectedOutput !== undefined;
  return [...files.filter(isEntry), ...files.filter((f) => !isEntry(f))];
}

// The fixtures shipped next to this module (the SDK's dist/fixtures).
export function defaultFixtureSet(): FixtureSet {
  return loadFixtureSet(path.join(__dirname, 'fixtures'));
}

export async function runConformance(pack: LanguagePack, options: ConformanceOptions = {}): Promise<ConformanceReport> {
  const set = options.fixtures ?? defaultFixtureSet();
  const fixtures = set.fixtures.filter((f) => !options.filter || f.name.includes(options.filter));
  const ownWorkDir = !options.workDir;
  const workDir = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `vgraph-conformance-${pack.id}-`));
  const nodes = set.nodes.map((file) => parseNodeDefinition(fs.readFileSync(file, 'utf8'))).filter((d): d is NodeDefinition => !!d);
  const results: FixtureResult[] = new Array(fixtures.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < fixtures.length; i = next++) {
      const fixture = fixtures[i];
      let result: FixtureResult;
      try {
        result = await runFixture(pack, fixture, nodes, path.join(workDir, String(i)), options);
      } catch (error) {
        result = { fixture: fixture.name, status: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
      results[i] = result;
      options.onResult?.(result);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
  } finally {
    if (ownWorkDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
  const count = (status: ResultStatus) => results.filter((r) => r.status === status).length;
  return { pack: pack.id, results, passed: count('passed'), failed: count('failed'), notApplicable: count('not-applicable'), skipped: count('skipped') };
}

async function runFixture(pack: LanguagePack, fixture: Fixture, libraryNodes: NodeDefinition[], dir: string, options: ConformanceOptions): Promise<FixtureResult> {
  const generator = pack.generator;
  const runner = generator?.runner;
  if (!generator || !runner) return { fixture: fixture.name, status: 'skipped', message: `${pack.displayName} has no generator and runner.` };
  const docs = fixture.files.map((file) => ({ fileName: path.basename(file), doc: parseDocument(fs.readFileSync(file, 'utf8'), path.basename(file, '.vgraph')).document }));
  const generate = (fileName: string): GenerateOptions => ({ sourceFileName: fileName, outputDir: '', namespace: 'Conformance', ...options.generate });

  // Expected: Simulate, on the graphs as written (their code nodes run in their own language).
  const expected = simulate(docs, libraryNodes, fixture.kind);

  // The program in the pack's language, each file's types and classes registered for the others.
  const languages = new LanguagePackRegistry([...builtinLanguagePacks().all().filter((p) => p.id !== pack.id), pack]);
  const registry = new NodeRegistry();
  registry.registerMany(libraryNodes);
  const translated = docs.map(({ fileName, doc }) => ({ fileName, doc: { ...doc, language: pack.id } }));
  for (const { fileName, doc } of translated) {
    const generatedPath = generator.outputFileName(fileName);
    const module = generator.moduleName?.(generatedPath, generate(fileName));
    const definitions = graphFileDefinitions(doc, { document: fileName, generatedPath, ...(module ? { module } : {}) }, generator);
    if (definitions) registry.registerMany(definitions);
  }
  const compiled = [];
  for (const { fileName, doc } of translated) {
    const result = compileDocument(doc, { registry, languages, generate: generate(fileName) });
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    // What the pack can't express, or a library node it has no implementation of.
    if (errors.length && errors.every((d) => d.code === 'unsupported' || d.code === 'missing-snippet')) return { fixture: fixture.name, status: 'not-applicable', message: describe(errors[0], fileName) };
    if (errors.length || !result.output) return { fixture: fixture.name, status: 'failed', message: `It doesn't compile: ${errors.map((d) => describe(d, fileName)).join('; ')}` };
    compiled.push(result.output);
  }

  fs.mkdirSync(dir, { recursive: true });
  const files = compiled.map((output) => {
    const file = path.join(dir, output.fileName);
    fs.writeFileSync(file, output.text);
    for (const companion of output.companionFiles ?? []) fs.writeFileSync(path.join(dir, companion.fileName), companion.text);
    return file;
  });
  const entry = compiled[0];
  let testFile: string | undefined;
  if (fixture.kind === 'tests') {
    if (!entry.tests?.length) return { fixture: fixture.name, status: 'failed', message: 'The generated code has no tests.' };
    if (entry.testFile !== undefined) {
      testFile = path.join(dir, generator.testFileName!(docs[0].fileName));
      fs.writeFileSync(testFile, entry.testFile);
    }
  }
  let outcome;
  try {
    outcome = await runGeneratedCode(runner, files[0], entry.className, {
      cwd: dir,
      importRoots: [dir],
      sources: files.slice(1),
      mainMethod: entry.mainMethod,
      args: [],
      command: options.command,
      timeoutMs: options.timeoutMs ?? 300000,
      ...(fixture.kind === 'tests' ? { tests: { testFile, cases: entry.tests! } } : {})
    });
  } catch (error) {
    if (error instanceof ToolNotFoundError) return { fixture: fixture.name, status: 'skipped', message: error.message };
    throw error;
  }
  const text = `${outcome.stdout}\n${outcome.stderr}`;
  if (fixture.kind === 'tests') {
    const failures = expected.failures;
    const missing = failures.filter((message) => !text.includes(message));
    if ((outcome.exitCode !== 0) !== failures.length > 0) return { fixture: fixture.name, status: 'failed', message: `Simulate has ${failures.length} failing test(s), the generated tests exited with code ${outcome.exitCode}.\n${text}` };
    if (missing.length) return { fixture: fixture.name, status: 'failed', message: `The test output doesn't report: ${missing.join('; ')}\n${text}` };
    return { fixture: fixture.name, status: 'passed' };
  }
  const actual = outputLines(outcome.stdout);
  if (JSON.stringify(actual) !== JSON.stringify(expected.output)) return { fixture: fixture.name, status: 'failed', message: `It printed something else.\n${outcome.stderr}`, expected: expected.output, actual };
  if ((outcome.exitCode !== 0) !== expected.error) {
    return { fixture: fixture.name, status: 'failed', message: expected.error ? 'Simulate stops with an error, but the generated code exited normally.' : `The generated code exited with code ${outcome.exitCode}.\n${outcome.stderr}` };
  }
  return { fixture: fixture.name, status: 'passed' };
}

// What Simulate prints, whether it stops with an error, and (for tests) each failing test's message.
function simulate(docs: { fileName: string; doc: GraphDocument }[], libraryNodes: NodeDefinition[], kind: Fixture['kind']): { output: string[]; error: boolean; failures: string[] } {
  const languages = builtinLanguagePacks();
  const registry = new NodeRegistry();
  registry.registerMany(libraryNodes);
  for (const { fileName, doc } of docs) {
    const generator = languages.get(doc.language || DEFAULT_LANGUAGE)?.generator;
    const definitions = generator && graphFileDefinitions(doc, { document: fileName, generatedPath: generator.outputFileName(fileName) }, generator);
    if (definitions) registry.registerMany(definitions);
  }
  const events: RuntimeLogEvent[] = [];
  const runtime = new GraphRuntime(registry, (e) => events.push(e), languages, (file) => docs.find((d) => d.fileName === file)?.doc);
  if (kind === 'tests') {
    const results = runtime.runTests(docs[0].doc);
    return { output: [], error: false, failures: results.filter((r) => !r.passed).map((r) => r.message ?? '') };
  }
  runtime.run(docs[0].doc);
  return { output: events.filter((e) => e.kind === 'log').map((e) => e.message ?? ''), error: events.some((e) => e.kind === 'error'), failures: [] };
}

// ---- Node libraries (docs/node-authoring.md, gap 8) ---------------------------------------------

export type NodeTestOptions = Pick<ConformanceOptions, 'workDir' | 'generate' | 'command' | 'timeoutMs' | 'onResult'>;

// The node files of a file or folder (its *.node.json files, at any depth).
export function loadNodeFiles(fileOrDir: string): NodeDefinition[] {
  const files = fs.statSync(fileOrDir).isDirectory()
    ? (fs.readdirSync(fileOrDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.node.json')).sort().map((f) => path.join(fileOrDir, f))
    : [fileOrDir];
  return files.map((file) => parseNodeDefinition(fs.readFileSync(file, 'utf8'))).filter((d): d is NodeDefinition => !!d);
}

// Tests a node library in a language pack: each node's examples run in a graph of the pack's
// language, and their outputs are compared with the examples'. A node without examples only has to
// compile; one without a snippet for the pack isn't applicable.
export async function runNodeExamples(pack: LanguagePack, nodes: NodeDefinition[], options: NodeTestOptions = {}): Promise<ConformanceReport> {
  const ownWorkDir = !options.workDir;
  const workDir = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `vgraph-nodes-${pack.id}-`));
  const results: FixtureResult[] = [];
  try {
    for (const [i, def] of nodes.entries()) {
      let result: FixtureResult;
      try {
        result = await runNodeExample(pack, def, nodes, path.join(workDir, String(i)), options);
      } catch (error) {
        result = { fixture: def.type, status: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
      results.push(result);
      options.onResult?.(result);
    }
  } finally {
    if (ownWorkDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
  return report(pack.id, results);
}

async function runNodeExample(pack: LanguagePack, def: NodeDefinition, nodes: NodeDefinition[], dir: string, options: NodeTestOptions): Promise<FixtureResult> {
  const generator = pack.generator;
  const runner = generator?.runner;
  if (!generator || !runner) return { fixture: def.type, status: 'skipped', message: `${pack.displayName} has no generator and runner.` };
  const implementation = def.implementation;
  if (implementation?.kind === 'code' && !generator.snippetLanguages.some((key) => implementation.languages[key] !== undefined) && generator.snippets?.[def.type] === undefined) {
    return { fixture: def.type, status: 'not-applicable', message: `It has no ${generator.snippetLanguages.map((k) => `"${k}"`).join(' or ')} snippet.` };
  }
  const { document, expected } = exampleGraph(def, pack.id);
  const languages = new LanguagePackRegistry([...builtinLanguagePacks().all().filter((p) => p.id !== pack.id), pack]);
  const registry = new NodeRegistry();
  registry.registerMany(nodes);
  const result = compileDocument(document, { registry, languages, generate: { sourceFileName: 'NodeExamples.vgraph', outputDir: '', namespace: 'Conformance', ...options.generate } });
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length || !result.output) return { fixture: def.type, status: 'failed', message: `It doesn't compile: ${errors.map((d) => d.message).join('; ')}` };
  if (!def.examples?.length) return { fixture: def.type, status: 'passed', message: 'It compiles; it has no examples to run.' };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, result.output.fileName);
  fs.writeFileSync(file, result.output.text);
  for (const companion of result.output.companionFiles ?? []) fs.writeFileSync(path.join(dir, companion.fileName), companion.text);
  let outcome;
  try {
    outcome = await runGeneratedCode(runner, file, result.output.className, { cwd: dir, importRoots: [dir], command: options.command, timeoutMs: options.timeoutMs ?? 300000 });
  } catch (error) {
    if (error instanceof ToolNotFoundError) return { fixture: def.type, status: 'skipped', message: error.message };
    throw error;
  }
  const actual = outputLines(outcome.stdout);
  const problems = exampleMismatches(def, expected, actual);
  if (outcome.exitCode !== 0) problems.push(`The generated code exited with code ${outcome.exitCode}.\n${outcome.stderr}`);
  return problems.length ? { fixture: def.type, status: 'failed', message: problems.join('\n'), expected: expected.flat(), actual } : { fixture: def.type, status: 'passed' };
}

// The same in Simulate, in a graph of `language` (its code nodes run as Simulate runs them).
export function simulateNodeExamples(nodes: NodeDefinition[], language = DEFAULT_LANGUAGE): ConformanceReport {
  const results = nodes.map((def): FixtureResult => {
    if (!def.examples?.length) return { fixture: def.type, status: 'not-applicable', message: 'It has no examples.' };
    const { document, expected } = exampleGraph(def, language);
    const registry = new NodeRegistry();
    registry.registerMany(nodes);
    const events: RuntimeLogEvent[] = [];
    new GraphRuntime(registry, (e) => events.push(e), builtinLanguagePacks()).run(document);
    const actual = events.filter((e) => e.kind === 'log').map((e) => e.message ?? '');
    const error = events.find((e) => e.kind === 'error');
    const problems = [...(error ? [`Simulate stopped: ${error.message ?? ''}`] : []), ...exampleMismatches(def, expected, actual)];
    return problems.length ? { fixture: def.type, status: 'failed', message: problems.join('\n'), expected: expected.flat(), actual } : { fixture: def.type, status: 'passed' };
  });
  return report('simulate', results);
}

function report(pack: string, results: FixtureResult[]): ConformanceReport {
  const count = (status: ResultStatus) => results.filter((r) => r.status === status).length;
  return { pack, results, passed: count('passed'), failed: count('failed'), notApplicable: count('not-applicable'), skipped: count('skipped') };
}

function describe(d: CompileDiagnostic, fileName: string): string {
  return `${fileName}${d.nodeId ? ` (node ${d.nodeId})` : ''}: ${d.message}`;
}

export function outputLines(stdout: string): string[] {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// The report as text, one line per fixture, then the totals.
export function formatReport(report: ConformanceReport): string {
  const mark: Record<ResultStatus, string> = { passed: '✔', failed: '✖', 'not-applicable': '–', skipped: '○' };
  const lines = report.results.map((r) => {
    const head = `${mark[r.status]} ${r.fixture}${r.status === 'not-applicable' ? ' (not applicable)' : r.status === 'skipped' ? ' (skipped)' : ''}`;
    const detail = [r.message, ...(r.expected ? [`expected: ${JSON.stringify(r.expected)}`, `actual:   ${JSON.stringify(r.actual)}`] : [])].filter(Boolean).map((t) => `    ${t!.split('\n').join('\n    ')}`);
    return r.status === 'passed' ? head : [head, ...detail].join('\n');
  });
  lines.push(`${report.pack}: ${report.passed} passed, ${report.failed} failed, ${report.notApplicable} not applicable, ${report.skipped} skipped`);
  return lines.join('\n');
}
