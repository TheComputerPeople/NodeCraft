// Details for a custom event (its name and inputs) and for an event dispatcher (its name and
// parameters), as in Unreal's Details panel for each (src/core/events.ts).
import {
  EventOwner, addEventParam, eventUses, removeEventParam, renameCustomEvent, renameDispatcher, renameEventParam, setEventParamType
} from '../core/blueprint-edits';
import { documentDispatchers, eventInputs, eventName } from '../core/events';
import { GraphNode, GraphPin } from '../core/model';
import { markDirty } from './document';
import { dom, escapeHtml, setStatus } from './dom';
import { renderMyBlueprint } from './my-blueprint';
import { renderPalette, typePicker } from './panels';
import { render } from './render';
import { state } from './state';

export function renderEventDetails(node: GraphNode): void {
  const doc = state.document;
  if (!doc) return;
  const name = textField('Event Name', eventName(node), (value) => renameCustomEvent(doc, node, value));
  const uses = eventUses(doc, node);
  show(eventName(node), 'Custom Event', [
    field('Event Name', name),
    ...paramRows({ event: node }, eventInputs(node), 'Inputs'),
    note(uses ? `Called by ${uses} node${uses === 1 ? '' : 's'}.` : 'Not called yet: find it in the action menu, or bind it to an event dispatcher.')
  ]);
}

export function renderDispatcherDetails(id: string): boolean {
  const doc = state.document;
  const dispatcher = documentDispatchers(doc ?? undefined).find((d) => d.id === id);
  if (!doc || !dispatcher) return false;
  const name = textField('Dispatcher Name', dispatcher.name, (value) => renameDispatcher(doc, id, value));
  show(dispatcher.name, 'Event Dispatcher', [
    field('Dispatcher Name', name),
    ...paramRows({ dispatcher: id }, dispatcher.inputs, 'Inputs'),
    note('Drag it onto a graph to Call, Bind, Unbind or Assign it.')
  ]);
  return true;
}

function refresh(): void {
  markDirty();
  render();
  renderMyBlueprint();
  renderPalette();
}

function show(title: string, kind: string, rows: HTMLElement[]): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'details';
  wrapper.innerHTML = `<div class="inspector-name">${escapeHtml(title)}</div><div class="muted inspector-type">${escapeHtml(kind)}</div>`;
  const fields = document.createElement('div');
  fields.className = 'details-fields';
  fields.append(...rows);
  wrapper.appendChild(fields);
  dom.inspector.innerHTML = '';
  dom.inspector.appendChild(wrapper);
}

// A parameter list, as a function's Inputs in Details: name, type, remove; and Add input.
function paramRows(owner: EventOwner, pins: GraphPin[], heading: string): HTMLElement[] {
  const doc = state.document!;
  const rows: HTMLElement[] = [];
  const title = document.createElement('div');
  title.className = 'details-heading';
  title.textContent = heading;
  rows.push(title);
  for (const pin of pins) {
    const row = document.createElement('div');
    row.className = 'signature-row';
    const pinName = textField('Input Name', pin.name, (value) => renameEventParam(doc, owner, pin.id, value));
    const type = typePicker(pin.type ?? { id: 'any' }, `${pin.name} Type`, (t) => {
      setEventParamType(doc, owner, pin.id, t);
      refresh();
    });
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = `Remove ${pin.name}`;
    remove.addEventListener('click', () => {
      removeEventParam(doc, owner, pin.id);
      refresh();
    });
    row.append(pinName, type, remove);
    rows.push(row);
  }
  const add = document.createElement('button');
  add.textContent = 'Add input';
  add.addEventListener('click', () => {
    addEventParam(doc, owner);
    refresh();
  });
  rows.push(add);
  return rows;
}

// A text input that applies on change, or shows why it can't and puts the old value back.
function textField(label: string, value: string, apply: (value: string) => string | undefined): HTMLInputElement {
  const input = document.createElement('input');
  input.value = value;
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => {
    const error = apply(input.value);
    if (error) {
      setStatus(error);
      input.value = value;
    } else refresh();
  });
  return input;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field';
  const text = document.createElement('span');
  text.textContent = label;
  row.append(text, control);
  return row;
}

function note(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'muted';
  el.textContent = text;
  return el;
}
