// Installs the Node.js tools the corpus of project layouts runs (docs/project-integration.md,
// part 3; test/conformance/corpus.test.ts) into a folder of their own, outside the repository:
// TypeScript 5 (what most projects pin; the repository itself builds with TypeScript 7), ESLint with
// typescript-eslint, and Node.js's types. Each layout links the folder in as its node_modules, as a
// project with its devDependencies installed has them. Also PHP's tools, as .phar files in its phar
// folder (Composer, PHPStan, PHP_CodeSniffer). The other languages' checkers (mypy, Pyright, Ruff,
// dotnet, javac, Maven, Gradle, cargo, go, staticcheck, RuboCop, ...) are found on the PATH.
//
//   npm run corpus:tools
//
// NODECRAFT_CORPUS_TOOLS names another folder.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGES = ['typescript@5', 'eslint@10', '@eslint/js@10', 'typescript-eslint@8', 'globals', '@types/node@24'];

// As test/conformance/corpus.ts finds it.
const os = require('node:os');
const folder = process.env.NODECRAFT_CORPUS_TOOLS
  || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'nodecraft-corpus', 'node') : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'nodecraft-corpus', 'node'));
fs.mkdirSync(folder, { recursive: true });
const manifest = path.join(folder, 'package.json');
if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ name: 'nodecraft-corpus-tools', private: true }, null, 2) + '\n');
console.log(`Installing ${PACKAGES.join(', ')} into ${folder}`);
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--save-dev', '--no-audit', '--no-fund', ...PACKAGES], { cwd: folder, stdio: 'inherit', shell: process.platform === 'win32' });

// PHP's tools, each a single .phar that PHP runs (no extensions beyond PHP's usual ones; Composer
// only writes the autoloader, which needs no network): Composer, PHPStan and PHP_CodeSniffer.
const PHARS = {
  'composer.phar': 'https://getcomposer.org/download/latest-stable/composer.phar',
  'phpstan.phar': 'https://github.com/phpstan/phpstan/releases/latest/download/phpstan.phar',
  'phpcs.phar': 'https://github.com/PHPCSStandards/PHP_CodeSniffer/releases/latest/download/phpcs.phar'
};
(async () => {
  const phar = path.join(folder, 'phar');
  fs.mkdirSync(phar, { recursive: true });
  for (const [name, url] of Object.entries(PHARS)) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    fs.writeFileSync(path.join(phar, name), Buffer.from(await response.arrayBuffer()));
  }
  console.log(`PHP's tools are in ${phar}`);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
