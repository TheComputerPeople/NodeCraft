// The code preview (docs/language-context.md, part 3): the highlighted palette or Add Node menu entry,
// in the graph's language. The host works it out (src/core/preview.ts); answers are kept for each
// entry and language until the definitions or the document change.
import { NodePreview } from '../core/preview';
import { DEFAULT_LANGUAGE } from '../core/languages';
import type { PaletteEntry } from './document';
import { postToHost } from './host';
import { state } from './state';

const PREVIEW_DELAY_MS = 120;

const cache = new Map<string, NodePreview | null>();
const waiting = new Map<number, string>();
let nextRequest = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
// The pane and entry the preview is for now.
let shown: { pane: HTMLElement; key: string; language: string } | undefined;

function languageName(): string {
  const id = state.document?.language || DEFAULT_LANGUAGE;
  return state.languages.find((l) => l.id === id)?.displayName ?? id;
}

function cacheKey(entry: PaletteEntry): string {
  return `${state.document?.language || DEFAULT_LANGUAGE}|${entry.type}|${JSON.stringify(entry.properties)}`;
}

// Shows the entry's code in `pane`, asking the host when it isn't known yet.
export function showPreview(pane: HTMLElement, entry: PaletteEntry): void {
  const key = cacheKey(entry);
  shown = { pane, key, language: languageName() };
  if (cache.has(key)) {
    fill(pane, cache.get(key) ?? null, shown.language);
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!state.document || shown?.key !== key) return;
    const requestId = nextRequest++;
    waiting.set(requestId, key);
    postToHost({ type: 'previewNode', requestId, nodeType: entry.type, properties: entry.properties, document: state.document });
  }, PREVIEW_DELAY_MS);
}

export function receivePreview(requestId: number, preview: NodePreview | undefined): void {
  const key = waiting.get(requestId);
  if (key === undefined) return;
  waiting.delete(requestId);
  cache.set(key, preview ?? null);
  if (shown?.key === key && shown.pane.isConnected) fill(shown.pane, preview ?? null, shown.language);
}

// Previews are worked out again after the definitions or the document change.
export function forgetPreviews(): void {
  cache.clear();
}

function fill(pane: HTMLElement, preview: NodePreview | null, language: string): void {
  pane.hidden = false;
  pane.replaceChildren();
  const title = document.createElement('div');
  title.className = 'node-preview-title';
  title.textContent = preview ? `In ${language}` : `No ${language} preview`;
  pane.appendChild(title);
  if (!preview) return;
  const code = document.createElement('pre');
  code.className = 'node-preview-code';
  code.textContent = preview.code;
  pane.appendChild(code);
}
