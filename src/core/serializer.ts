import { DEFAULT_LANGUAGE } from './languages';
import { GraphDefinition } from './model';

export const CURRENT_SCHEMA_VERSION = 1;

export function createEmptyGraph(name = 'NewGraph', language = DEFAULT_LANGUAGE): GraphDefinition {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    name,
    language,
    variables: [],
    nodes: [],
    connections: [],
    metadata: { createdBy: 'Blueprint Visual Scripting' }
  };
}

export function parseGraph(text: string, fallbackName = 'NewGraph'): GraphDefinition {
  if (!text.trim()) return createEmptyGraph(fallbackName);
  const parsed = JSON.parse(text) as GraphDefinition;
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.connections)) {
    throw new Error('Invalid .vgraph document: expected nodes and connections arrays.');
  }
  return {
    schemaVersion: parsed.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    name: parsed.name ?? fallbackName,
    language: parsed.language ?? DEFAULT_LANGUAGE,
    variables: Array.isArray(parsed.variables) ? parsed.variables : [],
    nodes: parsed.nodes,
    connections: parsed.connections,
    metadata: parsed.metadata ?? {}
  };
}

export function serializeGraph(graph: GraphDefinition): string {
  return JSON.stringify(graph, null, 2) + '\n';
}
