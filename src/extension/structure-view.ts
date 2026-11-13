// The Codebase Map's tree (docs/codebase-map.md, Part 3, accessibility): the same index as the map,
// in the Explorer, so everything on it can be reached by keyboard and screen reader. Projects,
// folders, files, types and functions, graph files and their graphs, and the external packages
// imported. Choosing an item opens it (its code, or its graph); its menu shows it on the map, its
// call flow and control flow, and exposes a function as a node. Collapsed until it's opened: nothing
// is read before then, as for the map.
import * as vscode from 'vscode';
import { CodeIndex, Entity } from '../core/codemap/code-index';
import { CodeMapService } from './code-map-service';
import { canExpose, entityUri, summaryOf } from './map-bridges';

export const STRUCTURE_VIEW = 'nodecraft.codebaseStructure';
export const OPEN_ENTITY = 'nodecraft.openMapEntity';

// An item: an entity of a folder's index; the folder itself (when the workspace has several); or
// the folder's external packages.
export interface StructureNode {
  folder: vscode.WorkspaceFolder;
  id?: string;
}

export const EXTERNALS = 'group:externals';

export function isStructureNode(value: unknown): value is StructureNode {
  return typeof value === 'object' && value !== null && 'folder' in value && !(value instanceof vscode.Uri);
}

interface FolderTree {
  byId: Map<string, Entity>;
  // Each entity's children, in the order shown ('' : the top level).
  children: Map<string, Entity[]>;
}

// Folders, files and packages by name; a file's types and functions by line.
const KIND_ORDER: Record<string, number> = { project: 0, module: 1, file: 2, 'graph-file': 2, graph: 3, type: 4, function: 4, external: 5 };

export class StructureTree implements vscode.TreeDataProvider<StructureNode>, vscode.Disposable {
  private readonly trees = new Map<string, Promise<FolderTree>>();
  private readonly changed = new vscode.EventEmitter<StructureNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly codeMap: CodeMapService) {
    codeMap.onDidChange((folder) => {
      if (!this.trees.delete(folder.uri.toString())) return;
      this.changed.fire(undefined);
    }, undefined, this.disposables);
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.trees.clear();
      this.changed.fire(undefined);
    }, undefined, this.disposables);
  }

  private tree(folder: vscode.WorkspaceFolder): Promise<FolderTree> {
    const key = folder.uri.toString();
    let tree = this.trees.get(key);
    if (!tree) {
      tree = this.codeMap.codeIndex(folder).then(treeOf);
      this.trees.set(key, tree);
      tree.catch(() => this.trees.get(key) === tree && this.trees.delete(key));
    }
    return tree;
  }

  async getChildren(node?: StructureNode): Promise<StructureNode[]> {
    if (!node) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length !== 1) return folders.map((folder) => ({ folder }));
      return this.childrenOf(folders[0]);
    }
    return this.childrenOf(node.folder, node.id);
  }

  private async childrenOf(folder: vscode.WorkspaceFolder, id?: string): Promise<StructureNode[]> {
    const tree = await this.tree(folder);
    const children = (tree.children.get(id ?? '') ?? []).map((e) => ({ folder, id: e.id }));
    // The packages imported, after the folder's own code.
    if (!id && tree.children.get(EXTERNALS)?.length) children.push({ folder, id: EXTERNALS });
    return children;
  }

  // (Revealing an item opens the items above it.)
  async getParent(node: StructureNode): Promise<StructureNode | undefined> {
    if (!node.id) return undefined;
    const top = (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? { folder: node.folder } : undefined;
    if (node.id === EXTERNALS) return top;
    const tree = await this.tree(node.folder);
    const entity = tree.byId.get(node.id);
    if (entity?.kind === 'external') return { folder: node.folder, id: EXTERNALS };
    return entity?.parent && tree.byId.has(entity.parent) ? { folder: node.folder, id: entity.parent } : top;
  }

  async getTreeItem(node: StructureNode): Promise<vscode.TreeItem> {
    if (!node.id) {
      const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = node.folder.uri.toString();
      item.iconPath = new vscode.ThemeIcon('root-folder');
      item.contextValue = 'codemap-folder';
      return item;
    }
    const tree = await this.tree(node.folder);
    if (node.id === EXTERNALS) {
      const item = new vscode.TreeItem('External packages', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${node.folder.uri.toString()}|${EXTERNALS}`;
      item.iconPath = new vscode.ThemeIcon('package');
      item.description = String(tree.children.get(EXTERNALS)?.length ?? 0);
      return item;
    }
    const entity = tree.byId.get(node.id);
    if (!entity) return new vscode.TreeItem(node.id);
    const hasChildren = !!tree.children.get(entity.id)?.length;
    const item = new vscode.TreeItem(entity.name, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `${node.folder.uri.toString()}|${entity.id}`;
    const entries = entity.entries?.length ? `entry point (${[...new Set(entity.entries.map((e) => e.kind))].join(', ')})` : '';
    item.description = [entity.kind === 'project' ? '' : entity.detail, entries].filter(Boolean).join(' · ') || undefined;
    item.iconPath = iconOf(entity);
    const uri = entityUri(node.folder, entity);
    if (entity.kind === 'file' && uri) item.resourceUri = uri;
    item.contextValue = `codemap-${entity.kind}${canExpose(entity) ? '-exposable' : ''}`;
    item.accessibilityInformation = { label: `${entity.name}, ${kindName(entity)}${item.description ? `, ${item.description}` : ''}` };
    if (uri && entity.kind !== 'project' && entity.kind !== 'module') item.command = { command: OPEN_ENTITY, title: 'Open', arguments: [node] };
    return item;
  }

  // The tooltip: what it is, where, and a type's or function's signature and doc comment.
  async resolveTreeItem(item: vscode.TreeItem, node: StructureNode): Promise<vscode.TreeItem> {
    if (!node.id || node.id === EXTERNALS) return item;
    const entity = (await this.tree(node.folder)).byId.get(node.id);
    if (!entity) return item;
    const tooltip = new vscode.MarkdownString();
    const summary = await summaryOf(node.folder, entity);
    if (summary) tooltip.appendCodeblock(summary.signature, entity.language ?? '');
    else tooltip.appendMarkdown(`**${escape(entity.name)}**\n\n`);
    // (Doc comments are mostly Markdown already; the tooltip isn't trusted, so no HTML or commands.)
    if (summary?.doc) tooltip.appendMarkdown(`${summary.doc.replace(/\n/g, '  \n')}\n\n`);
    tooltip.appendMarkdown(`*${escape([kindName(entity), entity.path ? `${entity.path}${entity.line ? `:${entity.line}` : ''}` : ''].filter(Boolean).join(' · '))}*`);
    item.tooltip = tooltip;
    return item;
  }

  // The entity an item stands for (the commands on its menu).
  async entityOf(node: StructureNode): Promise<Entity | undefined> {
    return node.id ? (await this.tree(node.folder)).byId.get(node.id) : undefined;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function treeOf(index: CodeIndex): FolderTree {
  const byId = new Map(index.entities.map((e) => [e.id, e]));
  const children = new Map<string, Entity[]>();
  for (const entity of index.entities) {
    const key = entity.kind === 'external' ? EXTERNALS : entity.parent && byId.has(entity.parent) ? entity.parent : '';
    let list = children.get(key);
    if (!list) children.set(key, list = []);
    list.push(entity);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
      || (a.kind === 'type' || a.kind === 'function' ? (a.line ?? 0) - (b.line ?? 0) : 0)
      || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  }
  return { byId, children };
}

function iconOf(entity: Entity): vscode.ThemeIcon {
  switch (entity.kind) {
    case 'project': return new vscode.ThemeIcon('project');
    case 'module': return vscode.ThemeIcon.Folder;
    case 'file': return vscode.ThemeIcon.File;
    case 'graph-file': return new vscode.ThemeIcon('circuit-board');
    case 'graph': return new vscode.ThemeIcon('symbol-event');
    case 'external': return new vscode.ThemeIcon('package');
    case 'type':
      return new vscode.ThemeIcon(({ interface: 'symbol-interface', enum: 'symbol-enum', struct: 'symbol-structure', namespace: 'symbol-namespace', trait: 'symbol-interface' } as Record<string, string>)[entity.detail ?? ''] ?? 'symbol-class');
    case 'function':
      return new vscode.ThemeIcon(entity.detail === 'method' ? 'symbol-method' : entity.detail === 'constructor' ? 'symbol-constructor' : 'symbol-function');
  }
}

function kindName(entity: Entity): string {
  return ({ project: 'project', module: 'folder', file: 'file', 'graph-file': 'graph file', graph: 'graph', type: entity.detail ?? 'type', function: entity.detail ?? 'function', external: 'package' } as Record<string, string>)[entity.kind] ?? entity.kind;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
