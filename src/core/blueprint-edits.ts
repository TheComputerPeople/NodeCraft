// Edits to a document's structure: its graphs and member variables (Unreal's My Blueprint panel).
// Pure data operations shared by the editor and tests; each mutates the document passed in.
import { FUNCTION_CALL, FUNCTION_ENTRY, FUNCTION_RETURN, allLocalVariables } from './functions';
import { Graph, GraphDocument, GraphKind, GraphPin, GraphVariable } from './model';
import { VARIABLE_GET, VARIABLE_SET } from './resolve';
import { createGraph } from './serializer';
import { TypeRef } from './types';
import { storedDefault } from './values';

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
  // A new function starts with its entry node, as in Unreal.
  if (kind === 'function') graph.nodes.push({ id: 'entry', type: FUNCTION_ENTRY, position: { x: 0, y: 0 }, properties: { graph: graph.id } });
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
  const variable: GraphVariable = { id: uniqueId('var_', name, doc.variables.map((v) => v.id)), name, type, defaultValue: storedDefault(type) };
  doc.variables.push(variable);
  return variable;
}

// A member variable, or a function's local variable, and the list it is in.
export function findVariable(doc: GraphDocument, id: string): { variable: GraphVariable; siblings: GraphVariable[]; graph?: Graph } | undefined {
  const member = doc.variables.find((v) => v.id === id);
  if (member) return { variable: member, siblings: doc.variables };
  for (const graph of doc.graphs) {
    const local = graph.localVariables?.find((v) => v.id === id);
    if (local) return { variable: local, siblings: graph.localVariables!, graph };
  }
  return undefined;
}

export function renameVariable(doc: GraphDocument, id: string, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'A variable needs a name.';
  const found = findVariable(doc, id);
  if (found?.siblings.some((v) => v.id !== id && v.name === trimmed)) return `There is already a variable named "${trimmed}".`;
  if (found) found.variable.name = trimmed;
  return undefined;
}

// Changes the type, resetting the default to the new type's default (a default of the old type
// rarely makes sense for the new one).
export function setVariableType(doc: GraphDocument, id: string, type: TypeRef): void {
  const variable = findVariable(doc, id)?.variable;
  if (!variable) return;
  variable.type = type;
  variable.defaultValue = storedDefault(type);
}

// A local variable of a function: it starts at its default on every call (Unreal's Local Variables).
export function addLocalVariable(doc: GraphDocument, graphId: string, type: TypeRef = { id: 'bool' }): GraphVariable {
  const graph = doc.graphs.find((g) => g.id === graphId && g.kind === 'function');
  if (!graph) throw new Error('Only functions have local variables.');
  const locals = (graph.localVariables ??= []);
  const name = uniqueName('NewLocalVar', locals.map((v) => v.name));
  const taken = [...doc.variables, ...allLocalVariables(doc)].map((v) => v.id);
  const variable: GraphVariable = { id: uniqueId('local_', `${graph.id}_${name}`, taken), name, type, defaultValue: storedDefault(type) };
  locals.push(variable);
  return variable;
}

// Deletes the variable and, as Unreal does, every Get/Set node that uses it. Returns how many
// nodes were removed.
export function deleteVariable(doc: GraphDocument, id: string): number {
  doc.variables = doc.variables.filter((v) => v.id !== id);
  for (const graph of doc.graphs) if (graph.localVariables) graph.localVariables = graph.localVariables.filter((v) => v.id !== id);
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

// ---- Function signatures (Unreal's Inputs and Outputs in a function's Details) -------------------

export type SignatureSide = 'inputs' | 'outputs';

function signatureOf(doc: GraphDocument, graphId: string): Graph['signature'] & object | undefined {
  const graph = doc.graphs.find((g) => g.id === graphId && g.kind === 'function');
  if (!graph) return undefined;
  return (graph.signature ??= { inputs: [], outputs: [] });
}

// Adds an input or output (a bool named NewParam, as Unreal does). A function's first output also
// gets a Return Node, wired after the entry if nothing follows it yet.
export function addSignaturePin(doc: GraphDocument, graphId: string, side: SignatureSide, type: TypeRef = { id: 'bool' }): GraphPin | undefined {
  const signature = signatureOf(doc, graphId);
  const graph = doc.graphs.find((g) => g.id === graphId);
  if (!signature || !graph) return undefined;
  const pins = signature[side];
  const name = uniqueName('NewParam', pins.map((p) => p.name));
  const pin: GraphPin = { id: uniqueId('', name, [...signature.inputs, ...signature.outputs].map((p) => p.id)), name, kind: 'data', type };
  pins.push(pin);
  if (side === 'outputs' && !graph.nodes.some((n) => n.type === FUNCTION_RETURN)) {
    const entry = graph.nodes.find((n) => n.type === FUNCTION_ENTRY);
    const id = uniqueName('return', graph.nodes.map((n) => n.id));
    graph.nodes.push({ id, type: FUNCTION_RETURN, position: { x: (entry?.position.x ?? 0) + 400, y: entry?.position.y ?? 0 }, properties: { graph: graphId } });
    if (entry && !graph.connections.some((c) => c.fromNode === entry.id && c.fromPin === 'execOut')) {
      graph.connections.push({ id: uniqueName(`${entry.id}_return`, graph.connections.map((c) => c.id)), fromNode: entry.id, fromPin: 'execOut', toNode: id, toPin: 'execIn' });
    }
  }
  return pin;
}

export function renameSignaturePin(doc: GraphDocument, graphId: string, side: SignatureSide, pinId: string, name: string): string | undefined {
  const trimmed = name.trim();
  const pins = signatureOf(doc, graphId)?.[side];
  if (!trimmed) return 'A parameter needs a name.';
  if (pins?.some((p) => p.id !== pinId && p.name === trimmed)) return `There is already a parameter named "${trimmed}".`;
  const pin = pins?.find((p) => p.id === pinId);
  if (pin) pin.name = trimmed;
  return undefined;
}

// Changes a parameter's type; its wires (on the entry, return and call nodes) are removed, as their
// other ends no longer fit, and so is any value typed on call nodes.
export function setSignaturePinType(doc: GraphDocument, graphId: string, side: SignatureSide, pinId: string, type: TypeRef): void {
  const pin = signatureOf(doc, graphId)?.[side].find((p) => p.id === pinId);
  if (!pin) return;
  pin.type = type;
  delete pin.defaultValue;
  forgetSignaturePin(doc, graphId, side, pinId);
}

export function removeSignaturePin(doc: GraphDocument, graphId: string, side: SignatureSide, pinId: string): void {
  const signature = signatureOf(doc, graphId);
  if (!signature) return;
  signature[side] = signature[side].filter((p) => p.id !== pinId);
  forgetSignaturePin(doc, graphId, side, pinId);
}

// Removes the wires and stored values of a parameter on every node that shows it: the function's
// entry (inputs) or return nodes (outputs), and its call nodes anywhere.
function forgetSignaturePin(doc: GraphDocument, graphId: string, side: SignatureSide, pinId: string): void {
  for (const graph of doc.graphs) {
    const nodes = new Set(graph.nodes.filter((n) => n.properties.graph === graphId && (n.type === FUNCTION_CALL || (graph.id === graphId && n.type === (side === 'inputs' ? FUNCTION_ENTRY : FUNCTION_RETURN)))).map((n) => n.id));
    graph.connections = graph.connections.filter((c) => !((nodes.has(c.toNode) && c.toPin === pinId) || (nodes.has(c.fromNode) && c.fromPin === pinId)));
    for (const node of graph.nodes) if (nodes.has(node.id)) delete node.properties[`pin:${pinId}`];
  }
}

// A pure function's call nodes have no exec pins, so making a function pure removes their exec wires.
export function setFunctionPure(doc: GraphDocument, graphId: string, pure: boolean): void {
  const signature = signatureOf(doc, graphId);
  if (!signature) return;
  if (pure) signature.pure = true;
  else delete signature.pure;
  if (!pure) return;
  for (const graph of doc.graphs) {
    const calls = new Set(graph.nodes.filter((n) => n.type === FUNCTION_CALL && n.properties.graph === graphId).map((n) => n.id));
    graph.connections = graph.connections.filter((c) => !((calls.has(c.toNode) && c.toPin === 'execIn') || (calls.has(c.fromNode) && c.fromPin === 'execOut')));
  }
}

// How many nodes call a function, across all graphs.
export function functionUses(doc: GraphDocument, graphId: string): number {
  return doc.graphs.reduce((n, g) => n + g.nodes.filter((node) => node.type === FUNCTION_CALL && node.properties.graph === graphId).length, 0);
}
