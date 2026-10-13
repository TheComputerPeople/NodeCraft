// Comment boxes, as in Unreal: C wraps the selection, the title bar drags the box and the nodes
// inside it, the corner resizes it, and double-click or F2 renames it. The box's body lets clicks
// through, so nodes inside can still be selected with a marquee.
import { GraphComment } from '../core/model';
import { markDirty } from './document';
import { dom, setStatus } from './dom';
import { render } from './render';
import { Point, state } from './state';
import { screenToWorld } from './view';

const PADDING = 24;
const TITLE_HEIGHT = 28;

interface CommentDrag {
  kind: 'move' | 'resize';
  comment: GraphComment;
  origin: Point;
  start: { position: Point; size: { width: number; height: number } };
  // Nodes inside the box when the drag began, which move with it.
  nodes: { id: string; x: number; y: number }[];
  moved: boolean;
}

let drag: CommentDrag | null = null;
export const selectedCommentIds = new Set<string>();

export function renderComments(): void {
  for (const comment of state.graph?.comments ?? []) dom.world.appendChild(commentElement(comment));
}

function commentElement(comment: GraphComment): HTMLElement {
  const el = document.createElement('div');
  el.className = 'comment' + (selectedCommentIds.has(comment.id) ? ' selected' : '');
  el.dataset.comment = comment.id;
  el.style.left = `${comment.position.x}px`;
  el.style.top = `${comment.position.y}px`;
  el.style.width = `${comment.size.width}px`;
  el.style.height = `${comment.size.height}px`;
  if (comment.color) el.style.setProperty('--comment-color', comment.color);

  const title = document.createElement('div');
  title.className = 'comment-title';
  title.textContent = comment.text;
  title.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
      selectedCommentIds.clear();
      state.selectedNodeIds.clear();
      state.selectedNodeId = null;
    }
    selectedCommentIds.add(comment.id);
    beginDrag('move', comment, e);
    render();
  });
  title.addEventListener('dblclick', () => startCommentRename(comment.id));
  el.appendChild(title);

  const handle = document.createElement('div');
  handle.className = 'comment-resize';
  handle.title = 'Resize';
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    beginDrag('resize', comment, e);
  });
  el.appendChild(handle);
  return el;
}

function nodeBounds(id: string): { x: number; y: number; width: number; height: number } | undefined {
  const node = state.graph?.nodes.find((n) => n.id === id);
  const el = dom.world.querySelector<HTMLElement>(`.node[data-node="${CSS.escape(id)}"]`);
  if (!node || !el) return undefined;
  return { x: node.position.x, y: node.position.y, width: el.offsetWidth, height: el.offsetHeight };
}

function beginDrag(kind: CommentDrag['kind'], comment: GraphComment, e: MouseEvent): void {
  const inside = kind === 'move' ? (state.graph?.nodes ?? []).filter((node) => {
    const b = nodeBounds(node.id);
    return !!b && b.x >= comment.position.x && b.y >= comment.position.y
      && b.x + b.width <= comment.position.x + comment.size.width && b.y + b.height <= comment.position.y + comment.size.height;
  }) : [];
  drag = {
    kind,
    comment,
    origin: screenToWorld(e.clientX, e.clientY),
    start: { position: { ...comment.position }, size: { ...comment.size } },
    nodes: inside.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
    moved: false
  };
}

export function isDraggingComment(): boolean {
  return drag !== null;
}

export function updateCommentDrag(e: MouseEvent): void {
  if (!drag) return;
  const p = screenToWorld(e.clientX, e.clientY);
  const dx = p.x - drag.origin.x;
  const dy = p.y - drag.origin.y;
  drag.moved = drag.moved || Math.abs(dx) > 1 || Math.abs(dy) > 1;
  if (drag.kind === 'move') {
    drag.comment.position = { x: drag.start.position.x + dx, y: drag.start.position.y + dy };
    for (const item of drag.nodes) {
      const node = state.graph?.nodes.find((n) => n.id === item.id);
      if (node) node.position = { x: item.x + dx, y: item.y + dy };
    }
  } else {
    drag.comment.size = { width: Math.max(120, drag.start.size.width + dx), height: Math.max(60, drag.start.size.height + dy) };
  }
  render();
}

export function finishCommentDrag(): void {
  if (drag?.moved) markDirty();
  drag = null;
}

// C with nodes selected: a comment box around them, ready to be named.
export function wrapSelectionInComment(): void {
  if (!state.graph || !state.selectedNodeIds.size) return;
  const bounds = [...state.selectedNodeIds].map(nodeBounds).filter((b): b is NonNullable<typeof b> => !!b);
  if (!bounds.length) return;
  const left = Math.min(...bounds.map((b) => b.x)) - PADDING;
  const top = Math.min(...bounds.map((b) => b.y)) - PADDING - TITLE_HEIGHT;
  const right = Math.max(...bounds.map((b) => b.x + b.width)) + PADDING;
  const bottom = Math.max(...bounds.map((b) => b.y + b.height)) + PADDING;
  addComment({ x: left, y: top }, { width: right - left, height: bottom - top });
}

// Hold C and click: an empty comment box at the pointer.
export function placeComment(clientX: number, clientY: number): void {
  addComment(screenToWorld(clientX, clientY), { width: 400, height: 200 });
}

function addComment(position: Point, size: { width: number; height: number }): void {
  const graph = state.graph;
  if (!graph) return;
  const used = new Set(graph.comments.map((c) => c.id));
  let id = 'comment';
  for (let i = 1; used.has(id); i++) id = `comment_${i}`;
  graph.comments.push({ id, text: 'Comment', position, size });
  selectedCommentIds.clear();
  selectedCommentIds.add(id);
  markDirty();
  render();
  startCommentRename(id);
}

export function startCommentRename(id: string): void {
  const comment = state.graph?.comments.find((c) => c.id === id);
  const title = dom.world.querySelector<HTMLElement>(`.comment[data-comment="${CSS.escape(id)}"] .comment-title`);
  if (!comment || !title) return;
  const input = document.createElement('input');
  input.className = 'comment-rename';
  input.value = comment.text;
  input.setAttribute('aria-label', 'Comment');
  title.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (apply: boolean): void => {
    if (done) return;
    done = true;
    if (apply && input.value.trim() && input.value !== comment.text) {
      comment.text = input.value.trim();
      markDirty();
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('mousedown', (e) => e.stopPropagation());
}

export function deleteSelectedComments(): boolean {
  const graph = state.graph;
  if (!graph || !selectedCommentIds.size) return false;
  const count = selectedCommentIds.size;
  graph.comments = graph.comments.filter((c) => !selectedCommentIds.has(c.id));
  selectedCommentIds.clear();
  markDirty();
  render();
  setStatus(`Deleted ${count} comment${count === 1 ? '' : 's'}.`);
  return true;
}

export function clearCommentSelection(): void {
  if (!selectedCommentIds.size) return;
  selectedCommentIds.clear();
  for (const el of dom.world.querySelectorAll('.comment.selected')) el.classList.remove('selected');
}
