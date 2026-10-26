// Breakpoints on nodes (docs/debugging.md, "Breakpoints"). The host keeps them in the workspace's
// state, not in the graph file; the editor draws them and changes them with F9 and the node menu.
import { GraphBreakpoint } from '../core/model';
import { setStatus } from './dom';
import { postToHost } from './host';
import { render } from './render';
import { state } from './state';

// The breakpoint on a node of the graph on the canvas, if any.
export function breakpointOn(nodeId: string): GraphBreakpoint | undefined {
  const graphId = state.graph?.id;
  return state.breakpoints.find((b) => b.graphId === graphId && b.nodeId === nodeId);
}

// The host's copy changed (another panel of the file, or the echo of ours).
export function setBreakpoints(breakpoints: GraphBreakpoint[]): void {
  state.breakpoints = breakpoints;
  render();
}

function update(breakpoints: GraphBreakpoint[]): void {
  state.breakpoints = breakpoints;
  postToHost({ type: 'setBreakpoints', breakpoints });
  render();
}

// F9: toggles the selected nodes' breakpoints, as in Unreal. A mixed selection gains breakpoints
// on the nodes without one, so pressing F9 again removes them all.
export function toggleSelectedBreakpoints(): void {
  const graphId = state.graph?.id;
  const nodeIds = [...state.selectedNodeIds];
  if (!graphId || !nodeIds.length) {
    setStatus('Select a node to toggle its breakpoint.');
    return;
  }
  if (nodeIds.every((id) => breakpointOn(id))) removeBreakpoints(nodeIds);
  else addBreakpoints(nodeIds.filter((id) => !breakpointOn(id)));
}

export function addBreakpoints(nodeIds: string[]): void {
  const graphId = state.graph?.id;
  if (!graphId) return;
  update([...state.breakpoints, ...nodeIds.map((nodeId) => ({ graphId, nodeId, enabled: true }))]);
}

export function removeBreakpoints(nodeIds: string[]): void {
  const graphId = state.graph?.id;
  update(state.breakpoints.filter((b) => b.graphId !== graphId || !nodeIds.includes(b.nodeId)));
}

export function enableBreakpoints(nodeIds: string[], enabled: boolean): void {
  const graphId = state.graph?.id;
  update(state.breakpoints.map((b) => (b.graphId === graphId && nodeIds.includes(b.nodeId) ? { ...b, enabled } : b)));
}

// Ctrl+Shift+F9 (Unreal's Delete All Breakpoints): every breakpoint in the file, in every graph.
export function clearBreakpoints(): void {
  if (!state.breakpoints.length) {
    setStatus('No breakpoints to remove.');
    return;
  }
  const count = state.breakpoints.length;
  update([]);
  setStatus(`Removed ${count} breakpoint${count === 1 ? '' : 's'}.`);
}

// Drops breakpoints whose node or graph is gone (deleted, or removed by an edit outside the editor).
export function pruneBreakpoints(): void {
  const document = state.document;
  if (!document || !state.breakpoints.length) return;
  const nodes = new Map(document.graphs.map((g) => [g.id, new Set(g.nodes.map((n) => n.id))]));
  const kept = state.breakpoints.filter((b) => nodes.get(b.graphId)?.has(b.nodeId));
  if (kept.length !== state.breakpoints.length) {
    state.breakpoints = kept;
    postToHost({ type: 'setBreakpoints', breakpoints: kept });
  }
}
