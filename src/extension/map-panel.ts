// The Codebase Map panel (docs/codebase-map.md, Part 3): one per workspace folder, showing its index
// (CodeMapService) as a scene (src/core/codemap/scene.ts) laid out top to bottom (MapLayout). Which
// boxes are open is remembered per folder; the map is redrawn when the code changes.
import * as vscode from 'vscode';
import type { MapHostMessage, MapMessage } from '../core/codemap/map-protocol';
import { buildCallScene } from '../core/codemap/call-scene';
import { CodeIndex, Entity } from '../core/codemap/code-index';
import { buildFlowScene, callsOf } from '../core/codemap/flow-scene';
import { findEntities, hiddenBy } from '../core/codemap/find';
import { CallDirection, LaidScene, MapMode, MapView, Scene, buildScene, defaultView } from '../core/codemap/scene';
import { CodeMapService } from './code-map-service';
import { renderMapHtml } from './map-html';
import { MapLayout } from './map-layout';
import { createNonce } from './webview-html';

const VIEW_TYPE = 'blueprintVisualScripting.codebaseMap';
const GRAPH_EDITOR = 'blueprintVisualScripting.graphEditor';
// Back goes this many places back.
const MAX_HISTORY = 50;

// A place the map has been: its view, the call flow's start or path, the flowchart, and the box
// centred there.
interface Place {
  mode?: MapMode;
  calls?: MapView['calls'];
  flow?: MapView['flow'];
  focus?: string;
}

interface OpenMap {
  panel: vscode.WebviewPanel;
  folder: vscode.WorkspaceFolder;
  view: MapView;
  // The newest render asked for: older ones that finish later are dropped.
  render: number;
  scene?: LaidScene;
  // The box the last render centred and selected.
  focus?: string;
  // Whether the page has loaded (said it's ready): until then, a view or focus set waits for it.
  ready: boolean;
  pendingFocus?: string[];
  // The places before and after this one (Back and Forward), while the map is open.
  back: Place[];
  forward: Place[];
  // The latest render (done when it's drawn, or failed), and why the last one failed.
  latest?: Promise<void>;
  error?: Error;
  // Each render's outcome: its scene, or why it failed.
  rendered: vscode.EventEmitter<LaidScene | Error>;
}

export class CodeMapPanels implements vscode.Disposable {
  private readonly maps = new Map<string, OpenMap>();
  private readonly layout = new MapLayout();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly codeMap: CodeMapService) {
    codeMap.onDidChange((folder) => {
      const map = this.maps.get(folder.uri.toString());
      if (map) void this.render(map);
    }, undefined, this.disposables);
  }

  // Shows the folder's map (opening it, or bringing it forward). Resolves with its first scene.
  async show(folder: vscode.WorkspaceFolder): Promise<LaidScene> {
    const key = folder.uri.toString();
    const existing = this.maps.get(key);
    if (existing) {
      existing.panel.reveal();
      return existing.scene ?? nextScene(existing);
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `Codebase Map: ${folder.name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')]
    });
    panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', name)).toString();
    panel.webview.html = renderMapHtml({ cspSource: panel.webview.cspSource, nonce: createNonce(), scriptUri: asset('map.js'), styleUri: asset('map.css') });
    const saved = this.context.workspaceState.get<MapView>(this.viewKey(folder));
    const map: OpenMap = { panel, folder, view: saved ?? { expanded: [] }, render: 0, ready: false, back: [], forward: [], rendered: new vscode.EventEmitter<LaidScene | Error>() };
    const first = !saved;
    this.maps.set(key, map);
    const firstScene = nextScene(map);
    panel.onDidDispose(() => {
      this.maps.delete(key);
      map.rendered.dispose();
    }, undefined, this.disposables);
    panel.webview.onDidReceiveMessage(async (message: MapMessage) => {
      if (message.type === 'ready') {
        // A first map opens on the default view, unless a command already chose one.
        if (first && !map.view.mode) map.view = defaultView(await this.codeMap.codeIndex(folder));
        map.ready = true;
        const focus = map.pendingFocus;
        map.pendingFocus = undefined;
        await this.render(map, focus);
      } else if (message.type === 'toggle') {
        await this.toggle(map, message.id);
      } else if (message.type === 'open') {
        await this.open(map, message.id);
      } else if (message.type === 'mode') {
        await this.setMode(map, message.mode);
      } else if (message.type === 'calls') {
        await this.showCalls(map, message.id, message.direction);
      } else if (message.type === 'direction') {
        await this.navigate(map, { ...map.view, calls: { ...withoutPath(map.view.calls), direction: message.direction, explored: [] } });
      } else if (message.type === 'depth') {
        await this.update(map, { ...map.view, calls: { ...map.view.calls, depth: message.depth, explored: [] } });
      } else if (message.type === 'path') {
        await this.showPath(map, message.from, message.to);
      } else if (message.type === 'flow') {
        await this.showFlow(map, message.id);
      } else if (message.type === 'history') {
        await this.history(map, message.direction);
      } else if (message.type === 'openLine') {
        await this.openLine(map, message.line);
      } else if (message.type === 'find') {
        const results = findEntities(await this.codeMap.codeIndex(folder), message.query);
        const reply: MapHostMessage = { type: 'found', query: message.query, results };
        void panel.webview.postMessage(reply);
      } else if (message.type === 'reveal') {
        await this.reveal(map, message.id);
      } else if (message.type === 'filters') {
        await this.update(map, { ...map.view, filters: message.filters });
      }
    }, undefined, this.disposables);
    return firstScene;
  }

  // The scene the folder's map shows now (for tests).
  sceneOf(folder: vscode.WorkspaceFolder): LaidScene | undefined {
    return this.maps.get(folder.uri.toString())?.scene;
  }

  // The call flow from a box (none: from the entry points), the way it went before unless told.
  async showCalls(map: OpenMap, id?: string, direction?: CallDirection): Promise<void> {
    const way = direction ?? map.view.calls?.direction ?? 'callees';
    await this.navigate(map, { ...map.view, mode: 'calls', calls: { direction: way, ...(map.view.calls?.depth ? { depth: map.view.calls.depth } : {}), ...(id ? { root: id } : {}), explored: [] } });
  }

  async callsIn(folder: vscode.WorkspaceFolder, id?: string, direction?: CallDirection): Promise<LaidScene | undefined> {
    const map = this.maps.get(folder.uri.toString());
    if (!map) return undefined;
    return this.settled(map, () => this.showCalls(map, id, direction));
  }

  // The calls that lead from one box to another.
  async showPath(map: OpenMap, from: string, to: string): Promise<void> {
    const calls = map.view.calls;
    await this.navigate(map, { ...map.view, mode: 'calls', calls: { direction: 'callees', ...(calls?.depth ? { depth: calls.depth } : {}), root: from, explored: [], path: { from, to } } });
  }

  async pathIn(folder: vscode.WorkspaceFolder, from: string, to: string): Promise<LaidScene | undefined> {
    const map = this.maps.get(folder.uri.toString());
    if (!map) return undefined;
    return this.settled(map, () => this.showPath(map, from, to));
  }

  // Shows an entity on the map: in the view that has it (declarations are the structure's; the call
  // and control flow views show other things), its boxes opened up to it, and it centred and selected
  // (or the nearest box holding it: a method's type). Filters that hide it are cleared.
  async reveal(map: OpenMap, id: string): Promise<void> {
    const index = await this.codeMap.codeIndex(map.folder);
    const byId = new Map(index.entities.map((e) => [e.id, e]));
    const entity = byId.get(id);
    if (!entity) return;
    const declaration = entity.kind === 'type' || entity.kind === 'function' || entity.kind === 'graph';
    const current = map.view.mode ?? 'architecture';
    const mode: MapMode = declaration ? 'structure' : current === 'calls' || current === 'flow' ? 'architecture' : current;
    const ancestors: string[] = [];
    for (let p = entity.parent ? byId.get(entity.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) ancestors.push(p.id);
    if (entity.kind === 'external') ancestors.push('externals');
    const filters = map.view.filters && hiddenBy(index, map.view.filters).has(id) ? undefined : map.view.filters;
    await this.navigate(map, { ...map.view, mode, expanded: [...new Set([...map.view.expanded, ...ancestors])], ...(filters ? { filters } : { filters: undefined }) }, [id, ...ancestors]);
  }

  async revealIn(folder: vscode.WorkspaceFolder, id: string): Promise<{ scene: LaidScene; focus?: string } | undefined> {
    const map = this.maps.get(folder.uri.toString());
    if (!map) return undefined;
    const scene = await this.settled(map, () => this.reveal(map, id));
    return { scene, ...(map.focus ? { focus: map.focus } : {}) };
  }

  // A function's control flow. A graph opens in the graph editor (its flow is the graph itself); a
  // type's flow is its constructor's; anything else without a flowchart opens its code.
  async showFlow(map: OpenMap, id: string): Promise<void> {
    const index = await this.codeMap.codeIndex(map.folder);
    const target = flowTarget(index, id);
    if (!target) {
      await this.open(map, id);
      return;
    }
    await this.navigate(map, { ...map.view, mode: 'flow', flow: { id: target } });
  }

  async flowIn(folder: vscode.WorkspaceFolder, id: string): Promise<LaidScene | undefined> {
    const map = this.maps.get(folder.uri.toString());
    if (!map) return undefined;
    return this.settled(map, () => this.showFlow(map, id));
  }

  // Back or Forward through the places the map has been: its view, call flow or flowchart, and the
  // box centred there. (The boxes opened and the filters stay as they are.)
  private async history(map: OpenMap, direction: 'back' | 'forward'): Promise<void> {
    const to = (direction === 'back' ? map.back : map.forward).pop();
    if (!to) return;
    (direction === 'back' ? map.forward : map.back).push(placeOf(map));
    map.view = { ...map.view, mode: to.mode, calls: to.calls, flow: to.flow };
    await this.context.workspaceState.update(this.viewKey(map.folder), map.view);
    await this.render(map, to.focus ? [to.focus] : undefined);
  }

  async historyIn(folder: vscode.WorkspaceFolder, direction: 'back' | 'forward'): Promise<LaidScene | undefined> {
    const map = this.maps.get(folder.uri.toString());
    if (!map || !(direction === 'back' ? map.back : map.forward).length) return undefined;
    return this.settled(map, () => this.history(map, direction));
  }

  // Goes somewhere else on the map: where it was goes on the Back list.
  private async navigate(map: OpenMap, view: MapView, focus?: string[]): Promise<void> {
    const here = placeOf(map);
    const there: Place = { mode: view.mode, calls: view.calls, flow: view.flow };
    if (map.scene && (JSON.stringify({ ...here, focus: undefined }) !== JSON.stringify(there) || focus)) {
      map.back.push(here);
      if (map.back.length > MAX_HISTORY) map.back.shift();
      map.forward = [];
    }
    map.view = view;
    await this.context.workspaceState.update(this.viewKey(map.folder), map.view);
    await this.render(map, focus);
  }

  // The flowchart's file at a line.
  private async openLine(map: OpenMap, line: number): Promise<void> {
    const index = await this.codeMap.codeIndex(map.folder);
    const entity = index.entities.find((e) => e.id === map.view.flow?.id);
    if (!entity?.path) return;
    const uri = vscode.Uri.joinPath(map.folder.uri, ...entity.path.split('/'));
    const at = Math.max(0, line - 1);
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(at, 0, at, 0) });
  }

  // The flowchart scene of the view's function.
  private async flowScene(map: OpenMap, index: CodeIndex): Promise<Scene> {
    const flow = map.view.flow;
    const entity = flow && index.entities.find((e) => e.id === flow.id);
    if (!flow || !entity?.path) throw new Error('Choose a function to see its control flow (its ⧉ button, in any view).');
    const chart = await this.codeMap.flowchart(map.folder, entity.path, entity.line ?? 1);
    if (!chart) throw new Error(`${entity.name} has no body to draw.`);
    return buildFlowScene(chart, callsOf(index, entity.id), { id: entity.id, label: entity.name, path: entity.path, line: entity.line ?? 1 });
  }

  private async update(map: OpenMap, view: MapView): Promise<void> {
    map.view = view;
    await this.context.workspaceState.update(this.viewKey(map.folder), map.view);
    await this.render(map);
  }

  // Opens or closes a box ("N more…" shows the rest of its box's children); in the call flow,
  // explores a box one level further, or closes it again.
  async toggle(map: OpenMap, id: string): Promise<void> {
    if (map.view.mode === 'calls') {
      const explored = new Set(map.view.calls?.explored ?? []);
      if (explored.has(id)) explored.delete(id);
      else explored.add(id);
      await this.update(map, { ...map.view, calls: { ...map.view.calls, explored: [...explored] } });
      return;
    }
    if (id.startsWith('more:')) {
      const parent = id.slice('more:'.length);
      map.view = { ...map.view, unlimited: [...new Set([...(map.view.unlimited ?? []), parent])] };
    } else {
      const open = new Set(map.view.expanded);
      if (open.has(id)) open.delete(id);
      else open.add(id);
      map.view = { ...map.view, expanded: [...open] };
    }
    await this.context.workspaceState.update(this.viewKey(map.folder), map.view);
    await this.render(map);
  }

  // Switches the map's view (each view keeps the same open boxes).
  async setMode(map: OpenMap, mode: MapMode): Promise<void> {
    await this.navigate(map, { ...map.view, mode });
  }

  async modeIn(folder: vscode.WorkspaceFolder, mode: MapMode): Promise<LaidScene | undefined> {
    const map = this.maps.get(folder.uri.toString());
    if (!map) return undefined;
    return this.settled(map, () => this.setMode(map, mode));
  }

  async toggleIn(folder: vscode.WorkspaceFolder, id: string): Promise<LaidScene | undefined> {
    const map = this.maps.get(folder.uri.toString());
    if (!map) return undefined;
    return this.settled(map, () => this.toggle(map, id));
  }

  // Does something to the map, and resolves with the scene it then shows: the one its own render
  // drew (or a newer one), not one drawn meanwhile for something else (a change to the code).
  private async settled(map: OpenMap, action: () => Promise<void>): Promise<LaidScene> {
    if (!map.ready) {
      // (Until the page is ready, nothing is drawn: its first scene is the one wanted.)
      const next = nextScene(map);
      await action();
      return next;
    }
    await action();
    await map.latest;
    if (map.error) throw map.error;
    return map.scene!;
  }

  // Draws the map; `focus`: ids to centre and select, the first that's a box.
  private render(map: OpenMap, focus?: string[]): Promise<void> {
    if (!map.ready) {
      if (focus) map.pendingFocus = focus;
      return Promise.resolve();
    }
    const number = ++map.render;
    const drawing = this.draw(map, number, focus);
    map.latest = drawing;
    return drawing;
  }

  // Draws one render; one overtaken by a newer render waits for that instead.
  private async draw(map: OpenMap, number: number, focus?: string[]): Promise<void> {
    try {
      const index = await this.codeMap.codeIndex(map.folder);
      const built = map.view.mode === 'calls' ? buildCallScene(index, map.view) : map.view.mode === 'flow' ? await this.flowScene(map, index) : buildScene(index, map.view);
      const scene = await this.layout.layout(built);
      if (number !== map.render) return map.latest;
      map.scene = scene;
      map.error = undefined;
      const boxes = new Set(scene.boxes.map((b) => b.id));
      map.focus = focus?.find((id) => boxes.has(id));
      const message: MapHostMessage = {
        type: 'scene', scene, title: `Codebase Map: ${map.folder.name}`, ...(map.focus ? { focus: map.focus } : {}),
        history: { back: map.back.length > 0, forward: map.forward.length > 0 }
      };
      void map.panel.webview.postMessage(message);
      map.rendered.fire(scene);
    } catch (error) {
      if (number !== map.render) return map.latest;
      map.error = error instanceof Error ? error : new Error(String(error));
      map.rendered.fire(map.error);
      const message: MapHostMessage = { type: 'status', text: `The map couldn't be drawn: ${error instanceof Error ? error.message : String(error)}` };
      void map.panel.webview.postMessage(message);
    }
  }

  // A box's code in an editor, at its line; a graph in the graph editor.
  private async open(map: OpenMap, id: string): Promise<void> {
    const index = await this.codeMap.codeIndex(map.folder);
    const entity = index.entities.find((e) => e.id === id);
    if (!entity?.path) return;
    const uri = vscode.Uri.joinPath(map.folder.uri, ...entity.path.split('/'));
    if (entity.kind === 'graph-file' || entity.kind === 'graph') {
      await vscode.commands.executeCommand('vscode.openWith', uri, GRAPH_EDITOR, vscode.ViewColumn.Beside);
      return;
    }
    if (entity.kind === 'project' || entity.kind === 'module') {
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }
    const line = Math.max(0, (entity.line ?? 1) - 1);
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(line, 0, line, 0), preserveFocus: false });
  }

  private viewKey(folder: vscode.WorkspaceFolder): string {
    return `codebaseMap.view:${folder.uri.toString()}`;
  }

  dispose(): void {
    for (const map of this.maps.values()) map.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    void this.layout.dispose();
  }
}

// Where the map is now.
function placeOf(map: OpenMap): Place {
  return { mode: map.view.mode, calls: map.view.calls, flow: map.view.flow, ...(map.focus ? { focus: map.focus } : {}) };
}

// The call flow's settings, without a path (going another way leaves the path).
function withoutPath(calls: MapView['calls']): MapView['calls'] {
  if (!calls?.path) return calls;
  const { path: _path, ...rest } = calls;
  return rest;
}

// The map's next scene, or its render's error.
function nextScene(map: OpenMap): Promise<LaidScene> {
  return new Promise((resolve, reject) => {
    const listener = map.rendered.event((outcome) => {
      listener.dispose();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    });
  });
}

// The function whose flowchart a box stands for: itself, a type's constructor; undefined for what has
// no flowchart (a graph, a file, a package).
function flowTarget(index: CodeIndex, id: string): string | undefined {
  const entity = index.entities.find((e) => e.id === id);
  if (!entity) return undefined;
  if (entity.kind === 'function') return entity.id;
  if (entity.kind === 'type') {
    const constructor = index.entities.find((e: Entity) => e.parent === entity.id && e.kind === 'function' && (e.detail === 'constructor' || /^(constructor|__init__|initialize|_init|new|__construct)$/.test(e.name) || e.name === entity.name));
    return constructor?.id;
  }
  return undefined;
}
