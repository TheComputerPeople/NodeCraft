// Installs the built .vsix (the newest, or the one named) into a VS Code of its own, as a user would,
// and checks the installed extension: it activates, New Project writes the Tour and compiles it, and
// the Codebase Map opens (which loads web-tree-sitter). 0.1.0 was published without its runtime
// libraries and couldn't activate; this is the check that would have caught it.
// Usage: node scripts/test-package.js [file.vsix]   (npm run test:package)
'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const id = `${pkg.publisher}.${pkg.name}`;
const vsix = process.argv[2]
  ? path.resolve(process.argv[2])
  : fs.readdirSync(root).filter((f) => f.endsWith('.vsix')).map((f) => path.join(root, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

// Runs inside VS Code: the extension under test, as installed.
const PROBE = `
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
exports.run = async () => {
  const ext = vscode.extensions.getExtension(${JSON.stringify(id)});
  if (!ext) throw new Error(${JSON.stringify(`${id} isn't installed`)});
  await ext.activate();
  if (!ext.isActive) throw new Error('it did not activate');
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const graph = await vscode.commands.executeCommand('nodecraft.newProject', { language: 'typescript', folder: vscode.Uri.joinPath(folder, 'tour'), name: 'Tour', start: 'tour' });
  if (!graph || !fs.existsSync(path.join(path.dirname(graph.fsPath), 'Main.vgraph.ts'))) throw new Error('New Project wrote no generated code');
  await vscode.commands.executeCommand('nodecraft.showCodebaseMap');
  fs.writeFileSync(process.env.NODECRAFT_PACKAGE_RESULT, ext.packageJSON.version);
};
`;

(async () => {
  if (!vsix) throw new Error('No .vsix to test: run `npm run package` first.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecraft-package-'));
  try {
    for (const dir of ['probe', 'workspace', 'extensions', 'user']) fs.mkdirSync(path.join(temp, dir));
    fs.writeFileSync(path.join(temp, 'probe', 'package.json'), JSON.stringify({ name: 'nodecraft-package-probe', publisher: 'probe', version: '0.0.0', engines: { vscode: '*' } }));
    fs.writeFileSync(path.join(temp, 'probe', 'probe.js'), PROBE);
    const exe = await downloadAndUnzipVSCode(pkg.engines.vscode.replace(/^[^\d]*/, ''));
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(exe);
    const install = cp.spawnSync(cli, [...args, '--extensions-dir', path.join(temp, 'extensions'), '--install-extension', vsix], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (install.status !== 0) throw new Error(`Installing ${path.basename(vsix)} failed:\n${install.stdout}${install.stderr}`);
    process.env.NODECRAFT_PACKAGE_RESULT = path.join(temp, 'result.txt');
    // VS Code sets this for its child processes; the VS Code launched here must run as itself.
    delete process.env.ELECTRON_RUN_AS_NODE;
    await runTests({
      vscodeExecutablePath: exe,
      extensionDevelopmentPath: path.join(temp, 'probe'),
      extensionTestsPath: path.join(temp, 'probe', 'probe.js'),
      launchArgs: [path.join(temp, 'workspace'), '--extensions-dir', path.join(temp, 'extensions'), '--user-data-dir', path.join(temp, 'user')]
    });
    const version = fs.readFileSync(path.join(temp, 'result.txt'), 'utf8');
    console.log(`${path.basename(vsix)}: installed ${id} ${version} activates, New Project writes the Tour, and the Codebase Map opens.`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
