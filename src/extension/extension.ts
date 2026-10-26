import * as path from 'node:path';
import * as vscode from 'vscode';
import { builtinLanguagePacks } from '../core/languages';
import { NodeRegistry } from '../core/registry';
import { DOCUMENT_KIND_NAMES, newDocument } from '../core/blueprint-edits';
import { DocumentKind } from '../core/model';
import { serializeDocument } from '../core/serializer';
import { CompileService } from './compile-service';
import { GraphEditorProvider, GRAPH_VIEW_TYPE } from './editor-provider';
import { detectWorkspaceLanguage } from './languages';
import { watchWorkspaceNodeLibraries } from './node-libraries';
import { isGeneratedFrom } from './placement';
import { GraphLibraries } from './graph-libraries';
import { DebugMarks } from './breakpoints';
import { CodeDebugService } from './code-debug';
import { ProjectFunctions } from './project-functions';

// What activation returns: the integration tests drive debugging through it.
export interface ExtensionApi {
  marks: DebugMarks;
  provider: GraphEditorProvider;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
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

  // The project's own functions, exposed as nodes (docs/code-as-nodes.md).
  const projectFunctions = new ProjectFunctions(registry, languages, output);
  context.subscriptions.push(projectFunctions);
  // Function libraries made of graphs (docs/program-structure.md, "Functions").
  const graphLibraries = new GraphLibraries(registry, languages);
  context.subscriptions.push(graphLibraries);

  // Compiling waits for the first scans, so functions that are merely still loading aren't reported missing.
  const compiler = new CompileService(registry, languages, output, () => Promise.all([projectFunctions.ready, graphLibraries.ready]).then(() => undefined));
  // Breakpoints on nodes, kept per workspace (docs/debugging.md).
  const marks = new DebugMarks(context.workspaceState);
  context.subscriptions.push(marks);
  const provider = new GraphEditorProvider(context, registry, languages, compiler, output, () => projectFunctions.loaded, marks);
  // Debugging generated code with the language's debugger (docs/debugging.md).
  const codeDebug = new CodeDebugService(provider, compiler, marks, registry, languages, output);
  context.subscriptions.push(
    compiler,
    codeDebug,
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
    // Unreal's File > Refresh All Nodes: updates every node whose project function changed.
    vscode.commands.registerCommand('blueprintVisualScripting.refreshAllNodes', () => {
      if (!provider.postToActive({ type: 'refreshAll' })) void vscode.window.showInformationMessage('Open a graph to refresh its nodes.');
    }),
    vscode.commands.registerCommand('blueprintVisualScripting.debug', async (uri?: vscode.Uri) => {
      const document = await graphDocumentFor(uri);
      if (document) await codeDebug.start(document.uri);
    }),
    // The debugger's buttons (docs/debugging.md); the keys apply while a graph editor has focus.
    ...(['resume', 'stepOver', 'stepInto', 'stepOut', 'stop'] as const).map((action) =>
      vscode.commands.registerCommand(`blueprintVisualScripting.debug.${action}`, () => provider.debugAction(action))),
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

  context.subscriptions.push(...followGraphFileChanges(compiler, marks, compileAndReport));

  context.subscriptions.push(
    vscode.commands.registerCommand('blueprintVisualScripting.createGraph', async () => {
      // What to make, as Unreal's Content Browser offers it.
      const picked = await vscode.window.showQuickPick(
        (Object.entries(DOCUMENT_KIND_NAMES) as [DocumentKind, string][]).map(([documentKind, label]) => ({ label, documentKind })),
        { placeHolder: 'What kind of file?' }
      );
      if (!picked) return;
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? context.extensionUri, 'NewGraph.vgraph'),
        filters: { 'Visual Graph': ['vgraph'] },
        saveLabel: 'Create Graph'
      });
      if (!target) return;

      const name = target.path.split('/').pop()?.replace(/\.vgraph$/i, '') || 'NewGraph';
      const language = await detectWorkspaceLanguage(languages);
      const graphDocument = newDocument(name, language?.id, picked.documentKind);
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serializeDocument(graphDocument)));
      await vscode.commands.executeCommand('vscode.open', target);
    })
  );
  return { marks, provider };
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
function followGraphFileChanges(compiler: CompileService, marks: DebugMarks, recompile: (document: vscode.TextDocument) => Promise<void>): vscode.Disposable[] {
  return [
    vscode.workspace.onDidRenameFiles(async (event) => {
      for (const { oldUri, newUri } of event.files) {
        if (!isGraph(oldUri) || !isGraph(newUri)) continue;
        compiler.forget(oldUri);
        await marks.move(oldUri, newUri);
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
        await marks.forget(uri);
        const name = path.basename(uri.fsPath);
        for (const output of compiler.outputPathsFor(uri.fsPath).filter((file) => isGeneratedFrom(file, name))) {
          await vscode.workspace.fs.delete(vscode.Uri.file(output), { useTrash: true });
        }
      }
    })
  ];
}
