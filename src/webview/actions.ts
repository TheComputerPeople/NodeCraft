// User actions that change the graph, plus the pointer gestures that lead to them.
import { copyNodes, pasteNodes } from '../core/clipboard';
import * as editing from '../core/editing';
import * as edits from '../core/blueprint-edits';
import { addVariable, uniqueName } from '../core/blueprint-edits';
import { FUNCTION_ENTRY } from '../core/functions';
import { MACRO_INPUTS, MACRO_OUTPUTS } from '../core/macros';
import { functionStatus, isFunctionType, rebindFunctionNode } from '../core/imported-functions';
import { libraryChange, refreshLibrary } from '../core/node-packages';
import { VARIABLE_GET, VARIABLE_SET } from '../core/resolve';
import { GraphNode, LibraryFile, NodeDefinition, PinDefinition } from '../core/model';
import { libraryDefinitions } from '../core/libraries';
import { structInfo } from '../core/user-types';
import { CUSTOM_EVENT } from '../core/events';
import { TEST_CASE } from '../core/tests';
import { PaletteEntry, lookupDefinition, markDirty, paletteEntries, pinDef } from './document';
import { isWatched, toggleWatch } from './values';
import { dom, eventElement, pinElement, setStatus } from './dom';
import { newConnectionId, postToHost } from './host';
import { clearCommentSelection } from './comments';
import { hideContextMenu } from './menus';
import { MenuItem } from './floating-menu';
import { renderMyBlueprint, startRename } from './my-blueprint';
import { renderInspector, renderPalette } from './panels';
import { render, renderEdges, syncSelectionClasses } from './render';
import { selectNode } from './selection';
import { Point, state } from './state';
import { centerOf, screenPointToWorld, screenToWorld } from './view';

// `properties` presets the node, e.g. the variable a Get/Set node is bound to.
export function addNode(type: string, position: Point, properties: Record<string, unknown> = {}): string | null {
  if (!state.graph) return null;
  // A new custom event takes a name no function, event or dispatcher has.
  if (type === CUSTOM_EVENT && !properties.name && state.document) properties = { ...properties, name: edits.uniqueEventName(state.document) };
  if (type === TEST_CASE && !properties.name && state.document) properties = { ...properties, name: edits.uniqueTestName(state.document) };
  const definition = lookupDefinition({ id: '', type, position, properties });
  const node = editing.createNode(type, definition, position, editing.nodeIdFor(type), properties);
  state.graph.nodes.push(node);
  state.selectedNodeIds = new Set([node.id]);
  state.selectedNodeId = node.id;
  markDirty();
  render();
  return node.id;
}

export function deleteSelected(): void {
  if (!state.graph || !state.selectedNodeIds.size) return;
  // A function's entry node and a macro's Inputs and Outputs can't be deleted, as in Unreal.
  const fixed = state.graph.nodes.filter((n) => [FUNCTION_ENTRY, MACRO_INPUTS, MACRO_OUTPUTS].includes(n.type) && state.selectedNodeIds.has(n.id));
  if (fixed.length) {
    for (const node of fixed) state.selectedNodeIds.delete(node.id);
    setStatus(fixed[0].type === FUNCTION_ENTRY ? "A function's entry node can't be deleted." : "A macro's Inputs and Outputs nodes can't be deleted.");
    if (!state.selectedNodeIds.size) return;
  }
  editing.deleteNodes(state.graph, new Set(state.selectedNodeIds));
  state.selectedNodeIds.clear();
  state.selectedNodeId = null;
  markDirty();
  render();
}

// Unreal's Collapse to Function: the selection becomes a new function, called where it was.
export function collapseToFunction(): void {
  const doc = state.document;
  const graph = state.graph;
  if (!doc || !graph) return;
  const result = edits.collapseToFunction(doc, graph, new Set(state.selectedNodeIds), lookupDefinition, newConnectionId);
  if (typeof result === 'string') {
    setStatus(result);
    return;
  }
  state.selectedNodeIds = new Set([result.call.id]);
  state.selectedNodeId = result.call.id;
  markDirty();
  render();
  renderMyBlueprint();
  renderPalette();
  setStatus(`Collapsed into ${result.function.name}. Name it in My Blueprint.`);
  startRename('graph', result.function.id);
}

// Collapse to Function in Library (docs/node-authoring.md, gap 10): the host asks which function
// library to use (or makes one), then the selection becomes a function there, called where it was.
// The selection is the one when the command was chosen.
let pendingLibraryCollapse: { graphId: string; nodeIds: Set<string> } | undefined;

export function collapseToLibrary(): void {
  if (!state.document || !state.graph || !state.selectedNodeIds.size) return;
  pendingLibraryCollapse = { graphId: state.graph.id, nodeIds: new Set(state.selectedNodeIds) };
  postToHost({ type: 'pickFunctionLibrary' });
}

export function finishCollapseToLibrary(library: LibraryFile | undefined): void {
  const pending = pendingLibraryCollapse;
  pendingLibraryCollapse = undefined;
  const doc = state.document;
  const graph = doc?.graphs.find((g) => g.id === pending?.graphId);
  if (!pending || !library || !doc || !graph) return;
  const result = edits.collapseToLibraryFunction(doc, graph, pending.nodeIds, lookupDefinition, newConnectionId, library.document, library.path);
  if (typeof result === 'string') {
    setStatus(result);
    return;
  }
  postToHost({ type: 'saveLibrary', library });
  // Until the host scans the saved library, its new node's pins come from the function itself.
  const call = libraryDefinitions(library.document, { documentPath: library.path, generatedPath: library.path, exports: { names: new Map([[result.function.id, result.function.name]]) } });
  state.definitions = [...state.definitions.filter((d) => d.type !== result.call.type), ...call];
  state.defByType.set(result.call.type, call[0]);
  state.selectedNodeIds = new Set([result.call.id]);
  state.selectedNodeId = result.call.id;
  markDirty();
  render();
  renderMyBlueprint();
  renderPalette();
  setStatus(`Collapsed into ${result.function.name} in ${library.document.name}. Open the library to name it.`);
}

// Unreal's Collapse to Macro: the selection becomes a new macro, used where it was.
export function collapseToMacro(): void {
  const doc = state.document;
  const graph = state.graph;
  if (!doc || !graph) return;
  const result = edits.collapseToMacro(doc, graph, new Set(state.selectedNodeIds), lookupDefinition, newConnectionId);
  if (typeof result === 'string') {
    setStatus(result);
    return;
  }
  state.selectedNodeIds = new Set([result.instance.id]);
  state.selectedNodeId = result.instance.id;
  markDirty();
  render();
  renderMyBlueprint();
  renderPalette();
  setStatus(`Collapsed into ${result.macro.name}. Name it in My Blueprint.`);
  startRename('graph', result.macro.id);
}

export function duplicateSelected(): void {
  if (!state.graph) return;
  const copies = editing.duplicateNodes(state.graph, state.selectedNodeIds, { x: 35, y: 35 }, (n) => editing.nodeIdFor(n.type), newConnectionId);
  if (!copies.length) return;
  state.selectedNodeIds = new Set(copies.map((n) => n.id));
  state.selectedNodeId = copies[0].id;
  markDirty();
  render();
  setStatus(`${copies.length} node${copies.length === 1 ? '' : 's'} duplicated`);
}

export function disconnectSelected(): void {
  if (!state.graph) return;
  if (editing.disconnectNodes(state.graph, state.selectedNodeIds)) {
    markDirty();
    render();
  }
}

export function removeConnection(connectionId: string): void {
  if (state.graph && editing.disconnectConnection(state.graph, connectionId)) {
    markDirty();
    renderEdges();
    setStatus('Connection removed.');
  }
}

function disconnectPin(nodeId: string, pinId: string): void {
  if (state.graph && editing.disconnectPin(state.graph, { node: nodeId, pin: pinId })) {
    markDirty();
    render();
    setStatus('Pin disconnected.');
  }
}

// Wires `source` to the first compatible pin of a node just created from the action menu.
export function connectNewNode(newNodeId: string, source: editing.PinAddress): void {
  const graph = state.graph;
  const sourceDef = pinDef(source.node, source.pin);
  const node = graph?.nodes.find((n) => n.id === newNodeId);
  if (!graph || !node || !sourceDef) return;
  const candidate = editing.matchingPin(editing.definitionFor(node, lookupDefinition), sourceDef);
  if (!candidate) return;
  const endpoints = sourceDef.direction === 'output'
    ? { fromNode: source.node, fromPin: source.pin, toNode: newNodeId, toPin: candidate.id }
    : { fromNode: newNodeId, fromPin: candidate.id, toNode: source.node, toPin: source.pin };
  editing.connect(graph, lookupDefinition, endpoints, newConnectionId());
  markDirty();
  render();
}

// Palette entries that could take a wire dragged out of the draft's pin.
export function compatibleEntriesForDraft(): PaletteEntry[] {
  const draft = state.draftConnection;
  const source = draft && pinDef(draft.node, draft.pin);
  return source ? paletteEntries().filter((entry) => editing.matchingPin(entry.definition, source)) : [];
}

export function completeConnection(targetNodeId: string, targetPinId: string): void {
  const draft = state.draftConnection;
  if (!draft || !state.graph) return;
  const plan = editing.planConnection(state.graph, lookupDefinition, { node: draft.node, pin: draft.pin }, { node: targetNodeId, pin: targetPinId });
  if (!plan) return;
  if (plan.convert) {
    // Unreal inserts a conversion node rather than refusing a bool or number → string wire.
    editing.connectThroughToString(state.graph, lookupDefinition, plan.endpoints, { node: editing.nodeIdFor(editing.TO_STRING), connections: [newConnectionId(), newConnectionId()] });
  } else {
    editing.connect(state.graph, lookupDefinition, plan.endpoints, newConnectionId());
  }
  markDirty();
  render();
  if (plan.convert) setStatus('Added a To String conversion.');
}

// Unreal's "Promote to Variable": a new variable of the pin's type, with a Get wired into an input
// pin or a Set wired from an output pin.
export function promoteToVariable(nodeId: string, pinId: string): void {
  const doc = state.document;
  const graph = state.graph;
  const pin = pinDef(nodeId, pinId);
  const node = graph?.nodes.find((n) => n.id === nodeId);
  if (!doc || !graph || !pin || !node || pin.kind !== 'data' || doc.kind !== 'class') return;
  const variable = addVariable(doc, pin.type ?? { id: 'any' });
  const name = uniqueName((pin.name || pin.id).replace(/[^A-Za-z0-9_]+/g, ''), doc.variables.filter((v) => v.id !== variable.id).map((v) => v.name));
  if (name) variable.name = name;
  if (pin.direction === 'input' && node.properties[`pin:${pinId}`] !== undefined) variable.defaultValue = node.properties[`pin:${pinId}`];
  const input = pin.direction === 'input';
  const placed = editing.createNode(input ? VARIABLE_GET : VARIABLE_SET, undefined, { x: node.position.x + (input ? -200 : 300), y: node.position.y + 60 }, editing.nodeIdFor('variable'), { variable: variable.id });
  graph.nodes.push(placed);
  editing.connect(graph, lookupDefinition, input
    ? { fromNode: placed.id, fromPin: 'value', toNode: nodeId, toPin: pinId }
    : { fromNode: nodeId, fromPin: pinId, toNode: placed.id, toPin: 'value' }, newConnectionId());
  markDirty();
  render();
  renderMyBlueprint();
  renderPalette();
  setStatus(`Promoted ${pin.name || pin.id} to variable ${variable.name}.`);
}

// Selection follows Unreal: click selects, Shift+click adds, Ctrl+click toggles.
export function onNodeMouseDown(node: GraphNode, e: MouseEvent): void {
  if (e.button !== 0) return;
  const target = eventElement(e);
  if (target?.closest('.pin') || target?.closest('input, select, textarea')) return;
  hideContextMenu();
  if (!e.shiftKey && !e.ctrlKey && !e.metaKey) clearCommentSelection();
  if (state.selectedVariableId) {
    state.selectedVariableId = null;
    renderMyBlueprint();
  }
  const toggle = e.ctrlKey || e.metaKey;
  if (toggle && state.selectedNodeIds.has(node.id)) {
    selectNode(node.id, true);
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  if (toggle || e.shiftKey) state.selectedNodeIds.add(node.id);
  else if (!state.selectedNodeIds.has(node.id)) state.selectedNodeIds = new Set([node.id]);
  state.selectedNodeId = node.id;
  syncSelectionClasses();
  renderInspector();
  beginNodeDrag(node, e);
  e.stopPropagation();
  e.preventDefault();
}

function beginNodeDrag(node: GraphNode, e: MouseEvent): void {
  if (!state.graph) return;
  const graph = state.graph;
  const p = screenToWorld(e.clientX, e.clientY);
  const ids = state.selectedNodeIds.has(node.id) ? [...state.selectedNodeIds] : [node.id];
  state.dragging = {
    originX: p.x,
    originY: p.y,
    items: ids
      .map((id) => graph.nodes.find((n) => n.id === id))
      .filter((n): n is GraphNode => !!n)
      .map((n) => ({ node: n, startX: n.position.x, startY: n.position.y })),
    moved: false
  };
}

// Ctrl+C / Ctrl+X: the selection as text (src/core/clipboard.ts).
export function copySelection(): string | undefined {
  if (!state.document || !state.graph) return undefined;
  return copyNodes(state.document, state.graph, state.selectedNodeIds);
}

// Ctrl+V: pastes copied nodes with their top-left corner at `at`. False when the text isn't nodes.
export function pasteText(text: string, at: Point): boolean {
  if (!state.document || !state.graph) return false;
  const variablesBefore = state.document.variables.length;
  const ids = pasteNodes(state.document, state.graph, text, at, { node: (type) => editing.nodeIdFor(type), connection: newConnectionId });
  if (!ids) return false;
  state.selectedNodeIds = new Set(ids);
  state.selectedNodeId = ids[0] ?? null;
  markDirty();
  render();
  if (state.document.variables.length !== variablesBefore) {
    renderMyBlueprint();
    renderPalette();
  }
  setStatus(`Pasted ${ids.length} node${ids.length === 1 ? '' : 's'}.`);
  return true;
}

export function insertRerouteAt(connectionId: string, clientX: number, clientY: number): void {
  if (!state.graph) return;
  const at = screenToWorld(clientX, clientY);
  const knot = editing.insertReroute(state.graph, lookupDefinition, connectionId, { x: at.x - 18, y: at.y - 9 },
    { node: editing.nodeIdFor('reroute'), connections: [newConnectionId(), newConnectionId()] });
  if (!knot) return;
  state.selectedNodeIds = new Set([knot.id]);
  state.selectedNodeId = knot.id;
  markDirty();
  render();
}

export function addPin(node: GraphNode): void {
  editing.addPin(node);
  markDirty();
  render();
}

// A pin's actions, as in Unreal: break its links, promote it, and remove it where pins can be
// removed. The node menu shows them above the node's own actions.
export function pinMenuItems(nodeId: string, pinId: string): MenuItem[] {
  const graph = state.graph;
  const node = graph?.nodes.find((n) => n.id === nodeId);
  const items: MenuItem[] = [];
  if (!graph || !node) return items;
  if (graph.connections.some((c) => (c.fromNode === nodeId && c.fromPin === pinId) || (c.toNode === nodeId && c.toPin === pinId))) {
    items.push({ label: 'Break Link(s)', action: () => disconnectPin(nodeId, pinId) });
  }
  const pin = pinDef(nodeId, pinId);
  // Unreal's Watch this value: the pin's value shows in a bubble whenever the debugger pauses.
  if (pin?.kind === 'data') {
    items.push({ label: isWatched(nodeId, pinId) ? 'Stop watching this value' : 'Watch this value', action: () => toggleWatch(nodeId, pinId) });
  }
  if (pin?.kind === 'data' && state.document?.kind === 'class') {
    items.push({ label: 'Promote to Variable', action: () => promoteToVariable(nodeId, pinId) });
  }
  // Unreal's Split Struct Pin and Recombine Struct Pin.
  const edit = (change: () => void) => () => {
    change();
    markDirty();
    render();
  };
  if (pin?.kind === 'data' && structInfo(pin.type, (type) => state.defByType.get(type))) {
    items.push({ label: 'Split Struct Pin', action: edit(() => editing.splitStructPin(graph, node, pinId)) });
  }
  if (pin?.split) {
    const whole = pin.split.pin;
    items.push({ label: 'Recombine Struct Pin', action: edit(() => editing.recombineStructPin(graph, node, whole)) });
  }
  const element = /^(item|key|value)\d+$/.test(pinId);
  if (editing.canAddPin(node) && (element || /^(then|out|case)\d+$/.test(pinId))) {
    items.push({
      label: element ? 'Remove Element Pin' : 'Remove Execution Pin',
      danger: true,
      action: () => {
        if (editing.removePin(graph, node, pinId)) {
          markDirty();
          render();
        } else setStatus(`${lookupDefinition(node)?.displayName ?? 'This node'} needs at least one ${element ? 'element' : 'output'}.`);
      }
    });
  }
  return items;
}

// Unreal's Refresh Node: updates project function nodes whose code changed to the new signature,
// and nodes of a package that changed major version to its new version (all of that package's
// nodes in the file: the graph records one version per package), keeping the wires that still fit.
// Without `nodeIds`, every such node in the file (Refresh All Nodes).
export function refreshFunctionNodes(nodeIds?: ReadonlySet<string>): void {
  const doc = state.document;
  if (!doc) return;
  let nodes = 0;
  let wires = 0;
  const packages = new Map<string, string>();
  for (const graph of doc.graphs) {
    for (const node of graph.nodes) {
      const change = libraryChange(doc, state.defByType.get(node.type));
      if (change && (!nodeIds || nodeIds.has(node.id))) packages.set(change.name, change.to);
    }
  }
  for (const graph of doc.graphs) {
    for (const node of graph.nodes) {
      const definition = state.defByType.get(node.type);
      if (definition?.library && packages.has(definition.library.name)) {
        wires += rebindFunctionNode(graph, node, definition, lookupDefinition).length;
        nodes++;
        continue;
      }
      if (!isFunctionType(node.type) || (nodeIds && !nodeIds.has(node.id))) continue;
      const status = functionStatus(doc.importedFunctions?.[node.type], state.defByType.get(node.type), () => state.definitions);
      if (status.state !== 'changed') continue;
      wires += rebind(graph, node, status.definition);
      nodes++;
    }
  }
  for (const [name, version] of packages) refreshLibrary(doc, name, version);
  if (!nodes) {
    setStatus('No nodes needed refreshing.');
    return;
  }
  markDirty();
  render();
  setStatus(`Refreshed ${nodes} node${nodes === 1 ? '' : 's'}${wires ? `; removed ${wires} wire${wires === 1 ? '' : 's'} that no longer fit` : ''}.`);
}

// Points a node whose project function is gone at the function it was renamed or moved to.
export function replaceFunctionNode(nodeId: string, replacement: NodeDefinition): void {
  const graph = state.graph;
  const node = graph?.nodes.find((n) => n.id === nodeId);
  if (!graph || !node) return;
  const wires = rebind(graph, node, replacement);
  markDirty();
  render();
  setStatus(`Replaced with ${replacement.displayName}${wires ? `; removed ${wires} wire${wires === 1 ? '' : 's'} that no longer fit` : ''}.`);
}

// Stores the new signature first, so the node (and the wire checks) use it.
function rebind(graph: NonNullable<typeof state.graph>, node: GraphNode, definition: NodeDefinition): number {
  const doc = state.document!;
  doc.importedFunctions = { ...(doc.importedFunctions ?? {}), [definition.type]: definition };
  return rebindFunctionNode(graph, node, definition, lookupDefinition).length;
}

// Arrow keys move the selection, as in Unreal.
export function moveSelection(dx: number, dy: number): void {
  if (!state.graph || !state.selectedNodeIds.size) return;
  for (const node of state.graph.nodes) {
    if (!state.selectedNodeIds.has(node.id)) continue;
    node.position.x += dx;
    node.position.y += dy;
  }
  markDirty();
  render();
}

export function onPinMouseDown(node: GraphNode, pin: PinDefinition, e: MouseEvent): void {
  if (e.button !== 0) return;
  // Do not preventDefault here: the window-level mousemove/mouseup listeners need the normal
  // mouse event sequence.
  e.stopPropagation();
  state.selectedNodeId = node.id;
  if (!state.selectedNodeIds.has(node.id)) state.selectedNodeIds = new Set([node.id]);
  syncSelectionClasses();
  hideContextMenu();

  if (e.altKey) {
    disconnectPin(node.id, pin.id);
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    beginMoveConnections(node.id, pin.id, e.clientX, e.clientY);
    return;
  }
  state.draftConnection = { node: node.id, pin: pin.id, kind: pin.kind, direction: pin.direction, startX: e.clientX, startY: e.clientY };
  renderEdges();
}

// Ctrl+drag from a pin picks up all of its wires, to drop them on another pin (Unreal's "move
// all connections").
function beginMoveConnections(nodeId: string, pinId: string, clientX: number, clientY: number): void {
  if (!state.graph || !pinDef(nodeId, pinId)) return;
  const isThisPin = (node: string, pin: string): boolean => node === nodeId && pin === pinId;
  const wires = state.graph.connections.filter((c) => isThisPin(c.fromNode, c.fromPin) || isThisPin(c.toNode, c.toPin));
  if (!wires.length) {
    setStatus('That pin has no connections to move.');
    return;
  }
  // A pin is either an output (its wires' "from" end) or an input (their "to" end).
  const side = isThisPin(wires[0].fromNode, wires[0].fromPin) ? 'from' : 'to';
  state.rewire = { connectionIds: wires.map((c) => c.id), side, startX: clientX, startY: clientY, dropRemoves: false };
  renderEdges({ x: clientX, y: clientY });
}

// Ctrl+click on a wire grabs the end nearest to the click.
export function beginRewireFromConnection(connectionId: string, clientX: number, clientY: number): void {
  const connection = state.graph?.connections.find((c) => c.id === connectionId);
  if (!connection) return;
  const source = pinElement(connection.fromNode, connection.fromPin);
  const target = pinElement(connection.toNode, connection.toPin);
  if (!source || !target) return;
  const rect = dom.canvasWrap.getBoundingClientRect();
  const a = centerOf(source, rect);
  const b = centerOf(target, rect);
  const click = screenPointToWorld({ x: clientX, y: clientY }, rect);
  const side = Math.hypot(click.x - a.x, click.y - a.y) <= Math.hypot(click.x - b.x, click.y - b.y) ? 'from' : 'to';
  state.rewire = { connectionIds: [connectionId], side, startX: clientX, startY: clientY, dropRemoves: true };
  renderEdges({ x: clientX, y: clientY });
}

// Dropping on a compatible pin moves the wires there. Dropping elsewhere removes a single grabbed
// wire, or leaves moved wires where they were.
export function finishRewire(e: MouseEvent): void {
  const rewire = state.rewire;
  state.rewire = null;
  if (!rewire || !state.graph) return;
  const targetPin = eventElement(e)?.closest<HTMLElement>('.pin');
  const target = targetPin && { node: targetPin.dataset.node ?? '', pin: targetPin.dataset.pin ?? '' };
  let moved = 0;
  if (target) {
    for (const id of rewire.connectionIds) {
      if (editing.rewire(state.graph, lookupDefinition, id, rewire.side, target)) moved++;
    }
  }
  if (moved) {
    markDirty();
    render();
  } else if (rewire.dropRemoves) {
    rewire.connectionIds.forEach(removeConnection);
  }
  renderEdges();
}
