// Expose Functions as Nodes (docs/code-as-nodes.md): on a file in the Explorer (or the active
// editor's), its functions that aren't nodes yet, to pick; the picked ones are marked @blueprint in
// their language's documentation style, as the quick fix marks one. On a C or C++ source file, its
// functions become nodes through its header: declared there (a header is made when there's none,
// with extern "C" for a C file) or marked where it declares them. The edit opens in the Refactor
// Preview, to apply or discard; tests give the answers and apply it at once. From the Codebase Map,
// it's one function's (`only`): the choice of functions is skipped.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { headerFor, isCSource, sourceFunctions, withDeclarations } from '../core/importing/c-sources';
import { docStyle, withMarkers } from '../core/importing/expose';
import { ProjectFunctions } from './project-functions';

export interface ExposeAnswers {
  // The functions to expose, by name (all of them when absent).
  names?: string[];
  pure?: boolean;
}

// The one function to expose: the declaration at `line`, else the functions named `name` (a
// method's name without its class's).
export interface ExposeOnly {
  name: string;
  line?: number;
}

const LABEL = 'Expose as Blueprint nodes';

export async function exposeFunctions(projectFunctions: ProjectFunctions, target?: vscode.Uri, given?: ExposeAnswers, only?: ExposeOnly): Promise<string[] | undefined> {
  const uri = target ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    void vscode.window.showInformationMessage('Expose Functions as Nodes works on a source file: pick one in the Explorer, or open one.');
    return undefined;
  }
  const changes = isCSource(uri.fsPath) ? await cSourceChanges(uri, given, only) : await fileChanges(projectFunctions, uri, given, only);
  if (!changes?.length) return undefined;
  const edit = new vscode.WorkspaceEdit();
  const metadata = given ? undefined : { needsConfirmation: true, label: LABEL };
  for (const change of changes) {
    const file = vscode.Uri.file(change.path);
    if (fs.existsSync(file.fsPath)) {
      const document = await vscode.workspace.openTextDocument(file);
      edit.replace(file, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), change.text, metadata);
    } else {
      edit.createFile(file, { ignoreIfExists: true }, metadata);
      edit.insert(file, new vscode.Position(0, 0), change.text, metadata);
    }
  }
  if (!await vscode.workspace.applyEdit(edit)) return undefined;
  if (given) {
    for (const change of changes) await vscode.workspace.textDocuments.find((d) => d.uri.fsPath === vscode.Uri.file(change.path).fsPath)?.save();
  }
  return changes.map((c) => c.path);
}

// A file whose own declarations become nodes: every language, and C and C++ headers.
async function fileChanges(projectFunctions: ProjectFunctions, uri: vscode.Uri, given?: ExposeAnswers, only?: ExposeOnly): Promise<{ path: string; text: string }[] | undefined> {
  const document = await vscode.workspace.openTextDocument(uri);
  const found = await projectFunctions.exposeCandidates(document);
  if (!found) {
    void vscode.window.showInformationMessage(`${path.basename(uri.fsPath)} isn't a file of a language graphs call (or isn't in the workspace).`);
    return undefined;
  }
  if (!found.candidates.length) {
    void vscode.window.showInformationMessage(`${path.basename(uri.fsPath)} has no functions to expose: they're nodes already, or can't be (the Output panel's Blueprint channel says why).`);
    return undefined;
  }
  const candidates = only ? onlyOne(found.candidates, only, (c) => c.line) : found.candidates;
  if (!candidates.length) {
    void vscode.window.showInformationMessage(`${only!.name} is a node already, or can't be one (the Output panel's Blueprint channel says why).`);
    return undefined;
  }
  const chosen = await pick(candidates.map((c) => ({ item: c, label: c.name, description: `${c.kind}, line ${c.line}` })), given, !!only);
  if (!chosen?.length) return undefined;
  const marker = await markerFor(chosen.some((c) => c.kind === 'function' || c.kind === 'method'), given);
  if (!marker) return undefined;
  return [{ path: uri.fsPath, text: withMarkers(document.getText(), chosen, marker, docStyle(found.pack.id)!) }];
}

// A C or C++ source: its functions, through its header.
async function cSourceChanges(uri: vscode.Uri, given?: ExposeAnswers, only?: ExposeOnly): Promise<{ path: string; text: string }[] | undefined> {
  const source = (await vscode.workspace.openTextDocument(uri)).getText();
  const header = headerFor(uri.fsPath, (f) => fs.existsSync(f));
  const headerDocument = fs.existsSync(header) ? await vscode.workspace.openTextDocument(vscode.Uri.file(header)) : undefined;
  const all = sourceFunctions(source, headerDocument?.getText()).filter((f) => f.header.state !== 'marked');
  const functions = only ? onlyOne(all, only) : all;
  if (!functions.length) {
    void vscode.window.showInformationMessage(only
      ? `${only.name} is a node already, or can't be one (static functions belong to their file).`
      : `${path.basename(uri.fsPath)} has no functions to expose: they're nodes already, or can't be (static functions belong to their file).`);
    return undefined;
  }
  const name = path.basename(header);
  const chosen = await pick(functions.map((f) => ({ item: f, label: f.name, description: f.header.state === 'declared' ? `marks its declaration in ${name}` : `declares it in ${name}${headerDocument ? '' : ' (a new header)'}` })), given, !!only);
  if (!chosen?.length) return undefined;
  const marker = await markerFor(true, given);
  if (!marker) return undefined;
  const result = withDeclarations({ path: uri.fsPath, text: source }, { path: header, ...(headerDocument ? { text: headerDocument.getText() } : {}) }, chosen, marker, /\.c$/i.test(uri.fsPath));
  return [{ path: header, text: result.header }, ...(result.source !== undefined ? [{ path: uri.fsPath, text: result.source }] : [])];
}

// The function `only` names: by its line, else by name (several, when it's overloaded or several
// classes have a method so named).
function onlyOne<T extends { name: string }>(items: T[], only: ExposeOnly, lineOf?: (item: T) => number): T[] {
  const byLine = lineOf && only.line !== undefined ? items.filter((i) => lineOf(i) === only.line) : [];
  if (byLine.length) return byLine;
  return items.filter((i) => i.name === only.name || i.name.split(/\.|::/).pop() === only.name);
}

// The functions picked; one already chosen (from the map) isn't asked about.
async function pick<T>(items: { item: T; label: string; description: string }[], given?: ExposeAnswers, chosen = false): Promise<T[] | undefined> {
  if (given) return items.filter((i) => !given.names || given.names.includes(i.label)).map((i) => i.item);
  if (chosen && items.length === 1) return [items[0].item];
  const picked = await vscode.window.showQuickPick(items.map((i) => ({ ...i, picked: true })), { title: 'Expose Functions as Nodes', placeHolder: 'The functions to make nodes', canPickMany: true });
  return picked?.map((p) => p.item);
}

// "@blueprint", or "@blueprint pure" for nodes without exec pins (functions that only compute).
async function markerFor(functions: boolean, given?: ExposeAnswers): Promise<string | undefined> {
  if (given) return given.pure ? '@blueprint pure' : '@blueprint';
  if (!functions) return '@blueprint';
  const choice = await vscode.window.showQuickPick([
    { label: 'Nodes', description: 'with exec pins, run in order', marker: '@blueprint' },
    { label: 'Pure nodes', description: 'no exec pins: for functions that only compute a value', marker: '@blueprint pure' }
  ], { title: 'Expose Functions as Nodes', placeHolder: 'As which nodes?' });
  return choice?.marker;
}
