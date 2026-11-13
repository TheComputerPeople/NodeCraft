// Coming from Unreal (docs/coming-from-unreal.md) names only nodes, commands and code tags that exist
// (docs/release.md, step 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { DOCUMENT_KIND_NAMES } from '../../src/core/blueprint-edits';
import { repoRoot } from './helpers';

const guide = fs.readFileSync(path.join(repoRoot, 'docs', 'coming-from-unreal.md'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { contributes: { commands: { title: string }[] } };
const source = (file: string) => fs.readFileSync(path.join(repoRoot, 'src', 'core', file), 'utf8');

// The rows of the table under a heading, as [Unreal, Here].
function table(heading: string): [string, string][] {
  const section = guide.split(/^## /m).find((s) => s.startsWith(`${heading}\n`));
  assert.ok(section, `no section ${heading}`);
  return section.split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Unreal') && !line.startsWith('|---'))
    .map((line) => line.split('|').slice(1, 3).map((cell) => cell.trim()) as [string, string]);
}

const bold = (text: string) => [...text.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]);

// Nodes made for each class, interface, struct or enum: their titles start with these.
const PER_TYPE: Record<string, string> = {
  Construct: 'objects.ts',
  'Cast To': 'objects.ts',
  'Switch on': 'user-types.ts'
};

test('every node the Nodes table names is a built-in node, or one made for each type', () => {
  const names = new Set(builtinNodeDefinitions().map((d) => d.displayName));
  for (const [prefix, file] of Object.entries(PER_TYPE)) assert.ok(source(file).includes(`displayName: \`${prefix} \${`), prefix);
  const named = table('Nodes').flatMap(([, here]) => bold(here));
  assert.ok(named.length > 30, `${named.length} nodes`);
  for (const name of named) assert.ok(names.has(name) || name in PER_TYPE, `${name} isn't a node`);
});

test('the events it names are nodes', () => {
  const names = new Set(builtinNodeDefinitions().map((d) => d.displayName));
  for (const name of ['Start', 'Main', 'Custom Event', 'Call Event', 'Test Case', 'Assert True', 'Assert Equal', 'Delay', 'Interface Call', 'Parent', 'Self', 'Is Valid', 'Get Variable', 'Set Variable', 'Lerp', 'Save String to File', 'Load File to String']) {
    assert.ok(guide.includes(name), `${name} isn't in the guide`);
    assert.ok(names.has(name), `${name} isn't a node`);
  }
});

test('every command it names exists', () => {
  const titles = new Set(manifest.contributes.commands.map((c) => c.title));
  const named = [...guide.matchAll(/\*\*NodeCraft: ([^*]+)\*\*/g)].map((m) => m[1]);
  assert.ok(named.length >= 5, `${named.length} commands`);
  for (const title of named) assert.ok(titles.has(title), `no command ${title}`);
});

test('the assets are what New Graph offers', () => {
  const offered = table('Assets').flatMap(([, here]) => bold(here)).filter((name) => !name.startsWith('NodeCraft'));
  for (const kind of Object.values(DOCUMENT_KIND_NAMES)) assert.ok(offered.includes(kind), `${kind} is missing`);
});

test('every code tag it names is read by the scanners', () => {
  const importing = ['symbols.ts', ...fs.readdirSync(path.join(repoRoot, 'src', 'core', 'importing'))]
    .map((file) => fs.existsSync(path.join(repoRoot, 'src', 'core', 'importing', file)) ? fs.readFileSync(path.join(repoRoot, 'src', 'core', 'importing', file), 'utf8') : '')
    .join('\n');
  const rows = table('C++ and Blueprints: your code and graphs');
  const tags = rows.flatMap(([, here]) => [...here.matchAll(/`@([a-zA-Z]+)( [a-z]+)?`/g)].map((m) => [m[1], m[2]?.trim()] as const));
  assert.ok(tags.length >= 10, `${tags.length} tags`);
  for (const [tag, word] of tags) {
    assert.ok(importing.includes(`'${tag}'`), `@${tag} isn't read`);
    if (word) assert.ok(importing.includes(`^${word}\\b`), `@${tag} ${word} isn't read`);
  }
});
