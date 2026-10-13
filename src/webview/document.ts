// The document being edited, the node definitions it uses, and syncing changes back to the host.
import { pinDefinition } from '../core/editing';
import { GraphDocument, GraphNode, HostMessage, NodeDefinition, PinDefinition } from '../core/model';
import { VARIABLE_GET, VARIABLE_SET, createResolver } from '../core/resolve';
import { primaryGraph } from '../core/serializer';
import { markCompileDirty, renderLanguagePicker } from './compile-results';
import { dom, setStatus } from './dom';
import { postToHost } from './host';
import { renderMyBlueprint } from './my-blueprint';
import { renderPalette } from './panels';
import { render } from './render';
import { state } from './state';
import { applyTransform } from './view';

// A node's definition in the open document (variable nodes take their variable's name and type).
export function lookupDefinition(node: GraphNode): NodeDefinition | undefined {
  return createResolver({ get: (type) => state.defByType.get(type) }, state.document?.variables ?? [])(node);
}

// Something the palette and action menu can place: a node type, plus preset properties.
export interface PaletteEntry {
  key: string;
  type: string;
  properties: Record<string, unknown>;
  definition: NodeDefinition;
}

// Every node type, except that variable Get/Set nodes are offered once per declared variable
// ("Get Score", "Set Score"), as in Unreal's action menu.
export function paletteEntries(): PaletteEntry[] {
  const entries: PaletteEntry[] = state.definitions
    .filter((d) => d.type !== VARIABLE_GET && d.type !== VARIABLE_SET)
    .map((d) => ({ key: d.type, type: d.type, properties: {}, definition: d }));
  for (const variable of state.document?.variables ?? []) {
    for (const type of [VARIABLE_GET, VARIABLE_SET]) {
      const properties = { variable: variable.id };
      const definition = lookupDefinition({ id: '', type, position: { x: 0, y: 0 }, properties });
      if (definition) entries.push({ key: `${type}:${variable.id}`, type, properties, definition });
    }
  }
  return entries;
}

// Text an entry matches in searches: its name, category, description and keywords.
export function searchText(definition: NodeDefinition): string {
  return [definition.displayName, definition.category, definition.description ?? '', ...(definition.keywords ?? [])].join(' ').toLowerCase();
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
  if (typeof message.trusted === 'boolean') {
    const restricted = 'Running graphs is disabled in Restricted Mode. Trust this workspace to run graphs.';
    dom.runButton.disabled = !message.trusted;
    dom.runButton.title = message.trusted ? 'Compile, then run the generated code' : restricted;
    dom.simulateButton.disabled = !message.trusted;
    dom.simulateButton.title = message.trusted ? 'Run the graph in the editor without compiling' : restricted;
  }
}

// Shows `doc`, staying on the same graph when it still exists (e.g. after an undo).
export function loadDocument(doc: GraphDocument, preserveView = false): void {
  const previousGraphId = state.graph?.id;
  state.document = copyDocument(doc);
  state.graph = state.document.graphs.find((g) => g.id === previousGraphId) ?? primaryGraph(state.document);
  dom.graphName.textContent = `${state.document.name} › ${state.graph.name}`;
  renderLanguagePicker();
  // Variables may have changed, and the palette lists one Get and Set entry per variable.
  renderPalette();
  renderMyBlueprint();
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

// The host validates and normalizes documents; this takes a private copy the editor can mutate
// freely and guards node fields the canvas relies on.
function copyDocument(doc: GraphDocument): GraphDocument {
  const copy = JSON.parse(JSON.stringify(doc)) as GraphDocument;
  for (const graph of copy.graphs) {
    for (const n of graph.nodes) {
      n.properties = n.properties || {};
      n.position = n.position || { x: 0, y: 0 };
    }
  }
  return copy;
}

export function markDirty(): void {
  state.dirty = true;
  setStatus('Unsaved changes');
  markCompileDirty();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, state.saveDelay);
}

export function flushSave(): void {
  if (!state.document || !state.dirty) return;
  clearTimeout(state.saveTimer);
  state.dirty = false;
  postToHost({ type: 'applyDocument', document: state.document });
  // Don't hide a message an action just showed (e.g. "Deleted Health and 2 nodes").
  if (dom.status.textContent === 'Unsaved changes') setStatus('Saved');
}
