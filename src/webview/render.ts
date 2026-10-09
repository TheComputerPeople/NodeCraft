import { definitionFor } from '../core/editing';
import { GraphNode, PinDefinition } from '../core/model';
import { beginRewireFromConnection, onNodeMouseDown, onPinMouseDown, removeConnection } from './actions';
import { lookupDefinition } from './document';
import { dom, escapeHtml, pinElement } from './dom';
import { renderInspector } from './panels';
import { Point, state } from './state';
import { applyTransform, centerOf, screenPointToWorld } from './view';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function render(): void {
  dom.world.innerHTML = '';
  if (!state.graph) return;
  state.graph.nodes.forEach((node) => dom.world.appendChild(renderNode(node)));
  applyTransform();
  renderEdges();
  renderInspector();
  syncSelectionClasses();
}

function renderNode(node: GraphNode): HTMLElement {
  const def = definitionFor(node, lookupDefinition);
  const el = document.createElement('div');
  el.className = 'node' + (state.selectedNodeIds.has(node.id) ? ' selected' : '') + (state.executedNodeIds.has(node.id) ? ' executing' : '');
  el.dataset.node = node.id;
  el.draggable = false;
  el.style.left = `${node.position.x}px`;
  el.style.top = `${node.position.y}px`;
  el.style.setProperty('--node-color', def.color || '#6b7280');

  const header = document.createElement('div');
  header.className = 'node-header';
  header.innerHTML = `<span class="node-title">${escapeHtml(def.displayName)}</span><span class="node-type">${escapeHtml(def.category)}</span>`;
  el.appendChild(header);

  const body = document.createElement('div');
  body.className = 'node-body';
  const left = document.createElement('div');
  left.className = 'pin-column left';
  const right = document.createElement('div');
  right.className = 'pin-column right';
  def.inputs.forEach((pin) => left.appendChild(renderPin(node, pin)));
  def.outputs.forEach((pin) => right.appendChild(renderPin(node, pin)));
  body.append(left, right);
  el.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'node-footer';
  if (def.description) footer.textContent = def.description;
  el.appendChild(footer);

  // The whole node body is draggable. Pin mousedown stops propagation and therefore
  // remains exclusively responsible for drawing a connection.
  el.addEventListener('mousedown', (e) => onNodeMouseDown(node, e));
  return el;
}

function renderPin(node: GraphNode, pin: PinDefinition): HTMLElement {
  const row = document.createElement('div');
  row.className = `pin-row ${pin.kind} ${pin.direction}`;
  const label = document.createElement('span');
  label.className = 'pin-label';
  label.textContent = pin.name || (pin.kind === 'exec' ? '' : pin.id);

  const handle = document.createElement('span');
  handle.className = `pin ${pin.kind}`;
  handle.dataset.node = node.id;
  handle.dataset.pin = pin.id;
  handle.dataset.kind = pin.kind;
  handle.dataset.direction = pin.direction;
  handle.title = pin.kind === 'exec' ? 'Execution pin' : `${pin.name} (${pin.type?.id || 'any'})`;
  handle.addEventListener('mousedown', (e) => onPinMouseDown(node, pin, e));
  handle.addEventListener('dragstart', (e) => e.preventDefault());

  if (pin.direction === 'input') row.append(handle, label);
  else row.append(label, handle);
  return row;
}

// `pointer` is the cursor position (client coordinates) while a wire is being dragged.
export function renderEdges(pointer: Point | null = null): void {
  dom.edges.innerHTML = '';
  if (!state.graph) return;
  const rect = dom.canvasWrap.getBoundingClientRect();
  for (const c of state.graph.connections) {
    const source = pinElement(c.fromNode, c.fromPin);
    const target = pinElement(c.toNode, c.toPin);
    if (!source || !target) continue;
    const ran = state.executedNodeIds.has(c.fromNode) && state.executedNodeIds.has(c.toNode);
    addPath(centerOf(source, rect), centerOf(target, rect), ran ? 'active' : '', c.id);
  }

  const draft = state.draftConnection;
  if (draft) {
    const source = pinElement(draft.node, draft.pin);
    if (source) {
      const end = screenPointToWorld(pointer ?? { x: draft.startX, y: draft.startY }, rect);
      addPath(centerOf(source, rect), end, 'draft');
    }
  }

  const rewire = state.rewire;
  if (rewire) {
    const c = state.graph.connections.find((connection) => connection.id === rewire.connectionId);
    const source = c && pinElement(c.fromNode, c.fromPin);
    const target = c && pinElement(c.toNode, c.toPin);
    if (source && target) {
      const moving = screenPointToWorld(pointer ?? { x: rewire.startX, y: rewire.startY }, rect);
      if (rewire.side === 'from') addPath(moving, centerOf(target, rect), 'draft');
      else addPath(centerOf(source, rect), moving, 'draft');
    }
  }
}

function addPath(a: Point, b: Point, className = '', connectionId: string | null = null): void {
  const d = bezierPath(a, b);
  if (connectionId) {
    // A wide invisible stroke under the visible wire, so wires are easy to click.
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'edge-hit');
    hit.dataset.connectionId = connectionId;
    hit.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (e.button !== 0) return;
      if (e.altKey) removeConnection(connectionId);
      else if (e.ctrlKey || e.metaKey) beginRewireFromConnection(connectionId, e.clientX, e.clientY);
    });
    dom.edges.appendChild(hit);
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', `edge ${className}`.trim());
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
