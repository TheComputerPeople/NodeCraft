// The README the Marketplace shows (scripts/marketplace-readme.js) when package.json names no
// repository: links to the repository's other files become their text; links to web pages and
// headings stay. (With a repository, vsce rewrites them to it.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRoot } from './helpers';

const { marketplaceReadme } = require(path.join(repoRoot, 'scripts/marketplace-readme.js')) as { marketplaceReadme(text: string): string };

test('links to the repository\'s files become their text', () => {
  assert.equal(marketplaceReadme('See [the pack SDK](packages/pack-sdk/README.md) and [LICENSING.md](LICENSING.md).'), 'See the pack SDK and LICENSING.md.');
  assert.equal(marketplaceReadme('**[Coming from Unreal](docs/coming-from-unreal.md)**'), '**Coming from Unreal**');
});

test('links to web pages and headings, and images, are kept', () => {
  const text = 'Read [VS Code](https://code.visualstudio.com), [Settings](#settings), [mail](mailto:a@example.com) and ![a picture](images/x.png).';
  assert.equal(marketplaceReadme(text), text);
});

test('the README, as the Marketplace shows it without a repository, links to no file', () => {
  const shown = marketplaceReadme(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8'));
  const relative = [...shown.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !/^(https?:|mailto:|#)/.test(t));
  assert.deepEqual(relative, []);
  assert.match(shown, /## License/);
});
