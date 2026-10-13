// Graph editing tools: copy/cut/paste and comment boxes (docs/unreal-conventions.md, "Nodes").
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { Graph } from '../../src/core/model';
import { EditorPage, launchBrowser } from './harness';

describe('editing tools', () => {
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
    editor = await EditorPage.withSample(browser);
    return editor;
  }

  // Dispatches a clipboard event the way VS Code routes Ctrl+C/X/V; returns the copied text.
  const clipboard = (e: EditorPage, type: 'copy' | 'cut' | 'paste', text = '') => e.page.evaluate(([kind, data]) => {
    const transfer = new DataTransfer();
    if (data) transfer.setData('text/plain', data);
    document.dispatchEvent(new ClipboardEvent(kind, { clipboardData: transfer, bubbles: true, cancelable: true }));
    return transfer.getData('text/plain');
  }, [type, text] as const);

  async function savedGraph(e: EditorPage, ready: (g: Graph) => boolean): Promise<Graph> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const g = await e.lastSavedGraph().catch(() => undefined);
      if (g && ready(g)) return g;
      if (Date.now() > deadline) throw new Error('No matching save arrived');
      await e.page.waitForTimeout(25);
    }
  }

  const header = (id: string) => `.node[data-node="${id}"] .node-header`;

  test('copy then paste adds the nodes and their wires at the pointer', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('add_1'));
    await e.page.click(header('print_true'), { modifiers: ['Shift'] });
    const text = await clipboard(e, 'copy');
    assert.match(text, /blueprint-visual-scripting\/nodes/);

    await e.page.mouse.move(500, 700);
    await clipboard(e, 'paste', text);
    assert.equal(await e.count('.node'), 9);
    assert.equal(await e.page.textContent('#status'), 'Pasted 2 nodes.');
    const g = await savedGraph(e, (graph) => graph.nodes.length === 9);
    const pasted = g.nodes.slice(-2);
    assert.ok(g.connections.some((c) => c.fromNode === pasted[0].id && c.toNode === pasted[1].id), 'the wire between them was pasted too');
    assert.deepEqual(await e.page.$$eval('.node.selected', (els) => els.length), 2, 'the pasted nodes are selected');
  });

  test('cut removes the nodes', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('end_true'));
    const text = await clipboard(e, 'cut');
    assert.ok(text);
    assert.equal(await e.count('.node'), 6);
  });

  test('pasting text that is not nodes does nothing', async (t) => {
    const e = await open(t);
    if (!e) return;
    await clipboard(e, 'paste', 'just some text');
    assert.equal(await e.count('.node'), 7);
  });

  test('C wraps the selection in a comment, ready to name', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('add_1'));
    await e.page.keyboard.press('c');
    const input = e.page.locator('.comment-rename');
    assert.equal(await input.inputValue(), 'Comment');
    await input.fill('Do the maths');
    await input.press('Enter');
    const g = await savedGraph(e, (graph) => graph.comments[0]?.text === 'Do the maths');
    const comment = g.comments[0];
    const add = g.nodes.find((n) => n.id === 'add_1')!;
    assert.ok(comment.position.x < add.position.x && comment.position.y < add.position.y, 'the box surrounds the node');
  });

  test('dragging a comment title moves the nodes inside it', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('add_1'));
    await e.page.keyboard.press('c');
    await e.page.keyboard.press('Enter');
    const title = (await e.page.locator('.comment-title').boundingBox())!;
    await e.drag({ x: title.x + 20, y: title.y + 10 }, { x: title.x + 120, y: title.y + 60 });
    const g = await savedGraph(e, (graph) => graph.nodes.find((n) => n.id === 'add_1')!.position.x !== 390);
    const add = g.nodes.find((n) => n.id === 'add_1')!;
    assert.deepEqual(add.position, { x: 490, y: 195 });
    assert.equal(g.nodes.find((n) => n.id === 'branch_1')!.position.x, 700, 'nodes outside the box stay put');
  });

  test('holding C and clicking places a comment; Delete removes it but not nodes', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.mouse.click(600, 700);
    await e.page.keyboard.down('c');
    await e.page.mouse.click(400, 650);
    await e.page.keyboard.up('c');
    await e.page.keyboard.press('Enter');
    assert.equal(await e.count('.comment'), 1);
    await e.page.click('.comment-title');
    await e.page.keyboard.press('Delete');
    assert.equal(await e.count('.comment'), 0);
    assert.equal(await e.count('.node'), 7);
  });

  test('the corner handle resizes a comment', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('start_1'));
    await e.page.keyboard.press('c');
    await e.page.keyboard.press('Enter');
    const before = (await e.page.locator('.comment').boundingBox())!;
    const handle = (await e.page.locator('.comment-resize').boundingBox())!;
    await e.drag({ x: handle.x + 7, y: handle.y + 7 }, { x: handle.x + 107, y: handle.y + 57 });
    const after = (await e.page.locator('.comment').boundingBox())!;
    assert.ok(after.width > before.width + 90 && after.height > before.height + 40);
  });
});
