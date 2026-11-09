// The graph tabs and Back/Forward history of an open file (src/core/graph-tabs.ts).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphTabs, HISTORY_LIMIT } from '../../src/core/graph-tabs';

function visited(...ids: string[]): GraphTabs {
  const tabs = new GraphTabs();
  ids.forEach((id) => tabs.show(id));
  return tabs;
}

describe('graph tabs', () => {
  test('showing a graph opens its tab at the end, or switches to the tab it has', () => {
    const tabs = visited('EventGraph', 'Heal', 'Damage');
    assert.deepEqual(tabs.open, ['EventGraph', 'Heal', 'Damage']);
    assert.equal(tabs.active, 'Damage');
    tabs.show('Heal');
    assert.deepEqual(tabs.open, ['EventGraph', 'Heal', 'Damage'], 'no second tab');
    assert.equal(tabs.active, 'Heal');
  });

  test('Back and Forward step through the graphs visited, without new entries', () => {
    const tabs = visited('EventGraph', 'Heal', 'Damage');
    assert.equal(tabs.canGoForward, false);
    assert.equal(tabs.back(), 'Heal');
    assert.equal(tabs.back(), 'EventGraph');
    assert.equal(tabs.canGoBack, false);
    assert.equal(tabs.back(), undefined);
    assert.equal(tabs.active, 'EventGraph');
    assert.equal(tabs.forward(), 'Heal');
    assert.equal(tabs.forward(), 'Damage');
    assert.equal(tabs.forward(), undefined);
  });

  test('a visit after going back drops what Forward would have reached', () => {
    const tabs = visited('A', 'B', 'C');
    tabs.back();
    tabs.back();
    tabs.show('D');
    assert.equal(tabs.canGoForward, false);
    assert.equal(tabs.back(), 'A');
  });

  test('showing the graph already shown adds no entry', () => {
    const tabs = visited('A', 'B', 'B', 'B');
    assert.equal(tabs.back(), 'A');
    assert.equal(tabs.canGoBack, false);
  });

  test('the history keeps the latest visits', () => {
    const tabs = visited(...Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => `G${i}`));
    let steps = 0;
    while (tabs.back()) steps++;
    assert.equal(steps, HISTORY_LIMIT - 1);
    assert.equal(tabs.active, 'G10');
  });

  test('closing the shown tab shows the one shown before it', () => {
    const tabs = visited('A', 'B', 'C');
    tabs.show('A');
    assert.equal(tabs.close(['A']), 'C');
    assert.deepEqual(tabs.open, ['B', 'C']);
    // Closing another tab leaves the shown one.
    assert.equal(tabs.close(['B']), 'C');
    assert.deepEqual(tabs.open, ['C']);
  });

  test('the last tab never closes', () => {
    const tabs = visited('A');
    assert.equal(tabs.close(['A']), 'A');
    assert.deepEqual(tabs.open, ['A']);
    tabs.show('B');
    assert.equal(tabs.close(['A', 'B']), 'B');
    assert.deepEqual(tabs.open, ['A', 'B']);
  });

  test('Back reopens a graph whose tab was closed', () => {
    const tabs = visited('A', 'B', 'C');
    tabs.close(['B']);
    assert.equal(tabs.back(), 'B');
    assert.deepEqual(tabs.open, ['A', 'C', 'B']);
  });

  test('Close Other Tabs and Close Tabs to the Right', () => {
    const tabs = visited('A', 'B', 'C', 'D');
    assert.equal(tabs.closeToTheRight('B'), 'B', 'the shown tab was to the right');
    assert.deepEqual(tabs.open, ['A', 'B']);
    tabs.show('C');
    assert.equal(tabs.closeOthers('A'), 'A');
    assert.deepEqual(tabs.open, ['A']);
  });

  test('a tab moves within the tab order', () => {
    const tabs = visited('A', 'B', 'C');
    tabs.move('C', 0);
    assert.deepEqual(tabs.open, ['C', 'A', 'B']);
    tabs.move('C', 99);
    assert.deepEqual(tabs.open, ['A', 'B', 'C']);
    tabs.move('missing', 0);
    assert.deepEqual(tabs.open, ['A', 'B', 'C']);
  });

  test("deleted graphs leave the tabs and the history; the shown one's place goes to the last shown", () => {
    const tabs = visited('A', 'B', 'A', 'C');
    assert.equal(tabs.reconcile(['A', 'B'], 'A'), 'A');
    assert.deepEqual(tabs.open, ['A', 'B']);
    // A, B, A remain; C is gone, and showing A again after it added no entry.
    assert.equal(tabs.back(), 'B');
    assert.equal(tabs.back(), 'A');
    assert.equal(tabs.back(), undefined);
  });

  test('removing a visit between two of one graph makes them one entry', () => {
    const tabs = visited('A', 'B', 'A', 'C');
    tabs.reconcile(['A', 'C'], 'A');
    assert.equal(tabs.active, 'C');
    assert.equal(tabs.back(), 'A');
    assert.equal(tabs.back(), undefined);
  });

  test('with every tab gone, the fallback graph is shown', () => {
    const tabs = visited('Old');
    assert.equal(tabs.reconcile(['EventGraph'], 'EventGraph'), 'EventGraph');
    assert.deepEqual(tabs.open, ['EventGraph']);
    assert.equal(new GraphTabs().reconcile([], null), null);
  });

  test('tabs survive a save and restore, and a malformed save is ignored', () => {
    const tabs = visited('A', 'B', 'C');
    tabs.back();
    const restored = GraphTabs.restore(JSON.parse(JSON.stringify(tabs.save())));
    assert.deepEqual(restored.open, ['A', 'B', 'C']);
    assert.equal(restored.active, 'B');
    assert.equal(restored.forward(), 'C');
    assert.equal(restored.back(), 'B');
    assert.equal(restored.back(), 'A');

    for (const junk of [undefined, null, 7, 'tabs', { open: 'A' }, { open: [1, 'A', 'A'], active: 'Z', position: 99, history: ['A', 2] }]) {
      const t = GraphTabs.restore(junk);
      assert.ok(t.open.every((id) => typeof id === 'string'));
      assert.ok(t.active === null || t.open.includes(t.active));
    }
    assert.deepEqual(GraphTabs.restore({ open: [1, 'A', 'A'] }).open, ['A']);
  });
});
