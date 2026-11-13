// The corpus of project layouts (docs/project-integration.md, part 3): in each, graphs a user would
// write compile into the project, which builds, passes its own type checkers and linters, runs its
// tests and runs from its own entry point, calling the generated code that calls its code. A tool
// that isn't installed is skipped, by name (npm run corpus:tools installs the Node.js ones): a layout
// that skipped some of its steps is reported as todo, not passed, and with
// NODECRAFT_CORPUS_REQUIRE_TOOLS set (a machine that should have every tool) it fails.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { corpusWorkDir, runLayout } from './corpus';
import { LAYOUTS } from './corpus-layouts';

const workDir = corpusWorkDir();
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const requireTools = !!process.env.NODECRAFT_CORPUS_REQUIRE_TOOLS;

describe('the corpus of project layouts', { concurrency: 4 }, () => {
  for (const layout of LAYOUTS) {
    test(`${layout.name} (${layout.language})`, async (t) => {
      const result = await runLayout(layout, workDir);
      assert.deepEqual(result.compileErrors, [], 'every graph compiles');
      assert.deepEqual(result.warnings, [], 'and without warnings: placement, the project, the build registration');
      if (layout.body) assert.ok(result.generated.some((f) => f.startsWith(`${layout.body}/audit/`)), 'the node audit is in the project');
      for (const graph of result.notApplicable) t.diagnostic(`not applicable: ${graph}`);
      for (const step of result.steps) t.diagnostic(step.status === 'skipped' ? `skipped: ${step.message}` : `${step.step}: ${step.status}`);
      const failed = result.steps.filter((s) => s.status === 'failed');
      assert.deepEqual(failed.map((s) => s.step), [], failed.map((s) => s.message).join('\n\n'));
      const skipped = result.steps.filter((s) => s.status === 'skipped');
      if (requireTools) assert.deepEqual(skipped.map((s) => s.message), [], 'NODECRAFT_CORPUS_REQUIRE_TOOLS: every tool is installed');
      if (skipped.length === result.steps.length) t.skip(skipped.map((s) => s.message).join('; '));
      else if (skipped.length) t.todo(`partly checked: ${skipped.map((s) => s.message).join('; ')}`);
    });
  }
});
