// Searching a document, for Unreal's Find in Blueprint (Ctrl+F) and Find in All Blueprints
// (Ctrl+Shift+F). Matches graph names, variables, nodes (title, type and input values) and
// comments, case-insensitively.
import { definitionFor } from './editing';
import { GraphDocument } from './model';
import { NodeResolver } from './resolve';

export interface SearchHit {
  kind: 'graph' | 'variable' | 'node' | 'comment';
  // The graph the hit is in (for variables: none).
  graphId?: string;
  graphName?: string;
  // The node, comment, variable or graph id.
  id: string;
  label: string;
  // What matched, when it isn't the label (e.g. an input value).
  detail?: string;
}

export function searchDocument(doc: GraphDocument, query: string, resolve: NodeResolver): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches = (text: unknown) => typeof text === 'string' && text.toLowerCase().includes(q);
  const hits: SearchHit[] = [];

  for (const variable of doc.variables) {
    if (matches(variable.name) || matches(variable.description)) {
      hits.push({ kind: 'variable', id: variable.id, label: variable.name, ...(matches(variable.name) ? {} : { detail: variable.description }) });
    }
  }
  for (const graph of doc.graphs) {
    const where = { graphId: graph.id, graphName: graph.name };
    if (matches(graph.name)) hits.push({ kind: 'graph', ...where, id: graph.id, label: graph.name });
    for (const node of graph.nodes) {
      const def = definitionFor(node, resolve);
      if (matches(def.displayName) || matches(node.type)) {
        hits.push({ kind: 'node', ...where, id: node.id, label: def.displayName });
        continue;
      }
      // An input value, e.g. the text a Print node prints.
      for (const pin of def.inputs) {
        const value = node.properties[`pin:${pin.id}`];
        const text = value === undefined || value === null ? '' : String(value);
        if (matches(text)) {
          hits.push({ kind: 'node', ...where, id: node.id, label: def.displayName, detail: `${pin.name || pin.id}: ${text}` });
          break;
        }
      }
    }
    for (const comment of graph.comments) {
      if (matches(comment.text)) hits.push({ kind: 'comment', ...where, id: comment.id, label: comment.text });
    }
  }
  return hits;
}
