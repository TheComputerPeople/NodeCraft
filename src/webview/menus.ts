// The canvas's context menus: the node-search "action menu", and the menus for a node, a pin
// (its pin actions above the node's) and a comment.
import * as editing from '../core/editing';
import { PinAddress, definitionFor } from '../core/editing';
import { PinKind } from '../core/model';
import { addNode, collapseToFunction, collapseToLibrary, collapseToMacro, connectNewNode, connectPins, deleteSelected, disconnectSelected, duplicateSelected, pinMenuItems, refreshFunctionNodes, replaceFunctionNode } from './actions';
import { findReferences, goToDefinition, siteOf } from './navigation';
import { showPreview } from './preview';
import { alignSelection, distributeSelection, straightenConnections } from './align';
import { addBreakpoints, breakpointOn, enableBreakpoints, removeBreakpoints } from './breakpoints';
import { PaletteEntry, functionProblem, libraryProblem, lookupDefinition, paletteEntries, searchText } from './document';
import { dom, escapeHtml, setStatus } from './dom';
import { nodeTitle, pinName } from './keyboard';
import { headerColor } from './style';
import { deleteSelectedComments, selectedCommentIds, startCommentRename } from './comments';
import { MenuItem } from './floating-menu';
import { render } from './render';
import { selectConnected } from './selection';
import { Point, state } from './state';
import { centerOnNode, screenToWorld } from './view';

const MAX_RESULTS = 18;
// The Add Node menu's result the arrow keys are on, which Enter adds (docs/release.md, step 6).
let activeResult = 0;

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
      <input id="context-search" class="context-search" placeholder="Search nodes…" aria-label="Search nodes" role="combobox" aria-expanded="true" aria-controls="context-results" aria-autocomplete="list">
      <div id="context-results" role="listbox" aria-label="Nodes"></div>
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
  // The arrow keys move through the results, Enter adds the one they're on (the first, until they
  // move), and Escape closes the menu.
  input.addEventListener('keydown', (e) => {
    const options = [...dom.contextMenu.querySelectorAll<HTMLElement>('[role="option"]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp') {
      if (!options.length) return;
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? 5 : -5;
      setActiveResult(Math.max(0, Math.min(options.length - 1, activeResult + step)));
      e.preventDefault();
    } else if (e.key === 'Enter') {
      options[activeResult]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      e.preventDefault();
    } else if (e.key === 'Escape') {
      hideContextMenu();
      e.preventDefault();
    }
  });
  renderContextNodeResults('');
  // At once, so keys typed straight after opening it from the keyboard land in it; and again after
  // the opening click, which would otherwise take focus back (skipped if the menu closed meanwhile).
  input.focus();
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
  activeResult = 0;
  if (!entries.length) {
    result.innerHTML = '<div class="context-empty" role="presentation">No matching nodes</div>';
    dom.contextMenu.querySelector('#context-search')?.removeAttribute('aria-activedescendant');
    return;
  }
  entries.forEach((entry, i) => {
    const def = entry.definition;
    const button = document.createElement('button');
    button.className = 'context-node';
    button.id = `context-option-${i}`;
    button.setAttribute('role', 'option');
    button.tabIndex = -1;
    button.innerHTML = `<span class="palette-dot" style="--node-color:${escapeHtml(headerColor(def))}"></span><span><strong>${escapeHtml(def.displayName)}</strong><small>${escapeHtml(def.category)}</small></span>`;
    button.addEventListener('mouseenter', () => setActiveResult(i, false));
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const id = addNode(entry.type, context.position, entry.properties);
      if (id && context.source) connectNewNode(id, context.source);
      hideContextMenu();
    });
    result.appendChild(button);
  });
  setActiveResult(0, false);
}

// Marks a result as the one Enter adds, shows its code, and (from the keyboard) scrolls to it.
function setActiveResult(index: number, scroll = true): void {
  const context = state.context;
  const options = [...dom.contextMenu.querySelectorAll<HTMLElement>('[role="option"]')];
  if (context?.kind !== 'add-node' || !options[index]) return;
  activeResult = index;
  options.forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
  dom.contextMenu.querySelector('#context-search')?.setAttribute('aria-activedescendant', options[index].id);
  if (scroll) options[index].scrollIntoView({ block: 'nearest' });
  const preview = dom.contextMenu.querySelector<HTMLElement>('#context-preview');
  const q = (dom.contextMenu.querySelector<HTMLInputElement>('#context-search')?.value ?? '').trim().toLowerCase();
  const pool = context.source && !state.contextSensitive ? context.allEntries : context.entries;
  const entry = pool.filter((e) => searchText(e.definition).includes(q))[index];
  if (preview && entry) showPreview(preview, entry);
}

// A node's or comment's menu is a menu of items: focus starts on the first, and the arrow keys,
// Home and End move through them (docs/release.md, step 6). Enter and Space are the buttons' own.
function readyMenu(): void {
  dom.contextMenu.setAttribute('role', 'menu');
  const items = menuItems();
  for (const item of items) {
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
  }
  dom.contextMenu.querySelectorAll('.context-separator').forEach((s) => s.setAttribute('role', 'separator'));
  dom.contextMenu.querySelectorAll('.context-title, .context-heading').forEach((h) => h.setAttribute('role', 'presentation'));
  items[0]?.focus();
}

function menuItems(): HTMLButtonElement[] {
  return [...dom.contextMenu.querySelectorAll<HTMLButtonElement>('button[data-action], button[data-pin-action], button[data-function-action]')];
}

dom.contextMenu.addEventListener('keydown', (e) => {
  if (state.context?.kind === 'add-node') return;
  const items = menuItems();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === 'ArrowDown' ? (at + 1) % items.length
    : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
    : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : undefined;
  if (next !== undefined && items.length) {
    items[next].focus();
    e.preventDefault();
    e.stopPropagation();
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    hideContextMenu();
    e.preventDefault();
    e.stopPropagation();
  }
});

// Shift+F10 or the Menu key (docs/release.md, step 6): the menu a right-click would open, for what's
// selected: the selected node's menu beside it, the selected comment's at its title, or with nothing
// selected the Add Node menu at the view's center.
export function showMenuAtSelection(): void {
  if (!state.graph) return;
  const rect = dom.canvasWrap.getBoundingClientRect();
  const nodeId = state.selectedNodeId ?? (state.selectedNodeIds.size ? [...state.selectedNodeIds][0] : null);
  const nodeEl = nodeId ? dom.canvasWrap.querySelector<HTMLElement>(`.node[data-node="${CSS.escape(nodeId)}"]`) : null;
  if (nodeId && nodeEl) {
    const box = nodeEl.getBoundingClientRect();
    showNodeContextMenu(nodeId, Math.min(box.right + 4, rect.right - 8), Math.max(box.top, rect.top + 4));
    return;
  }
  const commentId = selectedCommentIds.size === 1 ? [...selectedCommentIds][0] : null;
  const title = commentId ? dom.canvasWrap.querySelector<HTMLElement>(`.comment[data-comment="${CSS.escape(commentId)}"] .comment-title`) : null;
  if (commentId && title) {
    const box = title.getBoundingClientRect();
    showCommentContextMenu(commentId, box.left + 8, box.bottom);
    return;
  }
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 3;
  showAddNodeMenu(screenToWorld(x, y), x, y, paletteEntries(), 'Add Node');
}

// A pin's actions with the two that stand in for dragging a wire (docs/release.md, step 7): Connect
// to, which lists the pins it can be wired to, and Add Node from Here, as dropping a wire on the
// graph does. Then the pin's own actions.
export function wiringMenuItems(nodeId: string, pinId: string): MenuItem[] {
  const items: MenuItem[] = [];
  const pinEl = () => dom.canvasWrap.querySelector<HTMLElement>(`.pin[data-node="${CSS.escape(nodeId)}"][data-pin="${CSS.escape(pinId)}"]`);
  const at = () => {
    const box = pinEl()?.getBoundingClientRect() ?? dom.canvasWrap.getBoundingClientRect();
    return { x: box.right + 4, y: box.top };
  };
  if (connectCandidates(nodeId, pinId).length) items.push({ label: 'Connect to…', action: () => showConnectMenu(nodeId, pinId, at().x, at().y) });
  const source = state.graph && editing.pinDefinition(state.graph, lookupDefinition, nodeId, pinId);
  const fits = source ? paletteEntries().filter((entry) => editing.matchingPin(entry.definition, source)) : [];
  if (source && fits.length) {
    items.push({
      label: 'Add Node from Here…',
      action: () => {
        const { x, y } = at();
        const world = screenToWorld(x + 60, y);
        showAddNodeMenu(world, x, y, fits, `Add Node from ${pinName(source)}`, { node: nodeId, pin: pinId, kind: source.kind });
      }
    });
  }
  return [...items, ...pinMenuItems(nodeId, pinId)];
}

// The pins of the graph a pin can be wired to (with a To String between, where Unreal adds one),
// nearest node first.
function connectCandidates(nodeId: string, pinId: string): { node: string; pin: string; label: string }[] {
  const graph = state.graph;
  const from = graph?.nodes.find((n) => n.id === nodeId);
  if (!graph || !from) return [];
  const linked = (other: string, pin: string) => graph.connections.some((c) =>
    (c.fromNode === nodeId && c.fromPin === pinId && c.toNode === other && c.toPin === pin) || (c.toNode === nodeId && c.toPin === pinId && c.fromNode === other && c.fromPin === pin));
  const found: { node: string; pin: string; label: string; distance: number }[] = [];
  for (const node of graph.nodes) {
    if (node.id === nodeId) continue;
    const def = definitionFor(node, lookupDefinition);
    for (const pin of [...def.inputs, ...def.outputs]) {
      if (linked(node.id, pin.id) || !editing.planConnection(graph, lookupDefinition, { node: nodeId, pin: pinId }, { node: node.id, pin: pin.id })) continue;
      const distance = Math.hypot(node.position.x - from.position.x, node.position.y - from.position.y);
      found.push({ node: node.id, pin: pin.id, label: `${nodeTitle(node.id)}: ${pinName(pin)}`, distance });
    }
  }
  return found.sort((a, b) => a.distance - b.distance).slice(0, 40);
}

function showConnectMenu(nodeId: string, pinId: string, clientX: number, clientY: number): void {
  const source = state.graph && editing.pinDefinition(state.graph, lookupDefinition, nodeId, pinId);
  const candidates = connectCandidates(nodeId, pinId);
  if (!source || !candidates.length) return;
  dom.contextMenu.innerHTML = `
      <div class="context-title">Connect ${escapeHtml(nodeTitle(nodeId))}: ${escapeHtml(pinName(source))} to</div>
      ${candidates.map((c, i) => `<button data-action="${i}">${escapeHtml(c.label)}</button>`).join('')}`;
  state.context = { kind: 'node', nodeId };
  dom.contextMenu.hidden = false;
  positionContextMenu(clientX, clientY);
  readyMenu();
  dom.contextMenu.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = candidates[Number(button.dataset.action)];
      hideContextMenu();
      if (target && connectPins({ node: nodeId, pin: pinId }, { node: target.node, pin: target.pin })) {
        setStatus(`Connected ${nodeTitle(nodeId)}: ${pinName(source)} to ${target.label}.`);
      }
    });
  });
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
  readyMenu();
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
  readyMenu();
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
  dom.contextMenu.removeAttribute('role');
  state.context = null;
}
