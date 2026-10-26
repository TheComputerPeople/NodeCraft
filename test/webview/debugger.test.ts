// Simulate's debugger in the editor (docs/debugging.md): the paused node, the buttons and the call
// stack. The host runs the session; the editor shows its state and sends the buttons' actions.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { DebugStackFrame } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

const here = (graphId: string, nodeId: string, nodeName = ''): DebugStackFrame =>
  ({ graphId, graphName: graphId, nodeId, nodeName, uri: 'file:///demo.vgraph', fileName: 'demo', here: true });

describe('debugger', () => {
  let browser: Browser | undefined;
  let skipReason = '';
  let editor: EditorPage | undefined;

  before(async () => {
    const result = await launchBrowser();
    if (typeof result === 'string') skipReason = result;
    else browser = result;
  });
  after(async () => {
    await browser?.close();
  });
  afterEach(async () => {
    if (!editor) return;
    const errors = editor.errors;
    await editor.close();
    editor = undefined;
    assert.deepEqual(errors, [], 'the page logged errors');
  });

  async function open(t: TestContext): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    const doc = sampleDocument();
    // A function graph to stop in.
    doc.graphs.push({
      id: 'Helper', name: 'Helper', kind: 'function', comments: [], signature: { inputs: [], outputs: [] },
      nodes: [{ id: 'entry', type: 'core:function.entry', position: { x: 0, y: 0 }, properties: { graph: 'Helper' } },
        { id: 'say', type: 'core:console.print', position: { x: 2400, y: 1600 }, properties: {} }],
      connections: []
    });
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document: doc, definitions: sampleDefinitions(), saveDelay: 0 });
    return editor;
  }

  test('a pause shows the node, the buttons and the call stack; the buttons send actions', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.equal(await e.page.isVisible('#debugger'), false);
    await e.send({ type: 'debugState', debug: { state: 'running' } });
    assert.equal(await e.page.isVisible('#debugger'), true);
    assert.equal(await e.page.isDisabled('#debug-actions button[data-debug-action="stepOver"]'), true, 'stepping waits for a pause');
    assert.equal(await e.page.isDisabled('#debug-actions button[data-debug-action="stop"]'), false);

    await e.send({ type: 'debugState', debug: { state: 'paused', stack: [here('EventGraph', 'branch_1')] } });
    assert.equal(await e.page.textContent('#debug-title'), 'Paused at Branch');
    assert.equal(await e.count('.node.paused'), 1);
    assert.equal(await e.count('.node[data-node="branch_1"] .node-paused-arrow'), 1);
    await e.page.click('#debug-actions button[data-debug-action="stepOver"]');
    assert.deepEqual((await e.posted()).filter((m) => m.type === 'debugAction').map((m) => m.action), ['stepOver']);

    await e.send({ type: 'debugState', debug: { state: 'ended' } });
    assert.equal(await e.page.isVisible('#debugger'), false);
    assert.equal(await e.count('.node.paused'), 0);
  });

  test('pausing in a function graph opens it and brings the node into view', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.send({ type: 'debugState', debug: { state: 'paused', stack: [here('Helper', 'say'), here('EventGraph', 'add_1')] } });
    assert.match((await e.page.textContent('#graph-name'))!, /Helper/);
    const node = (await e.page.locator('.node[data-node="say"]').boundingBox())!;
    const canvas = (await e.page.locator('#canvas-wrap').boundingBox())!;
    assert.ok(node.x >= canvas.x && node.x + node.width <= canvas.x + canvas.width, 'the node is on screen');
    assert.deepEqual(await e.page.$$eval('#call-stack li .frame-node', (els) => els.map((el) => el.textContent)), ['Print', 'Add']);

    // A frame lower in the stack shows the calling node.
    await e.page.click('#call-stack li:nth-child(2)');
    assert.match((await e.page.textContent('#graph-name'))!, /EventGraph/);
  });

  test('a frame in another file is revealed by the host', async (t) => {
    const e = await open(t);
    if (!e) return;
    const library: DebugStackFrame = { graphId: 'Lib', graphName: 'Double It', nodeId: 'n1', nodeName: 'Multiply', uri: 'file:///lib/Math.vgraph', fileName: 'Math', here: false };
    await e.send({ type: 'debugState', debug: { state: 'paused', stack: [library, here('EventGraph', 'add_1')] } });
    assert.equal(await e.page.textContent('#debug-title'), 'Paused at Multiply');
    assert.equal(await e.count('.node.paused'), 0, 'the paused node isn\'t in this file');
    assert.match((await e.page.textContent('#call-stack li.elsewhere'))!, /Multiply Double It · ?Math|Multiply\s+Double It\s+Math/);
    await e.page.click('#call-stack li.elsewhere');
    const reveal = (await e.posted()).filter((m) => m.type === 'reveal').pop();
    assert.deepEqual(reveal?.target, { uri: 'file:///lib/Math.vgraph', kind: 'node', id: 'n1', graphId: 'Lib' });
  });
});
