// The Codebase Map in Restricted Mode (docs/codebase-map.md, "Exit check"): the index only parses
// files, so in a workspace that isn't trusted the map, its views, its hovers and its tree all work.
// runTest.ts opens a copy of the sample workspace with workspace trust on and its prompt off.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'local.blueprint-visual-scripting';

interface StructureNode {
  folder: vscode.WorkspaceFolder;
  id?: string;
}

interface Scene {
  mode: string;
  boxes: { id: string; kind: string; root?: boolean; flowKind?: string }[];
  arrows: { kind: string; from: string; to: string }[];
  calls?: { starts: number };
  flow?: { label: string };
}

interface ExtensionApi {
  testing: {
    codeMapPanels: {
      toggleIn(folder: vscode.WorkspaceFolder, id: string): Promise<Scene | undefined>;
      callsIn(folder: vscode.WorkspaceFolder, id?: string): Promise<Scene | undefined>;
      flowIn(folder: vscode.WorkspaceFolder, id: string): Promise<Scene | undefined>;
      modeIn(folder: vscode.WorkspaceFolder, mode: 'architecture' | 'structure' | 'calls'): Promise<Scene | undefined>;
      hoverIn(folder: vscode.WorkspaceFolder, id: string): Promise<{ signature: string; doc?: string } | undefined>;
    };
    structureTree: {
      getChildren(node?: StructureNode): Promise<StructureNode[]>;
    };
  };
}

const tests: { name: string; run: () => Promise<void> }[] = [];
const test = (name: string, run: () => Promise<void>) => tests.push({ name, run });

test('the workspace is in Restricted Mode', async () => {
  assert.equal(vscode.workspace.isTrusted, false);
});

test('the Codebase Map draws the folder and its four views, with hovers and the tree', async () => {
  const api = ((await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ExtensionApi).testing;
  const folder = vscode.workspace.workspaceFolders![0];
  try {
    const scene = await vscode.commands.executeCommand<Scene>('blueprintVisualScripting.showCodebaseMap', folder.uri);
    assert.ok(scene?.boxes.some((b) => b.id === 'm:arena'), 'the architecture: the arena folder is on the map');
    const opened = await api.codeMapPanels.toggleIn(folder, 'm:arena');
    assert.ok(opened?.boxes.some((b) => b.id === 'g:arena/Game.vgraph'), "opening it shows the folder's graphs");
    const structure = await api.codeMapPanels.modeIn(folder, 'structure');
    assert.ok(structure?.arrows.some((a) => a.kind === 'inherits' && a.from === 'g:arena/Knight.vgraph' && a.to === 'g:arena/Fighter.vgraph'), 'the structure: Knight extends Fighter');
    const calls = await api.codeMapPanels.callsIn(folder);
    assert.ok((calls?.calls?.starts ?? 0) > 0 && calls?.boxes.some((b) => b.id === 'g:arena/Game.vgraph#EventGraph'), 'the call flow starts from the game');
    const flow = await api.codeMapPanels.flowIn(folder, 's:node-authoring/lib/dojo.ts#Trainee.train');
    assert.equal(flow?.flow?.label, 'train', 'the control flow of a method');
    assert.deepEqual(flow?.boxes.map((b) => b.flowKind), ['start', 'end', 'block', 'return']);
    assert.match((await api.codeMapPanels.hoverIn(folder, 's:node-authoring/lib/dojo.ts#Trainee.train'))?.signature ?? '', /train\(/, "a method's hover");
    const top = await api.structureTree.getChildren();
    assert.ok(top.some((n) => n.id?.startsWith('p:')), `the tree: ${JSON.stringify(top.map((n) => n.id))}`);
    await api.codeMapPanels.modeIn(folder, 'architecture');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
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
  console.log(`${tests.length - failures.length}/${tests.length} Restricted Mode integration tests passed`);
  if (failures.length) throw new Error(`${failures.length} Restricted Mode integration test(s) failed: ${failures.join(', ')}`);
}
