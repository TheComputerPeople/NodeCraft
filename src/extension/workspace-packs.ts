// Declarative language packs in the workspace (Tier 3, docs/language-breadth.md): every
// `*.vgraph-language.json` file is loaded as a pack, and reloaded when it changes. A definition's
// problems appear on its file in the Problems panel; a pack whose id is taken isn't loaded.
import * as vscode from 'vscode';
import { loadDeclarativePack } from '../core/declarative';
import { LanguagePackRegistry } from '../core/language-pack';

const PACK_GLOB = '**/*.vgraph-language.json';
const RELOAD_DEBOUNCE_MS = 200;

export function watchWorkspaceLanguagePacks(languages: LanguagePackRegistry, output: () => vscode.OutputChannel): vscode.Disposable {
  const problems = vscode.languages.createDiagnosticCollection('blueprint-language-packs');
  // The ids this watcher registered, so it removes only its own packs.
  let registered = new Map<string, string>();
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reload = async (): Promise<void> => {
    const current = ++generation;
    const files = await vscode.workspace.findFiles(PACK_GLOB, '**/node_modules/**', 100);
    const loaded: { uri: vscode.Uri; value?: unknown; error?: string }[] = [];
    for (const uri of files.sort((a, b) => a.toString().localeCompare(b.toString()))) {
      try {
        loaded.push({ uri, value: JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) });
      } catch (error) {
        loaded.push({ uri, error: `It isn't valid JSON: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    // A newer reload started while this one was reading; its result wins.
    if (current !== generation) return;
    for (const id of registered.values()) languages.unregister(id);
    const next = new Map<string, string>();
    problems.clear();
    for (const { uri, value, error } of loaded) {
      const result = error ? { problems: [error] } : loadDeclarativePack(value);
      const pack = result.pack;
      const found = [...result.problems];
      if (pack && languages.get(pack.id)) found.push(`A language pack with the id "${pack.id}" is already registered.`);
      if (found.length || !pack) {
        problems.set(uri, found.map((message) => new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, vscode.DiagnosticSeverity.Error)));
        output().appendLine(`[error] ${vscode.workspace.asRelativePath(uri)} isn't loaded as a language pack:\n${found.map((p) => `  - ${p}`).join('\n')}`);
        continue;
      }
      languages.register(pack);
      next.set(uri.toString(), pack.id);
    }
    registered = next;
  };
  const scheduleReload = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS);
  };

  const watcher = vscode.workspace.createFileSystemWatcher(PACK_GLOB);
  const subscriptions = [
    problems,
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
    for (const id of registered.values()) languages.unregister(id);
    subscriptions.forEach((s) => s.dispose());
  });
}
