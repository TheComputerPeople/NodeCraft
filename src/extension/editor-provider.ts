import * as vscode from 'vscode';
import { LanguagePackRegistry } from '../core/language-pack';
import { CompileReport, FileSearchHit, GraphDocument, HostMessage, LanguageOption, RevealTarget, UIMessage } from '../core/model';
import { createResolver } from '../core/resolve';
import { searchDocument } from '../core/search';
import { NodeRegistry } from '../core/registry';
import { GraphRuntime } from '../core/runtime';
import { parseDocument, serializeDocument } from '../core/serializer';
import { CompileService } from './compile-service';
import { loadGraphDocument } from './graph-libraries';
import { createNonce, renderEditorHtml } from './webview-html';

const VIEW_TYPE = 'blueprintVisualScripting.graphEditor';

type PanelSet = Set<vscode.WebviewPanel>;

export class GraphEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panelsByDocument = new Map<string, PanelSet>();
  // Find in All Blueprints hits to show once their file's editor has loaded.
  private readonly pendingReveals = new Map<string, RevealTarget>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: NodeRegistry,
    private readonly languages: LanguagePackRegistry,
    private readonly compiler: CompileService,
    private readonly output: () => vscode.OutputChannel,
    // Whether the project's functions have been scanned (src/extension/project-functions.ts).
    private readonly functionsLoaded: () => boolean = () => true
  ) {
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
              compile: this.compiler.lastReport(document.uri)
            });
            if (parseError) this.post(webviewPanel, { type: 'error', message: parseError });
            const reveal = this.pendingReveals.get(key);
            if (reveal) {
              this.pendingReveals.delete(key);
              this.post(webviewPanel, { type: 'reveal', target: reveal });
            }
            break;
          }
          case 'findInAll':
            this.post(webviewPanel, { type: 'findResults', results: await this.findInAll(message.query ?? '', key) });
            break;
          case 'reveal':
            if (message.target?.uri) await this.reveal(message.target);
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
      for (const hit of searchDocument(graphDocument, query, resolve)) {
        results.push({ ...hit, uri: uri.toString(), file: vscode.workspace.asRelativePath(uri), current: uri.toString() === currentKey });
        if (results.length >= MAX_FIND_RESULTS) return results;
      }
    }
    return results;
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

  // Shows a compile result in every editor open on the graph.
  notifyCompiled(uri: vscode.Uri, report: CompileReport): void {
    this.broadcast(uri.toString(), { type: 'compileResult', compile: report });
  }

  private languageOptions(): LanguageOption[] {
    return this.languages.all().filter((p) => p.generator).map((p) => ({ id: p.id, displayName: p.displayName, callable: p.generator!.importLanguages }));
  }

  // Running executes code-node snippets and generated code, which is as risky as running workspace
  // code. The buttons are disabled too; this guards against a stale webview.
  private ensureTrusted(panel: vscode.WebviewPanel): boolean {
    if (vscode.workspace.isTrusted) return true;
    this.post(panel, { type: 'error', message: RESTRICTED_MODE_MESSAGE });
    return false;
  }

  private async updateDocument(document: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
  }

  // Runs the graph in the editor's reference interpreter.
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
    output.appendLine('Simulating in the editor');
    const runtime = new GraphRuntime(this.registry, (event) => {
      // Nodes of a function library's graph aren't in this editor.
      if (!event.document) this.broadcast(document.uri.toString(), { type: 'runtimeEvent', event });
      if (event.kind === 'log') output.appendLine(event.message ?? '');
      else if (event.kind === 'error') output.appendLine(`[error] ${event.document ? `${event.document}: ` : ''}${event.message ?? ''}`);
    }, this.languages, (path) => loadGraphDocument(document.uri, path));
    runtime.run(graphDocument, vscode.workspace.getConfiguration('blueprintVisualScripting', document.uri).get<string[]>('runArguments', []));
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
