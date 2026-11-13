// Node definitions for a node in its document. Most nodes are fully described by their type, but
// some take their pins from context, as in Unreal: a variable Get/Set node shows the variable's
// name and type. Everything that needs a node's pins (editor, compiler, Simulate) goes through
// this, so they always agree.
import { MAKE_ARRAY, MAKE_MAP, MAKE_SET, addedPinCount, makeDefinition, resolveWildcards } from './containers';
import { MULTIGATE, SWITCH_INT, SWITCH_STRING, flowControlDefinition } from './flow-control';
import { isFunctionType, signatureChanges } from './imported-functions';
import { FUNCTION_CALL, FUNCTION_ENTRY, FUNCTION_RETURN, allLocalVariables, functionNodeDefinition } from './functions';
import { MACRO_INPUTS, MACRO_INSTANCE, MACRO_OUTPUTS, macroNodeDefinition } from './macros';
import { Dispatcher, eventNodeDefinition, isDispatcherNode, isEventNode } from './events';
import { TEST_CASE, testCaseDefinition } from './tests';
import { constructWithParentInputs, declaredClass, isObjectNode, objectNodeDefinition } from './objects';
import { Graph, GraphDocument, GraphNode, GraphVariable, NodeDefinition, PinDefinition } from './model';
import { applySplits, setMembersDefinition, splitPinIds } from './user-types';
import { isTypeRef } from './types';

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
  return addedPinCount(node, 1, DEFAULT_SEQUENCE_PINS);
}

// The variable a Get/Set node is bound to (by id, so renaming the variable keeps the node bound).
export function boundVariable(node: GraphNode, variables: readonly GraphVariable[]): GraphVariable | undefined {
  const id = node.properties.variable;
  return typeof id === 'string' ? variables.find((v) => v.id === id) : undefined;
}

// What the resolver needs from the document: its variables (and each function's locals), its
// graphs (for function signatures), and its stored project-function signatures.
export interface ResolverDocument {
  variables: readonly GraphVariable[];
  graphs?: readonly Graph[];
  importedFunctions?: Readonly<Record<string, NodeDefinition>>;
  dispatchers?: readonly Dispatcher[];
  // A class document's name and kind: Self and member nodes may use its own members.
  name?: string;
  kind?: GraphDocument['kind'];
  language?: string;
}

// `doc.importedFunctions` is the document's stored function signatures: a project function whose
// code no longer matches (or is gone) keeps the pins its nodes were made with until refreshed.
export function createResolver(registry: ResolveContext, doc: ResolverDocument): NodeResolver {
  const resolve = createUnsplitResolver(registry, doc);
  // Split struct pins show a pin per field (src/core/user-types.ts).
  return (node) => {
    const def = resolve(node);
    const split = splitPinIds(node.properties);
    return def && split.length ? applySplits(def, split, (type) => registry.get(type)) : def;
  };
}

// The resolver without split struct pins: what a node's pins are before splitting.
export function createUnsplitResolver(registry: ResolveContext, doc: ResolverDocument): NodeResolver {
  const variables = [...doc.variables, ...allLocalVariables(doc)];
  let own: ReturnType<typeof declaredClass> | null = null;
  const ownClass = () => (own ??= doc.kind === 'class' && doc.name ? declaredClass(doc as GraphDocument) : undefined);
  return (node) => {
    const base = registry.get(node.type);
    if (isFunctionType(node.type)) {
      const stored = doc.importedFunctions?.[node.type];
      const def = stored && (!base || signatureChanges(stored, base).length) ? stored : base;
      // A generic function's wildcard pins take the types the node adopted (gap 10).
      return def && resolveWildcards(def, node);
    }
    if (!base) return undefined;
    if (node.type === VARIABLE_GET || node.type === VARIABLE_SET) return variableDefinition(base, node, variables);
    if (node.type === FUNCTION_ENTRY || node.type === FUNCTION_RETURN || node.type === FUNCTION_CALL) return functionNodeDefinition(base, node, doc.graphs);
    if (node.type === MACRO_INPUTS || node.type === MACRO_OUTPUTS || node.type === MACRO_INSTANCE) return macroNodeDefinition(base, node, doc.graphs);
    if (isEventNode(node.type) || isDispatcherNode(node.type)) return eventNodeDefinition(base, node, doc);
    if (node.type === TEST_CASE) return testCaseDefinition(base, node);
    if (isObjectNode(node.type)) return objectNodeDefinition(base, node, ownClass(), (type) => registry.get(type));
    if (node.type === SEQUENCE) return { ...base, outputs: Array.from({ length: sequencePinCount(node) }, (_, i) => execPin(`then${i}`, `Then ${i}`, 'output')) };
    if (node.type === REROUTE) return rerouteDefinition(base, node);
    if (base.implementation?.kind === 'struct' && base.implementation.operation === 'set-members') return setMembersDefinition(base, node.properties.members);
    // Construct <Class> takes the parent constructor's arguments when the class extends code that needs them.
    if (base.implementation?.kind === 'class' && base.implementation.operation === 'construct') return constructWithParentInputs(base, (type) => registry.get(type));
    if (node.type === MULTIGATE || node.type === SWITCH_INT || node.type === SWITCH_STRING) return flowControlDefinition(base, node);
    // Wildcard pins take the element types the node adopted (src/core/containers.ts).
    if (node.type === MAKE_ARRAY || node.type === MAKE_SET || node.type === MAKE_MAP) return resolveWildcards(makeDefinition(base, node), node);
    return resolveWildcards(base, node);
  };
}

function execPin(id: string, name: string, direction: PinDefinition['direction']): PinDefinition {
  return { id, name, kind: 'exec', direction };
}

function rerouteDefinition(base: NodeDefinition, node: GraphNode): NodeDefinition {
  if (node.properties.kind === 'exec') return { ...base, inputs: [execPin('in', '', 'input')], outputs: [execPin('out', '', 'output')] };
  const type = node.properties.type;
  if (!isTypeRef(type)) return base;
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
