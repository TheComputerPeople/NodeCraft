// The node palette (left) and the Details panel (right).
import { definitionFor } from '../core/editing';
import { formatType } from '../core/types';
import { addNode } from './actions';
import { PaletteEntry, lookupDefinition, paletteEntries, searchText } from './document';
import { dom, escapeHtml } from './dom';
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
  dom.inspector.innerHTML = '';
  dom.inspector.appendChild(wrapper);
}
