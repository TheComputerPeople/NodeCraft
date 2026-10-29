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
  myBlueprint: element<HTMLDivElement>('mb-sections'),
  floatingMenu: element<HTMLDivElement>('floating-menu'),
  dragGhost: element<HTMLDivElement>('drag-ghost'),
  search: element<HTMLInputElement>('search'),
  inspector: element<HTMLDivElement>('inspector-content'),
  status: element<HTMLSpanElement>('status'),
  graphName: element<HTMLSpanElement>('graph-name'),
  contextMenu: element<HTMLDivElement>('context-menu'),
  compileButton: element<HTMLButtonElement>('compile'),
  runButton: element<HTMLButtonElement>('run'),
  simulateButton: element<HTMLButtonElement>('simulate'),
  debugButton: element<HTMLButtonElement>('debug'),
  languageSelect: element<HTMLSelectElement>('language'),
  results: element<HTMLElement>('compiler-results'),
  resultsTitle: element<HTMLSpanElement>('results-title'),
  resultsList: element<HTMLUListElement>('results-list'),
  resultsClose: element<HTMLButtonElement>('results-close'),
  find: element<HTMLElement>('find-results'),
  findInput: element<HTMLInputElement>('find-input'),
  findAll: element<HTMLInputElement>('find-all'),
  findList: element<HTMLUListElement>('find-list'),
  findClose: element<HTMLButtonElement>('find-close'),
  fitButton: element<HTMLButtonElement>('fit'),
  // Simulate's debugger: its state, buttons and call stack.
  debugger: element<HTMLElement>('debugger'),
  debugTitle: element<HTMLSpanElement>('debug-title'),
  debugActions: element<HTMLSpanElement>('debug-actions'),
  callStack: element<HTMLOListElement>('call-stack'),
  // A hovered pin's value while paused.
  valueBubble: element<HTMLDivElement>('value-bubble'),
  // Structure and enumeration files are edited here instead of on the canvas.
  typeEditor: element<HTMLElement>('type-editor'),
  palette: element<HTMLElement>('palette'),
  // The highlighted palette entry's code in the graph's language (src/webview/preview.ts).
  palettePreview: element<HTMLDivElement>('palette-preview'),
  help: element<HTMLElement>('help')
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
