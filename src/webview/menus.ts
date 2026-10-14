// The floating context menu: the node-search "action menu" and per-node actions.
import { PinAddress, definitionFor } from '../core/editing';
import { PinKind } from '../core/model';
import { addNode, connectNewNode, deleteSelected, disconnectSelected, duplicateSelected } from './actions';
import { alignSelection, distributeSelection, straightenConnections } from './align';
import { PaletteEntry, lookupDefinition, searchText } from './document';
import { dom, escapeHtml } from './dom';
import { headerColor } from './style';
import { selectConnected } from './selection';
import { Point, state } from './state';
import { centerOnNode } from './view';

const MAX_RESULTS = 18;

export function showAddNodeMenu(
  position: Point,
  clientX: number,
  clientY: number,
  entries: PaletteEntry[],
  title: string,
  source: (PinAddress & { kind: PinKind }) | null = null
): void {
  if (!state.graph) return;
  const unique = [...new Map(entries.map((entry) => [entry.key, entry])).values()];
  if (!unique.length) return;
  state.context = { kind: 'add-node', position, entries: unique, title, source };
  dom.contextMenu.innerHTML = `
      <div class="context-title">${escapeHtml(title)}</div>
      <input id="context-search" class="context-search" placeholder="Search nodes…" aria-label="Search nodes">
      <div id="context-results"></div>`;
  dom.contextMenu.hidden = false;
  positionContextMenu(clientX, clientY);
  const input = dom.contextMenu.querySelector<HTMLInputElement>('#context-search')!;
  input.addEventListener('input', () => renderContextNodeResults(input.value));
  renderContextNodeResults('');
  requestAnimationFrame(() => input.focus());
}

function renderContextNodeResults(query: string): void {
  const context = state.context;
  if (context?.kind !== 'add-node') return;
  const result = dom.contextMenu.querySelector<HTMLDivElement>('#context-results');
  if (!result) return;
  const q = query.trim().toLowerCase();
  const entries = context.entries.filter((entry) => searchText(entry.definition).includes(q)).slice(0, MAX_RESULTS);
  result.innerHTML = '';
  if (!entries.length) {
    result.innerHTML = '<div class="context-empty">No matching nodes</div>';
    return;
  }
  for (const entry of entries) {
    const def = entry.definition;
    const button = document.createElement('button');
    button.className = 'context-node';
    button.innerHTML = `<span class="palette-dot" style="--node-color:${escapeHtml(headerColor(def))}"></span><span><strong>${escapeHtml(def.displayName)}</strong><small>${escapeHtml(def.category)}</small></span>`;
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const id = addNode(entry.type, context.position, entry.properties);
      if (id && context.source) connectNewNode(id, context.source);
      hideContextMenu();
    });
    result.appendChild(button);
  }
}

export function showNodeContextMenu(nodeId: string, clientX: number, clientY: number): void {
  const node = state.graph?.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const def = definitionFor(node, lookupDefinition);
  dom.contextMenu.innerHTML = `
      <div class="context-title">${escapeHtml(def.displayName)}</div>
      <button data-action="duplicate">Duplicate</button>
      <button data-action="disconnect">Disconnect All Connections</button>
      <button data-action="select-connected">Select Connected Nodes</button>
      <button data-action="center">Center View</button>
      <div class="context-separator"></div>
      <div class="context-heading">Alignment</div>
      <button data-action="straighten" title="Q">Straighten Connections</button>
      <button data-action="align-top" title="Shift+W">Align Top</button>
      <button data-action="align-middle">Align Middle</button>
      <button data-action="align-bottom" title="Shift+S">Align Bottom</button>
      <button data-action="align-left" title="Shift+A">Align Left</button>
      <button data-action="align-center">Align Center</button>
      <button data-action="align-right" title="Shift+D">Align Right</button>
      <button data-action="distribute-horizontal">Distribute Horizontally</button>
      <button data-action="distribute-vertical">Distribute Vertically</button>
      <div class="context-separator"></div>
      <button data-action="delete" class="context-danger">Delete Node</button>`;
  state.context = { kind: 'node', nodeId };
  dom.contextMenu.hidden = false;
  positionContextMenu(clientX, clientY);
  const actions: Record<string, () => void> = {
    duplicate: duplicateSelected,
    disconnect: disconnectSelected,
    'select-connected': () => selectConnected(nodeId),
    center: () => centerOnNode(nodeId),
    delete: deleteSelected,
    straighten: straightenConnections,
    'align-top': () => alignSelection('top'),
    'align-middle': () => alignSelection('middle'),
    'align-bottom': () => alignSelection('bottom'),
    'align-left': () => alignSelection('left'),
    'align-center': () => alignSelection('center'),
    'align-right': () => alignSelection('right'),
    'distribute-horizontal': () => distributeSelection('horizontal'),
    'distribute-vertical': () => distributeSelection('vertical')
  };
  dom.contextMenu.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      actions[button.dataset.action ?? '']?.();
      hideContextMenu();
    });
  });
}

function positionContextMenu(clientX: number, clientY: number): void {
  const rect = dom.canvasWrap.getBoundingClientRect();
  dom.contextMenu.style.left = `${Math.max(4, clientX - rect.left)}px`;
  dom.contextMenu.style.top = `${Math.max(4, clientY - rect.top)}px`;
  requestAnimationFrame(clampContextMenuToCanvas);
}

export function clampContextMenuToCanvas(): void {
  const rect = dom.canvasWrap.getBoundingClientRect();
  const menu = dom.contextMenu.getBoundingClientRect();
  const currentLeft = parseFloat(dom.contextMenu.style.left || '0');
  const currentTop = parseFloat(dom.contextMenu.style.top || '0');
  dom.contextMenu.style.left = `${Math.min(currentLeft, Math.max(4, rect.width - menu.width - 4))}px`;
  dom.contextMenu.style.top = `${Math.min(currentTop, Math.max(4, rect.height - menu.height - 4))}px`;
}

export function hideContextMenu(): void {
  dom.contextMenu.hidden = true;
  state.context = null;
}
