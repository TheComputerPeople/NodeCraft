// The canvas's context menus: the node-search "action menu", and the menus for a node, a pin
// (its pin actions above the node's) and a comment.
import { PinAddress, definitionFor } from '../core/editing';
import { PinKind } from '../core/model';
import { addNode, collapseToFunction, collapseToLibrary, collapseToMacro, connectNewNode, deleteSelected, disconnectSelected, duplicateSelected, refreshFunctionNodes, replaceFunctionNode } from './actions';
import { findReferences, goToDefinition, siteOf } from './navigation';
import { showPreview } from './preview';
import { alignSelection, distributeSelection, straightenConnections } from './align';
import { addBreakpoints, breakpointOn, enableBreakpoints, removeBreakpoints } from './breakpoints';
import { PaletteEntry, functionProblem, libraryProblem, lookupDefinition, paletteEntries, searchText } from './document';
import { dom, escapeHtml } from './dom';
import { headerColor } from './style';
import { deleteSelectedComments, selectedCommentIds, startCommentRename } from './comments';
import { MenuItem } from './floating-menu';
import { render } from './render';
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
  state.context = { kind: 'add-node', position, entries: unique, allEntries: paletteEntries(), title, source };
  // Unreal's "Context Sensitive" checkbox: when dragging from a pin, unchecking it shows every node.
  dom.contextMenu.innerHTML = `
      <div class="context-title"><span>${escapeHtml(title)}</span>${source ? `<label class="context-sensitive"><input type="checkbox" id="context-sensitive"${state.contextSensitive ? ' checked' : ''}> Context Sensitive</label>` : ''}</div>
      <input id="context-search" class="context-search" placeholder="Search nodes…" aria-label="Search nodes">
      <div id="context-results"></div>
      <div id="context-preview" class="node-preview" aria-live="polite" hidden></div>`;
  const toggle = dom.contextMenu.querySelector<HTMLInputElement>('#context-sensitive');
  toggle?.addEventListener('change', () => {
    state.contextSensitive = toggle.checked;
    renderContextNodeResults(dom.contextMenu.querySelector<HTMLInputElement>('#context-search')?.value ?? '');
  });
  dom.contextMenu.hidden = false;
  positionContextMenu(clientX, clientY);
  const input = dom.contextMenu.querySelector<HTMLInputElement>('#context-search')!;
  input.addEventListener('input', () => renderContextNodeResults(input.value));
  renderContextNodeResults('');
  // Deferred so the opening click does not steal focus back; skipped if the menu closed meanwhile.
  requestAnimationFrame(() => {
    if (!dom.contextMenu.hidden) input.focus();
  });
}

function renderContextNodeResults(query: string): void {
  const context = state.context;
  if (context?.kind !== 'add-node') return;
  const result = dom.contextMenu.querySelector<HTMLDivElement>('#context-results');
  if (!result) return;
  const q = query.trim().toLowerCase();
  const pool = context.source && !state.contextSensitive ? context.allEntries : context.entries;
  const entries = pool.filter((entry) => searchText(entry.definition).includes(q)).slice(0, MAX_RESULTS);
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
    const preview = dom.contextMenu.querySelector<HTMLElement>('#context-preview');
    if (preview) button.addEventListener('mouseenter', () => showPreview(preview, entry));
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const id = addNode(entry.type, context.position, entry.properties);
      if (id && context.source) connectNewNode(id, context.source);
      hideContextMenu();
    });
    result.appendChild(button);
  }
}

// A node's menu. Right-clicking a pin opens the same menu with that pin's actions on top, as in
// Unreal, so the menu always opens even when the pin itself has nothing to offer.
export function showNodeContextMenu(nodeId: string, clientX: number, clientY: number, pinItems: MenuItem[] | null = null): void {
  const node = state.graph?.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const def = definitionFor(node, lookupDefinition);
  const breakpoint = breakpointOn(nodeId);
  const pinSection = pinItems?.length
    ? `<div class="context-heading">Pin Actions</div>
      ${pinItems.map((item, i) => `<button data-pin-action="${i}"${item.danger ? ' class="context-danger"' : ''}>${escapeHtml(item.label)}</button>`).join('')}
      <div class="context-separator"></div>
      <div class="context-heading">Node Actions</div>`
    : '';
  // A project function whose code changed or is gone: Refresh Node, or Replace with a function it
  // was probably renamed or moved to.
  const status = functionProblem(node)?.status;
  // A node of a package that changed major version: Refresh Node, too.
  const functionItems: MenuItem[] = status?.state === 'changed' || libraryProblem(node)
    ? [{ label: 'Refresh Node', action: () => refreshFunctionNodes(new Set([nodeId])) }]
    : status?.state === 'missing'
      ? status.candidates.slice(0, 5).map((c) => ({ label: `Replace with ${c.displayName}${c.implementation?.kind === 'function' ? ` (${c.implementation.path})` : ''}`, action: () => replaceFunctionNode(nodeId, c) }))
      : [];
  dom.contextMenu.innerHTML = `
      <div class="context-title">${escapeHtml(def.displayName)}</div>
      ${pinSection}
      ${functionItems.map((item, i) => `<button data-function-action="${i}">${escapeHtml(item.label)}</button>`).join('')}
      ${siteOf(nodeId) ? '<button data-action="go-to-definition" title="F12">Go to Definition</button>' : ''}
      <button data-action="find-references" title="Shift+F12">Find References</button>
      <button data-action="duplicate">Duplicate</button>
      <button data-action="disconnect">Disconnect All Connections</button>
      <button data-action="select-connected">Select Connected Nodes</button>
      <button data-action="center">Center View</button>
      <button data-action="collapse-function">Collapse to Function</button>
      <button data-action="collapse-library">Collapse to Function in Library…</button>
      <button data-action="collapse-macro">Collapse to Macro</button>
      <div class="context-separator"></div>
      <div class="context-heading">Breakpoints</div>
      ${breakpoint
        ? `<button data-action="remove-breakpoint" title="F9">Remove Breakpoint</button>
      <button data-action="toggle-breakpoint-enabled">${breakpoint.enabled ? 'Disable' : 'Enable'} Breakpoint</button>`
        : '<button data-action="add-breakpoint" title="F9">Add Breakpoint</button>'}
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
    'go-to-definition': () => goToDefinition(nodeId),
    'find-references': () => findReferences(nodeId),
    duplicate: duplicateSelected,
    disconnect: disconnectSelected,
    'select-connected': () => selectConnected(nodeId),
    center: () => centerOnNode(nodeId),
    'collapse-function': collapseToFunction,
    'collapse-library': collapseToLibrary,
    'collapse-macro': collapseToMacro,
    'add-breakpoint': () => addBreakpoints([nodeId]),
    'remove-breakpoint': () => removeBreakpoints([nodeId]),
    'toggle-breakpoint-enabled': () => enableBreakpoints([nodeId], !breakpoint?.enabled),
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
  dom.contextMenu.querySelectorAll<HTMLButtonElement>('button[data-function-action]').forEach((button) => {
    button.addEventListener('click', () => {
      hideContextMenu();
      functionItems[Number(button.dataset.functionAction)]?.action();
    });
  });
  dom.contextMenu.querySelectorAll<HTMLButtonElement>('button[data-pin-action]').forEach((button) => {
    button.addEventListener('click', () => {
      hideContextMenu();
      pinItems?.[Number(button.dataset.pinAction)]?.action();
    });
  });
}

// A comment's menu, from its title bar. (Unreal sets a comment's color in Details.)
export function showCommentContextMenu(commentId: string, clientX: number, clientY: number): void {
  const comment = state.graph?.comments.find((c) => c.id === commentId);
  if (!comment) return;
  if (!selectedCommentIds.has(commentId)) {
    selectedCommentIds.clear();
    selectedCommentIds.add(commentId);
    state.selectedNodeIds.clear();
    state.selectedNodeId = null;
    render();
  }
  dom.contextMenu.innerHTML = `
      <div class="context-title">${escapeHtml(comment.text)}</div>
      <button data-action="rename" title="F2">Rename</button>
      <div class="context-separator"></div>
      <button data-action="delete" class="context-danger">Delete Comment</button>`;
  state.context = { kind: 'comment', commentId };
  dom.contextMenu.hidden = false;
  positionContextMenu(clientX, clientY);
  const actions: Record<string, () => void> = {
    rename: () => startCommentRename(commentId),
    delete: () => deleteSelectedComments()
  };
  dom.contextMenu.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      hideContextMenu();
      actions[button.dataset.action ?? '']?.();
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
  // A hidden field keeps focus until the next layout; release it now so the very next key press
  // reaches the graph's shortcuts.
  if (dom.contextMenu.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  dom.contextMenu.hidden = true;
  state.context = null;
}
