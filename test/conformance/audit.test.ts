// The node audit in every language (docs/language-context.md, part 1): each node the palette offers
// compiles, builds and prints what Simulate prints. A language whose toolchain is missing is skipped.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auditPack, formatAudit } from '../../src/conformance/audit';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { builtinLanguagePacks } from '../../src/core/languages';
import { NodeDefinition } from '../../src/core/model';

const packs = builtinLanguagePacks().all().filter((p) => p.generator?.runner);

describe('node audit', { concurrency: 4 }, () => {
  for (const pack of packs) {
    test(`every node the palette offers works in ${pack.displayName}`, async (t) => {
      const report = await auditPack(pack, builtinNodeDefinitions(), { timeoutMs: 300000 });
      if (report.missingTool) return t.skip(report.skipped);
      assert.equal(report.skipped, undefined, formatAudit(report));
      assert.deepEqual(report.findings, [], formatAudit(report));
      assert.ok((report.ran ?? 0) > 300, `only ${report.ran} cases ran`);
    });
  }

  test('a snippet that gives another answer is found', async (t) => {
    const python = builtinLanguagePacks().get('python')!;
    const definitions = builtinNodeDefinitions().map((d): NodeDefinition => (d.type === 'core:string.reverse' && d.implementation?.kind === 'code'
      ? { ...d, implementation: { ...d.implementation, languages: { ...d.implementation.languages, python: 'return text' } } }
      : d));
    const report = await auditPack(python, definitions, { filter: 'core:string.' });
    if (report.skipped) return t.skip(report.skipped);
    assert.deepEqual(report.findings.map((f) => [f.case, f.kind]), [['core:string.reverse', 'output']]);
  });
});
