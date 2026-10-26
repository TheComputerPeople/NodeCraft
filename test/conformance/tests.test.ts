// Test Case events and Assert nodes (docs/debugging.md, "Test Case"): Simulate and each language's
// generated test file, run with its test tool, agree on which tests pass and why the others fail.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { GraphRuntime } from '../../src/core/runtime';
import { ToolNotFoundError, runGeneratedCode } from '../../src/extension/runner';
import { doc, node, wire } from '../unit/helpers';

const languages = builtinLanguagePacks();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-tests-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

// "Adds up" sets Score to 2 + 3 and asserts it is 5 and more than 4; "Fails on purpose" asserts
// 1 equals 2.
function calculator(language: string): GraphDocument {
  const d = doc(
    [
      node('t1', 'core:test.case', { name: 'Adds up' }),
      node('add', 'core:math.add', { 'pin:a': 2, 'pin:b': 3 }),
      node('set', 'core:variable.set', { variable: 'v_score' }),
      node('get', 'core:variable.get', { variable: 'v_score' }),
      node('eq', 'core:test.assert-equal', { wildcards: { wildcard: 'float' }, 'pin:expected': 5 }),
      node('gt', 'core:math.greater', { 'pin:b': 4 }),
      node('at', 'core:test.assert-true', { 'pin:message': 'more than four' }),
      node('t2', 'core:test.case', { name: 'Fails on purpose' }),
      node('eq2', 'core:test.assert-equal', { wildcards: { wildcard: 'int' }, 'pin:actual': 1, 'pin:expected': 2, 'pin:message': 'math' })
    ],
    [
      wire('t1', 'execOut', 'add', 'execIn'), wire('add', 'execOut', 'set', 'execIn'), wire('add', 'result', 'set', 'value'),
      wire('set', 'execOut', 'eq', 'execIn'), wire('get', 'value', 'eq', 'actual'),
      wire('eq', 'execOut', 'at', 'execIn'), wire('get', 'value', 'gt', 'a'), wire('gt', 'returnValue', 'at', 'condition'),
      wire('t2', 'execOut', 'eq2', 'execIn')
    ],
    [{ id: 'v_score', name: 'Score', type: { id: 'float' }, defaultValue: 0 }]
  );
  return { ...d, name: 'Calc', language };
}

const FAILURE = 'Expected 2, got 1: math';

describe('tests in graphs', () => {
  test('Simulate runs each Test Case on a new object and reports each result', () => {
    const results = new GraphRuntime(new NodeRegistry(), () => {}).runTests(calculator('javascript'));
    assert.deepEqual(results.map((r) => [r.name, r.passed, r.message]), [['Adds up', true, undefined], ['Fails on purpose', false, FAILURE]]);
  });

  test('a normal Simulate run doesn\'t run tests', () => {
    const d = calculator('javascript');
    d.graphs[0].nodes.push(node('s', 'core:event.start'));
    const events: string[] = [];
    new GraphRuntime(new NodeRegistry(), (e) => events.push(e.kind)).run(d);
    assert.ok(!events.includes('error'));
    assert.ok(!events.includes('node.enter') || events.filter((k) => k === 'node.enter').length === 1);
  });

  // How each tool reports a passing and a failing test.
  const reports: Record<string, { pass: RegExp; fail: RegExp }> = {
    javascript: { pass: /(✔|ok \d+ -) Adds up/, fail: /(✖|not ok \d+ -) Fails on purpose/ },
    typescript: { pass: /(✔|ok \d+ -) Adds up/, fail: /(✖|not ok \d+ -) Fails on purpose/ },
    python: { pass: /Adds up \.\.\. ok/, fail: /Fails on purpose \.\.\. FAIL/ },
    csharp: { pass: /PASS Adds up/, fail: /FAIL Fails on purpose: Expected 2, got 1: math/ }
  };

  for (const language of Object.keys(reports)) {
    test(`${language}: Run Tests runs the generated tests with the language's test tool`, async (t) => {
      const generator = languages.get(language)!.generator!;
      const result = compileDocument(calculator(language), { registry: new NodeRegistry(), languages, generate: { sourceFileName: 'Calc.vgraph' } });
      assert.deepEqual(result.diagnostics, []);
      const output = result.output!;
      assert.deepEqual(output.tests?.map((x) => x.name), ['Adds up', 'Fails on purpose']);
      const dir = fs.mkdtempSync(path.join(workDir, `${language}-`));
      const file = path.join(dir, output.fileName);
      fs.writeFileSync(file, output.text);
      const testFile = output.testFile ? path.join(dir, generator.testFileName!('Calc.vgraph')) : undefined;
      if (testFile) fs.writeFileSync(testFile, output.testFile!);
      let outcome;
      try {
        outcome = await runGeneratedCode(generator.runner!, file, output.className, { cwd: dir, timeoutMs: 300000, tests: { testFile, cases: output.tests! } });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      const text = outcome.stdout + outcome.stderr;
      assert.notEqual(outcome.exitCode, 0, 'a failing test fails the run');
      assert.match(text, reports[language].pass, text);
      assert.match(text, reports[language].fail, text);
      assert.ok(text.includes(FAILURE), text);
    });
  }
});
