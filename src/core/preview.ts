// The code preview (docs/language-context.md, part 3): what a node the palette offers becomes in the
// graph's language. A code node shows its snippet for the language. Any other node is compiled in a
// small graph (in the open document when it refers to it: a variable, an event, a member) and shows
// its own lines of the generated code, found through the generator's node lines.
import { compileDocument } from './compiler';
import { dedent } from './compiler/names';
import { LanguagePackRegistry } from './language-pack';
import { Graph, GraphConnection, GraphDocument, GraphNode, NodeDefinition, PinDefinition } from './model';
import { NodeRegistry } from './registry';
import { createResolver } from './resolve';
import { TypeRef } from './types';

export interface PreviewEntry {
  type: string;
  properties?: Record<string, unknown>;
}

export interface NodePreview {
  code: string;
  // A code node's snippet, or the node's lines of generated code.
  kind: 'snippet' | 'generated';
}

export interface PreviewOptions {
  language: string;
  languages: LanguagePackRegistry;
  registry: NodeRegistry;
  // The open document, for nodes that refer to it.
  document?: GraphDocument;
}

const EVENT = 'vgPreviewEvent';
const FUNCTION = 'VgPreviewFunction';

// Wildcard pins are shown with these types: ints, and strings for a map's values.
const ELEMENT = 'int';
const VALUE = 'string';

export function previewNode(entry: PreviewEntry, options: PreviewOptions): NodePreview | undefined {
  const generator = options.languages.get(options.language)?.generator;
  const base = options.registry.get(entry.type);
  if (!generator || !base) return undefined;
  const implementation = base.implementation;
  if (implementation?.kind === 'code') {
    const key = generator.snippetLanguages.find((k) => implementation.languages[k] !== undefined);
    const snippet = key ? implementation.languages[key] : generator.snippets?.[entry.type];
    // Inputs are named after their pins in the generated helper.
    return snippet === undefined ? undefined : { code: dedent(snippet).join('\n').replace(/\$\{([^}]+)\}/g, '$1'), kind: 'snippet' };
  }
  const standalone: GraphDocument = { schemaVersion: 3, name: 'Preview', kind: 'class', language: options.language, variables: [], graphs: [] };
  for (const context of [standalone, ...(options.document ? [{ ...options.document, language: options.language }] : [])]) {
    const code = generated(entry, context, options);
    if (code !== undefined) return { code, kind: 'generated' };
  }
  return undefined;
}

function concrete(type: TypeRef | undefined): TypeRef | undefined {
  if (!type) return undefined;
  const id = type.id === 'wildcard' || type.id === 'any' ? ELEMENT : type.id === 'wildcard:value' ? VALUE : type.id;
  return { ...type, id, ...(type.valueType ? { valueType: concrete(type.valueType) } : {}) };
}

function hasWildcards(def: NodeDefinition): boolean {
  return [...def.inputs, ...def.outputs].some((p) => p.type && [p.type.id, p.type.valueType?.id].some((id) => id === 'wildcard' || id === 'wildcard:value'));
}

const wire = (fromNode: string, fromPin: string, toNode: string, toPin: string): GraphConnection => ({ id: `${fromNode}.${fromPin}>${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
// Named as the pin, or by its id when its name isn't a word (Make Array's "[0]").
const signaturePin = (pin: PinDefinition) => ({ id: pin.id, name: /^[A-Za-z]/.test(pin.name) ? pin.name : pin.id, kind: 'data' as const, ...(concrete(pin.type) ? { type: concrete(pin.type)! } : {}) });

// The node's code in a copy of `context`: an impure node from a custom event whose inputs are its
// own, a pure one in a function that returns its outputs (it's written where it's used).
function generated(entry: PreviewEntry, context: GraphDocument, options: PreviewOptions): string | undefined {
  const base = options.registry.get(entry.type)!;
  // Generated names come from the node's id: "node" reads well, unless the document has one.
  const nodeId = context.graphs.some((g) => g.nodes.some((n) => n.id === 'node')) ? 'vgPreviewNode' : 'node';
  const properties = { ...(entry.properties ?? {}), ...(hasWildcards(base) && !entry.properties?.wildcards ? { wildcards: { wildcard: ELEMENT, 'wildcard:value': VALUE } } : {}) };
  const node: GraphNode = { id: nodeId, type: entry.type, position: { x: 0, y: 0 }, properties };
  const def = createResolver(options.registry, context)(node);
  if (!def) return undefined;
  const inputs = def.inputs.filter((p) => p.kind === 'data');
  const outputs = def.outputs.filter((p) => p.kind === 'data');
  const execIn = def.inputs.find((p) => p.kind === 'exec');
  const doc: GraphDocument = { ...context, graphs: [...context.graphs] };
  let graph: Graph;
  let shown: string;
  if (execIn) {
    const event = doc.graphs.find((g) => g.kind === 'event');
    const custom: GraphNode = { id: EVENT, type: 'core:event.custom', position: { x: 0, y: 0 }, properties: { name: 'VgPreview', inputs: inputs.map(signaturePin) } };
    const connections = [wire(EVENT, 'execOut', nodeId, execIn.id), ...inputs.map((p) => wire(EVENT, p.id, nodeId, p.id))];
    graph = event
      ? { ...event, nodes: [...event.nodes, custom, node], connections: [...event.connections, ...connections] }
      : { id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [custom, node], connections };
    doc.graphs = event ? doc.graphs.map((g) => (g === event ? graph : g)) : [graph, ...doc.graphs];
    shown = nodeId;
  } else {
    const entryNode: GraphNode = { id: `${nodeId}Entry`, type: 'core:function.entry', position: { x: 0, y: 0 }, properties: { graph: FUNCTION } };
    const returnNode: GraphNode = { id: `${nodeId}Return`, type: 'core:function.return', position: { x: 0, y: 0 }, properties: { graph: FUNCTION } };
    graph = {
      id: FUNCTION, name: FUNCTION, kind: 'function', comments: [],
      signature: { pure: true, inputs: inputs.map(signaturePin), outputs: outputs.map(signaturePin) },
      nodes: [entryNode, node, returnNode],
      connections: [wire(entryNode.id, 'execOut', returnNode.id, 'execIn'), ...inputs.map((p) => wire(entryNode.id, p.id, nodeId, p.id)), ...outputs.map((p) => wire(nodeId, p.id, returnNode.id, p.id))]
    };
    if (!doc.graphs.some((g) => g.kind === 'event')) doc.graphs.unshift({ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [], connections: [] });
    doc.graphs.push(graph);
    shown = returnNode.id;
  }
  let result;
  try {
    result = compileDocument(doc, { registry: options.registry, languages: options.languages, generate: { sourceFileName: `${context.name || 'Preview'}.vgraph`, outputDir: '' } });
  } catch {
    return undefined;
  }
  if (!result.output || result.diagnostics.some((d) => d.severity === 'error' && (d.graphId === graph.id || !d.graphId))) return undefined;
  const at = result.output.nodeLines.find((l) => l.graphId === graph.id && l.nodeId === shown);
  return at ? ownLines(result.output.text, at.line) : undefined;
}

// The lines from `line` (1-based) while they're indented at least as deep, dedented.
export function ownLines(text: string, line: number): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const first = lines[line - 1] ?? '';
  const indent = /^\s*/.exec(first)![0];
  const own: string[] = [];
  for (let i = line - 1; i < lines.length; i++) {
    const current = lines[i];
    if (current.trim() && !current.startsWith(indent)) break;
    own.push(current);
  }
  while (own.length && !own[own.length - 1].trim()) own.pop();
  return own.map((l) => l.slice(indent.length)).join('\n');
}
