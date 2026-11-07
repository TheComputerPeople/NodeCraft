// Node libraries (docs/language-breadth.md, "Node library versioning"): loose `*.node.json` files,
// packages (`*.vgraph-package.json` manifests listing their node files) and libraries other
// extensions register, resolved together into the registry. Package problems (a missing dependency,
// a node type defined twice) are warnings on the manifest in the Problems panel; the nodes still load.
import * as vscode from 'vscode';
import { API_VERSION, NodeLibrary } from '../core/api';
import { LanguagePackRegistry } from '../core/language-pack';
import { NodeDefinition } from '../core/model';
import { SnippetLanguage, nodeFileProblems } from '../core/node-files';
import { NodePackage, NodePackageManifest, manifestProblems, resolvePackages } from '../core/node-packages';
import { NodeRegistry, parseNodeDefinition } from '../core/registry';
import { findFilesLimited } from './scan-limit';

const NODE_LIBRARY_GLOB = '**/*.node.json';
const PACKAGE_GLOB = '**/*.vgraph-package.json';
const GRAPH_GLOB = '**/*.vgraph';
const EXCLUDE = '**/node_modules/**';
const RELOAD_DEBOUNCE_MS = 200;

export class NodeLibraries implements vscode.Disposable {
  private readonly problems = vscode.languages.createDiagnosticCollection('blueprint-node-packages');
  // Problems in node files while they're edited (docs/node-authoring.md, gap 8).
  private readonly fileProblems = vscode.languages.createDiagnosticCollection('blueprint-node-files');
  // Every node file read, with its text, for those problems.
  private nodeFiles: { uri: vscode.Uri; text: string; def: NodeDefinition }[] = [];
  private languagesTimer: ReturnType<typeof setTimeout> | undefined;
  // The package each graph file a manifest lists belongs to (docs/node-authoring.md, gap 9).
  private graphPackages = new Map<string, { name: string; version: string }>();
  private readonly graphPackagesChanged = new vscode.EventEmitter<void>();
  // Fires when the graph files packages list, or their versions, change.
  readonly onDidChangeGraphPackages = this.graphPackagesChanged.event;
  private readonly api = new Map<string, NodePackage>();
  private workspace: { packages: NodePackage[]; loose: NodeDefinition[]; manifestProblems: Map<string, string[]> } = { packages: [], loose: [], manifestProblems: new Map() };
  private readonly subscriptions: vscode.Disposable[] = [];
  // The file each node type was read from, for Go to Definition.
  private files = new Map<string, vscode.Uri>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly registry: NodeRegistry, private readonly languages?: LanguagePackRegistry) {
    const nodes = vscode.workspace.createFileSystemWatcher(NODE_LIBRARY_GLOB);
    const packages = vscode.workspace.createFileSystemWatcher(PACKAGE_GLOB);
    const graphs = vscode.workspace.createFileSystemWatcher(GRAPH_GLOB);
    const schedule = () => this.scheduleReload();
    // A graph's language decides which snippets the workspace needs.
    const checkLanguages = () => {
      clearTimeout(this.languagesTimer);
      this.languagesTimer = setTimeout(() => void this.checkFiles(), 1000);
    };
    this.subscriptions.push(
      this.problems, this.fileProblems, this.graphPackagesChanged, nodes, packages, graphs,
      graphs.onDidCreate(checkLanguages), graphs.onDidChange(checkLanguages), graphs.onDidDelete(checkLanguages),
      nodes.onDidCreate(schedule), nodes.onDidChange(schedule), nodes.onDidDelete(schedule),
      packages.onDidCreate(schedule), packages.onDidChange(schedule), packages.onDidDelete(schedule),
      vscode.workspace.onDidChangeWorkspaceFolders(schedule)
    );
    void this.reload();
  }

  // A library another extension registers (the API's registerNodeLibrary).
  register(library: NodeLibrary): vscode.Disposable {
    if (!library?.name || typeof library.version !== 'string' || !Array.isArray(library.nodes)) throw new Error('A node library needs a name, a version and a list of nodes.');
    if (this.api.has(library.name)) throw new Error(`A node library named "${library.name}" is already registered.`);
    this.api.set(library.name, { name: library.name, version: library.version, nodes: library.nodes, ...(library.dependencies ? { dependencies: library.dependencies } : {}), ...(library.engines ? { engines: library.engines } : {}), origin: 'extension' });
    this.publish();
    return new vscode.Disposable(() => {
      this.api.delete(library.name);
      this.publish();
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.languagesTimer);
    this.generation++;
    this.subscriptions.forEach((s) => s.dispose());
  }

  private scheduleReload(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reload(), RELOAD_DEBOUNCE_MS);
  }

  // The *.node.json file a node type was read from.
  locate(type: string): vscode.Uri | undefined {
    return this.files.get(type);
  }

  // The package a graph file belongs to, when a manifest lists it.
  packageOfGraph(uri: vscode.Uri): { name: string; version: string } | undefined {
    return this.graphPackages.get(uri.toString());
  }

  private async reload(): Promise<void> {
    const current = ++this.generation;
    const files = new Map<string, vscode.Uri>();
    const nodeFiles: NodeLibraries['nodeFiles'] = [];
    const read = async (file: vscode.Uri): Promise<NodeDefinition | undefined> => {
      let text: string;
      try {
        text = await readText(file);
      } catch {
        return undefined;
      }
      const def = parseDefinition(text);
      if (def) {
        files.set(def.type, file);
        nodeFiles.push({ uri: file, text, def });
      }
      return def;
    };
    const packages: NodePackage[] = [];
    const manifestProblemsByFile = new Map<string, string[]>();
    const claimed = new Set<string>();
    const graphPackages = new Map<string, { name: string; version: string }>();
    for (const manifestUri of await findFilesLimited(PACKAGE_GLOB, EXCLUDE, 'package manifests')) {
      let manifest: NodePackageManifest;
      try {
        manifest = JSON.parse(await readText(manifestUri)) as NodePackageManifest;
      } catch (error) {
        manifestProblemsByFile.set(manifestUri.toString(), [`It isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
        continue;
      }
      const problems = manifestProblems(manifest);
      if (problems.length) {
        manifestProblemsByFile.set(manifestUri.toString(), problems);
        continue;
      }
      const folder = vscode.Uri.joinPath(manifestUri, '..');
      const nodes: NodeDefinition[] = [];
      const missing: string[] = [];
      for (const entry of manifest.nodes ?? []) {
        const files = await findFilesLimited(new vscode.RelativePattern(folder, entry), EXCLUDE, "packages' node files");
        if (!files.length) missing.push(`"${entry}" matches no node definition file.`);
        for (const file of files) {
          claimed.add(file.toString());
          const def = await read(file);
          if (def) nodes.push(def);
        }
      }
      for (const entry of manifest.graphs ?? []) {
        const files = await findFilesLimited(new vscode.RelativePattern(folder, entry), EXCLUDE, "packages' graph files");
        if (!files.length) missing.push(`"${entry}" matches no graph file.`);
        for (const file of files) graphPackages.set(file.toString(), { name: manifest.name, version: manifest.version });
      }
      if (missing.length) manifestProblemsByFile.set(manifestUri.toString(), missing);
      packages.push({
        name: manifest.name, version: manifest.version, nodes, origin: manifestUri.toString(), where: vscode.workspace.asRelativePath(manifestUri),
        ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}), ...(manifest.engines ? { engines: manifest.engines } : {})
      });
    }
    // Node files no package holds load on their own, as before packages.
    const loose: NodeDefinition[] = [];
    for (const file of await findFilesLimited(NODE_LIBRARY_GLOB, EXCLUDE, 'node files')) {
      if (claimed.has(file.toString())) continue;
      const def = await read(file);
      if (def) loose.push(def);
    }
    // A newer reload started while this one was reading; its result wins.
    if (current !== this.generation) return;
    this.files = files;
    this.nodeFiles = nodeFiles;
    this.workspace = { packages, loose, manifestProblems: manifestProblemsByFile };
    const graphsChanged = JSON.stringify([...graphPackages]) !== JSON.stringify([...this.graphPackages]);
    this.graphPackages = graphPackages;
    this.publish();
    if (graphsChanged) this.graphPackagesChanged.fire();
  }

  private publish(): void {
    const { definitions, problems } = resolvePackages([...this.workspace.packages, ...this.api.values()], this.workspace.loose, API_VERSION);
    this.registry.setSource('libraries', definitions);
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const add = (key: string, message: string, severity: vscode.DiagnosticSeverity) => byFile.set(key, [...(byFile.get(key) ?? []), new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, severity)]);
    for (const [key, messages] of this.workspace.manifestProblems) for (const message of messages) add(key, message, vscode.DiagnosticSeverity.Error);
    for (const problem of problems) if (problem.origin !== 'extension') add(problem.origin, problem.message, vscode.DiagnosticSeverity.Warning);
    this.problems.clear();
    for (const [key, diagnostics] of byFile) this.problems.set(vscode.Uri.parse(key), diagnostics);
    void this.checkFiles();
  }

  // Each node file's problems: snippets using inputs it doesn't have, languages the workspace's
  // graphs use that it has no snippet for, and a type another file defines too.
  private async checkFiles(): Promise<void> {
    const languages = this.languages ? await workspaceSnippetLanguages(this.languages) : [];
    const byType = new Map<string, vscode.Uri[]>();
    for (const file of this.nodeFiles) byType.set(file.def.type, [...(byType.get(file.def.type) ?? []), file.uri]);
    this.fileProblems.clear();
    for (const file of this.nodeFiles) {
      const problems = nodeFileProblems(file.def, languages).map((p) => ({ ...p, severity: p.severity === 'error' ? vscode.DiagnosticSeverity.Error : p.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information }));
      const others = (byType.get(file.def.type) ?? []).filter((uri) => uri.toString() !== file.uri.toString());
      if (others.length) problems.push({ severity: vscode.DiagnosticSeverity.Warning, message: `"${file.def.type}" is also defined in ${others.map((uri) => vscode.workspace.asRelativePath(uri)).join(', ')}; only one of them is used.`, at: JSON.stringify(file.def.type) });
      if (!problems.length) continue;
      this.fileProblems.set(file.uri, problems.map((p) => {
        const offset = p.at ? Math.max(0, file.text.indexOf(p.at)) : 0;
        const start = positionAt(file.text, offset);
        const diagnostic = new vscode.Diagnostic(new vscode.Range(start, positionAt(file.text, offset + (p.at && file.text.includes(p.at) ? p.at.length : 0))), p.message, p.severity);
        diagnostic.source = 'Blueprint';
        return diagnostic;
      }));
    }
  }
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

function parseDefinition(text: string): NodeDefinition | undefined {
  try {
    return parseNodeDefinition(text);
  } catch {
    // Invalid library files are ignored; the editor remains usable (their schema shows why).
    return undefined;
  }
}

function positionAt(text: string, offset: number): vscode.Position {
  const before = text.slice(0, offset).split(/\r?\n/);
  return new vscode.Position(before.length - 1, before[before.length - 1].length);
}

// The languages of the workspace's graphs, as snippets need them (New Node writes one for each).
export async function workspaceSnippetLanguages(languages: LanguagePackRegistry): Promise<SnippetLanguage[]> {
  const ids = new Set<string>();
  for (const uri of await findFilesLimited(GRAPH_GLOB, EXCLUDE, 'graph files')) {
    try {
      const doc = JSON.parse(await readText(uri)) as { language?: string; languages?: string[] };
      if (doc.language) ids.add(doc.language);
      for (const other of doc.languages ?? []) ids.add(other);
    } catch {
      // An unreadable graph says nothing about languages.
    }
  }
  return [...ids].sort().flatMap((id) => {
    const pack = languages.get(id);
    return pack?.generator ? [{ id, displayName: pack.displayName, snippetLanguages: pack.generator.snippetLanguages, ...(pack.generator.snippets ? { snippets: pack.generator.snippets } : {}) }] : [];
  });
}
