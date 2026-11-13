// Runs inside the VS Code extension host. A tiny sequential runner keeps the suite free of a test
// framework dependency; VS Code reports failure when the returned promise rejects.
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LanguagePack } from '../../../src/core/language-pack';
import type { NodeDefinition } from '../../../src/core/model';
import type { DefinitionSite } from '../../../src/core/navigation';
import { builtinLanguagePacks } from '../../../src/core/languages';
import { javascriptPack } from '../../../src/core/languages/javascript';
import { detectNewGraphLanguage } from '../../../src/extension/languages';
import { tarball } from '../../tar';

const EXTENSION_ID = 'local.blueprint-visual-scripting';
const VIEW_TYPE = 'blueprintVisualScripting.graphEditor';

type Test = { name: string; run: () => Promise<void> };
// Thrown by a test that can't run here (a debugger extension that isn't loaded).
class Skip extends Error {}
const tests: Test[] = [];
const test = (name: string, run: () => Promise<void>): void => {
  tests.push({ name, run });
};

function workspaceFile(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace is open');
  return vscode.Uri.joinPath(folder.uri, name);
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function activeCustomEditor(): vscode.TabInputCustom | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input : undefined;
}

// The first file opened waits for VS Code's start and the extension's activation, which can be slow.
async function openInGraphEditor(name: string): Promise<vscode.Uri> {
  const uri = workspaceFile(name);
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  await waitFor(() => activeCustomEditor()?.uri.toString() === uri.toString(), `${name} to open in the graph editor`, 30000);
  return uri;
}

test('activates when a .vgraph file opens in the graph editor', async () => {
  await openInGraphEditor('demo.vgraph');
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} is installed`);
  await waitFor(() => extension.isActive, 'activation');
  assert.equal(activeCustomEditor()?.viewType, VIEW_TYPE);
});

test('registers the New Graph command', async () => {
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('blueprintVisualScripting.createGraph'));
});

// docs/unreal-conventions.md, "Graph tabs": Alt+Left and Alt+Right go through a graph editor's
// graphs only while there's one to go to, and are VS Code's Go Back and Go Forward otherwise.
test("the graph tabs' Back and Forward are commands, keyed only while they can go somewhere", async () => {
  const commands = await vscode.commands.getCommands(true);
  const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
  const keys = (extension.packageJSON as { contributes: { keybindings: { command: string; key: string; when: string }[] } }).contributes.keybindings;
  for (const [command, key, context] of [['graphBack', 'alt+left', 'graphCanGoBack'], ['graphForward', 'alt+right', 'graphCanGoForward']]) {
    assert.ok(commands.includes(`blueprintVisualScripting.${command}`), command);
    const binding = keys.find((k) => k.command === `blueprintVisualScripting.${command}`);
    assert.equal(binding?.key, key);
    assert.match(binding?.when ?? '', new RegExp(`activeCustomEditorId == blueprintVisualScripting\\.graphEditor && blueprintVisualScripting\\.${context}$`));
  }
  // With a graph editor focused, the commands reach it without failing.
  await vscode.commands.executeCommand('blueprintVisualScripting.graphBack');
  await vscode.commands.executeCommand('blueprintVisualScripting.graphForward');
});

// docs/codebase-map.md, Part 1: the workspace's index, built in the parsing worker inside VS Code's
// extension host, with graph files in place of their generated code, and rebuilt when a file changes.
test('the Codebase Map indexes the workspace, and follows a change', async () => {
  const api = ((await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ExtensionApi).testing;
  const folder = vscode.workspace.workspaceFolders![0];
  const index = await api.codeMap.codeIndex(folder);
  const ids = new Set(index.entities.map((e) => e.id));
  for (const id of ['g:demo.vgraph', 'g:countdown/Countdown.vgraph', 'f:node-authoring/lib/tally.ts', 'f:node-authoring/app/tally.py']) assert.ok(ids.has(id), id);
  assert.ok(!ids.has('f:countdown/Countdown.vgraph.ts') && !ids.has('f:demo.vgraph.js'), 'generated code is shown as its graph');
  assert.ok(index.imports.some((e) => e.from === 'g:countdown/Countdown.vgraph' && e.to === 'g:countdown/DoubleCounter.vgraph'), 'a graph imports the graphs it uses');
  assert.ok(index.entities.find((e) => e.id === 'g:countdown/Countdown.vgraph')?.entries?.length, "the countdown's Start event is an entry point");

  const changed = new Promise<void>((resolve) => {
    const listener = api.codeMap.onDidChange(() => {
      listener.dispose();
      resolve();
    });
  });
  const file = workspaceFile('node-authoring/lib/map_probe.ts');
  fs.writeFileSync(file.fsPath, 'export function mapProbe(): number {\n  return 1;\n}\n');
  try {
    await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error("The index wasn't rebuilt")), 15000))]);
    const after = await api.codeMap.codeIndex(folder);
    assert.ok(after.entities.some((e) => e.id === 's:node-authoring/lib/map_probe.ts#mapProbe'));
  } finally {
    fs.rmSync(file.fsPath, { force: true });
  }
});

// docs/codebase-map.md, Part 2: a call the index can only guess (a method on a variable) is resolved
// by the language's server when asked: here TypeScript's, built into VS Code.
test("the Codebase Map asks the language's server what a guessed call is", async () => {
  const api = ((await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ExtensionApi).testing;
  const folder = vscode.workspace.workspaceFolders![0];
  const file = workspaceFile('node-authoring/lib/map_calls.ts');
  fs.writeFileSync(file.fsPath, "import { Tally } from './tally';\n\nexport function addTwo(t: Tally): number {\n  return t.add(2);\n}\n");
  try {
    let index = await api.codeMap.codeIndex(folder);
    const deadline = Date.now() + 15000;
    while (!index.calls.some((c) => c.from === 's:node-authoring/lib/map_calls.ts#addTwo') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      index = await api.codeMap.codeIndex(folder);
    }
    const call = index.calls.find((c) => c.from === 's:node-authoring/lib/map_calls.ts#addTwo');
    assert.ok(call, 'the call is in the index');
    assert.equal(call.to, 's:node-authoring/lib/tally.ts#Tally.add');
    assert.equal(call.certain, false, 'a method on a variable is a guess');
    // --disable-extensions turns off the built-in TypeScript extension too (npm run
    // test:integration:debuggers runs with it).
    if (!vscode.extensions.getExtension('vscode.typescript-language-features')) throw new Skip("VS Code's TypeScript extension is not loaded");
    // The server may still be starting: it's asked until it answers.
    let resolved: string | undefined;
    while (!resolved && Date.now() < deadline + 30000) {
      resolved = await api.codeMap.definitionAt(folder, call.path, call.line, call.column);
      if (!resolved) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(resolved, 's:node-authoring/lib/tally.ts#Tally.add');
  } finally {
    fs.rmSync(file.fsPath, { force: true });
  }
});

// docs/codebase-map.md, Part 2: a function's flowchart, from the file as the editor has it.
test("the Codebase Map draws a function's control flow", async () => {
  const api = ((await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ExtensionApi).testing;
  const folder = vscode.workspace.workspaceFolders![0];
  const chart = await api.codeMap.flowchart(folder, 'node-authoring/lib/tally.ts', 22);
  assert.equal(chart?.name, 'add');
  assert.deepEqual(chart?.nodes.map((n) => n.kind), ['start', 'end', 'block', 'return']);
  assert.equal(await api.codeMap.flowchart(folder, 'node-authoring/lib/tally.ts', 1), undefined);
});

// docs/codebase-map.md, Part 3: Show Codebase Map opens the folder's map, laid out in the extension
// and drawn in its webview; opening a box shows what it holds.
test('Show Codebase Map draws the folder, and opening a box shows what it holds', async () => {
  const api = ((await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ExtensionApi).testing;
  const folder = vscode.workspace.workspaceFolders![0];
  try {
    const scene = await vscode.commands.executeCommand<{ boxes: { id: string; kind: string; parent?: string; expanded: boolean }[] }>('blueprintVisualScripting.showCodebaseMap', folder.uri);
    assert.ok(scene?.boxes.some((b) => b.id === 'm:countdown' && !b.expanded), 'the countdown folder is on the map, closed');
    assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.label.startsWith('Codebase Map'), 'the map is the active tab');
    const opened = await api.codeMapPanels.toggleIn(folder, 'm:countdown');
    assert.ok(opened?.boxes.some((b) => b.id === 'g:countdown/Countdown.vgraph' && b.parent === 'm:countdown'), "the folder's graphs are shown inside it");
    // The structure: graph files list their graphs, and a graph class points at its parent.
    const structure = await api.codeMapPanels.modeIn(folder, 'structure');
    assert.equal(structure?.mode, 'structure');
    assert.ok(structure?.boxes.find((b) => b.id === 'g:countdown/Countdown.vgraph')?.members?.length, "the countdown's graphs are listed in its box");
    assert.ok(structure?.arrows.some((a) => a.kind === 'inherits' && a.from === 'g:countdown/DoubleCounter.vgraph' && a.to === 'g:countdown/Counter.vgraph'), 'DoubleCounter extends Counter');
    // The call flow: from the entry points (the countdown's Start), and from the countdown's event graph down.
    const entries = await api.codeMapPanels.callsIn(folder);
    assert.equal(entries?.mode, 'calls');
    assert.ok((entries?.calls?.starts ?? 0) > 0 && entries?.boxes.some((b) => b.id === 'g:countdown/Countdown.vgraph#EventGraph'), 'the countdown starts the flow');
    const fromCountdown = await api.codeMapPanels.callsIn(folder, 'g:countdown/Countdown.vgraph#EventGraph');
    assert.ok(fromCountdown?.boxes.some((b) => b.id === 'g:countdown/Countdown.vgraph#EventGraph' && b.root));
    assert.ok(fromCountdown?.arrows.some((a) => a.kind === 'calls' && a.from === 'g:countdown/Countdown.vgraph#EventGraph'), 'the countdown calls on, down the map');
    // A function's control flow, from its code.
    const add = await api.codeMapPanels.flowIn(folder, 's:node-authoring/lib/tally.ts#Tally.add');
    assert.equal(add?.mode, 'flow');
    assert.equal(add?.flow?.label, 'add');
    assert.deepEqual(add?.boxes.map((b) => b.flowKind), ['start', 'end', 'block', 'return']);
    await api.codeMapPanels.modeIn(folder, 'architecture');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
});

// docs/codebase-map.md, Part 3: focus on a box's callers and calls, the path of calls between two
// boxes, and Back and Forward through where the map has been.
test('the Codebase Map focuses on a box, finds the calls between two, and goes back and forward', async () => {
  const api = ((await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ExtensionApi).testing;
  const folder = vscode.workspace.workspaceFolders![0];
  const countdown = 'g:countdown/Countdown.vgraph#EventGraph';
  try {
    await vscode.commands.executeCommand('blueprintVisualScripting.showCodebaseMap', folder.uri);
    const fromCountdown = await api.codeMapPanels.callsIn(folder, countdown, 'callees');
    // (Something the countdown's calls reach, past what it calls itself.)
    const called = new Set(fromCountdown?.arrows.filter((a) => a.from === countdown).map((a) => a.to));
    const reached = fromCountdown?.boxes.find((b) => !b.root && !b.id.startsWith('in:') && b.kind !== 'unresolved' && !called.has(b.id))
      ?? fromCountdown?.boxes.find((b) => called.has(b.id));
    assert.ok(reached, 'the countdown calls something');
    // Focus: what it calls below it, what calls it above.
    const focus = await api.codeMapPanels.callsIn(folder, reached.id, 'both');
    assert.equal(focus?.calls?.direction, 'both');
    assert.ok(focus?.arrows.some((a) => a.to === reached.id), 'its callers are above it');
    // The path from the countdown to it.
    const path = await api.codeMapPanels.pathIn(folder, countdown, reached.id);
    assert.ok((path?.calls?.path?.length ?? 0) >= 1, 'a path of calls');
    assert.ok(path?.boxes.some((b) => b.id === countdown && b.root) && path.boxes.some((b) => b.id === reached.id && b.root), 'both ends are marked');
    // Back to the focus, back to the countdown's flow, forward to the focus.
    assert.equal((await api.codeMapPanels.historyIn(folder, 'back'))?.calls?.direction, 'both');
    const before = await api.codeMapPanels.historyIn(folder, 'back');
    assert.equal(before?.calls?.root, countdown);
    assert.equal(before?.calls?.path, undefined);
    assert.equal((await api.codeMapPanels.historyIn(folder, 'forward'))?.calls?.root, reached.id);
    await api.codeMapPanels.modeIn(folder, 'architecture');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
});

// docs/codebase-map.md, Part 3: Show in Codebase Map, Show Call Flow and Show Control Flow, from a
// file in the Explorer or the function at the cursor.
test('Show in Codebase Map reveals a file, or the function at the cursor; the flows start from it', async () => {
  const folder = vscode.workspace.workspaceFolders![0];
  type Revealed = { scene: { mode: string; boxes: { id: string }[] }; focus?: string } | undefined;
  try {
    const countdown = await vscode.commands.executeCommand<Revealed>('blueprintVisualScripting.showInCodebaseMap', vscode.Uri.joinPath(folder.uri, 'countdown', 'Countdown.vgraph'));
    assert.equal(countdown?.focus, 'g:countdown/Countdown.vgraph', 'the graph file is centred and selected');
    assert.equal(countdown?.scene.mode, 'architecture');
    const tally = await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, 'node-authoring', 'lib', 'tally.ts'));
    tally.selection = new vscode.Selection(21, 4, 21, 4);
    const add = await vscode.commands.executeCommand<Revealed>('blueprintVisualScripting.showInCodebaseMap');
    assert.equal(add?.scene.mode, 'structure', 'a declaration is shown in the structure');
    assert.ok(add?.focus === 's:node-authoring/lib/tally.ts#Tally.add' || add?.focus === 's:node-authoring/lib/tally.ts#Tally', `the method (or its class) is selected: ${add?.focus}`);
    await vscode.window.showTextDocument(tally.document);
    const calls = await vscode.commands.executeCommand<{ mode: string; calls?: { root?: string } }>('blueprintVisualScripting.showCallFlow');
    assert.equal(calls?.mode, 'calls');
    assert.equal(calls?.calls?.root, 's:node-authoring/lib/tally.ts#Tally.add');
    await vscode.window.showTextDocument(tally.document);
    const flow = await vscode.commands.executeCommand<{ mode: string; flow?: { label: string } }>('blueprintVisualScripting.showControlFlow');
    assert.equal(flow?.mode, 'flow');
    assert.equal(flow?.flow?.label, 'add');
    const api = ((await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ExtensionApi).testing;
    await api.codeMapPanels.modeIn(folder, 'architecture');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
});

// docs/codebase-map.md, Part 3: the bridges into Blueprint (Expose as Node makes a node; a graph's box
// opens the graph), a box's hover, and the same index as a tree in the Explorer.
test("the Codebase Map's bridges: hover, Expose as Node and Open Graph; its tree opens, shows and exposes", async () => {
  const api = ((await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ExtensionApi).testing;
  const folder = vscode.workspace.workspaceFolders![0];
  const source = workspaceFile('node-authoring/lib/map_bridge.ts');
  const id = 's:node-authoring/lib/map_bridge.ts#doubleIt';
  const halve = 's:node-authoring/lib/map_bridge.ts#halveIt';
  fs.writeFileSync(source.fsPath, '/** Doubles a number. */\nexport function doubleIt(n: number): number {\n  return n * 2;\n}\n\n// Halves a number.\nexport function halveIt(n: number): number {\n  return n / 2;\n}\n');
  try {
    let index = await api.codeMap.codeIndex(folder);
    const deadline = Date.now() + 15000;
    while (!index.entities.some((e) => e.id === halve) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      index = await api.codeMap.codeIndex(folder);
    }
    await vscode.commands.executeCommand('blueprintVisualScripting.showCodebaseMap', folder.uri);
    // A function's hover: its signature and doc comment, from its code.
    assert.deepEqual(await api.codeMapPanels.hoverIn(folder, id), { signature: 'export function doubleIt(n: number): number', doc: 'Doubles a number.' });
    assert.equal(await api.codeMapPanels.hoverIn(folder, 'f:node-authoring/lib/map_bridge.ts'), undefined, 'a file has none');

    // The tree: the folder's code, down to the function, in the Explorer.
    await vscode.commands.executeCommand('blueprintVisualScripting.codebaseStructure.focus');
    const tree = api.structureTree;
    const node = { folder, id: halve };
    const chain: { folder: vscode.WorkspaceFolder; id?: string }[] = [node];
    for (let up = await tree.getParent(node); up; up = await tree.getParent(up)) chain.unshift(up);
    for (let i = 0; i < chain.length; i++) {
      const siblings = await tree.getChildren(i ? chain[i - 1] : undefined);
      assert.ok(siblings.some((n) => n.id === chain[i].id), `${chain[i].id} is under ${chain[i - 1]?.id ?? 'the top'}`);
    }
    assert.ok(chain.some((n) => n.id === 'f:node-authoring/lib/map_bridge.ts'), 'in its file');
    const item = await tree.getTreeItem(node);
    assert.equal(item.label, 'halveIt');
    assert.equal(item.contextValue, 'codemap-function-exposable');
    assert.equal(item.command?.command, 'blueprintVisualScripting.openMapEntity');
    const resolved = await tree.resolveTreeItem(item, node);
    const tooltip = (resolved.tooltip as vscode.MarkdownString).value;
    assert.match(tooltip, /export function halveIt\(n: number\): number/);
    assert.match(tooltip, /Halves a number\./);
    // Its items open their code and show on the map.
    await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, source.fsPath);
    assert.equal(vscode.window.activeTextEditor?.selection.active.line, 6);
    const shown = await vscode.commands.executeCommand<{ focus?: string }>('blueprintVisualScripting.showInCodebaseMap', node);
    assert.equal(shown?.focus, halve);

    // Open Graph: a graph's box opens its file in the graph editor.
    await api.codeMapPanels.openIn(folder, 'g:countdown/Countdown.vgraph#EventGraph');
    await waitFor(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputCustom && input.viewType === 'blueprintVisualScripting.graphEditor' && input.uri.path.endsWith('/countdown/Countdown.vgraph');
    }, 'the countdown in the graph editor', 15000);

    // Expose as Node, from its box: only it is marked, and it becomes a node.
    const changed = await api.codeMapPanels.exposeIn(folder, id, {});
    assert.deepEqual(changed?.map((f) => path.basename(f)), ['map_bridge.ts']);
    const marked = await readText(source);
    assert.match(marked, /Doubles a number\.\r?\n \* @blueprint\r?\n \*\/\r?\nexport function doubleIt/);
    assert.ok(!marked.split('export function doubleIt')[1].includes('@blueprint'), 'only the function chosen');
    await waitFor(() => !!api.registry.get('fn:typescript:node-authoring/lib/map_bridge.ts#doubleIt'), 'the Double It node', 20000);
    // And from the tree, as a pure node.
    const exposed = await vscode.commands.executeCommand<string[]>('blueprintVisualScripting.exposeAsNode', node, { pure: true });
    assert.deepEqual(exposed?.map((f) => path.basename(f)), ['map_bridge.ts']);
    assert.match(await readText(source), /\/\/ Halves a number\.[\s\S]*@blueprint pure[^\n]*\r?\nexport function halveIt/);
    await waitFor(() => !!api.registry.get('fn:typescript:node-authoring/lib/map_bridge.ts#halveIt'), 'the Halve It node', 20000);
    await api.codeMapPanels.modeIn(folder, 'architecture');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(source.fsPath, { force: true });
  }
});

// docs/multi-language.md, gap 1: a repository with a TypeScript web/ and a Python api/.
test("a new graph takes its folder's language, and the folder's setting wins", async () => {
  const folder = workspaceFile('multi').fsPath;
  fs.mkdirSync(path.join(folder, 'api', 'handlers'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'web'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'api', 'pyproject.toml'), '[project]\nname = "api"\n');
  fs.writeFileSync(path.join(folder, 'web', 'tsconfig.json'), '{}\n');
  const settings = vscode.workspace.getConfiguration('blueprintVisualScripting');
  try {
    const languageOf = async (file: string) => (await detectNewGraphLanguage(builtinLanguagePacks(), workspaceFile(`multi/${file}`)))?.id;
    assert.equal(await languageOf('api/handlers/New.vgraph'), 'python');
    assert.equal(await languageOf('web/New.vgraph'), 'typescript');
    await settings.update('defaultLanguage', 'go', vscode.ConfigurationTarget.Workspace);
    assert.equal(await languageOf('api/handlers/New.vgraph'), 'go');
  } finally {
    await settings.update('defaultLanguage', undefined, vscode.ConfigurationTarget.Workspace);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('opening a schema 1 file does not modify it', async () => {
  const uri = await openInGraphEditor('legacy.vgraph');
  const before = (await vscode.workspace.fs.readFile(uri)).toString();
  // Give the webview time to load and send its first messages.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  assert.equal(document?.isDirty ?? false, false, 'the document is not marked modified');
  assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), before);
});

test('an unparsable file still opens in the graph editor', async () => {
  await openInGraphEditor('broken.vgraph');
  assert.equal(activeCustomEditor()?.viewType, VIEW_TYPE);
});

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(uri: vscode.Uri, present: boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while ((await exists(uri)) !== present) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

// Replaces a graph's whole text through the editor, as a user edit would.
async function editGraph(uri: vscode.Uri, change: (graph: Record<string, unknown>) => void): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(uri);
  const graph = JSON.parse(document.getText());
  change(graph);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), JSON.stringify(graph, null, 2) + '\n');
  await vscode.workspace.applyEdit(edit);
  return document;
}

test('Compile writes the generated file next to the graph', async () => {
  const graph = workspaceFile('demo.vgraph');
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
  const output = workspaceFile('demo.vgraph.js');
  assert.ok(await exists(output), 'demo.vgraph.js was written');
  const text = await readText(output);
  assert.match(text, /^\/\/ Generated by Blueprint Visual Scripting from demo\.vgraph\./);
  assert.match(text, /export class BlueprintDemo/);
  assert.deepEqual(vscode.languages.getDiagnostics(graph), []);
});

// docs/project-integration.md, part 2.
test("Compile warns when the graph's project declares an older language version than generated code needs", async () => {
  const write = (name: string, text: string) => vscode.workspace.fs.writeFile(workspaceFile(name), new TextEncoder().encode(text));
  const graph = workspaceFile('legacy-java/src/main/java/game/Hello.vgraph');
  await write('legacy-java/pom.xml', '<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId><artifactId>a</artifactId><version>1</version><properties><maven.compiler.release>11</maven.compiler.release></properties></project>');
  await write('legacy-java/src/main/java/game/Hello.vgraph', JSON.stringify({
    schemaVersion: 3, name: 'Hello', kind: 'class', language: 'java', variables: [],
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [{ id: 's', type: 'core:event.start', position: { x: 0, y: 0 }, properties: {} }], connections: [] }]
  }));
  try {
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
    // Once for the project, on the file that declares the version, rather than on each graph.
    const warning = vscode.languages.getDiagnostics(workspaceFile('legacy-java/pom.xml')).find((d) => d.code === 'project-version');
    assert.ok(warning, 'the version warning');
    assert.equal(warning.severity, vscode.DiagnosticSeverity.Warning);
    assert.match(warning.message, /declares 11 in pom\.xml, but generated Java needs Java 17/);
    assert.ok(!vscode.languages.getDiagnostics(graph).some((d) => d.code === 'project-version'), 'not on the graph');
    assert.ok(await exists(workspaceFile('legacy-java/src/main/java/game/Hello.java')), 'generated all the same');
  } finally {
    await vscode.workspace.fs.delete(workspaceFile('legacy-java'), { recursive: true });
  }
});

test('saving a graph compiles it', async () => {
  const graph = workspaceFile('legacy.vgraph');
  const document = await editGraph(graph, (g) => {
    g.name = 'Legacy';
  });
  await document.save();
  await waitForFile(workspaceFile('legacy.vgraph.js'), true, 'compile on save');
});

test('switching the language replaces the old generated file', async () => {
  const graph = workspaceFile('demo.vgraph');
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
  await editGraph(graph, (g) => {
    g.language = 'python';
  });
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
  assert.ok(await exists(workspaceFile('demo_vgraph.py')), 'demo_vgraph.py was written');
  assert.equal(await exists(workspaceFile('demo.vgraph.js')), false, 'the stale JavaScript file is gone');
});

test('renaming a graph moves its generated file, and deleting it removes the file', async () => {
  const graph = workspaceFile('legacy.vgraph');
  const renamed = workspaceFile('renamed.vgraph');
  const save = await vscode.workspace.openTextDocument(graph);
  await save.save();
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
  assert.ok(await exists(workspaceFile('legacy.vgraph.js')));

  const rename = new vscode.WorkspaceEdit();
  rename.renameFile(graph, renamed);
  assert.ok(await vscode.workspace.applyEdit(rename));
  await waitForFile(workspaceFile('renamed.vgraph.js'), true, 'the generated file to follow the rename');
  assert.equal(await exists(workspaceFile('legacy.vgraph.js')), false);
  // The rename recompiles it, which rewrites its header.
  const renamedText = async () => readText(workspaceFile('renamed.vgraph.js'));
  const deadline = Date.now() + 10000;
  while (!/from renamed\.vgraph\./.test(await renamedText()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(await renamedText(), /from renamed\.vgraph\./);

  const remove = new vscode.WorkspaceEdit();
  remove.deleteFile(renamed);
  assert.ok(await vscode.workspace.applyEdit(remove));
  await waitForFile(workspaceFile('renamed.vgraph.js'), false, 'the generated file to be deleted');
});

// docs/audit.md, second pass: an older compile can't finish last and leave its language's file.
test('overlapping compiles of a graph take turns, and the last one wins', async () => {
  const graph = workspaceFile('demo.vgraph');
  await editGraph(graph, (g) => {
    g.language = 'javascript';
  });
  const first = vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
  await editGraph(graph, (g) => {
    g.language = 'python';
  });
  const others = [1, 2, 3].map(() => vscode.commands.executeCommand('blueprintVisualScripting.compile', graph));
  await Promise.all([first, ...others]);
  assert.ok(await exists(workspaceFile('demo_vgraph.py')), 'the latest language\'s file is there');
  assert.equal(await exists(workspaceFile('demo.vgraph.js')), false, 'and the older one\'s is gone');
});

test('renaming a graph onto a file of the user\'s leaves the file alone, and says so', async () => {
  const graph = workspaceFile('collide.vgraph');
  const renamed = workspaceFile('mine.vgraph');
  const mine = workspaceFile('mine.vgraph.js');
  const text = 'console.log("mine");\n';
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify({
    schemaVersion: 3, name: 'Collide', kind: 'class', language: 'javascript', variables: [],
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [{ id: 's', type: 'core:event.start', position: { x: 0, y: 0 }, properties: {} }], connections: [] }]
  })));
  await vscode.workspace.fs.writeFile(mine, new TextEncoder().encode(text));
  try {
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
    assert.ok(await exists(workspaceFile('collide.vgraph.js')));
    const rename = new vscode.WorkspaceEdit();
    rename.renameFile(graph, renamed);
    assert.ok(await vscode.workspace.applyEdit(rename));
    await waitFor(() => vscode.languages.getDiagnostics(renamed).some((d) => d.code === 'output-exists'), 'the problem about mine.vgraph.js');
    assert.equal(await readText(mine), text);
    assert.equal(await exists(workspaceFile('collide.vgraph.js')), false, 'the old generated file is removed, not left behind');
  } finally {
    const remove = new vscode.WorkspaceEdit();
    for (const file of [graph, renamed, mine, workspaceFile('collide.vgraph.js')]) remove.deleteFile(file, { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(remove);
  }
});

test('compile errors appear in the Problems panel', async () => {
  const graph = workspaceFile('broken.vgraph');
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
  const problems = vscode.languages.getDiagnostics(graph);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].severity, vscode.DiagnosticSeverity.Error);
  assert.match(problems[0].message, /can't be read/);
});

// docs/audit.md, step 3: a file broken inside (a bad merge) says where, rather than crashing the
// compiler on save with nothing said.
test('a graph broken inside says where in Problems when it is saved', async () => {
  const graph = workspaceFile('merged.vgraph');
  const node = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, properties: {} });
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify({
    schemaVersion: 3, name: 'Merged', kind: 'class', language: 'javascript', variables: [],
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [node('s', 'core:event.start'), node('p', 'core:console.print')], connections: [] }]
  }, null, 2)));
  try {
    const document = await editGraph(graph, (g) => {
      (g.graphs as { connections: unknown[] }[])[0].connections = [null];
    });
    await document.save();
    await waitFor(() => vscode.languages.getDiagnostics(graph).length > 0, 'the problem to be reported');
    const [problem] = vscode.languages.getDiagnostics(graph);
    assert.equal(problem.severity, vscode.DiagnosticSeverity.Error);
    assert.match(problem.message, /connection 1 in graph "EventGraph" is not an object/);
  } finally {
    await vscode.workspace.fs.delete(graph);
  }
});

// A compile that throws (here: its generated file can't be written, as a folder has its name) is
// reported in Problems, with the details in the output.
test('a compile that fails is reported in Problems', async () => {
  const graph = workspaceFile('stuck.vgraph');
  const output = workspaceFile('stuck.vgraph.js');
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify({
    schemaVersion: 3, name: 'Stuck', kind: 'class', language: 'javascript', variables: [],
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [{ id: 's', type: 'core:event.start', position: { x: 0, y: 0 }, properties: {} }], connections: [] }]
  })));
  // A generated file that can't be written: read-only. (A folder there is the user's, which
  // compiling doesn't write over: docs/audit.md, second pass.)
  await vscode.workspace.fs.writeFile(output, new TextEncoder().encode('// Generated by Blueprint Visual Scripting from stuck.vgraph.\n'));
  fs.chmodSync(output.fsPath, 0o444);
  try {
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
    const problems = vscode.languages.getDiagnostics(graph);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.equal(problems[0].severity, vscode.DiagnosticSeverity.Error);
    assert.match(problems[0].message, /^Compiling stopped: .+ The Blueprint Visual Scripting output has the details\.$/s);
  } finally {
    fs.chmodSync(output.fsPath, 0o666);
    await vscode.workspace.fs.delete(output);
    await vscode.workspace.fs.delete(graph);
  }
});

// docs/audit.md, step 4: Collapse to Function in Library writes only the library just picked for
// the graph, inside its workspace folder, whatever the editor's message names.
test('saving a collapsed library writes only the library picked, inside the folder', async () => {
  const api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as { testing: { provider: unknown } };
  const provider = api.testing.provider as {
    pickedLibraries: Map<string, string>;
    saveLibrary(from: vscode.Uri, library: { path: string; document: unknown }): Promise<void>;
  };
  const graph = workspaceFile('demo.vgraph');
  const library = (name: string) => ({ schemaVersion: 3, name, kind: 'functionLibrary', language: 'javascript', variables: [], graphs: [] });
  const outside = vscode.Uri.joinPath(workspaceFile('demo.vgraph'), '..', '..', 'escaped.vgraph');
  const unpicked = workspaceFile('Unpicked.vgraph');
  const picked = workspaceFile('Picked.vgraph');
  try {
    await provider.saveLibrary(graph, { path: '../escaped.vgraph', document: library('Escaped') });
    await provider.saveLibrary(graph, { path: 'Unpicked.vgraph', document: library('Unpicked') });
    // Picked, but the message names another file, or isn't a function library.
    provider.pickedLibraries.set(graph.toString(), 'Picked.vgraph');
    await provider.saveLibrary(graph, { path: 'Unpicked.vgraph', document: library('Unpicked') });
    provider.pickedLibraries.set(graph.toString(), '../escaped.vgraph');
    await provider.saveLibrary(graph, { path: '../escaped.vgraph', document: library('Escaped') });
    assert.equal(await exists(outside), false, 'nothing written outside the workspace folder');
    assert.equal(await exists(unpicked), false, 'nothing written that was not picked');
    provider.pickedLibraries.set(graph.toString(), 'Picked.vgraph');
    await provider.saveLibrary(graph, { path: 'Picked.vgraph', document: { ...library('Picked'), kind: 'class' } });
    assert.equal(await exists(picked), false, 'only a function library');
    provider.pickedLibraries.set(graph.toString(), 'Picked.vgraph');
    await provider.saveLibrary(graph, { path: 'Picked.vgraph', document: library('Picked') });
    assert.match(await readText(picked), /"kind": "functionLibrary"/);
    // Once: the pick is used up.
    await vscode.workspace.fs.delete(picked);
    await provider.saveLibrary(graph, { path: 'Picked.vgraph', document: library('Picked') });
    assert.equal(await exists(picked), false, 'a pick saves once');
  } finally {
    for (const uri of [outside, unpicked, picked]) if (await exists(uri)) await vscode.workspace.fs.delete(uri);
  }
});

// A graph calling one project function: Start → Double(4) → Print.
function projectGraph(name: string, language: string, type: string): string {
  const node = (id: string, nodeType: string, properties: Record<string, unknown> = {}) => ({ id, type: nodeType, position: { x: 0, y: 0 }, properties });
  return JSON.stringify({
    schemaVersion: 3, name, kind: 'class', language, variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('d', type, { 'pin:value': 4 }), node('p', 'core:console.print')],
      connections: [
        { id: 'c1', fromNode: 's', fromPin: 'execOut', toNode: 'p', toPin: 'execIn' },
        { id: 'c2', fromNode: 'd', fromPin: 'returnValue', toNode: 'p', toPin: 'value' }
      ]
    }]
  }, null, 2);
}

// Compiles until the project's functions have been found (they load in the background).
async function compileOnceFound(graph: vscode.Uri): Promise<void> {
  const deadline = Date.now() + 15000;
  for (;;) {
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
    const problems = vscode.languages.getDiagnostics(graph);
    if (!problems.some((p) => p.code === 'unknown-node-type' || p.code === 'function-missing')) {
      assert.deepEqual(problems.map((p) => p.message), []);
      return;
    }
    if (Date.now() > deadline) throw new Error(`The project function was never found: ${problems.map((p) => p.message).join('; ')}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('functions marked @blueprint become nodes that generated code imports', async () => {
  const write = (name: string, text: string) => vscode.workspace.fs.writeFile(workspaceFile(name), new TextEncoder().encode(text));
  await write('lib/score.ts', '/** @blueprint pure */\nexport function double(value: number): number {\n  return value * 2;\n}\n');
  await write('game/__init__.py', '');
  await write('game/score.py', 'def double(value: float) -> float:\n    """@blueprint pure"""\n    return value * 2\n');

  const tsGraph = workspaceFile('uses-ts.vgraph');
  await write('uses-ts.vgraph', projectGraph('UsesTs', 'typescript', 'fn:typescript:lib/score.ts#double'));
  await compileOnceFound(tsGraph);
  assert.match(await readText(workspaceFile('uses-ts.vgraph.ts')), /^import \{ double \} from "\.\/lib\/score\.ts";$/m);

  const pyGraph = workspaceFile('uses-py.vgraph');
  await write('uses-py.vgraph', projectGraph('UsesPy', 'python', 'fn:python:game/score.py#double'));
  await compileOnceFound(pyGraph);
  assert.match(await readText(workspaceFile('uses_py_vgraph.py')), /^from game\.score import double$/m);

  // C#: a static method in a project with a root namespace; the graph's class goes in it too.
  await write('Tools/Tools.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><RootNamespace>Studio.Tools</RootNamespace></PropertyGroup></Project>\n');
  await write('Tools/MathTools.cs', 'namespace Studio.Tools;\n\npublic static class MathTools\n{\n    /// @blueprint pure\n    public static double Double(double value) => value * 2;\n}\n');
  const csGraph = workspaceFile('Tools/Graphs/uses-cs.vgraph');
  await write('Tools/Graphs/uses-cs.vgraph', projectGraph('UsesCs', 'csharp', 'fn:csharp:Tools/MathTools.cs#Studio.Tools.MathTools.Double'));
  await compileOnceFound(csGraph);
  const csharp = await readText(workspaceFile('Tools/Graphs/uses-cs.vgraph.cs'));
  assert.match(csharp, /^namespace Studio\.Tools\.Graphs;$/m);
  assert.match(csharp, /global::Studio\.Tools\.MathTools\.Double\(4\)/);

  // Java: a public static method in a Maven project; the graph's class goes in its folder's package.
  await write('javaapp/pom.xml', '<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>app</artifactId><version>1</version></project>\n');
  await write('javaapp/src/main/java/demo/Scores.java', 'package demo;\n\npublic final class Scores {\n    /** @blueprint pure */\n    public static double twice(double value) {\n        return value * 2;\n    }\n}\n');
  const javaGraph = workspaceFile('javaapp/src/main/java/demo/graphs/UsesJava.vgraph');
  await write('javaapp/src/main/java/demo/graphs/UsesJava.vgraph', projectGraph('UsesJava', 'java', 'fn:java:javaapp/src/main/java/demo/Scores.java#demo.Scores.twice'));
  await compileOnceFound(javaGraph);
  const java = await readText(workspaceFile('javaapp/src/main/java/demo/graphs/UsesJava.java'));
  assert.match(java, /^package demo\.graphs;$/m);
  assert.match(java, /demo\.Scores\.twice\(4\.0\)/);

  // Renaming the function in code is detected: the node's function is gone.
  await write('lib/score.ts', '/** @blueprint pure */\nexport function twice(value: number): number {\n  return value * 2;\n}\n');
  const deadline = Date.now() + 15000;
  for (;;) {
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', tsGraph);
    const problems = vscode.languages.getDiagnostics(tsGraph);
    if (problems.some((p) => p.code === 'function-missing')) {
      assert.match(problems[0].message, /double in lib\/score\.ts no longer exists/);
      break;
    }
    if (Date.now() > deadline) throw new Error('The rename was never detected');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

test("Go to Definition opens a project function's code at its line, and a node file at its type", async () => {
  const write = (name: string, text: string) => vscode.workspace.fs.writeFile(workspaceFile(name), new TextEncoder().encode(text));
  await write('lib/navigate.ts', '// Somewhere to go.\n\n/** @blueprint */\nexport function arrive(): void {}\n');
  await write('nodes/Shout.node.json', JSON.stringify({
    type: 'test.shout', version: 1, displayName: 'Shout', category: 'Test', inputs: [], outputs: [],
    implementation: { kind: 'code', languages: { typescript: 'console.log("!");' } }
  }, null, 2));
  const graph = workspaceFile('lib/navigate.vgraph');
  const api = (vscode.extensions.getExtension(EXTENSION_ID)!.exports as ExtensionApi).testing;
  const opened = () => vscode.window.activeTextEditor;
  // The scan and the node files load in the background: ask until each one is found.
  const until = async (type: string, site: Parameters<typeof api.provider.goToDefinition>[2], file: string, line: number) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      await api.provider.goToDefinition(graph, type, site);
      const editor = opened();
      if (editor?.document.uri.toString() === workspaceFile(file).toString() && editor.selection.active.line === line) return;
      if (Date.now() > deadline) throw new Error(`${type} never opened ${file} at line ${line + 1}; the active editor: ${editor?.document.uri.toString()}:${editor?.selection.active.line}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  await until('fn:typescript:lib/navigate.ts#arrive', { kind: 'code', path: 'lib/navigate.ts' }, 'lib/navigate.ts', 3);
  await until('test.shout', { kind: 'node-file' }, 'nodes/Shout.node.json', 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('a marked function that cannot be a node warns in its file; Expose adds the marker', async () => {
  const uri = workspaceFile('lib/feedback.ts');
  const text = '/** @blueprint */\nexport function total(...values: number[]): number { return 0; }\n\nexport function plain(a: number): number {\n  return a;\n}\n';
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
  await waitFor(() => vscode.languages.getDiagnostics(uri).some((d) => d.source === 'Blueprint'), 'the warning on total', 20000);
  const [warning] = vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Blueprint');
  assert.equal(warning.message, "Not a Blueprint node: rest parameters can't be pins");
  assert.equal(warning.range.start.line, 1);

  const document = await vscode.workspace.openTextDocument(uri);
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, new vscode.Range(3, 0, 3, 0));
  const titles = actions.map((a) => a.title);
  assert.ok(titles.includes('Expose as Blueprint node') && titles.includes('Expose as pure Blueprint node'), titles.join(', '));
  assert.ok(await vscode.workspace.applyEdit(actions.find((a) => a.title === 'Expose as pure Blueprint node')!.edit!));
  assert.ok(document.getText().includes('/** @blueprint pure */\nexport function plain(a: number): number {'), document.getText());
  await document.save();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('New Project writes a project in a new folder of a folder that has files, opens its graph and compiles it', async () => {
  const parent = workspaceFile('new-projects');
  await vscode.workspace.fs.writeFile(workspaceFile('new-projects/notes.txt'), new TextEncoder().encode('not empty\n'));
  try {
    const graph = await vscode.commands.executeCommand<vscode.Uri>('blueprintVisualScripting.newProject', { language: 'javascript', folder: parent, name: 'Hello Game' });
    assert.equal(graph?.toString(), workspaceFile('new-projects/hello-game/src/Main.vgraph').toString());
    for (const file of ['package.json', 'src/main.js', 'src/Main.vgraph.js', '.gitignore', '.gitattributes', 'README.md']) {
      await vscode.workspace.fs.stat(workspaceFile(`new-projects/hello-game/${file}`));
    }
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(tab instanceof vscode.TabInputCustom && tab.uri.toString() === graph!.toString(), 'the graph is open in the graph editor');
    assert.match(await readText(workspaceFile('new-projects/hello-game/src/Main.vgraph.js')), /Hello from Blueprint/);
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(parent, { recursive: true });
  }
});

test('Set Up in This Project reports a folder\'s project; its first graph and .gitattributes apply as undoable edits', async () => {
  const folder = workspaceFile('setup-project');
  await vscode.workspace.fs.writeFile(workspaceFile('setup-project/package.json'), new TextEncoder().encode('{ "name": "setup-app", "type": "module" }\n'));
  await vscode.workspace.fs.writeFile(workspaceFile('setup-project/src/index.js'), new TextEncoder().encode('export const ready = true;\n'));
  try {
    const report = await vscode.commands.executeCommand<{ root: string; items: { kind: string; title: string; change?: { id: string } }[] }[]>('blueprintVisualScripting.setUpProject', folder);
    const optional = report?.flatMap((p) => p.items).filter((i) => i.kind === 'optional') ?? [];
    const first = optional.find((i) => /first graph/.test(i.title));
    const attributes = optional.find((i) => /gitattributes/.test(i.title));
    assert.ok(first?.change && attributes?.change, JSON.stringify(report));
    await waitFor(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === 'Set Up in This Project')), 'the report open');
    assert.equal(await vscode.commands.executeCommand('blueprintVisualScripting.applySetupChange', first.change.id), true);
    const output = workspaceFile('setup-project/src/Hello.vgraph.js').fsPath;
    await waitFor(() => fs.existsSync(output) && /Hello from Blueprint/.test(fs.readFileSync(output, 'utf8')), 'the first graph compiled', 20000);
    assert.equal(await vscode.commands.executeCommand('blueprintVisualScripting.applySetupChange', attributes.change.id), true);
    assert.match(await readText(workspaceFile('setup-project/.gitattributes')), /^\*\.vgraph\.\* linguist-generated$/m);
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(folder, { recursive: true });
  }
});

test('Expose Functions as Nodes marks a file\'s picked functions, which become nodes; a C file\'s through a new header', async () => {
  const api = (vscode.extensions.getExtension(EXTENSION_ID)!.exports as ExtensionApi).testing;
  const source = workspaceFile('lib/expose-me.ts');
  await vscode.workspace.fs.writeFile(source, new TextEncoder().encode('export function shout(text: string): string {\n  return text.toUpperCase();\n}\n\nexport function whisper(text: string): string {\n  return text.toLowerCase();\n}\n'));
  const native = workspaceFile('native/expose-me.c');
  await vscode.workspace.fs.writeFile(native, new TextEncoder().encode('double area(double width, double height) {\n    return width * height;\n}\n'));
  try {
    const changed = await vscode.commands.executeCommand<string[]>('blueprintVisualScripting.exposeFunctions', source, { names: ['shout'], pure: true });
    assert.deepEqual(changed?.map((f) => path.basename(f)), ['expose-me.ts']);
    assert.match(await readText(source), /^\/\*\* @blueprint pure \*\/\nexport function shout/m);
    assert.doesNotMatch(await readText(source), /@blueprint pure \*\/\nexport function whisper/, 'only what was picked');
    await waitFor(() => !!api.registry.get('fn:typescript:lib/expose-me.ts#shout'), 'the Shout node', 20000);

    const header = workspaceFile('native/expose-me.h');
    const fromC = await vscode.commands.executeCommand<string[]>('blueprintVisualScripting.exposeFunctions', native, {});
    assert.deepEqual(fromC?.map((f) => path.basename(f)).sort(), ['expose-me.c', 'expose-me.h']);
    const headerText = await readText(header);
    assert.match(headerText, /extern "C" \{[\s\S]*\/\/\/ @blueprint\r?\ndouble area\(double width, double height\);/);
    assert.match(await readText(native), /^#include "expose-me\.h"\r?\n/);
    await waitFor(() => !!api.registry.get('fn:cpp:native/expose-me.h#area'), 'the Area node, from the header', 20000);
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const file of [source, native, workspaceFile('native/expose-me.h')]) await vscode.workspace.fs.delete(file).then(undefined, () => undefined);
  }
});

test('New Node writes a node file to start from; node files show their problems', async () => {
  const created = await vscode.commands.executeCommand<vscode.Uri>('blueprintVisualScripting.newNode', workspaceFile('lib'), { name: 'Clamp Health', category: 'Combat' });
  assert.equal(created?.toString(), workspaceFile('lib/ClampHealth.node.json').toString());
  const definition = JSON.parse(await readText(created)) as NodeDefinition;
  assert.equal(definition.type, 'user.combat.clamp-health');
  assert.ok(definition.implementation?.kind === 'code' && Object.keys(definition.implementation.languages).length > 0);

  // A snippet using an input the node doesn't have, and a type another file defines too.
  const broken = workspaceFile('lib/Broken.node.json');
  const copy = workspaceFile('lib/BrokenCopy.node.json');
  const text = JSON.stringify({ ...definition, type: 'test.broken', implementation: { kind: 'code', languages: { typescript: 'return ${value} * ${factor};' } } }, null, 2);
  await vscode.workspace.fs.writeFile(broken, new TextEncoder().encode(text));
  await vscode.workspace.fs.writeFile(copy, new TextEncoder().encode(text));
  try {
    const messages = () => vscode.languages.getDiagnostics(broken).filter((d) => d.source === 'Blueprint').map((d) => d.message);
    await waitFor(() => messages().length >= 2, 'the problems in Broken.node.json', 20000);
    assert.ok(messages().includes('The typescript snippet uses ${factor}, but "Clamp Health" has no data input "factor".'), messages().join('\n'));
    assert.ok(messages().some((m) => m.startsWith('"test.broken" is also defined in lib/BrokenCopy.node.json')), messages().join('\n'));
  } finally {
    await vscode.workspace.fs.delete(copy);
    await vscode.workspace.fs.delete(broken);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
});

test("Test Node Library runs a node file's examples in Simulate and in generated code", async () => {
  const file = workspaceFile('lib/Halve.node.json');
  const halve = {
    type: 'test.halve', version: 1, displayName: 'Halve', category: 'Test',
    inputs: [{ id: 'value', name: 'Value', kind: 'data', direction: 'input', type: { id: 'float' } }],
    outputs: [{ id: 'result', name: 'Result', kind: 'data', direction: 'output', type: { id: 'float' } }],
    implementation: { kind: 'code', languages: { typescript: 'return ${value} / 2;', javascript: 'return ${value} / 2;' } },
    examples: [{ inputs: { value: 9 }, outputs: { result: 4.5 } }, { inputs: { value: 2 }, outputs: { result: 3 } }]
  };
  await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(halve, null, 2)));
  try {
    const reports = await vscode.commands.executeCommand<{ pack: string; results: { fixture: string; status: string; message?: string }[] }[]>('blueprintVisualScripting.testNodeLibrary', file, ['typescript']);
    assert.deepEqual(reports.map((r) => [r.pack, r.results.map((x) => x.status)]), [['simulate', ['failed']], ['typescript', ['failed']]]);
    for (const report of reports) assert.match(report.results[0].message ?? '', /Example 2, inputs \{"value":2\}: expected \["3"\], printed \["1"\]/);
  } finally {
    await vscode.workspace.fs.delete(file);
  }
});

test('Add Blueprint Package copies a graph package into the workspace, generates it, and its nodes carry its version', async () => {
  const write = (name: string, text: string) => vscode.workspace.fs.writeFile(workspaceFile(name), new TextEncoder().encode(text));
  const manifest = (version: string) => JSON.stringify({ name: 'combat-graphs', version, graphs: ['*.vgraph'] }, null, 2);
  const library = {
    schemaVersion: 3, name: 'Combat', kind: 'functionLibrary', language: 'typescript', variables: [],
    graphs: [{
      id: 'Half', name: 'Half', kind: 'function', comments: [],
      signature: { inputs: [{ id: 'value', name: 'Value', kind: 'data', type: { id: 'float' } }], outputs: [{ id: 'result', name: 'Result', kind: 'data', type: { id: 'float' } }], pure: true },
      nodes: [
        { id: 'entry', type: 'core:function.entry', position: { x: 0, y: 0 }, properties: { graph: 'Half' } },
        { id: 'div', type: 'core:math.divide', position: { x: 200, y: 0 }, properties: { 'pin:b': 2 } },
        { id: 'ret', type: 'core:function.return', position: { x: 400, y: 0 }, properties: { graph: 'Half' } }
      ],
      connections: [
        { id: 'c1', fromNode: 'entry', fromPin: 'execOut', toNode: 'ret', toPin: 'execIn' },
        { id: 'c2', fromNode: 'entry', fromPin: 'value', toNode: 'div', toPin: 'a' },
        { id: 'c3', fromNode: 'div', fromPin: 'returnValue', toNode: 'ret', toPin: 'result' }
      ]
    }]
  };
  await write('vendor/combat-graphs/combat.vgraph-package.json', manifest('1.0.0'));
  await write('vendor/combat-graphs/combat.vgraph', JSON.stringify(library, null, 2));
  const api = (vscode.extensions.getExtension(EXTENSION_ID)!.exports as ExtensionApi).testing;
  const type = 'lib:blueprint-packages/combat-graphs/combat.vgraph#Half';

  const target = await vscode.commands.executeCommand<vscode.Uri>('blueprintVisualScripting.addBlueprintPackage', workspaceFile('vendor/combat-graphs'));
  assert.equal(target?.toString(), workspaceFile('blueprint-packages/combat-graphs').toString());
  const added = JSON.parse(await readText(workspaceFile('blueprint-packages/combat-graphs/combat.vgraph'))) as { languages?: string[] };
  assert.ok(added.languages?.includes('python'), `generated for the workspace's Python graphs too: ${JSON.stringify(added.languages)}`);
  assert.ok(fs.existsSync(workspaceFile('blueprint-packages/combat-graphs/combat.vgraph.ts').fsPath), 'TypeScript generated');
  assert.ok(fs.existsSync(workspaceFile('blueprint-packages/combat-graphs/combat_vgraph.py').fsPath), 'Python generated');
  await waitFor(() => api.registry.get(type)?.library?.version === '1.0.0', 'the package version on its nodes', 20000);
  assert.deepEqual(api.registry.get(type)?.library, { name: 'combat-graphs', version: '1.0.0' });

  // A newer version replaces it, without asking.
  await write('vendor/combat-graphs/combat.vgraph-package.json', manifest('2.0.0'));
  await vscode.commands.executeCommand('blueprintVisualScripting.addBlueprintPackage', workspaceFile('vendor/combat-graphs'));
  await waitFor(() => api.registry.get(type)?.library?.version === '2.0.0', 'the new version on its nodes', 20000);
});

test("Add Blueprint Package installs from the registry the workspace's .npmrc names", async () => {
  const library = {
    schemaVersion: 3, name: 'Brawl', kind: 'functionLibrary', language: 'typescript', variables: [],
    graphs: [{
      id: 'Twice', name: 'Twice', kind: 'function', comments: [],
      signature: { inputs: [{ id: 'value', name: 'Value', kind: 'data', type: { id: 'float' } }], outputs: [{ id: 'result', name: 'Result', kind: 'data', type: { id: 'float' } }], pure: true },
      nodes: [
        { id: 'entry', type: 'core:function.entry', position: { x: 0, y: 0 }, properties: { graph: 'Twice' } },
        { id: 'mul', type: 'core:math.multiply', position: { x: 200, y: 0 }, properties: { 'pin:b': 2 } },
        { id: 'ret', type: 'core:function.return', position: { x: 400, y: 0 }, properties: { graph: 'Twice' } }
      ],
      connections: [
        { id: 'c1', fromNode: 'entry', fromPin: 'execOut', toNode: 'ret', toPin: 'execIn' },
        { id: 'c2', fromNode: 'entry', fromPin: 'value', toNode: 'mul', toPin: 'a' },
        { id: 'c3', fromNode: 'mul', fromPin: 'returnValue', toNode: 'ret', toPin: 'result' }
      ]
    }]
  };
  const archive = tarball({
    'package.json': JSON.stringify({ name: '@studio/brawl', version: '1.2.0', blueprint: 'graphs', keywords: ['blueprint-package'] }),
    'graphs/brawl.vgraph-package.json': JSON.stringify({ name: '@studio/brawl', version: '1.2.0', graphs: ['*.vgraph'] }),
    'graphs/brawl.vgraph': JSON.stringify(library, null, 2)
  });
  const authorizations: (string | undefined)[] = [];
  const server = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    if (request.url === '/@studio%2fbrawl') {
      response.end(JSON.stringify({ name: '@studio/brawl', 'dist-tags': { latest: '1.2.0' }, versions: { '1.2.0': { name: '@studio/brawl', version: '1.2.0', blueprint: 'graphs', dist: { tarball: `${base}brawl-1.2.0.tgz` } } } }));
    } else if (request.url === '/brawl-1.2.0.tgz') {
      response.end(archive);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const npmrc = workspaceFile('.npmrc');
  await vscode.workspace.fs.writeFile(npmrc, new TextEncoder().encode(`@studio:registry=http://127.0.0.1:${port}/\n//127.0.0.1:${port}/:_authToken=team-token\n`));
  // The user's own .npmrc is read too; none here, so the test doesn't depend on the machine's.
  const userConfig = process.env.NPM_CONFIG_USERCONFIG;
  process.env.NPM_CONFIG_USERCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vg-npmrc-')), 'none');
  try {
    const target = await vscode.commands.executeCommand<vscode.Uri>('blueprintVisualScripting.addBlueprintPackage', { npm: '@studio/brawl' });
    assert.equal(target?.toString(), workspaceFile('blueprint-packages/studio-brawl').toString());
    assert.ok(fs.existsSync(workspaceFile('blueprint-packages/studio-brawl/brawl.vgraph-package.json').fsPath), 'the Blueprint folder was added');
    assert.ok(!fs.existsSync(workspaceFile('blueprint-packages/studio-brawl/package.json').fsPath), "the npm package's own files weren't");
    assert.ok(fs.existsSync(workspaceFile('blueprint-packages/studio-brawl/brawl.vgraph.ts').fsPath), 'TypeScript generated');
    assert.ok(authorizations.length >= 2 && authorizations.every((a) => a === 'Bearer team-token'), `the token was sent: ${JSON.stringify(authorizations)}`);
  } finally {
    if (userConfig === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
    else process.env.NPM_CONFIG_USERCONFIG = userConfig;
    server.close();
    await vscode.workspace.fs.delete(npmrc);
  }
});

test('the functions of a function library graph become nodes that other graphs import', async () => {
  const write = (name: string, text: string) => vscode.workspace.fs.writeFile(workspaceFile(name), new TextEncoder().encode(text));
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const library = workspaceFile('mathlib/Helpers.vgraph');
  await write('mathlib/Helpers.vgraph', JSON.stringify({
    schemaVersion: 3, name: 'Helpers', kind: 'functionLibrary', language: 'typescript', variables: [],
    graphs: [{
      id: 'DoubleIt', name: 'Double It', kind: 'function', comments: [],
      signature: { pure: true, inputs: [{ id: 'value', name: 'Value', kind: 'data', type: { id: 'float' } }], outputs: [{ id: 'returnValue', name: 'Result', kind: 'data', type: { id: 'float' } }] },
      nodes: [node('entry', 'core:function.entry', { graph: 'DoubleIt' }), node('mul', 'core:math.multiply', { 'pin:b': 2 }), node('return', 'core:function.return', { graph: 'DoubleIt' })],
      connections: [
        { id: 'c1', fromNode: 'entry', fromPin: 'execOut', toNode: 'return', toPin: 'execIn' },
        { id: 'c2', fromNode: 'entry', fromPin: 'value', toNode: 'mul', toPin: 'a' },
        { id: 'c3', fromNode: 'mul', fromPin: 'returnValue', toNode: 'return', toPin: 'returnValue' }
      ]
    }]
  }, null, 2));
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', library);
  assert.match(await readText(workspaceFile('mathlib/Helpers.vgraph.ts')), /^export function doubleIt\(value: number\): number \{$/m);

  const caller = workspaceFile('uses-lib.vgraph');
  await write('uses-lib.vgraph', projectGraph('UsesLib', 'typescript', 'fn:typescript:mathlib/Helpers.vgraph.ts#doubleIt'));
  await compileOnceFound(caller);
  assert.match(await readText(workspaceFile('uses-lib.vgraph.ts')), /^import \{ doubleIt \} from "\.\/mathlib\/Helpers\.vgraph\.ts";$/m);
});

test('the macros of a macro library graph are expanded in the graphs that use them', async () => {
  const write = (name: string, text: string) => vscode.workspace.fs.writeFile(workspaceFile(name), new TextEncoder().encode(text));
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const wire = (id: string, fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id, fromNode, fromPin, toNode, toPin });
  await write('mathlib/Shared.vgraph', JSON.stringify({
    schemaVersion: 3, name: 'Shared', kind: 'macroLibrary', language: 'typescript', variables: [],
    graphs: [{
      id: 'Announce', name: 'Announce', kind: 'macro', comments: [],
      signature: { inputs: [{ id: 'in', name: 'In', kind: 'exec' }], outputs: [{ id: 'out', name: 'Out', kind: 'exec' }] },
      nodes: [node('inputs', 'core:macro.inputs', { graph: 'Announce' }), node('print', 'core:console.print', { 'pin:value': 'from the library' }), node('outputs', 'core:macro.outputs', { graph: 'Announce' })],
      connections: [wire('c1', 'inputs', 'in', 'print', 'execIn'), wire('c2', 'print', 'execOut', 'outputs', 'out')]
    }]
  }, null, 2));
  const caller = workspaceFile('uses-macro.vgraph');
  await write('uses-macro.vgraph', JSON.stringify({
    schemaVersion: 3, name: 'UsesMacro', kind: 'class', language: 'typescript', variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('m', 'macro:mathlib/Shared.vgraph#Announce')],
      connections: [wire('c1', 's', 'execOut', 'm', 'in')]
    }]
  }, null, 2));
  const deadline = Date.now() + 15000;
  for (;;) {
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', caller);
    const problems = vscode.languages.getDiagnostics(caller);
    if (!problems.length) break;
    if (Date.now() > deadline) throw new Error(`The macro library was never found: ${problems.map((p) => p.message).join('; ')}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.match(await readText(workspaceFile('uses-macro.vgraph.ts')), /\/\/ Announce: Print \(m\)\n\s*console\.log\("from the library"\);/);
});

test('structs and enums in the workspace become types and nodes that graphs import', async () => {
  const write = (name: string, text: string) => vscode.workspace.fs.writeFile(workspaceFile(name), new TextEncoder().encode(text));
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const team = workspaceFile('types/Faction.vgraph');
  await write('types/Faction.vgraph', JSON.stringify({
    schemaVersion: 3, name: 'Faction', kind: 'enumeration', language: 'typescript', variables: [], graphs: [],
    enumerators: [{ id: 'red', name: 'Red' }, { id: 'blue', name: 'Light Blue' }]
  }, null, 2));
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', team);
  assert.match(await readText(workspaceFile('types/Faction.vgraph.ts')), /^export const Faction = \{$/m);

  const caller = workspaceFile('uses-team.vgraph');
  await write('uses-team.vgraph', JSON.stringify({
    schemaVersion: 3, name: 'UsesTeam', kind: 'class', language: 'typescript', variables: [{ id: 'side', name: 'Side', type: { id: 'enum:Faction' }, defaultValue: 'blue' }],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('get', 'core:variable.get', { variable: 'side' }), node('switch', 'enum:Faction.switch'), node('p', 'core:console.print', { 'pin:value': 'blue' })],
      connections: [
        { id: 'c1', fromNode: 's', fromPin: 'execOut', toNode: 'switch', toPin: 'execIn' },
        { id: 'c2', fromNode: 'get', fromPin: 'value', toNode: 'switch', toPin: 'selection' },
        { id: 'c3', fromNode: 'switch', fromPin: 'blue', toNode: 'p', toPin: 'execIn' }
      ]
    }]
  }, null, 2));
  await compileOnceFound(caller);
  const text = await readText(workspaceFile('uses-team.vgraph.ts'));
  assert.match(text, /^import \{ Faction \} from "\.\/types\/Faction\.vgraph\.ts";$/m);
  assert.match(text, /Side: Faction = Faction\.LightBlue;/);
});

// The utility nodes (src/core/utilities.ts) are built in: a workspace with no node files of its own
// uses them, and their generated code runs.
test('the utility nodes are built in: a graph uses Slugify with nothing in the workspace', async () => {
  const graph = workspaceFile('slug.vgraph');
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify({
    schemaVersion: 3, name: 'Slug', kind: 'class', language: 'javascript', variables: [], metadata: {},
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('slug', 'core:string.slugify', { 'pin:text': 'Café au lait!' }), node('p', 'core:console.print')],
      connections: [
        { id: 'c1', fromNode: 's', fromPin: 'execOut', toNode: 'p', toPin: 'execIn' },
        { id: 'c2', fromNode: 'slug', fromPin: 'returnValue', toNode: 'p', toPin: 'value' }
      ]
    }]
  }, null, 2)));
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
  assert.deepEqual(vscode.languages.getDiagnostics(graph).map((d) => d.message), []);
  const generated = workspaceFile('slug.vgraph.js');
  const { execFileSync } = await import('node:child_process');
  const run = `const { Slug } = await import(${JSON.stringify(generated.toString())}); new Slug().start();`;
  assert.equal(execFileSync(process.platform === 'win32' ? 'node.exe' : 'node', ['--input-type=module', '-e', run], { encoding: 'utf8' }).trim(), 'caf-au-lait');
});

// docs/multi-language.md, gap 2: one struct for a TypeScript front end and a Python back end.
test('a shared struct is generated for each of its languages, and graphs in each use it', async () => {
  const write = (name: string, doc: unknown) => vscode.workspace.fs.writeFile(workspaceFile(name), new TextEncoder().encode(JSON.stringify(doc, null, 2)));
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const vec = { schemaVersion: 3, name: 'Vec', kind: 'structure', language: 'typescript', languages: ['python'], graphs: [], variables: [{ id: 'x', name: 'X', type: { id: 'float' }, defaultValue: 1 }] };
  await write('shared/Vec.vgraph', vec);
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', workspaceFile('shared/Vec.vgraph'));
  assert.match(await readText(workspaceFile('shared/Vec.vgraph.ts')), /class Vec/);
  assert.match(await readText(workspaceFile('shared/vec_vgraph.py')), /^class Vec/m);

  await write('uses_vec.vgraph', {
    schemaVersion: 3, name: 'UsesVec', kind: 'class', language: 'python', variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('make', 'struct:Vec.make'), node('p', 'core:console.print')],
      connections: [{ id: 'c1', fromNode: 's', fromPin: 'execOut', toNode: 'p', toPin: 'execIn' }, { id: 'c2', fromNode: 'make', fromPin: 'struct', toNode: 'p', toPin: 'value' }]
    }]
  });
  await compileOnceFound(workspaceFile('uses_vec.vgraph'));
  assert.match(await readText(workspaceFile('uses_vec_vgraph.py')), /^from [\w.]*vec_vgraph import Vec$/m);

  // Python no longer among its languages: its generated file goes. (Edited through its open
  // document, which a write to the file would update only later.)
  const open = await vscode.workspace.openTextDocument(workspaceFile('shared/Vec.vgraph'));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(open.uri, new vscode.Range(0, 0, open.lineCount, 0), JSON.stringify({ ...vec, languages: undefined }, null, 2));
  await vscode.workspace.applyEdit(edit);
  await open.save();
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', open.uri);
  assert.equal(fs.existsSync(workspaceFile('shared/vec_vgraph.py').fsPath), false);
});

// What activation returns (src/extension/extension.ts), as far as these tests use it.
// A call flow as the map draws it.
interface CallScene {
  mode: string;
  calls?: { root?: string; starts: number; direction: string; depth: number; path?: { from: string; to: string; length?: number } };
  boxes: { id: string; root?: boolean; kind: string }[];
  arrows: { kind: string; from: string; to: string }[];
}

interface ExtensionApi {
  testing: ExtensionInternals;
}

// The public part (src/core/api.ts).
interface PublicApi {
  apiVersion: number;
  registerLanguagePack(pack: LanguagePack): vscode.Disposable;
  registerDeclarativePack(definition: unknown): vscode.Disposable;
  registerNodeLibrary(library: { name: string; version: string; nodes: NodeDefinition[]; dependencies?: Record<string, string> }): vscode.Disposable;
}

interface ExtensionInternals {
  marks: { breakpoints: { set(uri: vscode.Uri, breakpoints: { graphId: string; nodeId: string; enabled: boolean }[]): Promise<void> } };
  provider: {
    currentDebug(): {
      stack?: { graphId: string; nodeId: string; nodeName: string; uri: vscode.Uri; external?: boolean }[];
      act(action: string): void;
      read(file: vscode.Uri, pins: { graphId: string; nodeId: string; pinId: string }[]): Promise<{ value?: string; unavailable?: string }[]>;
    } | undefined;
    goToDefinition(from: vscode.Uri, nodeType: string, site: DefinitionSite): Promise<void>;
  };
  registry: { get(type: string): NodeDefinition | undefined };
  codeMap: {
    codeIndex(folder: vscode.WorkspaceFolder): Promise<{
      entities: { id: string; kind: string; parent?: string; entries?: unknown[] }[];
      imports: { from: string; to: string }[];
      unresolved: unknown[];
      calls: { from: string; to: string; path: string; line: number; column: number; certain: boolean }[];
    }>;
    definitionAt(folder: vscode.WorkspaceFolder, path: string, line: number, column: number): Promise<string | undefined>;
    flowchart(folder: vscode.WorkspaceFolder, path: string, line: number): Promise<{ name: string; nodes: { kind: string; label: string }[] } | undefined>;
    onDidChange: vscode.Event<vscode.WorkspaceFolder>;
  };
  codeMapPanels: {
    toggleIn(folder: vscode.WorkspaceFolder, id: string): Promise<{ boxes: { id: string; kind: string; parent?: string; expanded: boolean }[] } | undefined>;
    callsIn(folder: vscode.WorkspaceFolder, id?: string, direction?: 'callees' | 'callers' | 'both'): Promise<CallScene | undefined>;
    pathIn(folder: vscode.WorkspaceFolder, from: string, to: string): Promise<CallScene | undefined>;
    historyIn(folder: vscode.WorkspaceFolder, direction: 'back' | 'forward'): Promise<CallScene | undefined>;
    flowIn(folder: vscode.WorkspaceFolder, id: string): Promise<{ mode: string; flow?: { label: string }; boxes: { flowKind?: string }[] } | undefined>;
    modeIn(folder: vscode.WorkspaceFolder, mode: 'architecture' | 'structure' | 'calls'): Promise<{
      mode: string;
      boxes: { id: string; members?: string[] }[];
      arrows: { kind: string; from: string; to: string }[];
    } | undefined>;
    hoverIn(folder: vscode.WorkspaceFolder, id: string): Promise<{ signature: string; doc?: string } | undefined>;
    exposeIn(folder: vscode.WorkspaceFolder, id: string, given: { names?: string[]; pure?: boolean }): Promise<string[] | undefined>;
    openIn(folder: vscode.WorkspaceFolder, id: string): Promise<void>;
  };
  structureTree: {
    getChildren(node?: { folder: vscode.WorkspaceFolder; id?: string }): Promise<{ folder: vscode.WorkspaceFolder; id?: string }[]>;
    getParent(node: { folder: vscode.WorkspaceFolder; id?: string }): Promise<{ folder: vscode.WorkspaceFolder; id?: string } | undefined>;
    getTreeItem(node: { folder: vscode.WorkspaceFolder; id?: string }): Promise<vscode.TreeItem>;
    resolveTreeItem(item: vscode.TreeItem, node: { folder: vscode.WorkspaceFolder; id?: string }): Promise<vscode.TreeItem>;
  };
}

// The public API, as another extension uses it (docs/language-breadth.md): a language pack and a
// node library registered while the extension runs, then removed.
test('another extension registers a language pack and a node library, then removes them', async () => {
  // As another extension gets it: activating returns the API.
  const api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as PublicApi;
  assert.equal(api.apiVersion, 1);
  assert.throws(() => api.registerLanguagePack({ ...javascriptPack, id: 'echo', displayName: 'Echo', apiVersion: 99 }), /built for API version 99/);
  const pack = api.registerLanguagePack({
    ...javascriptPack, id: 'echo', displayName: 'Echo', apiVersion: 1,
    generator: { ...javascriptPack.generator!, outputFileName: (name: string) => `${name}.echo.js` }
  });
  const library = api.registerNodeLibrary({
    name: 'greetings', version: '1.0.0',
    nodes: [{
      type: 'greetings:hello', version: 1, displayName: 'Hello', category: 'Greetings',
      inputs: [{ id: 'execIn', name: '', kind: 'exec', direction: 'input' }, { id: 'name', name: 'Name', kind: 'data', direction: 'input', type: { id: 'string' } }],
      outputs: [{ id: 'execOut', name: '', kind: 'exec', direction: 'output' }, { id: 'result', name: 'Result', kind: 'data', direction: 'output', type: { id: 'string' } }],
      implementation: { kind: 'code', languages: { javascript: "return 'Hello, ' + ${name};" } }
    }]
  });
  const graph = workspaceFile('echo.vgraph');
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify({
    schemaVersion: 3, name: 'Echo', kind: 'class', language: 'echo', variables: [], metadata: {},
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('h', 'greetings:hello', { 'pin:name': 'graphs' })],
      connections: [{ id: 'c', fromNode: 's', fromPin: 'execOut', toNode: 'h', toPin: 'execIn' }]
    }]
  }, null, 2)));
  try {
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
    assert.match(await readText(workspaceFile('echo.vgraph.echo.js')), /return 'Hello, ' \+ name;/);
    assert.deepEqual(vscode.languages.getDiagnostics(graph), []);
  } finally {
    library.dispose();
    pack.dispose();
  }
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
  assert.match(vscode.languages.getDiagnostics(graph).map((d) => d.message).join(' '), /Unknown graph language "echo"/);
});

// Declarative packs (docs/language-breadth.md): a workspace's *.vgraph-language.json file is loaded as
// a language pack, its problems shown on the file; the API refuses a definition with problems.
test('a declarative pack loads from a workspace file, and its problems show on the file', async () => {
  const api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as PublicApi;
  assert.throws(() => api.registerDeclarativePack({ id: 'Bad' }), /can't be registered:[\s\S]*"id" must be/);
  const definition = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../test/fixtures/declarative/minijs.vgraph-language.json'), 'utf8')) as { templates: Record<string, string> };
  const file = workspaceFile('mini.vgraph-language.json');
  const write = (value: unknown) => vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(value, null, 2)));
  const graph = workspaceFile('mini.vgraph');
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify({
    schemaVersion: 3, name: 'Mini', kind: 'class', language: 'minijs', variables: [], metadata: {},
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('p', 'core:console.print', { 'pin:value': 'hi from a workspace pack' })],
      connections: [{ id: 'c', fromNode: 's', fromPin: 'execOut', toNode: 'p', toPin: 'execIn' }]
    }]
  }, null, 2)));
  const generated = workspaceFile('mini.vgraph.mini.js');
  try {
    await write(definition);
    const deadline = Date.now() + 15000;
    while (!(await exists(generated)) && Date.now() < deadline) {
      await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.match(await readText(generated), /console\.log\("hi from a workspace pack"\);/);

    await write({ ...definition, templates: { ...definition.templates, file: '{{#if library}}' } });
    await waitFor(() => vscode.languages.getDiagnostics(file).length > 0, "the definition's problems on its file");
    assert.match(vscode.languages.getDiagnostics(file)[0].message, /^file: \{\{#if\}\} is never closed/);
  } finally {
    await vscode.workspace.fs.delete(file);
  }
  await waitFor(() => vscode.languages.getDiagnostics(file).length === 0, 'the problems to go with the file');
});

// Phase 6's exit check (docs/language-breadth.md): the C pack is a separate extension
// (examples/c-language-pack) that registers a declarative definition through the public API alone.
test('exit check: a separate extension adds C, and its graphs compile and run', async () => {
  assert.ok(vscode.extensions.getExtension('local.blueprint-c-language-pack'), 'the C pack extension is loaded');
  const graph = workspaceFile('hello_c.vgraph');
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify({
    schemaVersion: 3, name: 'HelloC', kind: 'class', language: 'c', variables: [], metadata: {},
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('sq', 'core:math.sqrt', { 'pin:value': 2.25 }), node('p', 'core:console.print')],
      connections: [
        { id: 'c1', fromNode: 's', fromPin: 'execOut', toNode: 'p', toPin: 'execIn' },
        { id: 'c2', fromNode: 'sq', fromPin: 'returnValue', toNode: 'p', toPin: 'value' }
      ]
    }]
  }, null, 2)));
  const generated = workspaceFile('hello_c_vgraph.c');
  // The C extension activates once startup finishes.
  const deadline = Date.now() + 30000;
  while (!(await exists(generated)) && Date.now() < deadline) {
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(await exists(generated), `It doesn't compile: ${vscode.languages.getDiagnostics(graph).map((d) => d.message).join('; ')}`);
  const text = await readText(generated);
  assert.match(text, /static double HelloC_core_math_sqrt|static double HelloC_math_sqrt/);
  const { execFileSync } = await import('node:child_process');
  const main = path.join(path.dirname(generated.fsPath), 'hello_c_main.c');
  fs.writeFileSync(main, `#include "hello_c_vgraph.c"
int main(void) { vg_program_start(); return 0; }
`);
  const program = path.join(path.dirname(generated.fsPath), process.platform === 'win32' ? 'hello_c.exe' : 'hello_c');
  try {
    execFileSync('gcc', ['-std=gnu11', '-w', '-o', program, main, '-lm']);
  } catch {
    throw new Skip('gcc is not available');
  }
  assert.equal(execFileSync(program, { encoding: 'utf8' }).trim(), '1.5');
});

// Node library packages (docs/language-breadth.md, "Node library versioning"): a workspace package's
// problems show on its manifest and clear when an extension registers its dependency; a graph made
// with an older major version of a package compiles with a warning on its nodes.
test('node packages resolve with extension libraries, and graphs remember their versions', async () => {
  const api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as PublicApi;
  const write = (name: string, value: unknown) => vscode.workspace.fs.writeFile(workspaceFile(name), new TextEncoder().encode(JSON.stringify(value, null, 2)));
  const manifest = workspaceFile('packages/combat/combat.vgraph-package.json');
  await write('packages/combat/Hit.node.json', {
    type: 'combat:hit', version: 1, displayName: 'Hit', category: 'Combat',
    inputs: [{ id: 'execIn', name: '', kind: 'exec', direction: 'input' }],
    outputs: [{ id: 'execOut', name: '', kind: 'exec', direction: 'output' }],
    implementation: { kind: 'code', languages: { javascript: 'console.log("hit");' } }
  });
  await write('packages/combat/combat.vgraph-package.json', { name: 'combat-nodes', version: '2.0.0', nodes: ['*.node.json'], dependencies: { 'math-nodes': '^1.0.0' } });
  await waitFor(() => vscode.languages.getDiagnostics(manifest).length > 0, 'the missing dependency on the manifest');
  assert.equal(vscode.languages.getDiagnostics(manifest)[0].message, "combat-nodes needs math-nodes ^1.0.0, which isn't installed.");
  const math = api.registerNodeLibrary({ name: 'math-nodes', version: '1.4.0', nodes: [] });
  try {
    await waitFor(() => vscode.languages.getDiagnostics(manifest).length === 0, 'the dependency an extension registered');
    const graph = workspaceFile('hit.vgraph');
    const node = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, properties: {} });
    await write('hit.vgraph', {
      schemaVersion: 3, name: 'HitIt', kind: 'class', language: 'javascript', variables: [], metadata: { libraries: { 'combat-nodes': '1.3.0' } },
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [node('s', 'core:event.start'), node('h', 'combat:hit')],
        connections: [{ id: 'c', fromNode: 's', fromPin: 'execOut', toNode: 'h', toPin: 'execIn' }]
      }]
    });
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
    assert.ok(await exists(workspaceFile('hit.vgraph.js')), 'it compiles');
    assert.match(vscode.languages.getDiagnostics(graph).map((d) => d.message).join('\n'), /combat-nodes is now version 2\.0\.0, a new major version \(this graph was made with 1\.3\.0\)/);
  } finally {
    math.dispose();
    await vscode.workspace.fs.delete(workspaceFile('packages'), { recursive: true });
  }
});

// Output plans (docs/output-placement.md): a pack registering its generated files with a build.
// It owns a list of every generated file, and adds a fenced block to the user's build.txt once,
// when the user agrees; after that, only the block's lines change.
test("a pack's output plan owns a file and adds a fenced block to the user's build file, with consent", async () => {
  const api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as PublicApi & { testing: { outputPlans: { ask: (hook: { id: string }) => Promise<string> } } };
  const asked: string[] = [];
  let answer = 'decline';
  api.testing.outputPlans.ask = async (hook) => {
    asked.push(hook.id);
    return answer;
  };
  const pack = api.registerLanguagePack({
    ...javascriptPack, id: 'built', displayName: 'Built', apiVersion: 1,
    generator: {
      ...javascriptPack.generator!,
      outputFileName: (name: string) => `${name}.built.js`,
      placement: (context) => ({
        ownedFiles: [{ path: 'vgraph-sources.txt', text: context.generatedFiles.map((f) => `${f}\n`).join('') }],
        hooks: [{ id: 'build-include', file: 'build.txt', description: 'Add vgraph-sources.txt to build.txt', block: { begin: '# vgraph:begin', end: '# vgraph:end', text: `sources ${context.generatedFiles.length}` } }]
      })
    }
  });
  const graph = (name: string) => workspaceFile(`${name}.vgraph`);
  const write = (name: string) => vscode.workspace.fs.writeFile(graph(name), new TextEncoder().encode(JSON.stringify({
    schemaVersion: 3, name, kind: 'class', language: 'built', variables: [], metadata: {},
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [{ id: 's', type: 'core:event.start', position: { x: 0, y: 0 }, properties: {} }], connections: [] }]
  }, null, 2)));
  const text = (name: string) => fs.readFileSync(workspaceFile(name).fsPath, 'utf8');
  fs.writeFileSync(workspaceFile('build.txt').fsPath, 'project demo\n');
  try {
    await write('BuiltOne');
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph('BuiltOne'));
    assert.equal(text('vgraph-sources.txt'), 'BuiltOne.vgraph.built.js\n');
    await waitFor(() => asked.length === 1, 'the hook to be proposed');
    assert.match(vscode.languages.getDiagnostics(graph('BuiltOne')).map((d) => d.message).join(' '), /isn't registered with the build yet: Add vgraph-sources.txt to build.txt/);
    assert.equal(text('build.txt'), 'project demo\n', 'declined: the file is untouched');

    // Declined: not asked again, until the command offers it again; then accepted.
    await write('BuiltTwo');
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph('BuiltTwo'));
    assert.equal(asked.length, 1);
    assert.equal(text('vgraph-sources.txt'), 'BuiltOne.vgraph.built.js\nBuiltTwo.vgraph.built.js\n');
    answer = 'accept';
    await vscode.commands.executeCommand('blueprintVisualScripting.registerGeneratedFiles');
    await waitFor(() => asked.length === 2, 'the hook to be offered again');
    await waitFor(() => text('build.txt').includes('# vgraph:begin'), 'the block to be added');
    assert.equal(text('build.txt'), 'project demo\n# vgraph:begin\nsources 2\n# vgraph:end\n');

    // Deleting a graph updates the owned file and the block's lines without asking.
    const remove = new vscode.WorkspaceEdit();
    remove.deleteFile(graph('BuiltTwo'));
    await vscode.workspace.applyEdit(remove);
    await waitFor(() => text('build.txt').includes('sources 1'), 'the block to follow the delete');
    assert.equal(text('vgraph-sources.txt'), 'BuiltOne.vgraph.built.js\n');
    assert.equal(asked.length, 2);
  } finally {
    pack.dispose();
  }
});

test("Compile writes a graph's tests to their own file; Run Tests and Simulate Tests run them", async () => {
  const graph = workspaceFile('tested.vgraph');
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const document = {
    schemaVersion: 3, name: 'Tested', kind: 'class', language: 'javascript', variables: [], metadata: {},
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('t', 'core:test.case', { name: 'Holds' }), node('a', 'core:test.assert-true', { 'pin:condition': true })],
      connections: [{ id: 'c', fromNode: 't', fromPin: 'execOut', toNode: 'a', toPin: 'execIn' }]
    }]
  };
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify(document, null, 2)));
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
  const tests = workspaceFile('tested.vgraph.test.js');
  assert.match(await readText(tests), /test\("Holds", \(\) => \{\n {2}new Tested\(\)\.testHolds\(\);/);
  await vscode.commands.executeCommand('blueprintVisualScripting.runTests', graph);
  await vscode.commands.executeCommand('blueprintVisualScripting.simulateTests', graph);

  // Without tests, the test file goes.
  await editGraph(graph, (g) => {
    const [events] = g.graphs as { nodes: unknown[]; connections: unknown[] }[];
    events.nodes = [];
    events.connections = [];
  });
  await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
  assert.equal(await exists(tests), false);
});

// docs/audit.md, third pass: Simulate runs in a worker, so a graph that would run for hours (a loop
// in a loop, each inside the loop limit) leaves the extension host free (this test runs in it), shows
// Running in the Blueprint Debugger, and Stop ends it.
test('Simulate Tests of a graph that runs for hours returns at once, and Stop ends it', async () => {
  const api = ((await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ExtensionApi).testing;
  const graph = workspaceFile('long.vgraph');
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const wire = (from: string, fromPin: string, to: string) => ({ id: `${from}-${to}`, fromNode: from, fromPin, toNode: to, toPin: 'execIn' });
  const document = {
    schemaVersion: 3, name: 'Long', kind: 'class', language: 'javascript', variables: [], metadata: {},
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('t', 'core:test.case', { name: 'Long' }), node('outer', 'core:flow.for-loop', { 'pin:lastIndex': 999999 }), node('inner', 'core:flow.for-loop', { 'pin:lastIndex': 999999 })],
      connections: [wire('t', 'execOut', 'outer'), wire('outer', 'loopBody', 'inner')]
    }]
  };
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify(document, null, 2)));
  try {
    await vscode.commands.executeCommand('blueprintVisualScripting.simulateTests', graph);
    await waitFor(() => !!api.provider.currentDebug(), 'Simulate to show as running', 5000);
    assert.equal(api.provider.currentDebug()!.stack, undefined, 'running, not paused');
    await vscode.commands.executeCommand('blueprintVisualScripting.debug.stop');
    await waitFor(() => !api.provider.currentDebug(), 'Stop to end it', 5000);
  } finally {
    api.provider.currentDebug()?.act('stop');
    await vscode.workspace.fs.delete(graph);
  }
});

// Debugs the sample in `language`: stops at a breakpoint on Add, reads its result before and after
// it runs, steps node by node to the Print, and runs to the end.
async function debugSample(language: string, generatedFile: string, folder = ''): Promise<void> {
  const name = `${folder ? `${folder}/` : ''}debug_${language}.vgraph`;
  const graph = workspaceFile(name);
  // An earlier test switched demo.vgraph to Python; each language gets its own copy.
  const sample = JSON.parse(await readText(workspaceFile('demo.vgraph'))) as { name: string; language: string };
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify({ ...sample, name: 'DebugMe', language }, null, 2)));
  await openInGraphEditor(name);
  const api = (vscode.extensions.getExtension(EXTENSION_ID)!.exports as ExtensionApi).testing;
  await api.marks.breakpoints.set(graph, [{ graphId: 'EventGraph', nodeId: 'add_1', enabled: true }]);
  try {
    await vscode.commands.executeCommand('blueprintVisualScripting.debug', graph);
    const paused = () => api.provider.currentDebug()?.stack;
    await waitFor(() => !!paused(), 'the debugger to stop at the breakpoint', 180000);
    assert.deepEqual(paused()![0], { ...paused()![0], graphId: 'EventGraph', nodeId: 'add_1' });
    const mirrored = vscode.debug.breakpoints.filter((b) => b instanceof vscode.SourceBreakpoint && b.location.uri.fsPath.endsWith(generatedFile));
    assert.equal(mirrored.length, 1, 'the graph breakpoint is mirrored into the generated file');
    const debug = api.provider.currentDebug()!;
    const result = [{ graphId: 'EventGraph', nodeId: 'add_1', pinId: 'result' }];
    assert.deepEqual(await debug.read(graph, result), [{ value: '0' }], "Add hasn't run yet");

    // Each step moves one node. Some compilers drop the Branch on the constant true, so the step
    // from Add may land on the Print directly.
    const visited: string[] = [];
    for (let i = 0; i < 3 && paused()?.[0].nodeId !== 'print_true'; i++) {
      const from = paused()![0].nodeId;
      debug.act('stepOver');
      await waitFor(() => !!paused() && paused()![0].nodeId !== from, 'Step Over to reach the next node', 60000);
      visited.push(paused()![0].nodeId);
    }
    assert.ok(['print_true', 'branch_1,print_true'].includes(visited.join(',')), `stepped through ${visited.join(', ')}`);
    assert.deepEqual(await debug.read(graph, result), [{ value: '30' }]);
    // VS Code showed the generated code where it stopped; the graph editor is in front instead.
    await waitFor(() => activeCustomEditor()?.uri.toString() === graph.toString(), 'the graph editor to come back to the front');

    debug.act('resume');
    await waitFor(() => !api.provider.currentDebug(), 'the session to end', 60000);
  } finally {
    api.provider.currentDebug()?.act('stop');
    await api.marks.breakpoints.set(graph, []);
  }
}

// Phase 5's exit check (docs/debugging.md): Start calls Twice(21) and prints the result. With
// breakpoints on the call and on Twice's Return: stop at the call, Step Into Twice, read its input,
// Resume to the Return, read the sum, Step Out to the caller, and run to the end.
async function exitCheck(language: string, folder = ''): Promise<void> {
  const name = `${folder ? `${folder}/` : ''}exit_${language}.vgraph`;
  const graph = workspaceFile(name);
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const wire = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}`, fromNode, fromPin, toNode, toPin });
  const number = { id: 'float' };
  const document = {
    schemaVersion: 3, name: 'ExitCheck', kind: 'class', language, variables: [], metadata: {},
    graphs: [
      {
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [node('start', 'core:event.start'), node('call', 'core:function.call', { graph: 'Twice', 'pin:n': 21 }), node('print', 'core:console.print')],
        connections: [wire('start', 'execOut', 'call', 'execIn'), wire('call', 'execOut', 'print', 'execIn'), wire('call', 'result', 'print', 'value')]
      },
      {
        id: 'Twice', name: 'Twice', kind: 'function', comments: [],
        signature: { inputs: [{ id: 'n', name: 'N', kind: 'data', type: number }], outputs: [{ id: 'result', name: 'Result', kind: 'data', type: number }] },
        nodes: [node('entry', 'core:function.entry', { graph: 'Twice' }), node('add', 'core:math.add'), node('ret', 'core:function.return', { graph: 'Twice' })],
        connections: [wire('entry', 'execOut', 'add', 'execIn'), wire('entry', 'n', 'add', 'a'), { ...wire('entry', 'n', 'add', 'b'), id: 'entry.n.b' }, wire('add', 'execOut', 'ret', 'execIn'), wire('add', 'result', 'ret', 'result')]
      }
    ]
  };
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify(document, null, 2)));
  await openInGraphEditor(name);
  const api = (vscode.extensions.getExtension(EXTENSION_ID)!.exports as ExtensionApi).testing;
  await api.marks.breakpoints.set(graph, [{ graphId: 'EventGraph', nodeId: 'call', enabled: true }, { graphId: 'Twice', nodeId: 'ret', enabled: true }]);
  const stack = () => api.provider.currentDebug()?.stack?.filter((f) => !f.external).map((f) => `${f.graphId}/${f.nodeId}`);
  const until = (what: string, ready: (frames: string[]) => boolean) => waitFor(() => !!stack() && ready(stack()!), what, 60000)
    .catch((error: Error) => { throw new Error(`${error.message}; the stack: ${JSON.stringify(api.provider.currentDebug()?.stack ?? 'running')}`); });
  try {
    await vscode.commands.executeCommand('blueprintVisualScripting.debug', graph);
    await until('the stop at the call', (frames) => frames[0] === 'EventGraph/call');
    const debug = api.provider.currentDebug()!;

    debug.act('stepInto');
    await until('Step Into Twice', (frames) => frames[0] !== 'EventGraph/call');
    assert.deepEqual(stack(), ['Twice/add', 'EventGraph/call'], 'the call stack, in graph terms');
    assert.equal(api.provider.currentDebug()!.stack!.length, 2, 'the code that started the program is left out');
    assert.deepEqual(await debug.read(graph, [{ graphId: 'Twice', nodeId: 'entry', pinId: 'n' }]), [{ value: '21' }]);

    debug.act('resume');
    await until('the stop at the Return', (frames) => frames[0] === 'Twice/ret');
    assert.deepEqual(await debug.read(graph, [{ graphId: 'Twice', nodeId: 'add', pinId: 'result' }]), [{ value: '42' }]);

    debug.act('stepOut');
    await until('Step Out to the caller', (frames) => frames.length === 1);
    assert.ok(['EventGraph/call', 'EventGraph/print'].includes(stack()![0]), stack()![0]);

    debug.act('resume');
    await waitFor(() => !api.provider.currentDebug(), 'the session to end', 60000);
  } finally {
    api.provider.currentDebug()?.act('stop');
    await api.marks.breakpoints.set(graph, []);
  }
}

test('exit check: debugging a function graph in generated TypeScript', () => exitCheck('typescript'));

test('exit check: debugging a function graph in generated JavaScript', () => exitCheck('javascript'));

test('exit check: debugging a function graph in generated Python', async () => {
  if (!vscode.extensions.getExtension('ms-python.debugpy')) throw new Skip('the Python Debugger extension is not loaded');
  await exitCheck('python');
});

// Phase 13's exit check (docs/code-classes-as-parents.md, part 4): a graph class extending a class
// from the code, debugged across the boundary. The code's Actor has an overridable hit and a template
// method turn that calls it; Knight's Event hit prints and calls Parent: hit; Arena constructs a Knight
// and runs turn. A breakpoint in Event hit stops when the code calls it; Step Into the Parent call
// reaches the code's hit, and Step Out comes back to the graph.
const ACTOR_SOURCES = {
  typescript: [
    '/** @blueprint */',
    'export abstract class Actor {',
    '  /** @blueprint */',
    '  health = 100;',
    '  readonly name: string;',
    '  /** @blueprint */',
    '  constructor(name: string) {',
    '    this.name = name;',
    '  }',
    '  /** @blueprint overridable */',
    '  hit(damage: number): void {',
    '    this.health -= damage;',
    '    console.log(`${this.name} takes ${damage}`);',
    '  }',
    '  /** @blueprint */',
    '  abstract describe(): string;',
    '  /** @blueprint */',
    '  turn(): void {',
    '    console.log(`${this.name} is ${this.describe()}`);',
    '    this.hit(3);',
    '  }',
    '}',
    ''
  ],
  python: [
    'from abc import ABC, abstractmethod',
    '',
    '',
    'class Actor(ABC):',
    '    """@blueprint"""',
    '',
    '    def __init__(self, name: str) -> None:',
    '        """@blueprint"""',
    '        self.name = name',
    '        self.health = 100',
    '',
    '    def hit(self, damage: int) -> None:',
    '        """@blueprint overridable"""',
    '        self.health -= damage',
    '        print(f"{self.name} takes {damage}")',
    '',
    '    @abstractmethod',
    '    def describe(self) -> str:',
    '        """@blueprint"""',
    '',
    '    def turn(self) -> None:',
    '        """@blueprint"""',
    '        print(f"{self.name} is {self.describe()}")',
    '        self.hit(3)',
    ''
  ]
};

async function codeParentDebug(language: 'typescript' | 'python'): Promise<void> {
  const prefix = language === 'typescript' ? 'Ts' : 'Py';
  const actorPath = language === 'typescript' ? 'parents/actor.ts' : 'parents_py/actor.py';
  const write = (name: string, text: string) => vscode.workspace.fs.writeFile(workspaceFile(name), new TextEncoder().encode(text));
  const lines = ACTOR_SOURCES[language];
  await write(actorPath, lines.join('\n'));
  if (language === 'python') await write('parents_py/__init__.py', '');
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const wire = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
  const actor = `code:${language}:${actorPath}#Actor`;
  const knightName = `${prefix}Knight`;
  const knight = {
    schemaVersion: 3, name: knightName, kind: 'class', language, parent: actor, variables: [],
    graphs: [
      {
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [node('hit', 'core:event.override', { method: 'hit' }), node('p2', 'core:console.print', { 'pin:value': 'Knight blocks' }), node('parent', 'core:object.parent', { function: 'hit' })],
        connections: [wire('hit', 'execOut', 'p2', 'execIn'), wire('p2', 'execOut', 'parent', 'execIn'), wire('hit', 'damage', 'parent', 'damage')]
      },
      {
        id: 'Describe', name: 'describe', kind: 'function', comments: [],
        signature: { inputs: [], outputs: [{ id: 'returnValue', name: 'Return Value', kind: 'data', type: { id: 'string' } }] },
        nodes: [node('entry', 'core:function.entry', { graph: 'Describe' }), node('return', 'core:function.return', { graph: 'Describe', 'pin:returnValue': 'a knight' })],
        connections: [wire('entry', 'execOut', 'return', 'execIn')]
      }
    ]
  };
  const arena = {
    schemaVersion: 3, name: `${prefix}Arena`, kind: 'class', language, variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('make', `object:${knightName}.construct`, { 'pin:name': 'Bors' }), node('turn', `fn:${language}:${actorPath}#Actor:turn`)],
      connections: [wire('s', 'execOut', 'make', 'execIn'), wire('make', 'execOut', 'turn', 'execIn'), wire('make', 'object', 'turn', 'target')]
    }]
  };
  const knightFile = `parents_${language}_knight.vgraph`;
  const arenaFile = `parents_${language}_arena.vgraph`;
  const knightGraph = workspaceFile(knightFile);
  const arenaGraph = workspaceFile(arenaFile);
  await write(knightFile, JSON.stringify(knight, null, 2));
  await write(arenaFile, JSON.stringify(arena, null, 2));
  // The code's classes load in the background: compile until Knight's parent and Arena's nodes are found.
  for (const graph of [knightGraph, arenaGraph]) {
    const deadline = Date.now() + 20000;
    for (;;) {
      await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
      const problems = vscode.languages.getDiagnostics(graph).filter((p) => p.severity === vscode.DiagnosticSeverity.Error);
      if (!problems.length) break;
      if (Date.now() > deadline) throw new Error(`${path.basename(graph.fsPath)} never compiled: ${problems.map((p) => p.message).join('; ')}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  await openInGraphEditor(arenaFile);
  const api = (vscode.extensions.getExtension(EXTENSION_ID)!.exports as ExtensionApi).testing;
  await api.marks.breakpoints.set(knightGraph, [{ graphId: 'EventGraph', nodeId: 'p2', enabled: true }]);
  const frames = () => api.provider.currentDebug()?.stack;
  const top = () => frames()?.[0];
  const until = (what: string, ready: (frame: NonNullable<ReturnType<typeof top>>) => boolean) => waitFor(() => !!top() && ready(top()!), what, 90000)
    .catch((error: Error) => { throw new Error(`${error.message}; the stack: ${JSON.stringify(frames() ?? 'running')}`); });
  const inKnight = (nodeId: string) => (f: NonNullable<ReturnType<typeof top>>) => !f.external && f.uri.toString() === knightGraph.toString() && f.nodeId === nodeId;
  try {
    await vscode.commands.executeCommand('blueprintVisualScripting.debug', arenaGraph);
    // The code's turn calls hit: the debugger stops in Knight's Event hit, below the code's frame.
    await until("the stop in Knight's Event hit", inKnight('p2'));
    const below = frames()![1];
    assert.ok(below.external && below.uri.fsPath.endsWith(path.normalize(actorPath)), `the code's turn called it: ${JSON.stringify(below)}`);
    assert.ok(frames()!.some((f) => !f.external && f.uri.toString() === arenaGraph.toString() && f.nodeId === 'turn'), "Arena's Turn node called the code");
    const debug = api.provider.currentDebug()!;

    debug.act('stepOver');
    await until('Step Over to the Parent call', inKnight('parent'));

    // Step Into reaches the code's own hit, at its first line.
    debug.act('stepInto');
    await until("Step Into the code's hit", (f) => !!f.external);
    const first = lines.findIndex((l) => l.trim() === (language === 'typescript' ? 'this.health -= damage;' : 'self.health -= damage')) + 1;
    assert.ok(top()!.uri.fsPath.endsWith(path.normalize(actorPath)), JSON.stringify(top()));
    assert.equal(top()!.nodeName, `${path.basename(actorPath)}:${first}`);
    assert.ok(inKnight('parent')(frames()![1]), 'called from the Parent call');

    // Step Out comes back to the graph.
    debug.act('stepOut');
    await until('Step Out to the graph', (f) => !f.external);
    assert.ok(inKnight('parent')(top()!), JSON.stringify(top()));

    debug.act('resume');
    await waitFor(() => !api.provider.currentDebug(), 'the session to end', 60000);
  } finally {
    api.provider.currentDebug()?.act('stop');
    await api.marks.breakpoints.set(knightGraph, []);
  }
}

test('exit check: debugging a graph class extending a class from the code, in TypeScript', () => codeParentDebug('typescript'));

test('exit check: debugging a graph class extending a class from the code, in Python', async () => {
  if (!vscode.extensions.getExtension('ms-python.debugpy')) throw new Skip('the Python Debugger extension is not loaded');
  await codeParentDebug('python');
});

test('exit check: debugging a function graph in generated C++', async () => {
  if (!vscode.extensions.getExtension('ms-vscode.cpptools')) throw new Skip('the C/C++ extension is not loaded');
  await exitCheck('cpp');
});

// CodeLLDB, or on Windows the C/C++ extension's Visual Studio debugger.
function requireRustDebugger(): void {
  const [id, name] = process.platform === 'win32' ? ['ms-vscode.cpptools', 'C/C++'] : ['vadimcn.vscode-lldb', 'CodeLLDB'];
  if (!vscode.extensions.getExtension(id)) throw new Skip(`the ${name} extension is not loaded`);
}

test('exit check: debugging a function graph in generated Rust', async () => {
  requireRustDebugger();
  await exitCheck('rust');
});

test("exit check: debugging a function graph in generated C (a separate extension's declarative pack)", async () => {
  if (!vscode.extensions.getExtension('ms-vscode.cpptools')) throw new Skip('the C/C++ extension is not loaded');
  await exitCheck('c');
});

test('exit check: debugging a function graph in generated Java', async () => {
  if (!vscode.extensions.getExtension('vscjava.vscode-java-debug')) throw new Skip('the Debugger for Java extension is not loaded');
  await exitCheck('java');
});

// The Go extension, active: its debug adapter is registered when it activates.
async function requireGoDebugger(): Promise<void> {
  const go = vscode.extensions.getExtension('golang.go');
  if (!go) throw new Skip('the Go extension is not loaded');
  await go.activate();
}

test('exit check: debugging a function graph in generated Go', async () => {
  await requireGoDebugger();
  await exitCheck('go');
});

test('exit check: debugging a function graph in generated Lua', async () => {
  if (!vscode.extensions.getExtension('actboy168.lua-debug')) throw new Skip('the Lua Debug extension is not loaded');
  await exitCheck('lua');
});

// GDScript is debugged in a Godot project: godot-tools maps breakpoints to its res:// paths. It checks
// the project's Godot version against the executable's (the GODOT environment variable's).
async function godotProject(): Promise<string> {
  if (!vscode.extensions.getExtension('geequlim.godot-tools')) throw new Skip('the godot-tools extension is not loaded');
  if (!process.env.GODOT) throw new Skip('the GODOT environment variable is not set');
  const version = /^(\d+\.\d+)/.exec(spawnSync(process.env.GODOT, ['--version'], { encoding: 'utf8' }).stdout ?? '')?.[1] ?? '4.0';
  await vscode.workspace.fs.writeFile(workspaceFile('godot/project.godot'), new TextEncoder().encode(`config_version=5\n\n[application]\nconfig/features=PackedStringArray("${version}")\n`));
  return 'godot';
}

test('exit check: debugging a function graph in generated GDScript', async () => {
  await exitCheck('gdscript', await godotProject());
});

test('exit check: debugging a function graph in generated Ruby', async () => {
  if (!vscode.extensions.getExtension('KoichiSasada.vscode-rdbg')) throw new Skip('the VSCode rdbg Ruby Debugger extension is not loaded');
  await exitCheck('ruby');
});

// PHP is debugged with Xdebug, which php.ini must load (zend_extension=xdebug).
function requirePhpDebugger(): void {
  if (!vscode.extensions.getExtension('xdebug.php-debug')) throw new Skip('the PHP Debug extension is not loaded');
  if (!/^xdebug$/im.test(spawnSync('php', ['-m'], { encoding: 'utf8' }).stdout ?? '')) throw new Skip('PHP has no Xdebug (php -m)');
}

test('exit check: debugging a function graph in generated PHP', async () => {
  requirePhpDebugger();
  await exitCheck('php');
});

test('exit check: debugging a function graph in generated C#', async () => {
  if (!vscode.extensions.getExtension('ms-dotnettools.csharp')) throw new Skip('the C# extension is not loaded');
  await exitCheck('csharp');
});

test('Debug stops at a node breakpoint in generated JavaScript, steps by node and reads pins', () => debugSample('javascript', 'debug_javascript.vgraph.js'));

test('Debug does the same in generated TypeScript', () => debugSample('typescript', 'debug_typescript.vgraph.ts'));

// Tier 2 symbol import (docs/language-breadth.md): a declarative pack finds marked functions through
// the language server, here VS Code's own TypeScript server for a JavaScript file.
test('a declarative pack imports marked functions through the language server', async () => {
  const api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as PublicApi;
  const definition = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../test/fixtures/declarative/minijs.vgraph-language.json'), 'utf8'));
  const source = workspaceFile('jstools/score.js');
  await vscode.workspace.fs.writeFile(source, new TextEncoder().encode([
    '/**',
    ' * Triples a value.',
    ' * @blueprint',
    ' * @param {number} value',
    ' * @returns {number}',
    ' */',
    'function triple(value) {',
    '  return value * 3;',
    '}',
    '',
    'module.exports = { triple };',
    ''
  ].join('\n')));
  const pack = api.registerDeclarativePack({ ...definition, id: 'minijs-lsp' });
  const graph = workspaceFile('lsp.vgraph');
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  await vscode.workspace.fs.writeFile(graph, new TextEncoder().encode(JSON.stringify({
    schemaVersion: 3, name: 'Lsp', kind: 'class', language: 'minijs-lsp', variables: [], metadata: {},
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('t', 'fn:minijs-lsp:jstools/score.js#triple', { 'pin:value': 14 }), node('p', 'core:console.print')],
      connections: [
        { id: 'c1', fromNode: 's', fromPin: 'execOut', toNode: 't', toPin: 'execIn' },
        { id: 'c2', fromNode: 't', fromPin: 'execOut', toNode: 'p', toPin: 'execIn' },
        { id: 'c3', fromNode: 't', fromPin: 'returnValue', toNode: 'p', toPin: 'value' }
      ]
    }]
  }, null, 2)));
  const generated = workspaceFile('lsp.vgraph.mini.js');
  try {
    // The language server may take a while to start.
    const deadline = Date.now() + 60000;
    while (!(await exists(generated)) && Date.now() < deadline) {
      await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(await exists(generated), `It doesn't compile: ${vscode.languages.getDiagnostics(graph).map((d) => d.message).join('; ')}`);
    const text = await readText(generated);
    assert.match(text, /const \{ triple \} = require\("\.\/jstools\/score\.js"\);/);
    assert.match(text, /triple\(14\.0\)/, 'the hover said value is a number: a float');
    const { execFileSync } = await import('node:child_process');
    assert.equal(execFileSync(process.platform === 'win32' ? 'node.exe' : 'node', [generated.fsPath], { encoding: 'utf8' }).trim(), '42');
  } finally {
    pack.dispose();
  }
});

test('Debug does the same for a declarative pack, through its debugger description', async () => {
  const api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as PublicApi;
  const pack = api.registerDeclarativePack({ ...JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../test/fixtures/declarative/minijs.vgraph-language.json'), 'utf8')), id: 'minijs-api' });
  try {
    await debugSample('minijs-api', 'debug_minijs-api.vgraph.mini.js');
  } finally {
    pack.dispose();
  }
});

// These need the language's debugger extension: run `npm run test:integration:debuggers` to load
// the installed extensions.
test('Debug does the same in generated Python (debugpy)', async () => {
  if (!vscode.extensions.getExtension('ms-python.debugpy')) throw new Skip('the Python Debugger extension is not loaded');
  await debugSample('python', 'debug_python_vgraph.py');
});

test('Debug does the same in generated C++ (cppdbg)', async () => {
  if (!vscode.extensions.getExtension('ms-vscode.cpptools')) throw new Skip('the C/C++ extension is not loaded');
  await debugSample('cpp', 'debug_cpp.vgraph.cpp');
});

test('Debug does the same in generated Rust', async () => {
  requireRustDebugger();
  await debugSample('rust', 'debug_rust_vgraph.rs');
});

test('Debug does the same in generated C (cppdbg)', async () => {
  if (!vscode.extensions.getExtension('ms-vscode.cpptools')) throw new Skip('the C/C++ extension is not loaded');
  await debugSample('c', 'debug_c_vgraph.c');
});

test('Debug does the same in generated Java', async () => {
  if (!vscode.extensions.getExtension('vscjava.vscode-java-debug')) throw new Skip('the Debugger for Java extension is not loaded');
  await debugSample('java', 'DebugJava.java');
});

test('Debug does the same in generated Lua (Lua Debug)', async () => {
  if (!vscode.extensions.getExtension('actboy168.lua-debug')) throw new Skip('the Lua Debug extension is not loaded');
  await debugSample('lua', 'debug_lua_vgraph.lua');
});

test('Debug does the same in generated GDScript (godot-tools)', async () => {
  await debugSample('gdscript', 'debug_gdscript_vgraph.gd', await godotProject());
});

test('Debug does the same in generated Ruby (rdbg)', async () => {
  if (!vscode.extensions.getExtension('KoichiSasada.vscode-rdbg')) throw new Skip('the VSCode rdbg Ruby Debugger extension is not loaded');
  await debugSample('ruby', 'debug_ruby_vgraph.rb');
});

test('Debug does the same in generated PHP (Xdebug)', async () => {
  requirePhpDebugger();
  await debugSample('php', 'debug_php.vgraph.php');
});

test('Debug does the same in generated Go (Delve)', async () => {
  await requireGoDebugger();
  await debugSample('go', 'debug_go_vgraph.go');
});

test('Debug does the same in generated C# (coreclr)', async () => {
  if (!vscode.extensions.getExtension('ms-dotnettools.csharp')) throw new Skip('the C# extension is not loaded');
  await debugSample('csharp', 'debug_csharp.vgraph.cs');
});

export async function run(): Promise<void> {
  const failures: string[] = [];
  let skipped = 0;
  const filter = process.env.BLUEPRINT_IT_FILTER ?? '';
  const selected = tests.filter((t) => t.name.includes(filter));
  for (const { name, run: body } of selected) {
    try {
      await body();
      console.log(`  ✔ ${name}`);
    } catch (error) {
      if (error instanceof Skip) {
        skipped++;
        console.log(`  - ${name} (skipped: ${error.message})`);
        continue;
      }
      failures.push(name);
      console.error(`  ✖ ${name}\n    ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log(`${selected.length - failures.length - skipped}/${selected.length - skipped} integration tests passed${skipped ? ` (${skipped} skipped)` : ''}`);
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed: ${failures.join(', ')}`);
}

// Tier 2 symbol import for a Tier 1 pack (docs/language-breadth.md, "Go"): functions marked
// @blueprint in a module's package are found through gopls and called through the package's import.
test('Go functions marked @blueprint become nodes through gopls', async () => {
  await requireGoDebugger();
  const write = (name: string, text: string) => vscode.workspace.fs.writeFile(workspaceFile(name), new TextEncoder().encode(text));
  await write('gomod/go.mod', 'module example.com/app\n\ngo 1.22\n');
  await write('gomod/scores/scores.go', [
    'package scores', '', '// Twice doubles a value.', '// @blueprint pure', 'func Twice(value float64) float64 {', '\treturn value * 2', '}', '',
    // A struct's field and method (docs/node-authoring.md, gap 2), as gopls reports them.
    'type Counter struct {', '\t// @blueprint', '\tCount float64', '}', '', '// @blueprint', 'func (c *Counter) Add(amount float64) float64 {', '\tc.Count += amount', '\treturn c.Count', '}', ''
  ].join('\n'));
  await write('gomod/graphs/doc.go', 'package graphs\n');
  const graph = workspaceFile('gomod/graphs/uses_go.vgraph');
  await write('gomod/graphs/uses_go.vgraph', projectGraph('UsesGo', 'go', 'fn:go:gomod/scores/scores.go#Twice'));
  const generated = workspaceFile('gomod/graphs/uses_go_vgraph.go');
  const deadline = Date.now() + 90000;
  while (!(await exists(generated)) && Date.now() < deadline) {
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', graph);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(await exists(generated), `It doesn't compile: ${vscode.languages.getDiagnostics(graph).map((d) => d.message).join('; ')}`);
  const text = await readText(generated);
  assert.match(text, /^package graphs$/m);
  assert.match(text, /scores "example\.com\/app\/scores"/);
  assert.match(text, /scores\.Twice\(4\)/);
  assert.ok(await exists(workspaceFile('gomod/graphs/vgraph_runtime.go')), 'the package\'s support code');

  // The struct's field became a Get node with a Target of the struct's pointer.
  const counterGraph = workspaceFile('gomod/graphs/uses_counter.vgraph');
  await write('gomod/graphs/uses_counter.vgraph', projectGraph('UsesCounter', 'go', 'fn:go:gomod/scores/scores.go#Counter:get:Count'));
  const counterGenerated = workspaceFile('gomod/graphs/uses_counter_vgraph.go');
  const until = Date.now() + 90000;
  while (!(await exists(counterGenerated)) && Date.now() < until) {
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', counterGraph);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(await exists(counterGenerated), `It doesn't compile: ${vscode.languages.getDiagnostics(counterGraph).map((d) => d.message).join('; ')}`);
  assert.match(await readText(counterGenerated), /\.\(\*scores\.Counter\)\.Count/);

  // Its method, which gopls names "(*Counter).Add", became a node too: Start → Add → Print.
  const addGraph = workspaceFile('gomod/graphs/uses_add.vgraph');
  const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  await write('gomod/graphs/uses_add.vgraph', JSON.stringify({
    schemaVersion: 3, name: 'UsesAdd', kind: 'class', language: 'go', variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [node('s', 'core:event.start'), node('a', 'fn:go:gomod/scores/scores.go#Counter:Add', { 'pin:amount': 2 }), node('p', 'core:console.print')],
      connections: [
        { id: 'c1', fromNode: 's', fromPin: 'execOut', toNode: 'a', toPin: 'execIn' },
        { id: 'c2', fromNode: 'a', fromPin: 'execOut', toNode: 'p', toPin: 'execIn' },
        { id: 'c3', fromNode: 'a', fromPin: 'returnValue', toNode: 'p', toPin: 'value' }
      ]
    }]
  }, null, 2));
  const addGenerated = workspaceFile('gomod/graphs/uses_add_vgraph.go');
  const addUntil = Date.now() + 90000;
  while (!(await exists(addGenerated)) && Date.now() < addUntil) {
    await vscode.commands.executeCommand('blueprintVisualScripting.compile', addGraph);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(await exists(addGenerated), `It doesn't compile: ${vscode.languages.getDiagnostics(addGraph).map((d) => d.message).join('; ')}`);
  assert.match(await readText(addGenerated), /\.\(\*scores\.Counter\)\.Add\(2\)/);

  // An unmarked function offers Expose, from gopls's symbols (docs/node-authoring.md, gap 7).
  const tools = workspaceFile('gomod/scores/tools.go');
  await write('gomod/scores/tools.go', 'package scores\n\n// Triple triples a value.\nfunc Triple(value float64) float64 {\n\treturn value * 3\n}\n');
  const document = await vscode.workspace.openTextDocument(tools);
  const deadlineFix = Date.now() + 60000;
  let actions: vscode.CodeAction[] = [];
  while (!actions.some((a) => a.title === 'Expose as Blueprint node') && Date.now() < deadlineFix) {
    actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', tools, new vscode.Range(3, 0, 3, 0));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const expose = actions.find((a) => a.title === 'Expose as Blueprint node');
  assert.ok(expose, actions.map((a) => a.title).join(', '));
  assert.ok(await vscode.workspace.applyEdit(expose.edit!));
  assert.ok(document.getText().includes('// Triple triples a value.\n// @blueprint\nfunc Triple('), document.getText());
  await document.save();
});
