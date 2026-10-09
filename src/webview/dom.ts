// Fails at startup, rather than on first use, if the host's markup is missing an element.
function element<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Webview markup is missing #${id}`);
  return el as unknown as T;
}

export const dom = {
  world: element<HTMLDivElement>('world'),
  edges: element<SVGSVGElement>('edges'),
  canvasWrap: element<HTMLDivElement>('canvas-wrap'),
  selectionBox: element<HTMLDivElement>('selection-box'),
  categories: element<HTMLDivElement>('categories'),
  search: element<HTMLInputElement>('search'),
  inspector: element<HTMLDivElement>('inspector-content'),
  status: element<HTMLSpanElement>('status'),
  graphName: element<HTMLSpanElement>('graph-name'),
  contextMenu: element<HTMLDivElement>('context-menu'),
  runButton: element<HTMLButtonElement>('run'),
  fitButton: element<HTMLButtonElement>('fit')
};

export function setStatus(text: string): void {
  dom.status.textContent = text;
}

// The element an event happened on, or null for non-element targets (e.g. window).
export function eventElement(e: Event): Element | null {
  return e.target instanceof Element ? e.target : null;
}

export function pinElement(nodeId: string, pinId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.pin[data-node="${cssEscape(nodeId)}"][data-pin="${cssEscape(pinId)}"]`);
}

export function nodeElement(nodeId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.node[data-node="${cssEscape(nodeId)}"]`);
}

export function escapeHtml(text: unknown): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
  return String(text).replace(/[&<>'"]/g, (c) => entities[c]);
}

function cssEscape(text: string): string {
  return String(text).replace(/(["\\#.[\]:])/g, '\\$1');
}
