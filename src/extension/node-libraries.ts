import * as vscode from 'vscode';
import { NodeDefinition } from '../core/model';
import { NodeRegistry, parseNodeDefinition } from '../core/registry';

const NODE_LIBRARY_GLOB = '**/*.node.json';
const RELOAD_DEBOUNCE_MS = 200;

export async function readWorkspaceNodeLibraries(): Promise<NodeDefinition[]> {
  const files = await vscode.workspace.findFiles(NODE_LIBRARY_GLOB, '**/node_modules/**', 500);
  const definitions: NodeDefinition[] = [];
  for (const file of files) {
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      const def = parseNodeDefinition(new TextDecoder().decode(bytes));
      if (def) definitions.push(def);
    } catch {
      // Invalid library files are ignored; the editor remains usable.
    }
  }
  return definitions;
}

// Loads workspace node libraries now and reloads them whenever a library file or the set of
// workspace folders changes.
export function watchWorkspaceNodeLibraries(registry: NodeRegistry): vscode.Disposable {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reload = async (): Promise<void> => {
    const current = ++generation;
    const definitions = await readWorkspaceNodeLibraries();
    // A newer reload started while this one was reading; its result wins.
    if (current === generation) registry.replaceWorkspaceDefinitions(definitions);
  };
  const scheduleReload = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS);
  };

  const watcher = vscode.workspace.createFileSystemWatcher(NODE_LIBRARY_GLOB);
  const subscriptions = [
    watcher,
    watcher.onDidCreate(scheduleReload),
    watcher.onDidChange(scheduleReload),
    watcher.onDidDelete(scheduleReload),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleReload)
  ];
  void reload();

  return new vscode.Disposable(() => {
    clearTimeout(timer);
    generation++;
    subscriptions.forEach((s) => s.dispose());
  });
}
