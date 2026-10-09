import * as vscode from 'vscode';
import { GraphEditorProvider, GRAPH_VIEW_TYPE } from './editor-provider';
import { NodeRegistry, watchWorkspaceNodeLibraries } from './graph/registry';
import { createEmptyGraph, serializeGraph } from './graph/serializer';

export function activate(context: vscode.ExtensionContext): void {
  // Libraries load in the background; open editors receive the updated definitions when ready.
  const registry = new NodeRegistry();
  context.subscriptions.push(registry, watchWorkspaceNodeLibraries(registry));

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      GRAPH_VIEW_TYPE,
      new GraphEditorProvider(context, registry),
      { supportsMultipleEditorsPerDocument: true }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('blueprintVisualScripting.createGraph', async () => {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? context.extensionUri, 'NewGraph.vgraph'),
        filters: { 'Visual Graph': ['vgraph'] },
        saveLabel: 'Create Graph'
      });
      if (!target) return;

      const graph = createEmptyGraph(target.path.split('/').pop()?.replace(/\.vgraph$/i, '') || 'NewGraph');
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serializeGraph(graph)));
      await vscode.commands.executeCommand('vscode.open', target);
    })
  );

}

export function deactivate(): void {}
