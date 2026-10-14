// Function graphs (docs/program-structure.md, "Functions"): a Function Entry node, Return Nodes, and
// call nodes elsewhere. Their pins come from the function's signature, so editing the signature
// updates every node that uses it, as in Unreal.
import { Graph, GraphNode, GraphPin, NodeDefinition, PinDefinition } from './model';

export const FUNCTION_ENTRY = 'core:function.entry';
export const FUNCTION_RETURN = 'core:function.return';
export const FUNCTION_CALL = 'core:function.call';

const COLOR = '#7c3aed';

export function functionDefinitions(): NodeDefinition[] {
  return [
    {
      type: FUNCTION_ENTRY, version: 1, displayName: 'Function Entry', category: 'Functions', color: COLOR,
      description: 'Where the function starts. Its outputs are the function\'s inputs.',
      inputs: [], outputs: [{ id: 'execOut', name: '', kind: 'exec', direction: 'output' }], implementation: { kind: 'native', operation: 'function-entry' }
    },
    {
      type: FUNCTION_RETURN, version: 1, displayName: 'Return Node', category: 'Functions', color: COLOR,
      description: 'Ends the function, returning its outputs.', keywords: ['return', 'output', 'result'],
      inputs: [{ id: 'execIn', name: '', kind: 'exec', direction: 'input' }], outputs: [], implementation: { kind: 'native', operation: 'function-return' }
    },
    {
      type: FUNCTION_CALL, version: 1, displayName: 'Call Function', category: 'Functions', color: COLOR,
      description: 'Calls a function of this blueprint.',
      inputs: [], outputs: [], implementation: { kind: 'native', operation: 'call-function' }
    }
  ];
}

// The function graph a node refers to: a call's target, or the graph an entry or return node is in.
export function functionGraph(node: GraphNode, graphs: readonly Graph[] | undefined): Graph | undefined {
  const id = node.properties.graph;
  return typeof id === 'string' ? graphs?.find((g) => g.id === id && g.kind === 'function') : undefined;
}

const data = (pin: GraphPin, direction: PinDefinition['direction']): PinDefinition => ({
  id: pin.id, name: pin.name, kind: 'data', direction, ...(pin.type ? { type: pin.type } : {}), ...(pin.defaultValue !== undefined ? { defaultValue: pin.defaultValue } : {})
});

// Entry, Return and call nodes with the pins of their function's signature.
export function functionNodeDefinition(base: NodeDefinition, node: GraphNode, graphs: readonly Graph[] | undefined): NodeDefinition {
  const graph = functionGraph(node, graphs);
  const signature = graph?.signature ?? { inputs: [], outputs: [] };
  const inputs = signature.inputs.filter((p) => p.kind === 'data');
  const outputs = signature.outputs.filter((p) => p.kind === 'data');
  if (node.type === FUNCTION_ENTRY) {
    return { ...base, displayName: graph?.name ?? base.displayName, outputs: [...base.outputs, ...inputs.map((p) => data(p, 'output'))] };
  }
  if (node.type === FUNCTION_RETURN) return { ...base, inputs: [...base.inputs, ...outputs.map((p) => data(p, 'input'))] };
  // A call: exec pins unless the function is pure, as in Unreal.
  const exec: PinDefinition[] = signature.pure ? [] : [{ id: 'execIn', name: '', kind: 'exec', direction: 'input' }];
  return {
    ...base,
    displayName: graph?.name ?? 'Missing function',
    category: graph?.signature?.category || 'Functions',
    ...(graph?.signature?.description ? { description: graph.signature.description } : {}),
    inputs: [...exec, ...inputs.map((p) => data(p, 'input'))],
    outputs: [...(signature.pure ? [] : [{ id: 'execOut', name: '', kind: 'exec' as const, direction: 'output' as const }]), ...outputs.map((p) => data(p, 'output'))]
  };
}

export function isFunctionNode(type: string): boolean {
  return type === FUNCTION_ENTRY || type === FUNCTION_RETURN || type === FUNCTION_CALL;
}

// The local variables of every function, which Get and Set nodes can be bound to like members.
export function allLocalVariables(doc: { graphs?: readonly Graph[] } | undefined): NonNullable<Graph['localVariables']> {
  return doc?.graphs?.flatMap((g) => g.localVariables ?? []) ?? [];
}
