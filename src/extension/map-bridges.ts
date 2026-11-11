// What the Codebase Map's panel and its tree (structure-view.ts) do with an entity
// (docs/codebase-map.md, Part 3): open it (its code, or its graph on its tab), expose a function as a
// Blueprint node, and read the signature and doc comment a hover shows.
import * as vscode from 'vscode';
import { Entity } from '../core/codemap/code-index';
import { DeclarationSummary, declarationSummary } from '../core/codemap/hover';
import { ExposeAnswers, ExposeOnly } from './expose-command';

// The bridges into Blueprint, which the extension gives the map (the graph editor, Expose).
export interface MapBridges {
  openGraph(uri: vscode.Uri, graphId: string | undefined, column?: vscode.ViewColumn): Promise<void>;
  expose(uri: vscode.Uri, only: ExposeOnly, given?: ExposeAnswers): Promise<string[] | undefined>;
}

export function entityUri(folder: vscode.WorkspaceFolder, entity: Entity): vscode.Uri | undefined {
  return entity.path === undefined ? undefined : vscode.Uri.joinPath(folder.uri, ...entity.path.split('/').filter(Boolean));
}

// A box's code in an editor at its line; a graph file or graph in the graph editor (a graph on its
// tab); a project or folder in the Explorer.
export async function openEntity(folder: vscode.WorkspaceFolder, entity: Entity, bridges: MapBridges, column = vscode.ViewColumn.Beside): Promise<void> {
  const uri = entityUri(folder, entity);
  if (!uri) return;
  if (entity.kind === 'graph-file' || entity.kind === 'graph') {
    await bridges.openGraph(uri, entity.kind === 'graph' ? entity.id.slice(entity.id.indexOf('#') + 1) : undefined, column);
    return;
  }
  if (entity.kind === 'project' || entity.kind === 'module') {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  const line = Math.max(0, (entity.line ?? 1) - 1);
  await vscode.window.showTextDocument(uri, { viewColumn: column, selection: new vscode.Range(line, 0, line, 0), preserveFocus: false });
}

// Expose as Node: a function made a node, as Expose Functions as Nodes does (the edit in the
// Refactor Preview), without asking which function. The files changed; undefined when nothing was.
export async function exposeEntity(folder: vscode.WorkspaceFolder, entity: Entity, bridges: MapBridges, given?: ExposeAnswers): Promise<string[] | undefined> {
  const uri = entityUri(folder, entity);
  if (!uri || entity.kind !== 'function') {
    void vscode.window.showInformationMessage(`${entity.name} isn't a function: only functions become nodes.`);
    return undefined;
  }
  return bridges.expose(uri, { name: entity.name, ...(entity.line !== undefined ? { line: entity.line } : {}) }, given);
}

export function canExpose(entity: Entity): boolean {
  return entity.kind === 'function' && !!entity.path;
}

// A type's or function's signature and doc comment, from its file as it is now (an editor's text,
// saved or not).
export async function summaryOf(folder: vscode.WorkspaceFolder, entity: Entity): Promise<DeclarationSummary | undefined> {
  const uri = entityUri(folder, entity);
  if (!uri || (entity.kind !== 'type' && entity.kind !== 'function') || entity.line === undefined) return undefined;
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  let text = open?.getText();
  if (text === undefined) {
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }
  return declarationSummary(text, entity.line, entity.language);
}
