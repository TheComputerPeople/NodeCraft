// Graph-editing operations shared by the webview and tests. Everything here is pure data
// manipulation: no DOM, no rendering, no persistence. Functions that change the graph mutate the
// object passed in and report whether anything changed so callers can decide to save and redraw.
import { MAKE_ARRAY, MAKE_MAP, MAKE_SET, adoptedTypes, hasWildcard, inferWildcards, makeItemCount } from './containers';
import { DEFAULT_MULTIGATE_PINS, DEFAULT_SWITCH_INT_PINS, MULTIGATE, SWITCH_INT, SWITCH_STRING, pinCount, switchStringCases } from './flow-control';
import { GraphConnection, GraphNode, NodeDefinition, PinDefinition } from './model';
import { REROUTE, SEQUENCE, sequencePinCount } from './resolve';
import { canConnect } from './types';
import { SPLIT_PROPERTY, splitPinIds } from './user-types';

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

// A node's definition in context (src/core/resolve.ts); undefined for unregistered node types.
export type DefinitionLookup = (node: GraphNode) => NodeDefinition | undefined;

// Shown for nodes whose type isn't registered (e.g. a library file was deleted) so the graph still loads.
export function fallbackDefinition(node: GraphNode): NodeDefinition {
  return { type: node.type, version: 1, displayName: node.type, category: 'Unknown', inputs: [], outputs: [], color: '#6b7280' };
}

export function definitionFor(node: GraphNode, lookup: DefinitionLookup): NodeDefinition {
  return lookup(node) ?? fallbackDefinition(node);
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
  adoptWildcards(graph, lookup, connection);
  return connection;
}

// Unreal gives a wildcard pin the type of the first wire connected to it: the node records the
// element (and map value) type, and passes it on through wires to other wildcard nodes.
export function adoptWildcards(graph: GraphContent, lookup: DefinitionLookup, first: GraphConnection): void {
  const queue = [first];
  const seen = new Set<string>();
  while (queue.length) {
    const c = queue.shift()!;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const from = pinDefinition(graph, lookup, c.fromNode, c.fromPin);
    const to = pinDefinition(graph, lookup, c.toNode, c.toPin);
    if (!from || !to || from.kind !== 'data') continue;
    for (const [nodeId, wild, concrete] of [[c.toNode, to, from], [c.fromNode, from, to]] as const) {
      if (!hasWildcard(wild.type)) continue;
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.type === REROUTE) continue;
      const learned = inferWildcards(wild.type!, concrete.type);
      const adopted = adoptedTypes(node);
      const fresh = Object.entries(learned).filter(([id]) => !adopted[id]);
      if (!fresh.length) continue;
      node.properties.wildcards = { ...adopted, ...Object.fromEntries(fresh) };
      // Its other wires may now teach wildcard nodes at their far end.
      queue.push(...graph.connections.filter((x) => x.id !== c.id && (x.fromNode === nodeId || x.toNode === nodeId)));
    }
  }
}

// Drops the adopted types of wildcard nodes with no wire left on their wildcard pins, so they can
// take another type, as in Unreal. Returns whether anything changed.
export function releaseWildcards(graph: GraphContent, lookup: DefinitionLookup): boolean {
  let changed = false;
  for (const node of graph.nodes) {
    if (!Object.keys(adoptedTypes(node)).length) continue;
    const generic = lookup({ ...node, properties: { ...node.properties, wildcards: undefined } });
    const wildPins = new Set([...(generic?.inputs ?? []), ...(generic?.outputs ?? [])].filter((p) => hasWildcard(p.type)).map((p) => p.id));
    const wired = graph.connections.some((c) => (c.fromNode === node.id && wildPins.has(c.fromPin)) || (c.toNode === node.id && wildPins.has(c.toPin)));
    if (!wired) {
      delete node.properties.wildcards;
      changed = true;
    }
  }
  return changed;
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
// `properties` presets the node, e.g. the variable a Get/Set node is bound to.
export function createNode(type: string, def: NodeDefinition | undefined, position: { x: number; y: number }, id: string, properties: Record<string, unknown> = {}): GraphNode {
  const node: GraphNode = { id, type, position: { x: position.x, y: position.y }, properties: { ...properties } };
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


// Removes item N of a Make node (Make Map's key N and value N together).
function removeMakeItem(graph: GraphContent, node: GraphNode, pinId: string): boolean {
  const index = Number(/^(?:item|key|value)(\d+)$/.exec(pinId)?.[1]);
  const count = makeItemCount(node);
  if (count <= 1 || !Number.isInteger(index) || index >= count) return false;
  const prefixes = node.type === MAKE_MAP ? ['key', 'value'] : ['item'];
  const numberOf = (pin: string) => Number(/^(?:item|key|value)(\d+)$/.exec(pin)?.[1]);
  graph.connections = graph.connections.filter((c) => !(c.toNode === node.id && numberOf(c.toPin) === index));
  for (const c of graph.connections) {
    if (c.toNode !== node.id) continue;
    const n = numberOf(c.toPin);
    if (n > index) c.toPin = c.toPin.replace(/\d+$/, String(n - 1));
  }
  for (const prefix of prefixes) {
    for (let i = index; i < count; i++) {
      const next = node.properties[`pin:${prefix}${i + 1}`];
      if (next === undefined) delete node.properties[`pin:${prefix}${i}`];
      else node.properties[`pin:${prefix}${i}`] = next;
    }
  }
  node.properties.pins = count - 1;
  return true;
}

// Splits a wire with a reroute node at `position`; the knot carries the wire's kind and type.
// Returns the new node, or undefined when the wire doesn't exist.
export function insertReroute(
  graph: GraphContent,
  lookup: DefinitionLookup,
  connectionId: string,
  position: { x: number; y: number },
  ids: { node: string; connections: [string, string] }
): GraphNode | undefined {
  const wire = graph.connections.find((c) => c.id === connectionId);
  const source = wire && pinDefinition(graph, lookup, wire.fromNode, wire.fromPin);
  if (!wire || !source) return undefined;
  const properties = source.kind === 'exec' ? { kind: 'exec' } : { kind: 'data', ...(source.type ? { type: source.type } : {}) };
  const knot: GraphNode = { id: ids.node, type: REROUTE, position: { x: position.x, y: position.y }, properties };
  graph.nodes.push(knot);
  graph.connections = graph.connections.filter((c) => c.id !== connectionId);
  graph.connections.push(
    { id: ids.connections[0], fromNode: wire.fromNode, fromPin: wire.fromPin, toNode: knot.id, toPin: 'in' },
    { id: ids.connections[1], fromNode: knot.id, fromPin: 'out', toNode: wire.toNode, toPin: wire.toPin }
  );
  return knot;
}

// Nodes whose outputs grow with Unreal's "Add pin +": the prefix of their numbered outputs.
const GROWABLE: Record<string, string> = { [SEQUENCE]: 'then', [MULTIGATE]: 'out', [SWITCH_INT]: 'case', [SWITCH_STRING]: 'case' };

export function canAddPin(node: GraphNode): boolean {
  return node.type in GROWABLE || isMakeNode(node);
}

function isMakeNode(node: GraphNode): boolean {
  return node.type === MAKE_ARRAY || node.type === MAKE_SET || node.type === MAKE_MAP;
}

function outputCount(node: GraphNode): number {
  switch (node.type) {
    case SEQUENCE:
      return sequencePinCount(node);
    case MULTIGATE:
      return pinCount(node, DEFAULT_MULTIGATE_PINS);
    case SWITCH_INT:
      return pinCount(node, DEFAULT_SWITCH_INT_PINS);
    default:
      return switchStringCases(node).length;
  }
}

// Adds a pin: the next Then, Out or case output (Switch on String gets a new case name to edit),
// or the next item input of Make Array/Set (a key and value of Make Map).
export function addPin(node: GraphNode): void {
  if (isMakeNode(node)) {
    node.properties.pins = makeItemCount(node) + 1;
  } else if (node.type === SWITCH_STRING) {
    const cases = switchStringCases(node);
    let n = cases.length;
    while (cases.includes(`Case ${n}`)) n++;
    node.properties.cases = [...cases, `Case ${n}`];
  } else if (canAddPin(node)) {
    node.properties.pins = outputCount(node) + 1;
  }
}

// Removes one numbered pin, as Unreal's "Remove execution pin" and "Remove array element pin": its
// wires go, and later pins move up one (Then 3 becomes Then 2) keeping their wires and values.
// Sequence, MultiGate, Switch on Int and the Make nodes keep at least one; Switch on String may
// have none (Default remains).
export function removePin(graph: GraphContent, node: GraphNode, pinId: string): boolean {
  if (isMakeNode(node)) return removeMakeItem(graph, node, pinId);
  const prefix = GROWABLE[node.type];
  if (!prefix) return false;
  const count = outputCount(node);
  const number = (pin: string) => Number(new RegExp(`^${prefix}(\\d+)$`).exec(pin)?.[1]);
  const index = number(pinId);
  const minimum = node.type === SWITCH_STRING ? 0 : 1;
  if (count <= minimum || !Number.isInteger(index) || index >= count) return false;
  graph.connections = graph.connections.filter((c) => !(c.fromNode === node.id && c.fromPin === pinId));
  for (const c of graph.connections) {
    const later = c.fromNode === node.id ? number(c.fromPin) : NaN;
    if (later > index) c.fromPin = `${prefix}${later - 1}`;
  }
  if (node.type === SWITCH_STRING) node.properties.cases = switchStringCases(node).filter((_, i) => i !== index);
  else node.properties.pins = count - 1;
  return true;
}

export const TO_STRING = 'core:convert.to-string';

// When a wire would join a bool or number output to a string input, Unreal inserts a conversion
// node instead of refusing. Returns the endpoints in output → input order and whether a To String
// node is needed between them; undefined when the pins can't be joined even with a conversion.
export function planConnection(graph: GraphContent, lookup: DefinitionLookup, a: PinAddress, b: PinAddress): { endpoints: Endpoints; convert: boolean } | undefined {
  const direct = resolveConnection(graph, lookup, a, b);
  if (direct) return { endpoints: direct, convert: false };
  const aDef = pinDefinition(graph, lookup, a.node, a.pin);
  const bDef = pinDefinition(graph, lookup, b.node, b.pin);
  if (!aDef || !bDef || aDef.kind !== 'data' || bDef.kind !== 'data' || aDef.direction === bDef.direction) return undefined;
  const [from, fromDef, to, toDef] = aDef.direction === 'output' ? [a, aDef, b, bDef] : [b, bDef, a, aDef];
  const convertible = !fromDef.type?.container && ['bool', 'int', 'float'].includes(fromDef.type?.id ?? '')
    && !toDef.type?.container && toDef.type?.id === 'string';
  return convertible ? { endpoints: { fromNode: from.node, fromPin: from.pin, toNode: to.node, toPin: to.pin }, convert: true } : undefined;
}

// Wires `endpoints` through a new To String node placed between the two nodes.
export function connectThroughToString(
  graph: GraphContent,
  lookup: DefinitionLookup,
  endpoints: Endpoints,
  ids: { node: string; connections: [string, string] }
): GraphNode {
  const from = graph.nodes.find((n) => n.id === endpoints.fromNode);
  const to = graph.nodes.find((n) => n.id === endpoints.toNode);
  const position = from && to ? { x: (from.position.x + to.position.x) / 2, y: (from.position.y + to.position.y) / 2 + 60 } : { x: 0, y: 0 };
  const node: GraphNode = { id: ids.node, type: TO_STRING, position, properties: {} };
  graph.nodes.push(node);
  connect(graph, lookup, { fromNode: endpoints.fromNode, fromPin: endpoints.fromPin, toNode: node.id, toPin: 'value' }, ids.connections[0]);
  connect(graph, lookup, { fromNode: node.id, fromPin: 'result', toNode: endpoints.toNode, toPin: endpoints.toPin }, ids.connections[1]);
  return node;
}

// Unreal's Split Struct Pin: the pin's wires and value go, and a pin per field takes its place.
export function splitStructPin(graph: GraphContent, node: GraphNode, pinId: string): void {
  const split = splitPinIds(node.properties);
  if (split.includes(pinId)) return;
  graph.connections = graph.connections.filter((c) => !((c.toNode === node.id && c.toPin === pinId) || (c.fromNode === node.id && c.fromPin === pinId)));
  delete node.properties[`pin:${pinId}`];
  node.properties[SPLIT_PROPERTY] = [...split, pinId];
}

// Unreal's Recombine Struct Pin, from the struct pin or any of its field pins (and theirs): the
// field pins' wires and values go, and the struct pin returns.
export function recombineStructPin(graph: GraphContent, node: GraphNode, pinId: string): void {
  const prefix = `${pinId}.`;
  const remaining = splitPinIds(node.properties).filter((id) => id !== pinId && !id.startsWith(prefix));
  if (remaining.length) node.properties[SPLIT_PROPERTY] = remaining;
  else delete node.properties[SPLIT_PROPERTY];
  graph.connections = graph.connections.filter((c) => !((c.toNode === node.id && c.toPin.startsWith(prefix)) || (c.fromNode === node.id && c.fromPin.startsWith(prefix))));
  for (const key of Object.keys(node.properties)) if (key.startsWith(`pin:${prefix}`)) delete node.properties[key];
}
