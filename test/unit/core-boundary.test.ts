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
    // Covers `import x from 'm'`, `export … from 'm'`, `import 'm'`, `import('m')` and `require('m')`.
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith('.')) offenders.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});
