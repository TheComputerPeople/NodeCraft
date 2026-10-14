// Large-graph responsiveness: a 500-node graph must load, drag and pan without lag.
import { after, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphConnection, GraphDocument, GraphNode } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions } from './harness';

// 250 Add → Print pairs in a row, exec-chained, each Add feeding its Print: 500 nodes, 749 wires.
function bigDocument(pairs = 250): GraphDocument {
  const nodes: GraphNode[] = [{ id: 'start', type: 'core:event.start', position: { x: 0, y: 0 }, properties: {} }];
  const connections: GraphConnection[] = [];
  let previous = 'start';
  for (let i = 0; i < pairs; i++) {
    const x = 300 + (i % 25) * 600;
    const y = Math.floor(i / 25) * 260;
    nodes.push({ id: `add${i}`, type: 'core:math.add', position: { x, y }, properties: {} });
    nodes.push({ id: `print${i}`, type: 'core:console.print', position: { x: x + 300, y }, properties: {} });
    connections.push({ id: `e${i}`, fromNode: previous, fromPin: 'execOut', toNode: `add${i}`, toPin: 'execIn' });
    connections.push({ id: `x${i}`, fromNode: `add${i}`, fromPin: 'execOut', toNode: `print${i}`, toPin: 'execIn' });
    connections.push({ id: `d${i}`, fromNode: `add${i}`, fromPin: 'result', toNode: `print${i}`, toPin: 'value' });
    previous = `print${i}`;
  }
  return { schemaVersion: 3, name: 'Big', kind: 'class', language: 'typescript', variables: [], graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', nodes, connections, comments: [] }] };
}

describe('large graphs', () => {
  let browser: Browser | undefined;
  let skipReason = '';
  before(async () => {
    const result = await launchBrowser();
    if (typeof result === 'string') skipReason = result;
    else browser = result;
  });
  after(async () => {
    await browser?.close();
  });

  test('a 500-node graph loads, drags and pans quickly', async (t: TestContext) => {
    if (!browser) return t.skip(skipReason);
    const e = await EditorPage.open(browser);
    try {
      const graphDocument = bigDocument();
      const started = Date.now();
      await e.send({ type: 'init', document: graphDocument, definitions: sampleDefinitions(), saveDelay: 60000 });
      const loadMs = Date.now() - started;

      // Time the editor spends handling each mouse move, measured inside the page so the test's
      // own round trips (and other tests running in parallel) don't count. Each move is followed
      // by a forced layout, as a frame would be.
      const perMove = (start: { x: number; y: number }, button: number) => e.page.evaluate(([x, y, b]) => {
        const target = document.elementFromPoint(x, y)!;
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: b, buttons: b === 2 ? 2 : 1 }));
        const t0 = performance.now();
        for (let i = 1; i <= 40; i++) {
          window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + i * 4, clientY: y + i * 2, buttons: b === 2 ? 2 : 1 }));
          void document.body.offsetHeight;
        }
        const elapsed = (performance.now() - t0) / 40;
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 160, clientY: y + 80, button: b }));
        return elapsed;
      }, [start.x, start.y, button] as const);
      const node = (await e.page.locator('.node[data-node="add0"] .node-header').boundingBox())!;
      const dragMs = await perMove({ x: node.x + 20, y: node.y + 8 }, 0);
      const panMs = await perMove({ x: 700, y: 600 }, 2);

      t.diagnostic(`load ${loadMs} ms, drag ${dragMs.toFixed(1)} ms/move, pan ${panMs.toFixed(1)} ms/move`);
      assert.deepEqual(e.errors, []);
      assert.ok(loadMs < 3000, `loading took ${loadMs} ms`);
      // Before wires were drawn from cached pin offsets, a move cost tens of milliseconds here.
      assert.ok(dragMs < 16, `dragging took ${dragMs.toFixed(1)} ms per move`);
      assert.ok(panMs < 16, `panning took ${panMs.toFixed(1)} ms per move`);
    } finally {
      await e.close();
    }
  });
});
