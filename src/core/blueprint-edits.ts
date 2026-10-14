// Edits to a document's structure: its graphs and member variables (Unreal's My Blueprint panel).
// Pure data operations shared by the editor and tests; each mutates the document passed in.
import { FUNCTION_CALL, FUNCTION_ENTRY, FUNCTION_RETURN, allLocalVariables } from './functions';
import { MACRO_INPUTS, MACRO_INSTANCE, MACRO_OUTPUTS } from './macros';
import { DocumentKind, Graph, GraphConnection, GraphDocument, GraphKind, GraphNode, GraphPin, GraphVariable, NodeDefinition } from './model';
import { VARIABLE_GET, VARIABLE_SET } from './resolve';
import { createEmptyDocument, createGraph } from './serializer';
import { TypeRef } from './types';
import { storedDefault } from './values';
import { Enumerator } from './user-types';

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
  if (doc.kind === 'structure' || doc.kind === 'enumeration') return [];
  return doc.kind === 'functionLibrary' ? ['function'] : doc.kind === 'macroLibrary' ? ['macro'] : ['event', 'function', 'macro'];
}

const DEFAULT_GRAPH_NAMES: Record<GraphKind, string> = { event: 'NewEventGraph', function: 'NewFunction', macro: 'NewMacro' };

export function addGraph(doc: GraphDocument, kind: GraphKind): Graph {
  if (!allowedGraphKinds(doc).includes(kind)) throw new Error(`A ${doc.kind} can't contain ${kind} graphs.`);
  const name = uniqueName(DEFAULT_GRAPH_NAMES[kind], doc.graphs.map((g) => g.name));
  const graph = { ...createGraph(name, kind), id: uniqueId('', name, doc.graphs.map((g) => g.id)) };
  // A new function starts with its entry node, and a macro with its Inputs and Outputs, as in Unreal.
  if (kind === 'function') graph.nodes.push({ id: 'entry', type: FUNCTION_ENTRY, position: { x: 0, y: 0 }, properties: { graph: graph.id } });
  if (kind === 'macro') {
    graph.nodes.push(
      { id: 'inputs', type: MACRO_INPUTS, position: { x: 0, y: 0 }, properties: { graph: graph.id } },
      { id: 'outputs', type: MACRO_OUTPUTS, position: { x: 500, y: 0 }, properties: { graph: graph.id } }
    );
  }
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

// A class's member variable, or a structure's field (Unreal's struct editor names new fields
// MemberVar).
export function addVariable(doc: GraphDocument, type: TypeRef = { id: 'bool' }): GraphVariable {
  if (doc.kind !== 'class' && doc.kind !== 'structure') throw new Error('Only classes have variables, and structures fields.');
  const name = uniqueName(doc.kind === 'structure' ? 'MemberVar' : 'NewVar', doc.variables.map((v) => v.name));
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

// ---- Function and macro signatures (Unreal's Inputs and Outputs in their Details) ----------------

export type SignatureSide = 'inputs' | 'outputs';

// A pin's type in a signature; macros may also have exec pins.
export type SignatureType = TypeRef | 'exec';

function signatureOf(doc: GraphDocument, graphId: string): Graph['signature'] & object | undefined {
  const graph = doc.graphs.find((g) => g.id === graphId && (g.kind === 'function' || g.kind === 'macro'));
  if (!graph) return undefined;
  return (graph.signature ??= { inputs: [], outputs: [] });
}

// Adds an input or output (a bool named NewParam, as Unreal does). A function's first output also
// gets a Return Node, wired after the entry if nothing follows it yet.
export function addSignaturePin(doc: GraphDocument, graphId: string, side: SignatureSide, type: SignatureType = { id: 'bool' }): GraphPin | undefined {
  const signature = signatureOf(doc, graphId);
  const graph = doc.graphs.find((g) => g.id === graphId);
  if (!signature || !graph) return undefined;
  const pins = signature[side];
  const name = uniqueName('NewParam', pins.map((p) => p.name));
  const id = uniqueId('', name, [...signature.inputs, ...signature.outputs].map((p) => p.id));
  const pin: GraphPin = type === 'exec' ? { id, name, kind: 'exec' } : { id, name, kind: 'data', type };
  pins.push(pin);
  if (graph.kind === 'function' && side === 'outputs' && !graph.nodes.some((n) => n.type === FUNCTION_RETURN)) {
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

// Changes a parameter's type (or, in a macro, makes it an exec pin); its wires (on the entry, return
// and call nodes, or the tunnels and instances) are removed, as their other ends no longer fit, and
// so is any value typed on call nodes.
export function setSignaturePinType(doc: GraphDocument, graphId: string, side: SignatureSide, pinId: string, type: SignatureType): void {
  const pin = signatureOf(doc, graphId)?.[side].find((p) => p.id === pinId);
  if (!pin) return;
  if (type === 'exec') {
    pin.kind = 'exec';
    delete pin.type;
  } else {
    pin.kind = 'data';
    pin.type = type;
  }
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
// entry (inputs) or return nodes (outputs), or the macro's tunnel, and its call or instance nodes
// anywhere.
function forgetSignaturePin(doc: GraphDocument, graphId: string, side: SignatureSide, pinId: string): void {
  const own = side === 'inputs' ? [FUNCTION_ENTRY, MACRO_INPUTS] : [FUNCTION_RETURN, MACRO_OUTPUTS];
  for (const graph of doc.graphs) {
    const nodes = new Set(graph.nodes.filter((n) => n.properties.graph === graphId && (n.type === FUNCTION_CALL || n.type === MACRO_INSTANCE || (graph.id === graphId && own.includes(n.type)))).map((n) => n.id));
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

// How many nodes call a function or use a macro, across all graphs.
export function functionUses(doc: GraphDocument, graphId: string): number {
  return doc.graphs.reduce((n, g) => n + g.nodes.filter((node) => (node.type === FUNCTION_CALL || node.type === MACRO_INSTANCE) && node.properties.graph === graphId).length, 0);
}

// ---- Collapse to Function (Unreal's node menu command) ----------------------------------------

export interface CollapseResult {
  function: Graph;
  call: GraphNode;
}

// Moves the selected nodes of `graph` into a new function and calls it in their place, as Unreal's
// Collapse to Function does. Wires that crossed the selection become the function's inputs (one per
// outside output feeding it) and outputs (one per inside output used outside). Execution must enter
// the selection at one pin and leave it from one; a selection with no exec pins becomes a pure
// function. Returns the new function and call node, or why the selection can't be collapsed.
export function collapseToFunction(
  doc: GraphDocument,
  graph: Graph,
  nodeIds: ReadonlySet<string>,
  lookup: (node: GraphNode) => NodeDefinition | undefined,
  connectionId: () => string
): CollapseResult | string {
  if (!allowedGraphKinds(doc).includes('function')) return 'Only blueprints that hold functions can collapse nodes into one.';
  const inside = graph.nodes.filter((n) => nodeIds.has(n.id));
  if (!inside.length) return 'Select the nodes to collapse.';
  if (inside.some((n) => n.type.startsWith('core:event.') || n.type === FUNCTION_ENTRY || n.type === FUNCTION_RETURN)) return "Events, entry and return nodes can't be collapsed into a function.";
  const localIds = new Set(allLocalVariables({ graphs: [graph] }).map((v) => v.id));
  if (inside.some((n) => localIds.has(String(n.properties.variable)))) return "The selection uses the function's local variables, which the new function couldn't see.";

  const isInside = (id: string) => nodeIds.has(id);
  const pinOf = (nodeId: string, pinId: string, side: 'inputs' | 'outputs') => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    return node ? lookup(node)?.[side].find((p) => p.id === pinId) : undefined;
  };
  const incoming = graph.connections.filter((c) => !isInside(c.fromNode) && isInside(c.toNode));
  const outgoing = graph.connections.filter((c) => isInside(c.fromNode) && !isInside(c.toNode));
  const internal = graph.connections.filter((c) => isInside(c.fromNode) && isInside(c.toNode));
  const isExec = (c: GraphConnection) => pinOf(c.fromNode, c.fromPin, 'outputs')?.kind === 'exec';

  // Classified now: the moved nodes leave the graph before the wires are redone.
  const execIn = incoming.filter(isExec);
  const execOut = outgoing.filter(isExec);
  const dataIn = incoming.filter((c) => !isExec(c));
  const dataOut = outgoing.filter((c) => !isExec(c));
  const execEntries = [...new Set(execIn.map((c) => `${c.toNode}\u0000${c.toPin}`))];
  const execExits = [...new Set(execOut.map((c) => `${c.fromNode}\u0000${c.fromPin}`))];
  if (execEntries.length > 1) return 'Execution enters the selection in more than one place; a function has one way in.';
  if (execExits.length > 1) return 'Execution leaves the selection from more than one place; a function has one way out.';
  const pure = !inside.some((n) => [...(lookup(n)?.inputs ?? []), ...(lookup(n)?.outputs ?? [])].some((p) => p.kind === 'exec'));

  // The function and its signature: an input per outside output feeding the selection, an output per
  // inside output used outside.
  const fn = addGraph(doc, 'function');
  const signature = (fn.signature ??= { inputs: [], outputs: [] });
  if (pure) signature.pure = true;
  const taken = new Set<string>();
  const newPin = (name: string, type: GraphPin['type']): GraphPin => {
    const pinName = uniqueName(name || 'Value', [...signature.inputs, ...signature.outputs].map((p) => p.name));
    const id = uniqueId('', pinName, taken);
    taken.add(id);
    return { id, name: pinName, kind: 'data', ...(type ? { type } : {}) };
  };
  const inputBySource = new Map<string, GraphPin>();
  for (const c of dataIn) {
    const key = `${c.fromNode}\u0000${c.fromPin}`;
    if (inputBySource.has(key)) continue;
    const pin = newPin(pinOf(c.toNode, c.toPin, 'inputs')?.name ?? '', pinOf(c.fromNode, c.fromPin, 'outputs')?.type);
    signature.inputs.push(pin);
    inputBySource.set(key, pin);
  }
  const outputBySource = new Map<string, GraphPin>();
  for (const c of dataOut) {
    const key = `${c.fromNode}\u0000${c.fromPin}`;
    if (outputBySource.has(key)) continue;
    const source = pinOf(c.fromNode, c.fromPin, 'outputs');
    const pin = newPin(source?.name ?? '', source?.type);
    signature.outputs.push(pin);
    outputBySource.set(key, pin);
  }

  // Move the nodes, keeping their layout, to the right of the entry node.
  const minX = Math.min(...inside.map((n) => n.position.x));
  const minY = Math.min(...inside.map((n) => n.position.y));
  const center = { x: inside.reduce((sum, n) => sum + n.position.x, 0) / inside.length, y: inside.reduce((sum, n) => sum + n.position.y, 0) / inside.length };
  const entry = fn.nodes[0];
  const moved = inside.map((n) => ({ ...n, position: { x: n.position.x - minX + 350, y: n.position.y - minY } }));
  const ids = new Set(moved.map((n) => n.id));
  if (ids.has(entry.id)) entry.id = uniqueName('entry', ids);
  fn.nodes.push(...moved);
  fn.connections.push(...internal);
  const wireIn = (fromNode: string, fromPin: string, toNode: string, toPin: string) => fn.connections.push({ id: connectionId(), fromNode, fromPin, toNode, toPin });

  for (const c of dataIn) wireIn(entry.id, inputBySource.get(`${c.fromNode}\u0000${c.fromPin}`)!.id, c.toNode, c.toPin);
  if (execIn.length) wireIn(entry.id, 'execOut', execIn[0].toNode, execIn[0].toPin);
  const needsReturn = signature.outputs.length > 0 || execOut.length > 0;
  if (needsReturn) {
    const ret: GraphNode = { id: uniqueName('return', [...ids, entry.id]), type: FUNCTION_RETURN, position: { x: Math.max(...moved.map((n) => n.position.x)) + 350, y: 0 }, properties: { graph: fn.id } };
    fn.nodes.push(ret);
    for (const [key, pin] of outputBySource) {
      const [node, out] = key.split('\u0000');
      wireIn(node, out, ret.id, pin.id);
    }
    if (execOut.length) wireIn(execOut[0].fromNode, execOut[0].fromPin, ret.id, 'execIn');
    // Only pure nodes: the return follows the entry directly.
    else if (pure) wireIn(entry.id, 'execOut', ret.id, 'execIn');
  }

  // In the original graph: the call takes the nodes' place and their outside wires.
  const call: GraphNode = { id: uniqueName(`call_${fn.id}`, graph.nodes.map((n) => n.id)), type: FUNCTION_CALL, position: center, properties: { graph: fn.id } };
  graph.nodes = graph.nodes.filter((n) => !isInside(n.id));
  graph.nodes.push(call);
  graph.connections = graph.connections.filter((c) => !isInside(c.fromNode) && !isInside(c.toNode));
  const wireOut = (fromNode: string, fromPin: string, toNode: string, toPin: string) => graph.connections.push({ id: connectionId(), fromNode, fromPin, toNode, toPin });
  for (const [key, pin] of inputBySource) {
    const [node, out] = key.split('\u0000');
    wireOut(node, out, call.id, pin.id);
  }
  for (const c of execIn) wireOut(c.fromNode, c.fromPin, call.id, 'execIn');
  for (const c of dataOut) wireOut(call.id, outputBySource.get(`${c.fromNode}\u0000${c.fromPin}`)!.id, c.toNode, c.toPin);
  for (const c of execOut) wireOut(call.id, 'execOut', c.toNode, c.toPin);
  return { function: fn, call };
}

// ---- Collapse to Macro (Unreal's node menu command) -------------------------------------------

export interface CollapseToMacroResult {
  macro: Graph;
  instance: GraphNode;
}

// Moves the selected nodes of `graph` into a new macro and uses it in their place, as Unreal's
// Collapse to Macro does. Like Collapse to Function, but execution may enter and leave the
// selection anywhere: each exec input wired from outside becomes an exec input of the macro, and
// each exec output wired to the outside an exec output.
export function collapseToMacro(
  doc: GraphDocument,
  graph: Graph,
  nodeIds: ReadonlySet<string>,
  lookup: (node: GraphNode) => NodeDefinition | undefined,
  connectionId: () => string
): CollapseToMacroResult | string {
  if (!allowedGraphKinds(doc).includes('macro')) return 'Only blueprints that hold macros can collapse nodes into one.';
  const inside = graph.nodes.filter((n) => nodeIds.has(n.id));
  if (!inside.length) return 'Select the nodes to collapse.';
  if (inside.some((n) => n.type.startsWith('core:event.') || [FUNCTION_ENTRY, FUNCTION_RETURN, MACRO_INPUTS, MACRO_OUTPUTS].includes(n.type))) {
    return "Events, entry, return, Inputs and Outputs nodes can't be collapsed into a macro.";
  }
  const localIds = new Set(allLocalVariables({ graphs: [graph] }).map((v) => v.id));
  if (inside.some((n) => localIds.has(String(n.properties.variable)))) return "The selection uses the function's local variables, which a macro can't see.";

  const isInside = (id: string) => nodeIds.has(id);
  const pinOf = (nodeId: string, pinId: string, side: 'inputs' | 'outputs') => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    return node ? lookup(node)?.[side].find((p) => p.id === pinId) : undefined;
  };
  const incoming = graph.connections.filter((c) => !isInside(c.fromNode) && isInside(c.toNode));
  const outgoing = graph.connections.filter((c) => isInside(c.fromNode) && !isInside(c.toNode));
  const internal = graph.connections.filter((c) => isInside(c.fromNode) && isInside(c.toNode));
  const isExec = (c: GraphConnection) => pinOf(c.fromNode, c.fromPin, 'outputs')?.kind === 'exec';

  const macro = addGraph(doc, 'macro');
  const signature = (macro.signature ??= { inputs: [], outputs: [] });
  const taken = new Set<string>();
  const newPin = (side: SignatureSide, name: string, fallback: string, type: GraphPin['type'] | 'exec'): GraphPin => {
    const pinName = uniqueName(name || fallback, signature[side].map((p) => p.name));
    const id = uniqueId('', pinName, taken);
    taken.add(id);
    const pin: GraphPin = type === 'exec' ? { id, name: pinName, kind: 'exec' } : { id, name: pinName, kind: 'data', ...(type ? { type } : {}) };
    signature[side].push(pin);
    return pin;
  };
  // A macro pin per inside exec input entered from outside, per outside output feeding the
  // selection, per inside exec output leaving it, and per inside output used outside.
  const inputs = new Map<string, GraphPin>();
  for (const c of incoming) {
    const exec = isExec(c);
    const key = exec ? `${c.toNode}\u0000${c.toPin}` : `${c.fromNode}\u0000${c.fromPin}`;
    if (!inputs.has(key)) inputs.set(key, newPin('inputs', pinOf(c.toNode, c.toPin, 'inputs')?.name ?? '', exec ? 'In' : 'Value', exec ? 'exec' : pinOf(c.fromNode, c.fromPin, 'outputs')?.type));
  }
  const outputs = new Map<string, GraphPin>();
  for (const c of outgoing) {
    const key = `${c.fromNode}\u0000${c.fromPin}`;
    const source = pinOf(c.fromNode, c.fromPin, 'outputs');
    if (!outputs.has(key)) outputs.set(key, newPin('outputs', source?.name ?? '', isExec(c) ? 'Out' : 'Value', isExec(c) ? 'exec' : source?.type));
  }
  const inputKey = (c: GraphConnection) => (isExec(c) ? `${c.toNode}\u0000${c.toPin}` : `${c.fromNode}\u0000${c.fromPin}`);
  const incomingPins = incoming.map((c) => ({ c, pin: inputs.get(inputKey(c))! }));
  const outgoingPins = outgoing.map((c) => ({ c, pin: outputs.get(`${c.fromNode}\u0000${c.fromPin}`)! }));

  // Move the nodes, keeping their layout, between the tunnels.
  const minX = Math.min(...inside.map((n) => n.position.x));
  const minY = Math.min(...inside.map((n) => n.position.y));
  const center = { x: inside.reduce((sum, n) => sum + n.position.x, 0) / inside.length, y: inside.reduce((sum, n) => sum + n.position.y, 0) / inside.length };
  const moved = inside.map((n) => ({ ...n, position: { x: n.position.x - minX + 350, y: n.position.y - minY } }));
  const ids = new Set(moved.map((n) => n.id));
  const [inputsTunnel, outputsTunnel] = macro.nodes;
  if (ids.has(inputsTunnel.id)) inputsTunnel.id = uniqueName('inputs', ids);
  if (ids.has(outputsTunnel.id)) outputsTunnel.id = uniqueName('outputs', [...ids, inputsTunnel.id]);
  outputsTunnel.position = { x: Math.max(...moved.map((n) => n.position.x)) + 350, y: 0 };
  macro.nodes.push(...moved);
  macro.connections.push(...internal);
  const wireIn = (fromNode: string, fromPin: string, toNode: string, toPin: string) => macro.connections.push({ id: connectionId(), fromNode, fromPin, toNode, toPin });
  const wiredIn = new Set<string>();
  for (const { c, pin } of incomingPins) {
    // One wire per inside pin: several outside wires into one exec input share it.
    const key = `${pin.id}\u0000${c.toNode}\u0000${c.toPin}`;
    if (!wiredIn.has(key)) wireIn(inputsTunnel.id, pin.id, c.toNode, c.toPin);
    wiredIn.add(key);
  }
  for (const [key, pin] of outputs) {
    const [node, out] = key.split('\u0000');
    wireIn(node, out, outputsTunnel.id, pin.id);
  }

  // In the original graph: the instance takes the nodes' place and their outside wires.
  const instance: GraphNode = { id: uniqueName(`macro_${macro.id}`, graph.nodes.map((n) => n.id)), type: MACRO_INSTANCE, position: center, properties: { graph: macro.id } };
  graph.nodes = graph.nodes.filter((n) => !isInside(n.id));
  graph.nodes.push(instance);
  graph.connections = graph.connections.filter((c) => !isInside(c.fromNode) && !isInside(c.toNode));
  const wireOut = (fromNode: string, fromPin: string, toNode: string, toPin: string) => graph.connections.push({ id: connectionId(), fromNode, fromPin, toNode, toPin });
  const wiredOut = new Set<string>();
  for (const { c, pin } of incomingPins) {
    // A data source feeding several inside pins needs one wire to the instance.
    const key = `${c.fromNode}\u0000${c.fromPin}\u0000${pin.id}`;
    if (!wiredOut.has(key)) wireOut(c.fromNode, c.fromPin, instance.id, pin.id);
    wiredOut.add(key);
  }
  for (const { c, pin } of outgoingPins) wireOut(instance.id, pin.id, c.toNode, c.toPin);
  return { macro, instance };
}

// ---- Enumerations (Unreal's enum editor) --------------------------------------------------------

export function addEnumerator(doc: GraphDocument): Enumerator {
  if (doc.kind !== 'enumeration') throw new Error('Only enumerations have values.');
  const values = (doc.enumerators ??= []);
  const name = uniqueName('NewEnumerator', values.map((e) => e.name));
  const enumerator: Enumerator = { id: uniqueId('', name, values.map((e) => e.id)), name };
  values.push(enumerator);
  return enumerator;
}

export function renameEnumerator(doc: GraphDocument, id: string, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'A value needs a name.';
  if (doc.enumerators?.some((e) => e.id !== id && e.name === trimmed)) return `There is already a value named "${trimmed}".`;
  const enumerator = doc.enumerators?.find((e) => e.id === id);
  if (enumerator) enumerator.name = trimmed;
  return undefined;
}

export function removeEnumerator(doc: GraphDocument, id: string): string | undefined {
  if ((doc.enumerators?.length ?? 0) <= 1) return 'An enumeration needs at least one value.';
  doc.enumerators = doc.enumerators?.filter((e) => e.id !== id);
  return undefined;
}

// Moves a structure's field or an enumeration's value up (-1) or down (+1).
export function moveMember(doc: GraphDocument, id: string, by: -1 | 1): void {
  const list: { id: string }[] = doc.kind === 'enumeration' ? doc.enumerators ?? [] : doc.variables;
  const from = list.findIndex((item) => item.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= list.length) return;
  [list[from], list[to]] = [list[to], list[from]];
}

// ---- New files ----------------------------------------------------------------------------------

// The kinds of .vgraph file, named as Unreal's Content Browser names the assets.
export const DOCUMENT_KIND_NAMES: Record<DocumentKind, string> = {
  class: 'Blueprint Class',
  functionLibrary: 'Blueprint Function Library',
  macroLibrary: 'Blueprint Macro Library',
  structure: 'Structure',
  enumeration: 'Enumeration'
};

// A new file of `kind`, as Unreal makes new assets: a class with its event graph, a library with one
// function or macro, a structure with one field, an enumeration with one value.
export function newDocument(name: string, language: string | undefined, kind: DocumentKind): GraphDocument {
  const doc = createEmptyDocument(name, language);
  if (kind === 'class') return doc;
  doc.kind = kind;
  doc.graphs = [];
  if (kind === 'functionLibrary') addGraph(doc, 'function');
  if (kind === 'macroLibrary') addGraph(doc, 'macro');
  if (kind === 'structure') addVariable(doc);
  if (kind === 'enumeration') addEnumerator(doc);
  return doc;
}
