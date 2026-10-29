import * as path from 'node:path';
import * as vscode from 'vscode';
import { builtinLanguagePacks } from '../core/languages';
import { NodeRegistry } from '../core/registry';
import { DOCUMENT_KIND_NAMES, newDocument } from '../core/blueprint-edits';
import { DocumentKind } from '../core/model';
import { serializeDocument } from '../core/serializer';
import { CompileService } from './compile-service';
import { GraphEditorProvider, GRAPH_VIEW_TYPE } from './editor-provider';
import { detectNewGraphLanguage } from './languages';
import { NodeLibraries, workspaceSnippetLanguages } from './node-libraries';
import { addBlueprintPackage } from './blueprint-packages';
import { newNodeDefinition } from '../core/node-files';
import { ConformanceReport, formatReport, runNodeExamples, simulateNodeExamples } from '../conformance/conformance';
import { NodeDefinition } from '../core/model';
import { parseNodeDefinition } from '../core/registry';
import { isGeneratedFrom } from './placement';
import { GraphLibraries } from './graph-libraries';
import { DebugMarks } from './breakpoints';
import { CodeDebugService } from './code-debug';
import { createApi } from './api';
import { OutputPlans } from './output-plans';
import { BlueprintVisualScriptingApi } from '../core/api';
import { ProjectFunctions } from './project-functions';
import { watchWorkspaceLanguagePacks } from './workspace-packs';

// What activation returns: the public API (src/core/api.ts), and, for this extension's own
// integration tests only, a few internals.
export interface ExtensionApi extends BlueprintVisualScriptingApi {
  testing: { marks: DebugMarks; provider: GraphEditorProvider; outputPlans: OutputPlans; registry: NodeRegistry };
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  // Libraries load in the background; open editors receive the updated definitions when ready.
  const registry = new NodeRegistry();
  const languages = builtinLanguagePacks();
  const nodeLibraries = new NodeLibraries(registry, languages);
  context.subscriptions.push(nodeLibraries);

  let outputChannel: vscode.OutputChannel | undefined;
  const output = (): vscode.OutputChannel => {
    if (!outputChannel) {
      outputChannel = vscode.window.createOutputChannel('Blueprint Visual Scripting');
      context.subscriptions.push(outputChannel);
    }
    return outputChannel;
  };

  // Declarative language packs in the workspace (docs/language-breadth.md, "Declarative packs").
  context.subscriptions.push(watchWorkspaceLanguagePacks(languages, output));

  // The project's own functions, exposed as nodes (docs/code-as-nodes.md), with warnings and Expose
  // quick fixes in their files.
  const projectFunctions = new ProjectFunctions(registry, languages, output);
  context.subscriptions.push(projectFunctions);
  // Function libraries made of graphs (docs/program-structure.md, "Functions").
  const graphLibraries = new GraphLibraries(registry, languages, nodeLibraries);
  context.subscriptions.push(graphLibraries);

  // Compiling waits for the first scans, so functions that are merely still loading aren't reported missing.
  // Registering generated files with the project's build, with consent (docs/output-placement.md).
  const outputPlans = new OutputPlans(context.workspaceState, languages);
  context.subscriptions.push(outputPlans);
  const compiler = new CompileService(registry, languages, output, () => Promise.all([projectFunctions.ready, graphLibraries.ready]).then(() => undefined), outputPlans);
  // Breakpoints on nodes, kept per workspace (docs/debugging.md).
  const marks = new DebugMarks(context.workspaceState);
  context.subscriptions.push(marks);
  const provider = new GraphEditorProvider(context, registry, languages, compiler, output, () => projectFunctions.loaded, marks, {
    code: (type) => projectFunctions.locate(type),
    nodeFile: (type) => nodeLibraries.locate(type)
  });
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
    // Test Case events (docs/debugging.md): with the language's test tool, or in Simulate.
    vscode.commands.registerCommand('blueprintVisualScripting.runTests', async (uri?: vscode.Uri) => {
      const document = await graphDocumentFor(uri);
      if (!document) return;
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage('Running graphs is disabled in Restricted Mode. Trust this workspace to run graphs.');
        return;
      }
      await compiler.run(document, (status) => {
        provider.notifyRunStatus(document.uri, status);
        if (status.state === 'failed') void vscode.window.showErrorMessage(status.message);
        else if (status.state === 'finished') void vscode.window.showInformationMessage(status.message);
      }, (report) => provider.notifyCompiled(document.uri, report), true);
    }),
    vscode.commands.registerCommand('blueprintVisualScripting.simulateTests', async (uri?: vscode.Uri) => {
      const document = await graphDocumentFor(uri);
      if (!document) return;
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage('Running graphs is disabled in Restricted Mode. Trust this workspace to run graphs.');
        return;
      }
      provider.simulateTests(document);
    }),
    vscode.commands.registerCommand('blueprintVisualScripting.debug', async (uri?: vscode.Uri) => {
      const document = await graphDocumentFor(uri);
      if (document) await codeDebug.start(document.uri);
    }),
    // The debugger's buttons (docs/debugging.md); the keys apply while a graph editor has focus.
    ...(['resume', 'stepOver', 'stepInto', 'stepOut', 'stop'] as const).map((action) =>
      vscode.commands.registerCommand(`blueprintVisualScripting.debug.${action}`, () => provider.debugAction(action))),
    // Offers the build registrations the user declined again (docs/output-placement.md).
    vscode.commands.registerCommand('blueprintVisualScripting.registerGeneratedFiles', async () => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) await outputPlans.offerAgain(folder.uri.fsPath);
    }),
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

  context.subscriptions.push(...followGraphFileChanges(compiler, marks, compileAndReport, outputPlans));

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
      const language = await detectNewGraphLanguage(languages, target);
      const graphDocument = newDocument(name, language?.id, picked.documentKind);
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serializeDocument(graphDocument)));
      await vscode.commands.executeCommand('vscode.open', target);
    })
  );
  // New Node (docs/node-authoring.md, gap 8): a snippet node to start from, in the folder picked in
  // the Explorer (else the workspace's nodes folder), with a snippet for each language its graphs use.
  context.subscriptions.push(vscode.commands.registerCommand('blueprintVisualScripting.newNode', async (folder?: vscode.Uri, given?: { name: string; category: string }): Promise<vscode.Uri | undefined> => {
    const name = given?.name ?? await vscode.window.showInputBox({ prompt: "The node's name", placeHolder: 'Clamp Health', validateInput: (v) => (v.trim() ? undefined : 'Give the node a name.') });
    if (!name?.trim()) return undefined;
    const category = given?.category ?? await vscode.window.showInputBox({ prompt: 'Its category in the palette ("|" nests one in another)', value: 'My Nodes' });
    if (category === undefined) return undefined;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    let directory = folder ?? (workspaceFolder && vscode.Uri.joinPath(workspaceFolder, 'nodes'));
    if (!directory) {
      void vscode.window.showErrorMessage('Open a folder first: New Node writes its file there.');
      return undefined;
    }
    if (folder && (await vscode.workspace.fs.stat(folder).then((s) => s.type, () => vscode.FileType.Unknown)) === vscode.FileType.File) directory = vscode.Uri.joinPath(folder, '..');
    const fileName = `${name.trim().split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'NewNode'}.node.json`;
    const target = vscode.Uri.joinPath(directory, fileName);
    if (await vscode.workspace.fs.stat(target).then(() => true, () => false)) {
      void vscode.window.showErrorMessage(`${vscode.workspace.asRelativePath(target)} already exists.`);
      return undefined;
    }
    const definition = newNodeDefinition(name, category.trim() || 'My Nodes', await workspaceSnippetLanguages(languages));
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(`${JSON.stringify(definition, null, 2)}\n`));
    await vscode.window.showTextDocument(target);
    return target;
  }));
  // Add Blueprint Package… (docs/node-authoring.md, gap 9): from a folder or an installed extension.
  context.subscriptions.push(vscode.commands.registerCommand('blueprintVisualScripting.addBlueprintPackage', (source?: vscode.Uri) => addBlueprintPackage(languages, source)));
  // Test Node Library (docs/node-authoring.md, gap 8): the examples of a node file's nodes, or a
  // folder's, run in Simulate and in each language the workspace's graphs use; nodes without
  // examples are compiled. The report goes to the output channel.
  context.subscriptions.push(vscode.commands.registerCommand('blueprintVisualScripting.testNodeLibrary', async (target?: vscode.Uri, only?: string[]): Promise<ConformanceReport[] | undefined> => {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Testing a node library runs its code; trust the workspace first.');
      return undefined;
    }
    const where = target ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!where) return undefined;
    const isFile = (await vscode.workspace.fs.stat(where)).type === vscode.FileType.File;
    const files = isFile ? [where] : await vscode.workspace.findFiles(new vscode.RelativePattern(where, '**/*.node.json'), '**/node_modules/**', 500);
    const nodes: NodeDefinition[] = [];
    for (const file of files) {
      try {
        const def = parseNodeDefinition(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
        if (def) nodes.push(def);
      } catch {
        // A file that isn't a node shows its problems in its editor.
      }
    }
    if (!nodes.length) {
      void vscode.window.showInformationMessage(`No nodes in ${vscode.workspace.asRelativePath(where)}.`);
      return undefined;
    }
    // `only`: the languages to test in, in place of the workspace's (for tests).
    const used = only ? only.map((id) => ({ id })) : await workspaceSnippetLanguages(languages);
    const packs = (used.length ? used.map((l) => languages.get(l.id)!) : [languages.get('typescript')!]).filter((p) => p?.generator?.runner);
    const commands = vscode.workspace.getConfiguration('blueprintVisualScripting').get<Record<string, string[]>>('runCommands', {});
    const reports = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Testing the node library', cancellable: false }, async (progress) => {
      const done: ConformanceReport[] = [simulateNodeExamples(nodes, packs[0]?.id)];
      for (const pack of packs) {
        progress.report({ message: pack.displayName });
        done.push(await runNodeExamples(pack, nodes, { command: commands[pack.id], ...(pack.id === 'javascript' ? { generate: { moduleFormat: 'esm' } } : {}) }));
      }
      return done;
    });
    const channel = output();
    channel.appendLine(`Test Node Library: ${vscode.workspace.asRelativePath(where)} (${nodes.length} node${nodes.length === 1 ? '' : 's'})`);
    for (const report of reports) channel.appendLine(formatReport(report));
    const failed = reports.reduce((n, r) => n + r.failed, 0);
    const passed = reports.reduce((n, r) => n + r.passed, 0);
    void (failed ? vscode.window.showWarningMessage(`Test Node Library: ${failed} failed, ${passed} passed.`, 'Show Output') : vscode.window.showInformationMessage(`Test Node Library: ${passed} passed.`, 'Show Output'))
      .then((choice) => choice && channel.show());
    return reports;
  }));
  return { ...createApi(languages, nodeLibraries, output), testing: { marks, provider, outputPlans, registry } };
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
function followGraphFileChanges(compiler: CompileService, marks: DebugMarks, recompile: (document: vscode.TextDocument) => Promise<void>, outputPlans: OutputPlans): vscode.Disposable[] {
  // Build registrations list every generated file, so they change when a graph goes or moves.
  const refreshPlans = async (uri: vscode.Uri): Promise<void> => {
    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (root) await outputPlans.refreshAll(root);
  };
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
        await refreshPlans(newUri);
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
        await refreshPlans(uri);
      }
    })
  ];
}
