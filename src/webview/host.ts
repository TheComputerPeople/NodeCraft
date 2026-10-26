import { UIMessage } from '../core/model';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState?(): unknown; setState?(state: unknown): void };

// acquireVsCodeApi may only be called once per webview, so it lives at module scope.
const vscode = acquireVsCodeApi();

export function postToHost(message: UIMessage): void {
  vscode.postMessage(message);
}

// The webview's own view state (which panels are collapsed), which VS Code keeps while the editor
// stays open, by key.
export function loadViewState<T>(key: string): T | undefined {
  const state = vscode.getState?.() as Record<string, unknown> | undefined;
  return state?.[key] as T | undefined;
}

export function saveViewState(key: string, value: unknown): void {
  const state = (vscode.getState?.() as Record<string, unknown> | undefined) ?? {};
  vscode.setState?.({ ...state, [key]: value });
}

export function newConnectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
