// The document being edited, the node definitions it uses, and syncing changes back to the host.
import { pinDefinition, releaseWildcards } from '../core/editing';
import { GraphDocument, GraphNode, HostMessage, NodeDefinition, PinDefinition } from '../core/model';
import { describeFunction, functionStatus, isFunctionType, syncImportedFunctions } from '../core/imported-functions';
import { FUNCTION_CALL, FUNCTION_ENTRY, FUNCTION_RETURN } from '../core/functions';
import { MACRO_INPUTS, MACRO_INSTANCE, MACRO_OUTPUTS } from '../core/macros';
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
  return createResolver({ get: (type) => state.defByType.get(type) }, state.document ?? { variables: [] })(node);
}

// Something the palette and action menu can place: a node type, plus preset properties.
export interface PaletteEntry {
  key: string;
  type: string;
  properties: Record<string, unknown>;
  definition: NodeDefinition;
}

// Every node type, except that variable Get/Set nodes are offered once per declared variable
// ("Get Score", "Set Score"), as in Unreal's action menu, and project functions only when the
// graph's language can call them.
export function paletteEntries(): PaletteEntry[] {
  const kind = state.graph?.kind;
  const entries: PaletteEntry[] = state.definitions
    .filter((d) => d.type !== VARIABLE_GET && d.type !== VARIABLE_SET && callable(d))
    // A function has one entry node and a macro one pair of tunnels; calls and macros are offered
    // one by one; Return Nodes only fit in functions, and events only in event graphs (as in
    // Unreal's action menu).
    .filter((d) => ![FUNCTION_ENTRY, FUNCTION_CALL, MACRO_INPUTS, MACRO_OUTPUTS, MACRO_INSTANCE].includes(d.type))
    .filter((d) => (kind === 'event' || !kind ? d.type !== FUNCTION_RETURN : !d.type.startsWith('core:event.') && (kind === 'function' || d.type !== FUNCTION_RETURN)))
    // A macro library's macro can't use itself.
    .filter((d) => !(d.implementation?.kind === 'macro' && kind === 'macro' && d.implementation.source.graph === state.graph?.id && state.document?.kind === 'macroLibrary'))
    .map((d) => ({ key: d.type, type: d.type, properties: {}, definition: d }));
  for (const graph of state.document?.graphs ?? []) {
    if (graph.kind !== 'function' && graph.kind !== 'macro') continue;
    // A macro can't use itself.
    if (graph.kind === 'macro' && graph.id === state.graph?.id) continue;
    const type = graph.kind === 'function' ? FUNCTION_CALL : MACRO_INSTANCE;
    const properties = { graph: graph.id };
    const definition = lookupDefinition({ id: '', type, position: { x: 0, y: 0 }, properties });
    if (definition) entries.push({ key: `${type}:${graph.id}`, type, properties, definition });
  }
  const locals = state.graph?.localVariables ?? [];
  for (const variable of [...(state.document?.variables ?? []), ...locals]) {
    for (const type of [VARIABLE_GET, VARIABLE_SET]) {
      const properties = { variable: variable.id };
      const definition = lookupDefinition({ id: '', type, position: { x: 0, y: 0 }, properties });
      if (definition) entries.push({ key: `${type}:${variable.id}`, type, properties, definition });
    }
  }
  return entries;
}

function callable(definition: NodeDefinition): boolean {
  const implementation = definition.implementation;
  // A macro library's macros are for graphs in its language.
  if (implementation?.kind === 'macro') return !implementation.language || !state.document?.language || implementation.language === state.document.language;
  if (implementation?.kind !== 'function') return true;
  const language = state.languages.find((l) => l.id === state.document?.language);
  return !language || language.callable.includes(implementation.language);
}

// Text an entry matches in searches: its name, category, description and keywords.
export function searchText(definition: NodeDefinition): string {
  return [definition.displayName, definition.category, definition.description ?? '', ...(definition.keywords ?? [])].join(' ').toLowerCase();
}

// A project function node whose code changed (a warning until it is refreshed) or is gone (an
// error), for its badge and menu (docs/code-as-nodes.md, "When the code changes").
export function functionProblem(node: GraphNode): { severity: 'error' | 'warning'; message: string; status: ReturnType<typeof functionStatus> } | undefined {
  if (!isFunctionType(node.type) || !state.document) return undefined;
  const stored = state.document.importedFunctions?.[node.type];
  const status = functionStatus(stored, state.defByType.get(node.type), () => state.definitions);
  const { name, path } = describeFunction(node.type, stored);
  if (status.state === 'changed') {
    return { severity: 'warning', status, message: `${name} in ${path} changed: ${status.changes.join('; ')}. Right-click the node and choose Refresh Node.` };
  }
  if (status.state === 'missing' && state.functionsLoaded) {
    const offer = status.candidates.length ? ` Right-click the node to replace it with ${status.candidates.map((c) => c.displayName).join(' or ')}.` : '';
    return { severity: 'error', status, message: `${name} in ${path} no longer exists, or is no longer marked @blueprint.${offer}` };
  }
  return undefined;
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
  // A wildcard node with no wire left on its wildcard pins can take another type, as in Unreal.
  if (state.graph && releaseWildcards(state.graph, lookupDefinition)) render();
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
  // Store the signature of each project function the graph calls, with the graph.
  syncImportedFunctions(state.document, (type) => state.defByType.get(type));
  postToHost({ type: 'applyDocument', document: state.document });
  // Don't hide a message an action just showed (e.g. "Deleted Health and 2 nodes").
  if (dom.status.textContent === 'Unsaved changes') setStatus('Saved');
}
