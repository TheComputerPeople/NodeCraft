// Node examples (docs/node-authoring.md, gap 8): a node may list inputs and the outputs they give.
// Testing a node library builds a graph from them, which calls the node once per example and prints
// each output, and compares what it prints with the outputs formatted as Print shows them.
import { GraphConnection, GraphDocument, GraphNode, NodeDefinition } from './model';
import { formatValue, fromStored } from './values';

// The graph, and the lines each example should print (one per output it lists, in pin order).
export interface ExampleGraph {
  document: GraphDocument;
  expected: string[][];
}

const n = (id: string, type: string, x: number, properties: Record<string, unknown> = {}): GraphNode => ({ id, type, position: { x, y: 0 }, properties });

// With no examples, the node is placed once with its inputs' defaults: the graph only compiles.
export function exampleGraph(def: NodeDefinition, language: string): ExampleGraph {
  const examples = def.examples ?? [];
  const nodes: GraphNode[] = [n('start', 'core:event.start', 0)];
  const connections: GraphConnection[] = [];
  const execIn = def.inputs.find((p) => p.kind === 'exec');
  const execOut = def.outputs.find((p) => p.kind === 'exec');
  const dataOutputs = def.outputs.filter((p) => p.kind === 'data');
  // The exec chain: Start, then each example's node (when it has exec pins) and its prints.
  let last = { node: 'start', pin: 'execOut' };
  const chain = (node: string, inPin: string, outPin: string) => {
    connections.push({ id: `${last.node}.${last.pin}`, fromNode: last.node, fromPin: last.pin, toNode: node, toPin: inPin });
    last = { node, pin: outPin };
  };
  const expected: string[][] = [];
  const runs = examples.length ? examples : [{}];
  runs.forEach((example, i) => {
    const id = `example${i}`;
    const properties = Object.fromEntries(Object.entries(example.inputs ?? {}).map(([pin, value]) => [`pin:${pin}`, value]));
    nodes.push(n(id, def.type, 200 + i * 400, properties));
    if (execIn && execOut) chain(id, execIn.id, execOut.id);
    const lines: string[] = [];
    for (const pin of dataOutputs) {
      if (!example.outputs || !(pin.id in example.outputs)) continue;
      const print = `${id}_print_${pin.id}`;
      nodes.push(n(print, 'core:console.print', 200 + i * 400));
      connections.push({ id: `${id}.${pin.id}`, fromNode: id, fromPin: pin.id, toNode: print, toPin: 'value' });
      chain(print, 'execIn', 'execOut');
      lines.push(formatValue(fromStored(example.outputs[pin.id], pin.type)));
    }
    if (examples.length) expected.push(lines);
  });
  return {
    document: {
      schemaVersion: 3, name: 'NodeExamples', kind: 'class', language, variables: [],
      graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes, connections }]
    },
    expected
  };
}

// Which examples printed something else: each example's lines are taken from `actual` in order.
export function exampleMismatches(def: NodeDefinition, expected: string[][], actual: string[]): string[] {
  const problems: string[] = [];
  let at = 0;
  expected.forEach((lines, i) => {
    const got = actual.slice(at, at + lines.length);
    at += lines.length;
    if (JSON.stringify(got) !== JSON.stringify(lines)) {
      const example = def.examples![i];
      problems.push(`Example ${i + 1}${example.description ? ` (${example.description})` : ''}, inputs ${JSON.stringify(example.inputs ?? {})}: expected ${JSON.stringify(lines)}, printed ${JSON.stringify(got)}`);
    }
  });
  if (at < actual.length) problems.push(`It printed more than its examples' outputs: ${JSON.stringify(actual.slice(at))}`);
  return problems;
}
