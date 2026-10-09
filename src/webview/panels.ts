// The node palette (left) and the Details panel (right).
import { definitionFor } from '../core/editing';
import { NodeDefinition } from '../core/model';
import { addNode, deleteSelected } from './actions';
import { lookupDefinition, markDirty } from './document';
import { dom, escapeHtml } from './dom';
import { state } from './state';
import { screenToWorld } from './view';

export function renderPalette(): void {
  dom.categories.innerHTML = '';
  const q = dom.search.value.trim().toLowerCase();
  const grouped = new Map<string, NodeDefinition[]>();
  for (const d of state.definitions) {
    if (!`${d.displayName} ${d.category} ${d.description || ''}`.toLowerCase().includes(q)) continue;
    if (!grouped.has(d.category)) grouped.set(d.category, []);
    grouped.get(d.category)!.push(d);
  }
  [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([category, defs]) => {
    const section = document.createElement('section');
    const title = document.createElement('div');
    title.className = 'category-title';
    title.textContent = category;
    section.appendChild(title);
    for (const def of defs) {
      const button = document.createElement('button');
      button.className = 'palette-node';
      button.innerHTML = `<span class="palette-dot" style="--node-color:${escapeHtml(def.color || '#6b7280')}"></span><span><strong>${escapeHtml(def.displayName)}</strong><small>${escapeHtml(def.description || '')}</small></span>`;
      button.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const rect = dom.canvasWrap.getBoundingClientRect();
        addNode(def.type, screenToWorld(rect.left + dom.canvasWrap.clientWidth / 2, rect.top + 120));
      });
      section.appendChild(button);
    }
    dom.categories.appendChild(section);
  });
}

export function renderInspector(): void {
  const graph = state.graph;
  const node = graph?.nodes.find((n) => n.id === state.selectedNodeId);
  if (!graph || !node) {
    dom.inspector.innerHTML = state.selectedNodeIds.size > 1
      ? `<div class="muted">${state.selectedNodeIds.size} nodes selected.</div>`
      : '<div class="muted">Select a node to edit defaults.</div>';
    return;
  }
  const def = definitionFor(node, lookupDefinition);
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<div class="inspector-name">${escapeHtml(def.displayName)}</div><div class="muted inspector-type">${escapeHtml(node.type)}</div>`;
  const group = document.createElement('div');
  group.className = 'inspector-fields';
  for (const pin of def.inputs.filter((p) => p.kind === 'data')) {
    const key = `pin:${pin.id}`;
    const typeId = pin.type?.id;
    const row = document.createElement('label');
    row.className = 'field';
    const text = document.createElement('span');
    text.textContent = `${pin.name} (${typeId || 'any'})`;
    const input = document.createElement('input');
    // A connected input takes its value from the wire, so its default is not editable.
    input.disabled = graph.connections.some((c) => c.toNode === node.id && c.toPin === pin.id);
    const value = node.properties[key] ?? '';
    if (typeId === 'bool') {
      input.type = 'checkbox';
      input.checked = Boolean(value);
    } else {
      input.type = typeId === 'number' || typeId === 'int' || typeId === 'float' ? 'number' : 'text';
      input.value = String(value);
    }
    input.addEventListener('input', () => {
      node.properties[key] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
      markDirty();
    });
    row.append(text, input);
    group.appendChild(row);
  }
  wrapper.appendChild(group);
  const deleteButton = document.createElement('button');
  deleteButton.className = 'danger';
  deleteButton.textContent = state.selectedNodeIds.size > 1 ? `Delete ${state.selectedNodeIds.size} Nodes` : 'Delete Node';
  deleteButton.addEventListener('click', deleteSelected);
  wrapper.appendChild(deleteButton);
  dom.inspector.innerHTML = '';
  dom.inspector.appendChild(wrapper);
}
