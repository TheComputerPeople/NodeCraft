// Node definitions for a node in its document. Most nodes are fully described by their type, but
// some take their pins from context, as in Unreal: a variable Get/Set node shows the variable's
// name and type. Everything that needs a node's pins (editor, compiler, Simulate) goes through
// this, so they always agree.
import { MAKE_ARRAY, MAKE_MAP, MAKE_SET, makeDefinition, resolveWildcards } from './containers';
import { MULTIGATE, SWITCH_INT, SWITCH_STRING, flowControlDefinition } from './flow-control';
import { isFunctionType, signatureChanges } from './imported-functions';
import { GraphNode, GraphVariable, NodeDefinition, PinDefinition } from './model';

export type NodeResolver = (node: GraphNode) => NodeDefinition | undefined;

export interface ResolveContext {
  get(type: string): NodeDefinition | undefined;
}

export const VARIABLE_GET = 'core:variable.get';
export const VARIABLE_SET = 'core:variable.set';
export const SEQUENCE = 'core:flow.sequence';
export const REROUTE = 'core:reroute';

// Sequence starts with three Then outputs (Unreal's has two; ours kept three for older graphs).
export const DEFAULT_SEQUENCE_PINS = 3;

export function sequencePinCount(node: GraphNode): number {
  const pins = Number(node.properties.pins);
  return Number.isInteger(pins) && pins >= 1 ? pins : DEFAULT_SEQUENCE_PINS;
}

// The variable a Get/Set node is bound to (by id, so renaming the variable keeps the node bound).
export function boundVariable(node: GraphNode, variables: readonly GraphVariable[]): GraphVariable | undefined {
  const id = node.properties.variable;
  return typeof id === 'string' ? variables.find((v) => v.id === id) : undefined;
}

// `imported` is the document's stored function signatures: a project function whose code no
// longer matches (or is gone) keeps the pins its nodes were made with until they are refreshed.
export function createResolver(registry: ResolveContext, variables: readonly GraphVariable[], imported?: Readonly<Record<string, NodeDefinition>>): NodeResolver {
  return (node) => {
    const base = registry.get(node.type);
    if (isFunctionType(node.type)) {
      const stored = imported?.[node.type];
      return stored && (!base || signatureChanges(stored, base).length) ? stored : base;
    }
    if (!base) return undefined;
    if (node.type === VARIABLE_GET || node.type === VARIABLE_SET) return variableDefinition(base, node, variables);
    if (node.type === SEQUENCE) return { ...base, outputs: Array.from({ length: sequencePinCount(node) }, (_, i) => execPin(`then${i}`, `Then ${i}`, 'output')) };
    if (node.type === REROUTE) return rerouteDefinition(base, node);
    if (node.type === MULTIGATE || node.type === SWITCH_INT || node.type === SWITCH_STRING) return flowControlDefinition(base, node);
    // Wildcard pins take the element types the node adopted (src/core/containers.ts).
    if (node.type === MAKE_ARRAY || node.type === MAKE_SET || node.type === MAKE_MAP) return resolveWildcards(makeDefinition(base, node), node);
    return resolveWildcards(base, node);
    return base;
  };
}

function execPin(id: string, name: string, direction: PinDefinition['direction']): PinDefinition {
  return { id, name, kind: 'exec', direction };
}

function rerouteDefinition(base: NodeDefinition, node: GraphNode): NodeDefinition {
  if (node.properties.kind === 'exec') return { ...base, inputs: [execPin('in', '', 'input')], outputs: [execPin('out', '', 'output')] };
  const type = node.properties.type as PinDefinition['type'] | undefined;
  if (!type) return base;
  return { ...base, inputs: base.inputs.map((p) => ({ ...p, type })), outputs: base.outputs.map((p) => ({ ...p, type })) };
}

function variableDefinition(base: NodeDefinition, node: GraphNode, variables: readonly GraphVariable[]): NodeDefinition {
  const variable = boundVariable(node, variables);
  const name = variable?.name ?? 'Missing variable';
  const typed = (pin: PinDefinition): PinDefinition => (pin.kind === 'data' ? { ...pin, name, ...(variable ? { type: variable.type } : {}) } : pin);
  const isGet = node.type === VARIABLE_GET;
  return {
    ...base,
    displayName: isGet ? name : `Set ${name}`,
    description: variable?.description ?? base.description,
    // Unreal draws variable getters without a title bar.
    compact: isGet,
    inputs: base.inputs.map(typed),
    outputs: base.outputs.map(typed)
  };
}

// A node without exec pins: evaluated where its outputs are used (docs/semantics.md, "Data flow").
export function isPure(def: NodeDefinition): boolean {
  return ![...def.inputs, ...def.outputs].some((p) => p.kind === 'exec');
}
