// Copying nodes as text, as Unreal does, so they paste into any graph or document (or a chat).
// The text carries the nodes, the wires between them, and the variables their Get/Set nodes use,
// so pasting into another document can bind to (or create) those variables, and the stored
// signatures of the project functions they call, so they keep their pins.
import { isFunctionType } from './imported-functions';
import { Graph, GraphConnection, GraphDocument, GraphNode, GraphVariable, NodeDefinition } from './model';
import { VARIABLE_GET, VARIABLE_SET } from './resolve';
import { uniqueName } from './blueprint-edits';

const FORMAT = 'blueprint-visual-scripting/nodes';

interface ClipboardData {
  format: typeof FORMAT;
  version: 1;
  nodes: GraphNode[];
  connections: GraphConnection[];
  variables: GraphVariable[];
  importedFunctions?: Record<string, NodeDefinition>;
}

export function copyNodes(doc: GraphDocument, graph: Graph, nodeIds: ReadonlySet<string>): string | undefined {
  const nodes = graph.nodes.filter((n) => nodeIds.has(n.id));
  if (!nodes.length) return undefined;
  const variableIds = new Set(nodes.filter(isVariableNode).map((n) => n.properties.variable));
  const functions = Object.fromEntries(nodes.filter((n) => isFunctionType(n.type) && doc.importedFunctions?.[n.type]).map((n) => [n.type, doc.importedFunctions![n.type]]));
  const data: ClipboardData = {
    format: FORMAT,
    version: 1,
    nodes,
    connections: graph.connections.filter((c) => nodeIds.has(c.fromNode) && nodeIds.has(c.toNode)),
    variables: doc.variables.filter((v) => variableIds.has(v.id)),
    ...(Object.keys(functions).length ? { importedFunctions: functions } : {})
  };
  return JSON.stringify(data, null, 2);
}

export interface PasteIds {
  node: (type: string) => string;
  connection: () => string;
}

// Adds copied nodes to `graph`, placing their top-left corner at `position`. Returns the new
// node ids, or undefined when `text` isn't copied nodes. Variables are matched by name; missing
// ones are created (libraries have no variables, so their nodes stay unbound there).
export function pasteNodes(doc: GraphDocument, graph: Graph, text: string, position: { x: number; y: number }, ids: PasteIds): string[] | undefined {
  let data: ClipboardData;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (data?.format !== FORMAT || !Array.isArray(data.nodes) || !data.nodes.length) return undefined;

  const variableMap = new Map<string, string>();
  for (const variable of data.variables ?? []) {
    if (doc.kind !== 'class') break;
    const existing = doc.variables.find((v) => v.name === variable.name);
    if (existing) {
      variableMap.set(variable.id, existing.id);
      continue;
    }
    const id = uniqueName(variable.id, doc.variables.map((v) => v.id));
    doc.variables.push({ ...variable, id });
    variableMap.set(variable.id, id);
  }

  // A signature the document already stores wins: its other nodes were made with it.
  for (const [type, signature] of Object.entries(data.importedFunctions ?? {})) {
    if (!doc.importedFunctions?.[type]) doc.importedFunctions = { ...(doc.importedFunctions ?? {}), [type]: signature };
  }

  const minX = Math.min(...data.nodes.map((n) => n.position.x));
  const minY = Math.min(...data.nodes.map((n) => n.position.y));
  const nodeMap = new Map<string, string>();
  const pasted: GraphNode[] = data.nodes.map((source) => {
    const node: GraphNode = JSON.parse(JSON.stringify(source));
    node.id = ids.node(node.type);
    nodeMap.set(source.id, node.id);
    node.position = { x: position.x + source.position.x - minX, y: position.y + source.position.y - minY };
    if (isVariableNode(node)) {
      const bound = variableMap.get(String(node.properties.variable));
      if (bound) node.properties.variable = bound;
      else delete node.properties.variable;
    }
    return node;
  });
  graph.nodes.push(...pasted);
  for (const c of data.connections ?? []) {
    const fromNode = nodeMap.get(c.fromNode);
    const toNode = nodeMap.get(c.toNode);
    if (fromNode && toNode) graph.connections.push({ id: ids.connection(), fromNode, fromPin: c.fromPin, toNode, toPin: c.toPin });
  }
  return pasted.map((n) => n.id);
}

function isVariableNode(node: GraphNode): boolean {
  return node.type === VARIABLE_GET || node.type === VARIABLE_SET;
}
