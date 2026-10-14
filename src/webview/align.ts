// Unreal's alignment tools (node menu → Alignment; Q and Shift+W/A/S/D): align selected nodes'
// edges or centers, distribute them evenly, and straighten wires by moving nodes so connected
// pins line up.
import { markDirty } from './document';
import { dom, pinElement, setStatus } from './dom';
import { render } from './render';
import { state } from './state';
import { screenPointToWorld } from './view';

export type AlignEdge = 'top' | 'middle' | 'bottom' | 'left' | 'center' | 'right';

interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Selected nodes with their rendered size (offset sizes are in world units: #world is scaled).
function selectedBoxes(): Box[] {
  const graph = state.graph;
  if (!graph) return [];
  return graph.nodes.filter((n) => state.selectedNodeIds.has(n.id)).map((n) => {
    const el = dom.world.querySelector<HTMLElement>(`.node[data-node="${CSS.escape(n.id)}"]`);
    return { id: n.id, x: n.position.x, y: n.position.y, width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 };
  });
}

function move(id: string, x: number, y: number): void {
  const node = state.graph?.nodes.find((n) => n.id === id);
  if (node) node.position = { x, y };
}

function commit(): void {
  markDirty();
  render();
}

export function alignSelection(edge: AlignEdge): void {
  const boxes = selectedBoxes();
  if (boxes.length < 2) {
    setStatus('Select two or more nodes to align them.');
    return;
  }
  const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  for (const b of boxes) {
    switch (edge) {
      case 'top': move(b.id, b.x, Math.min(...boxes.map((o) => o.y))); break;
      case 'bottom': move(b.id, b.x, Math.max(...boxes.map((o) => o.y + o.height)) - b.height); break;
      case 'middle': move(b.id, b.x, average(boxes.map((o) => o.y + o.height / 2)) - b.height / 2); break;
      case 'left': move(b.id, Math.min(...boxes.map((o) => o.x)), b.y); break;
      case 'right': move(b.id, Math.max(...boxes.map((o) => o.x + o.width)) - b.width, b.y); break;
      case 'center': move(b.id, average(boxes.map((o) => o.x + o.width / 2)) - b.width / 2, b.y); break;
    }
  }
  commit();
}

// Equal gaps between the selected nodes; the first and last stay put.
export function distributeSelection(axis: 'horizontal' | 'vertical'): void {
  const boxes = selectedBoxes();
  if (boxes.length < 3) {
    setStatus('Select three or more nodes to distribute them.');
    return;
  }
  const horizontal = axis === 'horizontal';
  const start = (b: Box) => (horizontal ? b.x : b.y);
  const size = (b: Box) => (horizontal ? b.width : b.height);
  boxes.sort((a, b) => start(a) - start(b));
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  const gap = (start(last) + size(last) - start(first) - boxes.reduce((n, b) => n + size(b), 0)) / (boxes.length - 1);
  let cursor = start(first);
  for (const b of boxes) {
    if (horizontal) move(b.id, cursor, b.y);
    else move(b.id, b.x, cursor);
    cursor += size(b) + gap;
  }
  commit();
}

// Moves each selected node vertically so the pin its incoming wire arrives at is level with the pin
// the wire leaves (exec wires first, as they set the flow). Left-to-right, so chains straighten.
export function straightenConnections(): void {
  const graph = state.graph;
  if (!graph || !state.selectedNodeIds.size) return;
  const rect = dom.canvasWrap.getBoundingClientRect();
  // A pin's height below its node's top, measured once (it doesn't change as nodes move).
  const offset = (nodeId: string, pinId: string): number | undefined => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    const el = pinElement(nodeId, pinId);
    if (!node || !el) return undefined;
    const r = el.getBoundingClientRect();
    return screenPointToWorld({ x: r.left, y: r.top + r.height / 2 }, rect).y - node.position.y;
  };
  const kindOf = (nodeId: string, pinId: string) => pinElement(nodeId, pinId)?.dataset.kind;
  const offsets = new Map<string, number | undefined>();
  const cached = (nodeId: string, pinId: string) => {
    const key = `${nodeId} ${pinId}`;
    if (!offsets.has(key)) offsets.set(key, offset(nodeId, pinId));
    return offsets.get(key);
  };

  let straightened = 0;
  const selected = graph.nodes.filter((n) => state.selectedNodeIds.has(n.id)).sort((a, b) => a.position.x - b.position.x);
  for (const node of selected) {
    const incoming = graph.connections.filter((c) => c.toNode === node.id && c.fromNode !== node.id);
    const wire = incoming.find((c) => kindOf(c.toNode, c.toPin) === 'exec') ?? incoming[0];
    const source = wire && graph.nodes.find((n) => n.id === wire.fromNode);
    const from = wire && cached(wire.fromNode, wire.fromPin);
    const to = wire && cached(wire.toNode, wire.toPin);
    if (!source || from === undefined || to === undefined) continue;
    node.position = { x: node.position.x, y: source.position.y + from - to };
    straightened++;
  }
  if (straightened) commit();
  else setStatus('The selected nodes have no incoming wires to straighten.');
}
