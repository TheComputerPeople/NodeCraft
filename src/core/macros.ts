// Macro graphs (docs/program-structure.md, "Macros"): an Inputs tunnel and an Outputs tunnel with
// any number of exec and data pins, used through instance nodes elsewhere. A macro is expanded where
// it is used, as in Unreal: before compiling and before Simulate, each instance node is replaced by
// a copy of the macro's nodes, so every use has its own state (Do Once…).
import { Graph, GraphConnection, GraphDocument, GraphNode, GraphPin, NodeDefinition, PinDefinition } from './model';
import { signatureMetadata } from './metadata';
import { storedDefault } from './values';

export const MACRO_INPUTS = 'core:macro.inputs';
export const MACRO_OUTPUTS = 'core:macro.outputs';
export const MACRO_INSTANCE = 'core:macro.instance';

// Joins an instance's id and an inner node's id in expanded graphs: "instance/inner".
export const MACRO_SEPARATOR = '/';

const COLOR = '#6b7280';

export function macroDefinitions(): NodeDefinition[] {
  return [
    {
      type: MACRO_INPUTS, version: 1, displayName: 'Inputs', category: 'Macros', color: COLOR,
      description: 'Where the macro starts. Its outputs are the macro\'s inputs.',
      inputs: [], outputs: [], implementation: { kind: 'native', operation: 'macro-inputs' }
    },
    {
      type: MACRO_OUTPUTS, version: 1, displayName: 'Outputs', category: 'Macros', color: COLOR,
      description: 'Where the macro ends. Its inputs are the macro\'s outputs.',
      inputs: [], outputs: [], implementation: { kind: 'native', operation: 'macro-outputs' }
    },
    {
      type: MACRO_INSTANCE, version: 1, displayName: 'Macro', category: 'Macros', color: COLOR,
      description: 'Uses a macro of this blueprint.',
      inputs: [], outputs: [], implementation: { kind: 'native', operation: 'macro-instance' }
    }
  ];
}

export function isMacroNode(type: string): boolean {
  return type === MACRO_INPUTS || type === MACRO_OUTPUTS || type === MACRO_INSTANCE;
}

// The macro graph a node refers to: an instance's macro, or the macro a tunnel is in.
export function macroGraph(node: GraphNode, graphs: readonly Graph[] | undefined): Graph | undefined {
  const id = node.properties.graph;
  return typeof id === 'string' ? graphs?.find((g) => g.id === id && g.kind === 'macro') : undefined;
}

export function signaturePin(pin: GraphPin, direction: PinDefinition['direction']): PinDefinition {
  return {
    id: pin.id, name: pin.name, kind: pin.kind, direction,
    ...(pin.kind === 'data' && pin.type ? { type: pin.type } : {}),
    ...(pin.kind === 'data' && pin.defaultValue !== undefined ? { defaultValue: pin.defaultValue } : {}),
    ...(pin.kind === 'data' && pin.advanced && direction === 'input' ? { advanced: true } : {})
  };
}

// Tunnels and instances with the pins of their macro's signature.
export function macroNodeDefinition(base: NodeDefinition, node: GraphNode, graphs: readonly Graph[] | undefined): NodeDefinition {
  const graph = macroGraph(node, graphs);
  const signature = graph?.signature ?? { inputs: [], outputs: [] };
  if (node.type === MACRO_INPUTS) return { ...base, outputs: signature.inputs.map((p) => signaturePin(p, 'output')) };
  if (node.type === MACRO_OUTPUTS) return { ...base, inputs: signature.outputs.map((p) => signaturePin(p, 'input')) };
  return macroInstanceDefinition(base, graph);
}

export function macroInstanceDefinition(base: NodeDefinition, graph: Graph | undefined): NodeDefinition {
  const signature = graph?.signature ?? { inputs: [], outputs: [] };
  return {
    ...base,
    displayName: graph?.name ?? 'Missing macro',
    category: signature.category || 'Macros',
    ...(signature.description ? { description: signature.description } : {}),
    ...signatureMetadata(signature),
    inputs: signature.inputs.map((p) => signaturePin(p, 'input')),
    outputs: signature.outputs.map((p) => signaturePin(p, 'output'))
  };
}

// The node a node of an expanded graph came from in the graph the user sees: an inner node of a
// macro reports as its instance.
export function visibleNodeId(id: string): string {
  const at = id.indexOf(MACRO_SEPARATOR);
  return at < 0 ? id : id.slice(0, at);
}

export function isExpandedNode(id: string): boolean {
  return id.includes(MACRO_SEPARATOR);
}

// A node copied from inside a macro (not one standing in for a split struct pin of the node itself,
// "node/split:pin"; src/core/user-types.ts).
export function isMacroInnerNode(id: string): boolean {
  const at = id.indexOf(MACRO_SEPARATOR);
  return at >= 0 && !id.startsWith('split:', at + 1);
}

// The macro an instance node uses: its graph and a key that identifies it (to catch a macro using
// itself), or why it can't be used. Undefined for nodes that aren't macro instances.
export type MacroLookup = (node: GraphNode) => { graph: Graph; key: string } | string | undefined;

// Finds macros of `graphs` (instance nodes) and of macro libraries (registry definitions whose
// implementation embeds the macro graph).
export function macroLookup(graphs: readonly Graph[], definition: (type: string) => NodeDefinition | undefined): MacroLookup {
  return (node) => {
    if (node.type === MACRO_INSTANCE) {
      const graph = macroGraph(node, graphs);
      return graph ? { graph, key: `#${graph.id}` } : 'This macro no longer exists.';
    }
    if (!node.type.startsWith('macro:')) return undefined;
    const implementation = definition(node.type)?.implementation;
    if (implementation?.kind !== 'macro') return `The macro library for "${node.type.slice('macro:'.length)}" is missing.`;
    return implementation.error ?? { graph: implementation.graph, key: node.type };
  };
}

export interface MacroProblem {
  // The instance node in the expanded graph (an id of the graph the user sees).
  nodeId: string;
  message: string;
}

export interface Expansion {
  graph: Graph;
  problems: MacroProblem[];
  // The name of the macro each expanded instance (by node id) uses.
  macros: Map<string, string>;
}

// Replaces each macro instance in `graph` with a copy of the macro's nodes (expanding macros used
// inside it first). Inner node ids get the instance's id in front ("instance/inner"). Wires to and
// from the instance are joined to the wires inside at the tunnels; an input with no wire passes on
// its literal value. Instances that can't be expanded stay, with a problem.
export function expandMacros(graph: Graph, lookup: MacroLookup, stack: readonly string[] = []): Expansion {
  const problems: MacroProblem[] = [];
  const macros = new Map<string, string>();
  if (!graph.nodes.some((n) => lookup(n) !== undefined)) return { graph, problems, macros };

  const nodes = new Map<string, GraphNode>();
  const connections: GraphConnection[] = [...graph.connections];
  // Each tunnel pin pair is a junction: wires come in at its entry pin and leave from its exit pin.
  // Entries: an instance's input pin, an Outputs tunnel's input pin. Exits: an Inputs tunnel's
  // output pin, an instance's output pin.
  const entries = new Map<string, { kind: GraphPin['kind']; literal: unknown }>();
  const exits = new Map<string, string>();

  for (const node of graph.nodes) {
    const macro = lookup(node);
    if (macro === undefined) {
      nodes.set(node.id, node);
      continue;
    }
    const fail = (message: string): void => {
      problems.push({ nodeId: node.id, message });
      nodes.set(node.id, node);
    };
    if (typeof macro === 'string') {
      fail(macro);
      continue;
    }
    if (stack.includes(macro.key)) {
      fail(`Macro "${macro.graph.name}" uses itself.`);
      continue;
    }
    const inputsTunnels = macro.graph.nodes.filter((n) => n.type === MACRO_INPUTS);
    const outputsTunnels = macro.graph.nodes.filter((n) => n.type === MACRO_OUTPUTS);
    if (inputsTunnels.length !== 1 || outputsTunnels.length !== 1) {
      fail(`Macro "${macro.graph.name}" needs exactly one Inputs node and one Outputs node.`);
      continue;
    }
    const misplaced = macro.graph.nodes.find((n) => n.type.startsWith('core:event.') || n.type.startsWith('core:function.'));
    if (misplaced) {
      fail(`Macro "${macro.graph.name}" can't hold events, Function Entry or Return nodes.`);
      continue;
    }
    const inner = expandMacros(macro.graph, lookup, [...stack, macro.key]);
    for (const p of inner.problems) problems.push({ nodeId: node.id, message: `In macro "${macro.graph.name}": ${p.message}` });

    macros.set(node.id, macro.graph.name);
    const prefix = `${node.id}${MACRO_SEPARATOR}`;
    const inputsId = prefix + inputsTunnels[0].id;
    const outputsId = prefix + outputsTunnels[0].id;
    const signature = macro.graph.signature ?? { inputs: [], outputs: [] };
    for (const pin of signature.inputs) {
      const entry = pinKey(node.id, pin.id);
      entries.set(entry, { kind: pin.kind, literal: literal(node, pin) });
      exits.set(pinKey(inputsId, pin.id), entry);
    }
    for (const pin of signature.outputs) {
      const entry = pinKey(outputsId, pin.id);
      entries.set(entry, { kind: pin.kind, literal: literal(outputsTunnels[0], pin) });
      exits.set(pinKey(node.id, pin.id), entry);
    }
    for (const n of inner.graph.nodes) {
      if (n.type !== MACRO_INPUTS && n.type !== MACRO_OUTPUTS) nodes.set(prefix + n.id, { ...n, id: prefix + n.id });
    }
    for (const c of inner.graph.connections) connections.push({ ...c, id: prefix + c.id, fromNode: prefix + c.fromNode, toNode: prefix + c.toNode });
  }

  const into = new Map<string, GraphConnection[]>();
  for (const c of connections) {
    const key = pinKey(c.toNode, c.toPin);
    into.set(key, [...(into.get(key) ?? []), c]);
  }
  type Source = { node: string; pin: string } | { literal: unknown };
  // Where a value or exec wire really starts: through any number of junctions.
  const sources = (nodeId: string, pinId: string, seen: Set<string>): Source[] => {
    const key = pinKey(nodeId, pinId);
    const entry = exits.get(key);
    if (entry === undefined) return [{ node: nodeId, pin: pinId }];
    if (seen.has(entry)) return [];
    seen.add(entry);
    const wires = into.get(entry) ?? [];
    if (!wires.length) {
      const junction = entries.get(entry)!;
      return junction.kind === 'data' ? [{ literal: junction.literal }] : [];
    }
    return wires.flatMap((w) => sources(w.fromNode, w.fromPin, seen));
  };

  const result: GraphConnection[] = [];
  for (const c of connections) {
    if (!nodes.has(c.toNode) || entries.has(pinKey(c.toNode, c.toPin))) continue;
    if (!exits.has(pinKey(c.fromNode, c.fromPin))) {
      result.push(c);
      continue;
    }
    sources(c.fromNode, c.fromPin, new Set()).forEach((source, i) => {
      if ('node' in source) {
        result.push({ ...c, id: `${c.id}${MACRO_SEPARATOR}${i}`, fromNode: source.node, fromPin: source.pin });
        return;
      }
      // An input with no wire: its value goes on the node that reads it, as if typed there.
      const target = nodes.get(c.toNode)!;
      nodes.set(c.toNode, { ...target, properties: { ...target.properties, [`pin:${c.toPin}`]: source.literal } });
    });
  }
  return { graph: { ...graph, nodes: [...nodes.values()], connections: result }, problems, macros };
}

// The document with macros expanded in its event and function graphs, for Simulate, and why the
// instances that couldn't be expanded can't be (keyed by graph id and node id, as macroProblemKey).
export function expandDocument(doc: GraphDocument, definition: (type: string) => NodeDefinition | undefined): { doc: GraphDocument; problems: Map<string, string> } {
  const lookup = macroLookup(doc.graphs, definition);
  const problems = new Map<string, string>();
  const graphs = doc.graphs.map((graph) => {
    if (graph.kind === 'macro') return graph;
    const expansion = expandMacros(graph, lookup);
    for (const p of expansion.problems) if (!problems.has(macroProblemKey(graph.id, p.nodeId))) problems.set(macroProblemKey(graph.id, p.nodeId), p.message);
    return expansion.graph;
  });
  return { doc: { ...doc, graphs }, problems };
}

export function macroProblemKey(graphId: string, nodeId: string): string {
  return JSON.stringify([graphId, nodeId]);
}

// The value an unwired tunnel pin passes on: typed on the node, else the pin's default, else its
// type's default.
function literal(node: GraphNode, pin: GraphPin): unknown {
  if (pin.kind !== 'data') return undefined;
  return node.properties[`pin:${pin.id}`] ?? pin.defaultValue ?? storedDefault(pin.type);
}

function pinKey(nodeId: string, pinId: string): string {
  return `${nodeId}\u0000${pinId}`;
}
