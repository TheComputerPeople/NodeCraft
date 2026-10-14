// The node palette (left) and the Details panel (right).
import { renameVariable, setVariableType, variableUses } from '../core/blueprint-edits';
import { definitionFor } from '../core/editing';
import { SWITCH_INT, SWITCH_STRING, switchIntCases, switchStringCases } from '../core/flow-control';
import { GraphNode, GraphVariable } from '../core/model';
import { ContainerKind } from '../core/types';
import { defaultValue } from '../core/values';
import { formatType } from '../core/types';
import { addNode, addOutputPin } from './actions';
import { PaletteEntry, lookupDefinition, markDirty, paletteEntries, searchText } from './document';
import { dom, escapeHtml, setStatus } from './dom';
import { renderMyBlueprint } from './my-blueprint';
import { render } from './render';
import { headerColor } from './style';
import { state } from './state';
import { screenToWorld } from './view';

export function renderPalette(): void {
  dom.categories.innerHTML = '';
  const q = dom.search.value.trim().toLowerCase();
  const grouped = new Map<string, PaletteEntry[]>();
  for (const entry of paletteEntries()) {
    const category = entry.definition.category;
    if (!searchText(entry.definition).includes(q)) continue;
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category)!.push(entry);
  }
  [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([category, entries]) => {
    const section = document.createElement('section');
    const title = document.createElement('div');
    title.className = 'category-title';
    title.textContent = category;
    section.appendChild(title);
    for (const entry of entries) {
      const def = entry.definition;
      const button = document.createElement('button');
      button.className = 'palette-node';
      button.innerHTML = `<span class="palette-dot" style="--node-color:${escapeHtml(headerColor(def))}"></span><span><strong>${escapeHtml(def.displayName)}</strong><small>${escapeHtml(def.description || '')}</small></span>`;
      button.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const rect = dom.canvasWrap.getBoundingClientRect();
        addNode(entry.type, screenToWorld(rect.left + dom.canvasWrap.clientWidth / 2, rect.top + 120), entry.properties);
      });
      section.appendChild(button);
    }
    dom.categories.appendChild(section);
  });
}

// The Details panel: what the selected node is. Pin values are edited on the node itself, as in
// Unreal; variable settings appear here with the My Blueprint panel.
export function renderInspector(): void {
  const graph = state.graph;
  const node = graph?.nodes.find((n) => n.id === state.selectedNodeId);
  if (!node && state.selectedVariableId && renderVariableDetails(state.selectedVariableId)) return;
  if (!graph || !node) {
    dom.inspector.innerHTML = state.selectedNodeIds.size > 1
      ? `<div class="muted details-empty">${state.selectedNodeIds.size} nodes selected.</div>`
      : '<div class="muted details-empty">Select a node to see its details.</div>';
    return;
  }
  const def = definitionFor(node, lookupDefinition);
  const wrapper = document.createElement('div');
  wrapper.className = 'details';
  wrapper.innerHTML = `<div class="inspector-name">${escapeHtml(def.displayName)}</div>`
    + `<div class="muted inspector-type">${escapeHtml(def.category)} · ${escapeHtml(node.type)}</div>`
    + (def.description ? `<p class="details-description">${escapeHtml(def.description)}</p>` : '');
  const pins = [...def.inputs, ...def.outputs].filter((p) => p.kind === 'data');
  if (pins.length) {
    const list = document.createElement('dl');
    list.className = 'details-pins';
    for (const pin of pins) {
      list.insertAdjacentHTML('beforeend', `<dt>${escapeHtml(pin.name || pin.id)}</dt><dd>${pin.direction === 'input' ? 'Input' : 'Output'} · ${escapeHtml(formatType(pin.type))}</dd>`);
    }
    wrapper.appendChild(list);
  }
  if (node.type === SWITCH_STRING) wrapper.appendChild(switchCasesEditor(node));
  if (node.type === SWITCH_INT) wrapper.appendChild(switchStartEditor(node));
  dom.inspector.innerHTML = '';
  dom.inspector.appendChild(wrapper);
}

// Switch on String's case names (Unreal's "Pin Names"), one field each.
function switchCasesEditor(node: GraphNode): HTMLElement {
  const section = document.createElement('div');
  section.className = 'details-fields switch-cases';
  section.insertAdjacentHTML('beforeend', '<div class="details-heading">Pin Names</div>');
  const commit = (cases: string[]): void => {
    node.properties.cases = cases;
    markDirty();
    render();
  };
  switchStringCases(node).forEach((value, i) => {
    const input = document.createElement('input');
    input.value = value;
    input.setAttribute('aria-label', `Case ${i}`);
    input.addEventListener('change', () => commit(switchStringCases(node).map((c, j) => (j === i ? input.value : c))));
    section.appendChild(field(`Case ${i}`, input));
  });
  const add = document.createElement('button');
  add.textContent = 'Add case';
  add.addEventListener('click', () => {
    addOutputPin(node);
  });
  section.appendChild(add);
  return section;
}

// Switch on Int's Start Index: the first case's value.
function switchStartEditor(node: GraphNode): HTMLElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '1';
  input.value = String(switchIntCases(node)[0] ?? 0);
  input.setAttribute('aria-label', 'Start Index');
  input.addEventListener('change', () => {
    node.properties.start = Math.trunc(Number(input.value) || 0);
    markDirty();
    render();
  });
  const section = document.createElement('div');
  section.className = 'details-fields';
  section.appendChild(field('Start Index', input));
  return section;
}

const VARIABLE_TYPES: { id: string; label: string }[] = [
  { id: 'bool', label: 'Boolean' },
  { id: 'int', label: 'Integer' },
  { id: 'float', label: 'Float' },
  { id: 'string', label: 'String' },
  { id: 'any', label: 'Any' }
];
const CONTAINERS: { id: '' | ContainerKind; label: string }[] = [
  { id: '', label: 'Single' },
  { id: 'array', label: 'Array' },
  { id: 'set', label: 'Set' },
  { id: 'map', label: 'Map' }
];

function field(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field';
  const text = document.createElement('span');
  text.textContent = label;
  row.append(text, control);
  return row;
}

function select(options: { id: string; label: string }[], value: string, label: string): HTMLSelectElement {
  const el = document.createElement('select');
  el.setAttribute('aria-label', label);
  for (const option of options) {
    const o = document.createElement('option');
    o.value = option.id;
    o.textContent = option.label;
    el.appendChild(o);
  }
  el.value = value;
  return el;
}

// The selected variable's settings, as in Unreal's Details panel for a variable.
function renderVariableDetails(variableId: string): boolean {
  const doc = state.document;
  const variable = doc?.variables.find((v) => v.id === variableId);
  if (!doc || !variable) return false;
  const refresh = (): void => {
    markDirty();
    // Variable nodes take the variable's name and type.
    render();
    renderMyBlueprint();
    renderPalette();
  };

  const wrapper = document.createElement('div');
  wrapper.className = 'details';
  wrapper.innerHTML = `<div class="inspector-name">${escapeHtml(variable.name)}</div><div class="muted inspector-type">Variable · ${escapeHtml(formatType(variable.type))}</div>`;
  const fields = document.createElement('div');
  fields.className = 'details-fields';

  const name = document.createElement('input');
  name.value = variable.name;
  name.setAttribute('aria-label', 'Variable Name');
  name.addEventListener('change', () => {
    const error = renameVariable(doc, variable.id, name.value);
    if (error) {
      setStatus(error);
      name.value = variable.name;
    } else refresh();
  });
  fields.appendChild(field('Variable Name', name));

  // Type and container, like Unreal's pin type picker with its container dropdown.
  const typeRow = document.createElement('div');
  typeRow.className = 'type-row';
  const elementType = select(VARIABLE_TYPES, variable.type.id, 'Variable Type');
  const container = select(CONTAINERS, variable.type.container ?? '', 'Container Type');
  const valueType = select(VARIABLE_TYPES, variable.type.valueType?.id ?? 'any', 'Map Value Type');
  valueType.hidden = variable.type.container !== 'map';
  const applyType = (): void => {
    const kind = container.value as '' | ContainerKind;
    setVariableType(doc, variable.id, {
      id: elementType.value,
      ...(kind ? { container: kind } : {}),
      ...(kind === 'map' ? { valueType: { id: valueType.value } } : {})
    });
    refresh();
  };
  [elementType, container, valueType].forEach((el) => el.addEventListener('change', applyType));
  typeRow.append(elementType, container, valueType);
  fields.appendChild(field('Variable Type', typeRow));

  fields.appendChild(field('Default Value', defaultValueEditor(variable)));

  const description = document.createElement('textarea');
  description.rows = 2;
  description.value = variable.description ?? '';
  description.setAttribute('aria-label', 'Description');
  description.addEventListener('change', () => {
    if (description.value.trim()) variable.description = description.value.trim();
    else delete variable.description;
    markDirty();
  });
  fields.appendChild(field('Description', description));

  const uses = variableUses(doc, variable.id);
  const usage = document.createElement('div');
  usage.className = 'muted';
  usage.textContent = uses ? `Used by ${uses} node${uses === 1 ? '' : 's'}.` : 'Not used by any node yet.';
  fields.appendChild(usage);

  wrapper.appendChild(fields);
  dom.inspector.innerHTML = '';
  dom.inspector.appendChild(wrapper);
  return true;
}

function defaultValueEditor(variable: GraphVariable): HTMLElement {
  const input = document.createElement('input');
  input.setAttribute('aria-label', 'Default Value');
  const type = variable.type;
  if (type.container) {
    // Editing container defaults arrives with container operations (Phase 4).
    input.type = 'text';
    input.value = JSON.stringify(variable.defaultValue ?? defaultValue(type));
    input.disabled = true;
    return input;
  }
  if (type.id === 'bool') {
    input.type = 'checkbox';
    input.checked = Boolean(variable.defaultValue);
  } else if (type.id === 'int' || type.id === 'float') {
    input.type = 'number';
    input.step = type.id === 'int' ? '1' : 'any';
    input.value = String(variable.defaultValue ?? 0);
  } else {
    input.type = 'text';
    input.value = variable.defaultValue === undefined || variable.defaultValue === null ? '' : String(variable.defaultValue);
  }
  input.addEventListener('change', () => {
    variable.defaultValue = input.type === 'checkbox' ? input.checked
      : input.type === 'number' ? (type.id === 'int' ? Math.trunc(Number(input.value)) : Number(input.value))
      : input.value;
    markDirty();
  });
  return input;
}
