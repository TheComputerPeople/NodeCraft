// Launches VS Code with the extension under development and runs the integration suite inside it.
// The first run downloads VS Code into .vscode-test/.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

const repoRoot = path.resolve(__dirname, '../../..');

// Tests run in a scratch copy of the sample workspace so they can change files freely.
function createWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-vscode-it-'));
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
  try {
    await runTests({
      version: minimumVsCodeVersion(),
      // The C pack loads too: a separate extension using only the public API (docs/language-breadth.md, "Exit check").
      extensionDevelopmentPath: [repoRoot, path.join(repoRoot, 'examples/c-language-pack')],
      extensionTestsPath: path.join(__dirname, 'suite'),
      // BLUEPRINT_IT_FILTER runs only the tests whose names contain it.
      extensionTestsEnv: { BLUEPRINT_IT_FILTER: process.env.BLUEPRINT_IT_FILTER ?? '' },
      // With --with-debuggers, the installed extensions load (Python's and C#'s debuggers), so their
      // debugging tests run instead of being skipped.
      launchArgs: [workspace, ...(withDebuggers ? [`--extensions-dir=${path.join(os.homedir(), '.vscode', 'extensions')}`] : ['--disable-extensions']), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes']
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
