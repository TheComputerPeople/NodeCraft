// The Codebase Map's webview (docs/codebase-map.md, Part 3): draws the laid-out scene the extension
// sends, top to bottom, with pan and zoom; double-clicking a box opens it (its contents, or its code).
// Zoomed out, boxes show less.
import type { MapHostMessage, MapMessage } from '../core/codemap/map-protocol';
import type { LaidArrow, LaidBox, LaidScene } from '../core/codemap/scene';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState?(): unknown; setState?(state: unknown): void };
const vscode = acquireVsCodeApi();

const post = (message: MapMessage) => vscode.postMessage(message);
const element = <T extends HTMLElement | SVGElement>(id: string) => document.getElementById(id) as unknown as T;
const canvas = element<HTMLElement>('map-canvas');
const world = element<HTMLElement>('map-world');
const arrowsSvg = element<SVGSVGElement>('map-arrows');
const boxesEl = element<HTMLElement>('map-boxes');
const statusEl = element<HTMLElement>('map-status');
const titleEl = element<HTMLElement>('map-title');

let scene: LaidScene | undefined;
// The box pointed at, and the box clicked (kept until the background is clicked).
let hovered: string | undefined;
let selected: string | undefined;
let pan = { x: 20, y: 20 };
let zoom = 1;
let fitted = false;

const MIN_ZOOM = 0.03;
const MAX_ZOOM = 3;

function applyView(): void {
  world.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  // Levels of detail: zoomed out, details and then small labels go.
  canvas.classList.toggle('far', zoom < 0.45);
  canvas.classList.toggle('very-far', zoom < 0.16);
}

export function fit(): void {
  if (!scene) return;
  const rect = canvas.getBoundingClientRect();
  const margin = 24;
  zoom = Math.max(MIN_ZOOM, Math.min(1, (rect.width - margin * 2) / Math.max(1, scene.width), (rect.height - margin * 2) / Math.max(1, scene.height)));
  pan = { x: (rect.width - scene.width * zoom) / 2, y: margin };
  applyView();
}

const CODE_KINDS = new Set(['file', 'graph-file', 'graph', 'type', 'function']);
// Boxes the call flow can start from.
const CALLABLE_KINDS = new Set(['function', 'type', 'graph', 'graph-file', 'file']);

const KIND_NAMES: Record<string, string> = {
  project: 'project', module: 'folder', file: 'file', 'graph-file': 'graph file', graph: 'graph', type: 'type', function: 'function', external: 'package', externals: 'packages', more: ''
};

function renderBox(box: LaidBox): HTMLElement {
  const el = document.createElement('div');
  el.className = `map-box${box.expanded && scene?.mode !== 'calls' ? ' open' : ''}${box.entry ? ' entry' : ''}${box.cycle ? ' cycle' : ''}${box.root ? ' root' : ''}`;
  el.dataset.id = box.id;
  el.dataset.kind = box.kind;
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
  el.tabIndex = -1;
  el.setAttribute('role', 'treeitem');
  if (box.expandable) el.setAttribute('aria-expanded', String(box.expanded));
  const what = box.detail && box.kind !== 'project' ? box.detail : KIND_NAMES[box.kind] ?? box.kind;
  el.title = [box.label, what, box.path ? `${box.path}${box.line ? `:${box.line}` : ''}` : '', box.entry ? `entry point (${box.entry})` : '', box.expandable ? `${box.count} inside` : '', box.cycle ? 'in an import cycle' : ''].filter(Boolean).join('\n');
  const head = document.createElement('div');
  head.className = 'map-head';
  if (box.expandable) {
    const toggle = document.createElement('button');
    toggle.className = 'map-toggle';
    toggle.textContent = box.expanded ? '▾' : '▸';
    toggle.setAttribute('aria-label', box.expanded ? `Close ${box.label}` : `Open ${box.label}`);
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'toggle', id: box.id });
    });
    head.appendChild(toggle);
  }
  const name = document.createElement('span');
  name.className = 'map-name';
  name.textContent = box.label;
  head.appendChild(name);
  // The call flow from a box (in the call flow itself, from another box).
  if (CALLABLE_KINDS.has(box.kind) && !box.root) {
    const calls = document.createElement('button');
    calls.className = 'map-calls';
    calls.textContent = '⤵';
    calls.title = 'Show its call flow';
    calls.setAttribute('aria-label', `Show the call flow of ${box.label}`);
    calls.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'calls', id: box.id });
    });
    head.appendChild(calls);
  }
  // Boxes with code open it in an editor.
  if (box.path && CODE_KINDS.has(box.kind)) {
    const open = document.createElement('button');
    open.className = 'map-open';
    open.textContent = '↗';
    open.title = box.kind === 'graph-file' || box.kind === 'graph' ? 'Open the graph' : 'Open the code';
    open.setAttribute('aria-label', `Open ${box.label}`);
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'open', id: box.id });
    });
    head.appendChild(open);
  }
  if (box.expandable && !box.expanded && box.kind !== 'more') {
    const count = document.createElement('span');
    count.className = 'map-count';
    count.textContent = String(box.count);
    head.appendChild(count);
  }
  el.appendChild(head);
  if (!box.expanded && box.kind !== 'more') {
    const detail = document.createElement('div');
    detail.className = 'map-detail';
    detail.textContent = what;
    el.appendChild(detail);
  }
  // A type's members (or a graph file's graphs), listed in its box.
  if (box.members?.length) {
    const list = document.createElement('ul');
    list.className = 'map-members';
    for (const member of box.members) {
      const item = document.createElement('li');
      item.textContent = member;
      list.appendChild(item);
    }
    el.appendChild(list);
  }
  el.addEventListener('mouseenter', () => {
    hovered = box.id;
    highlight();
  });
  el.addEventListener('mouseleave', () => {
    if (hovered === box.id) hovered = undefined;
    highlight();
  });
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    selected = selected === box.id ? undefined : box.id;
    highlight();
  });
  // Double-clicking a box that holds others opens or closes it; a box with nothing inside opens its code.
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (box.expandable) post({ type: 'toggle', id: box.id });
    else if (box.path) post({ type: 'open', id: box.id });
  });
  return el;
}

// A routed arrow follows its points; a two-point arrow is a curve, down, or around the left side when
// it points back up.
function arrowPath(arrow: LaidArrow): string {
  const p = arrow.points;
  if (p.length > 2 || p.length < 2) return `M ${p.map((q) => `${q.x} ${q.y}`).join(' L ')}`;
  const [a, b] = p;
  if (arrow.back) {
    const bulge = Math.max(40, Math.abs(a.y - b.y) * 0.25);
    return `M ${a.x} ${a.y} C ${a.x - bulge} ${a.y}, ${b.x - bulge} ${b.y}, ${b.x} ${b.y}`;
  }
  const dy = Math.max(20, (b.y - a.y) / 2);
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
}

// The arrows of the box pointed at (or selected), and of everything inside it, drawn over the map
// (which dims), with the boxes they reach marked.
function highlight(): void {
  if (!scene) return;
  arrowsSvg.querySelector('#map-highlight')?.remove();
  for (const el of boxesEl.querySelectorAll('.map-box.active, .map-box.linked')) el.classList.remove('active', 'linked');
  const active = hovered ?? selected;
  arrowsSvg.classList.toggle('focused', !!active);
  if (!active) return;
  const parents = new Map(scene.boxes.map((b) => [b.id, b.parent]));
  const within = (id: string): boolean => {
    for (let p: string | undefined = id; p; p = parents.get(p)) if (p === active) return true;
    return false;
  };
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.id = 'map-highlight';
  const linked = new Set<string>();
  for (const arrow of scene.details) {
    const out = within(arrow.from);
    const into = within(arrow.to);
    if (out === into) continue;
    linked.add(out ? arrow.to : arrow.from);
    group.appendChild(arrowElement(arrow, ' highlight'));
  }
  arrowsSvg.appendChild(group);
  boxesEl.querySelector(`.map-box[data-id="${CSS.escape(active)}"]`)?.classList.add('active');
  for (const id of linked) boxesEl.querySelector(`.map-box[data-id="${CSS.escape(id)}"]`)?.classList.add('linked');
}

function arrowElement(arrow: LaidArrow, extra = ''): SVGPathElement {
  const ns = 'http://www.w3.org/2000/svg';
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', arrowPath(arrow));
  path.setAttribute('class', `map-arrow ${arrow.kind}${arrow.certain ? '' : ' guess'}${arrow.back ? ' back' : ''}${arrow.cycle ? ' cycle' : ''}${extra}`);
  path.setAttribute('stroke-width', String(1.2 + Math.log2(arrow.weight)));
  path.setAttribute('marker-end', `url(#head-${arrow.kind})`);
  path.dataset.from = arrow.from;
  path.dataset.to = arrow.to;
  const title = document.createElementNS(ns, 'title');
  title.textContent = `${arrow.kind === 'inherits' ? 'extends' : arrow.kind}${arrow.weight > 1 ? ` (${arrow.weight})` : ''}${arrow.certain ? '' : ', guessed'}${arrow.cycle ? ', in an import cycle' : ''}`;
  path.appendChild(title);
  return path;
}

function render(): void {
  if (!scene) return;
  boxesEl.textContent = '';
  // Outer boxes first, so inner ones are drawn over them.
  for (const box of scene.boxes) boxesEl.appendChild(renderBox(box));
  arrowsSvg.setAttribute('width', String(Math.max(1, scene.width)));
  arrowsSvg.setAttribute('height', String(Math.max(1, scene.height)));
  const ns = 'http://www.w3.org/2000/svg';
  arrowsSvg.textContent = '';
  const defs = document.createElementNS(ns, 'defs');
  for (const kind of ['imports', 'calls', 'inherits']) {
    const marker = document.createElementNS(ns, 'marker');
    marker.setAttribute('id', `head-${kind}`);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto-start-reverse');
    const head = document.createElementNS(ns, 'path');
    head.setAttribute('d', kind === 'inherits' ? 'M 0 0 L 10 5 L 0 10 z' : 'M 0 0 L 10 5 L 0 10 L 3 5 z');
    head.setAttribute('class', `map-arrowhead ${kind}`);
    marker.appendChild(head);
    defs.appendChild(marker);
  }
  arrowsSvg.appendChild(defs);
  for (const arrow of scene.arrows) arrowsSvg.appendChild(arrowElement(arrow));
  // A selected box that's gone (closed, or its file deleted) is no longer selected.
  if (selected && !scene.boxes.some((b) => b.id === selected)) selected = undefined;
  highlight();
  const shown = scene.boxes.length;
  statusEl.textContent = `${shown.toLocaleString()} box${shown === 1 ? '' : 'es'} · ${scene.arrows.length.toLocaleString()} arrow${scene.arrows.length === 1 ? '' : 's'}`;
  if (!fitted) {
    fitted = true;
    fit();
  } else {
    applyView();
  }
}

// Pan by dragging the background; zoom with the wheel, around the pointer.
let drag: { x: number; y: number; panX: number; panY: number } | undefined;
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
  if (e.button === 0 && e.target instanceof Element && e.target.closest('button')) return;
  drag = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  canvas.classList.add('panning');
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  pan = { x: drag.panX + e.clientX - drag.x, y: drag.panY + e.clientY - drag.y };
  applyView();
});
window.addEventListener('mouseup', (e) => {
  // A press on the background that didn't pan lets go of the selected box.
  const moved = drag && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3;
  if (drag && !moved && selected && !(e.target instanceof Element && e.target.closest('.map-box'))) {
    selected = undefined;
    highlight();
  }
  drag = undefined;
  canvas.classList.remove('panning');
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * Math.exp(-e.deltaY * 0.0015)));
  pan = { x: mx - ((mx - pan.x) / zoom) * next, y: my - ((my - pan.y) / zoom) * next };
  zoom = next;
  applyView();
}, { passive: false });
element<HTMLElement>('map-fit').addEventListener('click', fit);
const callsBar = element<HTMLElement>('map-calls');
const rootLabel = element<HTMLElement>('map-root-label');
const rootClear = element<HTMLElement>('map-root-clear');
rootClear.addEventListener('click', () => post({ type: 'calls' }));
for (const button of document.querySelectorAll<HTMLElement>('.map-direction')) {
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-checked') !== 'true') post({ type: 'direction', direction: button.dataset.direction as 'callees' | 'callers' });
  });
}
for (const button of document.querySelectorAll<HTMLElement>('.map-mode')) {
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-checked') !== 'true') post({ type: 'mode', mode: button.dataset.mode as 'architecture' | 'structure' | 'calls' });
  });
}
canvas.addEventListener('keydown', (e) => {
  if (e.key === 'Home') {
    fit();
    e.preventDefault();
  }
});

window.addEventListener('message', (event: MessageEvent<MapHostMessage>) => {
  const message = event.data;
  if (message.type === 'scene' && message.scene) {
    // A new view starts fitted.
    if (scene && scene.mode !== message.scene.mode) fitted = false;
    scene = message.scene;
    if (message.title) titleEl.textContent = message.title;
    for (const button of document.querySelectorAll<HTMLElement>('.map-mode')) button.setAttribute('aria-checked', String(button.dataset.mode === scene.mode));
    // The call flow's bar: its direction and where it starts.
    callsBar.hidden = scene.mode !== 'calls';
    if (scene.calls) {
      for (const button of document.querySelectorAll<HTMLElement>('.map-direction')) button.setAttribute('aria-checked', String(button.dataset.direction === scene.calls.direction));
      rootLabel.textContent = scene.calls.rootLabel ? `${scene.calls.direction === 'callers' ? 'Callers of' : 'From'} ${scene.calls.rootLabel}` : `From the entry points (${scene.calls.starts})`;
      rootClear.hidden = !scene.calls.root;
    }
    render();
  } else if (message.type === 'status' && message.text !== undefined) {
    statusEl.textContent = message.text;
  }
});

post({ type: 'ready' });
