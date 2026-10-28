// The document being edited, the node definitions it uses, and syncing changes back to the host.
import { DEFAULT_LANGUAGE } from '../core/languages';
import { FULL_CAPABILITIES, implementsCode, missingCapabilities, nodeRequirements } from '../core/capabilities';
import type { LanguageCapabilities } from '../core/language-pack';
import { pinDefinition, releaseWildcards } from '../core/editing';
import { Access, GraphDocument, GraphNode, GraphPin, HostMessage, NodeDefinition, PinDefinition } from '../core/model';
import { adoptAliasedTypes, describeFunction, functionStatus, isFunctionType, syncImportedFunctions } from '../core/imported-functions';
import { libraryChange, libraryChangeMessage, syncLibraryVersions } from '../core/node-packages';
import { FUNCTION_CALL, FUNCTION_ENTRY, FUNCTION_RETURN } from '../core/functions';
import { MACRO_INPUTS, MACRO_INSTANCE, MACRO_OUTPUTS } from '../core/macros';
import { BIND_EVENT, CALL_DISPATCHER, CALL_EVENT, UNBIND_ALL, UNBIND_EVENT, customEvents, documentDispatchers, eventName } from '../core/events';
import { INTERFACE_CALL, OBJECT_CALL, OBJECT_DISPATCHER, OBJECT_EVENT, OBJECT_GET, OBJECT_SET, PARENT_CALL, PARENT_START, ancestors, canAccess, classTypeId, declaredClass, implementedInterfaces, interfaceById, subclassTest } from '../core/objects';
import { setClassHierarchy } from '../core/types';
import { listUserTypes } from '../core/user-types';
import { VARIABLE_GET, VARIABLE_SET, createResolver } from '../core/resolve';
import { primaryGraph } from '../core/serializer';
import { isTypeDocument, renderTypeEditor } from './type-editor';
import { markCompileDirty, renderLanguagePicker } from './compile-results';
import { dom, setStatus } from './dom';
import { postToHost } from './host';
import { renderMyBlueprint } from './my-blueprint';
import { renderPalette } from './panels';
import { pruneBreakpoints } from './breakpoints';
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
// ("Get Score", "Set Score"), as in Unreal's action menu, and project functions and code nodes only
// when the graph's language can call or compile them.
// What the graph's language can express (src/core/capabilities.ts); the editor offers nothing else.
export function languageCapabilities(): LanguageCapabilities {
  const id = state.document?.language || DEFAULT_LANGUAGE;
  return state.languages.find((l) => l.id === id)?.capabilities ?? FULL_CAPABILITIES;
}

export function paletteEntries(): PaletteEntry[] {
  const kind = state.graph?.kind;
  const entries: PaletteEntry[] = state.definitions
    .filter((d) => d.type !== VARIABLE_GET && d.type !== VARIABLE_SET && callable(d))
    // A function has one entry node and a macro one pair of tunnels; calls and macros are offered
    // one by one; Return Nodes only fit in functions, and events only in event graphs (as in
    // Unreal's action menu).
    .filter((d) => ![FUNCTION_ENTRY, FUNCTION_CALL, MACRO_INPUTS, MACRO_OUTPUTS, MACRO_INSTANCE, CALL_EVENT, CALL_DISPATCHER, BIND_EVENT, UNBIND_EVENT, UNBIND_ALL, OBJECT_GET, OBJECT_SET, OBJECT_CALL, OBJECT_EVENT, OBJECT_DISPATCHER, PARENT_CALL, INTERFACE_CALL].includes(d.type))
    // Entry events (Main, framework packs' events) belong in event graphs too.
    .filter((d) => (kind === 'event' || !kind ? d.type !== FUNCTION_RETURN : !d.type.startsWith('core:event.') && d.implementation?.kind !== 'event' && (kind === 'function' || d.type !== FUNCTION_RETURN)))
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
  // Each custom event can be called, and each dispatcher called, bound and unbound.
  const offer = (type: string, properties: Record<string, unknown>, key: string): void => {
    const definition = lookupDefinition({ id: '', type, position: { x: 0, y: 0 }, properties });
    if (definition) entries.push({ key, type, properties, definition: { ...definition, category: type === CALL_EVENT ? 'Events' : 'Event Dispatchers' } });
  };
  for (const { node } of customEvents(state.document?.graphs)) offer(CALL_EVENT, { event: eventName(node) }, `${CALL_EVENT}:${eventName(node)}`);
  for (const d of documentDispatchers(state.document ?? undefined)) {
    for (const type of [CALL_DISPATCHER, BIND_EVENT, UNBIND_EVENT, UNBIND_ALL]) offer(type, { dispatcher: d.id }, `${type}:${d.id}`);
  }
  // Parent: Start in event graphs, and Parent: <Function> in a function that overrides one.
  const parents = documentAncestors();
  if (parents.length) {
    const name = kind === 'event' ? PARENT_START : kind === 'function' && parents.some((a) => a.functions.some((f) => f.name === state.graph?.name)) ? state.graph?.name : undefined;
    const properties = { function: name };
    const definition = name && lookupDefinition({ id: '', type: PARENT_CALL, position: { x: 0, y: 0 }, properties });
    if (definition) entries.push({ key: `${PARENT_CALL}:${name}`, type: PARENT_CALL, properties, definition });
  }
  // Other classes' members, each with a Target pin, under the class's name (src/core/objects.ts).
  const own = state.document ? classTypeId(state.document.name) : '';
  const ownClass = state.document ? declaredClass(state.document) : undefined;
  for (const type of listUserTypes(state.definitions, state.document?.language)) {
    // An interface's functions, called on any object that implements it.
    if (type.kind === 'interface') {
      for (const f of type.functions) {
        const properties = { interface: type.id, function: f.id };
        const definition = lookupDefinition({ id: '', type: INTERFACE_CALL, position: { x: 0, y: 0 }, properties });
        if (definition) entries.push({ key: `${type.id}:${f.id}`, type: INTERFACE_CALL, properties, definition });
      }
      continue;
    }
    if (type.kind !== 'class' || type.id === own) continue;
    const member = (nodeType: string, properties: Record<string, unknown>, key: string): void => {
      const definition = lookupDefinition({ id: '', type: nodeType, position: { x: 0, y: 0 }, properties: { class: type.id, ...properties } });
      if (definition) entries.push({ key: `${type.id}:${key}`, type: nodeType, properties: { class: type.id, ...properties }, definition });
    };
    // Only the members this class may use: public ones, and its ancestors' protected ones.
    const usable = (m: { access?: Access }) => canAccess(m.access, type.id, ownClass, (t) => state.defByType.get(t));
    for (const v of type.variables.filter(usable)) {
      member(OBJECT_GET, { variable: v.id }, `get:${v.id}`);
      member(OBJECT_SET, { variable: v.id }, `set:${v.id}`);
    }
    for (const f of type.functions.filter(usable)) member(OBJECT_CALL, { function: f.id }, `call:${f.id}`);
    for (const e of type.events) member(OBJECT_EVENT, { event: e.id }, `event:${e.id}`);
    for (const d of type.dispatchers) for (const action of ['call', 'bind', 'unbind', 'unbind-all']) member(OBJECT_DISPATCHER, { dispatcher: d.id, action }, `${action}:${d.id}`);
  }
  const locals = state.graph?.localVariables ?? [];
  for (const variable of [...(state.document?.variables ?? []), ...locals]) {
    for (const type of [VARIABLE_GET, VARIABLE_SET]) {
      const properties = { variable: variable.id };
      const definition = lookupDefinition({ id: '', type, position: { x: 0, y: 0 }, properties });
      if (definition) entries.push({ key: `${type}:${variable.id}`, type, properties, definition });
    }
  }
  const capabilities = languageCapabilities();
  return entries.filter((e) => !missingCapabilities(nodeRequirements(e.definition), capabilities).length);
}

function callable(definition: NodeDefinition): boolean {
  const implementation = definition.implementation;
  // A macro library's macros are for graphs in its language.
  if (implementation?.kind === 'macro') return !implementation.language || !state.document?.language || implementation.language === state.document.language;
  const language = state.languages.find((l) => l.id === state.document?.language);
  if (implementation?.kind === 'code') return !language?.snippetLanguages || implementsCode(definition, language.snippetLanguages, language.snippets ?? []);
  if (implementation?.kind !== 'function') return true;
  // A library generated for several languages can be called from each of them.
  return !language || [implementation.language, ...Object.keys(implementation.variants ?? {})].some((l) => language.callable.includes(l));
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
    const gone = node.type.startsWith('lib:') ? 'no longer exists' : 'no longer exists, or is no longer marked @blueprint';
    return { severity: 'error', status, message: `${name} in ${path} ${gone}.${offer}` };
  }
  return undefined;
}

// A node whose package changed major version since the graph recorded it (a warning until it is
// refreshed; docs/language-breadth.md, "Node library versioning").
export function libraryProblem(node: GraphNode): { severity: 'warning'; message: string; library: string } | undefined {
  if (!state.document) return undefined;
  const change = libraryChange(state.document, state.defByType.get(node.type));
  return change && { severity: 'warning', message: libraryChangeMessage(change), library: change.name };
}

export function pinDef(nodeId: string, pinId: string): PinDefinition | undefined {
  return state.graph ? pinDefinition(state.graph, lookupDefinition, nodeId, pinId) : undefined;
}

export function setDefinitions(definitions: NodeDefinition[]): void {
  state.definitions = definitions;
  // A node of a former type (NodeDefinition.aliases) finds its definition, and takes its type when saved.
  state.defByType = new Map(definitions.flatMap((d) => [[d.type, d] as const, ...(d.aliases ?? []).map((alias) => [alias, d] as const)]));
  updateClassHierarchy();
  renderPalette();
}

// An object of a subclass wires where its parent class is expected (src/core/objects.ts).
export function updateClassHierarchy(): void {
  const own = state.document ? declaredClass(state.document) : undefined;
  setClassHierarchy(subclassTest((type) => state.defByType.get(type), own));
}

// The functions of the interfaces the document's class implements (with its ancestors').
export function documentInterfaceFunctions(): { name: string; inputs: GraphPin[]; outputs: GraphPin[]; pure: boolean }[] {
  const own = state.document ? declaredClass(state.document) : undefined;
  if (!own) return [];
  const definition = (type: string) => state.defByType.get(type);
  return implementedInterfaces(own, definition).flatMap((id) => interfaceById(id, definition)?.functions ?? []);
}

// The document's class's ancestors, nearest first.
export function documentAncestors(): ReturnType<typeof ancestors> {
  const own = state.document ? declaredClass(state.document) : undefined;
  return own ? ancestors(own, (type) => state.defByType.get(type)) : [];
}

export function applySettings(message: HostMessage): void {
  if (typeof message.saveDelay === 'number' && message.saveDelay >= 0) state.saveDelay = message.saveDelay;
  if (typeof message.trusted === 'boolean') {
    const restricted = 'Running graphs is disabled in Restricted Mode. Trust this workspace to run graphs.';
    dom.runButton.disabled = !message.trusted;
    dom.runButton.title = message.trusted ? 'Compile, then run the generated code' : restricted;
    dom.simulateButton.disabled = !message.trusted;
    dom.simulateButton.title = message.trusted ? 'Run the graph in the editor without compiling' : restricted;
    dom.debugButton.disabled = !message.trusted;
    dom.debugButton.title = message.trusted ? 'Compile, then run the generated code under the debugger, stopping at breakpoints (F5)' : restricted;
  }
}

// Shows `doc`, staying on the same graph when it still exists (e.g. after an undo).
export function loadDocument(doc: GraphDocument, preserveView = false): void {
  const previousGraphId = state.graph?.id;
  state.document = copyDocument(doc);
  updateClassHierarchy();
  state.graph = state.document.graphs.find((g) => g.id === previousGraphId) ?? primaryGraph(state.document) ?? null;
  dom.graphName.textContent = state.graph ? `${state.document.name} › ${state.graph.name}` : state.document.name;
  // A structure or enumeration has no graphs: its fields or values are edited instead.
  const typeDocument = isTypeDocument(state.document);
  dom.typeEditor.hidden = !typeDocument;
  dom.typeEditor.dataset.kind = state.document.kind;
  dom.palette.hidden = typeDocument;
  dom.help.hidden = typeDocument;
  dom.fitButton.hidden = typeDocument;
  for (const button of [dom.runButton, dom.simulateButton, dom.debugButton]) button.hidden = typeDocument;
  if (typeDocument) renderTypeEditor();
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
  pruneBreakpoints();
  // Nodes of a former type become their definition's (a function library's "fn:" nodes, "lib:").
  adoptAliasedTypes(state.document, (type) => state.defByType.get(type));
  // Store the signature of each project function the graph calls, with the graph.
  syncImportedFunctions(state.document, (type) => state.defByType.get(type));
  // And the version of each node package it uses.
  syncLibraryVersions(state.document, (type) => state.defByType.get(type));
  postToHost({ type: 'applyDocument', document: state.document });
  // Don't hide a message an action just showed (e.g. "Deleted Health and 2 nodes").
  if (dom.status.textContent === 'Unsaved changes') setStatus('Saved');
}
