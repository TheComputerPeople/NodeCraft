// Runs inside the VS Code extension host. A tiny sequential runner keeps the suite free of a test
// framework dependency; VS Code reports failure when the returned promise rejects.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'local.blueprint-visual-scripting';
const VIEW_TYPE = 'blueprintVisualScripting.graphEditor';

type Test = { name: string; run: () => Promise<void> };
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

async function openInGraphEditor(name: string): Promise<vscode.Uri> {
  const uri = workspaceFile(name);
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  await waitFor(() => activeCustomEditor()?.uri.toString() === uri.toString(), `${name} to open in the graph editor`);
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

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const { name, run: body } of tests) {
    try {
      await body();
      console.log(`  ✔ ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`  ✖ ${name}\n    ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log(`${tests.length - failures.length}/${tests.length} integration tests passed`);
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed: ${failures.join(', ')}`);
}
