// The code index on the corpus of project layouts (docs/codebase-map.md, "Exit check"): each layout,
// with its graphs compiled in, is indexed with every import of its own code resolved, its generated
// code shown as its graphs, and the imports that make its structure: its entry point to its graphs,
// its graphs to the code they call. All 12 languages.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ParseService } from '../../src/extension/parse-service';
import { JsonFactsCache, factsVersion, indexFolder } from '../../src/extension/code-indexer';
import { corpusWorkDir, prepareLayout } from './corpus';
import { LAYOUTS } from './corpus-layouts';
import { CALLS, EXPECTED, INHERITS, id } from './corpus-map-expected';

const repoRoot = path.resolve(__dirname, '../../..');
const grammarDir = path.join(repoRoot, 'grammars');

describe('the code index of each layout of the corpus', () => {
  let parser: ParseService;
  let workDir: string;
  before(() => {
    parser = new ParseService(grammarDir);
    workDir = corpusWorkDir();
  });
  after(async () => {
    await parser.dispose();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('every layout has expectations', () => {
    assert.deepEqual(LAYOUTS.map((l) => l.name).filter((n) => !EXPECTED[n] || !CALLS[n]), []);
  });

  for (const layout of LAYOUTS) {
    test(layout.name, async () => {
      const { root, result } = await prepareLayout(layout, workDir);
      assert.deepEqual(result.compileErrors, []);
      const { index } = await indexFolder(root, { parser });
      const ids = new Set(index.entities.map((e) => e.id));
      assert.deepEqual(index.unresolved, [], 'every import of the workspace\'s own code is found');
      // Generated code is shown as its graph, never as a file of its own.
      assert.deepEqual(result.generated.filter((f) => ids.has(`f:${f}`)), []);
      const graphFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : graphFiles(path.join(dir, e.name))) : e.name.endsWith('.vgraph') ? [path.join(dir, e.name)] : []));
      for (const file of graphFiles(root)) assert.ok(ids.has(`g:${path.relative(root, file).split(path.sep).join('/')}`), file);
      const imports = new Set(index.imports.map((e) => `${e.from} > ${e.to}`));
      const expected = EXPECTED[layout.name];
      for (const edge of expected.imports) {
        const [from, to] = edge.split(' > ');
        assert.ok(imports.has(`${id(from)} > ${id(to)}`), `${layout.name}: ${edge}`);
      }
      for (const entry of expected.entries) assert.ok(index.entities.find((e) => e.id === entry)?.entries?.length, `${layout.name}: ${entry} is an entry point`);
      for (const edge of CALLS[layout.name]) {
        const [from, to] = edge.split(' > ');
        const found = index.calls.find((c) => c.to === to && (from.endsWith('*') ? c.from.startsWith(from.slice(0, -1)) : c.from === from));
        assert.ok(found?.certain, `${layout.name}: calls ${edge}${found ? ' (found, but not certain)' : ''}`);
      }
      for (const edge of INHERITS[layout.name] ?? []) {
        const [from, to] = edge.split(' > ');
        assert.ok(index.inherits.some((i) => i.from === from && i.to === to), `${layout.name}: ${edge}`);
      }
      // Every call and base type is between entities of the index.
      for (const c of index.calls) assert.ok(ids.has(c.from) && ids.has(c.to), `${c.from} > ${c.to}`);
      for (const i of index.inherits) assert.ok(ids.has(i.from) && (!i.to || ids.has(i.to)), `${i.from} > ${i.to}`);
      // The structure is a tree: every entity's parent is in the index, before it.
      const seen = new Set<string>();
      for (const e of index.entities) {
        if (e.parent) assert.ok(seen.has(e.parent), `${e.id}'s parent ${e.parent}`);
        seen.add(e.id);
      }
    });
  }

  test('a cache makes the second index read only what changed', async () => {
    const { root } = await prepareLayout(LAYOUTS.find((l) => l.name === 'py-src-layout')!, fs.mkdtempSync(path.join(workDir, 'cache-')));
    const cacheFile = path.join(workDir, 'facts-cache.json');
    const first = new JsonFactsCache(cacheFile, factsVersion(grammarDir));
    const cold = await indexFolder(root, { parser, cache: first });
    first.save();
    assert.equal(cold.parsed, cold.files);
    const text = path.join(root, 'src/corpus_game/text.py');
    fs.appendFileSync(text, '\n\ndef shout(name: str) -> str:\n    return name.upper()\n');
    const second = new JsonFactsCache(cacheFile, factsVersion(grammarDir));
    const warm = await indexFolder(root, { parser, cache: second });
    assert.equal(warm.parsed, 1, 'only the changed file is parsed again');
    assert.ok(warm.index.entities.some((e) => e.id === 's:src/corpus_game/text.py#shout'));
    // Another version of the queries or grammars reads everything again.
    assert.equal(new JsonFactsCache(cacheFile, 'other').get('src/corpus_game/text.py', 'x'), undefined);
  });

  test('the limit leaves files out, and says how many', async () => {
    const { root } = await prepareLayout(LAYOUTS.find((l) => l.name === 'go-module')!, fs.mkdtempSync(path.join(workDir, 'limit-')));
    const all = await indexFolder(root, { parser });
    const limited = await indexFolder(root, { parser, limit: 3 });
    assert.equal(limited.files, 3);
    assert.equal(limited.skipped, all.files - 3);
  });
});
