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
import { builtinLanguagePacks } from '../../src/core/languages';
import { javascriptPack } from '../../src/core/languages/javascript';
import { repoRoot } from '../unit/helpers';

describe('published conformance suite', () => {
  for (const pack of builtinLanguagePacks().all()) {
    test(`${pack.displayName} passes every fixture`, async (t) => {
      const report = await runConformance(pack, { fixtures: repoFixtures() });
      if (report.skipped === report.results.length) return t.skip(report.results[0]?.message ?? 'no toolchain');
      assert.equal(report.failed, 0, formatReport(report));
      assert.equal(report.notApplicable, 0, formatReport(report));
      assert.equal(report.passed, report.results.length, formatReport(report));
    });
  }

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
