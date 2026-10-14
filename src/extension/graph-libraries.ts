// Finds the workspace's function and macro libraries (.vgraph files of kind "functionLibrary" or
// "macroLibrary") and turns their functions and macros into nodes (src/core/libraries.ts), keeping
// the registry up to date as library files change. Graphs call library functions through the
// libraries' generated files; library macros are expanded where they are used.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguagePackRegistry } from '../core/language-pack';
import { libraryDefinitions, macroLibraryDefinitions } from '../core/libraries';
import { GraphDocument, NodeDefinition } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { parseDocument } from '../core/serializer';
import { csharpNamespace, pythonModule } from './placement';

const GLOB = '**/*.vgraph';
const EXCLUDE = '**/{node_modules,.git,.venv,venv,dist,out,build,bin,obj}/**';
const MAX_FILES = 5000;
const RELOAD_DEBOUNCE_MS = 300;
const SOURCE = 'graph-libraries';

interface LibraryFile {
  path: string;
  definitions: NodeDefinition[];
}

export class GraphLibraries implements vscode.Disposable {
  private readonly files = new Map<string, LibraryFile>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly changed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private readyResolve!: () => void;
  // Resolves after the first full scan.
  readonly ready = new Promise<void>((resolve) => (this.readyResolve = resolve));

  constructor(private readonly registry: NodeRegistry, private readonly languages: LanguagePackRegistry) {
    const watcher = vscode.workspace.createFileSystemWatcher(GLOB);
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => this.queue(uri)),
      watcher.onDidChange((uri) => this.queue(uri)),
      watcher.onDidDelete((uri) => this.queue(uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rescan())
    );
    void this.rescan().then(() => this.readyResolve());
  }

  async rescan(): Promise<void> {
    const generation = ++this.generation;
    const uris = await vscode.workspace.findFiles(GLOB, EXCLUDE, MAX_FILES);
    const scanned = await Promise.all(uris.map((uri) => this.scan(uri)));
    if (generation !== this.generation) return;
    this.files.clear();
    uris.forEach((uri, i) => {
      const result = scanned[i];
      if (result) this.files.set(uri.toString(), result);
    });
    this.publish();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.generation++;
    this.subscriptions.forEach((s) => s.dispose());
  }

  private queue(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') return;
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

  // The library's nodes, or undefined when the file isn't a library.
  private async scan(uri: vscode.Uri): Promise<LibraryFile | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (uri.scheme !== 'file' || !folder) return undefined;
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
    // Most graphs are classes; skip parsing them.
    if (!text.includes('functionLibrary') && !text.includes('macroLibrary')) return undefined;
    let doc: GraphDocument;
    try {
      doc = parseDocument(text, path.basename(uri.fsPath, '.vgraph')).document;
    } catch {
      return undefined;
    }
    const root = folder.uri.fsPath;
    if (doc.kind === 'macroLibrary') return { path: relative(root, uri.fsPath), definitions: macroLibraryDefinitions(doc, relative(root, uri.fsPath)) };
    const generator = doc.language ? this.languages.get(doc.language)?.generator : undefined;
    if (doc.kind !== 'functionLibrary' || !generator) return undefined;
    const dir = path.dirname(uri.fsPath);
    const generated = path.join(dir, generator.outputFileName(path.basename(uri.fsPath)));
    const functions = doc.graphs.filter((g) => g.kind === 'function').map((g) => ({ id: g.id, name: g.name }));
    const definitions = libraryDefinitions(doc, {
      documentPath: relative(root, uri.fsPath),
      generatedPath: relative(root, generated),
      exports: generator.libraryExports(doc.name, functions),
      module: doc.language === 'python' ? pythonModule(generated, root).module : doc.language === 'csharp' ? csharpNamespace(dir, root) : undefined
    });
    return { path: relative(root, uri.fsPath), definitions };
  }

  private publish(): void {
    const files = [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.registry.setSource(SOURCE, files.flatMap((f) => f.definitions));
  }
}

// Reads a graph file for Simulate, preferring an open editor's unsaved text. `documentPath` is
// relative to the workspace folder of `from`.
export function loadGraphDocument(from: vscode.Uri, documentPath: string): GraphDocument | undefined {
  const root = vscode.workspace.getWorkspaceFolder(from)?.uri.fsPath;
  if (!root) return undefined;
  const file = path.join(root, ...documentPath.split('/'));
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === path.resolve(file));
  try {
    const text = open ? open.getText() : fs.readFileSync(file, 'utf8');
    return parseDocument(text, path.basename(file, '.vgraph')).document;
  } catch {
    return undefined;
  }
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
