// Finds the project functions exposed as nodes (docs/code-as-nodes.md) and keeps the registry up to
// date as source files change, the exposeAll setting changes, or workspace folders come and go.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SkippedFunction, exposeFunctions } from '../core/importing/symbols';
import { LanguagePack, LanguagePackRegistry } from '../core/language-pack';
import { NodeDefinition } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { pythonModule } from './placement';

// Build output, dependencies and virtual environments hold no project functions.
const EXCLUDE = '**/{node_modules,.git,.venv,venv,env,__pycache__,site-packages,dist,out,build,.tox}/**';
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1_000_000;
const RELOAD_DEBOUNCE_MS = 300;
// Generated files: classes, never project functions.
const GENERATED = /(\.vgraph\.[cm]?[jt]s|_vgraph\.py)$/i;
const SOURCE = 'functions';

interface FileFunctions {
  definitions: NodeDefinition[];
  // Workspace-relative path, for messages.
  path: string;
  skipped: SkippedFunction[];
}

export class ProjectFunctions implements vscode.Disposable {
  private readonly files = new Map<string, FileFunctions>();
  private readonly packs = new Map<string, LanguagePack>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly changed = new Set<string>();
  private readonly glob: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private lastReport = '';
  private readyResolve!: () => void;
  // Resolves after the first full scan.
  readonly ready = new Promise<void>((resolve) => (this.readyResolve = resolve));

  constructor(private readonly registry: NodeRegistry, languages: LanguagePackRegistry, private readonly output: () => vscode.OutputChannel) {
    for (const pack of languages.all()) for (const ext of pack.importer?.extensions ?? []) this.packs.set(ext, pack);
    this.glob = `**/*{${[...this.packs.keys()].join(',')}}`;

    const watcher = vscode.workspace.createFileSystemWatcher(this.glob);
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => this.queue(uri)),
      watcher.onDidChange((uri) => this.queue(uri)),
      watcher.onDidDelete((uri) => this.queue(uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rescan()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('blueprintVisualScripting.exposeAllFunctions')) void this.rescan();
      })
    );
    void this.rescan().then(() => this.readyResolve());
  }

  // Scans every source file in the workspace.
  async rescan(): Promise<void> {
    const generation = ++this.generation;
    const uris = (await vscode.workspace.findFiles(this.glob, EXCLUDE, MAX_FILES)).filter((uri) => this.packFor(uri));
    const results = new Map<string, FileFunctions>();
    for (let i = 0; i < uris.length; i += 50) {
      const batch = uris.slice(i, i + 50);
      const scanned = await Promise.all(batch.map((uri) => this.scan(uri)));
      batch.forEach((uri, j) => {
        const result = scanned[j];
        if (result) results.set(uri.toString(), result);
      });
    }
    // A newer scan started meanwhile; its result wins.
    if (generation !== this.generation) return;
    this.files.clear();
    for (const [key, value] of results) this.files.set(key, value);
    this.publish();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.generation++;
    this.subscriptions.forEach((s) => s.dispose());
  }

  private queue(uri: vscode.Uri): void {
    if (!this.packFor(uri)) return;
    this.changed.add(uri.toString());
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), RELOAD_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    const keys = [...this.changed];
    this.changed.clear();
    const generation = this.generation;
    const results = await Promise.all(keys.map((key) => this.scan(vscode.Uri.parse(key))));
    if (generation !== this.generation) return;
    keys.forEach((key, i) => {
      const result = results[i];
      if (result) this.files.set(key, result);
      else this.files.delete(key);
    });
    this.publish();
  }

  // The file's functions, or undefined when it has none (or is gone, too big or excluded).
  private async scan(uri: vscode.Uri): Promise<FileFunctions | undefined> {
    const pack = this.packFor(uri);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!pack?.importer || !folder || isExcluded(uri, folder)) return undefined;
    let text: string;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) return undefined;
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
    const exposeAll = vscode.workspace.getConfiguration('blueprintVisualScripting', uri).get<boolean>('exposeAllFunctions', false);
    // Most files mark nothing; skip parsing them.
    if (!exposeAll && !text.includes('@blueprint')) return undefined;
    const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    const module = pack.id === 'python' ? pythonModule(uri.fsPath, folder.uri.fsPath).module : undefined;
    const exposed = exposeFunctions(pack.importer.scan(text), { language: pack.id, path: relative, module, exposeAll });
    if (!exposed.definitions.length && !exposed.skipped.length) return undefined;
    return { definitions: exposed.definitions, path: relative, skipped: exposed.skipped };
  }

  private packFor(uri: vscode.Uri): LanguagePack | undefined {
    const name = path.basename(uri.path);
    if (uri.scheme !== 'file' || GENERATED.test(name) || /\.d\.[cm]?ts$/i.test(name)) return undefined;
    return this.packs.get(path.extname(name).toLowerCase());
  }

  private publish(): void {
    const files = [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.registry.setSource(SOURCE, files.flatMap((f) => f.definitions));
    this.report(files);
  }

  // Tells the user, once per change, which marked functions couldn't become nodes and why.
  private report(files: FileFunctions[]): void {
    const lines = files.flatMap((f) => f.skipped.map((s) => `  ${f.path}:${s.line} ${s.name}: ${s.reason}`));
    const count = files.reduce((n, f) => n + f.definitions.length, 0);
    const text = lines.length ? [`Project functions: ${count} node${count === 1 ? '' : 's'}. These functions can't be nodes:`, ...lines].join('\n') : '';
    if (text === this.lastReport) return;
    this.lastReport = text;
    if (text) this.output().appendLine(text);
  }
}

function isExcluded(uri: vscode.Uri, folder: vscode.WorkspaceFolder): boolean {
  const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep);
  return relative.some((part) => ['node_modules', '.git', '.venv', 'venv', 'env', '__pycache__', 'site-packages', 'dist', 'out', 'build', '.tox'].includes(part));
}
