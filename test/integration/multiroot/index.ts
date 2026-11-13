// A multi-root workspace of two projects in different languages (docs/project-integration.md,
// "Exit check"): a TypeScript web app and a Python API, each with its own code and a graph. From each
// folder, its code becomes nodes, its graph compiles there in its language and runs, a new graph
// takes its language, and Set Up reports its project. runTest.ts opens multi.code-workspace for it.
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { NodeRegistry } from '../../../src/core/registry';

const EXTENSION_ID = 'local.nodecraft';

interface StructureNode {
  folder: vscode.WorkspaceFolder;
  id?: string;
}

interface ExtensionApi {
  testing: {
    registry: NodeRegistry;
    structureTree: {
      getChildren(node?: StructureNode): Promise<StructureNode[]>;
      getParent(node: StructureNode): Promise<StructureNode | undefined>;
      getTreeItem(node: StructureNode): Promise<vscode.TreeItem>;
    };
  };
}

const tests: { name: string; run: () => Promise<void> }[] = [];
const test = (name: string, run: () => Promise<void>) => tests.push({ name, run });

function folder(name: 'web' | 'api'): vscode.WorkspaceFolder {
  const found = vscode.workspace.workspaceFolders?.find((f) => f.name === name);
  assert.ok(found, `the ${name} folder is open`);
  return found;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

test('both folders are open, each a project of its own language', async () => {
  assert.deepEqual(vscode.workspace.workspaceFolders?.map((f) => f.name), ['web', 'api']);
});

test("each folder's code becomes nodes, by its path in its own folder", async () => {
  const api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate() as ExtensionApi).testing;
  await waitFor(() => !!api.registry.get('fn:typescript:src/text.ts#title') && !!api.registry.get('fn:python:app/text.py#title'), 'the title nodes of both folders');
});

for (const [name, language, graph, output, command] of [
  ['web', 'TypeScript', 'src/Greet.vgraph', 'src/Greet.vgraph.ts', ['node', '--input-type=module', '-e', "const { Greet } = await import('./src/Greet.vgraph.ts'); new Greet().start();"]],
  ['api', 'Python', 'app/Greet.vgraph', 'app/greet_vgraph.py', [PYTHON, '-c', 'from app.greet_vgraph import Greet; Greet().start()']]
] as const) {
  test(`${name}: its graph compiles in its folder, in ${language}, calling its folder's code, and runs`, async () => {
    const root = folder(name).uri;
    const graphUri = vscode.Uri.joinPath(root, graph);
    await vscode.commands.executeCommand('vscode.openWith', graphUri, 'nodecraft.graphEditor');
    await vscode.commands.executeCommand('nodecraft.compile', graphUri);
    const generated = path.join(root.fsPath, output);
    await waitFor(() => fs.existsSync(generated), `${output}`);
    const run = spawnSync(command[0], command.slice(1), { cwd: root.fsPath, encoding: 'utf8' });
    if (run.error && (run.error as NodeJS.ErrnoException).code === 'ENOENT') return;
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(run.stdout.trim(), 'Hello, Ada!');
  });
}

// docs/codebase-map.md, Part 3: the Codebase Map's tree has a branch for each folder, each with its own code.
test("the Codebase Map's tree has each folder, with its own code", async () => {
  const api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate() as ExtensionApi).testing;
  const top = await api.structureTree.getChildren();
  assert.deepEqual(top.map((n) => [n.folder.name, n.id]), [['web', undefined], ['api', undefined]]);
  for (const node of top) {
    const item = await api.structureTree.getTreeItem(node);
    assert.equal(item.label, node.folder.name);
    const inside = await api.structureTree.getChildren(node);
    assert.ok(inside.length && inside.every((n) => n.folder === node.folder && n.id), `${node.folder.name} has its code`);
    assert.deepEqual(await api.structureTree.getParent(inside[0]), { folder: node.folder }, 'under its folder');
  }
});

test("Set Up reports each folder's project, in its own language", async () => {
  for (const [name, language] of [['web', 'typescript'], ['api', 'python']] as const) {
    const report = await vscode.commands.executeCommand<{ root: string; languages: string[] }[]>('nodecraft.setUpProject', folder(name).uri);
    // One project in each folder, holding graphs of the folder's language (an npm project's may be
    // JavaScript too), and not the other folder's.
    assert.equal(report?.length, 1, `${name}: ${JSON.stringify(report)}`);
    const other = language === 'python' ? 'typescript' : 'python';
    assert.ok(report![0].languages.includes(language) && !report![0].languages.includes(other), `${name}: ${JSON.stringify(report)}`);
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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
  console.log(`${tests.length - failures.length}/${tests.length} multi-root integration tests passed`);
  if (failures.length) throw new Error(`${failures.length} multi-root integration test(s) failed: ${failures.join(', ')}`);
}
