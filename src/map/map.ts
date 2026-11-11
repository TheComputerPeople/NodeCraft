// The Codebase Map's webview (docs/codebase-map.md, Part 3): draws the laid-out scene the extension
// sends, top to bottom, with pan and zoom; double-clicking a box opens it (its contents, or its code).
// Zoomed out, boxes show less.
import type { FoundEntity, MapFilters } from '../core/codemap/find';
import type { DeclarationSummary } from '../core/codemap/hover';
import type { MapHostMessage, MapMessage } from '../core/codemap/map-protocol';
import type { CallDirection, LaidArrow, LaidBox, LaidScene } from '../core/codemap/scene';

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
// The box being opened or closed, and where it was on the screen: the map is laid out again, and
// moves so that box stays where it was (the rest moves around it, not it away from the pointer).
let anchor: { id: string; x: number; y: number } | undefined;

function toggleBox(box: LaidBox): void {
  anchor = { id: box.id, x: pan.x + box.x * zoom, y: pan.y + box.y * zoom };
  post({ type: 'toggle', id: box.id });
}

const MIN_ZOOM = 0.03;
const MAX_ZOOM = 3;

function applyView(): void {
  world.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  // Levels of detail: zoomed out, details and then small labels go.
  canvas.classList.toggle('far', zoom < 0.45);
  canvas.classList.toggle('very-far', zoom < 0.16);
  drawMinimap();
  hideHover();
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
const FLOW_SHAPES: Record<string, string> = { decision: '◇', loop: '↻', switch: '⋔', catch: '⚠', finally: '⤓', return: '⏎', throw: '⚡', break: '⇥', continue: '↺', await: '⏳' };

const KIND_NAMES: Record<string, string> = {
  project: 'project', module: 'folder', file: 'file', 'graph-file': 'graph file', graph: 'graph', type: 'type', function: 'function', external: 'package', externals: 'packages', more: ''
};

function renderBox(box: LaidBox): HTMLElement {
  const el = document.createElement('div');
  el.className = `map-box${box.expanded && scene?.mode !== 'calls' ? ' open' : ''}${box.entry ? ' entry' : ''}${box.cycle ? ' cycle' : ''}${box.root ? ' root' : ''}${box.flowKind ? ` flow-${box.flowKind}` : ''}`;
  el.dataset.id = box.id;
  el.dataset.kind = box.kind;
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
  el.tabIndex = -1;
  if (box.kind === 'flow') return renderFlowBox(box, el);
  el.setAttribute('role', 'treeitem');
  if (box.expandable) el.setAttribute('aria-expanded', String(box.expanded));
  const what = whatOf(box);
  // (A type's or function's hover card says this, with its signature and doc comment.)
  if (!hasHover(box)) el.title = [box.label, ...aboutBox(box)].join('\n');
  const head = document.createElement('div');
  head.className = 'map-head';
  if (box.expandable) {
    const toggle = document.createElement('button');
    toggle.className = 'map-toggle';
    toggle.textContent = box.expanded ? '▾' : '▸';
    toggle.setAttribute('aria-label', box.expanded ? `Close ${box.label}` : `Open ${box.label}`);
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBox(box);
    });
    head.appendChild(toggle);
  }
  const name = document.createElement('span');
  name.className = 'map-name';
  name.textContent = box.label;
  head.appendChild(name);
  // A function's control flow.
  if (box.kind === 'function') {
    const flow = document.createElement('button');
    flow.className = 'map-flow-open';
    flow.textContent = '⧉';
    flow.title = 'Show its control flow';
    flow.setAttribute('aria-label', `Show the control flow of ${box.label}`);
    flow.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'flow', id: box.id });
    });
    head.appendChild(flow);
  }
  // The call flow from a box (in the call flow itself, from another box).
  if (CALLABLE_KINDS.has(box.kind) && !box.root) {
    const calls = document.createElement('button');
    calls.className = 'map-calls';
    calls.textContent = '⤵';
    calls.title = 'Show its call flow';
    calls.setAttribute('aria-label', `Show the call flow of ${box.label}`);
    calls.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'calls', id: entityOf(box) });
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
    if (hasHover(box)) scheduleHover(box);
  });
  el.addEventListener('mouseleave', () => {
    if (hovered === box.id) hovered = undefined;
    highlight();
    if (hoverFor === box.id) hideHover();
  });
  // (A button's own tooltip, not the card.)
  el.addEventListener('mouseover', (e) => {
    if (hoverFor === box.id && e.target instanceof Element && e.target.closest('button')) hideHover();
  });
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    clickBox(box);
  });
  // Double-clicking a box that holds others opens or closes it; a box with nothing inside opens its code.
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (box.expandable) toggleBox(box);
    else if (box.path) post({ type: 'open', id: box.id });
  });
  return el;
}

function whatOf(box: LaidBox): string {
  return box.detail && box.kind !== 'project' ? box.detail : KIND_NAMES[box.kind] ?? box.kind;
}

// What a box's tooltip says under its name.
function aboutBox(box: LaidBox): string[] {
  return [whatOf(box), box.path ? `${box.path}${box.line ? `:${box.line}` : ''}` : '', box.entry ? `entry point (${box.entry})` : '', box.expandable ? (scene?.mode === 'calls' ? `${box.count} more to explore` : `${box.count} inside`) : '', box.cycle ? 'in an import cycle' : ''].filter(Boolean);
}

// Hovering a type's or function's box (or reaching it with the keys) shows a card with its
// signature and doc comment, which the extension reads from its code.
const hoverCard = element<HTMLElement>('map-hover');
const HOVER_KINDS = new Set(['type', 'function']);
// By entity id (null: its code has none); cleared with each scene, as the code may have changed.
const summaries = new Map<string, DeclarationSummary | null>();
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
// The box whose card is shown, or asked for.
let hoverFor: string | undefined;
const HOVER_DELAY = 450;

function hasHover(box: LaidBox): boolean {
  return HOVER_KINDS.has(box.kind) && !!box.path && box.line !== undefined;
}

function scheduleHover(box: LaidBox): void {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => requestHover(box), HOVER_DELAY);
}

function requestHover(box: LaidBox): void {
  hoverFor = box.id;
  if (summaries.has(entityOf(box))) showHover(box);
  else post({ type: 'hover', id: entityOf(box) });
}

function showHover(box: LaidBox): void {
  const el = boxesEl.querySelector<HTMLElement>(`.map-box[data-id="${CSS.escape(box.id)}"]`);
  if (hoverFor !== box.id || !menu.hidden || !el) return;
  const summary = summaries.get(entityOf(box));
  hoverCard.textContent = '';
  const signature = document.createElement('code');
  signature.className = 'map-hover-signature';
  signature.textContent = summary?.signature ?? box.label;
  hoverCard.appendChild(signature);
  if (summary?.doc) {
    const doc = document.createElement('div');
    doc.className = 'map-hover-doc';
    doc.textContent = summary.doc;
    hoverCard.appendChild(doc);
  }
  const about = document.createElement('div');
  about.className = 'map-hover-about';
  about.textContent = aboutBox(box).join(' · ');
  hoverCard.appendChild(about);
  hoverCard.hidden = false;
  const rect = el.getBoundingClientRect();
  const card = hoverCard.getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + card.height > window.innerHeight - 2) top = Math.max(2, rect.top - card.height - 6);
  hoverCard.style.left = `${Math.max(2, Math.min(rect.left, window.innerWidth - card.width - 2))}px`;
  hoverCard.style.top = `${top}px`;
  el.setAttribute('aria-describedby', 'map-hover');
}

function hideHover(): void {
  clearTimeout(hoverTimer);
  if (hoverFor) boxesEl.querySelector(`.map-box[data-id="${CSS.escape(hoverFor)}"]`)?.removeAttribute('aria-describedby');
  hoverFor = undefined;
  hoverCard.hidden = true;
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

// A flowchart's box: a mark for what it is, its code (or condition, or loop head), and the calls made
// on its lines, each opening its callee's flowchart. Double-clicking it shows its code.
function renderFlowBox(box: LaidBox, el: HTMLElement): HTMLElement {
  el.title = `${box.label}${box.detail ? `\n${box.detail}` : ''}${box.line ? `\nDouble-click: the code at line ${box.line}` : ''}`;
  const head = document.createElement('div');
  head.className = 'map-head';
  const mark = FLOW_SHAPES[box.flowKind ?? ''];
  if (mark) {
    const shape = document.createElement('span');
    shape.className = 'flow-mark';
    shape.textContent = mark;
    head.appendChild(shape);
  }
  const name = document.createElement('span');
  name.className = 'map-name';
  name.textContent = box.label;
  head.appendChild(name);
  el.appendChild(head);
  if (box.detail) {
    const detail = document.createElement('div');
    detail.className = 'map-detail';
    detail.textContent = box.detail;
    el.appendChild(detail);
  }
  if (box.members?.length) {
    const code = document.createElement('ul');
    code.className = 'map-members flow-code';
    for (const line of box.members) {
      const item = document.createElement('li');
      item.textContent = line;
      code.appendChild(item);
    }
    el.appendChild(code);
  }
  if (box.calls?.length) {
    const calls = document.createElement('div');
    calls.className = 'flow-calls';
    for (const call of box.calls) {
      const chip = document.createElement(call.id ? 'button' : 'span');
      chip.className = 'flow-call';
      chip.textContent = `→ ${call.label}`;
      if (call.id) {
        chip.title = `Open ${call.label.replace(/\?$/, '')}'s control flow`;
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          post({ type: 'flow', id: call.id! });
        });
      } else {
        chip.title = 'The index couldn\'t tell which function this is';
      }
      calls.appendChild(chip);
    }
    el.appendChild(calls);
  }
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (box.line) post({ type: 'openLine', line: box.line });
  });
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    clickBox(box);
  });
  return el;
}

// The entity a box stands for (a file's group in the call flow stands for its file).
function entityOf(box: LaidBox): string {
  return box.id.startsWith('in:') ? box.id.slice('in:'.length) : box.id;
}

// A click selects a box (or lets it go); while picking where a path leads, it's the path's end.
function clickBox(box: LaidBox): void {
  if (pathFrom) {
    if (CALLABLE_KINDS.has(box.kind) && entityOf(box) !== pathFrom.id) finishPath(entityOf(box));
    return;
  }
  select(selected === box.id ? undefined : box.id);
}

function select(id: string | undefined): void {
  selected = id;
  highlight();
}

// The arrows of the box pointed at (or selected), and of everything inside it, drawn over the map
// (which dims), with the boxes they reach marked.
function highlight(): void {
  if (!scene) return;
  showCrumbs();
  drawMinimap();
  const current = selected ? boxesEl.querySelector(`.map-box[data-id="${CSS.escape(selected)}"]`) : null;
  if (current?.id) canvas.setAttribute('aria-activedescendant', current.id);
  else canvas.removeAttribute('aria-activedescendant');
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
  scene.boxes.forEach((box, i) => {
    const el = renderBox(box);
    el.id = `map-box-${i}`;
    if (pathFrom && entityOf(box) === pathFrom.id) el.classList.add('path-start');
    boxesEl.appendChild(el);
  });
  arrowsSvg.setAttribute('width', String(Math.max(1, scene.width)));
  arrowsSvg.setAttribute('height', String(Math.max(1, scene.height)));
  const ns = 'http://www.w3.org/2000/svg';
  arrowsSvg.textContent = '';
  const defs = document.createElementNS(ns, 'defs');
  for (const kind of ['imports', 'calls', 'inherits', 'flow']) {
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
  for (const arrow of scene.arrows) {
    arrowsSvg.appendChild(arrowElement(arrow));
    // A flowchart's arrows say which way they go (true, false, a case, loop, done…), by their end,
    // where branches that leave a decision together have parted.
    if (arrow.label && arrow.points.length) {
      const end = arrow.points[arrow.points.length - 1];
      const before = arrow.points[arrow.points.length - 2] ?? end;
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('class', `map-arrow-label${arrow.label === 'true' ? ' yes' : arrow.label === 'false' ? ' no' : ''}`);
      // Just before the box it reaches: beside a last stretch going down, above one going across.
      const down = Math.abs(before.x - end.x) < Math.abs(before.y - end.y);
      text.setAttribute('x', String(end.x + (down ? 5 : (before.x < end.x ? -6 : 6))));
      // (An arrow coming back up into a box ends at its bottom: the label goes below it.)
      text.setAttribute('y', String(end.y + (down ? (before.y > end.y ? 12 : -6) : -4)));
      if (!down && before.x < end.x) text.setAttribute('text-anchor', 'end');
      text.textContent = arrow.label;
      arrowsSvg.appendChild(text);
    }
  }
  // A selected box that's gone (closed, or its file deleted) is no longer selected.
  if (selected && !scene.boxes.some((b) => b.id === selected)) selected = undefined;
  highlight();
  const shown = scene.boxes.length;
  statusEl.textContent = `${shown.toLocaleString()} box${shown === 1 ? '' : 'es'} · ${scene.arrows.length.toLocaleString()} arrow${scene.arrows.length === 1 ? '' : 's'}`;
  const kept = anchor && scene.boxes.find((b) => b.id === anchor!.id);
  if (!fitted) {
    fitted = true;
    fit();
  } else {
    if (kept && anchor) pan = { x: anchor.x - kept.x * zoom, y: anchor.y - kept.y * zoom };
    applyView();
  }
  anchor = undefined;
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
  const onBox = e.target instanceof Element ? e.target.closest<HTMLElement>('.map-box') : null;
  if (drag && !moved && e.button === 2 && onBox && scene) {
    const box = scene.boxes.find((b) => b.id === onBox.dataset.id);
    if (box) {
      select(box.id);
      showMenu(box, e.clientX, e.clientY);
    }
  } else if (drag && !moved && e.button === 0 && selected && !onBox) {
    select(undefined);
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
const flowBar = element<HTMLElement>('map-flow');
const flowLabel = element<HTMLElement>('map-flow-label');
const callsBar = element<HTMLElement>('map-calls');
const rootLabel = element<HTMLElement>('map-root-label');
const rootClear = element<HTMLElement>('map-root-clear');
const depthSelect = element<HTMLSelectElement>('map-depth');
// The × leaves a path for the call flow from its start; otherwise it starts from the entry points.
rootClear.addEventListener('click', () => post(scene?.calls?.path ? { type: 'calls', id: scene.calls.path.from, direction: 'callees' } : { type: 'calls' }));
depthSelect.addEventListener('change', () => post({ type: 'depth', depth: Number(depthSelect.value) }));
for (const button of document.querySelectorAll<HTMLElement>('.map-direction')) {
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-checked') !== 'true') post({ type: 'direction', direction: button.dataset.direction as CallDirection });
  });
}

// Back and Forward, through the places the map has been.
const backButton = element<HTMLButtonElement>('map-back');
const forwardButton = element<HTMLButtonElement>('map-forward');
backButton.addEventListener('click', () => post({ type: 'history', direction: 'back' }));
forwardButton.addEventListener('click', () => post({ type: 'history', direction: 'forward' }));
window.addEventListener('mouseup', (e) => {
  if (e.button === 3 && !backButton.disabled) post({ type: 'history', direction: 'back' });
  if (e.button === 4 && !forwardButton.disabled) post({ type: 'history', direction: 'forward' });
});

// The breadcrumb: the selected box and the boxes holding it, each a click away.
const crumbs = element<HTMLElement>('map-crumbs');
function showCrumbs(): void {
  crumbs.textContent = '';
  const byId = new Map((scene?.boxes ?? []).map((b) => [b.id, b]));
  const chain: LaidBox[] = [];
  for (let b = selected ? byId.get(selected) : undefined; b; b = b.parent ? byId.get(b.parent) : undefined) chain.unshift(b);
  if (!chain.length) {
    const none = document.createElement('li');
    none.className = 'map-crumb-none';
    none.textContent = 'Select a box to see where it is';
    crumbs.appendChild(none);
    return;
  }
  for (const box of chain) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = box.label;
    button.title = `${box.label} (${KIND_NAMES[box.kind] || box.kind})`;
    button.dataset.id = box.id;
    button.addEventListener('click', () => {
      select(box.id);
      centreOn(box.id);
    });
    item.appendChild(button);
    crumbs.appendChild(item);
  }
}

// A box's menu: what can be done with it.
const menu = element<HTMLElement>('map-menu');
let menuActive = 0;

function menuItems(box: LaidBox): ({ label: string; run: () => void } | 'separator')[] {
  const id = entityOf(box);
  const items: ({ label: string; run: () => void } | 'separator')[] = [];
  if (box.kind === 'flow') {
    if (box.line) items.push({ label: `Show the code (line ${box.line})`, run: () => post({ type: 'openLine', line: box.line! }) });
    return items;
  }
  if (box.path && CODE_KINDS.has(box.kind)) items.push({ label: box.kind === 'graph-file' || box.kind === 'graph' ? 'Open the graph' : 'Open the code', run: () => post({ type: 'open', id }) });
  if (box.expandable) {
    const calls = scene?.mode === 'calls';
    items.push({ label: calls ? (box.expanded ? 'Show fewer calls' : 'Show more calls') : box.expanded ? 'Close' : 'Open', run: () => toggleBox(box) });
  }
  if (CALLABLE_KINDS.has(box.kind)) {
    items.push('separator');
    items.push({ label: 'Call flow from here', run: () => post({ type: 'calls', id, direction: 'callees' }) });
    items.push({ label: 'Callers', run: () => post({ type: 'calls', id, direction: 'callers' }) });
    items.push({ label: 'Focus: its callers and calls', run: () => post({ type: 'calls', id, direction: 'both' }) });
    if (box.kind === 'function' || box.kind === 'type') items.push({ label: 'Control flow', run: () => post({ type: 'flow', id }) });
    items.push('separator');
    if (pathFrom && pathFrom.id !== id) items.push({ label: `Path from ${pathFrom.label} to here`, run: () => finishPath(id) });
    items.push({ label: 'Path from here to…', run: () => startPath(id, box.label) });
  }
  // The bridge into Blueprint: the function made a node.
  if (box.kind === 'function' && box.path) {
    items.push('separator');
    items.push({ label: 'Expose as Node', run: () => post({ type: 'expose', id }) });
  }
  return items;
}

function showMenu(box: LaidBox, x: number, y: number): void {
  const items = menuItems(box);
  if (!items.length) return;
  hideHover();
  menu.textContent = '';
  for (const item of items) {
    const li = document.createElement('li');
    if (item === 'separator') {
      li.setAttribute('role', 'separator');
    } else {
      li.setAttribute('role', 'menuitem');
      li.tabIndex = -1;
      li.textContent = item.label;
      li.addEventListener('mousedown', (e) => e.stopPropagation());
      li.addEventListener('click', () => {
        closeMenu();
        item.run();
      });
    }
    menu.appendChild(li);
  }
  // (A separator first or last, or two together, isn't drawn.)
  for (const li of [...menu.children]) {
    const prev = li.previousElementSibling;
    if (li.getAttribute('role') === 'separator' && (!prev || prev.getAttribute('role') === 'separator' || !li.nextElementSibling)) li.remove();
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(2, Math.min(x, window.innerWidth - rect.width - 2))}px`;
  menu.style.top = `${Math.max(2, Math.min(y, window.innerHeight - rect.height - 2))}px`;
  menuActive = 0;
  focusMenuItem();
}

function focusMenuItem(): void {
  const entries = [...menu.querySelectorAll<HTMLElement>('li[role="menuitem"]')];
  entries.forEach((li, i) => li.classList.toggle('active', i === menuActive));
  entries[menuActive]?.focus();
}

function closeMenu(): void {
  if (menu.hidden) return;
  menu.hidden = true;
  canvas.focus();
}

menu.addEventListener('keydown', (e) => {
  const entries = [...menu.querySelectorAll<HTMLElement>('li[role="menuitem"]')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    menuActive = (menuActive + (e.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length;
    focusMenuItem();
  } else if (e.key === 'Enter' || e.key === ' ') {
    entries[menuActive]?.click();
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    closeMenu();
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
});
window.addEventListener('mousedown', (e) => {
  if (!menu.hidden && !(e.target instanceof Element && e.target.closest('#map-menu'))) closeMenu();
});

// A path: its start chosen from a box's menu, then its end picked (a click, or Find).
const pickingEl = element<HTMLElement>('map-picking');
let pathFrom: { id: string; label: string } | undefined;

function startPath(id: string, label: string): void {
  pathFrom = { id, label };
  pickingEl.textContent = `Path from ${label}: pick where it leads (Esc to stop)`;
  pickingEl.hidden = false;
  canvas.classList.add('picking');
  render();
}

function finishPath(to: string): void {
  const from = pathFrom?.id;
  stopPath();
  if (from && from !== to) post({ type: 'path', from, to });
}

function stopPath(): void {
  if (!pathFrom) return;
  pathFrom = undefined;
  pickingEl.hidden = true;
  canvas.classList.remove('picking');
  boxesEl.querySelector('.map-box.path-start')?.classList.remove('path-start');
}

// The minimap: the whole map small, with the view's place on it; a click or drag moves the view there.
// It shows only when the map doesn't fit the view.
const minimap = element<HTMLCanvasElement>('map-minimap');
const MINIMAP = { width: 180, height: 120 };
let minimapScale = 1;

function drawMinimap(): void {
  if (!scene || !scene.boxes.length) {
    minimap.hidden = true;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const view = { x: -pan.x / zoom, y: -pan.y / zoom, width: rect.width / zoom, height: rect.height / zoom };
  const whole = view.x <= 0 && view.y <= 0 && view.x + view.width >= scene.width && view.y + view.height >= scene.height;
  minimap.hidden = whole;
  if (whole) return;
  minimapScale = Math.min(MINIMAP.width / Math.max(1, scene.width), MINIMAP.height / Math.max(1, scene.height));
  const width = Math.max(24, Math.round(scene.width * minimapScale));
  const height = Math.max(24, Math.round(scene.height * minimapScale));
  const ratio = window.devicePixelRatio || 1;
  if (minimap.width !== width * ratio || minimap.height !== height * ratio) {
    minimap.width = width * ratio;
    minimap.height = height * ratio;
    minimap.style.width = `${width}px`;
    minimap.style.height = `${height}px`;
  }
  const g = minimap.getContext('2d');
  if (!g) return;
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue('--muted').trim() || '#999';
  const accent = style.getPropertyValue('--accent').trim() || '#007acc';
  g.setTransform(ratio * minimapScale, 0, 0, ratio * minimapScale, 0, 0);
  g.clearRect(0, 0, scene.width, scene.height);
  for (const box of scene.boxes) {
    const open = box.expanded && scene.boxes.some((b) => b.parent === box.id);
    if (open) {
      g.globalAlpha = 0.5;
      g.strokeStyle = muted;
      g.lineWidth = 1 / minimapScale;
      g.strokeRect(box.x, box.y, box.width, box.height);
    } else {
      g.globalAlpha = box.id === selected ? 1 : 0.45;
      g.fillStyle = box.id === selected ? accent : muted;
      g.fillRect(box.x, box.y, box.width, box.height);
    }
  }
  g.globalAlpha = 1;
  g.strokeStyle = accent;
  g.lineWidth = 2 / minimapScale;
  g.strokeRect(view.x, view.y, view.width, view.height);
}

// Moves the view so a point of the map (from the minimap) is in its middle.
function minimapTo(e: MouseEvent): void {
  const at = minimap.getBoundingClientRect();
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - at.left) / minimapScale;
  const y = (e.clientY - at.top) / minimapScale;
  pan = { x: rect.width / 2 - x * zoom, y: rect.height / 2 - y * zoom };
  applyView();
}

let minimapDrag = false;
minimap.addEventListener('mousedown', (e) => {
  e.stopPropagation();
  e.preventDefault();
  minimapDrag = true;
  minimapTo(e);
});
window.addEventListener('mousemove', (e) => {
  if (minimapDrag) minimapTo(e);
});
window.addEventListener('mouseup', () => {
  minimapDrag = false;
});

// Keyboard: the arrow keys move the selection (up and down along the arrows, left and right beside
// it), Enter opens a box, Shift+F10 shows its menu; + and - zoom; Home fits; Alt+Left and Alt+Right
// go back and forward.
const announcer = document.createElement('div');
announcer.className = 'map-announce';
announcer.setAttribute('aria-live', 'polite');
announcer.setAttribute('role', 'status');
Object.assign(announcer.style, { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' });
document.body.appendChild(announcer);
// The boxes the last move along the arrows could have gone to (Left and Right go between them).
let followed: { from: string; to: string[] } | undefined;

const middle = (b: LaidBox) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

function within(id: string, holder: string, byId: Map<string, LaidBox>): boolean {
  for (let b = byId.get(id); b; b = b.parent ? byId.get(b.parent) : undefined) if (b.id === holder) return true;
  return false;
}

// The boxes the arrows of a box (and of what's inside it) lead to, or come from.
function alongArrows(box: LaidBox, down: boolean, byId: Map<string, LaidBox>): LaidBox[] {
  if (!scene) return [];
  const arrows = scene.details.length ? scene.details : scene.arrows;
  const ends = new Set<string>();
  for (const a of arrows) {
    const [near, far] = down ? [a.from, a.to] : [a.to, a.from];
    if (within(near, box.id, byId) && !within(far, box.id, byId)) ends.add(far);
  }
  return [...ends].map((id) => byId.get(id)!).filter(Boolean).sort((a, b) => middle(a).x - middle(b).x);
}

function moveSelection(key: string, alt: boolean): void {
  if (!scene || !scene.boxes.length) return;
  const byId = new Map(scene.boxes.map((b) => [b.id, b]));
  const current = selected ? byId.get(selected) : undefined;
  if (!current) {
    const top = scene.boxes.filter((b) => !b.parent).sort((a, b) => a.y - b.y || a.x - b.x)[0];
    goTo(top, undefined);
    return;
  }
  const here = middle(current);
  if (alt) {
    // Into the box (its first box, if it's open) or out of it.
    const target = key === 'ArrowDown'
      ? scene.boxes.filter((b) => b.parent === current.id).sort((a, b) => a.y - b.y || a.x - b.x)[0]
      : current.parent ? byId.get(current.parent) : undefined;
    goTo(target, undefined);
    return;
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    // Between the boxes the last move along the arrows could have reached; otherwise beside it.
    if (followed && followed.to.includes(current.id)) {
      const i = followed.to.indexOf(current.id) + (key === 'ArrowRight' ? 1 : -1);
      const next = followed.to[(i + followed.to.length) % followed.to.length];
      goTo(byId.get(next), followed);
      return;
    }
    const right = key === 'ArrowRight';
    const beside = scene.boxes
      .filter((b) => b.parent === current.parent && b.id !== current.id && (right ? middle(b).x > here.x : middle(b).x < here.x))
      .sort((a, b) => cost(a) - cost(b))[0];
    goTo(beside, undefined);
    return;
  }
  const down = key === 'ArrowDown';
  const ends = alongArrows(current, down, byId);
  if (ends.length) {
    const nearest = [...ends].sort((a, b) => Math.hypot(middle(a).x - here.x, middle(a).y - here.y) - Math.hypot(middle(b).x - here.x, middle(b).y - here.y))[0];
    goTo(nearest, { from: current.id, to: ends.map((b) => b.id) });
    return;
  }
  // No arrows that way: the nearest box beside it, below or above.
  const next = scene.boxes
    .filter((b) => b.parent === current.parent && b.id !== current.id && (down ? middle(b).y > here.y : middle(b).y < here.y))
    .sort((a, b) => cost(a) - cost(b))[0];
  goTo(next, undefined);

  function cost(b: LaidBox): number {
    const m = middle(b);
    return Math.abs(m.x - here.x) + Math.abs(m.y - here.y) * 2;
  }
}

function goTo(box: LaidBox | undefined, along: typeof followed): void {
  if (!box) return;
  followed = along;
  select(box.id);
  scrollIntoView(box);
  // (Its card, at once: the keys' hover.)
  hideHover();
  if (hasHover(box)) requestHover(box);
  const ways = along && along.to.length > 1 ? ` (${along.to.indexOf(box.id) + 1} of ${along.to.length}: Left and Right for the others)` : '';
  announcer.textContent = `${box.label}, ${KIND_NAMES[box.kind] || box.flowKind || box.kind}${box.detail ? `, ${box.detail}` : ''}${ways}`;
}

// Pans so a box is in view (without zooming), if it isn't.
function scrollIntoView(box: LaidBox): void {
  const rect = canvas.getBoundingClientRect();
  const left = pan.x + box.x * zoom;
  const top = pan.y + box.y * zoom;
  const right = left + box.width * zoom;
  const bottom = top + box.height * zoom;
  const margin = 24;
  if (left >= margin && top >= margin && right <= rect.width - margin && bottom <= rect.height - margin) return;
  if (box.width * zoom > rect.width - margin * 2 || box.height * zoom > rect.height - margin * 2) {
    pan = { x: rect.width / 2 - (box.x + box.width / 2) * zoom, y: margin - box.y * zoom };
  } else {
    pan = {
      x: left < margin ? pan.x + margin - left : right > rect.width - margin ? pan.x - (right - rect.width + margin) : pan.x,
      y: top < margin ? pan.y + margin - top : bottom > rect.height - margin ? pan.y - (bottom - rect.height + margin) : pan.y
    };
  }
  applyView();
}

function zoomBy(factor: number): void {
  const rect = canvas.getBoundingClientRect();
  const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
  pan = { x: rect.width / 2 - ((rect.width / 2 - pan.x) / zoom) * next, y: rect.height / 2 - ((rect.height / 2 - pan.y) / zoom) * next };
  zoom = next;
  applyView();
}
for (const button of document.querySelectorAll<HTMLElement>('.map-mode')) {
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-checked') !== 'true') post({ type: 'mode', mode: button.dataset.mode as 'architecture' | 'structure' | 'calls' | 'flow' });
  });
}
canvas.addEventListener('keydown', (e) => {
  const box = selected ? scene?.boxes.find((b) => b.id === selected) : undefined;
  if (e.key === 'Home') {
    fit();
  } else if (e.key.startsWith('Arrow') && !e.ctrlKey && !e.metaKey) {
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    moveSelection(e.key, e.altKey);
  } else if (e.key === 'Enter' && box) {
    if (box.kind === 'flow') {
      if (box.line) post({ type: 'openLine', line: box.line });
    } else if (pathFrom) {
      clickBox(box);
    } else if (e.ctrlKey || e.metaKey || e.shiftKey || !box.expandable) {
      if (box.path) post({ type: 'open', id: entityOf(box) });
    } else {
      toggleBox(box);
    }
  } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
    if (!box) return;
    const el = boxesEl.querySelector(`.map-box[data-id="${CSS.escape(box.id)}"]`)?.getBoundingClientRect();
    showMenu(box, el ? el.left + 8 : 8, el ? el.bottom - 4 : 8);
  } else if (e.key === 'Escape') {
    if (pathFrom) stopPath();
    else if (box) {
      // Out to the box holding it; at the top, nothing selected.
      const holder = box.parent ? scene?.boxes.find((b) => b.id === box.parent) : undefined;
      if (holder) goTo(holder, undefined);
      else select(undefined);
    } else return;
  } else if (e.key === '+' || e.key === '=') {
    zoomBy(1.25);
  } else if (e.key === '-' || e.key === '_') {
    zoomBy(0.8);
  } else {
    return;
  }
  e.preventDefault();
});
window.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target instanceof HTMLInputElement)) {
    const back = e.key === 'ArrowLeft';
    if (!(back ? backButton : forwardButton).disabled) post({ type: 'history', direction: back ? 'back' : 'forward' });
    e.preventDefault();
  } else if (e.key === 'Escape' && pathFrom && e.target === document.body) {
    stopPath();
  }
});

// Centres a box, zoomed so it's readable (and whole, if it can be).
function centreOn(id: string): void {
  const box = scene?.boxes.find((b) => b.id === id);
  if (!box) return;
  const rect = canvas.getBoundingClientRect();
  zoom = Math.max(MIN_ZOOM, Math.min(1, (rect.width * 0.8) / Math.max(1, box.width), (rect.height * 0.8) / Math.max(1, box.height)));
  pan = { x: rect.width / 2 - (box.x + box.width / 2) * zoom, y: rect.height / 2 - (box.y + box.height / 2) * zoom };
  fitted = true;
  applyView();
}

// Find: what the index has named like what's typed, picked from a list (arrow keys, Enter).
const findInput = element<HTMLInputElement>('map-find');
const foundList = element<HTMLElement>('map-found');
let found: FoundEntity[] = [];
let foundActive = 0;
let findTimer: ReturnType<typeof setTimeout> | undefined;

function placeBelow(popup: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  popup.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 340))}px`;
  popup.style.top = `${rect.bottom + 2}px`;
}

function showFound(): void {
  foundList.textContent = '';
  if (!findInput.value.trim()) {
    foundList.hidden = true;
    return;
  }
  if (!found.length) {
    const none = document.createElement('li');
    none.className = 'map-found-none';
    none.textContent = 'Nothing found';
    foundList.appendChild(none);
  }
  found.forEach((f, i) => {
    const item = document.createElement('li');
    item.className = `map-found-item${i === foundActive ? ' active' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(i === foundActive));
    item.dataset.id = f.id;
    const label = document.createElement('span');
    label.className = 'map-found-label';
    label.textContent = f.label;
    const kind = document.createElement('span');
    kind.className = 'map-found-kind';
    kind.textContent = KIND_NAMES[f.kind] ?? f.kind;
    const where = document.createElement('span');
    where.className = 'map-found-where';
    where.textContent = f.where;
    item.append(label, kind, where);
    // (On press, before the input's blur closes the list.)
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pick(i);
    });
    foundList.appendChild(item);
  });
  placeBelow(foundList, findInput);
  foundList.hidden = false;
}

function pick(i: number): void {
  const f = found[i];
  if (!f) return;
  foundList.hidden = true;
  if (pathFrom) finishPath(f.id);
  else post({ type: 'reveal', id: f.id });
}

findInput.addEventListener('input', () => {
  if (findTimer) clearTimeout(findTimer);
  const query = findInput.value;
  if (!query.trim()) {
    found = [];
    showFound();
    return;
  }
  findTimer = setTimeout(() => post({ type: 'find', query }), 120);
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!found.length) return;
    foundActive = (foundActive + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length;
    showFound();
    e.preventDefault();
  } else if (e.key === 'Enter') {
    pick(foundActive);
    e.preventDefault();
  } else if (e.key === 'Escape') {
    if (!foundList.hidden) foundList.hidden = true;
    else canvas.focus();
    e.preventDefault();
  }
});
findInput.addEventListener('blur', () => {
  foundList.hidden = true;
});
// Back in the box (or clicked again after a pick), the list shows again.
for (const event of ['focus', 'click']) {
  findInput.addEventListener(event, () => {
    if (findInput.value.trim() && foundList.hidden) showFound();
  });
}

// Filters: languages, projects, external packages and tests, each shown or hidden.
const filterButton = element<HTMLButtonElement>('map-filter');
const filterPanel = element<HTMLElement>('map-filters');

function filtersOn(filters: MapFilters | undefined): number {
  if (!filters) return 0;
  return (filters.languages?.length ?? 0) + (filters.projects?.length ?? 0) + (filters.externals === false ? 1 : 0) + (filters.tests === false ? 1 : 0);
}

function closeFilters(): void {
  filterPanel.hidden = true;
  filterButton.setAttribute('aria-expanded', 'false');
}

function showFilters(): void {
  if (!scene) return;
  const filters = scene.filters ?? {};
  filterPanel.textContent = '';
  const group = (title: string, items: { key: string; label: string; shown: boolean }[]): void => {
    if (!items.length) return;
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = title;
    fieldset.appendChild(legend);
    for (const item of items) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.shown;
      box.dataset.key = item.key;
      label.append(box, document.createTextNode(` ${item.label}`));
      fieldset.appendChild(label);
    }
    filterPanel.appendChild(fieldset);
  };
  const options = scene.options ?? { languages: [], projects: [] };
  group('Languages', options.languages.map((l) => ({ key: `language:${l}`, label: l, shown: !filters.languages?.includes(l) })));
  if (options.projects.length > 1) group('Projects', options.projects.map((p) => ({ key: `project:${p.id}`, label: p.label || '(workspace)', shown: !filters.projects?.includes(p.id) })));
  group('Show', [
    { key: 'externals', label: 'External packages', shown: filters.externals !== false },
    { key: 'tests', label: 'Tests', shown: filters.tests !== false }
  ]);
  placeBelow(filterPanel, filterButton);
  filterPanel.hidden = false;
  filterButton.setAttribute('aria-expanded', 'true');
}

filterButton.addEventListener('click', () => {
  if (filterPanel.hidden) showFilters();
  else closeFilters();
});
filterPanel.addEventListener('change', () => {
  const filters: MapFilters = {};
  for (const box of filterPanel.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
    if (box.checked) continue;
    const key = box.dataset.key ?? '';
    if (key.startsWith('language:')) (filters.languages ??= []).push(key.slice('language:'.length));
    else if (key.startsWith('project:')) (filters.projects ??= []).push(key.slice('project:'.length));
    else if (key === 'externals') filters.externals = false;
    else if (key === 'tests') filters.tests = false;
  }
  post({ type: 'filters', filters });
});
window.addEventListener('mousedown', (e) => {
  if (filterPanel.hidden || !(e.target instanceof Element)) return;
  if (e.target.closest('#map-filters, #map-filter')) return;
  closeFilters();
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    findInput.focus();
    findInput.select();
    e.preventDefault();
  } else if (e.key === 'Escape' && !filterPanel.hidden) {
    closeFilters();
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
    // The flowchart's bar: whose flow it is.
    flowBar.hidden = scene.mode !== 'flow';
    if (scene.flow) flowLabel.textContent = `Control flow of ${scene.flow.label}`;
    // The call flow's bar: its direction, how many levels, and where it starts (or the path shown).
    callsBar.hidden = scene.mode !== 'calls';
    if (scene.calls) {
      const calls = scene.calls;
      for (const button of document.querySelectorAll<HTMLElement>('.map-direction')) button.setAttribute('aria-checked', String(button.dataset.direction === calls.direction));
      callsBar.classList.toggle('path', !!calls.path);
      if (!calls.path) depthSelect.value = String(calls.depth);
      const path = calls.path;
      rootLabel.textContent = path
        ? path.length !== undefined
          ? `Path from ${path.fromLabel} to ${path.toLabel}: ${path.length} call${path.length === 1 ? '' : 's'}`
          : `No calls lead from ${path.fromLabel} to ${path.toLabel}, or back`
        : calls.rootLabel
          ? `${calls.direction === 'callers' ? 'Callers of' : calls.direction === 'both' ? 'Callers and calls of' : 'From'} ${calls.rootLabel}`
          : calls.uncalled ? `No entry points: from what nothing calls (${calls.starts})` : `From the entry points (${calls.starts})`;
      rootClear.hidden = !calls.root && !path;
      rootClear.title = path ? `Leave the path: the call flow from ${path.fromLabel}` : 'Start from the entry points';
      rootClear.setAttribute('aria-label', rootClear.title);
    }
    // Back and Forward.
    backButton.disabled = !message.history?.back;
    forwardButton.disabled = !message.history?.forward;
    closeMenu();
    // Filters on: the button says how many.
    const on = filtersOn(scene.filters);
    filterButton.textContent = on ? `Filter (${on})` : 'Filter';
    filterButton.classList.toggle('on', on > 0);
    if (message.focus) selected = message.focus;
    summaries.clear();
    hideHover();
    render();
    if (message.focus) centreOn(message.focus);
  } else if (message.type === 'status' && message.text !== undefined) {
    statusEl.textContent = message.text;
  } else if (message.type === 'hover' && message.id) {
    summaries.set(message.id, message.summary ?? null);
    const box = scene?.boxes.find((b) => b.id === hoverFor);
    if (box && entityOf(box) === message.id) showHover(box);
  } else if (message.type === 'found' && message.query === findInput.value) {
    found = message.results ?? [];
    foundActive = 0;
    if (document.activeElement === findInput) showFound();
  }
});

post({ type: 'ready' });
