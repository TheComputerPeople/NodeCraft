// The Codebase Map's index of each workspace folder (docs/codebase-map.md, Part 1), kept up to date:
// built on first use in the parsing worker, cached in the workspace's storage by each file's content,
// and rebuilt (reading only what changed) when files change. Parsing runs nothing from the project,
// so it works in Restricted Mode.
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeIndex } from '../core/codemap/code-index';
import { grammarForFile } from '../core/parsing/grammars';
import { IndexResult, JsonFactsCache, factsVersion, indexFolder } from './code-indexer';
import { ParseService } from './parse-service';
import { globToRegExp } from './placement';
import { scanLimit } from './scan-limit';

// After a change, the index is rebuilt once things have been quiet this long.
const REBUILD_DELAY_MS = 750;

export class CodeMapService implements vscode.Disposable {
  private parser: ParseService | undefined;
  private readonly indexes = new Map<string, Promise<IndexResult>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly changed = new vscode.EventEmitter<vscode.WorkspaceFolder>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private readonly warned = new Set<string>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Only folders already indexed are followed: nothing is parsed until the map is used.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const touched = (uri: vscode.Uri): void => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder || !this.indexes.has(folder.uri.toString())) return;
      if (!grammarForFile(uri.fsPath) && !uri.fsPath.endsWith('.vgraph') && path.extname(uri.fsPath) !== '') return;
      this.schedule(folder);
    };
    watcher.onDidChange(touched, undefined, this.disposables);
    watcher.onDidCreate(touched, undefined, this.disposables);
    watcher.onDidDelete(touched, undefined, this.disposables);
    this.disposables.push(watcher);
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.removed) this.indexes.delete(folder.uri.toString());
    }, undefined, this.disposables);
  }

  private grammarDir(): string {
    return path.join(this.context.extensionPath, 'grammars');
  }

  // The folder's index, built the first time it's asked for.
  index(folder: vscode.WorkspaceFolder): Promise<IndexResult> {
    const key = folder.uri.toString();
    let built = this.indexes.get(key);
    if (!built) {
      built = this.build(folder);
      this.indexes.set(key, built);
      // A failed build is tried again next time.
      built.catch(() => this.indexes.get(key) === built && this.indexes.delete(key));
    }
    return built;
  }

  async codeIndex(folder: vscode.WorkspaceFolder): Promise<CodeIndex> {
    return (await this.index(folder)).index;
  }

  private schedule(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      const rebuilt = this.build(folder);
      // Until the new index is ready, the old one answers.
      void rebuilt.then(() => {
        this.indexes.set(key, rebuilt);
        this.changed.fire(folder);
      }, () => undefined);
    }, REBUILD_DELAY_MS));
  }

  private async build(folder: vscode.WorkspaceFolder): Promise<IndexResult> {
    this.parser ??= new ParseService(this.grammarDir());
    const storage = this.context.storageUri ?? this.context.globalStorageUri;
    const id = crypto.createHash('sha1').update(folder.uri.toString()).digest('hex').slice(0, 12);
    const cache = new JsonFactsCache(path.join(storage.fsPath, `codemap-${id}.json`), factsVersion(this.grammarDir()));
    const excludes = Object.entries(vscode.workspace.getConfiguration('files', folder.uri).get<Record<string, boolean>>('exclude', {}))
      .filter(([, on]) => on === true).map(([pattern]) => globToRegExp(pattern, true));
    const limit = scanLimit();
    const result = await indexFolder(folder.uri.fsPath, { parser: this.parser, cache, limit, exclude: (p) => excludes.some((re) => re.test(p)) });
    cache.pruneUnused();
    cache.save();
    if (result.skipped && !this.warned.has(folder.uri.toString())) {
      this.warned.add(folder.uri.toString());
      const open = 'Open Settings';
      void vscode.window.showWarningMessage(`The Codebase Map read the first ${limit} source files of ${folder.name} and left out ${result.skipped}. Raise blueprintVisualScripting.scanLimit to map them all.`, open)
        .then((choice) => choice && vscode.commands.executeCommand('workbench.action.openSettings', 'blueprintVisualScripting.scanLimit'));
    }
    return result;
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.disposables.forEach((d) => d.dispose());
    void this.parser?.dispose();
  }
}
