// The README's Settings table lists every setting the extension contributes, with its default
// (docs/release.md, step 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRoot } from './helpers';

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { default: unknown; description?: string; markdownDescription?: string }> } };
};
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const settings = manifest.contributes.configuration.properties;

function documentedDefault(key: string): string | undefined {
  const row = readme.split('\n').find((line) => line.startsWith(`| \`${key}\` |`));
  return row?.split('|')[2]?.trim();
}

test('every setting is in the README with its default', () => {
  for (const [key, setting] of Object.entries(settings)) {
    const documented = documentedDefault(key);
    assert.ok(documented, `${key} is missing from the README's Settings table`);
    const expected = setting.default === '' ? 'empty' : `\`${JSON.stringify(setting.default)}\``;
    assert.equal(documented, expected, key);
  }
});

test('the README lists no setting that does not exist', () => {
  const listed = [...readme.matchAll(/^\| `(nodecraft\.[A-Za-z]+)` \|/gm)].map((m) => m[1]);
  for (const key of listed) assert.ok(key in settings, `${key} is in the README but not in package.json`);
});

test('every setting has a description', () => {
  for (const [key, setting] of Object.entries(settings)) assert.ok((setting.description ?? setting.markdownDescription ?? '').length > 40, key);
});

test('defaultLanguage names every built-in language', () => {
  const text = settings['nodecraft.defaultLanguage'].markdownDescription ?? '';
  for (const id of ['typescript', 'javascript', 'python', 'csharp', 'cpp', 'rust', 'java', 'go', 'lua', 'gdscript', 'ruby', 'php']) {
    assert.ok(text.includes(`\`${id}\``), id);
  }
});
