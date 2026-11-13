// Launches VS Code with the extension under development and runs the integration suite inside it.
// The first run downloads VS Code into .vscode-test/.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

// runTests always turns workspace trust off (--disable-workspace-trust). For Restricted Mode, VS Code
// is started here with the same arguments but that one, and stopped (its whole process tree) if it
// doesn't finish in time.
async function runTestsWithTrust(options: { version: string; extensionDevelopmentPath: string; extensionTestsPath: string; workspace: string; userDataDir: string; extensionsDir: string }): Promise<void> {
  const executable = await downloadAndUnzipVSCode(options.version);
  const args = [
    options.workspace, '--disable-extensions', `--user-data-dir=${options.userDataDir}`, `--extensions-dir=${options.extensionsDir}`,
    '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--no-cached-data',
    `--extensionTestsPath=${options.extensionTestsPath}`, `--extensionDevelopmentPath=${options.extensionDevelopmentPath}`
  ];
  const child = spawn(executable, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d: Buffer) => process.stdout.write(d));
  child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
  const timer = setTimeout(() => {
    console.error('The Restricted Mode run took over 5 minutes; stopping it.');
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child.kill('SIGKILL');
  }, 5 * 60_000);
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  clearTimeout(timer);
  if (code !== 0) throw new Error(`The Restricted Mode run failed with code ${code}`);
}

const repoRoot = path.resolve(__dirname, '../../..');

// The test VS Code's user settings (@vscode/test-electron's default user-data folder), with extension
// updates turned off.
function keepExtensionsAsInstalled(settingsFile: string): void {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
  } catch {
    // No settings yet.
  }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false }, null, 4));
}

// Tests run in a scratch copy of the sample workspace so they can change files freely.
function createWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecraft-it-'));
  fs.cpSync(path.join(repoRoot, 'sample'), workspace, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'test/fixtures/demo-v1.vgraph'), path.join(workspace, 'legacy.vgraph'));
  fs.writeFileSync(path.join(workspace, 'broken.vgraph'), '{ "schemaVersion": 2, "graphs": ');
  return workspace;
}

// Test against the oldest VS Code the extension claims to support.
function minimumVsCodeVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { engines: { vscode: string } };
  return pkg.engines.vscode.replace(/^[^\d]*/, '');
}

async function main(): Promise<void> {
  // Set when this runs from a VS Code terminal or extension; it would make the downloaded VS Code
  // start as plain Node and try to execute the workspace folder as a script.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const workspace = createWorkspace();
  const withDebuggers = process.argv.includes('--with-debuggers');
  // With the installed extensions loaded, the test VS Code must leave them as they are: it is an
  // older VS Code, and it would otherwise update them in the user's own extensions folder.
  if (withDebuggers) keepExtensionsAsInstalled(path.join(repoRoot, '.vscode-test', 'user-data', 'User', 'settings.json'));
  try {
    await runTests({
      version: minimumVsCodeVersion(),
      // The C pack loads too: a separate extension using only the public API (docs/language-breadth.md, "Exit check").
      extensionDevelopmentPath: [repoRoot, path.join(repoRoot, 'examples/c-language-pack')],
      extensionTestsPath: path.join(__dirname, 'suite'),
      // NODECRAFT_IT_FILTER runs only the tests whose names contain it.
      extensionTestsEnv: { NODECRAFT_IT_FILTER: process.env.NODECRAFT_IT_FILTER ?? '' },
      // With --with-debuggers, the installed extensions load (Python's and C#'s debuggers), so their
      // debugging tests run instead of being skipped.
      launchArgs: [workspace, ...(withDebuggers ? [`--extensions-dir=${path.join(os.homedir(), '.vscode', 'extensions')}`] : ['--disable-extensions']), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes']
    });
  } finally {
    // A language server (Java's) may still hold files in it for a moment.
    try {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`The test workspace ${workspace} wasn't removed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // A multi-root workspace of two projects in different languages (docs/project-integration.md,
  // "Exit check"), opened as its .code-workspace file.
  const multi = createMultiRootWorkspace();
  try {
    await runTests({
      version: minimumVsCodeVersion(),
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: path.join(__dirname, 'multiroot'),
      launchArgs: [path.join(multi, 'multi.code-workspace'), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes']
    });
  } finally {
    fs.rmSync(multi, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  // Restricted Mode (docs/codebase-map.md, "Exit check"): the sample workspace again, with workspace
  // trust on and its prompt off, so it opens untrusted. Its own user data, so no trust is remembered.
  const restricted = createWorkspace();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecraft-untrusted-'));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecraft-untrusted-extensions-'));
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.banner': 'never' }, null, 4));
  try {
    await runTestsWithTrust({
      version: minimumVsCodeVersion(),
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: path.join(__dirname, 'restricted'),
      workspace: restricted,
      userDataDir: userData,
      extensionsDir
    });
  } finally {
    for (const dir of [restricted, userData, extensionsDir]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

// A TypeScript web app and a Python API, each with a function marked @blueprint and a graph that
// greets with it: Start prints "Hello, " + title("ada") + "!".
function createMultiRootWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecraft-multi-'));
  const greet = (language: string, title: string) => JSON.stringify({
    schemaVersion: 3, name: 'Greet', kind: 'class', language, variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [
        { id: 'start', type: 'core:event.start', position: { x: 0, y: 0 }, properties: {} },
        { id: 'title', type: title, position: { x: 0, y: 120 }, properties: { 'pin:name': 'ada' } },
        { id: 'hello', type: 'core:string.append', position: { x: 200, y: 120 }, properties: { 'pin:a': 'Hello, ' } },
        { id: 'bang', type: 'core:string.append', position: { x: 400, y: 120 }, properties: { 'pin:b': '!' } },
        { id: 'print', type: 'core:console.print', position: { x: 600, y: 0 }, properties: {} }
      ],
      connections: [
        { id: 'c1', fromNode: 'start', fromPin: 'execOut', toNode: 'print', toPin: 'execIn' },
        { id: 'c2', fromNode: 'title', fromPin: 'returnValue', toNode: 'hello', toPin: 'b' },
        { id: 'c3', fromNode: 'hello', fromPin: 'returnValue', toNode: 'bang', toPin: 'a' },
        { id: 'c4', fromNode: 'bang', fromPin: 'returnValue', toNode: 'print', toPin: 'value' }
      ]
    }]
  }, null, 2);
  const files: Record<string, string> = {
    'multi.code-workspace': JSON.stringify({ folders: [{ path: 'web' }, { path: 'api' }] }, null, 2),
    'web/package.json': JSON.stringify({ name: 'web', private: true, type: 'module' }, null, 2),
    'web/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'nodenext', strict: true, noEmit: true, allowImportingTsExtensions: true }, include: ['src'] }, null, 2),
    'web/src/text.ts': '/**\n * Capitalizes a name.\n * @blueprint pure\n */\nexport function title(name: string): string {\n  return name.charAt(0).toUpperCase() + name.slice(1);\n}\n',
    'web/src/Greet.vgraph': greet('typescript', 'fn:typescript:src/text.ts#title'),
    'api/pyproject.toml': '[project]\nname = "api"\nversion = "0.1.0"\nrequires-python = ">=3.8"\n',
    'api/app/__init__.py': '',
    'api/app/text.py': 'def title(name: str) -> str:\n    """Capitalizes a name.\n\n    @blueprint pure\n    """\n    return name[:1].upper() + name[1:]\n',
    'api/app/Greet.vgraph': greet('python', 'fn:python:app/text.py#title')
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
