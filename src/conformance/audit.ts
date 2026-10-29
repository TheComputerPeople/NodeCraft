// The node audit (docs/language-context.md, part 1): every node the palette offers in a language,
// compiled, built and run in it, and compared with Simulate. Each node instance is a case: its own
// custom event, with sample inputs from variables of concrete types (so wildcard pins resolve), and
// prints of its outputs. Start calls each case after printing a marker, so a crash names its case;
// a build error is traced to its case through the generator's node lines. A failing case is taken
// out (of the run, or of the graph) and the rest run again.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { builtinNodeDefinitions } from '../core/builtins';
import { implementsCode, missingCapabilities, nodeRequirements } from '../core/capabilities';
import { compileDocument } from '../core/compiler';
import { GenerateOptions, LanguagePack, LanguagePackRegistry } from '../core/language-pack';
import { builtinLanguagePacks } from '../core/languages';
import { GraphConnection, GraphDocument, GraphNode, NodeDefinition, PinDefinition, RuntimeLogEvent, TypeRef, GraphVariable } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { GraphRuntime } from '../core/runtime';
import { ToolNotFoundError, runGeneratedCode } from '../extension/runner';
import { outputLines } from './conformance';

// Nodes the audit leaves out: they need a place in a class (entries, returns, members, macros,
// events, dispatchers, tests) that the palette offers through other entries, and the fixtures cover.
const STRUCTURAL = new Set([
  'core:event.start', 'core:event.main', 'core:event.custom', 'core:call.event', 'core:variable.get', 'core:variable.set',
  'core:function.entry', 'core:function.return', 'core:function.call', 'core:macro.inputs', 'core:macro.outputs', 'core:macro.instance',
  'core:dispatcher.call', 'core:dispatcher.bind', 'core:dispatcher.unbind', 'core:dispatcher.unbind-all',
  'core:object.self', 'core:object.get', 'core:object.set', 'core:object.call', 'core:object.event', 'core:object.dispatcher', 'core:object.parent',
  'core:interface.call', 'core:test.case', 'core:test.assert-true', 'core:test.assert-equal',
  // Its input is an object.
  'core:object.is-valid'
]);

// Built, never run: they read files, or give another value each time.
const BUILD_ONLY = new Set([
  'core:file.load-to-string', 'core:file.save-string', 'core:math.random-float-in-range', 'core:math.random-integer-in-range',
  'core:math.random-bool', 'core:array.shuffle', 'core:array.random-item', 'core:time.now', 'core:time.real-time', 'core:utilities.new-uuid'
]);

type Scalar = 'int' | 'float' | 'string' | 'bool';

// Sample values: each type's, then by pin name, then by node and pin.
const SAMPLE: Record<Scalar, unknown> = { int: 2, float: 2.5, string: 'Hello, World', bool: true };
const ARRAYS: Record<Scalar, unknown[]> = { int: [3, 1, 2, 3], float: [2.5, -1, 0.5, 2.5], string: ['b', 'a', 'c', 'a'], bool: [true, false, true] };
// The second operand of a pair (b, right): another array, overlapping the first.
const OTHER_ARRAYS: Record<Scalar, unknown[]> = { int: [2, 5], float: [0.5, 9], string: ['a', 'z'], bool: [false] };
// An element that's in the arrays above, as an `item` or `key`.
const ITEMS: Record<Scalar, unknown> = { int: 2, float: 0.5, string: 'a', bool: false };
const BY_PIN: Record<string, unknown> = {
  a: 7.5, b: 2, count: 3, width: 8, index: 1, start: 1, stop: 7, step: 2, first: 0, second: 2, maxLength: 8, digits: 2,
  decimals: 1, minimum: 1, maximum: 5, firstIndex: 1, lastIndex: 3, n: 2, startIndex: 0, selection: 1, visibleStart: 1,
  visibleEnd: 2, exponent: 3, base: 2, size: 123456, ms: 1700000000000, tolerance: 0.01, alpha: 0.25, duration: 0.01,
  part: 'o', find: 'o', replacement: '0', prefix: 'Hel', suffix: 'rld', fill: '*', mask: '#', separator: '-', delimiter: ',',
  name: 'VG_AUDIT_UNSET', fallback: 'none', filename: 'audit.txt', path: 'a/b/../c.txt', message: 'check',
  inRangeA: 0, inRangeB: 10, outRangeA: 0, outRangeB: 100, end: 5, y: 1, x: 2
};
const BY_NODE: Record<string, Record<string, unknown>> = {
  'core:string.to-int': { text: '42' },
  'core:string.to-float': { text: '2.5' },
  'core:string.parse-integer-strict': { text: '42' },
  'core:string.parse-boolean': { text: 'true' },
  'core:string.is-numeric': { text: '12.5' },
  'core:string.parse-into-array': { text: 'a,b,,c' },
  'core:string.format': { format: '{0} and {1}', items: ['x', 'y'] },
  'core:string.truncate': { suffix: '...' },
  'core:encoding.base64-decode': { text: 'SGVsbG8sIFdvcmxk' },
  'core:encoding.url-decode': { text: 'a%20b%26c' },
  'core:math.wrap': { value: 7, minimum: 0, maximum: 5 },
  'core:math.clamp': { value: 7.5, minimum: 1, maximum: 5 },
  'core:math.in-range': { value: 2.5, start: 1 },
  'core:math.asin': { value: 0.5 },
  'core:math.acos': { value: 0.5 },
  'core:flow.while-loop': { condition: false },
  'core:array.range': { start: 1 }
};

// Wildcard types each node is tried with: single elements, and key and value pairs for maps.
const SINGLES: Scalar[] = ['int', 'float', 'string', 'bool'];
const PAIRS: [Scalar, Scalar][] = [['string', 'int'], ['int', 'string'], ['string', 'float']];

export interface AuditCase {
  index: number;
  definition: NodeDefinition;
  // The wildcard's element type and the map value's, for this case.
  element?: Scalar;
  value?: Scalar;
  // Whether it runs, or is only built.
  run: boolean;
  // How the report names it, e.g. "core:array.sort<string>".
  label: string;
}

export type AuditFindingKind = 'compile' | 'build' | 'crash' | 'output' | 'simulate';

export interface AuditFinding {
  case: string;
  kind: AuditFindingKind;
  message: string;
  expected?: string[];
  actual?: string[];
}

export interface AuditReport {
  pack: string;
  cases: number;
  // How many cases ran and were compared with Simulate (the rest were built only).
  ran?: number;
  findings: AuditFinding[];
  // Why the audit didn't finish in this language (a toolchain is missing, an error it can't place).
  skipped?: string;
  // The language's toolchain isn't installed.
  missingTool?: boolean;
}

function wildcards(def: NodeDefinition): { element: boolean; value: boolean } {
  const ids = [...def.inputs, ...def.outputs].flatMap((p) => (p.type ? [p.type.id, p.type.valueType?.id] : []));
  return { element: ids.some((id) => id === 'wildcard' || id === 'any'), value: ids.some((id) => id === 'wildcard:value') };
}

// The nodes the palette offers in the pack's language, as audit cases.
export function auditCases(definitions: NodeDefinition[], pack: LanguagePack): AuditCase[] {
  const generator = pack.generator;
  if (!generator) return [];
  const cases: AuditCase[] = [];
  for (const definition of definitions) {
    if (STRUCTURAL.has(definition.type) || definition.deprecated) continue;
    if (!implementsCode(definition, generator.snippetLanguages, Object.keys(generator.snippets ?? {}))) continue;
    if (missingCapabilities(nodeRequirements(definition), pack.capabilities).length) continue;
    const run = !BUILD_ONLY.has(definition.type);
    const { element, value } = wildcards(definition);
    const add = (e?: Scalar, v?: Scalar) => {
      const types = [e, v].filter(Boolean).join(', ');
      cases.push({ index: cases.length, definition, ...(e ? { element: e } : {}), ...(v ? { value: v } : {}), run, label: types ? `${definition.type}<${types}>` : definition.type });
    };
    if (value) for (const [e, v] of PAIRS) add(e, v);
    else if (element) for (const e of SINGLES) add(e);
    else add();
  }
  return cases.filter((c) => !needsMissingContainer(c, pack));
}

// A case whose types use a container the language doesn't have (a set of a wildcard's elements).
function needsMissingContainer(c: AuditCase, pack: LanguagePack): boolean {
  const containers = pack.capabilities.containers;
  return !!containers && [...c.definition.inputs, ...c.definition.outputs].some((p) => p.type?.container && !containers.includes(p.type.container));
}

function concrete(type: TypeRef, c: AuditCase): TypeRef {
  const id = (raw: string) => (raw === 'wildcard' || raw === 'any' ? c.element ?? 'string' : raw === 'wildcard:value' ? c.value ?? 'string' : raw);
  return { ...type, id: id(type.id), ...(type.valueType ? { valueType: concrete(type.valueType, c) } : {}) };
}

function sample(c: AuditCase, pin: PinDefinition, type: TypeRef): unknown {
  const own = BY_NODE[c.definition.type]?.[pin.id];
  if (own !== undefined) return own;
  const scalar = type.id as Scalar;
  const wild = pin.type?.id === 'wildcard' || pin.type?.id === 'any' || pin.type?.id === 'wildcard:value';
  const other = pin.id === 'b' || pin.id === 'right';
  if (type.container === 'map') {
    const keys = ARRAYS[scalar] ?? [];
    const values = ARRAYS[type.valueType?.id as Scalar] ?? [];
    // The first key is the sample `key`, so finding it finds something.
    const pairs = [ITEMS[scalar], ...keys.filter((k) => k !== ITEMS[scalar]).slice(0, 1)].map((k, i) => [k, values[(i + 1) % values.length]]);
    return other ? pairs.slice(1).concat([[ITEMS[scalar], values[0]]]) : pairs;
  }
  if (type.container) return (other ? OTHER_ARRAYS : ARRAYS)[scalar] ?? [];
  if (wild) return ITEMS[scalar];
  const byPin = BY_PIN[pin.id];
  if (byPin !== undefined && typeof byPin === (scalar === 'string' ? 'string' : scalar === 'bool' ? 'boolean' : 'number')) return scalar === 'int' && typeof byPin === 'number' ? Math.trunc(byPin) : byPin;
  return SAMPLE[scalar];
}

const node = (id: string, type: string, properties: Record<string, unknown> = {}): GraphNode => ({ id, type, position: { x: 0, y: 0 }, properties });
const wire = (fromNode: string, fromPin: string, toNode: string, toPin: string): GraphConnection => ({ id: `${fromNode}.${fromPin}>${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });

export const marker = (c: AuditCase) => `@@case ${c.index}`;

// The audit's graph in `language`: each case its own custom event, Start calling the ones that run.
export function auditGraph(cases: AuditCase[], language: string): GraphDocument {
  const nodes: GraphNode[] = [node('start', 'core:event.start')];
  const connections: GraphConnection[] = [];
  const variables: GraphVariable[] = [];
  let last = { node: 'start', pin: 'execOut' };
  for (const c of cases) {
    const i = c.index;
    const def = c.definition;
    const event = `Case${i}`;
    nodes.push(node(`e${i}`, 'core:event.custom', { name: event }));
    // The wildcards' types, as the editor records them when a wire gives them.
    const { element, value } = wildcards(def);
    const properties: Record<string, unknown> = element || value ? { wildcards: { ...(element ? { wildcard: c.element } : {}), ...(value ? { 'wildcard:value': c.value } : {}) } } : {};
    nodes.push(node(`n${i}`, def.type, properties));
    for (const pin of def.inputs.filter((p) => p.kind === 'data')) {
      if (!pin.type) continue;
      const type = concrete(pin.type, c);
      const id = `c${i}_${pin.id}`;
      variables.push({ id, name: `C${i} ${pin.id}`, type, defaultValue: sample(c, pin, type) });
      nodes.push(node(`g${i}_${pin.id}`, 'core:variable.get', { variable: id }));
      connections.push(wire(`g${i}_${pin.id}`, 'value', `n${i}`, pin.id));
    }
    const execIn = def.inputs.find((p) => p.kind === 'exec');
    const execOuts = def.outputs.filter((p) => p.kind === 'exec');
    const data = def.outputs.filter((p) => p.kind === 'data');
    // The prints after a point in the case's chain.
    const prints = (from: { node: string; pin: string }, label: string | undefined, outputs: PinDefinition[]) => {
      let at = from;
      const print = (id: string, properties: Record<string, unknown>, source?: { node: string; pin: string }) => {
        nodes.push(node(id, 'core:console.print', properties));
        connections.push(wire(at.node, at.pin, id, 'execIn'));
        if (source) connections.push(wire(source.node, source.pin, id, 'value'));
        at = { node: id, pin: 'execOut' };
      };
      if (label) print(`p${i}_${label}`, { 'pin:value': label });
      for (const pin of outputs) print(`p${i}_${label ?? 'out'}_${pin.id}`, {}, { node: `n${i}`, pin: pin.id });
    };
    if (execIn) {
      connections.push(wire(`e${i}`, 'execOut', `n${i}`, execIn.id));
      if (execOuts.length === 1) prints({ node: `n${i}`, pin: execOuts[0].id }, undefined, data);
      else for (const out of execOuts) prints({ node: `n${i}`, pin: out.id }, out.id, out.id === 'completed' ? [] : data);
    } else {
      prints({ node: `e${i}`, pin: 'execOut' }, undefined, data);
    }
    if (!c.run) continue;
    nodes.push(node(`m${i}`, 'core:console.print', { 'pin:value': marker(c) }));
    nodes.push(node(`call${i}`, 'core:call.event', { event }));
    connections.push(wire(last.node, last.pin, `m${i}`, 'execIn'), wire(`m${i}`, 'execOut', `call${i}`, 'execIn'));
    last = { node: `call${i}`, pin: 'execOut' };
  }
  return {
    schemaVersion: 3, name: 'Audit', kind: 'class', language, variables,
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes, connections }]
  };
}

// The case a node of the audit's graph belongs to.
export function caseOfNode(nodeId: string): number | undefined {
  const match = /^[a-z]+(\d+)/.exec(nodeId);
  return match ? Number(match[1]) : undefined;
}

// What Simulate prints for each case, by running the graph as a TypeScript graph (Simulate runs
// code nodes' TypeScript), and whether it stopped with an error.
export function simulateAudit(doc: GraphDocument, definitions: NodeDefinition[] = []): { lines: string[]; error?: string } {
  const events: RuntimeLogEvent[] = [];
  const runtime = new GraphRuntime(registryOf(definitions), (e) => events.push(e), builtinLanguagePacks());
  runtime.run({ ...doc, language: 'typescript' });
  const error = events.find((e) => e.kind === 'error');
  return { lines: events.filter((e) => e.kind === 'log').map((e) => e.message ?? ''), ...(error ? { error: error.message ?? 'error' } : {}) };
}

// A registry of the audited definitions, in place of the built-in ones of the same types.
function registryOf(definitions: NodeDefinition[]): NodeRegistry {
  const registry = new NodeRegistry();
  registry.registerMany(definitions);
  return registry;
}

// Each case's lines, from the markers.
export function caseSegments(lines: string[]): Map<number, string[]> {
  const segments = new Map<number, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const match = /^@@case (\d+)$/.exec(line);
    if (match) segments.set(Number(match[1]), (current = []));
    else current?.push(line);
  }
  return segments;
}

// The lines of a build's output that name the generated file, as line numbers.
export function errorLines(output: string, fileName: string): number[] {
  const lines = new Set<number>();
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}(?:[:(](\\d+)|", line (\\d+)| on line (\\d+)|:\\s*line (\\d+))`, 'g');
  for (const match of output.matchAll(pattern)) {
    const line = Number(match[1] ?? match[2] ?? match[3] ?? match[4]);
    if (line) lines.add(line);
  }
  return [...lines];
}

export interface AuditOptions {
  workDir?: string;
  timeoutMs?: number;
  // How many rounds to run before giving up on a language whose failures keep moving.
  rounds?: number;
  // Only the cases whose labels contain it.
  filter?: string;
  // Generate options to add, e.g. { moduleFormat: 'commonjs' } for JavaScript.
  generate?: Partial<GenerateOptions>;
  log?: (message: string) => void;
}

// Audits the pack's language: compiles, builds and runs every case, taking out each that fails.
export async function auditPack(pack: LanguagePack, definitions: NodeDefinition[] = builtinNodeDefinitions(), options: AuditOptions = {}): Promise<AuditReport> {
  const generator = pack.generator;
  const runner = generator?.runner;
  const all = auditCases(definitions, pack).filter((c) => !options.filter || c.label.includes(options.filter));
  const report: AuditReport = { pack: pack.id, cases: all.length, findings: [] };
  if (!generator || !runner) return { ...report, skipped: `${pack.displayName} has no generator and runner.` };
  const label = new Map(all.map((c) => [c.index, c.label]));
  const find = (index: number, kind: AuditFindingKind, message: string, more: Partial<AuditFinding> = {}) => report.findings.push({ case: label.get(index) ?? String(index), kind, message, ...more });

  // Cases Simulate can't run with their samples aren't run in the language either.
  for (const c of all.filter((x) => x.run)) {
    const alone = simulateAudit(auditGraph([c], 'typescript'), definitions);
    if (alone.error) {
      c.run = false;
      find(c.index, 'simulate', `Simulate stops with these inputs: ${alone.error}`);
    }
  }

  const ownWorkDir = !options.workDir;
  const workDir = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `vgraph-audit-${pack.id}-`));
  const languages = new LanguagePackRegistry([...builtinLanguagePacks().all().filter((p) => p.id !== pack.id), pack]);
  let cases = all;
  try {
    for (let round = 0; round < (options.rounds ?? 25); round++) {
      const doc = auditGraph(cases, pack.id);
      const result = compileDocument(doc, { registry: registryOf(definitions), languages, generate: { sourceFileName: 'Audit.vgraph', outputDir: '', namespace: 'Audit', ...options.generate } });
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      if (errors.length || !result.output) {
        const placed = new Set(errors.map((d) => (d.nodeId ? caseOfNode(d.nodeId) : undefined)).filter((i): i is number => i !== undefined));
        if (!placed.size) return { ...report, skipped: `It doesn't compile: ${errors.map((d) => d.message).join('; ')}` };
        for (const i of placed) find(i, 'compile', errors.filter((d) => d.nodeId && caseOfNode(d.nodeId) === i).map((d) => d.message).join('; '));
        cases = cases.filter((c) => !placed.has(c.index));
        continue;
      }
      const output = result.output;
      const dir = path.join(workDir, String(round));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, output.fileName);
      fs.writeFileSync(file, output.text);
      for (const companion of output.companionFiles ?? []) fs.writeFileSync(path.join(dir, companion.fileName), companion.text);
      options.log?.(`${pack.id}: round ${round + 1}, ${cases.length} cases`);
      let outcome;
      try {
        outcome = await runGeneratedCode(runner, file, output.className, { cwd: dir, importRoots: [dir], args: [], timeoutMs: options.timeoutMs ?? 300000, ...(output.mainMethod ? { mainMethod: output.mainMethod } : {}) });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return { ...report, skipped: error.message, missingTool: true };
        throw error;
      }
      const actual = outputLines(outcome.stdout);
      const text = `${outcome.stdout}\n${outcome.stderr}`;
      if (outcome.exitCode !== 0 || outcome.timedOut) {
        const segments = caseSegments(actual);
        const ran = [...segments.keys()];
        if (!ran.length) {
          // A build error, before anything ran: traced to its cases through the node lines.
          const sorted = [...output.nodeLines].sort((a, b) => a.line - b.line);
          const placed = new Set<number>();
          for (const line of errorLines(text, output.fileName)) {
            const at = sorted.filter((l) => l.line <= line).pop();
            const index = at && caseOfNode(at.nodeId);
            if (index !== undefined) placed.add(index);
          }
          if (!placed.size) return { ...report, skipped: `The build failed where no case is:\n${text.slice(0, 4000)}` };
          for (const i of placed) find(i, 'build', text.slice(0, 2000));
          cases = cases.filter((c) => !placed.has(c.index));
          continue;
        }
        // A crash: the last case that started.
        const crashed = ran[ran.length - 1];
        find(crashed, 'crash', `${outcome.timedOut ? 'It timed out' : `It exited with code ${outcome.exitCode}`}.\n${outcome.stderr.slice(-2000)}`);
        cases = cases.map((c) => (c.index === crashed ? { ...c, run: false } : c));
        continue;
      }
      // Every case ran: each one's lines against Simulate's.
      const expected = simulateAudit(auditGraph(cases, pack.id), definitions);
      const want = caseSegments(expected.lines);
      const got = caseSegments(actual);
      for (const c of cases.filter((x) => x.run)) {
        if (!want.has(c.index) || !got.has(c.index)) {
          find(c.index, 'output', `It didn't run in ${want.has(c.index) ? pack.displayName : 'Simulate'}.`);
          continue;
        }
        const e = want.get(c.index) ?? [];
        const a = got.get(c.index) ?? [];
        if (!sameLines(e, a)) find(c.index, 'output', 'It printed something else than Simulate.', { expected: e, actual: a });
      }
      return { ...report, ran: cases.filter((x) => x.run).length };
    }
    return { ...report, skipped: 'Failures kept moving after every round.' };
  } finally {
    if (ownWorkDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// The same output, allowing what platforms' math libraries differ in: the last bits of a sine or a
// logarithm. A number still has to be written as Simulate writes numbers (the shortest form that
// reads back), so formatting differences are still found.
export function sameLines(expected: string[], actual: string[]): boolean {
  return expected.length === actual.length && expected.every((e, i) => e === actual[i] || nearlySameNumber(e, actual[i]));
}

function nearlySameNumber(expected: string, actual: string): boolean {
  const e = Number(expected);
  const a = Number(actual);
  if (!Number.isFinite(e) || !Number.isFinite(a) || String(a) !== actual || String(e) !== expected) return false;
  return Math.abs(e - a) <= 4 * Number.EPSILON * Math.max(Math.abs(e), Math.abs(a));
}

export function formatAudit(report: AuditReport): string {
  const lines = [`${report.pack}: ${report.cases} cases, ${report.ran ?? 0} run, ${report.findings.length} findings${report.skipped ? ` (stopped: ${report.skipped.split('\n')[0]})` : ''}`];
  for (const f of report.findings) {
    lines.push(`  [${f.kind}] ${f.case}: ${f.message.split('\n')[0]}`);
    if (f.expected || f.actual) lines.push(`      expected ${JSON.stringify(f.expected)}`, `      actual   ${JSON.stringify(f.actual)}`);
  }
  return lines.join('\n');
}
