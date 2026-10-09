// Webview entry point: wires DOM and host events to the editor modules.
import { HostMessage, RuntimeLogEvent } from '../core/model';
import { compatibleDefinitionsForDraft, completeConnection, deleteSelected, finishRewire } from './actions';
import { applySettings, flushSave, loadDocument, markDirty, setDefinitions } from './document';
import { dom, eventElement, nodeElement, setStatus } from './dom';
import { postToHost } from './host';
import { clampContextMenuToCanvas, hideContextMenu, showAddNodeMenu, showNodeContextMenu } from './menus';
import { renderPalette } from './panels';
import { render, renderEdges, scheduleRuntimePaint } from './render';
import { beginGroupSelection, finishGroupSelection, hideSelectionBox, selectAllNodes, selectNode, setPrimarySelection, updateGroupSelection } from './selection';
import { state } from './state';
import { applyTransform, fitGraph, screenToWorld, zoomAt } from './view';

const RUN_TRAIL_MS = 1500;

dom.runButton.addEventListener('click', () => postToHost({ type: 'runGraph' }));
dom.fitButton.addEventListener('click', fitGraph);
dom.search.addEventListener('input', renderPalette);

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      applySettings(message);
      setDefinitions(message.definitions ?? []);
      // No document means the file could not be parsed; editing stays disabled until it can.
      if (message.document) loadDocument(message.document);
      break;
    case 'documentChanged': {
      if (!message.document) break;
      const hadGraph = !!state.graph;
      const selected = new Set(state.selectedNodeIds);
      const primary = state.selectedNodeId;
      loadDocument(message.document, hadGraph);
      const graph = state.graph;
      if (hadGraph && graph) {
        const exists = (id: string | null): boolean => graph.nodes.some((n) => n.id === id);
        state.selectedNodeIds = new Set([...selected].filter(exists));
        state.selectedNodeId = exists(primary) ? primary : [...state.selectedNodeIds][0] ?? null;
        render();
      }
      break;
    }
    case 'definitions':
      setDefinitions(message.definitions ?? []);
      render();
      break;
    case 'settings':
      applySettings(message);
      break;
    case 'runtimeEvent':
      if (message.event) handleRuntimeEvent(message.event);
      break;
    case 'error':
      state.runActive = false;
      setStatus(message.message || 'Error');
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if (eventElement(e)?.matches('input, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedNodeIds.size) {
    deleteSelected();
    e.preventDefault();
  }
  if (mod && e.key.toLowerCase() === 'a') {
    selectAllNodes();
    e.preventDefault();
  }
  if (e.key === 'Escape') {
    hideContextMenu();
    state.draftConnection = null;
    state.rewire = null;
    state.selection = null;
    hideSelectionBox();
    renderEdges();
  }
  if (mod && e.key.toLowerCase() === 's') {
    flushSave();
    e.preventDefault();
  }
});

dom.canvasWrap.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const target = eventElement(e);
  if (target?.closest('#context-menu')) return;
  const nodeId = target?.closest<HTMLElement>('.node')?.dataset.node;
  if (nodeId) {
    if (!state.selectedNodeIds.has(nodeId)) selectNode(nodeId, false, true);
    else setPrimarySelection(nodeId);
    showNodeContextMenu(nodeId, e.clientX, e.clientY);
  } else {
    showAddNodeMenu(screenToWorld(e.clientX, e.clientY), e.clientX, e.clientY, state.definitions, 'Add Node');
  }
});

// Pins and nodes stop propagation, so this only sees presses on the background and wires.
dom.canvasWrap.addEventListener('mousedown', (e) => {
  const target = eventElement(e);
  if (target?.closest('#context-menu')) return;
  hideContextMenu();
  if (e.button === 1) {
    state.panning = { startX: e.clientX, startY: e.clientY, panX: state.pan.x, panY: state.pan.y };
    e.preventDefault();
    return;
  }
  if (e.button === 0 && !target?.closest('.node, .pin, .edge-hit')) beginGroupSelection(e);
});

window.addEventListener('mouseup', (e) => {
  state.panning = null;

  if (state.selection) {
    finishGroupSelection();
    return;
  }
  if (state.dragging) {
    const moved = state.dragging.moved;
    state.dragging = null;
    if (moved) markDirty();
    return;
  }
  if (state.rewire) {
    finishRewire(e);
    return;
  }
  const draft = state.draftConnection;
  if (draft) {
    const targetPin = eventElement(e)?.closest<HTMLElement>('.pin');
    if (targetPin) {
      completeConnection(targetPin.dataset.node ?? '', targetPin.dataset.pin ?? '');
    } else {
      // Released on empty space: offer nodes that can connect to the dragged pin.
      showAddNodeMenu(screenToWorld(e.clientX, e.clientY), e.clientX, e.clientY, compatibleDefinitionsForDraft(),
        'Add Connected Node', { node: draft.node, pin: draft.pin, kind: draft.kind });
    }
    state.draftConnection = null;
    renderEdges();
  }
});

window.addEventListener('mousemove', (e) => {
  if (state.panning) {
    state.pan.x = state.panning.panX + (e.clientX - state.panning.startX);
    state.pan.y = state.panning.panY + (e.clientY - state.panning.startY);
    applyTransform();
    renderEdges();
    return;
  }
  if (state.selection) {
    updateGroupSelection(e);
    return;
  }
  const drag = state.dragging;
  if (drag) {
    const p = screenToWorld(e.clientX, e.clientY);
    const dx = p.x - drag.originX;
    const dy = p.y - drag.originY;
    drag.moved = drag.moved || Math.abs(dx) > 1 || Math.abs(dy) > 1;
    for (const item of drag.items) {
      item.node.position.x = item.startX + dx;
      item.node.position.y = item.startY + dy;
      const el = nodeElement(item.node.id);
      if (el) {
        el.style.left = `${item.node.position.x}px`;
        el.style.top = `${item.node.position.y}px`;
      }
    }
    renderEdges();
    return;
  }
  if (state.rewire || state.draftConnection) renderEdges({ x: e.clientX, y: e.clientY });
});

dom.canvasWrap.addEventListener('wheel', (e) => {
  if (e.ctrlKey) return;
  zoomAt(e.clientX, e.clientY, e.deltaY <= 0);
  e.preventDefault();
}, { passive: false });

window.addEventListener('resize', () => {
  renderEdges();
  if (!dom.contextMenu.hidden) clampContextMenuToCanvas();
});

function handleRuntimeEvent(event: RuntimeLogEvent): void {
  if (!state.runActive) {
    // First event of a new run (which may have been started from another panel).
    state.runActive = true;
    clearTimeout(state.runtimeClearTimer);
    state.executedNodeIds.clear();
  }
  // Node ids are only unique within a graph, so only highlight events from the graph on screen.
  if (event.kind === 'node.enter' && event.nodeId && (!event.graphId || event.graphId === state.graph?.id)) state.executedNodeIds.add(event.nodeId);
  // A graph-level error (no nodeId) ends the run without a graph.complete event.
  if (event.kind === 'graph.complete' || (event.kind === 'error' && !event.nodeId)) {
    state.runActive = false;
    state.runtimeClearTimer = setTimeout(() => {
      state.executedNodeIds.clear();
      scheduleRuntimePaint();
    }, RUN_TRAIL_MS);
  }
  scheduleRuntimePaint();
  if (event.kind === 'log') setStatus(`Print: ${event.message}`);
  if (event.kind === 'error') setStatus(`Error: ${event.message}`);
  if (event.kind === 'graph.complete') setStatus('Run complete');
}

postToHost({ type: 'ready' });
