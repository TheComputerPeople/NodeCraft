// The published conformance suite (docs/language-breadth.md), run on the built-in packs with the
// repository's fixtures: every fixture passes in every language. A pack without some capabilities
// gets "not applicable" for the fixtures that need them, never a failure.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatReport, runConformance } from '../../src/conformance/conformance';
import { repoFixtures } from './fixtures';
import { main } from '../../src/conformance/cli';
import { declarativePack } from '../../src/core/declarative';
import { builtinLanguagePacks } from '../../src/core/languages';
import { javascriptPack } from '../../src/core/languages/javascript';
import { repoRoot } from '../unit/helpers';

describe('published conformance suite', () => {
  for (const pack of builtinLanguagePacks().all()) {
    // Every fixture passes, except those needing what the language lacks (Rust: inheritance).
    test(`${pack.displayName} passes every fixture it can express`, async (t) => {
      const report = await runConformance(pack, { fixtures: repoFixtures() });
      if (report.skipped === report.results.length) return t.skip(report.results[0]?.message ?? 'no toolchain');
      assert.equal(report.failed, 0, formatReport(report));
      assert.equal(report.skipped, 0, formatReport(report));
      for (const result of report.results.filter((r) => r.status === 'not-applicable')) assert.match(result.message ?? '', /has no (inheritance|interfaces)/, formatReport(report));
      assert.deepEqual(report.results.filter((r) => r.status === 'not-applicable').map((r) => r.fixture), pack.capabilities.inheritance ? [] : ['programs/arena']);
    });
  }

  // A declarative pack (test/fixtures/declarative): templates, the library nodes' JavaScript
  // snippets, and Node.js to run it. It can't express objects, dispatchers or latent actions.
  test('a declarative pack passes every fixture it can express', async () => {
    const pack = declarativePack(JSON.parse(fs.readFileSync(path.join(repoRoot, 'test/fixtures/declarative/minijs.vgraph-language.json'), 'utf8')));
    const report = await runConformance(pack, { fixtures: repoFixtures() });
    assert.equal(report.failed, 0, formatReport(report));
    assert.deepEqual(report.results.filter((r) => r.status === 'not-applicable').map((r) => r.fixture), ['graphs/events.vgraph', 'graphs/latent.vgraph', 'programs/arena', 'programs/duel'], formatReport(report));
  });

  // Phase 6's exit check (docs/language-breadth.md): the C pack, a separate extension's declarative
  // definition, with gcc or clang. What it can't express is not applicable because of a capability.
  test('the C example pack passes every fixture it can express', async (t) => {
    const pack = declarativePack(JSON.parse(fs.readFileSync(path.join(repoRoot, 'examples/c-language-pack/c.vgraph-language.json'), 'utf8')));
    const report = await runConformance(pack, { fixtures: repoFixtures() });
    if (report.skipped === report.results.length) return t.skip(report.results[0]?.message ?? 'no C compiler');
    assert.equal(report.failed, 0, formatReport(report));
    assert.equal(report.skipped, 0, formatReport(report));
    const notApplicable = report.results.filter((r) => r.status === 'not-applicable');
    assert.deepEqual(notApplicable.map((r) => r.fixture), ['graphs/containers.vgraph', 'graphs/events.vgraph', 'graphs/latent.vgraph', 'graphs/utilities-collections.vgraph', 'graphs/utilities-sets.vgraph', 'programs/arena', 'programs/duel'], formatReport(report));
    for (const result of notApplicable) assert.match(result.message ?? '', /C has no (arrays|sets|event dispatchers|latent actions|object references)/);
  });

  test('JavaScript as CommonJS passes too', async () => {
    const report = await runConformance(javascriptPack, { fixtures: repoFixtures(), generate: { moduleFormat: 'commonjs' } });
    assert.equal(report.failed, 0, formatReport(report));
  });

  test("a pack without latent actions, maps or dispatchers gets those fixtures as not applicable", async () => {
    const limited = { ...javascriptPack, id: 'limited', displayName: 'Limited', capabilities: { ...javascriptPack.capabilities, async: false, containers: ['array' as const, 'set' as const], delegates: false } };
    const report = await runConformance(limited, { fixtures: repoFixtures() });
    assert.equal(report.failed, 0, formatReport(report));
    const notApplicable = report.results.filter((r) => r.status === 'not-applicable');
    assert.ok(notApplicable.some((r) => r.fixture === 'graphs/latent.vgraph' && /Limited has no latent actions/.test(r.message ?? '')), formatReport(report));
    assert.ok(notApplicable.some((r) => r.fixture === 'graphs/events.vgraph'), 'dispatchers');
    assert.ok(report.passed > 10);
  });

  test('blueprint-conformance runs a pack and exits with 0 when nothing fails', async () => {
    const log = console.log;
    const printed: string[] = [];
    console.log = (text: string) => printed.push(text);
    try {
      const fixturesDir = path.join(repoRoot, 'out', 'cli-fixtures');
      fs.rmSync(fixturesDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(fixturesDir, 'graphs'), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, 'test/fixtures/graphs/flow.vgraph'), path.join(fixturesDir, 'graphs/flow.vgraph'));
      assert.equal(await main(['javascript', '--fixtures', fixturesDir]), 0);
    } finally {
      console.log = log;
    }
    assert.match(printed.join('\n'), /javascript: 1 passed, 0 failed/);
  });
});
