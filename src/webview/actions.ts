// User actions that change the graph, plus the pointer gestures that lead to them.
import * as editing from '../core/editing';
import { GraphNode, PinDefinition } from '../core/model';
import { lookupDefinition, markDirty, pinDef } from './document';
import { dom, eventElement, pinElement, setStatus } from './dom';
import { newConnectionId } from './host';
import { hideContextMenu } from './menus';
import { renderInspector } from './panels';
import { render, renderEdges, syncSelectionClasses } from './render';
import { selectNode } from './selection';
import { Point, state } from './state';
import { centerOf, screenPointToWorld, screenToWorld } from './view';

export function addNode(type: string, position: Point): string | null {
  if (!state.graph) return null;
  const node = editing.createNode(type, lookupDefinition(type), position, editing.nodeIdFor(type));
  state.graph.nodes.push(node);
  state.selectedNodeIds = new Set([node.id]);
  state.selectedNodeId = node.id;
  markDirty();
  render();
  return node.id;
}

export function deleteSelected(): void {
  if (!state.graph || !state.selectedNodeIds.size) return;
  editing.deleteNodes(state.graph, new Set(state.selectedNodeIds));
  state.selectedNodeIds.clear();
  state.selectedNodeId = null;
  markDirty();
  render();
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
  editing.connect(graph, endpoints, newConnectionId());
  markDirty();
  render();
}

export function compatibleDefinitionsForDraft(): ReturnType<typeof editing.compatibleDefinitions> {
  const draft = state.draftConnection;
  const source = draft && pinDef(draft.node, draft.pin);
  return source ? editing.compatibleDefinitions(state.definitions, source) : [];
}

export function completeConnection(targetNodeId: string, targetPinId: string): void {
  const draft = state.draftConnection;
  if (!draft || !state.graph) return;
  const endpoints = editing.resolveConnection(state.graph, lookupDefinition, { node: draft.node, pin: draft.pin }, { node: targetNodeId, pin: targetPinId });
  if (!endpoints) return;
  editing.connect(state.graph, endpoints, newConnectionId());
  markDirty();
  render();
}

export function onNodeMouseDown(node: GraphNode, e: MouseEvent): void {
  if (e.button !== 0) return;
  const target = eventElement(e);
  if (target?.closest('.pin') || target?.closest('input')) return;
  hideContextMenu();
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (additive && state.selectedNodeIds.has(node.id)) {
    // Modifier-click on a selected node removes it from the selection; no drag starts.
    selectNode(node.id, true);
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  if (additive) state.selectedNodeIds.add(node.id);
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
    beginRewireFromPin(node.id, pin.id, e.clientX, e.clientY);
    return;
  }
  state.draftConnection = { node: node.id, pin: pin.id, kind: pin.kind, direction: pin.direction, startX: e.clientX, startY: e.clientY };
  renderEdges();
}

function beginRewireFromPin(nodeId: string, pinId: string, clientX: number, clientY: number): void {
  if (!state.graph || !pinDef(nodeId, pinId)) return;
  const isThisPin = (node: string, pin: string): boolean => node === nodeId && pin === pinId;
  const candidates = state.graph.connections.filter((c) => isThisPin(c.fromNode, c.fromPin) || isThisPin(c.toNode, c.toPin));
  if (!candidates.length) {
    setStatus('That pin has no connection to rewire.');
    return;
  }
  // With several wires on the pin, grab the one whose far end is closest to the cursor.
  let selected = candidates[0];
  let bestDistance = Infinity;
  for (const c of candidates) {
    const opposite = isThisPin(c.fromNode, c.fromPin) ? pinElement(c.toNode, c.toPin) : pinElement(c.fromNode, c.fromPin);
    const r = opposite?.getBoundingClientRect();
    if (!r) continue;
    const d = Math.hypot(r.left + r.width / 2 - clientX, r.top + r.height / 2 - clientY);
    if (d < bestDistance) {
      bestDistance = d;
      selected = c;
    }
  }
  const side = isThisPin(selected.fromNode, selected.fromPin) ? 'from' : 'to';
  state.rewire = { connectionId: selected.id, side, startX: clientX, startY: clientY };
  renderEdges({ x: clientX, y: clientY });
}

// Grabs the end of the wire nearest to where it was clicked.
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
  state.rewire = { connectionId, side, startX: clientX, startY: clientY };
  renderEdges({ x: clientX, y: clientY });
}

// Releasing off a pin, or on an incompatible one, removes the connection (as in Unreal).
export function finishRewire(e: MouseEvent): void {
  const rewire = state.rewire;
  if (!rewire || !state.graph) return;
  const targetPin = eventElement(e)?.closest<HTMLElement>('.pin');
  const target = targetPin && { node: targetPin.dataset.node ?? '', pin: targetPin.dataset.pin ?? '' };
  if (target && editing.rewire(state.graph, lookupDefinition, rewire.connectionId, rewire.side, target)) {
    markDirty();
    render();
  } else {
    removeConnection(rewire.connectionId);
  }
  state.rewire = null;
  renderEdges();
}
