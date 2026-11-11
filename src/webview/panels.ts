// The node palette (left) and the Details panel (right).
import { supports } from '../core/capabilities';
import {
  addSignaturePin, findVariable, functionUses, removeSignaturePin, renameGraph, renameSignaturePin, renameVariable, setFunctionPure, setSignaturePinType, setTypeLanguages, setVariableType, variableUses
} from '../core/blueprint-edits';
import { FUNCTION_ENTRY } from '../core/functions';
import { MACRO_INPUTS, MACRO_OUTPUTS } from '../core/macros';
import { definitionFor } from '../core/editing';
import { SWITCH_INT, SWITCH_STRING, switchIntCases, switchStringCases } from '../core/flow-control';
import { Access, Graph, GraphDocument, GraphNode, GraphSignature, GraphVariable } from '../core/model';
import { parseKeywords } from '../core/metadata';
import { ContainerKind, TypeRef } from '../core/types';
import { defaultValue } from '../core/values';
import { addNode, addPin } from './actions';
import { PaletteEntry, lookupDefinition, markDirty, paletteEntries, searchText, updateClassHierarchy, languageCapabilities, languageTerms, shownType } from './document';
import { dom, escapeHtml, setStatus } from './dom';
import { renderMyBlueprint } from './my-blueprint';
import { showPreview } from './preview';
import { render } from './render';
import { headerColor } from './style';
import { state } from './state';
import { screenToWorld } from './view';
import { UserType, listUserTypes } from '../core/user-types';
import { CUSTOM_EVENT } from '../core/events';
import { TEST_CASE } from '../core/tests';
import { ClassInfo, CodeClassInfo, ancestors, classTypeId } from '../core/objects';
import { renderDispatcherDetails, renderEventDetails, renderTestDetails } from './event-details';

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
      button.addEventListener('mouseenter', () => showPreview(dom.palettePreview, entry));
      button.addEventListener('focus', () => showPreview(dom.palettePreview, entry));
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
  if (!node && state.selectedDispatcherId && renderDispatcherDetails(state.selectedDispatcherId)) return;
  if (node?.type === CUSTOM_EVENT) {
    renderEventDetails(node);
    return;
  }
  if (node?.type === TEST_CASE) {
    renderTestDetails(node);
    return;
  }
  // A function's or macro's settings: when its graph is open with nothing selected, or its entry
  // (or a tunnel) is selected.
  const own = graph?.kind === 'function' ? [FUNCTION_ENTRY] : [MACRO_INPUTS, MACRO_OUTPUTS];
  if (graph && graph.kind !== 'event' && ((!node && state.selectedNodeIds.size === 0) || (node && own.includes(node.type)))) {
    renderFunctionDetails(graph);
    return;
  }
  // Unreal's Class Settings: shown for an event graph with nothing selected.
  if (graph?.kind === 'event' && !node && state.selectedNodeIds.size === 0 && state.document?.kind === 'class') {
    renderClassSettings();
    return;
  }
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
      list.insertAdjacentHTML('beforeend', `<dt>${escapeHtml(pin.name || pin.id)}</dt><dd>${pin.direction === 'input' ? 'Input' : 'Output'} · ${escapeHtml(shownType(pin.type))}</dd>`);
    }
    wrapper.appendChild(list);
  }
  const user = def.implementation;
  if (user?.kind === 'struct' && user.operation === 'set-members') wrapper.appendChild(membersEditor(node, user.type.fields));
  if (node.type === SWITCH_STRING) wrapper.appendChild(switchCasesEditor(node));
  if (node.type === SWITCH_INT) wrapper.appendChild(switchStartEditor(node));
  dom.inspector.innerHTML = '';
  dom.inspector.appendChild(wrapper);
}

// Class Settings: the Parent Class, from the workspace's classes in the same language (not this
// one, nor one that inherits from it).
function renderClassSettings(): void {
  const doc = state.document!;
  const own = classTypeId(doc.name);
  const candidates = workspaceTypes().filter((t) => t.kind === 'class' && t.id !== own && !ancestors(t as ClassInfo, (type) => state.defByType.get(type)).some((a) => a.id === own));
  const wrapper = document.createElement('div');
  wrapper.className = 'details';
  wrapper.innerHTML = `<div class="inspector-name">${escapeHtml(doc.name)}</div><div class="muted inspector-type">Class Settings</div>`;
  const fields = document.createElement('div');
  fields.className = 'details-fields';
  // Classes from the project's code too, in the languages this graph can use, with their files
  // (docs/code-classes-as-parents.md, part 1).
  const code = codeParentCandidates();
  const options = [{ id: '', label: 'None' }, ...candidates.map((t) => ({ id: t.id, label: t.name })), ...code.map((c) => ({ id: c.id, label: `${c.title} (${c.path})` }))];
  // A parent that's gone (renamed, moved, unmarked) stays chosen, and says so.
  if (doc.parent && !options.some((o) => o.id === doc.parent)) options.push({ id: doc.parent, label: `${doc.parent.replace(/^object:/, '').replace(/^code:.*#/, '')} (missing)` });
  const parent = select(options, doc.parent ?? '', 'Parent Class');
  const changed = (): void => {
    updateClassHierarchy();
    markDirty();
    render();
    renderMyBlueprint();
    renderPalette();
    renderInspector();
  };
  parent.addEventListener('change', () => {
    if (parent.value) doc.parent = parent.value;
    else delete doc.parent;
    changed();
  });
  // A language without inheritance or interfaces offers neither (unless the class already has one).
  const capabilities = languageCapabilities();
  if (supports(capabilities, 'inheritance') || doc.parent) fields.appendChild(field('Parent Class', parent));

  // Implemented Interfaces, as in Unreal's Class Settings.
  if (supports(capabilities, 'interfaces') || doc.interfaces?.length) fields.insertAdjacentHTML('beforeend', '<div class="details-heading">Implemented Interfaces</div>');
  const implemented = doc.interfaces ?? [];
  for (const id of implemented) {
    const row = document.createElement('div');
    row.className = 'signature-row';
    const label = document.createElement('span');
    label.textContent = id.replace(/^interface:/, '');
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = `Remove ${label.textContent}`;
    remove.addEventListener('click', () => {
      doc.interfaces = implemented.filter((i) => i !== id);
      if (!doc.interfaces.length) delete doc.interfaces;
      changed();
    });
    row.append(label, remove);
    fields.appendChild(row);
  }
  const available = workspaceTypes().filter((t) => t.kind === 'interface' && !implemented.includes(t.id));
  if (available.length && supports(capabilities, 'interfaces')) {
    const add = select([{ id: '', label: 'Add interface…' }, ...available.map((t) => ({ id: t.id, label: t.name }))], '', 'Add Interface');
    add.addEventListener('change', () => {
      if (!add.value) return;
      doc.interfaces = [...implemented, add.value];
      changed();
    });
    fields.appendChild(add);
  }
  fields.insertAdjacentHTML('beforeend', '<div class="muted">Select a node to see its details.</div>');
  wrapper.appendChild(fields);
  dom.inspector.innerHTML = '';
  dom.inspector.appendChild(wrapper);
}

// Set members in: a checkbox per field, for the fields the node changes (each gets a pin), as in
// Unreal's Details for the node.
function membersEditor(node: GraphNode, fields: { id: string; name: string }[]): HTMLElement {
  const list = document.createElement('div');
  list.className = 'details-fields';
  list.insertAdjacentHTML('beforeend', '<div class="details-heading">Members to set</div>');
  const chosen = new Set(Array.isArray(node.properties.members) ? (node.properties.members as string[]) : []);
  for (const f of fields) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = chosen.has(f.id);
    box.setAttribute('aria-label', f.name);
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(f.id);
      else chosen.delete(f.id);
      // Kept in field order; a field no longer set loses its wires.
      node.properties.members = fields.map((x) => x.id).filter((id) => chosen.has(id));
      if (!box.checked && state.graph) state.graph.connections = state.graph.connections.filter((c) => !(c.toNode === node.id && c.toPin === f.id));
      markDirty();
      render();
    });
    list.appendChild(field(f.name, box));
  }
  return list;
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
    addPin(node);
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

// ---- Function and macro details (Unreal's Details: Inputs, Outputs, Pure, Description) ------------

function renderFunctionDetails(graph: Graph): void {
  const doc = state.document;
  if (!doc) return;
  const macro = graph.kind === 'macro';
  const noun = macro ? 'Macro' : 'Function';
  const signature = graph.signature ?? { inputs: [], outputs: [] };
  const refresh = (): void => {
    markDirty();
    // Entry, return and call nodes take the signature's pins.
    render();
    renderPalette();
    renderInspector();
  };
  const wrapper = document.createElement('div');
  wrapper.className = 'details';
  wrapper.innerHTML = `<div class="inspector-name">${escapeHtml(graph.name)}</div><div class="muted inspector-type">${noun}</div>`;
  const fields = document.createElement('div');
  fields.className = 'details-fields';

  const name = document.createElement('input');
  name.value = graph.name;
  name.setAttribute('aria-label', `${noun} Name`);
  name.addEventListener('change', () => {
    const error = renameGraph(doc, graph.id, name.value);
    if (error) {
      setStatus(error);
      name.value = graph.name;
      return;
    }
    renderMyBlueprint();
    refresh();
  });
  fields.appendChild(field(`${noun} Name`, name));

  const description = document.createElement('textarea');
  description.rows = 2;
  description.value = signature.description ?? '';
  description.setAttribute('aria-label', 'Description');
  description.addEventListener('change', () => {
    const sig = (graph.signature ??= { inputs: [], outputs: [] });
    if (description.value.trim()) sig.description = description.value.trim();
    else delete sig.description;
    refresh();
  });
  fields.appendChild(field('Description', description));

  const category = document.createElement('input');
  category.value = signature.category ?? '';
  category.setAttribute('aria-label', 'Category');
  category.addEventListener('change', () => {
    const sig = (graph.signature ??= { inputs: [], outputs: [] });
    if (category.value.trim()) sig.category = category.value.trim();
    else delete sig.category;
    refresh();
  });
  fields.appendChild(field('Category', category));

  // Unreal's metadata (docs/node-authoring.md, gap 6).
  const text = (label: string, value: string | undefined, apply: (sig: GraphSignature, value: string) => void): void => {
    const input = document.createElement('input');
    input.value = value ?? '';
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      apply((graph.signature ??= { inputs: [], outputs: [] }), input.value.trim());
      refresh();
    });
    fields.appendChild(field(label, input));
  };
  text('Keywords', signature.keywords?.join(' '), (sig, value) => {
    const keywords = parseKeywords(value);
    if (keywords.length) sig.keywords = keywords;
    else delete sig.keywords;
  });
  text('Compact Node Title', signature.compactTitle, (sig, value) => {
    if (value) sig.compactTitle = value;
    else delete sig.compactTitle;
  });
  const deprecated = document.createElement('input');
  deprecated.type = 'checkbox';
  deprecated.checked = !!signature.deprecated;
  deprecated.setAttribute('aria-label', 'Deprecated');
  deprecated.addEventListener('change', () => {
    const sig = (graph.signature ??= { inputs: [], outputs: [] });
    if (deprecated.checked) sig.deprecated = {};
    else delete sig.deprecated;
    refresh();
  });
  fields.appendChild(field('Deprecated', deprecated));
  if (signature.deprecated) {
    text('Deprecation Message', signature.deprecated.message, (sig, value) => {
      if (sig.deprecated) sig.deprecated = value ? { message: value } : {};
    });
  }

  const pure = document.createElement('input');
  pure.type = 'checkbox';
  pure.checked = !!signature.pure;
  pure.setAttribute('aria-label', 'Pure');
  pure.addEventListener('change', () => {
    setFunctionPure(doc, graph.id, pure.checked);
    refresh();
  });
  // A macro is pure when it has no exec pins.
  if (!macro) fields.appendChild(field('Pure', pure));
  // Unreal's Access Specifier, for a class's functions.
  if (!macro && doc.kind === 'class') {
    fields.appendChild(field('Access Specifier', accessPicker(signature.access, (access) => {
      const sig = (graph.signature ??= { inputs: [], outputs: [] });
      if (access === 'public') delete sig.access;
      else sig.access = access;
      refresh();
    })));
  }

  for (const side of ['inputs', 'outputs'] as const) {
    fields.insertAdjacentHTML('beforeend', `<div class="details-heading">${side === 'inputs' ? 'Inputs' : 'Outputs'}</div>`);
    for (const pin of signature[side]) {
      const row = document.createElement('div');
      row.className = 'signature-row';
      const pinName = document.createElement('input');
      pinName.value = pin.name;
      pinName.setAttribute('aria-label', `${side === 'inputs' ? 'Input' : 'Output'} Name`);
      pinName.addEventListener('change', () => {
        const error = renameSignaturePin(doc, graph.id, side, pin.id, pinName.value);
        if (error) {
          setStatus(error);
          pinName.value = pin.name;
        } else refresh();
      });
      const type = typePicker(pin.kind === 'exec' ? 'exec' : pin.type ?? { id: 'any' }, `${pin.name} Type`, (t) => {
        setSignaturePinType(doc, graph.id, side, pin.id, t);
        refresh();
      }, macro);
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.title = `Remove ${pin.name}`;
      remove.addEventListener('click', () => {
        removeSignaturePin(doc, graph.id, side, pin.id);
        refresh();
      });
      row.append(pinName, type);
      // Unreal's Advanced View: the input folds under the node's arrow.
      if (side === 'inputs' && pin.kind === 'data') {
        const advanced = document.createElement('input');
        advanced.type = 'checkbox';
        advanced.checked = !!pin.advanced;
        advanced.title = 'Advanced View: shown under the node\'s arrow';
        advanced.setAttribute('aria-label', `${pin.name} Advanced View`);
        advanced.addEventListener('change', () => {
          if (advanced.checked) pin.advanced = true;
          else delete pin.advanced;
          refresh();
        });
        row.append(advanced);
      }
      row.append(remove);
      fields.appendChild(row);
    }
    const add = document.createElement('button');
    add.textContent = side === 'inputs' ? 'Add input' : 'Add output';
    add.addEventListener('click', () => {
      addSignaturePin(doc, graph.id, side);
      refresh();
    });
    fields.appendChild(add);
  }

  // A function library's languages: its functions are nodes in graphs of each (docs/node-authoring.md, gap 1).
  if (doc.kind === 'functionLibrary') {
    const shared = alsoGenerateFor(doc, refresh);
    if (shared) {
      fields.insertAdjacentHTML('beforeend', '<div class="details-heading">Library</div>');
      fields.appendChild(shared);
    }
  }

  const uses = functionUses(doc, graph.id);
  const usage = uses ? `${macro ? 'Used' : 'Called'} by ${uses} node${uses === 1 ? '' : 's'}.` : `Not ${macro ? 'used' : 'called'} yet: drag it from My Blueprint onto a graph.`;
  fields.insertAdjacentHTML('beforeend', `<div class="muted">${usage}</div>`);
  wrapper.appendChild(fields);
  dom.inspector.innerHTML = '';
  dom.inspector.appendChild(wrapper);
}

// The other languages a shared struct, enum or function library is generated for, as checkboxes;
// undefined when no other language is available (docs/multi-language.md, gap 2).
export function alsoGenerateFor(doc: GraphDocument, changed: () => void): HTMLElement | undefined {
  const others = state.languages.filter((l) => l.id !== doc.language);
  if (!others.length) return undefined;
  const shared = document.createElement('div');
  shared.className = 'type-languages';
  shared.setAttribute('role', 'group');
  shared.setAttribute('aria-label', 'Also Generate For');
  shared.insertAdjacentHTML('beforeend', '<span class="muted">Also generate for</span>');
  for (const language of others) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = doc.languages?.includes(language.id) ?? false;
    box.addEventListener('change', () => {
      const chosen = (doc.languages ?? []).filter((l) => l !== language.id);
      setTypeLanguages(doc, box.checked ? [...chosen, language.id] : chosen);
      changed();
    });
    label.append(box, document.createTextNode(` ${language.displayName}`));
    shared.appendChild(label);
  }
  return shared;
}

// Unreal's pin type picker: a type, a container, and a map's value type. Macros also offer Exec.
export function typePicker<T extends TypeRef | 'exec'>(type: T, label: string, apply: (type: T | TypeRef) => void, allowExec = false, exclude?: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'type-row';
  const data = type === 'exec' ? undefined : (type as TypeRef);
  const elementType = select(allowExec ? [{ id: 'exec', label: 'Exec' }, ...typeOptions(exclude)] : typeOptions(exclude), data?.id ?? 'exec', label);
  const container = select(containerOptions(data?.container), data?.container ?? '', `${label} Container`);
  const valueType = select(typeOptions(), data?.valueType?.id ?? 'any', `${label} Map Value`);
  container.hidden = !data;
  valueType.hidden = data?.container !== 'map';
  const change = (): void => {
    if (elementType.value === 'exec') {
      apply('exec' as T);
      return;
    }
    const kind = container.value as '' | ContainerKind;
    apply({ id: elementType.value, ...(kind ? { container: kind } : {}), ...(kind === 'map' ? { valueType: { id: valueType.value } } : {}) });
  };
  [elementType, container, valueType].forEach((el) => el.addEventListener('change', change));
  row.append(elementType, container, valueType);
  return row;
}

// The built-in types, then the workspace's structs and enums in the document's language (but not a
// structure itself, which can't contain itself).
export function typeOptions(exclude?: string): { id: string; label: string }[] {
  return [...basicTypes(), ...workspaceTypes().filter((t) => t.id !== exclude).map((t) => ({ id: t.id, label: t.name }))];
}

// The classes from the project's code a graph class in this language may extend.
export function codeParentCandidates(): CodeClassInfo[] {
  const language = state.languages.find((l) => l.id === state.document?.language);
  return state.definitions
    .flatMap((d) => (d.implementation?.kind === 'code-class' ? [d.implementation.type] : []))
    .filter((c) => (language ? language.callable.includes(c.language) : !state.document?.language || c.language === state.document.language))
    .sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
}

export function workspaceTypes(): UserType[] {
  return listUserTypes(state.definitions, state.document?.language);
}

function userType(id: string): UserType | undefined {
  return workspaceTypes().find((t) => t.id === id);
}

const VARIABLE_TYPES: { id: string; label: string }[] = [
  { id: 'bool', label: 'Boolean' },
  { id: 'int', label: 'Integer' },
  { id: 'float', label: 'Float' },
  { id: 'string', label: 'String' },
  { id: 'any', label: 'Any' }
];

// The basic types, in the graph language's terms when it has them (Python's int, float, str).
function basicTypes(): { id: string; label: string }[] {
  const terms = languageTerms();
  return terms ? VARIABLE_TYPES.map((t) => ({ id: t.id, label: shownType({ id: t.id }) })) : VARIABLE_TYPES;
}

// The containers the graph's language has (and the one a type already uses, so it still shows), by
// its names for them.
function containerOptions(current?: ContainerKind): { id: '' | ContainerKind; label: string }[] {
  const capabilities = languageCapabilities();
  const terms = languageTerms();
  const containers: { id: '' | ContainerKind; label: string }[] = [
    { id: '', label: 'Single' },
    { id: 'array', label: terms?.array ?? 'Array' },
    { id: 'set', label: terms?.set ?? 'Set' },
    { id: 'map', label: terms?.map ?? 'Map' }
  ];
  return containers.filter((c) => !c.id || c.id === current || supports(capabilities, c.id));
}

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
  const found = doc && findVariable(doc, variableId);
  const variable = found?.variable;
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
  wrapper.innerHTML = `<div class="inspector-name">${escapeHtml(variable.name)}</div><div class="muted inspector-type">${found?.graph ? `Local variable of ${escapeHtml(found.graph.name)}` : 'Variable'} · ${escapeHtml(shownType(variable.type))}</div>`;
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
  const elementType = select(typeOptions(), variable.type.id, 'Variable Type');
  const container = select(containerOptions(variable.type.container), variable.type.container ?? '', 'Container Type');
  const valueType = select(typeOptions(), variable.type.valueType?.id ?? 'any', 'Map Value Type');
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
  // A member variable's access (Unreal's Private flag, with Protected as for functions).
  if (!found?.graph && doc.kind === 'class') {
    fields.appendChild(field('Access', accessPicker(variable.access, (access) => {
      if (access === 'public') delete variable.access;
      else variable.access = access;
      refresh();
    })));
  }

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

// A container variable's default, one row per element (a key and a value per row for a map), as
// Unreal's Details lists them. Stored as a JSON array; a map as [key, value] pairs.
function containerDefaultEditor(variable: GraphVariable): HTMLElement {
  const type = variable.type;
  const list = document.createElement('div');
  list.className = 'container-default';
  const rows = (): unknown[] => (Array.isArray(variable.defaultValue) ? [...variable.defaultValue] : []);
  const save = (values: unknown[]): void => {
    variable.defaultValue = values;
    markDirty();
  };
  const redraw = (): void => {
    list.replaceWith(containerDefaultEditor(variable));
  };
  rows().forEach((row, i) => {
    const line = document.createElement('div');
    line.className = 'container-row';
    const set = (column: 0 | 1, value: unknown): void => {
      const values = rows();
      values[i] = type.container === 'map' ? (column === 0 ? [value, (values[i] as unknown[])?.[1]] : [(values[i] as unknown[])?.[0], value]) : value;
      save(values);
    };
    if (type.container === 'map') {
      const pair = Array.isArray(row) ? row : [undefined, undefined];
      line.append(elementEditor(type.id, pair[0], (v) => set(0, v), `Key ${i}`), elementEditor(type.valueType?.id ?? 'any', pair[1], (v) => set(1, v), `Value ${i}`));
    } else {
      line.append(elementEditor(type.id, row, (v) => set(0, v), `Element ${i}`));
    }
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = 'Remove this element';
    remove.addEventListener('click', () => {
      save(rows().filter((_, j) => j !== i));
      redraw();
    });
    line.appendChild(remove);
    list.appendChild(line);
  });
  const add = document.createElement('button');
  add.textContent = 'Add element';
  add.addEventListener('click', () => {
    const blank = defaultValue({ id: type.id });
    save([...rows(), type.container === 'map' ? [blank, defaultValue(type.valueType)] : blank]);
    redraw();
  });
  list.appendChild(add);
  return list;
}

// An editor for one value of a primitive type, or an enum's value (stored by id).
function elementEditor(typeId: string, value: unknown, change: (value: unknown) => void, label: string): HTMLElement {
  const enumType = userType(typeId);
  if (enumType?.kind === 'enum') return enumSelect(enumType, value, change, label);
  const input = document.createElement('input');
  input.setAttribute('aria-label', label);
  if (typeId === 'bool') {
    input.type = 'checkbox';
    input.checked = Boolean(value);
  } else if (typeId === 'int' || typeId === 'float') {
    input.type = 'number';
    input.step = typeId === 'int' ? '1' : 'any';
    input.value = String(value ?? 0);
  } else {
    input.value = value === undefined || value === null ? '' : String(value);
  }
  input.addEventListener('change', () => change(input.type === 'checkbox' ? input.checked
    : input.type === 'number' ? (typeId === 'int' ? Math.trunc(Number(input.value)) : Number(input.value))
    : input.value));
  return input;
}

export function defaultValueEditor(variable: GraphVariable): HTMLElement {
  const input = document.createElement('input');
  input.setAttribute('aria-label', 'Default Value');
  const type = variable.type;
  if (type.container) return containerDefaultEditor(variable);
  const user = userType(type.id);
  if (user?.kind === 'enum') {
    return enumSelect(user, variable.defaultValue, (value) => {
      variable.defaultValue = value;
      markDirty();
    }, 'Default Value');
  }
  if (user?.kind === 'struct' || type.id.startsWith('struct:')) {
    const note = document.createElement('span');
    note.className = 'muted';
    note.textContent = `The field defaults of ${user?.name ?? type.id.slice('struct:'.length)}.`;
    return note;
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

// Public, Protected or Private.
function accessPicker(value: Access | undefined, apply: (access: Access) => void): HTMLSelectElement {
  const el = select([{ id: 'public', label: 'Public' }, { id: 'protected', label: 'Protected' }, { id: 'private', label: 'Private' }], value ?? 'public', 'Access');
  el.addEventListener('change', () => apply(el.value as Access));
  return el;
}

// A dropdown of an enum's values (Unreal's enum pin editor); the stored value is the value's id.
export function enumSelect(type: { enumerators: { id: string; name: string }[] }, value: unknown, change: (value: string) => void, label: string): HTMLSelectElement {
  const el = select(type.enumerators.map((e) => ({ id: e.id, label: e.name })), typeof value === 'string' && type.enumerators.some((e) => e.id === value) ? value : type.enumerators[0]?.id ?? '', label);
  el.addEventListener('change', () => change(el.value));
  return el;
}
