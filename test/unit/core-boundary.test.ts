import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRoot } from './helpers';

// src/core is shared by the extension host, the webview bundle and plain-Node tests, so it must
// not depend on the VS Code API or on Node built-ins.
test('src/core imports neither vscode nor Node built-ins', () => {
  const coreDir = path.join(repoRoot, 'src/core');
  const offenders: string[] = [];
  for (const file of fs.readdirSync(coreDir, { recursive: true }) as string[]) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(coreDir, file), 'utf8');
    for (const specifier of moduleSpecifiers(source)) {
      if (!specifier.startsWith('.')) offenders.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// Statement-anchored so string literals such as `'from'` are not mistaken for imports.
const SPECIFIER_PATTERNS = [
  /^\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm, // import x from 'm' / export { x } from 'm'
  /^\s*import\s*['"]([^'"]+)['"]/gm, // import 'm'
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // import('m')
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g // require('m')
];

function moduleSpecifiers(source: string): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]));
}

test('moduleSpecifiers finds every import form and ignores look-alike strings', () => {
  const source = [
    "import { a } from './a';",
    "import {\n  b,\n  c\n} from 'pkg-b';",
    "import 'side-effect';",
    "export { d } from './d';",
    "const e = require('pkg-e');",
    "const f = import('pkg-f');",
    "const side: 'from' | 'to' = 'from';",
    "const text = 'import this';"
  ].join('\n');
  assert.deepEqual(moduleSpecifiers(source).sort(), ['./a', './d', 'pkg-b', 'pkg-e', 'pkg-f', 'side-effect']);
});
