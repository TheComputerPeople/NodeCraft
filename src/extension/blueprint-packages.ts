// Add Blueprint Package… (docs/node-authoring.md, gap 9): copies a package of graphs and nodes into
// the workspace's blueprint-packages folder, as an Unreal plugin's content sits in the project's
// Plugins folder, and generates its libraries, structures and enumerations for the languages the
// workspace's graphs use. From a folder, or from an installed extension that contributes
// `blueprintPackages` (a list of { "path": "<folder with a *.vgraph-package.json>" }).
import * as vscode from 'vscode';
import { LanguagePackRegistry } from '../core/language-pack';
import { GraphDocument } from '../core/model';
import { NodePackageManifest, compareVersions, manifestProblems } from '../core/node-packages';
import { parseDocument, serializeDocument } from '../core/serializer';
import { workspaceSnippetLanguages } from './node-libraries';

export const PACKAGES_FOLDER = 'blueprint-packages';

interface Offered {
  label: string;
  description?: string;
  folder?: vscode.Uri;
}

// The packages installed extensions contribute.
function contributedPackages(): Offered[] {
  return vscode.extensions.all.flatMap((extension) => {
    const contributed = (extension.packageJSON as { contributes?: { blueprintPackages?: { path?: string }[] } })?.contributes?.blueprintPackages;
    return (Array.isArray(contributed) ? contributed : []).filter((p) => typeof p?.path === 'string').map((p) => ({
      label: p.path!.split(/[\\/]/).filter(Boolean).pop() ?? p.path!,
      description: (extension.packageJSON as { displayName?: string }).displayName ?? extension.id,
      folder: vscode.Uri.joinPath(extension.extensionUri, p.path!)
    }));
  });
}

async function findManifest(folder: vscode.Uri): Promise<vscode.Uri | undefined> {
  const entries = await vscode.workspace.fs.readDirectory(folder).then((e) => e, () => [] as [string, vscode.FileType][]);
  const name = entries.find(([entry, type]) => type === vscode.FileType.File && entry.endsWith('.vgraph-package.json'))?.[0];
  return name ? vscode.Uri.joinPath(folder, name) : undefined;
}

async function readManifest(uri: vscode.Uri): Promise<NodePackageManifest> {
  return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as NodePackageManifest;
}

// Adds the package in `source` (asked for when absent) and returns where it went.
export async function addBlueprintPackage(languages: LanguagePackRegistry, source?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage('Open a folder first: a Blueprint package is added to the workspace.');
    return undefined;
  }
  let folder = source;
  if (!folder) {
    const fromFolder: Offered = { label: '$(folder) From a folder…' };
    const picked = await vscode.window.showQuickPick([...contributedPackages(), fromFolder], { placeHolder: 'Which package?' });
    if (!picked) return undefined;
    folder = picked.folder ?? (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Add Package' }))?.[0];
    if (!folder) return undefined;
  }
  const manifestUri = await findManifest(folder);
  if (!manifestUri) {
    void vscode.window.showErrorMessage(`${folder.fsPath} has no *.vgraph-package.json.`);
    return undefined;
  }
  const manifest = await readManifest(manifestUri);
  const problems = manifestProblems(manifest);
  if (problems.length) {
    void vscode.window.showErrorMessage(`The package's manifest isn't valid: ${problems.join(' ')}`);
    return undefined;
  }
  const target = vscode.Uri.joinPath(workspaceFolder, PACKAGES_FOLDER, manifest.name.replace(/^@/, '').replace(/\//g, '-'));
  // A newer version replaces the one there; anything else asks first.
  const existingManifest = await findManifest(target);
  if (existingManifest) {
    const existing = await readManifest(existingManifest).catch(() => undefined);
    const order = existing ? compareVersions(manifest.version, existing.version) : 1;
    if (order <= 0) {
      const replace = order === 0 ? 'Replace' : 'Downgrade';
      const answer = await vscode.window.showWarningMessage(`${manifest.name} ${existing!.version} is already in the workspace. ${order === 0 ? 'Replace it?' : `Replace it with the older ${manifest.version}?`}`, { modal: true }, replace);
      if (answer !== replace) return undefined;
    }
    await vscode.workspace.fs.delete(target, { recursive: true });
  }
  await vscode.workspace.fs.copy(folder, target, { overwrite: true });

  // Its libraries, structures and enumerations are generated for the workspace's languages.
  const used = (await workspaceSnippetLanguages(languages)).map((l) => l.id);
  for (const entry of manifest.graphs ?? []) {
    for (const file of await vscode.workspace.findFiles(new vscode.RelativePattern(target, entry))) {
      let doc: GraphDocument;
      try {
        doc = parseDocument(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)), file.path.split('/').pop()!.replace(/\.vgraph$/i, '')).document;
      } catch {
        continue;
      }
      if (doc.kind !== 'functionLibrary' && doc.kind !== 'structure' && doc.kind !== 'enumeration') continue;
      const others = used.filter((id) => id !== doc.language && languages.get(id)?.generator);
      const all = [...new Set([...(doc.languages ?? []), ...others])].sort();
      if (all.length) {
        doc.languages = all;
        await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(serializeDocument(doc)));
      }
      await vscode.commands.executeCommand('blueprintVisualScripting.compile', file);
    }
  }
  void vscode.window.showInformationMessage(`Added ${manifest.name} ${manifest.version} to ${vscode.workspace.asRelativePath(target)}.`);
  return target;
}
