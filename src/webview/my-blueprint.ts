// The My Blueprint panel, as in Unreal: the document's graphs, functions, macros and variables.
// Variables are dragged onto the canvas to place Get and Set nodes.
import * as edits from '../core/blueprint-edits';
import * as editing from '../core/editing';
import { FUNCTION_CALL } from '../core/functions';
import { MACRO_INSTANCE } from '../core/macros';
import { GraphKind, GraphVariable } from '../core/model';
import { VARIABLE_GET, VARIABLE_SET } from '../core/resolve';
import { formatType } from '../core/types';
import { addNode } from './actions';
import { lookupDefinition, markDirty } from './document';
import { dom, eventElement, setStatus } from './dom';
import { MenuItem, showFloatingMenu } from './floating-menu';
import { newConnectionId } from './host';
import { renderInspector, renderPalette } from './panels';
import { render, syncSelectionClasses } from './render';
import { state } from './state';
import { applyTransform, screenToWorld } from './view';
import { typeColor } from './style';

const GRAPH_SECTIONS: { kind: GraphKind; title: string; add: string }[] = [
  { kind: 'event', title: 'Graphs', add: 'Add Graph' },
  { kind: 'function', title: 'Functions', add: 'Add Function' },
  { kind: 'macro', title: 'Macros', add: 'Add Macro' }
];

export function renderMyBlueprint(): void {
  const root = dom.myBlueprint;
  root.innerHTML = '';
  const doc = state.document;
  if (!doc) return;
  const allowed = edits.allowedGraphKinds(doc);
  if (doc.kind === 'structure' || doc.kind === 'enumeration') {
    root.appendChild(emptyItem(doc.kind === 'structure' ? 'A structure has fields, edited in the middle.' : 'An enumeration has values, edited in the middle.'));
    return;
  }

  for (const section of GRAPH_SECTIONS.filter((s) => allowed.includes(s.kind))) {
    const el = sectionElement(section.title, section.add, () => {
      const graph = edits.addGraph(doc, section.kind);
      markDirty();
      openGraph(graph.id);
      startRename('graph', graph.id);
    });
    const graphs = doc.graphs.filter((g) => g.kind === section.kind);
    if (!graphs.length) el.appendChild(emptyItem(section.kind === 'function' ? 'No functions' : section.kind === 'macro' ? 'No macros' : 'No graphs'));
    for (const graph of graphs) {
      const item = itemElement(graph.name, 'graph', graph.id);
      item.classList.toggle('active', graph.id === state.graph?.id);
      item.title = graph.kind === 'event' ? 'Open this event graph'
        : graph.kind === 'function' ? 'Click to open; drag onto a graph to call it.' : 'Click to open; drag onto a graph to use it.';
      item.addEventListener('click', () => openGraph(graph.id));
      if (graph.kind === 'function' || graph.kind === 'macro') {
        item.addEventListener('mousedown', (e) => {
          if (e.button !== 0 || eventElement(e)?.closest('input')) return;
          state.variableDrag = { variableId: '', functionId: graph.id, startX: e.clientX, startY: e.clientY, moved: false };
        });
      }
      item.addEventListener('dblclick', () => startRename('graph', graph.id));
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showFloatingMenu([
          { label: 'Open', action: () => openGraph(graph.id) },
          { label: 'Rename', action: () => startRename('graph', graph.id) },
          { label: 'Delete', danger: true, action: () => removeGraph(graph.id) }
        ], e.clientX, e.clientY);
      });
      el.appendChild(item);
    }
    root.appendChild(el);
  }

  // The open function's local variables (Unreal's Local Variables section).
  const fn = state.graph?.kind === 'function' ? state.graph : undefined;
  if (fn) {
    const locals = sectionElement(`Local Variables (${fn.name})`, 'Add Local Variable', () => {
      const variable = edits.addLocalVariable(doc, fn.id);
      markDirty();
      selectVariable(variable.id);
      startRename('variable', variable.id);
    });
    if (!fn.localVariables?.length) locals.appendChild(emptyItem('No local variables'));
    for (const variable of fn.localVariables ?? []) locals.appendChild(variableItem(variable));
    root.appendChild(locals);
  }

  if (doc.kind === 'class') {
    const vars = sectionElement('Variables', 'Add Variable', () => {
      const variable = edits.addVariable(doc);
      markDirty();
      selectVariable(variable.id);
      startRename('variable', variable.id);
    });
    if (!doc.variables.length) vars.appendChild(emptyItem('No variables'));
    for (const variable of doc.variables) vars.appendChild(variableItem(variable));
    root.appendChild(vars);

    // Event dispatchers need custom events (Phase 4).
    const dispatchers = sectionElement('Event Dispatchers', 'Event dispatchers arrive in a later version', undefined);
    dispatchers.appendChild(emptyItem('Arrive in a later version'));
    root.appendChild(dispatchers);
  }
}

// A member or local variable: drag it onto the graph for Get or Set.
function variableItem(variable: GraphVariable): HTMLElement {
  const item = itemElement(variable.name, 'variable', variable.id);
  item.classList.toggle('selected', variable.id === state.selectedVariableId);
  item.title = 'Drag onto the graph: Ctrl for Get, Alt for Set. Drop on a pin to wire it.';
  const dot = document.createElement('span');
  dot.className = 'mb-dot';
  dot.style.setProperty('--pin-color', typeColor(variable.type));
  if (variable.type.container) dot.dataset.container = variable.type.container;
  item.prepend(dot);
  const type = document.createElement('span');
  type.className = 'mb-type';
  type.textContent = formatType(variable.type);
  item.appendChild(type);
  item.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || eventElement(e)?.closest('input')) return;
    selectVariable(variable.id);
    state.variableDrag = { variableId: variable.id, startX: e.clientX, startY: e.clientY, moved: false };
    e.preventDefault();
  });
  item.addEventListener('dblclick', () => startRename('variable', variable.id));
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showFloatingMenu([
      { label: 'Rename', action: () => startRename('variable', variable.id) },
      { label: 'Delete', danger: true, action: () => removeVariable(variable.id) }
    ], e.clientX, e.clientY);
  });
  return item;
}

function sectionElement(title: string, addLabel: string, onAdd: (() => void) | undefined): HTMLElement {
  const section = document.createElement('div');
  section.className = 'mb-section';
  const header = document.createElement('div');
  header.className = 'mb-header';
  header.innerHTML = `<span>${title}</span>`;
  const add = document.createElement('button');
  add.textContent = '+';
  add.title = addLabel;
  add.setAttribute('aria-label', addLabel);
  if (onAdd) add.addEventListener('click', onAdd);
  else add.disabled = true;
  header.appendChild(add);
  section.appendChild(header);
  return section;
}

function itemElement(name: string, kind: 'graph' | 'variable', id: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'mb-item';
  item.dataset.kind = kind;
  item.dataset.id = id;
  const label = document.createElement('span');
  label.className = 'mb-name';
  label.textContent = name;
  item.appendChild(label);
  return item;
}

function emptyItem(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mb-empty';
  el.textContent = text;
  return el;
}

// Shows a graph on the canvas, remembering each graph's pan and zoom.
export function openGraph(graphId: string): void {
  const doc = state.document;
  const graph = doc?.graphs.find((g) => g.id === graphId);
  if (!doc || !graph) return;
  if (state.graph) state.viewByGraph.set(state.graph.id, { pan: { ...state.pan }, zoom: state.zoom });
  state.graph = graph;
  const view = state.viewByGraph.get(graph.id);
  state.pan = view ? { ...view.pan } : { x: 40, y: 40 };
  state.zoom = view?.zoom ?? 1;
  state.selectedNodeIds.clear();
  state.selectedNodeId = null;
  dom.graphName.textContent = `${doc.name} › ${graph.name}`;
  applyTransform();
  render();
  renderMyBlueprint();
  // Functions offer Return Nodes and no events; event graphs the reverse.
  renderPalette();
  renderInspector();
}

export function selectVariable(id: string | null): void {
  state.selectedVariableId = id;
  if (id) {
    state.selectedNodeIds.clear();
    state.selectedNodeId = null;
    syncSelectionClasses();
  }
  renderMyBlueprint();
  renderInspector();
}

// Replaces an item's label with a text field; Enter or leaving the field applies, Escape cancels.
export function startRename(kind: 'graph' | 'variable', id: string): void {
  const item = dom.myBlueprint.querySelector<HTMLElement>(`.mb-item[data-kind="${kind}"][data-id="${CSS.escape(id)}"]`);
  const label = item?.querySelector<HTMLElement>('.mb-name');
  if (!item || !label) return;
  const input = document.createElement('input');
  input.value = label.textContent ?? '';
  input.setAttribute('aria-label', 'Name');
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (apply: boolean): void => {
    if (done) return;
    done = true;
    const doc = state.document;
    if (apply && doc) {
      const error = kind === 'graph' ? edits.renameGraph(doc, id, input.value) : edits.renameVariable(doc, id, input.value);
      if (error) setStatus(error);
      else {
        markDirty();
        if (kind === 'graph' && state.graph?.id === id) dom.graphName.textContent = `${doc.name} › ${state.graph.name}`;
        // Variable nodes show the variable's name.
        render();
        renderPalette();
      }
    }
    renderMyBlueprint();
    renderInspector();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('mousedown', (e) => e.stopPropagation());
}

function removeGraph(graphId: string): void {
  const doc = state.document;
  if (!doc) return;
  const error = edits.deleteGraph(doc, graphId);
  if (error) {
    setStatus(error);
    return;
  }
  markDirty();
  if (state.graph?.id === graphId) openGraph(doc.graphs[0].id);
  else renderMyBlueprint();
}

export function removeVariable(id: string): void {
  const doc = state.document;
  const variable = doc && edits.findVariable(doc, id)?.variable;
  if (!doc || !variable) return;
  const removed = edits.deleteVariable(doc, id);
  if (state.selectedVariableId === id) state.selectedVariableId = null;
  markDirty();
  render();
  renderMyBlueprint();
  renderPalette();
  setStatus(removed ? `Deleted ${variable.name} and the ${removed} node${removed === 1 ? '' : 's'} that used it.` : `Deleted ${variable.name}.`);
}

// ---- Dragging a variable onto the graph ---------------------------------------------------

export function updateVariableDrag(e: MouseEvent): void {
  const drag = state.variableDrag;
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return;
  drag.moved = true;
  const doc = state.document;
  const variable = doc && edits.findVariable(doc, drag.variableId)?.variable;
  const ghost = dom.dragGhost;
  ghost.hidden = false;
  ghost.textContent = drag.functionId ? doc?.graphs.find((g) => g.id === drag.functionId)?.name ?? '' : variable?.name ?? '';
  ghost.style.setProperty('--pin-color', typeColor(variable?.type));
  ghost.style.left = `${e.clientX}px`;
  ghost.style.top = `${e.clientY}px`;
}

// As in Unreal: Ctrl places Get, Alt places Set, dropping on a pin places whichever fits and wires
// it, and a plain drop asks.
export function finishVariableDrag(e: MouseEvent): void {
  const drag = state.variableDrag;
  state.variableDrag = null;
  dom.dragGhost.hidden = true;
  if (!drag?.moved || !state.graph) return;
  const target = eventElement(e);
  if (!target?.closest('#canvas-wrap')) return;
  const position = screenToWorld(e.clientX, e.clientY);
  // A function: place a call to it. A macro: place an instance of it, except in itself.
  if (drag.functionId) {
    const graph = state.document?.graphs.find((g) => g.id === drag.functionId);
    if (graph?.kind === 'macro') {
      if (graph.id === state.graph.id) setStatus("A macro can't use itself.");
      else addNode(MACRO_INSTANCE, position, { graph: graph.id });
      return;
    }
    addNode(FUNCTION_CALL, position, { graph: drag.functionId });
    return;
  }
  const doc = state.document;
  const found = doc && edits.findVariable(doc, drag.variableId);
  const variable = found?.variable;
  if (!variable) return;
  if (found.graph && found.graph.id !== state.graph.id) {
    setStatus(`${variable.name} is a local variable of ${found.graph.name}.`);
    return;
  }
  const properties = { variable: variable.id };

  const pin = target.closest<HTMLElement>('.pin[data-kind="data"]');
  if (pin) {
    const toInput = pin.dataset.direction === 'input';
    const id = addNode(toInput ? VARIABLE_GET : VARIABLE_SET, { x: position.x - (toInput ? 140 : -40), y: position.y - 10 }, properties);
    if (id) wireToPin(id, toInput, { node: pin.dataset.node ?? '', pin: pin.dataset.pin ?? '' });
    return;
  }
  if (e.ctrlKey || e.metaKey) addNode(VARIABLE_GET, position, properties);
  else if (e.altKey) addNode(VARIABLE_SET, position, properties);
  else {
    const items: MenuItem[] = [
      { label: `Get ${variable.name}`, action: () => addNode(VARIABLE_GET, position, properties) },
      { label: `Set ${variable.name}`, action: () => addNode(VARIABLE_SET, position, properties) }
    ];
    showFloatingMenu(items, e.clientX, e.clientY);
  }
}

// Wires a just-placed Get (into an input) or Set (from an output) to the pin it was dropped on.
function wireToPin(nodeId: string, getter: boolean, pin: editing.PinAddress): void {
  if (!state.graph) return;
  const ends = getter
    ? editing.resolveConnection(state.graph, lookupDefinition, { node: nodeId, pin: 'value' }, pin)
    : editing.resolveConnection(state.graph, lookupDefinition, pin, { node: nodeId, pin: 'value' });
  if (!ends) {
    setStatus("The variable's type doesn't match that pin.");
    return;
  }
  editing.connect(state.graph, lookupDefinition, ends, newConnectionId());
  markDirty();
  render();
}
