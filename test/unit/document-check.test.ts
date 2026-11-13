// What's inside a graph file (src/core/document-check.ts, docs/audit.md step 3): a file broken by
// hand or by a bad merge gives an error that says where, and nothing in it crashes the compiler.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { MAKE_ARRAY, MAX_ADDED_PINS, adoptedTypes, makeItemCount } from '../../src/core/containers';
import { eventInputs } from '../../src/core/events';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphNode } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { REROUTE, createResolver } from '../../src/core/resolve';
import { parseDocument } from '../../src/core/serializer';
import { repoRoot } from './helpers';

const start = { id: 's', type: 'core:event.start', position: { x: 0, y: 0 }, properties: {} };
const print = { id: 'p', type: 'core:console.print', position: { x: 200, y: 0 }, properties: {} };
const wire = { id: 'c1', fromNode: 's', fromPin: 'execOut', toNode: 'p', toPin: 'execIn' };
const file = (change: (doc: Record<string, any>) => void = () => {}): string => {
  const doc: Record<string, any> = {
    schemaVersion: 3, name: 'Doc', kind: 'class', variables: [{ id: 'v', name: 'Score', type: { id: 'int' } }],
    graphs: [
      { id: 'EventGraph', name: 'EventGraph', kind: 'event', nodes: [structuredClone(start), structuredClone(print)], connections: [structuredClone(wire)], comments: [] },
      { id: 'Add', name: 'Add', kind: 'function', signature: { inputs: [{ id: 'a', name: 'A', kind: 'data', type: { id: 'int' } }], outputs: [] }, nodes: [], connections: [], comments: [] }
    ]
  };
  change(doc);
  return JSON.stringify(doc);
};

describe("a graph file's contents", () => {
  test('a well-formed file parses', () => {
    assert.equal(parseDocument(file()).document.graphs[0].nodes.length, 2);
  });

  const broken: [string, (doc: Record<string, any>) => void, RegExp][] = [
    ['a null connection (a bad merge)', (d) => { d.graphs[0].connections[0] = null; }, /connection 1 in graph "EventGraph" is not an object/],
    ['a connection without its target', (d) => { delete d.graphs[0].connections[0].toNode; }, /connection "c1" in graph "EventGraph" has no toNode/],
    ['a node without a type', (d) => { delete d.graphs[0].nodes[1].type; }, /node "p" in graph "EventGraph" has no type/],
    ['a node whose type is a number', (d) => { d.graphs[0].nodes[1].type = 7; }, /node "p" in graph "EventGraph" has a type that isn't a non-empty string/],
    ['two nodes with one id', (d) => { d.graphs[0].nodes[1].id = 's'; }, /node "s" in graph "EventGraph" has the same id as another node/],
    ['properties that are a list', (d) => { d.graphs[0].nodes[0].properties = []; }, /node "s" in graph "EventGraph" has properties that aren't an object/],
    ['a position that is text', (d) => { d.graphs[0].nodes[0].position = 'here'; }, /has a position without numbers x and y/],
    ['a variable without a type', (d) => { delete d.variables[0].type; }, /variable "v" has no type/],
    ['a type without an id', (d) => { d.variables[0].type = { container: 'array' }; }, /variable "v" has a type without an id/],
    ['an unknown container', (d) => { d.variables[0].type.container = 'bag'; }, /unknown container "bag"/],
    ["a signature's inputs that aren't a list", (d) => { d.graphs[1].signature.inputs = {}; }, /graph "Add"'s signature inputs must be a list/],
    ['a pin of an unknown kind', (d) => { d.graphs[1].signature.inputs[0].kind = 'wire'; }, /pin "a" in graph "Add"'s signature's inputs has an unknown kind "wire"/],
    ['a comment without a size', (d) => { d.graphs[0].comments = [{ id: 'k', text: 'Note', position: { x: 0, y: 0 } }]; }, /comment "k" in graph "EventGraph" has a size without numbers/],
    ['a dispatcher whose inputs are missing', (d) => { d.dispatchers = [{ id: 'd', name: 'OnHit' }]; }, /event dispatcher "d" inputs must be a list/],
    ['a stored signature without pins', (d) => { d.importedFunctions = { 'fn:x': { type: 'fn:x', inputs: [] } }; }, /the stored signature of "fn:x" outputs must be a list/],
    ['a local variable named nothing', (d) => { d.graphs[1].localVariables = [{ id: 'l', name: '', type: { id: 'int' } }]; }, /variable "l" in graph "Add" has a name that isn't a non-empty string/],
    ['a version 1 file whose variables are text', (d) => { delete d.schemaVersion; delete d.graphs; d.nodes = []; d.connections = []; d.variables = 'none'; }, /variables must be a list of objects/]
  ];
  for (const [what, change, message] of broken) {
    test(`${what} gives an error that says where`, () => {
      assert.throws(() => parseDocument(file(change)), (error: Error) => {
        assert.ok(!(error instanceof TypeError), error.stack);
        assert.match(error.message, /^Invalid \.vgraph document: /);
        assert.match(error.message, message);
        return true;
      });
    });
  }

  test("a node's position and properties are filled when they're left out, as in a file written by hand", () => {
    const { document } = parseDocument(file((d) => {
      delete d.graphs[0].nodes[0].position;
      delete d.graphs[0].nodes[0].properties;
    }));
    assert.deepEqual(document.graphs[0].nodes[0], { id: 's', type: 'core:event.start', position: { x: 0, y: 0 }, properties: {} });
  });

  test('every graph file in the repository passes', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'out', '.git', '.vscode-test'].includes(entry.name)) continue;
        const at = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(at);
        else if (entry.name.endsWith('.vgraph')) files.push(at);
      }
    };
    walk(repoRoot);
    assert.ok(files.length > 50, `found ${files.length} graph files`);
    for (const at of files) assert.doesNotThrow(() => parseDocument(fs.readFileSync(at, 'utf8'), path.basename(at, '.vgraph')), at);
  });
});

describe("a node's properties, broken in the file", () => {
  const node = (type: string, properties: Record<string, unknown>): GraphNode => ({ id: 'n', type, position: { x: 0, y: 0 }, properties });

  test('a node asking for billions of added pins gets at most MAX_ADDED_PINS', () => {
    assert.equal(makeItemCount(node(MAKE_ARRAY, { pins: 99999999999 })), MAX_ADDED_PINS);
    assert.equal(makeItemCount(node(MAKE_ARRAY, { pins: 3 })), 3);
  });

  test("adopted element types that aren't type ids are left out", () => {
    assert.deepEqual(adoptedTypes(node(MAKE_ARRAY, { wildcards: { T: 'int', U: {}, V: null } })), { T: 'int' });
    assert.deepEqual(adoptedTypes(node(MAKE_ARRAY, { wildcards: ['int'] })), {});
  });

  test("a Custom Event's broken parameters are left out", () => {
    const pin = { id: 'n', name: 'N', kind: 'data', type: { id: 'int' } };
    assert.deepEqual(eventInputs(node('core:event.custom', { inputs: [pin, { ...pin, id: null }, { ...pin, type: { id: 3 } }, 'x'] })), [pin]);
  });

  test("a Reroute's type that isn't a type is ignored", () => {
    const registry = new NodeRegistry();
    const resolve = createResolver(registry, { variables: [], graphs: [] });
    const pins = resolve(node(REROUTE, { type: { id: null } }))!;
    assert.deepEqual(pins.inputs.map((p) => p.type), registry.get(REROUTE)!.inputs.map((p) => p.type));
  });
});

// The fuzzer from the audit: mutated fixture graphs, parsed and compiled in their language and one
// other. A broken file must give a readable error or compile diagnostics, never a TypeError.
describe('mutated graph files', () => {
  const dir = path.join(repoRoot, 'test/fixtures/graphs');
  const seeds = fs.readdirSync(dir).filter((f) => f.endsWith('.vgraph')).map((f) => ({ file: f, json: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as unknown }));
  const languages = builtinLanguagePacks();
  const ids = languages.all().filter((p) => p.generator).map((p) => p.id);
  const REPLACEMENTS = [null, 0, -1, 1.5, '', 'x', '__proto__', {}, [], true, 'string', 'int', 'exec', 99999999999, 'object:Nope', 'code:ts:x#Y'];

  function fuzz(seed: number, iterations: number): string[] {
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
    const paths = (value: unknown, at: string[] = [], into: string[][] = []): string[][] => {
      into.push(at);
      if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) paths(v, [...at, k], into);
      return into;
    };
    const mutate = (json: unknown): unknown => {
      const copy = structuredClone(json) as Record<string, unknown>;
      const all = paths(copy).filter((p) => p.length);
      for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n; i++) {
        const at = pick(all);
        let parent: any = copy;
        for (const k of at.slice(0, -1)) parent = parent?.[k];
        if (!parent || typeof parent !== 'object') continue;
        const key = at[at.length - 1];
        const r = rand();
        if (r < 0.2 && !Array.isArray(parent)) delete parent[key];
        else if (r < 0.3 && Array.isArray(parent)) parent.push(structuredClone(parent[Number(key)]));
        else if (r < 0.4 && typeof parent[key] === 'string') parent[key] = parent[key] + pick(['"', "'", '\\', '\n', '${x}', '#{x}', '*/', '$', '?>', ']]', ' ']);
        else parent[key] = structuredClone(pick(REPLACEMENTS));
      }
      return copy;
    };
    const crashes = new Set<string>();
    const where = (error: unknown) => `${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)} ${(error instanceof Error && error.stack?.split('\n')[1]?.trim()) || ''}`;
    for (let i = 0; i < iterations; i++) {
      const s = pick(seeds);
      let doc;
      try {
        doc = parseDocument(JSON.stringify(mutate(s.json)), 'Fuzz').document;
      } catch (error) {
        if (error instanceof TypeError || !(error instanceof Error) || !/^(Invalid \.vgraph|This graph uses schema)/.test(error.message)) crashes.add(`parse ${s.file}: ${where(error)}`);
        continue;
      }
      for (const language of [doc.language ?? 'typescript', pick(ids)]) {
        try {
          compileDocument({ ...structuredClone(doc), language }, { registry: new NodeRegistry(), languages, generate: { sourceFileName: 'Fuzz.vgraph' } });
        } catch (error) {
          crashes.add(`compile ${s.file} in ${language}: ${where(error)}`);
        }
      }
    }
    return [...crashes];
  }

  for (const seed of [12345, 777]) {
    test(`parse and compile without crashing (seed ${seed})`, () => {
      assert.deepEqual(fuzz(seed, 1500), []);
    });
  }
});
