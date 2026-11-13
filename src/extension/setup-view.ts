// The Set Up in This Project report (docs/project-integration.md, part 5) in a webview: each
// project's findings, with Show Change (a diff) and Apply (an undoable workspace edit) on each change.
// Nothing is changed without a click.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguagePackRegistry } from '../core/language-pack';
import { GRAPH_VIEW_TYPE } from './editor-provider';
import { ProjectSetup, SetupChange, SetupItem, setupReport } from './setup';

const PROPOSAL_SCHEME = 'vgraph-setup';

export class SetupView implements vscode.Disposable {
  private readonly proposals = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private root: string | undefined;
  private report: ProjectSetup[] = [];

  constructor(private readonly languages: LanguagePackRegistry) {
    this.disposables.push(vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, { provideTextDocumentContent: (uri) => this.proposals.get(uri.path) ?? '' }));
  }

  // Shows the report for a folder, and returns it.
  show(folder: string): ProjectSetup[] {
    this.root = folder;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('blueprintVisualScripting.setUp', 'Set Up in This Project', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
      this.panel.onDidDispose(() => (this.panel = undefined), undefined, this.disposables);
      this.panel.webview.onDidReceiveMessage((message: { type: 'show' | 'apply' | 'refresh'; id?: string }) => void this.receive(message), undefined, this.disposables);
    } else this.panel.reveal();
    return this.refresh();
  }

  // Applies a change of the report shown (the webview's Apply; the tests call it too).
  async apply(id: string): Promise<boolean> {
    const change = this.change(id);
    if (!change || !this.root) return false;
    const edit = new vscode.WorkspaceEdit();
    const hadChanges = new Set<string>();
    for (const file of change.files) {
      const uri = vscode.Uri.file(path.join(this.root, file.path));
      if (fs.existsSync(uri.fsPath)) {
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty) hadChanges.add(uri.fsPath);
        edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), file.text);
      } else {
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), file.text);
      }
    }
    if (!await vscode.workspace.applyEdit(edit)) return false;
    // Saved, as the build reads them, unless they had changes of the user's own.
    for (const file of change.files) {
      const fsPath = path.join(this.root, file.path);
      const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
      if (document?.isDirty && !hadChanges.has(fsPath)) await document.save();
    }
    if (change.open) {
      const graph = vscode.Uri.file(path.join(this.root, change.open));
      await vscode.commands.executeCommand('vscode.openWith', graph, GRAPH_VIEW_TYPE);
      await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
    }
    this.refresh();
    return true;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private refresh(): ProjectSetup[] {
    this.report = this.root ? setupReport(this.root, this.languages) : [];
    if (this.panel) this.panel.webview.html = render(this.report, this.root ?? '', nonce());
    return this.report;
  }

  private change(id: string): SetupChange | undefined {
    return this.report.flatMap((p) => p.items).find((i) => i.change?.id === id)?.change;
  }

  private async receive(message: { type: 'show' | 'apply' | 'refresh'; id?: string }): Promise<void> {
    if (message.type === 'refresh') this.refresh();
    else if (message.type === 'apply' && message.id) await this.apply(message.id);
    else if (message.type === 'show' && message.id) await this.showChange(message.id);
  }

  // Each file of the change, as it is and as it would be.
  private async showChange(id: string): Promise<void> {
    const change = this.change(id);
    if (!change || !this.root) return;
    for (const file of change.files) {
      const current = vscode.Uri.file(path.join(this.root, file.path));
      const proposed = `/proposed/${file.path}`;
      this.proposals.set(proposed, file.text);
      const before = fs.existsSync(current.fsPath) ? current : vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/new/${file.path}` });
      await vscode.commands.executeCommand('vscode.diff', before, vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: proposed }), `${path.basename(file.path)}: proposed change`);
    }
  }
}

const KINDS: { kind: SetupItem['kind']; heading: string }[] = [
  { kind: 'needs', heading: 'Needs' }, { kind: 'cant', heading: "Can't" }, { kind: 'found', heading: 'Found' }, { kind: 'optional', heading: 'Optional' }
];

function render(report: ProjectSetup[], root: string, scriptNonce: string): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const item = (i: SetupItem) => `<li class="${i.kind}"><div class="title">${escape(i.title)}</div>${i.detail ? `<div class="detail">${escape(i.detail)}</div>` : ''}${i.change ? `<div class="actions"><button data-show="${escape(i.change.id)}">Show Change</button><button data-apply="${escape(i.change.id)}">Apply</button></div>` : ''}</li>`;
  const project = (p: ProjectSetup) => `<section><h2>${escape(p.root || path.basename(root))}</h2>${KINDS.map(({ kind, heading }) => {
    const list = p.items.filter((i) => i.kind === kind);
    return list.length ? `<h3>${heading}</h3><ul>${list.map(item).join('')}</ul>` : '';
  }).join('')}</section>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
<title>Set Up in This Project</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 16px 24px; }
  h1 { font-size: 1.4em; } h2 { font-size: 1.15em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; } h3 { font-size: 1em; margin-bottom: 4px; }
  ul { list-style: none; padding: 0; margin: 0 0 8px; } li { padding: 6px 8px; margin: 4px 0; border-left: 3px solid var(--vscode-panel-border); }
  li.needs { border-left-color: var(--vscode-editorWarning-foreground); } li.cant { border-left-color: var(--vscode-editorError-foreground); } li.optional { border-left-color: var(--vscode-textLink-foreground); }
  .detail { opacity: 0.85; margin-top: 2px; } .actions { margin-top: 6px; display: flex; gap: 6px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 10px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); } button[data-show] { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style></head>
<body>
<h1>Set Up in This Project</h1>
<p>${escape(root)} <button id="refresh">Refresh</button></p>
${report.length ? report.map(project).join('') : '<p>No project found: a folder with a language\'s project file (package.json, pyproject.toml, a .csproj, Cargo.toml, go.mod, ...) is one.</p>'}
<script nonce="${scriptNonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.id === 'refresh') vscode.postMessage({ type: 'refresh' });
    else if (button.dataset.show) vscode.postMessage({ type: 'show', id: button.dataset.show });
    else if (button.dataset.apply) vscode.postMessage({ type: 'apply', id: button.dataset.apply });
  });
</script>
</body></html>`;
}

function nonce(): string {
  let text = '';
  for (let i = 0; i < 32; i++) text += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 62));
  return text;
}
