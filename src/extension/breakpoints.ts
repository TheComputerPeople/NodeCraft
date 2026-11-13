// Breakpoints on nodes and watched pins (docs/debugging.md, "Breakpoints"), kept in the
// workspace's state rather than in the graph file: setting one never changes the file, as in
// Unreal, where they are editor state and not part of the asset.
import * as vscode from 'vscode';
import { GraphBreakpoint, PinRef } from '../core/model';

// A list per graph file, by the file's URI.
export class PerFileStore<T> implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  // Fires with the graph file whose list changed.
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento, private readonly key: string) {}

  get(uri: vscode.Uri): T[] {
    return this.all()[uri.toString()] ?? [];
  }

  // Every graph file's list, by URI.
  all(): Record<string, T[]> {
    return this.state.get<Record<string, T[]>>(this.key, {});
  }

  async set(uri: vscode.Uri, items: T[]): Promise<void> {
    const all = { ...this.all() };
    if (items.length) all[uri.toString()] = items;
    else delete all[uri.toString()];
    await this.state.update(this.key, all);
    this.changed.fire(uri);
  }

  // A graph file renamed: its list moves with it.
  async move(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    const items = this.get(from);
    if (!items.length) return;
    await this.set(from, []);
    await this.set(to, items);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export class DebugMarks implements vscode.Disposable {
  readonly breakpoints: PerFileStore<GraphBreakpoint>;
  // Unreal's Watch this value.
  readonly watches: PerFileStore<PinRef>;

  constructor(state: vscode.Memento) {
    this.breakpoints = new PerFileStore(state, 'nodecraft.breakpoints');
    this.watches = new PerFileStore(state, 'nodecraft.watches');
  }

  async move(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    await this.breakpoints.move(from, to);
    await this.watches.move(from, to);
  }

  async forget(uri: vscode.Uri): Promise<void> {
    await this.breakpoints.set(uri, []);
    await this.watches.set(uri, []);
  }

  dispose(): void {
    this.breakpoints.dispose();
    this.watches.dispose();
  }
}
