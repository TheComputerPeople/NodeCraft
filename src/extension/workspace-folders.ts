// The workspace folder a command works in (docs/project-integration.md, part 1), in a workspace of
// one folder or several: the folder holding the file or folder it was run on, else the one holding
// the active editor's file (a graph editor counts), else the only folder, else the one the user picks.
import * as vscode from 'vscode';

// The file the active editor tab shows, a text file or a custom editor's (a graph's).
export function activeFile(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

export async function commandFolder(hint?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const uri of [hint, activeFile()]) {
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    if (folder) return folder.uri;
  }
  if (folders.length <= 1) return folders[0]?.uri;
  return (await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Which workspace folder?' }))?.uri;
}
