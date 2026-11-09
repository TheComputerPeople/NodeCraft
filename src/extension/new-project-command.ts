// Blueprint: New Project… (docs/project-integration.md, part 4): asks for a language and a folder (an
// empty one, or a new one in it), writes the project (new-project.ts), opens its graph, compiles it
// and offers Run. Tests give the answers instead of being asked.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { builtinLanguagePacks } from '../core/languages';
import { GRAPH_VIEW_TYPE } from './editor-provider';
import { createProject, detectJavaBuild, detectToolVersion, projectNames } from './new-project';

export interface NewProjectAnswers {
  language: string;
  // The folder the project goes in: itself when it's empty, else a new folder in it.
  folder: vscode.Uri;
  name?: string;
}

export async function newProject(given?: NewProjectAnswers): Promise<vscode.Uri | undefined> {
  const packs = builtinLanguagePacks().all();
  const language = given?.language ?? (await vscode.window.showQuickPick(
    packs.map((p) => ({ label: p.displayName, id: p.id })),
    { title: 'New Project', placeHolder: "The project's language" }
  ))?.id;
  if (!language) return undefined;
  const parent = given?.folder ?? (await vscode.window.showOpenDialog({ title: 'New Project', canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Create Project Here' }))?.[0];
  if (!parent) return undefined;
  const empty = !fs.existsSync(parent.fsPath) || fs.readdirSync(parent.fsPath).length === 0;
  const name = given?.name ?? await vscode.window.showInputBox({
    title: 'New Project', prompt: empty ? "The project's name" : "The project's name (a folder of this name is made for it)",
    value: path.basename(parent.fsPath), validateInput: (v) => (v.trim() ? undefined : 'Give the project a name.')
  });
  if (!name?.trim()) return undefined;
  const folder = empty ? parent.fsPath : path.join(parent.fsPath, projectNames(name).slug);
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) {
    void vscode.window.showErrorMessage(`${folder} isn't empty: pick an empty folder, or one to make the project's folder in.`);
    return undefined;
  }
  const pack = packs.find((p) => p.id === language)!;
  let created: Awaited<ReturnType<typeof createProject>>;
  try {
    created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating a ${pack.displayName} project` }, async () => {
      // Its versions: what generated code needs, or the installed toolchain's when that's newer.
      const toolVersion = await detectToolVersion(language);
      const javaBuild = language === 'java' ? await detectJavaBuild() : undefined;
      return createProject(folder, language, name.trim(), { ...(toolVersion ? { toolVersion } : {}), ...(javaBuild ? { javaBuild } : {}) });
    });
  } catch (error) {
    void vscode.window.showErrorMessage(`The project couldn't be created: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const graph = vscode.Uri.file(created.graph);
  if (!vscode.workspace.getWorkspaceFolder(graph)) {
    // Compiling and running work from the project's own folder.
    const choice = given ? undefined : await vscode.window.showInformationMessage(`Created ${name.trim()} in ${folder}.`, 'Open Folder', 'Add to Workspace');
    if (choice === 'Open Folder') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder));
    else if (choice === 'Add to Workspace') vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(folder) });
    return graph;
  }
  await vscode.commands.executeCommand('vscode.openWith', graph, GRAPH_VIEW_TYPE);
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
  if (!given) {
    const choice = await vscode.window.showInformationMessage(`Created ${name.trim()}: ${path.basename(created.graph)} prints "Hello from Blueprint".`, 'Run');
    if (choice === 'Run') await vscode.commands.executeCommand('blueprintVisualScripting.run', graph);
  }
  return graph;
}
