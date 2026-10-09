// The document being edited, the node definitions it uses, and syncing changes back to the host.
import { pinDefinition } from '../core/editing';
import { GraphDocument, HostMessage, NodeDefinition, PinDefinition } from '../core/model';
import { primaryGraph } from '../core/serializer';
import { markCompileDirty, renderLanguagePicker } from './compile-results';
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
  setStatus('Saved');
}
