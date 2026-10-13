import { connectedNodeIds } from '../core/editing';
import { clearCommentSelection } from './comments';
import { dom, nodeElement, setStatus } from './dom';
import { renderInspector } from './panels';
import { syncSelectionClasses } from './render';
import { SelectionMode, state } from './state';

function refreshSelection(): void {
  syncSelectionClasses();
  renderInspector();
}

// `additive` toggles the node; otherwise it becomes the only selected node. `primary` makes it
// the node shown in the Details panel.
export function selectNode(nodeId: string, additive = false, primary = false): void {
  if (additive) {
    if (state.selectedNodeIds.has(nodeId)) state.selectedNodeIds.delete(nodeId);
    else state.selectedNodeIds.add(nodeId);
  } else {
    state.selectedNodeIds = new Set([nodeId]);
  }
  if (primary || !state.selectedNodeId || !state.selectedNodeIds.has(state.selectedNodeId)) state.selectedNodeId = nodeId;
  if (!state.selectedNodeIds.size) state.selectedNodeId = null;
  refreshSelection();
}

export function setPrimarySelection(nodeId: string): void {
  state.selectedNodeId = nodeId;
  refreshSelection();
}

export function selectAllNodes(): void {
  state.selectedNodeIds = new Set(state.graph?.nodes.map((n) => n.id) ?? []);
  state.selectedNodeId = [...state.selectedNodeIds][0] ?? null;
  refreshSelection();
}

export function selectConnected(startNodeId: string): void {
  if (!state.graph) return;
  const selected = connectedNodeIds(state.graph, startNodeId);
  state.selectedNodeIds = selected;
  state.selectedNodeId = startNodeId;
  refreshSelection();
  setStatus(`${selected.size} connected node${selected.size === 1 ? '' : 's'} selected`);
}

export function beginGroupSelection(e: MouseEvent): void {
  if (!state.graph) return;
  if (!e.shiftKey && !e.ctrlKey && !e.metaKey) clearCommentSelection();
  state.draftConnection = null;
  state.rewire = null;
  // Unreal: drag replaces the selection, Shift+drag adds to it, Ctrl+drag removes from it.
  const mode: SelectionMode = e.ctrlKey || e.metaKey ? 'remove' : e.shiftKey ? 'add' : 'replace';
  const base = mode === 'replace' ? new Set<string>() : new Set(state.selectedNodeIds);
  if (mode === 'replace') {
    state.selectedNodeIds.clear();
    state.selectedNodeId = null;
    syncSelectionClasses();
  }
  state.selection = { startX: e.clientX, startY: e.clientY, mode, base, moved: false };
  updateSelectionBox(e.clientX, e.clientY);
  e.preventDefault();
}

export function updateGroupSelection(e: MouseEvent): void {
  const selection = state.selection;
  if (!selection || !state.graph) return;
  const moved = Math.abs(e.clientX - selection.startX) > 3 || Math.abs(e.clientY - selection.startY) > 3;
  selection.moved = moved;
  updateSelectionBox(e.clientX, e.clientY);
  if (!moved) return;

  const box = {
    left: Math.min(selection.startX, e.clientX), top: Math.min(selection.startY, e.clientY),
    right: Math.max(selection.startX, e.clientX), bottom: Math.max(selection.startY, e.clientY)
  };
  const hits = new Set<string>();
  for (const node of state.graph.nodes) {
    const r = nodeElement(node.id)?.getBoundingClientRect();
    if (r && box.left <= r.right && box.right >= r.left && box.top <= r.bottom && box.bottom >= r.top) hits.add(node.id);
  }
  state.selectedNodeIds = selection.mode === 'add' ? new Set([...selection.base, ...hits])
    : selection.mode === 'remove' ? new Set([...selection.base].filter((id) => !hits.has(id)))
    : hits;
  if (!state.selectedNodeId || !state.selectedNodeIds.has(state.selectedNodeId)) state.selectedNodeId = [...state.selectedNodeIds][0] ?? null;
  refreshSelection();
}

export function finishGroupSelection(): void {
  if (!state.selection) return;
  hideSelectionBox();
  const moved = state.selection.moved;
  state.selection = null;
  if (!moved) renderInspector();
  else setStatus(`${state.selectedNodeIds.size} node${state.selectedNodeIds.size === 1 ? '' : 's'} selected`);
}

function updateSelectionBox(endX: number, endY: number): void {
  if (!state.selection) return;
  const rect = dom.canvasWrap.getBoundingClientRect();
  const box = dom.selectionBox;
  box.hidden = false;
  box.style.left = `${Math.min(state.selection.startX, endX) - rect.left}px`;
  box.style.top = `${Math.min(state.selection.startY, endY) - rect.top}px`;
  box.style.width = `${Math.abs(endX - state.selection.startX)}px`;
  box.style.height = `${Math.abs(endY - state.selection.startY)}px`;
}

export function hideSelectionBox(): void {
  dom.selectionBox.hidden = true;
}
