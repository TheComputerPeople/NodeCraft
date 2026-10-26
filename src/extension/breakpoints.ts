// Breakpoints on graph nodes (docs/debugging.md, "Breakpoints"), kept in the workspace's state
// rather than in the graph file: setting one never changes the file, as in Unreal, where
// breakpoints are editor state and not part of the asset.
import * as vscode from 'vscode';
import { GraphBreakpoint } from '../core/model';

const KEY = 'blueprintVisualScripting.breakpoints';

export class BreakpointStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  // Fires with the graph file whose breakpoints changed.
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {}

  get(uri: vscode.Uri): GraphBreakpoint[] {
    return this.all()[uri.toString()] ?? [];
  }

  // Every graph file's breakpoints, by URI.
  all(): Record<string, GraphBreakpoint[]> {
    return this.state.get<Record<string, GraphBreakpoint[]>>(KEY, {});
  }

  async set(uri: vscode.Uri, breakpoints: GraphBreakpoint[]): Promise<void> {
    const all = { ...this.all() };
    if (breakpoints.length) all[uri.toString()] = breakpoints;
    else delete all[uri.toString()];
    await this.state.update(KEY, all);
    this.changed.fire(uri);
  }

  // A graph file renamed: its breakpoints move with it.
  async move(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    const breakpoints = this.get(from);
    if (!breakpoints.length) return;
    await this.set(from, []);
    await this.set(to, breakpoints);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
