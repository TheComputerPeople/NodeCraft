// What a graph needs from its language (docs/language-breadth.md, "Capabilities, enforced"): each
// node's needs, from its kind and its pins' types, and the document's own (a parent class, a
// container variable). The compiler reports what the language can't express; the editor hides it.
import { CompileDiagnostic } from './compiler/diagnostics';
import { BIND_EVENT, CALL_DISPATCHER, UNBIND_ALL, UNBIND_EVENT } from './events';
import { LanguageCapabilities } from './language-pack';
import { Capability, Graph, GraphDocument, GraphNode, GraphPin, NodeDefinition } from './model';
import { INTERFACE_CALL, IS_VALID, OBJECT_CALL, OBJECT_DISPATCHER, OBJECT_EVENT, OBJECT_GET, OBJECT_SET, OVERRIDE_EVENT, PARENT_CALL, SELF } from './objects';
import { TypeRef } from './types';

export type { Capability } from './model';

// Every language supports everything the first packs do unless its pack says otherwise.
export const FULL_CAPABILITIES: LanguageCapabilities = {
  staticTyping: true, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true,
  containers: ['array', 'set', 'map'], delegates: true
};

// Whether a target can compile a code node: it has a snippet in one of the target's snippet
// languages, or the target's pack implements the node itself (docs/multi-language.md, gap 3).
export function implementsCode(definition: NodeDefinition, snippetLanguages: readonly string[], ownSnippets: readonly string[]): boolean {
  if (definition.implementation?.kind !== 'code') return true;
  const sources = definition.implementation.languages;
  return snippetLanguages.some((key) => sources[key] !== undefined) || ownSnippets.includes(definition.type);
}

export function supports(capabilities: LanguageCapabilities, need: Capability): boolean {
  if (need === 'array' || need === 'set' || need === 'map') return (capabilities.containers ?? FULL_CAPABILITIES.containers!).includes(need);
  return capabilities[need] ?? true;
}

// What each capability is, as diagnostics name it.
const FEATURE: Record<Capability, string> = {
  classes: 'object references',
  inheritance: 'inheritance',
  interfaces: 'interfaces',
  async: 'latent actions such as Delay',
  delegates: 'event dispatchers',
  generics: 'generic types',
  exceptions: 'exceptions',
  array: 'arrays',
  set: 'sets',
  map: 'maps'
};

const BY_TYPE: Record<string, Capability[]> = {
  'core:latent.delay': ['async'],
  'core:latent.retriggerable-delay': ['async'],
  [SELF]: ['classes'],
  [IS_VALID]: ['classes'],
  [OBJECT_GET]: ['classes'],
  [OBJECT_SET]: ['classes'],
  [OBJECT_CALL]: ['classes'],
  [OBJECT_EVENT]: ['classes'],
  [OBJECT_DISPATCHER]: ['classes', 'delegates'],
  [PARENT_CALL]: ['inheritance'],
  [OVERRIDE_EVENT]: ['inheritance'],
  [INTERFACE_CALL]: ['interfaces'],
  [CALL_DISPATCHER]: ['delegates'],
  [BIND_EVENT]: ['delegates'],
  [UNBIND_EVENT]: ['delegates'],
  [UNBIND_ALL]: ['delegates']
};

// What a type needs: its container, and object references for a class type.
export function typeRequirements(type: TypeRef | undefined): Capability[] {
  if (!type) return [];
  const needs: Capability[] = [];
  if (type.container) needs.push(type.container);
  if (type.id.startsWith('object:')) needs.push('classes');
  if (type.id.startsWith('interface:')) needs.push('interfaces');
  return [...needs, ...typeRequirements(type.valueType)];
}

// What a node needs: its own kind's, its definition's `requires`, and its pins' types'.
export function nodeRequirements(definition: NodeDefinition): Capability[] {
  const needs = [...(BY_TYPE[definition.type] ?? []), ...(definition.requires ?? [])];
  const implementation = definition.implementation;
  if (implementation?.kind === 'class') needs.push('classes', ...(implementation.operation === 'cast' ? ['inheritance' as const] : []));
  if (implementation?.kind === 'interface') needs.push('interfaces');
  for (const pin of [...definition.inputs, ...definition.outputs]) needs.push(...typeRequirements(pin.type));
  return [...new Set(needs)];
}

export function missingCapabilities(needs: Capability[], capabilities: LanguageCapabilities): Capability[] {
  return needs.filter((need) => !supports(capabilities, need));
}

// The language's unsupported features a graph uses, as compile errors on the nodes (and the
// document's settings) that use them.
export function checkCapabilities(doc: GraphDocument, resolve: (node: GraphNode) => NodeDefinition | undefined, capabilities: LanguageCapabilities, languageName: string): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const report = (needs: Capability[], what: string, at: { graphId?: string; nodeId?: string } = {}) => {
    for (const need of missingCapabilities(needs, capabilities)) {
      diagnostics.push({ severity: 'error', code: 'unsupported', message: `${languageName} has no ${FEATURE[need]}, so ${what} can't be compiled to it.`, ...at });
    }
  };
  if (doc.parent) report(['inheritance'], 'a Parent Class');
  if (doc.interfaces?.length) report(['interfaces'], 'implemented interfaces');
  if (doc.dispatchers?.length) report(['delegates'], 'event dispatchers');
  for (const variable of doc.variables) report(typeRequirements(variable.type), `the variable "${variable.name}"`);
  for (const graph of doc.graphs) {
    for (const variable of graph.localVariables ?? []) report(typeRequirements(variable.type), `the local variable "${variable.name}"`, { graphId: graph.id });
    for (const pin of signaturePins(graph)) report(typeRequirements(pin.type), `the ${graph.kind} "${graph.name}"`, { graphId: graph.id });
    for (const node of graph.nodes) {
      const definition = resolve(node);
      if (definition) report(nodeRequirements(definition), `"${definition.displayName}"`, { graphId: graph.id, nodeId: node.id });
    }
  }
  // One diagnostic per place and feature.
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = JSON.stringify([d.graphId, d.nodeId, d.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function signaturePins(graph: Graph): GraphPin[] {
  return [...(graph.signature?.inputs ?? []), ...(graph.signature?.outputs ?? [])];
}
