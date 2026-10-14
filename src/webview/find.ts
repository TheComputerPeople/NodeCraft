// Find in Blueprint (Ctrl+F) and Find in All Blueprints (Ctrl+Shift+F), as in Unreal. This file
// is searched in the editor as you type; all files are searched by the host (src/core/search.ts).
import { FileSearchHit, RevealTarget } from '../core/model';
import { searchDocument } from '../core/search';
import { selectedCommentIds } from './comments';
import { lookupDefinition } from './document';
import { dom, setStatus } from './dom';
import { postToHost } from './host';
import { openGraph, selectVariable } from './my-blueprint';
import { render } from './render';
import { selectNode } from './selection';
import { state } from './state';
import { applyTransform, centerOnNode } from './view';

const ALL_FILES_DELAY_MS = 250;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

export function openFind(allFiles: boolean): void {
  dom.find.hidden = false;
  dom.findAll.checked = allFiles;
  updatePlaceholder();
  dom.findInput.focus();
  dom.findInput.select();
  runSearch();
}

export function closeFind(): void {
  if (dom.find.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  dom.find.hidden = true;
}

function updatePlaceholder(): void {
  dom.findInput.placeholder = dom.findAll.checked ? 'Search every graph in the workspace' : 'Search this graph file';
}

export function runSearch(): void {
  const query = dom.findInput.value;
  clearTimeout(searchTimer);
  if (dom.findAll.checked) {
    // The host reads every file, so wait for typing to pause.
    searchTimer = setTimeout(() => postToHost({ type: 'findInAll', query }), ALL_FILES_DELAY_MS);
    return;
  }
  const doc = state.document;
  const hits = doc ? searchDocument(doc, query, lookupDefinition).map((hit): FileSearchHit => ({ ...hit, uri: '', file: '', current: true })) : [];
  showResults(hits, query);
}

export function showResults(hits: FileSearchHit[], query = dom.findInput.value): void {
  const list = dom.findList;
  list.innerHTML = '';
  if (!query.trim()) return;
  if (!hits.length) {
    list.innerHTML = '<li class="find-empty">No results</li>';
    return;
  }
  let file: string | undefined;
  for (const hit of hits) {
    // Results from other files are grouped under their file name.
    if (dom.findAll.checked && hit.file !== file) {
      file = hit.file;
      const heading = document.createElement('li');
      heading.className = 'find-file';
      heading.textContent = hit.file;
      list.appendChild(heading);
    }
    const item = document.createElement('li');
    item.dataset.kind = hit.kind;
    item.dataset.id = hit.id;
    const kind = document.createElement('span');
    kind.className = 'find-kind';
    kind.textContent = hit.kind;
    const label = document.createElement('span');
    label.textContent = hit.detail ? `${hit.label}: ${hit.detail.replace(/^[^:]*: /, '')}` : hit.label;
    item.append(kind, label);
    if (hit.graphName) {
      const where = document.createElement('span');
      where.className = 'find-where';
      where.textContent = `in ${hit.graphName}`;
      item.appendChild(where);
    }
    item.addEventListener('click', () => {
      const target: RevealTarget = { kind: hit.kind, id: hit.id, ...(hit.graphId ? { graphId: hit.graphId } : {}) };
      if (hit.current) reveal(target);
      else postToHost({ type: 'reveal', target: { ...target, uri: hit.uri } });
    });
    list.appendChild(item);
  }
}

// Shows a hit in this editor: opens its graph, then selects and centers it.
export function reveal(target: RevealTarget): void {
  if (target.kind === 'variable') {
    selectVariable(target.id);
    return;
  }
  if (target.graphId && target.graphId !== state.graph?.id) openGraph(target.graphId);
  if (target.kind === 'node') {
    selectNode(target.id, false, true);
    centerOnNode(target.id);
  } else if (target.kind === 'comment') {
    const comment = state.graph?.comments.find((c) => c.id === target.id);
    if (!comment) return;
    selectedCommentIds.clear();
    selectedCommentIds.add(comment.id);
    const rect = dom.canvasWrap.getBoundingClientRect();
    state.pan = {
      x: rect.width / 2 - (comment.position.x + comment.size.width / 2) * state.zoom,
      y: rect.height / 2 - (comment.position.y + comment.size.height / 2) * state.zoom
    };
    applyTransform();
    render();
  }
  if (target.kind !== 'graph' && !state.graph?.nodes.some((n) => n.id === target.id) && !state.graph?.comments.some((c) => c.id === target.id)) {
    setStatus('That item is no longer in the graph.');
  }
}

dom.findInput.addEventListener('input', runSearch);
dom.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFind();
});
dom.findAll.addEventListener('change', () => {
  updatePlaceholder();
  runSearch();
});
dom.findClose.addEventListener('click', closeFind);
