// Nodes and pins from the keyboard (docs/release.md, step 7). The canvas is one focusable element;
// its focus is a node, or one of a node's pins, shown with a ring and named to screen readers through
// aria-activedescendant. The arrow keys move between nodes (to the nearest one in that direction) or,
// inside a node, between its pins; Enter goes into a node's pins, or opens a pin's menu (with Connect
// to and Add Node from Here); Escape comes back out; F2 edits a pin's value on the node.
import { definitionFor } from '../core/editing';
import { PinDefinition } from '../core/model';
import { lookupDefinition } from './document';
import { dom, nodeElement, pinElement } from './dom';
import { showNodeContextMenu, wiringMenuItems } from './menus';
import { selectNode } from './selection';
import { renderInspector } from './panels';
import { syncSelectionClasses } from './render';
import { state } from './state';

// The id the focused node or pin carries, for the canvas's aria-activedescendant.
const FOCUS_ID = 'graph-focus';
// Set while a press gives the canvas focus, so that focus doesn't count as the keyboard's.
let pressing = false;

export function initKeyboard(): void {
  const canvas = dom.canvasWrap;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-roledescription', 'graph');
  canvas.setAttribute('aria-label', 'Graph');
  canvas.addEventListener('focus', () => {
    // Reached with Tab: the focus ring shows, on the node the keyboard was last on, else the
    // selected node, else the first node.
    if (!pressing && canvas.matches(':focus-visible')) state.keyboard = true;
    if (!state.focus) {
      const start = state.selectedNodeId ?? firstNode();
      if (start) state.focus = { node: start };
    }
    syncKeyboardFocus();
  });
  canvas.addEventListener('blur', () => canvas.classList.remove('keyboard'));
  // A press on the graph moves the keyboard there too, onto the node or pin pressed (capture: nodes
  // and pins stop their presses). An inline value field keeps its own focus.
  canvas.addEventListener('mousedown', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('#context-menu') || target?.matches('input, textarea, select')) return;
    state.keyboard = false;
    const pin = target?.closest<HTMLElement>('.pin');
    const node = target?.closest<HTMLElement>('.node');
    if (pin?.dataset.node && pin.dataset.pin) state.focus = { node: pin.dataset.node, pin: pin.dataset.pin };
    else if (node?.dataset.node) state.focus = { node: node.dataset.node };
    pressing = true;
    if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
    pressing = false;
    syncKeyboardFocus();
  }, true);
}

// Marks the focused node or pin, after a redraw or a move.
export function syncKeyboardFocus(): void {
  const canvas = dom.canvasWrap;
  document.querySelectorAll('.kb-focus').forEach((el) => el.classList.remove('kb-focus'));
  document.getElementById(FOCUS_ID)?.removeAttribute('id');
  let focus = state.focus;
  if (focus && !state.graph?.nodes.some((n) => n.id === focus!.node)) focus = state.focus = null;
  let el = focus ? (focus.pin ? pinElement(focus.node, focus.pin) : nodeElement(focus.node)) : null;
  if (focus?.pin && !el) {
    state.focus = { node: focus.node };
    el = nodeElement(focus.node);
  }
  canvas.classList.toggle('keyboard', state.keyboard && document.activeElement === canvas);
  if (!el) {
    canvas.removeAttribute('aria-activedescendant');
    return;
  }
  el.classList.add('kb-focus');
  el.id = FOCUS_ID;
  canvas.setAttribute('aria-activedescendant', FOCUS_ID);
}

// Handles a key pressed on the graph; true when it was one of the keyboard's own.
export function handleGraphKey(e: KeyboardEvent): boolean {
  if (!state.graph || e.ctrlKey || e.metaKey || e.altKey) return false;
  const arrow = e.key.startsWith('Arrow');
  if (!arrow && !['Enter', 'Escape', 'F2'].includes(e.key)) return false;
  if (e.shiftKey && e.key !== 'Enter') return false;
  const focus = state.focus;
  if (arrow) {
    if (document.activeElement !== dom.canvasWrap) dom.canvasWrap.focus({ preventScroll: true });
    state.keyboard = true;
    if (!focus) {
      const start = state.selectedNodeId ?? firstNode();
      if (start) focusNode(start);
    } else if (focus.pin) {
      movePinFocus(focus.node, focus.pin, e.key);
    } else {
      const next = nearestNode(focus.node, e.key);
      if (next) focusNode(next);
    }
    return true;
  }
  if (!focus) return false;
  if (e.key === 'Enter' && !focus.pin) {
    const [first] = pinsOf(focus.node, 'input').length ? pinsOf(focus.node, 'input') : pinsOf(focus.node, 'output');
    if (!first) return false;
    setFocus({ node: focus.node, pin: first });
    return true;
  }
  if (e.key === 'Enter' && focus.pin) {
    showPinMenu(focus.node, focus.pin);
    return true;
  }
  if (e.key === 'Escape' && focus.pin) {
    setFocus({ node: focus.node });
    return true;
  }
  if (e.key === 'F2' && focus.pin) return editPinValue(focus.node, focus.pin);
  if (e.key === 'Escape') {
    // Out of the node too: nothing is focused or selected, so Shift+F10 opens Add Node. The editor's
    // own Escape (closing menus, ending gestures) still runs.
    state.focus = null;
    state.selectedNodeIds = new Set();
    state.selectedNodeId = null;
    syncSelectionClasses();
    renderInspector();
    syncKeyboardFocus();
  }
  return false;
}

// Shift+F10 or the Menu key on a pin: its menu, as a right-click on it opens. False when the focus
// isn't on a pin.
export function showPinMenuAtFocus(): boolean {
  const focus = state.focus;
  if (!focus?.pin || !pinElement(focus.node, focus.pin)) return false;
  showPinMenu(focus.node, focus.pin);
  return true;
}

function showPinMenu(nodeId: string, pinId: string): void {
  const box = pinElement(nodeId, pinId)!.getBoundingClientRect();
  showNodeContextMenu(nodeId, box.right + 4, box.top, wiringMenuItems(nodeId, pinId));
}

function setFocus(focus: { node: string; pin?: string }): void {
  state.focus = focus;
  state.keyboard = true;
  syncKeyboardFocus();
  const el = focus.pin ? pinElement(focus.node, focus.pin) : nodeElement(focus.node);
  if (el) keepInView(el);
}

// Focus follows to a node and selects it, as a click would.
function focusNode(nodeId: string): void {
  state.focus = { node: nodeId };
  selectNode(nodeId, false, true);
  setFocus({ node: nodeId });
}

// The node at the top left: where the keyboard starts on a graph.
function firstNode(): string | undefined {
  return [...(state.graph?.nodes ?? [])].sort((a, b) => (a.position.x + a.position.y) - (b.position.x + b.position.y))[0]?.id;
}

// The nearest node in an arrow's direction, measured between the nodes' centers: distance along the
// direction counts once, distance across it twice, so a node straight ahead wins over a closer one
// off to the side.
function nearestNode(fromId: string, key: string): string | undefined {
  const from = nodeElement(fromId)?.getBoundingClientRect();
  if (!from) return undefined;
  const center = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const a = center(from);
  let best: { id: string; score: number } | undefined;
  for (const node of state.graph?.nodes ?? []) {
    if (node.id === fromId) continue;
    const box = nodeElement(node.id)?.getBoundingClientRect();
    if (!box) continue;
    const b = center(box);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const along = key === 'ArrowRight' ? dx : key === 'ArrowLeft' ? -dx : key === 'ArrowDown' ? dy : -dy;
    const across = key === 'ArrowRight' || key === 'ArrowLeft' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) continue;
    const score = along + across * 2;
    if (!best || score < best.score) best = { id: node.id, score };
  }
  return best?.id;
}

// A node's pins on one side, in the order they're drawn.
function pinsOf(nodeId: string, direction: 'input' | 'output'): string[] {
  const el = nodeElement(nodeId);
  return el ? [...el.querySelectorAll<HTMLElement>(`.pin[data-direction="${direction}"]`)].map((p) => p.dataset.pin ?? '').filter(Boolean) : [];
}

// Up and Down move along a side's pins; Left and Right cross to the other side, at the same row
// or the nearest.
function movePinFocus(nodeId: string, pinId: string, key: string): void {
  const side = pinElement(nodeId, pinId)?.dataset.direction === 'output' ? 'output' : 'input';
  const pins = pinsOf(nodeId, side);
  const at = pins.indexOf(pinId);
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const next = pins[at + (key === 'ArrowDown' ? 1 : -1)];
    if (next) setFocus({ node: nodeId, pin: next });
    return;
  }
  const other = side === 'input' ? 'output' : 'input';
  if ((key === 'ArrowRight') !== (other === 'output')) return;
  const across = pinsOf(nodeId, other);
  if (across.length) setFocus({ node: nodeId, pin: across[Math.min(at, across.length - 1)] });
}

// F2 on an input with a value on the node: its field takes focus; Enter or Escape gives the
// keyboard back to the pin.
function editPinValue(nodeId: string, pinId: string): boolean {
  const field = pinElement(nodeId, pinId)?.closest('.pin-row')?.querySelector<HTMLElement>('.pin-default');
  if (!field) return false;
  field.focus();
  if (field instanceof HTMLInputElement && field.type !== 'checkbox') field.select();
  const done = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    field.removeEventListener('keydown', done);
    dom.canvasWrap.focus({ preventScroll: true });
    state.keyboard = true;
    syncKeyboardFocus();
  };
  field.addEventListener('keydown', done);
  return true;
}

// Pans just enough to bring a node or pin into view.
function keepInView(el: Element): void {
  const view = dom.canvasWrap.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const margin = 40;
  let dx = 0;
  let dy = 0;
  if (box.left < view.left + margin) dx = view.left + margin - box.left;
  else if (box.right > view.right - margin) dx = view.right - margin - box.right;
  if (box.top < view.top + margin) dy = view.top + margin - box.top;
  else if (box.bottom > view.bottom - margin) dy = view.bottom - margin - box.bottom;
  if (!dx && !dy) return;
  state.pan.x += dx;
  state.pan.y += dy;
  const transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  dom.world.style.transform = transform;
  dom.edges.style.transform = transform;
}

// A pin's name as a person says it: an exec pin with no name is Exec (an input) or Then (an output).
export function pinName(pin: PinDefinition): string {
  return pin.name || (pin.kind === 'exec' ? (pin.direction === 'input' ? 'Exec' : 'Then') : pin.id);
}

// A node's title as it's drawn.
export function nodeTitle(nodeId: string): string {
  const drawn = nodeElement(nodeId)?.querySelector('.node-title')?.textContent?.trim();
  const node = state.graph?.nodes.find((n) => n.id === nodeId);
  return drawn || (node ? definitionFor(node, lookupDefinition).displayName : nodeId);
}
