// The project functions a graph calls, and what happens when their code changes
// (docs/code-as-nodes.md, "When the code changes"). A graph file stores the signature each function
// had when its nodes were made or last refreshed, as Unreal stores a node's pins with the node, so
// a changed function keeps its old pins until the user refreshes the node.
import { Graph, GraphDocument, GraphNode, NodeDefinition, PinDefinition } from './model';
import { canConnect, formatType } from './types';

export function isFunctionType(type: string): boolean {
  return type.startsWith('fn:');
}

export type FunctionStatus =
  | { state: 'current'; definition: NodeDefinition }
  | { state: 'changed'; definition: NodeDefinition; changes: string[] }
  | { state: 'missing'; candidates: NodeDefinition[] };

// How a function's code compares with the signature its nodes were made with.
export function functionStatus(
  stored: NodeDefinition | undefined,
  current: NodeDefinition | undefined,
  all: () => readonly NodeDefinition[]
): FunctionStatus {
  if (current) {
    const changes = stored ? signatureChanges(stored, current) : [];
    return changes.length ? { state: 'changed', definition: current, changes } : { state: 'current', definition: current };
  }
  return { state: 'missing', candidates: stored ? replacementCandidates(stored, all()) : [] };
}

// What changed between two signatures, in words. Titles, categories and descriptions don't count:
// only what a call depends on (pins, their order and types, and purity).
export function signatureChanges(stored: NodeDefinition, current: NodeDefinition): string[] {
  const changes: string[] = [];
  const storedPure = isPureDefinition(stored);
  const currentPure = isPureDefinition(current);
  if (storedPure !== currentPure) changes.push(currentPure ? 'it is now pure (no exec pins)' : 'it is no longer pure');

  const before = dataPins(stored.inputs);
  const after = dataPins(current.inputs);
  for (const pin of before) if (!after.some((p) => p.id === pin.id)) changes.push(`parameter "${pin.id}" was removed`);
  for (const pin of after) {
    const old = before.find((p) => p.id === pin.id);
    if (!old) changes.push(`parameter "${pin.id}" was added`);
    else if (!sameType(old, pin)) changes.push(`parameter "${pin.id}" is now ${formatType(pin.type)} (was ${formatType(old.type)})`);
  }
  const kept = before.filter((p) => after.some((q) => q.id === p.id)).map((p) => p.id);
  const keptAfter = after.filter((p) => before.some((q) => q.id === p.id)).map((p) => p.id);
  if (kept.join() !== keptAfter.join()) changes.push('its parameters were reordered');

  const oldReturn = dataPins(stored.outputs)[0];
  const newReturn = dataPins(current.outputs)[0];
  if (oldReturn && !newReturn) changes.push('it no longer returns a value');
  else if (!oldReturn && newReturn) changes.push('it now returns a value');
  else if (oldReturn && newReturn && !sameType(oldReturn, newReturn)) changes.push(`it now returns ${formatType(newReturn.type)} (was ${formatType(oldReturn.type)})`);

  const a = stored.implementation;
  const b = current.implementation;
  if (a?.kind === 'function' && b?.kind === 'function' && (a.module ?? '') !== (b.module ?? '')) changes.push(`its module is now ${b.module ?? b.path}`);
  return changes;
}

// Functions a missing one was probably renamed or moved to: the same signature, and either the
// same module under another name, or the same name in another module.
export function replacementCandidates(stored: NodeDefinition, all: readonly NodeDefinition[]): NodeDefinition[] {
  const old = stored.implementation;
  if (old?.kind !== 'function') return [];
  return all.filter((def) => {
    const impl = def.implementation;
    if (impl?.kind !== 'function' || impl.language !== old.language || def.type === stored.type) return false;
    if (impl.path !== old.path && impl.name !== old.name) return false;
    return signatureChanges(stored, def).length === 0;
  });
}

// Rebinds a function node to `replacement` (its refreshed or replacing definition). Wires stay on
// pins that still exist with a type that fits the other end; values typed on removed pins are
// dropped. Returns the ids of the wires removed.
export function rebindFunctionNode(graph: Graph, node: GraphNode, replacement: NodeDefinition, lookup: (node: GraphNode) => NodeDefinition | undefined): string[] {
  node.type = replacement.type;
  const pinsOf = (direction: PinDefinition['direction']) => (direction === 'input' ? replacement.inputs : replacement.outputs);
  const removed: string[] = [];
  graph.connections = graph.connections.filter((c) => {
    const here = c.toNode === node.id ? { pin: c.toPin, direction: 'input' as const } : c.fromNode === node.id ? { pin: c.fromPin, direction: 'output' as const } : undefined;
    if (!here) return true;
    const pin = pinsOf(here.direction).find((p) => p.id === here.pin);
    const otherNode = graph.nodes.find((n) => n.id === (here.direction === 'input' ? c.fromNode : c.toNode));
    const otherDef = otherNode && lookup(otherNode);
    const otherPin = here.direction === 'input' ? otherDef?.outputs.find((p) => p.id === c.fromPin) : otherDef?.inputs.find((p) => p.id === c.toPin);
    const fits = !!pin && !!otherPin && pin.kind === otherPin.kind
      && (pin.kind === 'exec' || (here.direction === 'input' ? canConnect(otherPin.type, pin.type) : canConnect(pin.type, otherPin.type)));
    if (!fits) removed.push(c.id);
    return fits;
  });
  for (const key of Object.keys(node.properties)) {
    if (key.startsWith('pin:') && !replacement.inputs.some((p) => p.id === key.slice(4))) delete node.properties[key];
  }
  return removed;
}

// Brings the document's stored signatures up to date: every project function its nodes call gets
// one (taken from the code when it has none), signatures no longer used are dropped, and a stored
// signature the code still matches takes the code's latest title and description. Signatures the
// code no longer matches are kept, so their nodes keep their pins. Returns whether anything changed.
export function syncImportedFunctions(doc: GraphDocument, current: (type: string) => NodeDefinition | undefined): boolean {
  const stored = doc.importedFunctions ?? {};
  const next: Record<string, NodeDefinition> = {};
  const used = [...new Set(doc.graphs.flatMap((g) => g.nodes.map((n) => n.type)).filter(isFunctionType))].sort();
  for (const type of used) {
    const before = stored[type];
    const now = current(type);
    const keep = before && (!now || signatureChanges(before, now).length) ? before : now;
    if (keep) next[type] = keep;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(doc.importedFunctions ?? {});
  if (!changed) return false;
  if (Object.keys(next).length) doc.importedFunctions = next;
  else delete doc.importedFunctions;
  return true;
}

// A function's name and module for messages, from its stored signature or else its node type
// ("fn:<language>:<path>#<name>").
export function describeFunction(type: string, stored?: NodeDefinition): { name: string; path: string } {
  if (stored?.implementation?.kind === 'function') return { name: stored.implementation.name, path: stored.implementation.path };
  const hash = type.lastIndexOf('#');
  const path = type.slice(type.indexOf(':', 3) + 1, hash);
  return { name: type.slice(hash + 1), path };
}

function dataPins(pins: PinDefinition[]): PinDefinition[] {
  return pins.filter((p) => p.kind === 'data');
}

function isPureDefinition(def: NodeDefinition): boolean {
  return ![...def.inputs, ...def.outputs].some((p) => p.kind === 'exec');
}

function sameType(a: PinDefinition, b: PinDefinition): boolean {
  return JSON.stringify(a.type ?? null) === JSON.stringify(b.type ?? null);
}
