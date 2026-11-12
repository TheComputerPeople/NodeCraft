// Add Blueprint Package… (docs/node-authoring.md, gap 9): copies a package of graphs and nodes into
// the workspace's blueprint-packages folder, as an Unreal plugin's content sits in the project's
// Plugins folder, and generates its libraries, structures and enumerations for the languages the
// workspace's graphs use. From a folder, from an installed extension that contributes
// `blueprintPackages` (a list of { "path": "<folder with a *.vgraph-package.json>" }), or from npm
// (src/extension/npm-registry.ts).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguagePackRegistry } from '../core/language-pack';
import { GraphDocument } from '../core/model';
import { NodePackageManifest, compareVersions, manifestProblems } from '../core/node-packages';
import { parseDocument, serializeDocument } from '../core/serializer';
import { workspaceSnippetLanguages } from './node-libraries';
import { blueprintFolder, downloadPackage, packageVersion, registryFor, searchPackages } from './npm-registry';
import { commandFolder } from './workspace-folders';

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

// A package on npm, by name (its latest version unless one is given).
export interface NpmSource {
  npm: string;
  version?: string;
}

// The workspace's .npmrc, which may name another registry and its token.
// The user's .npmrc, then the workspace's: only when the workspace is trusted, since a cloned
// repository's could send a token from the environment to a server of its choosing.
async function npmrcs(workspaceFolder: vscode.Uri): Promise<string[]> {
  const read = (uri: vscode.Uri) => vscode.workspace.fs.readFile(uri).then((b) => new TextDecoder().decode(b), () => '');
  const user = process.env.NPM_CONFIG_USERCONFIG || process.env.npm_config_userconfig || path.join(os.homedir(), '.npmrc');
  return [await read(vscode.Uri.file(user)), vscode.workspace.isTrusted ? await read(vscode.Uri.joinPath(workspaceFolder, '.npmrc')) : ''];
}

// Downloads an npm package into `dir`; its Blueprint folder.
async function fromNpm(workspaceFolder: vscode.Uri, source: NpmSource, dir: string): Promise<vscode.Uri> {
  const registry = registryFor(source.npm, ...(await npmrcs(workspaceFolder)));
  const found = await packageVersion(registry, source.npm, source.version);
  await downloadPackage(registry, found.tarball, dir);
  return vscode.Uri.file(blueprintFolder(dir, found.blueprint));
}

// Asks for a search on npm, and which package it found.
async function pickFromNpm(workspaceFolder: vscode.Uri): Promise<NpmSource | undefined> {
  const text = await vscode.window.showInputBox({ prompt: 'Search npm for Blueprint packages', placeHolder: 'math' });
  if (text === undefined) return undefined;
  const registry = registryFor('', ...(await npmrcs(workspaceFolder)));
  const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Searching npm' }, () => searchPackages(registry, text));
  if (!found.length) {
    void vscode.window.showInformationMessage(`No Blueprint packages on npm match "${text}".`);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(found.map((p) => ({ label: p.name, description: p.version, detail: p.description, name: p.name })), { placeHolder: 'Which package?' });
  return picked && { npm: picked.name };
}

// Adds the package in `source` (asked for when absent) and returns where it went.
export async function addBlueprintPackage(languages: LanguagePackRegistry, source?: vscode.Uri | NpmSource): Promise<vscode.Uri | undefined> {
  const workspaceFolder = await commandFolder();
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage('Open a folder first: a Blueprint package is added to the workspace.');
    return undefined;
  }
  let npm = source && !(source instanceof vscode.Uri) ? source : undefined;
  let folder = source instanceof vscode.Uri ? source : undefined;
  if (!source) {
    const fromFolder: Offered = { label: '$(folder) From a folder…' };
    const fromNpmItem: Offered = { label: '$(package) From npm…' };
    const picked = await vscode.window.showQuickPick([...contributedPackages(), fromNpmItem, fromFolder], { placeHolder: 'Which package?' });
    if (!picked) return undefined;
    if (picked === fromNpmItem) {
      npm = await pickFromNpm(workspaceFolder);
      if (!npm) return undefined;
    } else {
      folder = picked.folder ?? (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Add Package' }))?.[0];
      if (!folder) return undefined;
    }
  }
  if (!npm) return folder && install(languages, workspaceFolder, folder);
  // The download is copied into the workspace, then removed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-package-'));
  try {
    try {
      folder = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${npm.npm}` }, () => fromNpm(workspaceFolder, npm!, dir));
    } catch (error) {
      void vscode.window.showErrorMessage(`Couldn't add ${npm.npm}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    return await install(languages, workspaceFolder, folder);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Copies the package in `folder` into the workspace and generates it.
async function install(languages: LanguagePackRegistry, workspaceFolder: vscode.Uri, folder: vscode.Uri): Promise<vscode.Uri | undefined> {
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
