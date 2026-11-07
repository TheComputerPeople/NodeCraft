// Installs the Node.js tools the corpus of project layouts runs (docs/project-integration.md,
// part 3; test/conformance/corpus.test.ts) into a folder of their own, outside the repository:
// TypeScript 5 (what most projects pin; the repository itself builds with TypeScript 7), ESLint with
// typescript-eslint, and Node.js's types. Each layout links the folder in as its node_modules, as a
// project with its devDependencies installed has them. The other languages' checkers (mypy, Pyright,
// Ruff, dotnet, javac, Maven, Gradle) are found on the PATH.
//
//   npm run corpus:tools
//
// BLUEPRINT_CORPUS_TOOLS names another folder.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGES = ['typescript@5', 'eslint@10', '@eslint/js@10', 'typescript-eslint@8', 'globals', '@types/node@24'];

// As test/conformance/corpus.ts finds it.
const os = require('node:os');
const folder = process.env.BLUEPRINT_CORPUS_TOOLS
  || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'blueprint-corpus', 'node') : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'blueprint-corpus', 'node'));
fs.mkdirSync(folder, { recursive: true });
const manifest = path.join(folder, 'package.json');
if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ name: 'blueprint-corpus-tools', private: true }, null, 2) + '\n');
console.log(`Installing ${PACKAGES.join(', ')} into ${folder}`);
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--save-dev', '--no-audit', '--no-fund', ...PACKAGES], { cwd: folder, stdio: 'inherit', shell: process.platform === 'win32' });
