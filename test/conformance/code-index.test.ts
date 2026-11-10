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

const repoRoot = path.resolve(__dirname, '../../..');
const grammarDir = path.join(repoRoot, 'grammars');

// For each layout: entities that must be entry points, and imports ("from > to", by path; a graph
// file stands for its generated code) that must be there.
const EXPECTED: Record<string, { entries: string[]; imports: string[] }> = {
  'ts-vite-app': { entries: ['f:src/main.ts'], imports: ['src/main.ts > src/graphs/Greeting.vgraph', 'src/graphs/Greeting.vgraph > src/text/format.ts', 'src/graphs/Counting.vgraph > src/game/features.ts', 'src/graphs/GreetingTests.vgraph > src/graphs/Greeting.vgraph'] },
  'ts-node-library': { entries: [], imports: ['src/graphs/Greeting.vgraph > src/text/format.ts'] },
  'ts-pnpm-monorepo': { entries: [], imports: ['packages/app/src/main.ts > packages/shared/src/index.ts', 'packages/app/src/main.ts > packages/app/src/graphs/Greeting.vgraph', 'packages/app/src/graphs/Greeting.vgraph > packages/shared/src/text.ts'] },
  'js-commonjs': { entries: [], imports: ['src/index.js > src/graphs/Greeting.vgraph', 'src/graphs/Greeting.vgraph > lib/format.js'] },
  'js-esm': { entries: [], imports: ['src/index.js > src/graphs/Fetching.vgraph', 'src/graphs/Greeting.vgraph > lib/format.js', 'src/graphs/Firsts.vgraph > lib/features.js'] },
  'ts-py-shared': { entries: ['f:api/main.py'], imports: ['api/main.py > api/graphs/ShowScore.vgraph', 'api/graphs/ShowScore.vgraph > shared/Score.vgraph', 'web/src/main.ts > web/src/graphs/ShowScore.vgraph', 'web/src/graphs/ShowScore.vgraph > shared/Score.vgraph'] },
  'py-src-layout': { entries: ['f:src/corpus_game/__main__.py', 's:src/corpus_game/__main__.py#main'], imports: ['src/corpus_game/__main__.py > src/corpus_game/graphs/Greeting.vgraph', 'src/corpus_game/graphs/Greeting.vgraph > src/corpus_game/text.py', 'src/corpus_game/graphs/Counting.vgraph > src/corpus_game/features.py'] },
  'py-scripts': { entries: [], imports: ['scripts/main.py > scripts/Greeting.vgraph', 'scripts/Greeting.vgraph > scripts/score.py'] },
  'py-django-shaped': { entries: ['f:manage.py'], imports: ['manage.py > game/graphs/Greeting.vgraph', 'game/graphs/Greeting.vgraph > game/services.py'] },
  'cs-console': { entries: ['f:Program.cs'], imports: ['Program.cs > Graphs/Greeting.vgraph', 'Graphs/Greeting.vgraph > Names.cs', 'Graphs/Counting.vgraph > Features.cs'] },
  'cs-solution': { entries: ['f:src/Corpus.App/Program.cs'], imports: ['src/Corpus.App/Program.cs > src/Corpus.App/Graphs/Greeting.vgraph', 'src/Corpus.App/Graphs/Greeting.vgraph > src/Corpus.Core/Text.cs'] },
  'java-maven': { entries: ['s:src/main/java/corpus/game/Main.java#Main.main'], imports: ['src/main/java/corpus/game/Main.java > src/main/java/corpus/game/graphs/Greeting.vgraph', 'src/main/java/corpus/game/graphs/Greeting.vgraph > src/main/java/corpus/game/Text.java', 'src/main/java/corpus/game/graphs/Counting.vgraph > src/main/java/corpus/game/count/BigCounter.java'] },
  'java-gradle-multi': { entries: ['s:app/src/main/java/corpus/app/Main.java#Main.main'], imports: ['app/src/main/java/corpus/app/Main.java > app/src/main/java/corpus/app/graphs/Greeting.vgraph', 'app/src/main/java/corpus/app/graphs/Greeting.vgraph > core/src/main/java/corpus/core/Text.java'] },
  'go-module': { entries: ['s:cmd/corpus/main.go#main'], imports: ['cmd/corpus/main.go > internal/graphs/Greeting.vgraph', 'internal/graphs/Greeting.vgraph > internal/text/text.go', 'internal/graphs/Counting.vgraph > internal/features/count.go'] },
  'go-workspace': { entries: ['s:app/main.go#main'], imports: ['app/main.go > app/graphs/Greeting.vgraph', 'app/graphs/Greeting.vgraph > lib/text/text.go'] },
  'rust-bin': { entries: ['s:src/main.rs#main'], imports: ['src/main.rs > src/graphs/Greeting.vgraph', 'src/main.rs > src/features/mod.rs', 'src/features/mod.rs > src/features/count.rs', 'src/graphs/Greeting.vgraph > src/text.rs', 'src/graphs/Firsts.vgraph > src/features/lists.rs'] },
  'rust-workspace': { entries: ['s:crates/app/src/main.rs#main'], imports: ['crates/app/src/main.rs > crates/app/src/graphs/Greeting.vgraph', 'crates/app/src/graphs/Greeting.vgraph > crates/core/src/text.rs', 'crates/core/src/lib.rs > crates/core/src/text.rs'] },
  'cpp-cmake': { entries: ['s:src/main.cpp#main'], imports: ['src/main.cpp > src/graphs/Greeting.vgraph', 'src/graphs/Greeting.vgraph > lib/include/corpus/text.h', 'lib/src/text.cpp > lib/include/corpus/text.h', 'src/graphs/Counting.vgraph > src/features/count.h'] },
  'cpp-make': { entries: ['s:src/main.cpp#main'], imports: ['src/main.cpp > src/graphs/Greeting.vgraph', 'src/graphs/Greeting.vgraph > src/names.h', 'src/names.cpp > src/names.h'] },
  'cpp-c-sources': { entries: ['s:src/main.cpp#main'], imports: ['src/main.cpp > src/graphs/Room.vgraph', 'src/graphs/Room.vgraph > src/measure.h', 'src/measure.c > src/measure.h'] },
  'cpp-vcxproj': { entries: ['s:main.cpp#main'], imports: ['main.cpp > graphs/Greeting.vgraph', 'graphs/Greeting.vgraph > names.h'] },
  'ruby-gem': { entries: [], imports: ['lib/corpus_game.rb > lib/corpus_game/graphs/Greeting.vgraph', 'lib/corpus_game.rb > lib/corpus_game/text.rb', 'lib/corpus_game/graphs/Greeting.vgraph > lib/corpus_game/text.rb'] },
  'ruby-rails-shaped': { entries: [], imports: ['app/graphs/Greeting.vgraph > app/services/name_formatter.rb'] },
  'php-composer-lib': { entries: [], imports: ['src/Graphs/Greeting.vgraph > src/Text/Names.php', 'src/Graphs/Counting.vgraph > src/Features/BigCounter.php'] },
  'php-laravel-shaped': { entries: [], imports: ['app/Graphs/Greeting.vgraph > app/Services/NameFormatter.php'] },
  'lua-rock': { entries: ['f:bin/corpus_game.lua'], imports: ['bin/corpus_game.lua > src/corpus_game/graphs/Greeting.vgraph', 'src/corpus_game/graphs/Greeting.vgraph > src/corpus_game/text.lua'] },
  'lua-scripts': { entries: ['f:main.lua'], imports: ['main.lua > Greeting.vgraph', 'Greeting.vgraph > names.lua'] },
  'gd-addon': { entries: ['s:main.gd#_ready'], imports: ['main.gd > scenes/graphs/Greeting.vgraph', 'scenes/graphs/Greeting.vgraph > addons/corpus_tools/text.gd', 'scenes/graphs/Counting.vgraph > addons/corpus_tools/big_counter.gd'] }
};

const id = (p: string) => (p.endsWith('.vgraph') ? `g:${p}` : `f:${p}`);

// For each layout: calls that must be found, certain ("from > to", by entity id; a "from" ending in
// "*" is any entity starting with it): its entry point to its graphs, and its graphs to the code they call.
const CALLS: Record<string, string[]> = {
  'ts-vite-app': ['f:src/main.ts > g:src/graphs/Greeting.vgraph', 'g:src/graphs/Greeting.vgraph#Greet > s:src/text/format.ts#title'],
  'ts-node-library': ['g:src/graphs/Greeting.vgraph#Greet > s:src/text/format.ts#title'],
  'ts-pnpm-monorepo': ['f:packages/app/src/main.ts > g:packages/app/src/graphs/Greeting.vgraph', 'g:packages/app/src/graphs/Greeting.vgraph#Greet > s:packages/shared/src/text.ts#title'],
  'js-commonjs': ['f:src/index.js > g:src/graphs/Greeting.vgraph', 'g:src/graphs/Greeting.vgraph#Greet > s:lib/format.js#title'],
  'js-esm': ['f:src/index.js > g:src/graphs/Greeting.vgraph', 'g:src/graphs/Greeting.vgraph#Greet > s:lib/format.js#title'],
  'ts-py-shared': ['s:api/main.py#main > g:api/graphs/ShowScore.vgraph', 'g:api/graphs/ShowScore.vgraph > g:shared/Score.vgraph'],
  'py-src-layout': ['s:src/corpus_game/__main__.py#main > g:src/corpus_game/graphs/Greeting.vgraph', 'g:src/corpus_game/graphs/Greeting.vgraph#Greet > s:src/corpus_game/text.py#title', 's:src/corpus_game/features.py#BigCounter.__init__ > s:src/corpus_game/features.py#Counter.__init__'],
  'py-scripts': ['g:scripts/Greeting.vgraph#Greet > s:scripts/score.py#title'],
  'py-django-shaped': ['s:manage.py#main > g:game/graphs/Greeting.vgraph', 'g:game/graphs/Greeting.vgraph#Greet > s:game/services.py#title'],
  'cs-console': ['f:Program.cs > g:Graphs/Greeting.vgraph#Greet', 'g:Graphs/Greeting.vgraph#Greet > s:Names.cs#Names.Title'],
  'cs-solution': ['f:src/Corpus.App/Program.cs > g:src/Corpus.App/Graphs/Greeting.vgraph#Greet', 'g:src/Corpus.App/Graphs/Greeting.vgraph#Greet > s:src/Corpus.Core/Text.cs#Text.Title'],
  'java-maven': ['s:src/main/java/corpus/game/Main.java#Main.main > g:src/main/java/corpus/game/graphs/Greeting.vgraph', 'g:src/main/java/corpus/game/graphs/Greeting.vgraph#Greet > s:src/main/java/corpus/game/Text.java#Text.title'],
  'java-gradle-multi': ['s:app/src/main/java/corpus/app/Main.java#Main.main > g:app/src/main/java/corpus/app/graphs/Greeting.vgraph', 'g:app/src/main/java/corpus/app/graphs/Greeting.vgraph#Greet > s:core/src/main/java/corpus/core/Text.java#Text.title'],
  'go-module': ['s:cmd/corpus/main.go#main > g:internal/graphs/Greeting.vgraph#Greet', 'g:internal/graphs/Greeting.vgraph#Greet > s:internal/text/text.go#Title'],
  'go-workspace': ['s:app/main.go#main > g:app/graphs/Greeting.vgraph#Greet', 'g:app/graphs/Greeting.vgraph#Greet > s:lib/text/text.go#Title'],
  'rust-bin': ['s:src/main.rs#main > g:src/graphs/Greeting.vgraph', 'g:src/graphs/Greeting.vgraph#Greet > s:src/text.rs#title'],
  'rust-workspace': ['s:crates/app/src/main.rs#main > g:crates/app/src/graphs/Greeting.vgraph', 'g:crates/app/src/graphs/Greeting.vgraph#Greet > s:crates/core/src/text.rs#title'],
  'cpp-cmake': ['s:src/main.cpp#main > g:src/graphs/Greeting.vgraph', 'g:src/graphs/Greeting.vgraph#Greet > s:lib/src/text.cpp#corpus.title'],
  'cpp-make': ['s:src/main.cpp#main > g:src/graphs/Greeting.vgraph', 'g:src/graphs/Greeting.vgraph#Greet > s:src/names.cpp#names.title'],
  'cpp-c-sources': ['s:src/main.cpp#main > g:src/graphs/Room.vgraph', 'g:src/graphs/Room.vgraph* > s:src/measure.c#area'],
  'cpp-vcxproj': ['s:main.cpp#main > g:graphs/Greeting.vgraph', 'g:graphs/Greeting.vgraph#Greet > s:names.cpp#names.title'],
  'ruby-gem': ['g:lib/corpus_game/graphs/Greeting.vgraph#Greet > s:lib/corpus_game/text.rb#CorpusGame.Text.title'],
  'ruby-rails-shaped': ['g:app/graphs/Greeting.vgraph#Greet > s:app/services/name_formatter.rb#NameFormatter.title'],
  'php-composer-lib': ['g:src/Graphs/Greeting.vgraph#Greet > s:src/Text/Names.php#Names.title'],
  'php-laravel-shaped': ['g:app/Graphs/Greeting.vgraph#Greet > s:app/Services/NameFormatter.php#NameFormatter.title'],
  'lua-rock': ['f:bin/corpus_game.lua > g:src/corpus_game/graphs/Greeting.vgraph', 'g:src/corpus_game/graphs/Greeting.vgraph#Greet > s:src/corpus_game/text.lua#M.title'],
  'lua-scripts': ['f:main.lua > g:Greeting.vgraph', 'g:Greeting.vgraph#Greet > s:names.lua#M.title'],
  'gd-addon': ['s:main.gd#_ready > g:scenes/graphs/Greeting.vgraph', 'g:scenes/graphs/Greeting.vgraph#Greet > s:addons/corpus_tools/text.gd#title']
};

// Types that extend the workspace's own ("from > to").
const INHERITS: Record<string, string[]> = {
  'py-src-layout': ['s:src/corpus_game/features.py#BigCounter > s:src/corpus_game/features.py#Counter'],
  'ts-vite-app': ['s:src/game/features.ts#BigCounter > s:src/game/features.ts#Counter'],
  'cs-console': ['s:Features.cs#BigCounter > s:Features.cs#Counter'],
  'java-maven': ['s:src/main/java/corpus/game/count/BigCounter.java#BigCounter > s:src/main/java/corpus/game/count/Counter.java#Counter'],
  'cpp-cmake': ['s:src/features/count.h#game.BigCounter > s:src/features/count.h#game.Counter'],
  'gd-addon': ['f:addons/corpus_tools/big_counter.gd > f:addons/corpus_tools/counter.gd']
};

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
