import { pinName, syncKeyboardFocus } from './keyboard';
import { canAddPin, definitionFor } from '../core/editing';
import { deprecationMessage } from '../core/metadata';
import { GraphConnection, GraphNode, NodeDefinition, PinDefinition } from '../core/model';
import { addPin, beginRewireFromConnection, insertRerouteAt, onNodeMouseDown, onPinMouseDown, removeConnection } from './actions';
import { breakpointOn } from './breakpoints';
import { pausedNodeId } from './debugger';
import { hideHoverValue, isWatched, showHoverValue, watchedValue } from './values';
import { renderComments } from './comments';
import { nodeDiagnostics } from './compile-results';
import { functionProblem, libraryProblem, lookupDefinition, markDirty, pinDef, shownType } from './document';
import { dom } from './dom';
import { goToDefinition, siteOf } from './navigation';
import { enumSelect, renderInspector, workspaceTypes } from './panels';
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
  syncKeyboardFocus();
}

function renderNode(node: GraphNode): HTMLElement {
  const def = definitionFor(node, lookupDefinition);
  const kind = nodeKind(def);
  const el = document.createElement('div');
  // A Compact Node Title draws the node as operators are drawn.
  const compact = def.compact || !!def.compactTitle;
  el.className = 'node' + (state.selectedNodeIds.has(node.id) ? ' selected' : '') + (state.executedNodeIds.has(node.id) ? ' executing' : '') + (compact ? ' compact' : '') + (def.deprecated ? ' deprecated' : '');
  el.dataset.node = node.id;
  el.dataset.kind = kind;
  el.draggable = false;
  el.style.left = `${node.position.x}px`;
  el.style.top = `${node.position.y}px`;
  el.style.setProperty('--node-color', headerColor(def));
  // Unreal shows a node's description as a tooltip rather than on the node.
  if (def.description) el.title = def.description;

  // A breakpoint is a red dot on the node's corner, hollow when disabled, as in Unreal.
  const breakpoint = breakpointOn(node.id);
  if (breakpoint) {
    const marker = document.createElement('span');
    marker.className = 'node-breakpoint' + (breakpoint.enabled ? '' : ' disabled');
    marker.title = breakpoint.enabled ? 'Breakpoint' : 'Breakpoint (disabled)';
    el.appendChild(marker);
  }
  // Where the debugger paused: the node about to run, with Unreal's arrow pointing at it.
  if (pausedNodeId() === node.id) {
    el.classList.add('paused');
    const arrow = document.createElement('span');
    arrow.className = 'node-paused-arrow';
    arrow.textContent = '▶';
    el.appendChild(arrow);
  }

  // Unreal-style badge for compiler errors and warnings on this node, and for a project function
  // whose code changed or is gone (shown at once, without compiling).
  const problem = functionProblem(node);
  const library = libraryProblem(node);
  // A deprecated node warns at once, as in Unreal, not only after compiling.
  const deprecated = def.deprecated ? [{ severity: 'warning' as const, message: deprecationMessage(def) }] : [];
  const diagnostics = [...nodeDiagnostics(node.id), ...(problem ? [problem] : []), ...(library ? [library] : []), ...deprecated];
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
  } else if (compact) {
    // Compact nodes (variable getters, conversions, operators): inputs stacked left of the title,
    // outputs right of it, no title bar.
    const body = document.createElement('div');
    body.className = 'compact-body';
    // Operators (+, <, AND, …) show their symbol large, as Unreal does.
    if (def.type.startsWith('core:math.') || def.compactTitle) el.classList.add('operator');
    const column = (pins: PinDefinition[]): void => {
      if (!pins.length) return;
      const pinsEl = document.createElement('div');
      pinsEl.className = 'compact-pins';
      pins.forEach((pin) => pinsEl.appendChild(renderPin(node, pin, false)));
      body.appendChild(pinsEl);
    };
    column(shownInputs(node, def));
    const title = document.createElement('span');
    title.className = 'node-title';
    title.textContent = def.compactTitle ?? def.displayName;
    body.appendChild(title);
    column(def.outputs);
    el.appendChild(body);
    advancedArrow(el, node, def);
  } else {
    const header = document.createElement('div');
    header.className = 'node-header';
    const title = document.createElement('span');
    title.className = 'node-title';
    title.textContent = def.displayName;
    header.appendChild(title);
    // A latent node (Delay, an async function) has Unreal's clock: Completed runs later.
    if (def.latent) header.appendChild(clockIcon());
    el.appendChild(header);

    const body = document.createElement('div');
    body.className = 'node-body';
    const left = document.createElement('div');
    left.className = 'pin-column left';
    const right = document.createElement('div');
    right.className = 'pin-column right';
    shownInputs(node, def).forEach((pin) => left.appendChild(renderPin(node, pin, true)));
    def.outputs.forEach((pin) => right.appendChild(renderPin(node, pin, true)));
    body.append(left, right);
    el.appendChild(body);
    advancedArrow(el, node, def);
    // Unreal's "Add pin +" on nodes whose outputs can grow.
    if (canAddPin(node)) {
      const add = document.createElement('button');
      add.className = 'add-pin';
      add.textContent = 'Add pin +';
      add.title = 'Add an output';
      add.addEventListener('mousedown', (e) => e.stopPropagation());
      add.addEventListener('click', () => addPin(node));
      el.appendChild(add);
    }
  }

  // The whole node body is draggable. Pin mousedown stops propagation and therefore
  // remains exclusively responsible for drawing a connection.
  el.addEventListener('mousedown', (e) => onNodeMouseDown(node, e));
  // Double-clicking a node opens its definition, as in Unreal: a function or macro graph, a
  // library's graph, or the project's code.
  el.addEventListener('dblclick', (e) => {
    if ((e.target as Element).closest('input, select, textarea, button') || !siteOf(node.id)) return;
    goToDefinition(node.id);
  });
  labelNode(el, def, kind, { breakpoint: breakpoint ? (breakpoint.enabled ? 'breakpoint' : 'disabled breakpoint') : undefined, paused: pausedNodeId() === node.id, severity, messages: [...new Set(diagnostics.map((d) => d.message))] });
  return el;
}

// What a screen reader says for a node (docs/release.md, step 8): its title, what kind it is, and
// its breakpoint, pause and problems. The canvas names it through aria-activedescendant.
const KIND_WORDS: Record<string, string> = {
  event: 'event', flow: 'flow control', function: 'function', pure: 'pure function',
  'variable-get': 'get variable', 'variable-set': 'set variable', reroute: 'reroute'
};

function labelNode(el: HTMLElement, def: NodeDefinition, kind: string, about: { breakpoint?: string; paused: boolean; severity?: string; messages: string[] }): void {
  const title = el.querySelector('.node-title')?.textContent?.trim() || def.displayName;
  const parts = [title, KIND_WORDS[kind] ?? 'node'];
  if (about.breakpoint) parts.push(about.breakpoint);
  if (about.paused) parts.push('paused here');
  if (about.severity) parts.push(`${about.severity}: ${about.messages.join('; ')}`);
  el.setAttribute('role', 'group');
  el.setAttribute('aria-roledescription', 'node');
  el.setAttribute('aria-label', parts.join(', '));
}

// What a screen reader says for a pin: its name, type and direction, then what it's wired to, or the
// value it has on the node.
function pinLabel(node: GraphNode, pin: PinDefinition): string {
  const graph = state.graph;
  const kind = pin.kind === 'exec' ? 'exec' : shownType(pin.type);
  const parts = [pinName(pin), `${kind} ${pin.direction}`];
  const ends = graph?.connections
    .filter((c) => (pin.direction === 'input' ? c.toNode === node.id && c.toPin === pin.id : c.fromNode === node.id && c.fromPin === pin.id))
    .map((c) => {
      const [otherNode, otherPin] = pin.direction === 'input' ? [c.fromNode, c.fromPin] : [c.toNode, c.toPin];
      const other = graph.nodes.find((n) => n.id === otherNode);
      if (!other) return otherNode;
      const def = definitionFor(other, lookupDefinition);
      const p = [...def.inputs, ...def.outputs].find((x) => x.id === otherPin);
      return `${def.displayName}: ${p ? pinName(p) : otherPin}`;
    }) ?? [];
  if (ends.length) parts.push(`connected to ${ends.join(', ')}`);
  else if (pin.kind === 'data' && pin.direction === 'input') {
    const value = node.properties[`pin:${pin.id}`] ?? pin.defaultValue;
    parts.push(value === undefined || value === null || value === '' ? 'not connected' : `value ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  } else parts.push('not connected');
  return parts.join(', ');
}

// Unreal's Advanced View: advanced inputs show when the node's arrow is open, or when they're wired
// or set, so nothing a node uses is hidden.
function shownInputs(node: GraphNode, def: NodeDefinition): PinDefinition[] {
  if (node.properties.showAdvanced === true) return def.inputs;
  return def.inputs.filter((pin) => !pin.advanced || isConnected(node.id, pin.id) || node.properties[`pin:${pin.id}`] !== undefined);
}

// The arrow at the bottom of a node with advanced inputs, which shows or hides them.
function advancedArrow(el: HTMLElement, node: GraphNode, def: NodeDefinition): void {
  if (!def.inputs.some((pin) => pin.advanced)) return;
  const open = node.properties.showAdvanced === true;
  const arrow = document.createElement('button');
  arrow.className = 'node-advanced';
  arrow.textContent = open ? '▴' : '▾';
  arrow.title = open ? 'Hide advanced pins' : 'Show advanced pins';
  arrow.setAttribute('aria-expanded', String(open));
  arrow.addEventListener('mousedown', (e) => e.stopPropagation());
  arrow.addEventListener('click', () => {
    if (open) delete node.properties.showAdvanced;
    else node.properties.showAdvanced = true;
    markDirty();
    render();
  });
  el.appendChild(arrow);
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
  handle.title = pin.kind === 'exec' ? 'Execution pin' : `${pin.name || pin.id} (${shownType(pin.type)})`;
  handle.setAttribute('role', 'button');
  handle.setAttribute('aria-roledescription', 'pin');
  handle.setAttribute('aria-label', pinLabel(node, pin));
  handle.addEventListener('mousedown', (e) => onPinMouseDown(node, pin, e));
  handle.addEventListener('dragstart', (e) => e.preventDefault());
  // Hovering a pin highlights its wires, as in Unreal.
  // While paused, it also shows the pin's value.
  handle.addEventListener('mouseenter', () => {
    setHoverPin({ node: node.id, pin: pin.id });
    void showHoverValue(node.id, pin.id, handle);
  });
  handle.addEventListener('mouseleave', () => {
    setHoverPin(null);
    hideHoverValue();
  });
  // A watched pin's value stays in a bubble over it.
  if (pin.kind === 'data' && isWatched(node.id, pin.id)) {
    handle.classList.add('watched');
    const value = watchedValue(node.id, pin.id);
    if (value) {
      const bubble = document.createElement('span');
      bubble.className = 'watch-bubble' + (value.value === undefined ? ' unavailable' : '');
      bubble.textContent = value.value ?? value.unavailable ?? '';
      bubble.title = `${pin.name || pin.id}: ${bubble.textContent}`;
      row.classList.add('has-watch');
      row.appendChild(bubble);
    }
  }

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
// numbers and text, a dropdown for an enum. Containers and structs (made with Make) have none.
function defaultEditor(node: GraphNode, pin: PinDefinition): HTMLElement | undefined {
  const type = pin.type;
  if (type?.container || type?.id.startsWith('struct:')) return undefined;
  const key = `pin:${pin.id}`;
  const value = node.properties[key] ?? pin.defaultValue;
  const enumType = type && workspaceTypes().find((t) => t.id === type.id);
  if (enumType?.kind === 'enum' || type?.id.startsWith('enum:')) {
    const options = enumType?.kind === 'enum' ? enumType : { enumerators: [] };
    const picker = enumSelect(options, value, (id) => {
      node.properties[key] = id;
      markDirty();
    }, pin.name || pin.id);
    picker.className = 'pin-default';
    picker.dataset.pin = pin.id;
    picker.addEventListener('mousedown', (e) => e.stopPropagation());
    return picker;
  }
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
  if (connectionId) addPulse(connectionId, d, style);
}

const PULSE_MS = 700;

// A bright dash running along an exec wire execution just went through. Wires are redrawn as the
// run goes on, so the pulse is redrawn with the time it has already run.
function addPulse(connectionId: string, d: string, style: WireStyle): void {
  const started = state.pulses.get(connectionId);
  if (started === undefined) return;
  const elapsed = performance.now() - started;
  if (elapsed >= PULSE_MS) {
    state.pulses.delete(connectionId);
    return;
  }
  const pulse = document.createElementNS(SVG_NS, 'path');
  pulse.setAttribute('d', d);
  pulse.setAttribute('class', 'edge-pulse');
  pulse.setAttribute('pathLength', '100');
  pulse.setAttribute('pointer-events', 'none');
  pulse.dataset.connectionId = connectionId;
  pulse.style.setProperty('--wire-color', style.color);
  pulse.style.animationDuration = `${PULSE_MS}ms`;
  pulse.style.animationDelay = `${-elapsed}ms`;
  dom.edges.appendChild(pulse);
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

function clockIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'node-latent');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-label', 'Latent');
  const face = document.createElementNS(SVG_NS, 'circle');
  face.setAttribute('cx', '8');
  face.setAttribute('cy', '8');
  face.setAttribute('r', '6.5');
  const hands = document.createElementNS(SVG_NS, 'path');
  hands.setAttribute('d', 'M8 4v4l3 2');
  svg.append(face, hands);
  return svg;
}
