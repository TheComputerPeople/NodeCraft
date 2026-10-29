import * as path from 'path';
import * as vscode from 'vscode';
import { SimulateBreakpoint } from '../core/debugger';
import { LanguagePackRegistry } from '../core/language-pack';
import { CompileReport, DebugAction, DebugState, DebugValue, FileSearchHit, PinRef, GraphDocument, HostMessage, LanguageOption, LibraryFile, RevealTarget, RuntimeLogEvent, UIMessage, RunStatus } from '../core/model';
import { newDocument } from '../core/blueprint-edits';
import { generatedLanguages } from '../core/user-types';
import { createResolver } from '../core/resolve';
import { DefinitionSite, findReferences } from '../core/navigation';
import { previewNode } from '../core/preview';
import { DEFAULT_LANGUAGE } from '../core/languages';
import { SearchHit, searchDocument } from '../core/search';
import { NodeRegistry } from '../core/registry';
import { GraphRuntime } from '../core/runtime';
import { parseDocument, serializeDocument } from '../core/serializer';
import { CompileService } from './compile-service';
import { loadGraphDocument } from './graph-libraries';
import { DebugMarks } from './breakpoints';
import { GraphDebug, SimulateDebug } from './graph-debug';
import { SimulateSession } from './simulate-session';
import { createNonce, renderEditorHtml } from './webview-html';

const VIEW_TYPE = 'blueprintVisualScripting.graphEditor';

type PanelSet = Set<vscode.WebviewPanel>;

// Where the extension finds what Go to Definition opens outside graphs: a project function's
// declaration (src/extension/project-functions.ts), a node file (src/extension/node-libraries.ts).
export interface DefinitionLocator {
  code?(type: string): { uri: vscode.Uri; line: number } | undefined;
  nodeFile?(type: string): vscode.Uri | undefined;
}

export class GraphEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panelsByDocument = new Map<string, PanelSet>();
  // Find in All Blueprints hits to show once their file's editor has loaded.
  private readonly pendingReveals = new Map<string, RevealTarget>();
  // The debugging session the editors show (docs/debugging.md): Simulate's, or generated code's.
  private debug: GraphDebug | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: NodeRegistry,
    private readonly languages: LanguagePackRegistry,
    private readonly compiler: CompileService,
    private readonly output: () => vscode.OutputChannel,
    // Whether the project's functions have been scanned (src/extension/project-functions.ts).
    private readonly functionsLoaded: () => boolean = () => true,
    private readonly marks: DebugMarks = new DebugMarks(context.workspaceState),
    private readonly locator: DefinitionLocator = {}
  ) {
    // Every panel of a file shows its breakpoints and watches, wherever they were changed.
    context.subscriptions.push(marks.watches.onDidChange((uri) => this.broadcast(uri.toString(), { type: 'watches', watches: marks.watches.get(uri) })));
    context.subscriptions.push(marks.breakpoints.onDidChange((uri) => {
      this.broadcast(uri.toString(), { type: 'breakpoints', breakpoints: marks.breakpoints.get(uri) });
      this.debug?.breakpointsChanged();
    }));
    context.subscriptions.push({ dispose: () => this.debug?.act('stop') });
    // Language packs from other extensions come and go: editors update their language lists.
    context.subscriptions.push(languages.onDidChange(() => {
      const message: HostMessage = { type: 'languages', languages: this.languageOptions() };
      this.panelsByDocument.forEach((panels) => panels.forEach((panel) => this.post(panel, message)));
    }));
    context.subscriptions.push(
      registry.onDidChange(() => {
        const message: HostMessage = { type: 'definitions', definitions: registry.all(), functionsLoaded: this.functionsLoaded() };
        this.panelsByDocument.forEach((panels) => panels.forEach((panel) => this.post(panel, message)));
      })
    );
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const key = document.uri.toString();
    let panels = this.panelsByDocument.get(key);
    if (!panels) {
      panels = new Set();
      this.panelsByDocument.set(key, panels);
    }
    panels.add(webviewPanel);

    // Listeners scoped to this panel; released when it closes rather than at deactivation.
    const disposables: vscode.Disposable[] = [];
    webviewPanel.onDidDispose(() => {
      panels?.delete(webviewPanel);
      if (!panels?.size) this.panelsByDocument.delete(key);
      disposables.forEach((d) => d.dispose());
    });

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')]
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    // Text this panel last wrote to the document. The resulting change event is an echo of
    // state the webview already has; reloading it would rebuild the UI mid-edit.
    let pendingEchoText: string | undefined;

    disposables.push(webviewPanel.webview.onDidReceiveMessage(async (message: UIMessage) => {
      try {
        switch (message.type) {
          case 'ready': {
            // Definitions are sent even for an unparsable document so the palette still works
            // once the text is fixed; without a graph the webview refuses edits.
            let graphDocument: GraphDocument | undefined;
            let parseError: string | undefined;
            try {
              graphDocument = parseDocument(document.getText(), this.getFallbackName(document)).document;
            } catch (error) {
              parseError = `Cannot open graph: ${describeError(error)}`;
            }
            this.post(webviewPanel, {
              type: 'init',
              document: graphDocument,
              definitions: this.registry.all(),
              functionsLoaded: this.functionsLoaded(),
              saveDelay: getSaveDelay(),
              trusted: vscode.workspace.isTrusted,
              languages: this.languageOptions(),
              compile: this.compiler.lastReport(document.uri),
              breakpoints: this.marks.breakpoints.get(document.uri),
              watches: this.marks.watches.get(document.uri)
            });
            if (parseError) this.post(webviewPanel, { type: 'error', message: parseError });
            const reveal = this.pendingReveals.get(key);
            if (reveal) {
              this.pendingReveals.delete(key);
              this.post(webviewPanel, { type: 'reveal', target: reveal });
            }
            // A file opened while debugging (the debugger opens the one it stopped in).
            if (this.debug) this.post(webviewPanel, { type: 'debugState', debug: this.debugStateFor(key) });
            break;
          }
          case 'debugAction':
            if (message.action) this.debugAction(message.action);
            break;
          case 'findInAll':
            this.post(webviewPanel, { type: 'findResults', results: await this.findInAll(message.query ?? '', key) });
            break;
          case 'setBreakpoints':
            await this.marks.breakpoints.set(document.uri, message.breakpoints ?? []);
            break;
          case 'setWatches':
            await this.marks.watches.set(document.uri, message.watches ?? []);
            break;
          case 'readValues':
            this.post(webviewPanel, { type: 'debugValues', requestId: message.requestId, values: await this.readValues(document.uri, message.pins ?? []) });
            break;
          case 'debug':
            if (this.ensureTrusted(webviewPanel)) await vscode.commands.executeCommand('blueprintVisualScripting.debug', document.uri);
            break;
          case 'reveal':
            if (message.target?.uri) await this.reveal(message.target);
            break;
          case 'goToDefinition':
            if (message.nodeType && message.site) await this.goToDefinition(document.uri, message.nodeType, message.site);
            break;
          case 'previewNode':
            this.post(webviewPanel, { type: 'nodePreview', requestId: message.requestId, preview: message.nodeType && message.document ? previewNode({ type: message.nodeType, properties: message.properties }, { language: message.document.language || DEFAULT_LANGUAGE, languages: this.languages, registry: this.registry, document: message.document }) : undefined });
            break;
          case 'findReferences':
            this.post(webviewPanel, { type: 'findResults', results: await this.findAcrossGraphs(key, (doc, resolve) => findReferences(doc, message.nodeType ?? '', resolve)) });
            break;
          case 'pickFunctionLibrary':
            this.post(webviewPanel, { type: 'functionLibrary', library: await this.pickFunctionLibrary(document) });
            break;
          case 'saveLibrary':
            if (message.library) await this.saveLibrary(document.uri, message.library);
            break;
          case 'applyDocument': {
            if (!message.document) return;
            const text = serializeDocument(message.document);
            if (normalizeEol(text) === normalizeEol(document.getText())) break;
            pendingEchoText = normalizeEol(text);
            await this.updateDocument(document, text);
            break;
          }
          case 'compile': {
            const { report } = await this.compiler.compile(document);
            this.notifyCompiled(document.uri, report);
            break;
          }
          case 'run':
            if (!this.ensureTrusted(webviewPanel)) break;
            await this.compiler.run(
              document,
              (run) => this.broadcast(key, { type: 'runStatus', run }),
              (report) => this.notifyCompiled(document.uri, report)
            );
            break;
          case 'simulate':
            if (this.ensureTrusted(webviewPanel)) this.simulate(document);
            break;
        }
      } catch (error) {
        this.post(webviewPanel, { type: 'error', message: describeError(error) });
      }
    }));

    disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== key || event.contentChanges.length === 0) return;
      const text = event.document.getText();
      const isEcho = pendingEchoText !== undefined && normalizeEol(text) === pendingEchoText;
      pendingEchoText = undefined;
      if (isEcho) return;
      try {
        const { document: parsed } = parseDocument(text, this.getFallbackName(event.document));
        this.post(webviewPanel, { type: 'documentChanged', document: parsed });
      } catch (error) {
        // Typical while the file is being edited as text; keep the last good graph on screen.
        this.post(webviewPanel, { type: 'error', message: `Graph document is invalid: ${describeError(error)}` });
      }
    }));

    disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SAVE_DELAY_SETTING)) {
        this.post(webviewPanel, { type: 'settings', saveDelay: getSaveDelay() });
      }
    }));

    disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
      this.post(webviewPanel, { type: 'settings', trusted: true });
    }));
  }

  // Unreal's Find in All Blueprints: searches every graph in the workspace, using the editor's
  // text for files that are open (so unsaved changes are found too).
  private async findInAll(query: string, currentKey: string): Promise<FileSearchHit[]> {
    if (!query.trim()) return [];
    return this.findAcrossGraphs(currentKey, (doc, resolve) => searchDocument(doc, query, resolve));
  }

  // Runs `search` on every graph in the workspace (Find in All Blueprints, Find References).
  private async findAcrossGraphs(currentKey: string, search: (doc: GraphDocument, resolve: ReturnType<typeof createResolver>) => SearchHit[]): Promise<FileSearchHit[]> {
    const files = await vscode.workspace.findFiles('**/*.vgraph', '**/node_modules/**', 2000);
    const results: FileSearchHit[] = [];
    for (const uri of files) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      let text: string;
      try {
        text = open?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        continue;
      }
      let graphDocument: GraphDocument;
      try {
        graphDocument = parseDocument(text, uri.path.split('/').pop()?.replace(/\.vgraph$/i, '') || 'Graph').document;
      } catch {
        // Unreadable graphs are skipped; opening them shows the problem.
        continue;
      }
      const resolve = createResolver(this.registry, graphDocument);
      for (const hit of search(graphDocument, resolve)) {
        results.push({ ...hit, uri: uri.toString(), file: vscode.workspace.asRelativePath(uri), current: uri.toString() === currentKey });
        if (results.length >= MAX_FIND_RESULTS) return results;
      }
    }
    return results;
  }

  // Go to Definition (docs/node-authoring.md, gap 5): a library's graph, the project's code at the
  // declaration, or a node file at its type.
  async goToDefinition(from: vscode.Uri, nodeType: string, site: DefinitionSite): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(from)?.uri;
    const name = this.registry.get(nodeType)?.displayName ?? nodeType;
    if (site.kind === 'library' && folder) {
      const uri = vscode.Uri.joinPath(folder, ...site.document.split('/'));
      await this.reveal({ uri: uri.toString(), kind: 'graph', id: site.graphId, graphId: site.graphId });
      return;
    }
    if (site.kind === 'code') {
      const found = this.locator.code?.(nodeType);
      const uri = found?.uri ?? (folder ? vscode.Uri.joinPath(folder, ...site.path.split('/')) : undefined);
      if (uri) {
        await this.showText(uri, (found?.line ?? 1) - 1);
        return;
      }
    }
    if (site.kind === 'node-file') {
      const uri = this.locator.nodeFile?.(nodeType);
      if (uri) {
        // The line naming its type.
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const line = text.split(/\r?\n/).findIndex((l) => l.includes(JSON.stringify(nodeType)));
        await this.showText(uri, Math.max(0, line));
        return;
      }
    }
    void vscode.window.showInformationMessage(`"${name}" has no definition in the workspace to open.`);
  }

  private async showText(uri: vscode.Uri, line: number): Promise<void> {
    const position = new vscode.Position(line, 0);
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position), viewColumn: vscode.ViewColumn.Active });
  }

  // Opens another graph file at a Find in All Blueprints hit.
  private async reveal(target: RevealTarget): Promise<void> {
    const uri = vscode.Uri.parse(target.uri!);
    const key = uri.toString();
    const open = this.panelsByDocument.get(key);
    if (open?.size) open.forEach((panel) => this.post(panel, { type: 'reveal', target }));
    else this.pendingReveals.set(key, target);
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  }

  // Sends a message to the graph editor that has focus, if any.
  postToActive(message: HostMessage): boolean {
    for (const panels of this.panelsByDocument.values()) {
      for (const panel of panels) {
        if (panel.active) {
          this.post(panel, message);
          return true;
        }
      }
    }
    return false;
  }

  // Shows a run's progress in every editor open on the graph.
  notifyRunStatus(uri: vscode.Uri, run: RunStatus): void {
    this.broadcast(uri.toString(), { type: 'runStatus', run });
  }

  // Shows a compile result in every editor open on the graph.
  notifyCompiled(uri: vscode.Uri, report: CompileReport): void {
    this.broadcast(uri.toString(), { type: 'compileResult', compile: report });
  }

  private languageOptions(): LanguageOption[] {
    return this.languages.all().filter((p) => p.generator).map((p) => ({
      id: p.id, displayName: p.displayName, callable: p.generator!.importLanguages, capabilities: p.capabilities,
      snippetLanguages: p.generator!.snippetLanguages, snippets: Object.keys(p.generator!.snippets ?? {}),
      ...(p.terms ? { terms: p.terms } : {})
    }));
  }

  // Running executes code-node snippets and generated code, which is as risky as running workspace
  // code. The buttons are disabled too; this guards against a stale webview.
  private ensureTrusted(panel: vscode.WebviewPanel): boolean {
    if (vscode.workspace.isTrusted) return true;
    this.post(panel, { type: 'error', message: RESTRICTED_MODE_MESSAGE });
    return false;
  }

  // Collapse to Function in Library: the workspace's function libraries the graph's language can
  // call, or a new one (not written until the collapse saves it). Undefined when cancelled.
  private async pickFunctionLibrary(document: vscode.TextDocument): Promise<LibraryFile | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return undefined;
    let language: string | undefined;
    try {
      language = parseDocument(document.getText(), this.getFallbackName(document)).document.language;
    } catch {
      return undefined;
    }
    const libraries: LibraryFile[] = [];
    for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.vgraph'), '**/node_modules/**', 2000)) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      if (!text.includes('"functionLibrary"')) continue;
      try {
        const library = parseDocument(text, path.basename(uri.fsPath, '.vgraph')).document;
        if (library.kind === 'functionLibrary' && (!language || generatedLanguages(library).includes(language))) {
          libraries.push({ path: path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/'), document: library });
        }
      } catch {
        // Not a readable graph file.
      }
    }
    libraries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const NEW = '$(add) New Function Library…';
    const picked = await vscode.window.showQuickPick(
      [...libraries.map((library) => ({ label: library.document.name, description: library.path, library })), { label: NEW, description: '', library: undefined }],
      { placeHolder: 'Collapse into which function library?' }
    );
    if (!picked) return undefined;
    if (picked.library) return picked.library;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(document.uri, '..', `${this.getFallbackName(document)}Library.vgraph`),
      filters: { 'Visual Graph': ['vgraph'] },
      saveLabel: 'Create Function Library'
    });
    if (!target || !vscode.workspace.getWorkspaceFolder(target)) return undefined;
    const name = path.basename(target.fsPath, '.vgraph');
    // Its only function will be the collapsed one.
    const library = { ...newDocument(name, language, 'functionLibrary'), graphs: [] };
    return { path: path.relative(folder.uri.fsPath, target.fsPath).split(path.sep).join('/'), document: library };
  }

  // Writes a library the webview collapsed nodes into, and saves it, so it compiles as on save.
  private async saveLibrary(from: vscode.Uri, library: LibraryFile): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(from);
    if (!folder) return;
    const uri = vscode.Uri.joinPath(folder.uri, ...library.path.split('/'));
    const create = new vscode.WorkspaceEdit();
    create.createFile(uri, { ignoreIfExists: true });
    await vscode.workspace.applyEdit(create);
    const text = await vscode.workspace.openTextDocument(uri);
    await this.updateDocument(text, serializeDocument(library.document));
    await text.save();
  }

  private async updateDocument(document: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
  }

  // Runs the graph in the editor's reference interpreter: under the debugger, in a worker, when
  // breakpoints are set anywhere in the workspace.
  private simulate(document: vscode.TextDocument): void {
    let graphDocument: GraphDocument;
    try {
      graphDocument = parseDocument(document.getText(), this.getFallbackName(document)).document;
    } catch (error) {
      vscode.window.showErrorMessage(describeError(error));
      return;
    }

    const output = this.output();
    output.clear();
    output.show(true);
    const args = vscode.workspace.getConfiguration('blueprintVisualScripting', document.uri).get<string[]>('runArguments', []);
    const emit = (event: RuntimeLogEvent): void => {
      // Each event goes to the editors of the file its node is in.
      this.broadcast(this.fileUri(document.uri, event.document).toString(), { type: 'runtimeEvent', event });
      if (event.kind === 'log') output.appendLine(event.message ?? '');
      else if (event.kind === 'error') output.appendLine(`[error] ${event.document ? `${event.document}: ` : ''}${event.message ?? ''}`);
    };
    if (this.debug instanceof SimulateDebug) this.debug.act('stop');
    const breakpoints = this.simulateBreakpoints(document.uri);
    if (breakpoints.length) {
      output.appendLine('Simulating in the editor, with breakpoints');
      this.debugSimulate(document.uri, graphDocument, args, breakpoints, emit);
      return;
    }
    output.appendLine('Simulating in the editor');
    new GraphRuntime(this.registry, emit, this.languages, (file) => loadGraphDocument(document.uri, file)).run(graphDocument, args);
  }

  // Runs the graph's Test Case events in the editor's interpreter (docs/debugging.md, "Test Case").
  simulateTests(document: vscode.TextDocument): void {
    let graphDocument: GraphDocument;
    try {
      graphDocument = parseDocument(document.getText(), this.getFallbackName(document)).document;
    } catch (error) {
      vscode.window.showErrorMessage(describeError(error));
      return;
    }
    const output = this.output();
    output.clear();
    output.show(true);
    output.appendLine(`Simulating the tests of ${path.basename(document.uri.fsPath)}`);
    const results = new GraphRuntime(this.registry, (event) => {
      this.broadcast(this.fileUri(document.uri, event.document).toString(), { type: 'runtimeEvent', event });
      if (event.kind === 'log') output.appendLine(`  ${event.message ?? ''}`);
      else if (event.kind === 'test.pass') output.appendLine(`\u2714 ${event.test}`);
      else if (event.kind === 'test.fail') output.appendLine(`\u2716 ${event.test}: ${event.message ?? ''}`);
    }, this.languages, (file) => loadGraphDocument(document.uri, file)).runTests(graphDocument);
    const failed = results.filter((r) => !r.passed).length;
    const summary = !results.length ? 'This graph has no Test Case events.' : failed ? `${failed} of ${results.length} tests failed.` : `All ${results.length} tests passed.`;
    output.appendLine(summary);
    this.broadcast(document.uri.toString(), { type: 'runStatus', run: { state: failed || !results.length ? 'failed' : 'finished', message: summary } });
  }

  private debugSimulate(uri: vscode.Uri, graphDocument: GraphDocument, args: string[], breakpoints: SimulateBreakpoint[], emit: (event: RuntimeLogEvent) => void): void {
    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    // Open graph files' unsaved text wins over the file on disk, as in loadGraphDocument.
    const openDocuments: Record<string, string> = {};
    for (const d of vscode.workspace.textDocuments) {
      if (root && d.uri.scheme === 'file' && d.uri.fsPath.toLowerCase().endsWith('.vgraph')) openDocuments[relativePath(root, d.uri.fsPath)] = d.getText();
    }
    let debug: SimulateDebug | undefined = undefined;
    const session = new SimulateSession({ definitions: this.registry.all(), document: graphDocument, root, openDocuments, args, breakpoints }, {
      event: emit,
      paused: (stack) => {
        debug?.paused(stack);
        if (debug) this.debugChanged(debug);
      },
      resumed: () => {
        debug?.resumed();
        if (debug) this.debugChanged(debug);
      },
      ended: () => {
        if (debug) this.debugEnded(debug);
      }
    });
    debug = new SimulateDebug(session, (document) => this.fileUri(uri, document), () => this.simulateBreakpoints(uri));
    this.debugStarted(debug);
  }

  // The debugging session the editors show, if any.
  currentDebug(): GraphDebug | undefined {
    return this.debug;
  }

  // Resume, Step Over/Into/Out and Stop (the editor's buttons, and the keys while it has focus).
  debugAction(action: DebugAction): void {
    this.debug?.act(action);
  }

  // A debugging session the editors show starts (replacing the one shown), pauses or resumes, or
  // ends.
  debugStarted(debug: GraphDebug): void {
    if (this.debug && this.debug !== debug) this.debug.act('stop');
    this.debug = debug;
    setContext('debugging', true);
    this.debugChanged(debug);
  }

  debugChanged(debug: GraphDebug): void {
    if (debug !== this.debug) return;
    setContext('debugPaused', !!debug.stack);
    this.broadcastDebugState();
    // Shows the graph the debugger stopped in, over the generated code a debugger shows.
    const top = debug.stack?.[0];
    if (top && !top.external) void this.revealGraphEditor(top.uri);
  }

  debugEnded(debug: GraphDebug): void {
    if (debug !== this.debug) return;
    this.debug = undefined;
    setContext('debugPaused', false);
    setContext('debugging', false);
    this.broadcastDebugState();
  }

  // Brings a graph file's editor to the front, where it is open, or opens it.
  async revealGraphEditor(uri: vscode.Uri): Promise<void> {
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === VIEW_TYPE && t.input.uri.toString() === uri.toString());
    if (tab?.isActive && tab.group.isActive) return;
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, tab ? { viewColumn: tab.group.viewColumn, preserveFocus: false } : undefined);
  }

  // The workspace's enabled breakpoints, with their files named as a Simulate of `uri` names them.
  private simulateBreakpoints(uri: vscode.Uri): SimulateBreakpoint[] {
    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    return Object.entries(this.marks.breakpoints.all()).flatMap(([key, list]) => {
      const file = vscode.Uri.parse(key);
      const document = key === uri.toString() ? undefined : root && file.scheme === 'file' ? relativePath(root, file.fsPath) : null;
      if (document === null || document?.startsWith('..')) return [];
      return list.filter((b) => b.enabled).map((b) => ({ graphId: b.graphId, nodeId: b.nodeId, ...(document ? { document } : {}) }));
    });
  }

  // A graph file as runtime events and frames name it: relative to the workspace, or absent for
  // the file simulated.
  private fileUri(simulated: vscode.Uri, document: string | undefined): vscode.Uri {
    const root = vscode.workspace.getWorkspaceFolder(simulated)?.uri;
    return document && root ? vscode.Uri.joinPath(root, ...document.split('/')) : simulated;
  }

  private async readValues(file: vscode.Uri, pins: PinRef[]): Promise<DebugValue[]> {
    return this.debug ? this.debug.read(file, pins) : pins.map(() => ({ unavailable: 'Values are read while paused.' }));
  }

  private debugStateFor(panelKey: string): DebugState {
    const debug = this.debug;
    if (!debug) return { state: 'ended' };
    if (!debug.stack) return { state: 'running' };
    return {
      state: 'paused',
      stack: debug.stack.map(({ uri, prologue: _prologue, ...frame }) => ({
        ...frame, uri: uri.toString(), fileName: path.basename(uri.path).replace(/\.vgraph$/i, ''), here: !frame.external && uri.toString() === panelKey
      }))
    };
  }

  private broadcastDebugState(): void {
    this.panelsByDocument.forEach((panels, key) => panels.forEach((panel) => this.post(panel, { type: 'debugState', debug: this.debugStateFor(key) })));
  }

  private getHtml(webview: vscode.Webview): string {
    const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', name)).toString();
    return renderEditorHtml({ cspSource: webview.cspSource, nonce: createNonce(), scriptUri: asset('editor.js'), styleUri: asset('editor.css') });
  }

  private post(panel: vscode.WebviewPanel, message: HostMessage): void {
    panel.webview.postMessage(message);
  }

  private broadcast(key: string, message: HostMessage): void {
    const panels = this.panelsByDocument.get(key);
    panels?.forEach((panel) => this.post(panel, message));
  }

  private getFallbackName(document: vscode.TextDocument): string {
    return document.uri.path.split('/').pop()?.replace(/\.vgraph$/i, '') || 'NewGraph';
  }
}

const MAX_FIND_RESULTS = 500;
const RESTRICTED_MODE_MESSAGE = 'Running graphs is disabled in Restricted Mode. Trust this workspace to run graphs.';
const SAVE_DELAY_SETTING = 'blueprintVisualScripting.autoSaveDelay';
const DEFAULT_SAVE_DELAY_MS = 150;

function setContext(key: string, value: boolean): void {
  void vscode.commands.executeCommand('setContext', `blueprintVisualScripting.${key}`, value);
}

function relativePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function getSaveDelay(): number {
  const value = vscode.workspace.getConfiguration().get<number>(SAVE_DELAY_SETTING, DEFAULT_SAVE_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SAVE_DELAY_MS;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// VS Code converts inserted text to the document's EOL, so compare line-ending-insensitively.
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export const GRAPH_VIEW_TYPE = VIEW_TYPE;
