import { UIMessage } from '../core/model';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

// acquireVsCodeApi may only be called once per webview, so it lives at module scope.
const vscode = acquireVsCodeApi();

export function postToHost(message: UIMessage): void {
  vscode.postMessage(message);
}

export function newConnectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
