// The graph being edited, the node definitions it uses, and syncing changes back to the host.
import { pinDefinition } from '../core/editing';
import { GraphDefinition, HostMessage, NodeDefinition, PinDefinition } from '../core/model';
import { dom, setStatus } from './dom';
import { postToHost } from './host';
import { renderPalette } from './panels';
import { render } from './render';
import { state } from './state';
import { applyTransform } from './view';

export function lookupDefinition(type: string): NodeDefinition | undefined {
  return state.defByType.get(type);
}

export function pinDef(nodeId: string, pinId: string): PinDefinition | undefined {
  return state.graph ? pinDefinition(state.graph, lookupDefinition, nodeId, pinId) : undefined;
}

export function setDefinitions(definitions: NodeDefinition[]): void {
  state.definitions = definitions;
  state.defByType = new Map(definitions.map((d) => [d.type, d]));
  renderPalette();
}

export function applySettings(message: HostMessage): void {
  if (typeof message.saveDelay === 'number' && message.saveDelay >= 0) state.saveDelay = message.saveDelay;
}

export function loadGraph(graph: GraphDefinition | undefined, preserveView = false): void {
  state.graph = normalizeGraph(graph);
  dom.graphName.textContent = state.graph.name;
  state.dirty = false;
  if (!preserveView) {
    state.pan = { x: 40, y: 40 };
    state.zoom = 1;
    state.selectedNodeIds.clear();
    state.selectedNodeId = null;
  }
  applyTransform();
  render();
}

// The host already validates documents; this only guards against missing optional fields and
// takes a private copy the editor can mutate freely.
function normalizeGraph(graph: GraphDefinition | undefined): GraphDefinition {
  const g = JSON.parse(JSON.stringify(graph ?? {})) as Partial<GraphDefinition>;
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  nodes.forEach((n) => {
    n.properties = n.properties || {};
    n.position = n.position || { x: 0, y: 0 };
  });
  return {
    ...g,
    schemaVersion: g.schemaVersion || 1,
    name: g.name || 'NewGraph',
    language: g.language || 'javascript',
    variables: Array.isArray(g.variables) ? g.variables : [],
    nodes,
    connections: Array.isArray(g.connections) ? g.connections : []
  };
}

export function markDirty(): void {
  state.dirty = true;
  setStatus('Unsaved changes');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, state.saveDelay);
}

export function flushSave(): void {
  if (!state.graph || !state.dirty) return;
  clearTimeout(state.saveTimer);
  state.dirty = false;
  postToHost({ type: 'applyGraph', graph: state.graph });
  setStatus('Saved');
}
