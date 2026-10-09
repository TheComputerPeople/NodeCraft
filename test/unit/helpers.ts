import * as fs from 'node:fs';
import * as path from 'node:path';
import { Graph, GraphConnection, GraphDocument, GraphNode, GraphVariable, RuntimeLogEvent } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { GraphRuntime } from '../../src/core/runtime';

// Compiled tests live in out/test/unit, three levels below the repository root.
export const repoRoot = path.resolve(__dirname, '../../..');

export function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// A class document whose event graph holds the given nodes and connections.
export function doc(nodes: GraphNode[], connections: GraphConnection[], variables: GraphVariable[] = []): GraphDocument {
  return {
    schemaVersion: 2, name: 'Test', kind: 'class', language: 'javascript', variables,
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', nodes, connections, comments: [] }]
  };
}

export function graphOf(document: GraphDocument): Graph {
  return document.graphs[0];
}

export function node(id: string, type: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, type, position: { x: 0, y: 0 }, properties };
}

export function wire(fromNode: string, fromPin: string, toNode: string, toPin: string): GraphConnection {
  return { id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin };
}

export function run(g: GraphDocument, registry = new NodeRegistry()): RuntimeLogEvent[] {
  const events: RuntimeLogEvent[] = [];
  new GraphRuntime(registry, (event) => events.push(event)).run(g);
  return events;
}

export function logs(events: RuntimeLogEvent[]): string[] {
  return events.filter((e) => e.kind === 'log').map((e) => e.message ?? '');
}

export function exitCounts(events: RuntimeLogEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) if (e.kind === 'node.exit' && e.nodeId) counts[e.nodeId] = (counts[e.nodeId] ?? 0) + 1;
  return counts;
}
