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
