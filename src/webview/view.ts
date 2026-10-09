// Pan/zoom and the conversion between screen (client) and world (graph) coordinates.
import { dom } from './dom';
import { renderEdges } from './render';
import { Point, state } from './state';

export function screenToWorld(clientX: number, clientY: number): Point {
  return screenPointToWorld({ x: clientX, y: clientY });
}

export function screenPointToWorld(point: Point, rect: DOMRect = dom.canvasWrap.getBoundingClientRect()): Point {
  return {
    x: (point.x - rect.left - state.pan.x) / state.zoom,
    y: (point.y - rect.top - state.pan.y) / state.zoom
  };
}

// DOM pin positions are screen pixels because #world is CSS transformed. Convert them back
// to graph/world coordinates before drawing; the SVG receives the same transform.
export function centerOf(element: Element, rect: DOMRect): Point {
  const r = element.getBoundingClientRect();
  return screenPointToWorld({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, rect);
}

export function applyTransform(): void {
  const transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  dom.world.style.transform = transform;
  dom.edges.style.transformOrigin = '0 0';
  dom.edges.style.transform = transform;
}

export function zoomAt(clientX: number, clientY: number, zoomIn: boolean): void {
  const rect = dom.canvasWrap.getBoundingClientRect();
  const before = screenPointToWorld({ x: clientX, y: clientY }, rect);
  state.zoom = Math.min(2.2, Math.max(0.45, state.zoom * (zoomIn ? 1.1 : 0.9)));
  state.pan.x = clientX - rect.left - before.x * state.zoom;
  state.pan.y = clientY - rect.top - before.y * state.zoom;
  applyTransform();
  renderEdges();
}

export function fitGraph(): void {
  if (!state.graph?.nodes.length) return;
  const xs = state.graph.nodes.map((n) => n.position.x);
  const ys = state.graph.nodes.map((n) => n.position.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs) + 260, minY = Math.min(...ys), maxY = Math.max(...ys) + 180;
  const rect = dom.canvasWrap.getBoundingClientRect();
  state.zoom = Math.min(1.3, Math.max(0.6, Math.min(rect.width / (maxX - minX + 120), rect.height / (maxY - minY + 120))));
  state.pan.x = (rect.width - (maxX - minX) * state.zoom) / 2 - minX * state.zoom;
  state.pan.y = (rect.height - (maxY - minY) * state.zoom) / 2 - minY * state.zoom;
  applyTransform();
  renderEdges();
}

export function centerOnNode(nodeId: string): void {
  const node = state.graph?.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const rect = dom.canvasWrap.getBoundingClientRect();
  state.pan.x = rect.width / 2 - (node.position.x + 125) * state.zoom;
  state.pan.y = rect.height / 2 - (node.position.y + 80) * state.zoom;
  applyTransform();
  renderEdges();
}
