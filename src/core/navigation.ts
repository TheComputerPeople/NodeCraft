// Go to Definition and Find References (docs/node-authoring.md, gap 5): where a node's definition
// is, as Unreal opens a function's graph or a C++ node's source, and every node of a type.
import { definitionFor } from './editing';
import { FUNCTION_CALL } from './functions';
import { MACRO_INSTANCE } from './macros';
import { GraphDocument, GraphNode, NodeDefinition } from './model';
import { NodeResolver } from './resolve';
import { SearchHit } from './search';

export type DefinitionSite =
  // A function or macro graph of this file.
  | { kind: 'graph'; graphId: string }
  // A function or macro of a library: its .vgraph file (workspace-relative) and graph.
  | { kind: 'library'; document: string; graphId: string }
  // A function, method or property of the project's code (workspace-relative path); the host
  // finds its line from the latest scan.
  | { kind: 'code'; path: string }
  // A snippet node or a package's node: the host knows the *.node.json file it came from.
  | { kind: 'node-file' };

// Undefined for nodes defined by the editor itself (built-in nodes, a framework's events).
export function definitionSite(node: GraphNode, def: NodeDefinition, doc: GraphDocument | undefined): DefinitionSite | undefined {
  if (node.type === FUNCTION_CALL || node.type === MACRO_INSTANCE) {
    const graphId = node.properties.graph;
    return typeof graphId === 'string' && doc?.graphs.some((g) => g.id === graphId) ? { kind: 'graph', graphId } : undefined;
  }
  const implementation = def.implementation;
  if ((implementation?.kind === 'function' || implementation?.kind === 'macro') && implementation.source) {
    return { kind: 'library', document: implementation.source.document, graphId: implementation.source.graph };
  }
  if (implementation?.kind === 'function') return { kind: 'code', path: implementation.path };
  if (implementation?.kind === 'code' || def.library) return { kind: 'node-file' };
  return undefined;
}

// Every node of the type (or of one of its old types, its aliases), as Find in All Blueprints hits.
export function findReferences(doc: GraphDocument, type: string, resolve: NodeResolver): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const graph of doc.graphs) {
    for (const node of graph.nodes) {
      const def = definitionFor(node, resolve);
      if (node.type === type || def.type === type) hits.push({ kind: 'node', graphId: graph.id, graphName: graph.name, id: node.id, label: def.displayName });
    }
  }
  return hits;
}
