// The Codebase Map in Restricted Mode (docs/codebase-map.md, "Exit check"): the index only parses
// files, so in a workspace that isn't trusted the map, its views, its hovers and its tree all work.
// runTest.ts opens a copy of the sample workspace with workspace trust on and its prompt off.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
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
    assert.ok(scene?.boxes.some((b) => b.id === 'm:countdown'), 'the architecture: the countdown folder is on the map');
    const opened = await api.codeMapPanels.toggleIn(folder, 'm:countdown');
    assert.ok(opened?.boxes.some((b) => b.id === 'g:countdown/Countdown.vgraph'), "opening it shows the folder's graphs");
    const structure = await api.codeMapPanels.modeIn(folder, 'structure');
    assert.ok(structure?.arrows.some((a) => a.kind === 'inherits' && a.from === 'g:countdown/DoubleCounter.vgraph' && a.to === 'g:countdown/Counter.vgraph'), 'the structure: DoubleCounter extends Counter');
    const calls = await api.codeMapPanels.callsIn(folder);
    assert.ok((calls?.calls?.starts ?? 0) > 0 && calls?.boxes.some((b) => b.id === 'g:countdown/Countdown.vgraph#EventGraph'), 'the call flow starts from the countdown');
    const flow = await api.codeMapPanels.flowIn(folder, 's:node-authoring/lib/tally.ts#Tally.add');
    assert.equal(flow?.flow?.label, 'add', 'the control flow of a method');
    assert.deepEqual(flow?.boxes.map((b) => b.flowKind), ['start', 'end', 'block', 'return']);
    assert.match((await api.codeMapPanels.hoverIn(folder, 's:node-authoring/lib/tally.ts#Tally.add'))?.signature ?? '', /add\(/, "a method's hover");
    const top = await api.structureTree.getChildren();
    assert.ok(top.some((n) => n.id?.startsWith('p:')), `the tree: ${JSON.stringify(top.map((n) => n.id))}`);
    await api.codeMapPanels.modeIn(folder, 'architecture');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
});

// A cloned repository's .npmrc could name any server and send it a token from the environment, so
// Add Blueprint Package reads only the user's until the workspace is trusted.
test("Add Blueprint Package ignores the workspace's .npmrc", async () => {
  const requests: { server: string; url?: string; authorization?: string }[] = [];
  const listen = async (name: string) => {
    const server = http.createServer((request, response) => {
      requests.push({ server: name, url: request.url, authorization: request.headers.authorization });
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
  };
  const workspaceRegistry = await listen('workspace');
  const userRegistry = await listen('user');
  const folder = vscode.workspace.workspaceFolders![0].uri;
  const npmrc = vscode.Uri.joinPath(folder, '.npmrc');
  const host = workspaceRegistry.url.replace(/^http:/, '');
  fs.writeFileSync(npmrc.fsPath, `registry=${workspaceRegistry.url}\n${host}:_authToken=\${PATH}\n`);
  const user = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vg-npmrc-')), '.npmrc');
  fs.writeFileSync(user, `registry=${userRegistry.url}\n`);
  const userConfig = process.env.NPM_CONFIG_USERCONFIG;
  process.env.NPM_CONFIG_USERCONFIG = user;
  try {
    // The package isn't in the user's registry, so nothing is added.
    assert.equal(await vscode.commands.executeCommand('blueprintVisualScripting.addBlueprintPackage', { npm: 'combat-graphs' }), undefined);
    assert.deepEqual(requests.map((r) => r.server), ['user'], JSON.stringify(requests));
    assert.equal(requests[0].authorization, undefined);
  } finally {
    if (userConfig === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
    else process.env.NPM_CONFIG_USERCONFIG = userConfig;
    workspaceRegistry.server.close();
    userRegistry.server.close();
    fs.rmSync(npmrc.fsPath, { force: true });
  }
});

// docs/audit.md, second pass: the settings that say what Run starts are restricted, so a folder's
// own values for them aren't used until it's trusted.
test("the folder's runCommands and runArguments are ignored, and its other settings used", async () => {
  const folder = vscode.workspace.workspaceFolders![0].uri;
  const settings = vscode.Uri.joinPath(folder, '.vscode', 'settings.json');
  await vscode.workspace.fs.writeFile(settings, new TextEncoder().encode(JSON.stringify({
    'blueprintVisualScripting.defaultLanguage': 'python',
    'blueprintVisualScripting.runCommands': { javascript: ['not-a-real-command'] },
    'blueprintVisualScripting.runArguments': ['--from-the-folder']
  })));
  try {
    const config = () => vscode.workspace.getConfiguration('blueprintVisualScripting', folder);
    const deadline = Date.now() + 10000;
    while (config().get('defaultLanguage') !== 'python') {
      if (Date.now() > deadline) throw new Error("The folder's settings were never read");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(config().get('runCommands'), {});
    assert.deepEqual(config().get('runArguments'), []);
  } finally {
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, '.vscode'), { recursive: true });
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
