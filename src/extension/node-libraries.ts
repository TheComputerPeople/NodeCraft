// Node libraries (docs/language-breadth.md, "Node library versioning"): loose `*.node.json` files,
// packages (`*.vgraph-package.json` manifests listing their node files) and libraries other
// extensions register, resolved together into the registry. Package problems (a missing dependency,
// a node type defined twice) are warnings on the manifest in the Problems panel; the nodes still load.
import * as vscode from 'vscode';
import { API_VERSION, NodeLibrary } from '../core/api';
import { NodeDefinition } from '../core/model';
import { NodePackage, NodePackageManifest, manifestProblems, resolvePackages } from '../core/node-packages';
import { NodeRegistry, parseNodeDefinition } from '../core/registry';

const NODE_LIBRARY_GLOB = '**/*.node.json';
const PACKAGE_GLOB = '**/*.vgraph-package.json';
const EXCLUDE = '**/node_modules/**';
const RELOAD_DEBOUNCE_MS = 200;

export class NodeLibraries implements vscode.Disposable {
  private readonly problems = vscode.languages.createDiagnosticCollection('blueprint-node-packages');
  private readonly api = new Map<string, NodePackage>();
  private workspace: { packages: NodePackage[]; loose: NodeDefinition[]; manifestProblems: Map<string, string[]> } = { packages: [], loose: [], manifestProblems: new Map() };
  private readonly subscriptions: vscode.Disposable[] = [];
  // The file each node type was read from, for Go to Definition.
  private files = new Map<string, vscode.Uri>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly registry: NodeRegistry) {
    const nodes = vscode.workspace.createFileSystemWatcher(NODE_LIBRARY_GLOB);
    const packages = vscode.workspace.createFileSystemWatcher(PACKAGE_GLOB);
    const schedule = () => this.scheduleReload();
    this.subscriptions.push(
      this.problems, nodes, packages,
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

  private async reload(): Promise<void> {
    const current = ++this.generation;
    const files = new Map<string, vscode.Uri>();
    const read = async (file: vscode.Uri): Promise<NodeDefinition | undefined> => {
      const def = await readDefinition(file);
      if (def) files.set(def.type, file);
      return def;
    };
    const packages: NodePackage[] = [];
    const manifestProblemsByFile = new Map<string, string[]>();
    const claimed = new Set<string>();
    for (const manifestUri of await vscode.workspace.findFiles(PACKAGE_GLOB, EXCLUDE, 200)) {
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
      for (const entry of manifest.nodes) {
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, entry), EXCLUDE, 1000);
        if (!files.length) missing.push(entry);
        for (const file of files) {
          claimed.add(file.toString());
          const def = await read(file);
          if (def) nodes.push(def);
        }
      }
      if (missing.length) manifestProblemsByFile.set(manifestUri.toString(), missing.map((entry) => `"${entry}" matches no node definition file.`));
      packages.push({
        name: manifest.name, version: manifest.version, nodes, origin: manifestUri.toString(), where: vscode.workspace.asRelativePath(manifestUri),
        ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}), ...(manifest.engines ? { engines: manifest.engines } : {})
      });
    }
    // Node files no package holds load on their own, as before packages.
    const loose: NodeDefinition[] = [];
    for (const file of await vscode.workspace.findFiles(NODE_LIBRARY_GLOB, EXCLUDE, 500)) {
      if (claimed.has(file.toString())) continue;
      const def = await read(file);
      if (def) loose.push(def);
    }
    // A newer reload started while this one was reading; its result wins.
    if (current !== this.generation) return;
    this.files = files;
    this.workspace = { packages, loose, manifestProblems: manifestProblemsByFile };
    this.publish();
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
  }
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function readDefinition(uri: vscode.Uri): Promise<NodeDefinition | undefined> {
  try {
    return parseNodeDefinition(await readText(uri));
  } catch {
    // Invalid library files are ignored; the editor remains usable.
    return undefined;
  }
}
