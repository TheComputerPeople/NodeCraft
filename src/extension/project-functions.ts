// Finds the project functions exposed as nodes (docs/code-as-nodes.md) and keeps the registry up to
// date as source files change, the exposeAll setting changes, or workspace folders come and go.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { NO_SIGNATURE, SymbolFunction, scanSymbols } from '../core/importing/language-server';
import { ModuleScan, SkippedFunction, exposeFunctions } from '../core/importing/symbols';
import { LanguagePack, LanguagePackRegistry, LanguageServerImport } from '../core/language-pack';
import { NodeDefinition } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { goPackage, pythonModule, rustModule } from './placement';

// Build output, dependencies and virtual environments hold no project functions.
const EXCLUDE = '**/{node_modules,.git,.venv,venv,env,__pycache__,site-packages,dist,out,build,.tox,bin,obj}/**';
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1_000_000;
const RELOAD_DEBOUNCE_MS = 300;
// A language server with no symbols (or signatures) yet for a marked file may still be starting: it's asked again,
// waiting twice as long each time (about a minute in all).
const LANGUAGE_SERVER_RETRIES = 7;
const LANGUAGE_SERVER_RETRY_MS = 1000;
const LANGUAGE_SERVER_RETRY_MAX_MS = 15000;
// Generated files: classes, never project functions.
const GENERATED = /(\.vgraph\.([cm]?[jt]s|cs|php)|_vgraph\.(py|go|lua|gd|rb)|^vgraph_runtime\.(go|lua|gd|rb|php))$/i;
const SOURCE = 'functions';

interface FileFunctions {
  definitions: NodeDefinition[];
  // Workspace-relative path, for messages.
  path: string;
  skipped: SkippedFunction[];
}

export class ProjectFunctions implements vscode.Disposable {
  private readonly files = new Map<string, FileFunctions>();
  // The packs that read each file extension (C and C++ both read headers).
  private readonly packs = new Map<string, LanguagePack[]>();
  private readonly retries = new Map<string, number>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly changed = new Set<string>();
  private glob = '';
  private watcher: vscode.FileSystemWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private lastReport = '';
  private readyResolve!: () => void;
  // Whether the first full scan has finished, so a function that isn't found is really gone.
  loaded = false;
  // Resolves after the first full scan.
  readonly ready = new Promise<void>((resolve) => (this.readyResolve = resolve));

  constructor(private readonly registry: NodeRegistry, private readonly languages: LanguagePackRegistry, private readonly output: () => vscode.OutputChannel) {
    this.watchSources();
    this.subscriptions.push(
      { dispose: () => this.watcher?.dispose() },
      // A pack registered or removed (through the API) may read other source files.
      languages.onDidChange(() => {
        this.watchSources();
        void this.rescan();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rescan()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('blueprintVisualScripting.exposeAllFunctions')) void this.rescan();
      })
    );
    void this.rescan().then(() => this.readyResolve());
  }

  // Which packs read which source files, and a watcher for those files.
  private watchSources(): void {
    this.packs.clear();
    for (const pack of this.languages.all()) for (const ext of pack.importer?.extensions ?? []) this.packs.set(ext, [...(this.packs.get(ext) ?? []), pack]);
    this.glob = `**/*{${[...this.packs.keys()].join(',')}}`;
    this.watcher?.dispose();
    const watcher = vscode.workspace.createFileSystemWatcher(this.glob);
    watcher.onDidCreate((uri) => this.queue(uri));
    watcher.onDidChange((uri) => this.queue(uri));
    watcher.onDidDelete((uri) => this.queue(uri));
    this.watcher = watcher;
  }

  // Scans every source file in the workspace.
  async rescan(): Promise<void> {
    const generation = ++this.generation;
    const uris = (await vscode.workspace.findFiles(this.glob, EXCLUDE, MAX_FILES)).filter((uri) => this.packsFor(uri).length);
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
    this.loaded = true;
    this.publish();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.generation++;
    this.subscriptions.forEach((s) => s.dispose());
  }

  private queue(uri: vscode.Uri): void {
    if (!this.packsFor(uri).length) return;
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
    const packs = this.packsFor(uri);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!packs.length || !folder || isExcluded(uri, folder)) return undefined;
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
    const definitions: NodeDefinition[] = [];
    const skipped: SkippedFunction[] = [];
    for (const pack of packs) {
      const importer = pack.importer!;
      const scan = importer.scan ? importer.scan(text) : importer.languageServer ? await this.symbolScan(uri, text, importer.languageServer, pack, exposeAll) : undefined;
      if (!scan) continue;
      const module = pack.id === 'python' ? pythonModule(uri.fsPath, folder.uri.fsPath).module
        : pack.id === 'rust' ? rustModule(uri.fsPath, folder.uri.fsPath)
        : pack.id === 'go' ? goPackage(path.dirname(uri.fsPath), folder.uri.fsPath).path : undefined;
      const exposed = exposeFunctions(scan, { language: pack.id, path: relative, module, exposeAll });
      definitions.push(...exposed.definitions);
      skipped.push(...exposed.skipped);
    }
    if (!definitions.length && !skipped.length) return undefined;
    return { definitions, path: relative, skipped };
  }

  // Tier 2 (docs/language-breadth.md): the functions the language server reports, with their hovers.
  private async symbolScan(uri: vscode.Uri, text: string, spec: LanguageServerImport, pack: LanguagePack, exposeAll: boolean): Promise<ModuleScan | undefined> {
    let symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri);
    } catch {
      symbols = undefined;
    }
    if (!symbols?.length) {
      this.retryLater(uri);
      return undefined;
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const functions = collectFunctions(symbols);
    // Only marked functions are asked about, unless every function is exposed.
    const wanted = functions.filter((f) => exposeAll || lines.slice(Math.max(0, f.nameLine - 30), f.nameLine).some((l) => l.includes('@blueprint')));
    if (!wanted.length) return undefined;
    for (const fn of wanted) {
      try {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, fn.position);
        fn.hover = (hovers ?? []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : 'language' in c ? `\`\`\`${c.language}\n${c.value}\n\`\`\`` : c.value))).join('\n');
      } catch {
        // No hover: the function is reported as having no signature.
      }
    }
    const scan = scanSymbols(text, wanted, spec, (type) => pack.mapType(type));
    // A server that is still loading answers hovers without the signature.
    if (scan.skipped.some((s) => s.reason === NO_SIGNATURE)) this.retryLater(uri);
    else this.retries.delete(uri.toString());
    return scan;
  }

  // The file's functions aren't known yet (its language server may be starting): asked again soon.
  private retryLater(uri: vscode.Uri): void {
    const key = uri.toString();
    const count = this.retries.get(key) ?? 0;
    if (count >= LANGUAGE_SERVER_RETRIES) return;
    this.retries.set(key, count + 1);
    setTimeout(() => this.queue(uri), Math.min(LANGUAGE_SERVER_RETRY_MS * 2 ** count, LANGUAGE_SERVER_RETRY_MAX_MS));
  }

  private packsFor(uri: vscode.Uri): LanguagePack[] {
    const name = path.basename(uri.path);
    if (uri.scheme !== 'file' || GENERATED.test(name) || /\.d\.[cm]?ts$/i.test(name)) return [];
    return this.packs.get(path.extname(name).toLowerCase()) ?? [];
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

// The functions among the document's symbols: at the top level, or in namespaces and modules.
function collectFunctions(symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): (SymbolFunction & { position: vscode.Position })[] {
  const found: (SymbolFunction & { position: vscode.Position })[] = [];
  const walk = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[], containers: string[]) => {
    for (const s of list) {
      if ('children' in s) {
        if (s.kind === vscode.SymbolKind.Function) found.push({ name: s.name, line: s.range.start.line, nameLine: s.selectionRange.start.line, containers, position: s.selectionRange.start });
        else if ([vscode.SymbolKind.Namespace, vscode.SymbolKind.Module, vscode.SymbolKind.Package].includes(s.kind)) walk(s.children, [...containers, s.name]);
      } else if (s.kind === vscode.SymbolKind.Function) {
        const start = s.location.range.start;
        found.push({ name: s.name, line: start.line, nameLine: start.line, containers: s.containerName ? [s.containerName] : [], position: start });
      }
    }
  };
  walk(symbols, []);
  return found;
}

function isExcluded(uri: vscode.Uri, folder: vscode.WorkspaceFolder): boolean {
  const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep);
  return relative.some((part) => ['node_modules', '.git', '.venv', 'venv', 'env', '__pycache__', 'site-packages', 'dist', 'out', 'build', '.tox', 'bin', 'obj'].includes(part));
}
