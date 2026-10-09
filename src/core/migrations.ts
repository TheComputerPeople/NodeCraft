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
