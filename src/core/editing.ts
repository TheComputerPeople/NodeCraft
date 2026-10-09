// Graph-editing operations shared by the webview and tests. Everything here is pure data
// manipulation: no DOM, no rendering, no persistence. Functions that change the graph mutate the
// object passed in and report whether anything changed so callers can decide to save and redraw.
import { GraphConnection, GraphNode, NodeDefinition, PinDefinition } from './model';
import { canConnect } from './types';

export interface GraphContent {
  nodes: GraphNode[];
  connections: GraphConnection[];
}

export interface PinAddress {
  node: string;
  pin: string;
}

export interface Endpoints {
  fromNode: string;
  fromPin: string;
  toNode: string;
  toPin: string;
}

export type DefinitionLookup = (type: string) => NodeDefinition | undefined;

// Shown for nodes whose type isn't registered (e.g. a library file was deleted) so the graph still loads.
export function fallbackDefinition(node: GraphNode): NodeDefinition {
  return { type: node.type, version: 1, displayName: node.type, category: 'Unknown', inputs: [], outputs: [], color: '#6b7280' };
}

export function definitionFor(node: GraphNode, lookup: DefinitionLookup): NodeDefinition {
  return lookup(node.type) ?? fallbackDefinition(node);
}

export function pinDefinition(graph: GraphContent, lookup: DefinitionLookup, nodeId: string, pinId: string): PinDefinition | undefined {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  const def = definitionFor(node, lookup);
  return [...def.inputs, ...def.outputs].find((p) => p.id === pinId);
}

function pinsCompatible(from: PinDefinition, to: PinDefinition): boolean {
  if (from.direction !== 'output' || to.direction !== 'input' || from.kind !== to.kind) return false;
  return from.kind === 'exec' || canConnect(from.type, to.type);
}

// Orders two pins into output → input and checks they can be wired. A drag may start on either
// end, so `a` can be the input.
export function resolveConnection(graph: GraphContent, lookup: DefinitionLookup, a: PinAddress, b: PinAddress): Endpoints | undefined {
  if (a.node === b.node && a.pin === b.pin) return undefined;
  const aDef = pinDefinition(graph, lookup, a.node, a.pin);
  const bDef = pinDefinition(graph, lookup, b.node, b.pin);
  if (!aDef || !bDef) return undefined;
  const [from, fromDef, to, toDef] = aDef.direction === 'input' && bDef.direction === 'output'
    ? [b, bDef, a, aDef] : [a, aDef, b, bDef];
  if (!pinsCompatible(fromDef, toDef)) return undefined;
  return { fromNode: from.node, fromPin: from.pin, toNode: to.node, toPin: to.pin };
}

// Unreal's wiring rules: an exec output drives one exec input (which may have many drivers), and a
// data input reads from one output (which may feed many inputs). True for connections a new wire
// with `endpoints` would replace.
function replacedBy(graph: GraphContent, lookup: DefinitionLookup, endpoints: Endpoints): (c: GraphConnection) => boolean {
  const execOutput = pinDefinition(graph, lookup, endpoints.fromNode, endpoints.fromPin)?.kind === 'exec';
  const dataInput = pinDefinition(graph, lookup, endpoints.toNode, endpoints.toPin)?.kind !== 'exec';
  return (c) => (execOutput && c.fromNode === endpoints.fromNode && c.fromPin === endpoints.fromPin)
    || (dataInput && c.toNode === endpoints.toNode && c.toPin === endpoints.toPin);
}

// Adds a connection, replacing the ones Unreal's wiring rules say it supersedes.
export function connect(graph: GraphContent, lookup: DefinitionLookup, endpoints: Endpoints, connectionId: string): GraphConnection {
  const replaced = replacedBy(graph, lookup, endpoints);
  graph.connections = graph.connections.filter((c) => !replaced(c));
  const connection = { id: connectionId, ...endpoints };
  graph.connections.push(connection);
  return connection;
}

// Moves one end of an existing connection to another pin. Returns false (leaving the graph
// untouched) when the result would be invalid.
export function rewire(graph: GraphContent, lookup: DefinitionLookup, connectionId: string, side: 'from' | 'to', target: PinAddress): boolean {
  const connection = graph.connections.find((c) => c.id === connectionId);
  if (!connection) return false;
  const endpoints: Endpoints = side === 'from'
    ? { ...pick(connection), fromNode: target.node, fromPin: target.pin }
    : { ...pick(connection), toNode: target.node, toPin: target.pin };
  if (endpoints.fromNode === endpoints.toNode && endpoints.fromPin === endpoints.toPin) return false;
  const from = pinDefinition(graph, lookup, endpoints.fromNode, endpoints.fromPin);
  const to = pinDefinition(graph, lookup, endpoints.toNode, endpoints.toPin);
  if (!from || !to || !pinsCompatible(from, to)) return false;

  const replaced = replacedBy(graph, lookup, endpoints);
  graph.connections = graph.connections.filter((c) => c.id === connection.id || !replaced(c));
  Object.assign(connection, endpoints);
  return true;
}

function pick(c: GraphConnection): Endpoints {
  return { fromNode: c.fromNode, fromPin: c.fromPin, toNode: c.toNode, toPin: c.toPin };
}

export function disconnectPin(graph: GraphContent, address: PinAddress): number {
  return removeConnections(graph, (c) =>
    (c.fromNode === address.node && c.fromPin === address.pin) || (c.toNode === address.node && c.toPin === address.pin));
}

export function disconnectConnection(graph: GraphContent, connectionId: string): number {
  return removeConnections(graph, (c) => c.id === connectionId);
}

export function disconnectNodes(graph: GraphContent, nodeIds: ReadonlySet<string>): number {
  return removeConnections(graph, (c) => nodeIds.has(c.fromNode) || nodeIds.has(c.toNode));
}

function removeConnections(graph: GraphContent, shouldRemove: (c: GraphConnection) => boolean): number {
  const before = graph.connections.length;
  graph.connections = graph.connections.filter((c) => !shouldRemove(c));
  return before - graph.connections.length;
}

// Creates a node with its data-input defaults filled in. `def` is undefined for unregistered types.
export function createNode(type: string, def: NodeDefinition | undefined, position: { x: number; y: number }, id: string): GraphNode {
  const node: GraphNode = { id, type, position: { x: position.x, y: position.y }, properties: {} };
  for (const pin of def?.inputs ?? []) {
    if (pin.kind === 'data' && pin.defaultValue !== undefined) node.properties[`pin:${pin.id}`] = pin.defaultValue;
  }
  return node;
}

export function deleteNodes(graph: GraphContent, nodeIds: ReadonlySet<string>): void {
  graph.nodes = graph.nodes.filter((n) => !nodeIds.has(n.id));
  disconnectNodes(graph, nodeIds);
}

// Copies the given nodes, offset by `offset`, along with the connections that run between them.
export function duplicateNodes(
  graph: GraphContent,
  nodeIds: ReadonlySet<string>,
  offset: { x: number; y: number },
  newNodeId: (node: GraphNode) => string,
  newConnectionId: () => string
): GraphNode[] {
  const remap = new Map<string, string>();
  const copies = graph.nodes.filter((n) => nodeIds.has(n.id)).map((node) => {
    const id = newNodeId(node);
    remap.set(node.id, id);
    const copy = JSON.parse(JSON.stringify(node)) as GraphNode;
    return { ...copy, id, position: { x: node.position.x + offset.x, y: node.position.y + offset.y } };
  });
  const internal = graph.connections
    .filter((c) => remap.has(c.fromNode) && remap.has(c.toNode))
    .map((c) => ({ id: newConnectionId(), fromNode: remap.get(c.fromNode)!, fromPin: c.fromPin, toNode: remap.get(c.toNode)!, toPin: c.toPin }));
  graph.nodes.push(...copies);
  graph.connections.push(...internal);
  return copies;
}

// Every node reachable from `startId` through connections in either direction, including itself.
export function connectedNodeIds(graph: GraphContent, startId: string): Set<string> {
  const found = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const c of graph.connections) {
      const next = c.fromNode === current ? c.toNode : c.toNode === current ? c.fromNode : undefined;
      if (next && !found.has(next)) {
        found.add(next);
        queue.push(next);
      }
    }
  }
  return found;
}

// The pin on `def` that a wire dragged from `source` would attach to, if any.
export function matchingPin(def: NodeDefinition, source: PinDefinition): PinDefinition | undefined {
  const candidates = source.direction === 'output' ? def.inputs : def.outputs;
  return candidates.find((p) => p.kind === source.kind && (source.kind === 'exec'
    || (source.direction === 'output' ? canConnect(source.type, p.type) : canConnect(p.type, source.type))));
}

// Definitions that could accept a wire dragged from `source` (used to filter the action menu).
export function compatibleDefinitions(definitions: NodeDefinition[], source: PinDefinition): NodeDefinition[] {
  return definitions.filter((def) => matchingPin(def, source) !== undefined);
}

export function nodeIdFor(type: string, random: () => number = Math.random): string {
  const slug = type.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${slug}_${random().toString(36).slice(2, 8)}`;
}

