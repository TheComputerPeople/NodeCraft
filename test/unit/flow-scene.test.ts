// The control flow view (src/core/codemap/flow-scene.ts): a flowchart as the map's boxes and arrows,
// with each box's certain calls, labels on the arrows, and arrows back up.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeIndex } from '../../src/core/codemap/code-index';
import { buildFlowchart } from '../../src/core/codemap/flow';
import { MAX_FLOW_LINES, buildFlowScene, callsOf } from '../../src/core/codemap/flow-scene';

const CONTEXT = { id: 's:a.ts#total', label: 'total', path: 'a.ts', line: 1, back: false, forward: true };

// total(items): if (!items) return 0; for (const i of items) sum(i); return done();
const chart = buildFlowchart('total', 1, 9, [
  { kind: 'if', condition: '!items', line: 2, then: [{ kind: 'return', text: 'return 0', line: 2 }] },
  { kind: 'loop', head: 'for (const i of items)', line: 3, body: [{ kind: 'simple', text: 'sum(i)', line: 4, endLine: 4 }] },
  { kind: 'return', text: 'return done()', line: 6 }
]);

describe('the control flow view', () => {
  test('each node is a box, each edge an arrow with its label; loops come back up', () => {
    const scene = buildFlowScene(chart, [], CONTEXT);
    assert.equal(scene.mode, 'flow');
    assert.deepEqual(scene.flow, CONTEXT);
    assert.deepEqual(scene.boxes.map((b) => `${b.flowKind}:${b.label}`), ['start:total', 'end:End', 'decision:!items', 'return:return 0', 'loop:for (const i of items)', 'block:line 4', 'return:return done()']);
    assert.deepEqual(scene.boxes.find((b) => b.flowKind === 'block')!.members, ['sum(i)']);
    assert.ok(scene.boxes.every((b) => b.kind === 'flow' && b.path === 'a.ts'));
    const labels = scene.arrows.map((a) => a.label ?? '').filter(Boolean).sort();
    assert.deepEqual(labels, ['done', 'false', 'loop', 'true']);
    assert.equal(scene.arrows.filter((a) => a.back).length, 1, "the loop's body returns to its head");
    // Drawn as they are: every arrow its own, in the map.
    assert.equal(scene.lifted.length, scene.arrows.length);
  });

  test('a long block shows its first lines', () => {
    const long = buildFlowchart('f', 1, 30, Array.from({ length: 20 }, (_, i) => ({ kind: 'simple' as const, text: `s${i}()`, line: i + 2, endLine: i + 2 })));
    // The builder already shortens a block to its first lines; the box shows them.
    const block = buildFlowScene(long, [], CONTEXT).boxes.find((b) => b.flowKind === 'block')!;
    assert.ok(block.members!.length <= MAX_FLOW_LINES);
    assert.equal(block.label, 'lines 2–21');
  });

  test("a box lists the certain calls on its lines; a decision's are its condition's", () => {
    const index: CodeIndex = {
      entities: [{ id: 's:a.ts#sum', kind: 'function', name: 'sum' }, { id: 's:a.ts#done', kind: 'function', name: 'done' }, { id: 's:a.ts#Box', kind: 'type', name: 'Box' }],
      calls: [
        { from: 's:a.ts#total', to: 's:a.ts#sum', path: 'a.ts', line: 4, column: 5, count: 1, certain: true },
        { from: 's:a.ts#total', to: 's:a.ts#done', path: 'a.ts', line: 6, column: 10, count: 1, certain: true },
        { from: 's:a.ts#total', to: 's:a.ts#Box', path: 'a.ts', line: 6, column: 20, count: 1, certain: true },
        // A guess (a method on a variable) isn't listed.
        { from: 's:a.ts#total', to: 's:a.ts#sum', path: 'a.ts', line: 2, column: 5, count: 1, certain: false }
      ],
      imports: [], unresolved: [], unresolvedCalls: [], inherits: [], generated: []
    };
    const calls = callsOf(index, 's:a.ts#total');
    assert.deepEqual(calls.map((c) => `${c.line} ${c.label}`), ['4 sum', '6 done', '6 new Box']);
    const scene = buildFlowScene(chart, calls, CONTEXT);
    const by = (kind: string) => scene.boxes.filter((b) => b.flowKind === kind);
    assert.deepEqual(by('block')[0].calls, [{ label: 'sum', id: 's:a.ts#sum' }]);
    assert.deepEqual(by('return').find((b) => b.label === 'return done()')!.calls, [{ label: 'done', id: 's:a.ts#done' }, { label: 'new Box', id: 's:a.ts#Box' }]);
    assert.equal(by('decision')[0].calls, undefined);
  });
});
