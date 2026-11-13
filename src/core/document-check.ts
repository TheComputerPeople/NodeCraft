// What each part of a .vgraph file must be (docs/audit.md, step 3). parseDocument checks a file's
// outline; this checks what's inside it (nodes, connections, comments, pins, signatures, variables,
// enumerators, dispatchers and stored function signatures), so a file broken by hand or by a bad
// merge gives an error that says where, not a TypeError somewhere in the compiler or the editor.
// It checks shapes only: what a node's properties mean is up to the node, and wires to nodes or
// pins that don't exist are compile errors.
import type { Graph, GraphDocument } from './model';

const CONTAINERS = ['array', 'set', 'map'];
const PIN_KINDS = ['exec', 'data'];
const ACCESS = ['public', 'protected', 'private'];

type Value = Record<string, unknown>;

function fail(where: string, problem: string): never {
  throw new Error(`Invalid .vgraph document: ${where} ${problem}.`);
}

function isObject(value: unknown): value is Value {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isPoint = (value: unknown, a: string, b: string) => isObject(value) && Number.isFinite(value[a]) && Number.isFinite(value[b]);

// "node "n3"" when the item has an id, else "node 3".
function label(what: string, item: unknown, index: number): string {
  return isObject(item) && typeof item.id === 'string' && item.id ? `${what} "${item.id}"` : `${what} ${index + 1}`;
}

function list(value: unknown, where: string, what: string): unknown[] {
  if (!Array.isArray(value)) fail(where, `${what} must be a list`);
  return value as unknown[];
}

function text(item: Value, key: string, where: string, required: boolean, nonEmpty = false): void {
  const value = item[key];
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || (nonEmpty && !value)) fail(where, value === undefined ? `has no ${key}` : `has a ${key} that isn't ${nonEmpty ? 'a non-empty' : 'a'} string`);
}

function typeRef(value: unknown, where: string): void {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id) fail(where, 'has a type without an id');
  if (value.container !== undefined && !CONTAINERS.includes(value.container as string)) fail(where, `has an unknown container "${String(value.container)}"`);
  if (value.valueType !== undefined) typeRef(value.valueType, `${where}'s value type`);
  if (value.nullable !== undefined && typeof value.nullable !== 'boolean') fail(where, 'has a nullable that isn\'t true or false');
}

// A signature's pin, a dispatcher's input, or a stored node definition's pin.
function pin(value: unknown, where: string): void {
  if (!isObject(value)) fail(where, 'is not an object');
  text(value, 'id', where, true, true);
  text(value, 'name', where, true);
  if (!PIN_KINDS.includes(value.kind as string)) fail(where, `has an unknown kind "${String(value.kind)}"`);
  if (value.type !== undefined) typeRef(value.type, where);
}

function pins(value: unknown, where: string, what: string): void {
  list(value, where, what).forEach((p, i) => pin(p, `${label('pin', p, i)} in ${where}'s ${what}`));
}

function variable(value: unknown, where: string): void {
  if (!isObject(value)) fail(where, 'is not an object');
  text(value, 'id', where, true, true);
  text(value, 'name', where, true, true);
  if (value.type === undefined) fail(where, 'has no type');
  typeRef(value.type, where);
  if (value.access !== undefined && !ACCESS.includes(value.access as string)) fail(where, `has an unknown access "${String(value.access)}"`);
  text(value, 'category', where, false);
  text(value, 'description', where, false);
}

function variables(value: unknown, where: string, what: string): void {
  const ids = new Set<string>();
  list(value, where, what).forEach((v, i) => {
    const at = `${label('variable', v, i)}${where ? ` in ${where}` : ''}`;
    variable(v, at);
    const id = (v as Value).id as string;
    if (ids.has(id)) fail(at, 'has the same id as another variable');
    ids.add(id);
  });
}

function signature(value: unknown, where: string): void {
  if (!isObject(value)) fail(where, 'has a signature that isn\'t an object');
  pins(value.inputs, `${where}'s signature`, 'inputs');
  pins(value.outputs, `${where}'s signature`, 'outputs');
  if (value.pure !== undefined && typeof value.pure !== 'boolean') fail(where, 'has a pure that isn\'t true or false');
  for (const key of ['description', 'category', 'compactTitle']) text(value, key, `${where}'s signature`, false);
  if (value.access !== undefined && !ACCESS.includes(value.access as string)) fail(where, `has an unknown access "${String(value.access)}"`);
  if (value.keywords !== undefined && (!Array.isArray(value.keywords) || value.keywords.some((k) => typeof k !== 'string'))) fail(where, 'has keywords that aren\'t a list of strings');
  if (value.deprecated !== undefined && !isObject(value.deprecated)) fail(where, 'has a deprecated that isn\'t an object');
}

// Fills a node's position and properties when they're left out, as in a hand-written file.
function graphContents(graph: Graph): void {
  const where = `graph "${graph.id}"`;
  if (graph.signature !== undefined) signature(graph.signature, where);
  if (graph.localVariables !== undefined) variables(graph.localVariables, where, 'local variables');
  const nodes = new Set<string>();
  graph.nodes.forEach((node: unknown, i) => {
    const at = `${label('node', node, i)} in ${where}`;
    if (!isObject(node)) fail(at, 'is not an object');
    text(node, 'id', at, true, true);
    if (nodes.has(node.id as string)) fail(at, 'has the same id as another node');
    nodes.add(node.id as string);
    text(node, 'type', at, true, true);
    if (node.position === undefined) node.position = { x: 0, y: 0 };
    else if (!isPoint(node.position, 'x', 'y')) fail(at, 'has a position without numbers x and y');
    if (node.properties === undefined) node.properties = {};
    else if (!isObject(node.properties)) fail(at, 'has properties that aren\'t an object');
  });
  graph.connections.forEach((connection: unknown, i) => {
    const at = `${label('connection', connection, i)} in ${where}`;
    if (!isObject(connection)) fail(at, 'is not an object');
    for (const key of ['id', 'fromNode', 'fromPin', 'toNode', 'toPin']) text(connection, key, at, true, true);
  });
  graph.comments.forEach((comment: unknown, i) => {
    const at = `${label('comment', comment, i)} in ${where}`;
    if (!isObject(comment)) fail(at, 'is not an object');
    text(comment, 'id', at, true, true);
    text(comment, 'text', at, true);
    if (!isPoint(comment.position, 'x', 'y')) fail(at, 'has a position without numbers x and y');
    if (!isPoint(comment.size, 'width', 'height')) fail(at, 'has a size without numbers width and height');
    text(comment, 'color', at, false);
  });
}

// Throws with a readable message for the first part of the document that isn't what it must be.
export function checkDocumentContents(doc: GraphDocument): void {
  variables(doc.variables, '', 'variables');
  for (const graph of doc.graphs) graphContents(graph);
  if (doc.enumerators !== undefined) {
    const names = new Set<string>();
    doc.enumerators.forEach((e: unknown, i) => {
      const at = label('enumerator', e, i);
      if (!isObject(e)) fail(at, 'is not an object');
      text(e, 'id', at, true, true);
      text(e, 'name', at, true, true);
      text(e, 'description', at, false);
      if (names.has(e.name as string)) fail(at, `has the same name as another enumerator, "${String(e.name)}"`);
      names.add(e.name as string);
    });
  }
  doc.dispatchers?.forEach((d: unknown, i) => {
    const at = label('event dispatcher', d, i);
    if (!isObject(d)) fail(at, 'is not an object');
    text(d, 'id', at, true, true);
    text(d, 'name', at, true, true);
    text(d, 'description', at, false);
    pins(d.inputs, at, 'inputs');
  });
  if (doc.importedFunctions !== undefined) {
    if (!isObject(doc.importedFunctions)) fail('importedFunctions', 'isn\'t an object');
    for (const [type, definition] of Object.entries(doc.importedFunctions)) {
      const at = `the stored signature of "${type}"`;
      if (!isObject(definition)) fail(at, 'is not an object');
      text(definition, 'type', at, true, true);
      text(definition, 'displayName', at, false);
      pins(definition.inputs, at, 'inputs');
      pins(definition.outputs, at, 'outputs');
      const implementation: unknown = definition.implementation;
      if (implementation !== undefined && (!isObject(implementation) || typeof implementation.kind !== 'string')) fail(at, 'has an implementation without a kind');
      if (isObject(implementation) && implementation.kind === 'function') for (const key of ['language', 'path', 'name']) text(implementation, key, `${at}'s implementation`, true);
    }
  }
}
