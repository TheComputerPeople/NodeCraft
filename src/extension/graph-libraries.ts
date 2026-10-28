// Finds the workspace's function and macro libraries (.vgraph files of kind "functionLibrary" or
// "macroLibrary") and turns their functions and macros into nodes (src/core/libraries.ts), keeping
// the registry up to date as library files change. Graphs call library functions through the
// libraries' generated files; library macros are expanded where they are used.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguagePackRegistry } from '../core/language-pack';
import { GraphDocument, NodeDefinition } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { parseDocument } from '../core/serializer';
import { graphFileDefinitions } from '../core/graph-files';
import { duplicateTypes, typeLanguages } from '../core/user-types';
import { csharpNamespace, goPackage, javaProject, phpNamespace, pythonModule } from './placement';

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
  private readonly problems = vscode.languages.createDiagnosticCollection('blueprint-types');
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
      this.problems,
      watcher.onDidCreate((uri) => this.queue(uri)),
      watcher.onDidChange((uri) => this.queue(uri)),
      watcher.onDidDelete((uri) => this.queue(uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rescan()),
      // A pack registered or removed changes which libraries generate code, and their names.
      languages.onDidChange(() => void this.rescan())
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
    if (!/"kind":\s*"(class|functionLibrary|macroLibrary|structure|enumeration|interface)"/.test(text)) return undefined;
    let doc: GraphDocument;
    try {
      doc = parseDocument(text, path.basename(uri.fsPath, '.vgraph')).document;
    } catch {
      return undefined;
    }
    const root = folder.uri.fsPath;
    const dir = path.dirname(uri.fsPath);
    // Where a language generates this file, and the module other code imports it as.
    const output = (language: string | undefined): { generatedPath: string; module?: string } | undefined => {
      const generator = language ? this.languages.get(language)?.generator : undefined;
      if (!generator) return undefined;
      const generated = path.join(dir, generator.outputFileName(path.basename(uri.fsPath)));
      const module = language === 'python' ? pythonModule(generated, root).module : language === 'csharp' ? csharpNamespace(dir, root) : language === 'java' ? javaProject(dir, root).package : language === 'go' ? goPackage(dir, root).path ?? goPackage(dir, root).name : language === 'php' ? phpNamespace(dir, root) : undefined;
      return { generatedPath: relative(root, generated), ...(module ? { module } : {}) };
    };
    const generator = doc.language ? this.languages.get(doc.language)?.generator : undefined;
    const own = output(doc.language) ?? { generatedPath: relative(root, uri.fsPath) };
    // A shared struct or enum is generated for its other languages too (docs/multi-language.md).
    const others = Object.fromEntries(typeLanguages(doc).slice(1).flatMap((language) => {
      const other = output(language);
      return other ? [[language, other]] : [];
    }));
    const definitions = graphFileDefinitions(doc, { document: relative(root, uri.fsPath), ...own, ...(Object.keys(others).length ? { others } : {}) }, generator);
    return definitions && { path: relative(root, uri.fsPath), definitions };
  }

  private publish(): void {
    const files = [...this.files].map(([key, file]) => ({ key, ...file })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.registry.setSource(SOURCE, files.flatMap((f) => f.definitions));
    // A type name declared twice: the registry keeps one, and the other files say so.
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const { file, message } of duplicateTypes(files)) {
      const problem = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, vscode.DiagnosticSeverity.Error);
      problem.source = 'Blueprint';
      problem.code = 'duplicate-type';
      byFile.set(file.key, [...(byFile.get(file.key) ?? []), problem]);
    }
    this.problems.clear();
    for (const [key, problems] of byFile) this.problems.set(vscode.Uri.parse(key), problems);
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
