// The graph tabs of one open file, and its Back and Forward history, as in Unreal's Blueprint editor
// (docs/unreal-conventions.md, "Graph tabs"): each event graph, function or macro opened gets a tab
// above the canvas, and Back and Forward step through the graphs visited. The webview renders it.

export interface GraphTabsState {
  // Graph ids, in tab order.
  open: string[];
  active: string | null;
  // Most recently active first: closing the active tab shows the one before it, as VS Code does.
  recent: string[];
  // The graphs visited, oldest first, and the current entry's index.
  history: string[];
  position: number;
}

// Back goes this many graphs back at most.
export const HISTORY_LIMIT = 50;

export class GraphTabs {
  open: string[] = [];
  active: string | null = null;
  private recent: string[] = [];
  private history: string[] = [];
  private position = -1;

  // Tabs from a saved state; anything malformed is dropped.
  static restore(saved: unknown): GraphTabs {
    const tabs = new GraphTabs();
    if (!saved || typeof saved !== 'object') return tabs;
    const s = saved as Partial<GraphTabsState>;
    const ids = (list: unknown): string[] => (Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []);
    tabs.open = [...new Set(ids(s.open))];
    tabs.active = typeof s.active === 'string' && tabs.open.includes(s.active) ? s.active : tabs.open[0] ?? null;
    tabs.recent = [...new Set(ids(s.recent))].filter((id) => tabs.open.includes(id));
    tabs.history = ids(s.history);
    tabs.position = typeof s.position === 'number' && s.position >= 0 && s.position < tabs.history.length ? Math.floor(s.position) : tabs.history.length - 1;
    return tabs;
  }

  save(): GraphTabsState {
    return { open: [...this.open], active: this.active, recent: [...this.recent], history: [...this.history], position: this.position };
  }

  get canGoBack(): boolean {
    return this.position > 0;
  }

  get canGoForward(): boolean {
    return this.position < this.history.length - 1;
  }

  // Shows a graph: its tab if it has one, else a new tab at the end. A visit is recorded in the
  // history (dropping anything Forward would have reached), unless it's the current entry.
  show(id: string): void {
    this.activate(id);
    if (this.history[this.position] === id) return;
    this.history = [...this.history.slice(0, this.position + 1), id].slice(-HISTORY_LIMIT);
    this.position = this.history.length - 1;
  }

  // The graph Back shows (reopening its tab if it was closed), or undefined at the start.
  back(): string | undefined {
    return this.step(-1);
  }

  forward(): string | undefined {
    return this.step(1);
  }

  // Closes tabs, but never every tab: the canvas always shows a graph. Returns the graph now shown.
  close(ids: readonly string[]): string | null {
    const closing = new Set(ids);
    const remaining = this.open.filter((id) => !closing.has(id));
    if (!remaining.length) return this.active;
    this.open = remaining;
    this.recent = this.recent.filter((id) => !closing.has(id));
    if (this.active && closing.has(this.active)) this.show(this.recent[0] ?? remaining[0]);
    return this.active;
  }

  closeOthers(id: string): string | null {
    return this.close(this.open.filter((other) => other !== id));
  }

  closeToTheRight(id: string): string | null {
    const index = this.open.indexOf(id);
    return index < 0 ? this.active : this.close(this.open.slice(index + 1));
  }

  // Moves a tab to `index` in the tab order (as dragging it does).
  move(id: string, index: number): void {
    const from = this.open.indexOf(id);
    if (from < 0) return;
    const rest = this.open.filter((other) => other !== id);
    const to = Math.max(0, Math.min(index, rest.length));
    this.open = [...rest.slice(0, to), id, ...rest.slice(to)];
  }

  // Follows the file's graphs: tabs and history entries of graphs that no longer exist go (a
  // deleted graph, an undo, an edit outside the editor). When the shown graph is gone, the most
  // recent remaining tab is shown, else `fallback`. Returns the graph now shown.
  reconcile(graphIds: readonly string[], fallback: string | null): string | null {
    const exists = new Set(graphIds);
    this.open = this.open.filter((id) => exists.has(id));
    this.recent = this.recent.filter((id) => exists.has(id));
    let position = this.position;
    const history: string[] = [];
    this.history.forEach((id, i) => {
      // Removing an entry can make two neighbours the same graph: they become one.
      if (!exists.has(id) || history[history.length - 1] === id) {
        if (i <= this.position) position--;
        return;
      }
      history.push(id);
    });
    this.history = history;
    this.position = Math.max(Math.min(position, history.length - 1), history.length ? 0 : -1);
    if (this.active && exists.has(this.active)) return this.active;
    this.active = null;
    const next = this.recent[0] ?? this.open[0] ?? (fallback && exists.has(fallback) ? fallback : null);
    if (next) this.show(next);
    return this.active;
  }

  private activate(id: string): void {
    if (!this.open.includes(id)) this.open.push(id);
    this.active = id;
    this.recent = [id, ...this.recent.filter((other) => other !== id)];
  }

  private step(by: number): string | undefined {
    const position = this.position + by;
    if (position < 0 || position >= this.history.length) return undefined;
    this.position = position;
    this.activate(this.history[position]);
    return this.history[position];
  }
}
