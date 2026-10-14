// The editor for structure and enumeration files (docs/program-structure.md, "Structs and enums"),
// shown instead of the graph canvas, as Unreal opens struct and enum assets in their own editors:
// a structure's fields (name, type, default value) or an enumeration's values (display name,
// description), in order.
import { addEnumerator, addVariable, deleteVariable, moveMember, removeEnumerator, renameEnumerator, renameVariable, setVariableType } from '../core/blueprint-edits';
import { GraphDocument } from '../core/model';
import { structTypeId } from '../core/user-types';
import { markDirty } from './document';
import { dom, setStatus } from './dom';
import { defaultValueEditor, typePicker } from './panels';
import { state } from './state';

export function isTypeDocument(doc: GraphDocument | null | undefined): boolean {
  return doc?.kind === 'structure' || doc?.kind === 'enumeration';
}

export function renderTypeEditor(): void {
  const doc = state.document;
  const root = dom.typeEditor;
  root.innerHTML = '';
  if (!doc || !isTypeDocument(doc)) return;
  const struct = doc.kind === 'structure';
  const refresh = (): void => {
    markDirty();
    renderTypeEditor();
  };

  const title = document.createElement('div');
  title.className = 'type-title';
  title.innerHTML = `<span class="inspector-name"></span><span class="muted">${struct ? 'Structure' : 'Enumeration'}</span>`;
  title.querySelector('.inspector-name')!.textContent = doc.name;
  root.appendChild(title);

  const description = document.createElement('textarea');
  description.rows = 2;
  description.placeholder = 'Description';
  description.setAttribute('aria-label', 'Description');
  description.value = typeof doc.metadata?.description === 'string' ? doc.metadata.description : '';
  description.addEventListener('change', () => {
    doc.metadata = { ...(doc.metadata ?? {}) };
    if (description.value.trim()) doc.metadata.description = description.value.trim();
    else delete doc.metadata.description;
    markDirty();
  });
  root.appendChild(description);

  const table = document.createElement('div');
  table.className = 'type-members';
  table.insertAdjacentHTML('beforeend', struct
    ? '<div class="type-member type-header"><span>Name</span><span>Type</span><span>Default Value</span><span></span></div>'
    : '<div class="type-member type-header"><span>Display Name</span><span>Description</span><span></span></div>');

  const order = (id: string, count: number, index: number): HTMLElement => {
    const buttons = document.createElement('span');
    buttons.className = 'type-actions';
    const button = (text: string, label: string, action: () => void, disabled = false): void => {
      const b = document.createElement('button');
      b.textContent = text;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.disabled = disabled;
      b.addEventListener('click', action);
      buttons.appendChild(b);
    };
    button('↑', 'Move up', () => {
      moveMember(doc, id, -1);
      refresh();
    }, index === 0);
    button('↓', 'Move down', () => {
      moveMember(doc, id, 1);
      refresh();
    }, index === count - 1);
    button('×', 'Remove', () => {
      if (struct) deleteVariable(doc, id);
      else {
        const error = removeEnumerator(doc, id);
        if (error) {
          setStatus(error);
          return;
        }
      }
      refresh();
    });
    return buttons;
  };

  if (struct) {
    doc.variables.forEach((field, i) => {
      const row = document.createElement('div');
      row.className = 'type-member';
      row.dataset.member = field.id;
      const name = document.createElement('input');
      name.value = field.name;
      name.setAttribute('aria-label', 'Field Name');
      name.addEventListener('change', () => {
        const error = renameVariable(doc, field.id, name.value);
        if (error) {
          setStatus(error);
          name.value = field.name;
        } else refresh();
      });
      const type = typePicker(field.type, `${field.name} Type`, (t) => {
        setVariableType(doc, field.id, t);
        refresh();
      }, false, structTypeId(doc.name));
      row.append(name, type, defaultValueEditor(field), order(field.id, doc.variables.length, i));
      table.appendChild(row);
    });
  } else {
    const values = doc.enumerators ?? [];
    values.forEach((value, i) => {
      const row = document.createElement('div');
      row.className = 'type-member';
      row.dataset.member = value.id;
      const name = document.createElement('input');
      name.value = value.name;
      name.setAttribute('aria-label', 'Display Name');
      name.addEventListener('change', () => {
        const error = renameEnumerator(doc, value.id, name.value);
        if (error) {
          setStatus(error);
          name.value = value.name;
        } else refresh();
      });
      const note = document.createElement('input');
      note.value = value.description ?? '';
      note.setAttribute('aria-label', 'Value Description');
      note.addEventListener('change', () => {
        if (note.value.trim()) value.description = note.value.trim();
        else delete value.description;
        markDirty();
      });
      row.append(name, note, order(value.id, values.length, i));
      table.appendChild(row);
    });
  }
  root.appendChild(table);

  const add = document.createElement('button');
  add.className = 'type-add';
  add.textContent = struct ? '+ Add Variable' : '+ Add Enumerator';
  add.addEventListener('click', () => {
    if (struct) addVariable(doc);
    else addEnumerator(doc);
    refresh();
    root.querySelector<HTMLInputElement>('.type-member:last-child input')?.select();
  });
  root.appendChild(add);
}
