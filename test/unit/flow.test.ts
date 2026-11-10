// The flowchart builder (src/core/codemap/flow.ts), on hand-made statements: blocks, branches,
// loops and their exits, switches, try/catch/finally, and what can't be reached.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Flowchart, MAX_BLOCK_LINES, Statement, buildFlowchart } from '../../src/core/codemap/flow';

const s = (text: string, line = 1, waits?: 'await' | 'yield'): Statement => ({ kind: 'simple', text, line, endLine: line, ...(waits ? { waits } : {}) });

// "label -edge-> label" for each arrow, by the boxes' first lines.
function arrows(chart: Flowchart): string[] {
  const label = (id: string) => chart.nodes.find((n) => n.id === id)!.label.split('\n')[0];
  return chart.edges.map((e) => `${label(e.from)} -${e.label ?? ''}${e.back ? '^' : ''}-> ${label(e.to)}`);
}

describe('flowcharts', () => {
  test('runs of plain statements are one box; awaits are their own', () => {
    const chart = buildFlowchart('f', 1, 9, [s('a()'), s('b()'), s('await c()', 3, 'await'), s('d()')]);
    assert.deepEqual(chart.nodes.map((n) => `${n.kind}:${n.label}`), ['start:f', 'end:End', 'block:a()\nb()', 'await:await c()', 'block:d()']);
    assert.deepEqual(arrows(chart), ['f --> a()', 'a() --> await c()', 'await c() --> d()', 'd() --> End']);
  });

  test('a long block shows its first lines', () => {
    const chart = buildFlowchart('f', 1, 20, Array.from({ length: 10 }, (_, i) => s(`s${i}()`, i + 1)));
    const block = chart.nodes.find((n) => n.kind === 'block')!;
    assert.equal(block.label.split('\n').length, MAX_BLOCK_LINES + 1);
    assert.equal(block.label.split('\n').at(-1), '…');
    assert.deepEqual([block.line, block.endLine], [1, 10]);
  });

  test('if and else branch and meet again; an early return goes to the end', () => {
    const chart = buildFlowchart('f', 1, 9, [
      { kind: 'if', condition: 'x < 0', line: 2, then: [{ kind: 'return', text: 'return -1', line: 3 }], else: [s('y()')] },
      s('z()')
    ]);
    assert.deepEqual(arrows(chart), ['f --> x < 0', 'x < 0 -true-> return -1', 'x < 0 -false-> y()', 'y() --> z()', 'z() --> End', 'return -1 --> End']);
  });

  test('a loop returns to its head; break leaves it, continue goes back up', () => {
    const chart = buildFlowchart('f', 1, 9, [
      { kind: 'loop', head: 'for v in xs', line: 2, body: [
        { kind: 'if', condition: 'v == 0', line: 3, then: [{ kind: 'break', text: 'break', line: 3 }] },
        { kind: 'if', condition: 'v < 0', line: 4, then: [{ kind: 'continue', text: 'continue', line: 4 }] },
        s('use(v)', 5)
      ] },
      s('done()', 6)
    ]);
    assert.deepEqual(arrows(chart), [
      'f --> for v in xs', 'for v in xs -loop-> v == 0', 'v == 0 -true-> break', 'v == 0 -false-> v < 0', 'v < 0 -true-> continue', 'continue -^-> for v in xs',
      'v < 0 -false-> use(v)', 'use(v) -^-> for v in xs', 'break --> done()', 'for v in xs -done-> done()', 'done() --> End'
    ]);
  });

  test('do-while tests after its body; a loop with no test is left only by break, by its label', () => {
    const chart = buildFlowchart('f', 1, 9, [
      { kind: 'loop', head: 'while more()', line: 2, test: 'after', body: [s('step()', 3)] },
      { kind: 'loop', head: 'loop', line: 4, test: 'forever', label: 'outer', body: [
        { kind: 'loop', head: 'loop', line: 5, test: 'forever', body: [{ kind: 'break', text: "break 'outer", line: 6, label: 'outer' }] }
      ] },
      s('after()', 8)
    ]);
    assert.deepEqual(arrows(chart), [
      'f --> do', 'do --> step()', 'step() --> while more()', 'while more() -loop^-> do', 'while more() -done-> loop',
      'loop -loop-> loop', "loop -loop-> break 'outer", "break 'outer --> after()", 'after() --> End'
    ]);
  });

  test('switch cases fall through where the language does; no default leaves a "no match" way past', () => {
    const cases = [
      { label: 'case 1', line: 2, body: [s('one()', 2)] },
      { label: 'case 2', line: 3, body: [s('two()', 3), { kind: 'break' as const, text: 'break', line: 3 }] }
    ];
    const c = buildFlowchart('f', 1, 9, [{ kind: 'switch', subject: 'switch x', line: 1, cases, fallsThrough: true }]);
    assert.deepEqual(arrows(c), ['f --> switch x', 'switch x -case 1-> one()', 'switch x -case 2-> two()', 'one() --> two()', 'two() --> break', 'break --> End', 'switch x -no match-> End']);
    const rust = buildFlowchart('f', 1, 9, [{ kind: 'switch', subject: 'match x', line: 1, cases: [{ label: '0', line: 2, body: [s('zero()', 2)] }, { label: 'default', line: 3, body: [s('other()', 3)] }], fallsThrough: false }]);
    assert.deepEqual(arrows(rust), ['f --> match x', 'match x -0-> zero()', 'match x -default-> other()', 'zero() --> End', 'other() --> End']);
  });

  test('a try\'s body may throw to its catches; a throw in it goes to them; finally follows both', () => {
    const chart = buildFlowchart('f', 1, 9, [
      { kind: 'try', line: 2, body: [s('risky()', 3), { kind: 'if', condition: 'bad', line: 4, then: [{ kind: 'throw', text: 'throw E', line: 4 }] }],
        catches: [{ label: 'catch (E e)', line: 5, body: [s('recover()', 6)] }], finally: [s('close()', 8)] },
      { kind: 'throw', text: 'throw Late', line: 9 }
    ]);
    assert.deepEqual(arrows(chart), [
      'f --> risky()', 'risky() --> bad', 'bad -true-> throw E', 'throw E -exception-> catch (E e)', 'risky() -exception-> catch (E e)',
      'catch (E e) --> recover()', 'bad -false-> finally', 'recover() --> finally', 'finally --> close()', 'close() --> throw Late', 'throw Late -throws-> End'
    ]);
  });

  test('a return or an uncaught throw in a try leaves through its finally', () => {
    const chart = buildFlowchart('f', 1, 9, [
      { kind: 'try', line: 2, body: [{ kind: 'return', text: 'return parse()', line: 3 }], catches: [], finally: [s('tree.delete()', 5)] }
    ]);
    assert.deepEqual(arrows(chart), ['f --> return parse()', 'return parse() --> finally', 'finally --> tree.delete()', 'tree.delete() -return-> End']);
    const thrown = buildFlowchart('g', 1, 9, [
      { kind: 'try', line: 2, body: [s('work()', 3), { kind: 'throw', text: 'throw E', line: 4 }], catches: [], finally: [s('close()', 6)] }
    ]);
    assert.deepEqual(arrows(thrown), ['g --> work()', 'work() --> throw E', 'throw E -throws-> finally', 'finally --> close()', 'close() -throws-> End']);
  });

  test("what follows a return isn't reached, so it isn't drawn", () => {
    const chart = buildFlowchart('f', 1, 9, [{ kind: 'return', text: 'return', line: 2 }, s('never()', 3)]);
    assert.deepEqual(chart.nodes.map((n) => n.label), ['f', 'End', 'return']);
  });
});
