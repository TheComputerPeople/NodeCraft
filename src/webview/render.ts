import { canAddPin, definitionFor } from '../core/editing';
import { GraphConnection, GraphNode, PinDefinition } from '../core/model';
import { formatType } from '../core/types';
import { SEQUENCE } from '../core/resolve';
import { addOutputPin, beginRewireFromConnection, insertRerouteAt, onNodeMouseDown, onPinMouseDown, removeConnection } from './actions';
import { renderComments } from './comments';
import { nodeDiagnostics } from './compile-results';
import { functionProblem, lookupDefinition, markDirty, pinDef } from './document';
import { dom } from './dom';
import { renderInspector } from './panels';
import { Point, state } from './state';
import { applyTransform, screenPointToWorld } from './view';
import { headerColor, nodeKind, pinColor } from './style';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function render(): void {
  dom.world.innerHTML = '';
  if (!state.graph) return;
  // Comments first, so nodes draw on top of them.
  renderComments();
  state.graph.nodes.forEach((node) => dom.world.appendChild(renderNode(node)));
  applyTransform();
  measurePins();
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

  // Unreal-style badge for compiler errors and warnings on this node, and for a project function
  // whose code changed or is gone (shown at once, without compiling).
  const problem = functionProblem(node);
  const diagnostics = [...nodeDiagnostics(node.id), ...(problem ? [problem] : [])];
  const severity = diagnostics.some((d) => d.severity === 'error') ? 'error' : diagnostics.length ? 'warning' : undefined;
  if (severity) {
    el.classList.add(`has-${severity}`);
    const badge = document.createElement('span');
    badge.className = `node-badge ${severity}`;
    badge.textContent = severity === 'error' ? 'ERROR!' : 'WARNING!';
    badge.title = [...new Set(diagnostics.map((d) => d.message))].join('\n');
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
    // Compact nodes (variable getters, conversions, operators): inputs stacked left of the title,
    // outputs right of it, no title bar.
    const body = document.createElement('div');
    body.className = 'compact-body';
    // Operators (+, <, AND, …) show their symbol large, as Unreal does.
    if (def.type.startsWith('core:math.')) el.classList.add('operator');
    const column = (pins: PinDefinition[]): void => {
      if (!pins.length) return;
      const pinsEl = document.createElement('div');
      pinsEl.className = 'compact-pins';
      pins.forEach((pin) => pinsEl.appendChild(renderPin(node, pin, false)));
      body.appendChild(pinsEl);
    };
    column(def.inputs);
    const title = document.createElement('span');
    title.className = 'node-title';
    title.textContent = def.displayName;
    body.appendChild(title);
    column(def.outputs);
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
    if (canAddPin(node)) {
      const add = document.createElement('button');
      add.className = 'add-pin';
      add.textContent = 'Add pin +';
      add.title = 'Add an output';
      add.addEventListener('mousedown', (e) => e.stopPropagation());
      add.addEventListener('click', () => addOutputPin(node));
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
  handle.addEventListener('mouseenter', () => setHoverPin({ node: node.id, pin: pin.id }));
  handle.addEventListener('mouseleave', () => setHoverPin(null));

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

// ---- Wires ------------------------------------------------------------------------------------
// Wires are drawn in world coordinates inside an SVG that shares #world's transform, so panning
// and zooming never redraw them. Pin positions come from offsets measured once per render (pin
// position inside its node), so drawing a wire needs no layout queries; dragging nodes updates
// only the wires attached to them.

// Pin centers relative to their node's top-left, in world units, keyed by `pinKey`.
const pinOffsets = new Map<string, Point>();
// The drawn elements of each wire, for updating geometry and classes without a full redraw.
const wireElements = new Map<string, { hit: SVGPathElement; path: SVGPathElement }>();
let draftLayer: SVGGElement | undefined;

function pinKey(nodeId: string, pinId: string): string {
  return `${nodeId}\u0000${pinId}`;
}

// Measures every rendered pin's center within its node. A pin's offset parent is its node (the
// nearest positioned ancestor), and offsets are unaffected by the canvas zoom.
function measurePins(): void {
  pinOffsets.clear();
  for (const el of dom.world.querySelectorAll<HTMLElement>('.pin[data-node]')) {
    pinOffsets.set(pinKey(el.dataset.node ?? '', el.dataset.pin ?? ''), { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 });
  }
}

function pinPosition(nodeId: string, pinId: string, nodes: Map<string, GraphNode>): Point | undefined {
  const node = nodes.get(nodeId);
  const offset = pinOffsets.get(pinKey(nodeId, pinId));
  return node && offset ? { x: node.position.x + offset.x, y: node.position.y + offset.y } : undefined;
}

function nodeMap(): Map<string, GraphNode> {
  return new Map((state.graph?.nodes ?? []).map((n) => [n.id, n]));
}

function wireTouches(c: GraphConnection, pin: { node: string; pin: string }): boolean {
  return (c.fromNode === pin.node && c.fromPin === pin.pin) || (c.toNode === pin.node && c.toPin === pin.pin);
}

// Redraws every wire. `pointer` is the cursor (client coordinates) while a wire is being dragged.
export function renderEdges(pointer: Point | null = null): void {
  dom.edges.innerHTML = '';
  wireElements.clear();
  draftLayer = undefined;
  if (!state.graph) return;
  const nodes = nodeMap();
  const moving = new Set(state.rewire?.connectionIds ?? []);
  const hover = state.hoverPin;
  for (const c of state.graph.connections) {
    // Wires being moved are drawn from the pointer instead (see renderDrafts).
    if (moving.has(c.id)) continue;
    const a = pinPosition(c.fromNode, c.fromPin, nodes);
    const b = pinPosition(c.toNode, c.toPin, nodes);
    if (!a || !b) continue;
    const ran = state.executedNodeIds.has(c.fromNode) && state.executedNodeIds.has(c.toNode);
    const hovered = !!hover && wireTouches(c, hover);
    addWire(a, b, [ran ? 'active' : '', hovered ? 'hover' : ''].join(' ').trim(), wireStyle(c.fromNode, c.fromPin), c.id);
  }
  renderDrafts(pointer);
}

// Updates the wires attached to `nodeIds` after those nodes moved, reusing their elements.
export function updateEdgesFor(nodeIds: ReadonlySet<string>): void {
  if (!state.graph) return;
  const nodes = nodeMap();
  for (const c of state.graph.connections) {
    if (!nodeIds.has(c.fromNode) && !nodeIds.has(c.toNode)) continue;
    const elements = wireElements.get(c.id);
    const a = pinPosition(c.fromNode, c.fromPin, nodes);
    const b = pinPosition(c.toNode, c.toPin, nodes);
    if (!elements || !a || !b) continue;
    const d = bezierPath(a, b);
    elements.hit.setAttribute('d', d);
    elements.path.setAttribute('d', d);
  }
}

// Redraws only wires being dragged out (new or moved), on their own layer above the others.
export function renderDrafts(pointer: Point | null = null): void {
  if (!state.graph) return;
  if (!draftLayer) {
    draftLayer = document.createElementNS(SVG_NS, 'g');
    dom.edges.appendChild(draftLayer);
  }
  draftLayer.replaceChildren();
  const nodes = nodeMap();
  const draft = state.draftConnection;
  if (draft) {
    const from = pinPosition(draft.node, draft.pin, nodes);
    if (from) addWire(from, screenPointToWorld(pointer ?? { x: draft.startX, y: draft.startY }), 'draft', wireStyle(draft.node, draft.pin), null, draftLayer);
  }
  const rewire = state.rewire;
  if (rewire) {
    const end = screenPointToWorld(pointer ?? { x: rewire.startX, y: rewire.startY });
    const ids = new Set(rewire.connectionIds);
    for (const c of state.graph.connections.filter((connection) => ids.has(connection.id))) {
      // The end that stays put: the far pin of each wire being moved.
      const fixed = rewire.side === 'from' ? pinPosition(c.toNode, c.toPin, nodes) : pinPosition(c.fromNode, c.fromPin, nodes);
      if (!fixed) continue;
      const style = wireStyle(c.fromNode, c.fromPin);
      if (rewire.side === 'from') addWire(end, fixed, 'draft', style, null, draftLayer);
      else addWire(fixed, end, 'draft', style, null, draftLayer);
    }
  }
}

// Highlights the wires on a hovered pin by toggling classes, without redrawing.
function setHoverPin(pin: { node: string; pin: string } | null): void {
  const previous = state.hoverPin;
  state.hoverPin = pin;
  for (const c of state.graph?.connections ?? []) {
    const was = !!previous && wireTouches(c, previous);
    const now = !!pin && wireTouches(c, pin);
    if (was !== now) wireElements.get(c.id)?.path.classList.toggle('hover', now);
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

function addWire(a: Point, b: Point, className: string, style: WireStyle, connectionId: string | null = null, parent: SVGElement = dom.edges): void {
  const d = bezierPath(a, b);
  let hit: SVGPathElement | undefined;
  if (connectionId) {
    // A wide invisible stroke under the visible wire, so wires are easy to click.
    hit = document.createElementNS(SVG_NS, 'path');
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
    parent.appendChild(hit);
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', `edge ${style.exec ? 'exec ' : ''}${className}`.trim());
  path.style.setProperty('--wire-color', style.color);
  path.setAttribute('pointer-events', 'none');
  parent.appendChild(path);
  if (connectionId && hit) wireElements.set(connectionId, { hit, path });
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
