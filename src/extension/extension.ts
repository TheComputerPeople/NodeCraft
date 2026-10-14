import * as path from 'node:path';
import * as vscode from 'vscode';
import { builtinLanguagePacks } from '../core/languages';
import { NodeRegistry } from '../core/registry';
import { createEmptyDocument, serializeDocument } from '../core/serializer';
import { CompileService } from './compile-service';
import { GraphEditorProvider, GRAPH_VIEW_TYPE } from './editor-provider';
import { detectWorkspaceLanguage } from './languages';
import { watchWorkspaceNodeLibraries } from './node-libraries';
import { isGeneratedFrom } from './placement';

export function activate(context: vscode.ExtensionContext): void {
  // Libraries load in the background; open editors receive the updated definitions when ready.
  const registry = new NodeRegistry();
  const languages = builtinLanguagePacks();
  context.subscriptions.push(watchWorkspaceNodeLibraries(registry));

  let outputChannel: vscode.OutputChannel | undefined;
  const output = (): vscode.OutputChannel => {
    if (!outputChannel) {
      outputChannel = vscode.window.createOutputChannel('Blueprint Visual Scripting');
      context.subscriptions.push(outputChannel);
    }
    return outputChannel;
  };

  const compiler = new CompileService(registry, languages, output);
  const provider = new GraphEditorProvider(context, registry, languages, compiler, output);
  context.subscriptions.push(
    compiler,
    vscode.window.registerCustomEditorProvider(GRAPH_VIEW_TYPE, provider, { supportsMultipleEditorsPerDocument: true })
  );

  const compileAndReport = async (document: vscode.TextDocument): Promise<void> => {
    const { report } = await compiler.compile(document);
    provider.notifyCompiled(document.uri, report);
  };

  // Keep generated code in step with the graph, as Unreal compiles a Blueprint before saving it.
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    if (!isGraph(document.uri)) return;
    if (vscode.workspace.getConfiguration('blueprintVisualScripting', document.uri).get<boolean>('compileOnSave', true)) {
      void compileAndReport(document);
    }
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('blueprintVisualScripting.compile', async (uri?: vscode.Uri) => {
      const document = await graphDocumentFor(uri);
      if (document) await compileAndReport(document);
    }),
    // Bound to Ctrl+Shift+F in graph editors, so it opens Find in All Blueprints rather than
    // VS Code's workspace search (as in Unreal).
    vscode.commands.registerCommand('blueprintVisualScripting.findInAll', () => {
      if (!provider.postToActive({ type: 'openFind', findAll: true })) void vscode.commands.executeCommand('workbench.action.findInFiles');
    }),
    vscode.commands.registerCommand('blueprintVisualScripting.run', async (uri?: vscode.Uri) => {
      const document = await graphDocumentFor(uri);
      if (!document) return;
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage('Running graphs is disabled in Restricted Mode. Trust this workspace to run graphs.');
        return;
      }
      await compiler.run(document, (status) => {
        if (status.state === 'failed') void vscode.window.showErrorMessage(status.message);
      }, (report) => provider.notifyCompiled(document.uri, report));
    })
  );

  context.subscriptions.push(...followGraphFileChanges(compiler, compileAndReport));

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

function isGraph(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && uri.path.toLowerCase().endsWith('.vgraph');
}

// The graph a command applies to: the argument (from Explorer), else the active graph editor.
async function graphDocumentFor(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const target = uri ?? (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined);
  if (!target || !isGraph(target)) {
    void vscode.window.showInformationMessage('Open a .vgraph file first.');
    return undefined;
  }
  return vscode.workspace.openTextDocument(target);
}

// Generated files sit next to their graph, so moving a folder moves them too. Renaming, moving or
// deleting a single graph file needs its generated file to follow (docs/output-placement.md).
function followGraphFileChanges(compiler: CompileService, recompile: (document: vscode.TextDocument) => Promise<void>): vscode.Disposable[] {
  return [
    vscode.workspace.onDidRenameFiles(async (event) => {
      for (const { oldUri, newUri } of event.files) {
        if (!isGraph(oldUri) || !isGraph(newUri)) continue;
        compiler.forget(oldUri);
        const oldName = path.basename(oldUri.fsPath);
        const moves = compiler.outputPathsFor(oldUri.fsPath)
          .map((from, i) => ({ from, to: compiler.outputPathsFor(newUri.fsPath)[i] }))
          .filter(({ from }) => isGeneratedFrom(from, oldName));
        if (!moves.length) continue;
        const edit = new vscode.WorkspaceEdit();
        for (const { from, to } of moves) edit.renameFile(vscode.Uri.file(from), vscode.Uri.file(to), { overwrite: true });
        await vscode.workspace.applyEdit(edit);
        // Refreshes the header (it names the graph file) and Python's module-derived names.
        await recompile(await vscode.workspace.openTextDocument(newUri));
      }
    }),
    vscode.workspace.onDidDeleteFiles(async (event) => {
      for (const uri of event.files) {
        if (!isGraph(uri)) continue;
        compiler.forget(uri);
        const name = path.basename(uri.fsPath);
        for (const output of compiler.outputPathsFor(uri.fsPath).filter((file) => isGeneratedFrom(file, name))) {
          await vscode.workspace.fs.delete(vscode.Uri.file(output), { useTrash: true });
        }
      }
    })
  ];
}
