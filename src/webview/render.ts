import { definitionFor } from '../core/editing';
import { GraphNode, PinDefinition } from '../core/model';
import { formatType } from '../core/types';
import { SEQUENCE } from '../core/resolve';
import { addSequenceOutput, beginRewireFromConnection, insertRerouteAt, onNodeMouseDown, onPinMouseDown, removeConnection } from './actions';
import { renderComments } from './comments';
import { nodeDiagnostics } from './compile-results';
import { lookupDefinition, markDirty, pinDef } from './document';
import { dom, pinElement } from './dom';
import { renderInspector } from './panels';
import { Point, state } from './state';
import { applyTransform, centerOf, screenPointToWorld } from './view';
import { headerColor, nodeKind, pinColor } from './style';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function render(): void {
  dom.world.innerHTML = '';
  if (!state.graph) return;
  // Comments first, so nodes draw on top of them.
  renderComments();
  state.graph.nodes.forEach((node) => dom.world.appendChild(renderNode(node)));
  applyTransform();
  renderEdges();
  renderInspector();
  syncSelectionClasses();
}

function renderNode(node: GraphNode): HTMLElement {
  const def = definitionFor(node, lookupDefinition);
  const kind = nodeKind(def);
  const el = document.createElement('div');
  el.className = 'node' + (state.selectedNodeIds.has(node.id) ? ' selected' : '') + (state.executedNodeIds.has(node.id) ? ' executing' : '') + (def.compact ? ' compact' : '');
  el.dataset.node = node.id;
  el.dataset.kind = kind;
  el.draggable = false;
  el.style.left = `${node.position.x}px`;
  el.style.top = `${node.position.y}px`;
  el.style.setProperty('--node-color', headerColor(def));
  // Unreal shows a node's description as a tooltip rather than on the node.
  if (def.description) el.title = def.description;

  // Unreal-style badge for compiler errors and warnings on this node.
  const diagnostics = nodeDiagnostics(node.id);
  const severity = diagnostics.some((d) => d.severity === 'error') ? 'error' : diagnostics.length ? 'warning' : undefined;
  if (severity) {
    el.classList.add(`has-${severity}`);
    const badge = document.createElement('span');
    badge.className = `node-badge ${severity}`;
    badge.textContent = severity === 'error' ? 'ERROR!' : 'WARNING!';
    badge.title = diagnostics.map((d) => d.message).join('\n');
    el.appendChild(badge);
  }

  if (kind === 'reroute') {
    // A knot: the wire enters on the left and leaves on the right; the middle is the grab handle.
    el.classList.add('knot');
    const body = document.createElement('div');
    body.className = 'knot-body';
    def.inputs.forEach((pin) => body.appendChild(renderPin(node, pin, false)));
    const grip = document.createElement('span');
    grip.className = 'knot-grip';
    body.appendChild(grip);
    def.outputs.forEach((pin) => body.appendChild(renderPin(node, pin, false)));
    el.appendChild(body);
  } else if (def.compact) {
    // Variable getters: the variable's name beside its output pin, no title bar.
    const body = document.createElement('div');
    body.className = 'compact-body';
    const title = document.createElement('span');
    title.className = 'node-title';
    title.textContent = def.displayName;
    body.appendChild(title);
    def.outputs.forEach((pin) => body.appendChild(renderPin(node, pin, false)));
    el.appendChild(body);
  } else {
    const header = document.createElement('div');
    header.className = 'node-header';
    const title = document.createElement('span');
    title.className = 'node-title';
    title.textContent = def.displayName;
    header.appendChild(title);
    el.appendChild(header);

    const body = document.createElement('div');
    body.className = 'node-body';
    const left = document.createElement('div');
    left.className = 'pin-column left';
    const right = document.createElement('div');
    right.className = 'pin-column right';
    def.inputs.forEach((pin) => left.appendChild(renderPin(node, pin, true)));
    def.outputs.forEach((pin) => right.appendChild(renderPin(node, pin, true)));
    body.append(left, right);
    el.appendChild(body);
    // Unreal's "Add pin +" on nodes whose outputs can grow.
    if (node.type === SEQUENCE) {
      const add = document.createElement('button');
      add.className = 'add-pin';
      add.textContent = 'Add pin +';
      add.title = 'Add an output';
      add.addEventListener('mousedown', (e) => e.stopPropagation());
      add.addEventListener('click', () => addSequenceOutput(node));
      el.appendChild(add);
    }
  }

  // The whole node body is draggable. Pin mousedown stops propagation and therefore
  // remains exclusively responsible for drawing a connection.
  el.addEventListener('mousedown', (e) => onNodeMouseDown(node, e));
  return el;
}

function isConnected(nodeId: string, pinId: string): boolean {
  return !!state.graph?.connections.some((c) => (c.fromNode === nodeId && c.fromPin === pinId) || (c.toNode === nodeId && c.toPin === pinId));
}

function renderPin(node: GraphNode, pin: PinDefinition, showLabel: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = `pin-row ${pin.kind} ${pin.direction}`;
  const connected = isConnected(node.id, pin.id);
  const label = document.createElement('span');
  label.className = 'pin-label';
  label.textContent = showLabel ? pin.name || (pin.kind === 'exec' ? '' : pin.id) : '';

  const handle = document.createElement('span');
  handle.className = `pin ${pin.kind}${connected ? ' connected' : ''}`;
  handle.dataset.node = node.id;
  handle.dataset.pin = pin.id;
  handle.dataset.kind = pin.kind;
  handle.dataset.direction = pin.direction;
  if (pin.type?.container) handle.dataset.container = pin.type.container;
  handle.style.setProperty('--pin-color', pinColor(pin));
  handle.title = pin.kind === 'exec' ? 'Execution pin' : `${pin.name || pin.id} (${formatType(pin.type)})`;
  handle.addEventListener('mousedown', (e) => onPinMouseDown(node, pin, e));
  handle.addEventListener('dragstart', (e) => e.preventDefault());
  // Hovering a pin highlights its wires, as in Unreal.
  handle.addEventListener('mouseenter', () => {
    state.hoverPin = { node: node.id, pin: pin.id };
    renderEdges();
  });
  handle.addEventListener('mouseleave', () => {
    state.hoverPin = null;
    renderEdges();
  });

  if (pin.direction === 'input') {
    row.append(handle, label);
    const editor = !connected && pin.kind === 'data' ? defaultEditor(node, pin) : undefined;
    if (editor) row.appendChild(editor);
  } else {
    row.append(label, handle);
  }
  return row;
}

// Unreal edits an unconnected input's value right on the node: a checkbox for bool, a field for
// numbers and text. Containers get an editor in a later version.
function defaultEditor(node: GraphNode, pin: PinDefinition): HTMLInputElement | undefined {
  const type = pin.type;
  if (type?.container) return undefined;
  const key = `pin:${pin.id}`;
  const value = node.properties[key] ?? pin.defaultValue;
  const input = document.createElement('input');
  input.className = 'pin-default';
  input.dataset.pin = pin.id;
  input.setAttribute('aria-label', pin.name || pin.id);
  if (type?.id === 'bool') {
    input.type = 'checkbox';
    input.checked = Boolean(value);
  } else if (type?.id === 'int' || type?.id === 'float') {
    input.type = 'number';
    input.step = type.id === 'int' ? '1' : 'any';
    input.value = value === undefined || value === null ? '0' : String(value);
  } else {
    input.type = 'text';
    input.value = value === undefined || value === null ? '' : String(value);
  }
  input.addEventListener('input', () => {
    node.properties[key] = input.type === 'checkbox' ? input.checked
      : input.type === 'number' ? (type?.id === 'int' ? Math.trunc(Number(input.value)) : Number(input.value))
      : input.value;
    markDirty();
  });
  return input;
}

// `pointer` is the cursor position (client coordinates) while a wire is being dragged.
export function renderEdges(pointer: Point | null = null): void {
  dom.edges.innerHTML = '';
  if (!state.graph) return;
  const rect = dom.canvasWrap.getBoundingClientRect();
  const moving = new Set(state.rewire?.connectionIds ?? []);
  const hover = state.hoverPin;
  for (const c of state.graph.connections) {
    // Wires being moved are drawn from the pointer instead (below).
    if (moving.has(c.id)) continue;
    const source = pinElement(c.fromNode, c.fromPin);
    const target = pinElement(c.toNode, c.toPin);
    if (!source || !target) continue;
    const ran = state.executedNodeIds.has(c.fromNode) && state.executedNodeIds.has(c.toNode);
    const hovered = !!hover && ((c.fromNode === hover.node && c.fromPin === hover.pin) || (c.toNode === hover.node && c.toPin === hover.pin));
    addPath(centerOf(source, rect), centerOf(target, rect), [ran ? 'active' : '', hovered ? 'hover' : ''].join(' ').trim(), wireStyle(c.fromNode, c.fromPin), c.id);
  }

  const draft = state.draftConnection;
  if (draft) {
    const source = pinElement(draft.node, draft.pin);
    if (source) {
      const end = screenPointToWorld(pointer ?? { x: draft.startX, y: draft.startY }, rect);
      addPath(centerOf(source, rect), end, 'draft', wireStyle(draft.node, draft.pin));
    }
  }

  const rewire = state.rewire;
  if (rewire) {
    const end = screenPointToWorld(pointer ?? { x: rewire.startX, y: rewire.startY }, rect);
    for (const c of state.graph.connections.filter((connection) => moving.has(connection.id))) {
      // The end that stays put: the far pin of each wire being moved.
      const fixed = rewire.side === 'from' ? pinElement(c.toNode, c.toPin) : pinElement(c.fromNode, c.fromPin);
      if (!fixed) continue;
      const style = wireStyle(c.fromNode, c.fromPin);
      if (rewire.side === 'from') addPath(end, centerOf(fixed, rect), 'draft', style);
      else addPath(centerOf(fixed, rect), end, 'draft', style);
    }
  }
}

interface WireStyle {
  color: string;
  exec: boolean;
}

// A wire takes the color of the pin it leaves, as in Unreal; exec wires are drawn thicker.
function wireStyle(nodeId: string, pinId: string): WireStyle {
  const pin = pinDef(nodeId, pinId);
  return { color: pinColor(pin), exec: pin?.kind === 'exec' };
}

function addPath(a: Point, b: Point, className: string, style: WireStyle, connectionId: string | null = null): void {
  const d = bezierPath(a, b);
  if (connectionId) {
    // A wide invisible stroke under the visible wire, so wires are easy to click.
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'edge-hit');
    hit.dataset.connectionId = connectionId;
    // Double-clicking a wire adds a reroute node there.
    hit.addEventListener('dblclick', (e) => insertRerouteAt(connectionId, e.clientX, e.clientY));
    hit.addEventListener('mousedown', (e) => {
      // Other buttons fall through to the canvas (right-drag pans).
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.altKey) removeConnection(connectionId);
      else if (e.ctrlKey || e.metaKey) beginRewireFromConnection(connectionId, e.clientX, e.clientY);
    });
    dom.edges.appendChild(hit);
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', `edge ${style.exec ? 'exec ' : ''}${className}`.trim());
  path.style.setProperty('--wire-color', style.color);
  path.setAttribute('pointer-events', 'none');
  dom.edges.appendChild(path);
}

function bezierPath(a: Point, b: Point): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.55);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

export function syncSelectionClasses(): void {
  document.querySelectorAll<HTMLElement>('.node').forEach((el) => {
    el.classList.toggle('selected', state.selectedNodeIds.has(el.dataset.node ?? ''));
  });
}

// Repaints only the run highlight, at most once per frame, instead of rebuilding the canvas.
export function scheduleRuntimePaint(): void {
  if (state.runtimePaintPending) return;
  state.runtimePaintPending = true;
  requestAnimationFrame(() => {
    state.runtimePaintPending = false;
    document.querySelectorAll<HTMLElement>('.node').forEach((el) => {
      el.classList.toggle('executing', state.executedNodeIds.has(el.dataset.node ?? ''));
    });
    renderEdges();
  });
}
