// NodeCraft's license terms (docs/licensing.md): the GPL-3.0's text unchanged, the manifests
// pointing to LICENSING.md, and no production dependency whose license would tie NodeCraft to the
// GPL (the groundwork for a later move to another license).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRoot } from './helpers';

const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const { allowedLicense } = require(path.join(repoRoot, 'scripts/licenses.js')) as { allowedLicense(expression: unknown): boolean };

test('LICENSE is the GPL-3.0, word for word', () => {
  // The SHA-256 of https://www.gnu.org/licenses/gpl-3.0.txt (with its LF line endings, whatever a
  // checkout gives the file).
  const hash = createHash('sha256').update(read('LICENSE').replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(hash, '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986');
});

test('the extension and the pack SDK point to the terms, which name the license and its permissions', () => {
  for (const manifest of ['package.json', 'packages/pack-sdk/package.json']) {
    assert.equal(JSON.parse(read(manifest)).license, 'SEE LICENSE IN LICENSING.md', manifest);
  }
  const terms = read('LICENSING.md');
  assert.match(terms, /^Copyright \(C\) 2026 TheComputerPeople$/m);
  assert.match(terms, /GNU\s+General Public License, version 3 only/);
  assert.match(terms, /NodeCraft Output Exception/);
  assert.match(terms, /NodeCraft Language Pack Exception/);
  assert.match(read('README.md'), /^## License$/m);
  for (const file of ['CLA.md', 'CONTRIBUTING.md', 'docs/licensing.md', '.github/workflows/cla.yml']) assert.ok(fs.existsSync(path.join(repoRoot, file)), file);
});

test('the CLA bot asks for the sentence the CLA and CONTRIBUTING.md tell contributors to write', () => {
  const sentence = 'I have read the CLA Document and I hereby sign the CLA';
  assert.ok(read('.github/workflows/cla.yml').includes(`'${sentence}'`));
  assert.ok(read('CLA.md').includes(`> ${sentence}`));
  assert.ok(read('CONTRIBUTING.md').includes(`> ${sentence}`));
});

test('every production dependency has a license NodeCraft can include', () => {
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { dev?: boolean; devOptional?: boolean; license?: string }> };
  const production = Object.entries(lock.packages).filter(([at, entry]) => at.startsWith('node_modules/') && !entry.dev && !entry.devOptional);
  assert.ok(production.length > 0);
  for (const [at, entry] of production) assert.ok(allowedLicense(entry.license), `${at} is licensed ${entry.license}`);
});

test('a license is allowed when one of its options is permissive', () => {
  assert.ok(allowedLicense('MIT'));
  assert.ok(allowedLicense('EPL-2.0 OR GPL-3.0-or-later'));
  assert.ok(allowedLicense('(MIT OR Apache-2.0)'));
  assert.ok(allowedLicense('MIT AND ISC'));
  assert.ok(!allowedLicense('GPL-3.0-only'));
  assert.ok(!allowedLicense('LGPL-2.1-or-later'));
  assert.ok(!allowedLicense('MIT AND GPL-2.0-only'));
  assert.ok(!allowedLicense(undefined));
  assert.ok(!allowedLicense('SEE LICENSE IN LICENSE.txt'));
});
