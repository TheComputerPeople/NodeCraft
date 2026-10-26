// Between graph nodes and lines of generated code, for debugging generated code (docs/debugging.md,
// "Debugging generated code").
import type { NodeLine } from './compiler/writer';
import { visibleNodeId } from './macros';
import { Graph, NodeDefinition } from './model';
import { isPure } from './resolve';

// The node whose code contains `line`: the nearest node starting at or before it, in the generated
// file's order, unless code that belongs to no node starts in between (`breaks`: a method's
// opening). Lines before the first node's code (imports, fields) belong to none.
export function nodeAtLine(nodeLines: readonly NodeLine[], line: number, breaks: readonly number[] = []): NodeLine | undefined {
  let best: NodeLine | undefined;
  for (const n of nodeLines) {
    if (n.line <= line && (!best || n.line > best.line)) best = n;
  }
  return best && !breaks.some((b) => b > best!.line && b <= line) ? best : undefined;
}

// The lines a breakpoint on a node becomes: where its code starts (a node may be written more than
// once; a macro's node, wherever its insides start). A pure node has no code of its own, so it stops
// where the nodes reading it run, as in Unreal.
export function breakpointLines(graph: Graph, nodeId: string, nodeLines: readonly NodeLine[], resolve: (nodeId: string) => NodeDefinition | undefined): number[] {
  const linesOf = (id: string): number[] => nodeLines.filter((n) => n.graphId === graph.id && visibleNodeId(n.nodeId) === id).map((n) => n.line);
  const own = linesOf(nodeId);
  if (own.length) return own;
  const definition = resolve(nodeId);
  if (!definition || !isPure(definition)) return [];
  const lines = new Set<number>();
  const seen = new Set([nodeId]);
  const pending = [nodeId];
  while (pending.length) {
    const id = pending.pop()!;
    for (const c of graph.connections) {
      if (c.fromNode !== id || seen.has(c.toNode)) continue;
      seen.add(c.toNode);
      const reader = resolve(c.toNode);
      if (reader && isPure(reader)) pending.push(c.toNode);
      else linesOf(c.toNode).forEach((l) => lines.add(l));
    }
  }
  return [...lines].sort((a, b) => a - b);
}
