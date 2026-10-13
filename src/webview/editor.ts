// Webview entry point: wires DOM and host events to the editor modules.
import { HostMessage, RuntimeLogEvent } from '../core/model';
import { addNode, compatibleEntriesForDraft, completeConnection, deleteSelected, duplicateSelected, finishRewire, moveSelection } from './actions';
import { hideResults, markCompiling, renderCompileButton, renderLanguagePicker, setLanguage, showCompileResult } from './compile-results';
import { applySettings, flushSave, loadDocument, markDirty, paletteEntries, setDefinitions } from './document';
import { dom, eventElement, nodeElement, setStatus } from './dom';
import { postToHost } from './host';
import { clampContextMenuToCanvas, hideContextMenu, showAddNodeMenu, showNodeContextMenu } from './menus';
import { renderPalette } from './panels';
import { render, renderEdges, scheduleRuntimePaint } from './render';
import { beginGroupSelection, finishGroupSelection, hideSelectionBox, selectAllNodes, selectNode, setPrimarySelection, updateGroupSelection } from './selection';
import { state } from './state';
import { applyTransform, fitGraph, screenToWorld, zoomAt } from './view';

const RUN_TRAIL_MS = 1500;

// Nodes placed by holding a key and clicking the canvas, as in Unreal (P places BeginPlay, which
// is our Start event). C, for comments, arrives with comment boxes.
const PLACEMENT_KEYS: Record<string, string> = { b: 'core:flow.branch', s: 'core:flow.sequence', p: 'core:event.start' };
// Distance, in world units, that an arrow key moves the selection.
const NUDGE = 16;

// Each action first sends pending edits, so the host works on what is on screen.
function compileNow(): void {
  flushSave();
  markCompiling();
  postToHost({ type: 'compile' });
}

dom.compileButton.addEventListener('click', compileNow);
dom.runButton.addEventListener('click', () => {
  flushSave();
  setStatus('Compiling…');
  postToHost({ type: 'run' });
});
dom.simulateButton.addEventListener('click', () => {
  flushSave();
  postToHost({ type: 'simulate' });
});
dom.languageSelect.addEventListener('change', () => setLanguage(dom.languageSelect.value));
dom.resultsClose.addEventListener('click', hideResults);
dom.fitButton.addEventListener('click', () => fitGraph());
renderCompileButton();
dom.search.addEventListener('input', renderPalette);

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      applySettings(message);
      state.languages = message.languages ?? [];
      setDefinitions(message.definitions ?? []);
      // No document means the file could not be parsed; editing stays disabled until it can.
      if (message.document) loadDocument(message.document);
      else renderLanguagePicker();
      if (message.compile) showCompileResult(message.compile);
      break;
    case 'compileResult':
      if (message.compile) showCompileResult(message.compile);
      break;
    case 'runStatus':
      if (message.run) setStatus(message.run.message);
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

// Keyboard shortcuts follow Unreal's Blueprint editor (docs/unreal-conventions.md).
document.addEventListener('keydown', (e) => {
  if (eventElement(e)?.matches('input, textarea, select')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedNodeIds.size) {
    deleteSelected();
    e.preventDefault();
  } else if (mod && key === 'a') {
    selectAllNodes();
    e.preventDefault();
  } else if (mod && key === 'd') {
    duplicateSelected();
    e.preventDefault();
  } else if (mod && key === 's') {
    flushSave();
    e.preventDefault();
  } else if (e.key === 'F7') {
    compileNow();
    e.preventDefault();
  } else if (e.key === 'Home') {
    fitGraph(true);
    e.preventDefault();
  } else if (e.key.startsWith('Arrow') && state.selectedNodeIds.size && !mod) {
    const [dx, dy] = { ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0], ArrowUp: [0, -NUDGE], ArrowDown: [0, NUDGE] }[e.key] ?? [0, 0];
    moveSelection(dx, dy);
    e.preventDefault();
  } else if (e.key === 'Escape') {
    hideContextMenu();
    state.draftConnection = null;
    state.rewire = null;
    state.selection = null;
    hideSelectionBox();
    renderEdges();
  } else if (!mod && !e.altKey && PLACEMENT_KEYS[key]) {
    state.heldKey = key;
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key.toLowerCase() === state.heldKey) state.heldKey = null;
});
window.addEventListener('blur', () => {
  state.heldKey = null;
});

// Right-click menus open on release, so a right-drag can pan instead (as in Unreal).
dom.canvasWrap.addEventListener('contextmenu', (e) => e.preventDefault());

function openContextMenu(nodeId: string | null, clientX: number, clientY: number): void {
  if (nodeId) {
    if (!state.selectedNodeIds.has(nodeId)) selectNode(nodeId, false, true);
    else setPrimarySelection(nodeId);
    showNodeContextMenu(nodeId, clientX, clientY);
  } else {
    showAddNodeMenu(screenToWorld(clientX, clientY), clientX, clientY, paletteEntries(), 'Add Node');
  }
}

// Pins and nodes stop propagation of left presses, so a left press here is on the background.
dom.canvasWrap.addEventListener('mousedown', (e) => {
  const target = eventElement(e);
  if (target?.closest('#context-menu')) return;
  hideContextMenu();
  if (e.button === 1 || e.button === 2) {
    const nodeId = target?.closest<HTMLElement>('.node')?.dataset.node ?? null;
    state.panning = { startX: e.clientX, startY: e.clientY, panX: state.pan.x, panY: state.pan.y, button: e.button, moved: false, nodeId };
    e.preventDefault();
    return;
  }
  if (e.button !== 0 || target?.closest('.node, .pin, .edge-hit')) return;
  const placed = state.heldKey && PLACEMENT_KEYS[state.heldKey];
  if (placed) {
    addNode(placed, screenToWorld(e.clientX, e.clientY));
    e.preventDefault();
    return;
  }
  beginGroupSelection(e);
});

window.addEventListener('mouseup', (e) => {
  const panning = state.panning;
  if (panning) {
    state.panning = null;
    if (panning.button === 2 && !panning.moved && e.button === 2) openContextMenu(panning.nodeId, e.clientX, e.clientY);
    return;
  }

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
      showAddNodeMenu(screenToWorld(e.clientX, e.clientY), e.clientX, e.clientY, compatibleEntriesForDraft(),
        'Add Connected Node', { node: draft.node, pin: draft.pin, kind: draft.kind });
    }
    state.draftConnection = null;
    renderEdges();
  }
});

window.addEventListener('mousemove', (e) => {
  const panning = state.panning;
  if (panning) {
    const dx = e.clientX - panning.startX;
    const dy = e.clientY - panning.startY;
    // A small wobble during a right-click still counts as a click.
    if (!panning.moved && Math.hypot(dx, dy) < 4) return;
    panning.moved = true;
    state.pan.x = panning.panX + dx;
    state.pan.y = panning.panY + dy;
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
