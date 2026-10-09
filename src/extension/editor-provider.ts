import * as vscode from 'vscode';
import { NodeRegistry } from '../core/registry';
import { HostMessage, UIMessage, GraphDefinition } from '../core/model';
import { parseGraph, serializeGraph } from '../core/serializer';
import { GraphRuntime } from '../core/runtime';
import { createNonce, renderEditorHtml } from './webview-html';

const VIEW_TYPE = 'blueprintVisualScripting.graphEditor';

type PanelSet = Set<vscode.WebviewPanel>;

export class GraphEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panelsByDocument = new Map<string, PanelSet>();
  private outputChannel: vscode.OutputChannel | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly registry: NodeRegistry) {
    context.subscriptions.push(
      registry.onDidChange(() => {
        const message: HostMessage = { type: 'definitions', definitions: registry.all() };
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
            let graph: GraphDefinition | undefined;
            let parseError: string | undefined;
            try {
              graph = parseGraph(document.getText(), this.getFallbackName(document));
            } catch (error) {
              parseError = `Cannot open graph: ${describeError(error)}`;
            }
            this.post(webviewPanel, { type: 'init', graph, definitions: this.registry.all(), saveDelay: getSaveDelay() });
            if (parseError) this.post(webviewPanel, { type: 'error', message: parseError });
            break;
          }
          case 'applyGraph': {
            if (!message.graph) return;
            const text = serializeGraph(message.graph);
            if (normalizeEol(text) === normalizeEol(document.getText())) break;
            pendingEchoText = normalizeEol(text);
            await this.updateDocument(document, text);
            break;
          }
          case 'runGraph':
            this.runGraph(document);
            break;
          default:
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
        const parsed = parseGraph(text, this.getFallbackName(event.document));
        this.post(webviewPanel, { type: 'graphChanged', graph: parsed });
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
  }

  private async updateDocument(document: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
  }

  private runGraph(document: vscode.TextDocument): void {
    let graph: GraphDefinition;
    try {
      graph = parseGraph(document.getText(), this.getFallbackName(document));
    } catch (error) {
      vscode.window.showErrorMessage(describeError(error));
      return;
    }

    const output = this.getOutputChannel();
    output.clear();
    output.show(true);
    const runtime = new GraphRuntime(this.registry, (event) => {
      this.broadcast(document.uri.toString(), { type: 'runtimeEvent', event });
      if (event.kind === 'log') output.appendLine(event.message ?? '');
      else if (event.kind === 'error') output.appendLine(`[error] ${event.message ?? ''}`);
    });
    runtime.run(graph);
  }

  private getHtml(webview: vscode.Webview): string {
    const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', name)).toString();
    return renderEditorHtml({ cspSource: webview.cspSource, nonce: createNonce(), scriptUri: asset('editor.js'), styleUri: asset('editor.css') });
  }

  private getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel('Blueprint Visual Scripting');
      this.context.subscriptions.push(this.outputChannel);
    }
    return this.outputChannel;
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
