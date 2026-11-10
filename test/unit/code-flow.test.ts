// Control flow in each language (docs/codebase-map.md, "Exit check"): one function per language, with a
// branch, a loop with a break, a try/catch (or an error return) and an early return, matches its
// golden flowchart; and the parsing worker gives the flowchart of the function around a line.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { Flowchart } from '../../src/core/codemap/flow';
import { CodeParser } from '../../src/extension/code-parser';
import { ParseService } from '../../src/extension/parse-service';
import { FLOW_CASES } from './code-flow-cases';
import { GOLDEN } from './code-flow-golden';
import { repoRoot } from './helpers';

const grammarDir = path.join(repoRoot, 'grammars');

function arrows(chart: Flowchart): string[] {
  const label = (id: string) => chart.nodes.find((n) => n.id === id)!.label.split('\n')[0];
  return chart.edges.map((e) => `${label(e.from)} -${e.label ?? ''}${e.back ? '^' : ''}-> ${label(e.to)}`);
}

describe('control flow in each language', () => {
  let parser: CodeParser;
  before(async () => {
    parser = await CodeParser.create(grammarDir);
  });
  after(() => parser.dispose());

  test('every language has a golden flowchart', () => {
    assert.deepEqual(FLOW_CASES.map((c) => c.grammar).sort(), Object.keys(GOLDEN).sort());
    assert.equal(FLOW_CASES.length, 13);
  });

  for (const c of FLOW_CASES) {
    test(c.grammar, async () => {
      const chart = await parser.flow(c.grammar, c.code, c.line);
      assert.ok(chart, 'a function is found');
      assert.deepEqual({ name: chart.name, lines: [chart.line, chart.endLine], arrows: arrows(chart) }, GOLDEN[c.grammar]);
      // Every box but the start is reached, and every box but the end leads somewhere.
      for (const node of chart.nodes) {
        if (node.kind !== 'start') assert.ok(chart.edges.some((e) => e.to === node.id), `${c.grammar}: ${node.label} is reached`);
        if (node.kind !== 'end') assert.ok(chart.edges.some((e) => e.from === node.id), `${c.grammar}: ${node.label} leads somewhere`);
      }
      // The exit check's ingredients: a decision, a loop left by a break, and an early return.
      const kinds = new Set(chart.nodes.map((n) => n.kind));
      for (const kind of ['decision', 'loop', 'break', 'return'] as const) assert.ok(kinds.has(kind) || (kind === 'return' && c.grammar === 'rust'), `${c.grammar} has a ${kind}`);
    });
  }

  test('the innermost function around a line, and none outside every function', async () => {
    const code = 'function outer() {\n  const inner = () => {\n    if (a) return 1;\n    return 2;\n  };\n  return inner();\n}\nconst x = 1;\n';
    assert.equal((await parser.flow('typescript', code, 3))?.line, 2, 'the arrow function');
    assert.equal((await parser.flow('typescript', code, 6))?.name, 'outer');
    assert.equal(await parser.flow('typescript', code, 8), undefined);
  });

  test('the parsing worker gives flowcharts too', async () => {
    const service = new ParseService(grammarDir);
    try {
      const c = FLOW_CASES.find((x) => x.grammar === 'go')!;
      const chart = await service.flow(c.grammar, c.code, c.line);
      assert.deepEqual(chart && arrows(chart), GOLDEN.go.arrows);
    } finally {
      await service.dispose();
    }
  });
});
