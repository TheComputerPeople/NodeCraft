// Node definitions for a node in its document. Most nodes are fully described by their type, but
// some take their pins from context, as in Unreal: a variable Get/Set node shows the variable's
// name and type. Everything that needs a node's pins (editor, compiler, Simulate) goes through
// this, so they always agree.
import { GraphNode, GraphVariable, NodeDefinition, PinDefinition } from './model';

export type NodeResolver = (node: GraphNode) => NodeDefinition | undefined;

export interface ResolveContext {
  get(type: string): NodeDefinition | undefined;
}

export const VARIABLE_GET = 'core:variable.get';
export const VARIABLE_SET = 'core:variable.set';

// The variable a Get/Set node is bound to (by id, so renaming the variable keeps the node bound).
export function boundVariable(node: GraphNode, variables: readonly GraphVariable[]): GraphVariable | undefined {
  const id = node.properties.variable;
  return typeof id === 'string' ? variables.find((v) => v.id === id) : undefined;
}

export function createResolver(registry: ResolveContext, variables: readonly GraphVariable[]): NodeResolver {
  return (node) => {
    const base = registry.get(node.type);
    if (!base) return undefined;
    if (node.type === VARIABLE_GET || node.type === VARIABLE_SET) return variableDefinition(base, node, variables);
    return base;
  };
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
