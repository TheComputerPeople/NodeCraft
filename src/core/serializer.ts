import { DEFAULT_LANGUAGE } from './languages';
import { DEFAULT_EVENT_GRAPH_ID, isV1Document, migrateV1ToV2, migrateV2ToV3 } from './migrations';
import { DocumentKind, Graph, GraphDocument, GraphKind } from './model';

export const CURRENT_SCHEMA_VERSION = 3;

export interface ParsedDocument {
  document: GraphDocument;
  // The schema version the text was written in, when it was older and has been upgraded in memory.
  // The file itself is only rewritten when the document is next saved.
  migratedFrom?: number;
}

export function createEmptyDocument(name = 'NewGraph', language = DEFAULT_LANGUAGE): GraphDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    name,
    kind: 'class',
    language,
    variables: [],
    graphs: [createGraph(DEFAULT_EVENT_GRAPH_ID, 'event')],
    metadata: { createdBy: 'Blueprint Visual Scripting' }
  };
}

export function createGraph(name: string, kind: GraphKind): Graph {
  return {
    id: name,
    name,
    kind,
    ...(kind === 'event' ? {} : { signature: { inputs: [], outputs: [] } }),
    nodes: [],
    connections: [],
    comments: []
  };
}

export function parseDocument(text: string, fallbackName = 'NewGraph'): ParsedDocument {
  if (!text.trim()) return { document: createEmptyDocument(fallbackName) };
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error('Invalid .vgraph document: expected a JSON object.');

  const version = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`This graph uses schema version ${version}, which is newer than this extension supports (${CURRENT_SCHEMA_VERSION}). Update the extension to open it.`);
  }
  // Each migration step upgrades by one version, so older files pass through every step.
  let raw: Record<string, unknown> = parsed;
  if (version === 1) {
    if (!isV1Document(parsed)) throw new Error('Invalid .vgraph document: expected nodes and connections arrays.');
    raw = migrateV1ToV2(parsed, fallbackName);
  }
  const document = normalizeDocument(raw, fallbackName);
  if (version < 3) return { document: migrateV2ToV3(document), migratedFrom: version };
  return { document };
}

const DOCUMENT_KINDS: DocumentKind[] = ['class', 'functionLibrary', 'macroLibrary', 'structure', 'enumeration'];
const GRAPH_KINDS: GraphKind[] = ['event', 'function', 'macro'];

// Which graph kinds each document kind may contain, as in Unreal.
const ALLOWED_GRAPHS: Record<DocumentKind, GraphKind[]> = {
  class: ['event', 'function', 'macro'],
  functionLibrary: ['function'],
  macroLibrary: ['macro'],
  structure: [],
  enumeration: []
};

// Whether a document holds graphs: structures and enumerations only declare a type.
export function hasGraphs(kind: DocumentKind): boolean {
  return ALLOWED_GRAPHS[kind].length > 0;
}

// Fills optional fields and enforces the structural rules; throws with a readable message when
// the document breaks them.
function normalizeDocument(raw: Record<string, unknown>, fallbackName: string): GraphDocument {
  const kind = raw.kind ?? 'class';
  if (!DOCUMENT_KINDS.includes(kind as DocumentKind)) throw new Error(`Invalid .vgraph document: unknown kind "${String(kind)}".`);
  const graphless = kind === 'structure' || kind === 'enumeration';
  if (graphless ? raw.graphs !== undefined && !Array.isArray(raw.graphs) : !Array.isArray(raw.graphs) || raw.graphs.length === 0) throw new Error('Invalid .vgraph document: expected at least one graph.');
  if (raw.enumerators !== undefined && (kind !== 'enumeration' || !Array.isArray(raw.enumerators))) throw new Error('Invalid .vgraph document: only an enumeration has enumerators, as an array.');
  if (raw.variables !== undefined && !Array.isArray(raw.variables)) throw new Error('Invalid .vgraph document: variables must be an array.');

  const doc: GraphDocument = {
    ...raw,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    name: typeof raw.name === 'string' && raw.name ? raw.name : fallbackName,
    kind: kind as DocumentKind,
    language: typeof raw.language === 'string' && raw.language ? raw.language : DEFAULT_LANGUAGE,
    variables: (raw.variables as GraphDocument['variables'] | undefined) ?? [],
    graphs: ((raw.graphs as unknown[] | undefined) ?? []).map((g, i) => normalizeGraph(g, i)),
    ...(kind === 'enumeration' ? { enumerators: (raw.enumerators as GraphDocument['enumerators']) ?? [] } : {}),
    metadata: isObject(raw.metadata) ? raw.metadata : {}
  };

  if (doc.kind !== 'class' && doc.kind !== 'structure' && doc.variables.length) throw new Error(`Invalid .vgraph document: a ${doc.kind} cannot have variables.`);
  if (doc.dispatchers !== undefined && (doc.kind !== 'class' || !Array.isArray(doc.dispatchers))) throw new Error('Invalid .vgraph document: only a class has event dispatchers, as an array.');
  const ids = new Set<string>();
  for (const graph of doc.graphs) {
    if (ids.has(graph.id)) throw new Error(`Invalid .vgraph document: duplicate graph id "${graph.id}".`);
    ids.add(graph.id);
    if (!ALLOWED_GRAPHS[doc.kind].includes(graph.kind)) throw new Error(`Invalid .vgraph document: a ${doc.kind} cannot contain ${graph.kind} graph "${graph.name}".`);
  }
  return doc;
}

function normalizeGraph(raw: unknown, index: number): Graph {
  const where = `graph ${index + 1}`;
  if (!isObject(raw)) throw new Error(`Invalid .vgraph document: ${where} is not an object.`);
  if (typeof raw.id !== 'string' || !raw.id) throw new Error(`Invalid .vgraph document: ${where} has no id.`);
  if (!GRAPH_KINDS.includes(raw.kind as GraphKind)) throw new Error(`Invalid .vgraph document: graph "${raw.id}" has unknown kind "${String(raw.kind)}".`);
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.connections)) throw new Error(`Invalid .vgraph document: graph "${raw.id}" needs nodes and connections arrays.`);
  const kind = raw.kind as GraphKind;
  const graph = { ...raw, name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id, comments: Array.isArray(raw.comments) ? raw.comments : [] } as Graph;
  if (kind !== 'event' && !graph.signature) graph.signature = { inputs: [], outputs: [] };
  if (kind === 'event' && graph.signature) throw new Error(`Invalid .vgraph document: event graph "${raw.id}" cannot have a signature.`);
  return graph;
}

const DOCUMENT_KEY_ORDER = ['schemaVersion', 'name', 'kind', 'language', 'variables', 'enumerators', 'dispatchers', 'graphs', 'metadata'];
const GRAPH_KEY_ORDER = ['id', 'name', 'kind', 'signature', 'localVariables', 'nodes', 'connections', 'comments'];

// Known fields come first in a fixed order, so files diff cleanly whichever code produced them.
export function serializeDocument(doc: GraphDocument): string {
  const ordered = orderKeys(doc, DOCUMENT_KEY_ORDER);
  ordered.graphs = doc.graphs.map((g) => orderKeys(g, GRAPH_KEY_ORDER));
  return JSON.stringify(ordered, null, 2) + '\n';
}

function orderKeys<T extends object>(value: T, order: string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of order) if (source[key] !== undefined) result[key] = source[key];
  for (const key of Object.keys(source)) if (!(key in result) && source[key] !== undefined) result[key] = source[key];
  return result;
}

// The graph the editor opens and Run starts from: the first event graph, else the first graph.
export function primaryGraph(doc: GraphDocument): Graph {
  return doc.graphs.find((g) => g.kind === 'event') ?? doc.graphs[0];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
