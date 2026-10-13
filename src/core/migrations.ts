// Upgrades older .vgraph documents to the current schema. Each step is lossless: every field the
// old format carried is kept, and unknown fields are passed through.
import { GraphConnection, GraphDocument, GraphNode, GraphVariable } from './model';
import { normalizeTypeRef } from './types';

// The name Unreal gives a Blueprint's main event graph.
export const DEFAULT_EVENT_GRAPH_ID = 'EventGraph';

// Schema 1: a single graph with nodes and connections at the top level.
export interface GraphDocumentV1 {
  schemaVersion?: 1;
  name?: string;
  language?: string;
  variables?: GraphVariable[];
  nodes: GraphNode[];
  connections: GraphConnection[];
  metadata?: Record<string, unknown>;
  [extra: string]: unknown;
}

export function isV1Document(value: Record<string, unknown>): value is GraphDocumentV1 {
  return Array.isArray(value.nodes) && Array.isArray(value.connections);
}

// v2 → v3: variable Get/Set nodes bind to a declared variable (`properties.variable`, the
// variable's id) instead of naming it through a Name input. Each node is bound to the variable its
// Name input named, declaring it with type `any` if needed, which is how undeclared variables
// behaved before. Nodes whose name was wired, or that sit in a library (libraries have no
// variables), are left unbound and the compiler asks for a variable.
export function migrateV2ToV3(doc: GraphDocument): GraphDocument {
  for (const graph of doc.graphs) {
    for (const node of graph.nodes) {
      if (node.type !== 'core:variable.get' && node.type !== 'core:variable.set') continue;
      const wired = graph.connections.filter((c) => c.toNode === node.id && c.toPin === 'name');
      // The old definition's default name was "Score".
      const name = wired.length ? '' : String(node.properties['pin:name'] ?? 'Score');
      graph.connections = graph.connections.filter((c) => !wired.includes(c));
      delete node.properties['pin:name'];
      if (!name || doc.kind !== 'class') continue;
      let variable = doc.variables.find((v) => v.name === name);
      if (!variable) {
        variable = { id: uniqueVariableId(doc, name), name, type: { id: 'any' } };
        doc.variables.push(variable);
      }
      node.properties.variable = variable.id;
    }
  }
  return { ...doc, schemaVersion: 3 };
}

function uniqueVariableId(doc: GraphDocument, name: string): string {
  const base = `var_${name.replace(/[^A-Za-z0-9_]+/g, '_')}`;
  let id = base;
  for (let i = 2; doc.variables.some((v) => v.id === id); i++) id = `${base}_${i}`;
  return id;
}

// v1 → v2: the single graph becomes the class's event graph.
export function migrateV1ToV2(doc: GraphDocumentV1, fallbackName: string): GraphDocument {
  const { schemaVersion: _version, name, language, variables, nodes, connections, metadata, ...extra } = doc;
  return {
    schemaVersion: 2,
    name: name ?? fallbackName,
    kind: 'class',
    ...(language !== undefined ? { language } : {}),
    variables: (variables ?? []).map((v) => (v.type ? { ...v, type: normalizeTypeRef(v.type) } : v)),
    graphs: [{ id: DEFAULT_EVENT_GRAPH_ID, name: DEFAULT_EVENT_GRAPH_ID, kind: 'event', nodes, connections, comments: [] }],
    ...(metadata !== undefined ? { metadata } : {}),
    ...extra
  };
}
