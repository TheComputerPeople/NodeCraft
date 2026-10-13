// Edits to a document's structure: its graphs and member variables (Unreal's My Blueprint panel).
// Pure data operations shared by the editor and tests; each mutates the document passed in.
import { Graph, GraphDocument, GraphKind, GraphVariable } from './model';
import { VARIABLE_GET, VARIABLE_SET } from './resolve';
import { createGraph } from './serializer';
import { TypeRef } from './types';
import { defaultValue } from './values';

// The first of `base`, `base_1`, `base_2`, ... not in `taken`, following Unreal's naming.
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 1; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

function uniqueId(prefix: string, name: string, taken: Iterable<string>): string {
  return uniqueName(`${prefix}${name.replace(/[^A-Za-z0-9_]+/g, '_')}`, taken);
}

// Graph kinds a document kind can hold (as in Unreal's asset types).
export function allowedGraphKinds(doc: GraphDocument): GraphKind[] {
  return doc.kind === 'functionLibrary' ? ['function'] : doc.kind === 'macroLibrary' ? ['macro'] : ['event', 'function', 'macro'];
}

const DEFAULT_GRAPH_NAMES: Record<GraphKind, string> = { event: 'NewEventGraph', function: 'NewFunction', macro: 'NewMacro' };

export function addGraph(doc: GraphDocument, kind: GraphKind): Graph {
  if (!allowedGraphKinds(doc).includes(kind)) throw new Error(`A ${doc.kind} can't contain ${kind} graphs.`);
  const name = uniqueName(DEFAULT_GRAPH_NAMES[kind], doc.graphs.map((g) => g.name));
  const graph = { ...createGraph(name, kind), id: uniqueId('', name, doc.graphs.map((g) => g.id)) };
  doc.graphs.push(graph);
  return graph;
}

// Returns an error message instead of renaming when the name is empty or taken.
export function renameGraph(doc: GraphDocument, graphId: string, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'A graph needs a name.';
  if (doc.graphs.some((g) => g.id !== graphId && g.name === trimmed)) return `There is already a graph named "${trimmed}".`;
  const graph = doc.graphs.find((g) => g.id === graphId);
  if (graph) graph.name = trimmed;
  return undefined;
}

export function deleteGraph(doc: GraphDocument, graphId: string): string | undefined {
  if (doc.graphs.length <= 1) return 'A document needs at least one graph.';
  doc.graphs = doc.graphs.filter((g) => g.id !== graphId);
  return undefined;
}

export function addVariable(doc: GraphDocument, type: TypeRef = { id: 'bool' }): GraphVariable {
  if (doc.kind !== 'class') throw new Error('Only classes have variables.');
  const name = uniqueName('NewVar', doc.variables.map((v) => v.name));
  const variable: GraphVariable = { id: uniqueId('var_', name, doc.variables.map((v) => v.id)), name, type, defaultValue: defaultValue(type) };
  doc.variables.push(variable);
  return variable;
}

export function renameVariable(doc: GraphDocument, id: string, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'A variable needs a name.';
  if (doc.variables.some((v) => v.id !== id && v.name === trimmed)) return `There is already a variable named "${trimmed}".`;
  const variable = doc.variables.find((v) => v.id === id);
  if (variable) variable.name = trimmed;
  return undefined;
}

// Changes the type, resetting the default to the new type's default (a default of the old type
// rarely makes sense for the new one).
export function setVariableType(doc: GraphDocument, id: string, type: TypeRef): void {
  const variable = doc.variables.find((v) => v.id === id);
  if (!variable) return;
  variable.type = type;
  variable.defaultValue = defaultValue(type);
}

// Deletes the variable and, as Unreal does, every Get/Set node that uses it. Returns how many
// nodes were removed.
export function deleteVariable(doc: GraphDocument, id: string): number {
  doc.variables = doc.variables.filter((v) => v.id !== id);
  let removed = 0;
  for (const graph of doc.graphs) {
    const doomed = new Set(graph.nodes.filter((n) => (n.type === VARIABLE_GET || n.type === VARIABLE_SET) && n.properties.variable === id).map((n) => n.id));
    if (!doomed.size) continue;
    removed += doomed.size;
    graph.nodes = graph.nodes.filter((n) => !doomed.has(n.id));
    graph.connections = graph.connections.filter((c) => !doomed.has(c.fromNode) && !doomed.has(c.toNode));
  }
  return removed;
}

// How many Get/Set nodes use a variable, across all graphs.
export function variableUses(doc: GraphDocument, id: string): number {
  return doc.graphs.reduce((n, g) => n + g.nodes.filter((node) => (node.type === VARIABLE_GET || node.type === VARIABLE_SET) && node.properties.variable === id).length, 0);
}
