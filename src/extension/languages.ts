import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguagePack, LanguagePackRegistry } from '../core/language-pack';

// Picks the project's language from marker files (tsconfig.json, package.json, ...). Returns
// undefined when nothing matches, e.g. in an empty folder.
export async function detectWorkspaceLanguage(languages: LanguagePackRegistry): Promise<LanguagePack | undefined> {
  const markers = [...new Set(languages.all().flatMap((pack) => pack.workspaceMarkers))];
  const found = await Promise.all(markers.map(async (glob) => (await vscode.workspace.findFiles(glob, '**/node_modules/**', 1)).length > 0));
  const present = new Set(markers.filter((_, i) => found[i]));
  return languages.detect((glob) => present.has(glob));
}

// The language of a graph about to be saved at `target` (docs/multi-language.md, gap 1): the
// defaultLanguage setting for its folder, else the nearest marker files above it, else the
// workspace's.
export async function detectNewGraphLanguage(languages: LanguagePackRegistry, target: vscode.Uri): Promise<LanguagePack | undefined> {
  const setting = vscode.workspace.getConfiguration('blueprintVisualScripting', target).get<string>('defaultLanguage')?.trim();
  const root = vscode.workspace.getWorkspaceFolder(target)?.uri.fsPath;
  const folders: string[][] = [];
  for (let dir = path.dirname(target.fsPath); root !== undefined && !path.relative(root, dir).startsWith('..'); dir = path.dirname(dir)) {
    try {
      folders.push((await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir))).filter(([, type]) => type !== vscode.FileType.Directory).map(([name]) => name));
    } catch {
      folders.push([]);
    }
    if (path.relative(root, dir) === '' || path.dirname(dir) === dir) break;
  }
  return languages.detectNewGraph(setting, folders) ?? (await detectWorkspaceLanguage(languages));
}
