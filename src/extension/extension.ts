import * as vscode from 'vscode';
import { GraphEditorProvider, GRAPH_VIEW_TYPE } from './editor-provider';
import { NodeRegistry } from '../core/registry';
import { watchWorkspaceNodeLibraries } from './node-libraries';
import { createEmptyDocument, serializeDocument } from '../core/serializer';
import { builtinLanguagePacks } from '../core/languages';
import { detectWorkspaceLanguage } from './languages';

export function activate(context: vscode.ExtensionContext): void {
  // Libraries load in the background; open editors receive the updated definitions when ready.
  const registry = new NodeRegistry();
  const languages = builtinLanguagePacks();
  context.subscriptions.push(watchWorkspaceNodeLibraries(registry));

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

      const name = target.path.split('/').pop()?.replace(/\.vgraph$/i, '') || 'NewGraph';
      const language = await detectWorkspaceLanguage(languages);
      const graphDocument = createEmptyDocument(name, language?.id);
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serializeDocument(graphDocument)));
      await vscode.commands.executeCommand('vscode.open', target);
    })
  );

}

export function deactivate(): void {}
