// The open graphs' tabs above the canvas, with Back and Forward, as in Unreal's Blueprint editor
// (docs/unreal-conventions.md, "Graph tabs"). Every way of showing a graph (My Blueprint, a tab, Go
// to Definition, Find, the debugger) goes through openGraph, which records it here.
import { GraphTabs } from '../core/graph-tabs';
import { GraphKind } from '../core/model';
import { primaryGraph } from '../core/serializer';
import { dom } from './dom';
import { MenuItem, showFloatingMenu } from './floating-menu';
import { loadViewState, postToHost, saveViewState } from './host';
import { openGraph } from './my-blueprint';
import { state } from './state';

const VIEW_STATE_KEY = 'graphTabs';
const KIND_NAMES: Record<GraphKind, string> = { event: 'Event Graph', function: 'Function', macro: 'Macro' };
// A press on a tab becomes a drag once the pointer moves this far.
const DRAG_THRESHOLD = 5;

let tabs = new GraphTabs();
let restored = false;
let lastSentHistory = '';
let tabDrag: { id: string; startX: number; moved: boolean } | null = null;

function save(): void {
  saveViewState(VIEW_STATE_KEY, tabs.save());
}

// Records that openGraph showed `graphId` (unless Back, Forward or a close already did).
export function graphShown(graphId: string, recorded: boolean): void {
  if (!recorded) tabs.show(graphId);
  save();
}

// Follows the document's graphs after it loads or changes, and returns the graph to show: the one
// shown before when it still exists, else the tab the file had open last time, else its first graph.
export function syncGraphTabs(): string | null {
  const doc = state.document;
  if (!doc) return null;
  if (!restored) {
    restored = true;
    tabs = GraphTabs.restore(loadViewState(VIEW_STATE_KEY));
  }
  const ids = doc.graphs.map((g) => g.id);
  const fallback = doc.graphs.length ? primaryGraph(doc).id : null;
  const shown = tabs.reconcile(ids, fallback);
  // The graph on screen gets a tab, whatever the saved tabs were.
  if (shown) tabs.show(shown);
  save();
  return shown;
}

export function closeGraphTabs(ids: string[]): void {
  const before = state.graph?.id;
  const shown = tabs.close(ids);
  save();
  if (shown && shown !== before) openGraph(shown, true);
  else renderGraphTabs();
}

export function goBack(): void {
  step(tabs.back());
}

export function goForward(): void {
  step(tabs.forward());
}

function step(graphId: string | undefined): void {
  if (!graphId) return;
  save();
  openGraph(graphId, true);
}

// The tab strip, the graph's name in the toolbar and Back and Forward, from the current tabs.
export function renderGraphTabs(): void {
  const doc = state.document;
  const graph = state.graph;
  dom.graphName.textContent = doc ? (graph ? `${doc.name} › ${graph.name}` : doc.name) : 'Untitled';
  // A structure or enumeration file has no graphs, so no tabs.
  const hasGraphs = !!doc && doc.kind !== 'structure' && doc.kind !== 'enumeration' && doc.graphs.length > 0;
  dom.graphTabs.hidden = !hasGraphs;
  dom.tabList.innerHTML = '';
  if (!doc || !hasGraphs) return;
  const closable = tabs.open.length > 1;
  for (const id of tabs.open) {
    const g = doc.graphs.find((candidate) => candidate.id === id);
    if (!g) continue;
    const active = id === graph?.id;
    const tab = document.createElement('div');
    tab.className = 'graph-tab';
    tab.classList.toggle('active', active);
    tab.classList.toggle('dragging', tabDrag?.id === id && tabDrag.moved);
    tab.dataset.graph = id;
    tab.dataset.kind = g.kind;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    tab.title = `${KIND_NAMES[g.kind]}: ${g.name}`;
    const icon = document.createElement('span');
    icon.className = 'graph-tab-icon';
    icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'graph-tab-name';
    name.textContent = g.name;
    tab.append(icon, name);
    if (closable) {
      const close = document.createElement('button');
      close.className = 'graph-tab-close';
      close.tabIndex = -1;
      close.title = 'Close Tab (middle-click)';
      close.setAttribute('aria-label', `Close ${g.name}`);
      close.textContent = '×';
      close.addEventListener('mousedown', (e) => e.stopPropagation());
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeGraphTabs([id]);
      });
      tab.appendChild(close);
    }
    tab.addEventListener('mousedown', (e) => onTabMouseDown(id, e));
    tab.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (closable) closeGraphTabs([id]);
    });
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabMenu(id, e.clientX, e.clientY);
    });
    dom.tabList.appendChild(tab);
  }
  dom.tabList.querySelector<HTMLElement>('.graph-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  dom.graphBack.disabled = !tabs.canGoBack;
  dom.graphForward.disabled = !tabs.canGoForward;
  // The host's Alt+Left and Alt+Right apply only while there is somewhere to go, so VS Code's own
  // Go Back and Go Forward still work otherwise.
  const history = `${tabs.canGoBack}|${tabs.canGoForward}`;
  if (history !== lastSentHistory) {
    lastSentHistory = history;
    postToHost({ type: 'graphHistory', canGoBack: tabs.canGoBack, canGoForward: tabs.canGoForward });
  }
}

function showTabMenu(id: string, x: number, y: number): void {
  const index = tabs.open.indexOf(id);
  const items: MenuItem[] = [];
  if (tabs.open.length > 1) {
    items.push({ label: 'Close Tab', action: () => closeGraphTabs([id]) });
    items.push({ label: 'Close Other Tabs', action: () => closeOthers(id) });
  }
  if (index >= 0 && index < tabs.open.length - 1) items.push({ label: 'Close Tabs to the Right', action: () => closeToTheRight(id) });
  if (!items.length) return;
  showFloatingMenu(items, x, y);
}

function closeOthers(id: string): void {
  const before = state.graph?.id;
  const shown = tabs.closeOthers(id);
  save();
  if (shown && shown !== before) openGraph(shown, true);
  else renderGraphTabs();
}

function closeToTheRight(id: string): void {
  const before = state.graph?.id;
  const shown = tabs.closeToTheRight(id);
  save();
  if (shown && shown !== before) openGraph(shown, true);
  else renderGraphTabs();
}

// A press shows the tab's graph; dragging it along the strip moves the tab.
function onTabMouseDown(id: string, e: MouseEvent): void {
  if (e.button === 1) {
    // No autoscroll: a middle-click closes the tab.
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault();
  tabDrag = { id, startX: e.clientX, moved: false };
  if (state.graph?.id !== id) openGraph(id);
  dom.tabList.querySelector<HTMLElement>(`.graph-tab[data-graph="${CSS.escape(id)}"]`)?.focus();
}

window.addEventListener('mousemove', (e) => {
  if (!tabDrag) return;
  if (!tabDrag.moved && Math.abs(e.clientX - tabDrag.startX) < DRAG_THRESHOLD) return;
  tabDrag.moved = true;
  // The tab goes where the pointer is among the other tabs' midpoints.
  const dragged = tabDrag.id;
  const index = [...dom.tabList.querySelectorAll<HTMLElement>('.graph-tab')].filter((el) => {
    if (el.dataset.graph === dragged) return false;
    const r = el.getBoundingClientRect();
    return e.clientX > r.left + r.width / 2;
  }).length;
  if (tabs.open.indexOf(dragged) !== index) tabs.move(dragged, index);
  renderGraphTabs();
});

window.addEventListener('mouseup', (e) => {
  if (tabDrag && e.button === 0) {
    if (tabDrag.moved) save();
    tabDrag = null;
    renderGraphTabs();
  }
});

// The mouse's Back and Forward buttons, as in Unreal (and kept from the webview's own history).
window.addEventListener('mousedown', (e) => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
window.addEventListener('mouseup', (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  if (e.button === 3) goBack();
  else goForward();
});

dom.graphBack.addEventListener('click', goBack);
dom.graphForward.addEventListener('click', goForward);

// Keyboard: Left and Right (Home and End) move between tabs, Delete closes one.
dom.tabList.addEventListener('keydown', (e) => {
  const focused = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('.graph-tab') : null;
  const id = focused?.dataset.graph;
  if (!id) return;
  const index = tabs.open.indexOf(id);
  const target = e.key === 'ArrowLeft' ? tabs.open[index - 1]
    : e.key === 'ArrowRight' ? tabs.open[index + 1]
      : e.key === 'Home' ? tabs.open[0]
        : e.key === 'End' ? tabs.open[tabs.open.length - 1] : undefined;
  if (target) {
    openGraph(target);
    dom.tabList.querySelector<HTMLElement>(`.graph-tab[data-graph="${CSS.escape(target)}"]`)?.focus();
  } else if (e.key === 'Delete' && tabs.open.length > 1) {
    closeGraphTabs([id]);
    dom.tabList.querySelector<HTMLElement>('.graph-tab.active')?.focus();
  } else if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace'].includes(e.key)) {
    return;
  }
  // Not the canvas's: arrows would move the selected nodes and Delete would delete them.
  e.preventDefault();
  e.stopPropagation();
});
