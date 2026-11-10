// The Codebase Map panel (docs/codebase-map.md, Part 3): one per workspace folder, showing its index
// (CodeMapService) as a scene (src/core/codemap/scene.ts) laid out top to bottom (MapLayout). Which
// boxes are open is remembered per folder; the map is redrawn when the code changes.
import * as vscode from 'vscode';
import type { MapHostMessage, MapMessage } from '../core/codemap/map-protocol';
import { buildCallScene } from '../core/codemap/call-scene';
import { CodeIndex, Entity } from '../core/codemap/code-index';
import { buildFlowScene, callsOf } from '../core/codemap/flow-scene';
import { LaidScene, MapMode, MapView, Scene, buildScene, defaultView } from '../core/codemap/scene';
import { CodeMapService } from './code-map-service';
import { renderMapHtml } from './map-html';
import { MapLayout } from './map-layout';
import { createNonce } from './webview-html';

const VIEW_TYPE = 'blueprintVisualScripting.codebaseMap';
const GRAPH_EDITOR = 'blueprintVisualScripting.graphEditor';

interface OpenMap {
  panel: vscode.WebviewPanel;
  folder: vscode.WorkspaceFolder;
  view: MapView;
  // The newest render asked for: older ones that finish later are dropped.
  render: number;
  scene?: LaidScene;
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
    const map: OpenMap = { panel, folder, view: saved ?? { expanded: [] }, render: 0, rendered: new vscode.EventEmitter<LaidScene | Error>() };
    const first = !saved;
    this.maps.set(key, map);
    const firstScene = nextScene(map);
    panel.onDidDispose(() => {
      this.maps.delete(key);
      map.rendered.dispose();
    }, undefined, this.disposables);
    panel.webview.onDidReceiveMessage(async (message: MapMessage) => {
      if (message.type === 'ready') {
        if (first) map.view = defaultView(await this.codeMap.codeIndex(folder));
        await this.render(map);
      } else if (message.type === 'toggle') {
        await this.toggle(map, message.id);
      } else if (message.type === 'open') {
        await this.open(map, message.id);
      } else if (message.type === 'mode') {
        await this.setMode(map, message.mode);
      } else if (message.type === 'calls') {
        await this.showCalls(map, message.id);
      } else if (message.type === 'direction') {
        await this.update(map, { ...map.view, calls: { ...map.view.calls, direction: message.direction, explored: [] } });
      } else if (message.type === 'flow') {
        await this.showFlow(map, message.id);
      } else if (message.type === 'history') {
        await this.history(map, message.direction);
      } else if (message.type === 'openLine') {
        await this.openLine(map, message.line);
      }
    }, undefined, this.disposables);
    return firstScene;
  }

  // The scene the folder's map shows now (for tests).
  sceneOf(folder: vscode.WorkspaceFolder): LaidScene | undefined {
    return this.maps.get(folder.uri.toString())?.scene;
  }

  // The call flow from a box (none: from the entry points).
  async showCalls(map: OpenMap, id?: string): Promise<void> {
    await this.update(map, { ...map.view, mode: 'calls', calls: { direction: map.view.calls?.direction ?? 'callees', ...(id ? { root: id } : {}), explored: [] } });
  }

  async callsIn(folder: vscode.WorkspaceFolder, id?: string, direction?: 'callees' | 'callers'): Promise<LaidScene | undefined> {
    const map = this.maps.get(folder.uri.toString());
    if (!map) return undefined;
    const next = nextScene(map);
    if (direction) map.view = { ...map.view, calls: { ...map.view.calls, direction } };
    await this.showCalls(map, id);
    return next;
  }

  // A function's control flow; the flowchart shown before goes on the Back list. A graph opens in the
  // graph editor (its flow is the graph itself); a type's flow is its constructor's; anything else
  // without a flowchart opens its code.
  async showFlow(map: OpenMap, id: string): Promise<void> {
    const index = await this.codeMap.codeIndex(map.folder);
    const target = flowTarget(index, id);
    if (!target) {
      await this.open(map, id);
      return;
    }
    const current = map.view.mode === 'flow' ? map.view.flow?.id : undefined;
    const back = [...(map.view.flow?.back ?? []), ...(current && current !== target ? [current] : [])];
    await this.update(map, { ...map.view, mode: 'flow', flow: { id: target, back: current ? back : map.view.flow?.back ?? [], forward: [] } });
  }

  async flowIn(folder: vscode.WorkspaceFolder, id: string): Promise<LaidScene | undefined> {
    const map = this.maps.get(folder.uri.toString());
    if (!map) return undefined;
    const next = nextScene(map);
    await this.showFlow(map, id);
    return next;
  }

  // Back or Forward through the flowcharts opened.
  private async history(map: OpenMap, direction: 'back' | 'forward'): Promise<void> {
    const flow = map.view.flow;
    if (!flow) return;
    const from = direction === 'back' ? [...(flow.back ?? [])] : [...(flow.forward ?? [])];
    const to = from.pop();
    if (!to) return;
    const other = direction === 'back' ? [...(flow.forward ?? []), flow.id] : [...(flow.back ?? []), flow.id];
    await this.update(map, { ...map.view, mode: 'flow', flow: direction === 'back' ? { id: to, back: from, forward: other } : { id: to, back: other, forward: from } });
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
    return buildFlowScene(chart, callsOf(index, entity.id), {
      id: entity.id, label: entity.name, path: entity.path, line: entity.line ?? 1,
      back: (flow.back?.length ?? 0) > 0, forward: (flow.forward?.length ?? 0) > 0
    });
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
    map.view = { ...map.view, mode };
    await this.context.workspaceState.update(this.viewKey(map.folder), map.view);
    await this.render(map);
  }

  async modeIn(folder: vscode.WorkspaceFolder, mode: MapMode): Promise<LaidScene | undefined> {
    const map = this.maps.get(folder.uri.toString());
    if (!map) return undefined;
    const next = nextScene(map);
    await this.setMode(map, mode);
    return next;
  }

  async toggleIn(folder: vscode.WorkspaceFolder, id: string): Promise<LaidScene | undefined> {
    const map = this.maps.get(folder.uri.toString());
    if (!map) return undefined;
    const next = nextScene(map);
    await this.toggle(map, id);
    return next;
  }

  private async render(map: OpenMap): Promise<void> {
    const number = ++map.render;
    try {
      const index = await this.codeMap.codeIndex(map.folder);
      const built = map.view.mode === 'calls' ? buildCallScene(index, map.view) : map.view.mode === 'flow' ? await this.flowScene(map, index) : buildScene(index, map.view);
      const scene = await this.layout.layout(built);
      if (number !== map.render) return;
      map.scene = scene;
      const message: MapHostMessage = { type: 'scene', scene, title: `Codebase Map: ${map.folder.name}` };
      void map.panel.webview.postMessage(message);
      map.rendered.fire(scene);
    } catch (error) {
      if (number === map.render) map.rendered.fire(error instanceof Error ? error : new Error(String(error)));
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
