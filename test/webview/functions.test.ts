// Functions in the editor (docs/program-structure.md, "Functions"): creating one, editing its
// signature in Details, calling it from another graph, and its local variables.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphDocument } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

describe('functions', () => {
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
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document: sampleDocument(), definitions: sampleDefinitions(), saveDelay: 0 });
    return editor;
  }

  const saved = async (e: EditorPage, ready: (d: GraphDocument) => boolean): Promise<GraphDocument> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const doc = (await e.posted()).filter((m) => m.type === 'applyDocument').pop()?.document;
      if (doc && ready(doc)) return doc;
      if (Date.now() > deadline) throw new Error('No matching save arrived');
      await e.page.waitForTimeout(25);
    }
  };

  test('a new function opens with its entry; its signature is edited in Details', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.mb-header:has-text("Functions") button');
    await e.page.keyboard.press('Escape');
    assert.equal(await e.page.textContent('#inspector-content .inspector-type'), 'Function');

    await e.page.click('#inspector-content button:has-text("Add input")');
    await e.page.fill('#inspector-content input[aria-label="Input Name"]', 'Amount');
    await e.page.press('#inspector-content input[aria-label="Input Name"]', 'Enter');
    await e.page.selectOption('#inspector-content select[aria-label="Amount Type"]', 'float');
    await e.page.click('#inspector-content button:has-text("Add output")');
    const doc = await saved(e, (d) => d.graphs.some((g) => g.kind === 'function' && g.signature?.outputs.length === 1));
    const fn = doc.graphs.find((g) => g.kind === 'function')!;
    assert.deepEqual(fn.signature?.inputs.map((p) => [p.name, p.type?.id]), [['Amount', 'float']]);
    assert.deepEqual(fn.nodes.map((n) => n.type).sort(), ['core:function.entry', 'core:function.return'], 'the first output adds a Return Node');
    assert.ok(fn.connections.some((c) => c.fromPin === 'execOut'), 'wired after the entry');
    assert.equal(await e.count('.node'), 2);
  });

  test('dragging a function from My Blueprint onto a graph places a call with its pins', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.mb-header:has-text("Functions") button');
    await e.page.keyboard.press('Escape');
    await e.page.click('#inspector-content button:has-text("Add input")');
    await e.page.click('.mb-item[data-kind="graph"]:has(.mb-name:text-is("EventGraph"))');
    const item = (await e.page.locator('.mb-item[data-kind="graph"]:has(.mb-name:text-is("NewFunction"))').boundingBox())!;
    await e.drag({ x: item.x + 20, y: item.y + 8 }, { x: 900, y: 650 });
    const doc = await saved(e, (d) => d.graphs[0].nodes.some((n) => n.type === 'core:function.call'));
    const call = doc.graphs[0].nodes.find((n) => n.type === 'core:function.call')!;
    assert.equal(call.properties.graph, 'NewFunction');
    const callPins = await e.page.$$eval(`.pin[data-node="${call.id}"]`, (els) => els.map((el) => (el as HTMLElement).dataset.pin));
    assert.deepEqual(callPins, ['execIn', 'NewParam', 'execOut']);
  });

  test('a function has its own local variables in My Blueprint', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.mb-header:has-text("Functions") button');
    await e.page.keyboard.press('Escape');
    await e.page.click('.mb-header:has-text("Local Variables") button');
    await e.page.keyboard.press('Escape');
    const doc = await saved(e, (d) => !!d.graphs.find((g) => g.kind === 'function')?.localVariables?.length);
    assert.deepEqual(doc.graphs.find((g) => g.kind === 'function')!.localVariables!.map((v) => v.name), ['NewLocalVar']);
    assert.equal(await e.page.isVisible('.mb-header:has-text("Local Variables")'), true);
    await e.page.click('.mb-item[data-kind="graph"]:has(.mb-name:text-is("EventGraph"))');
    assert.equal(await e.page.isVisible('.mb-header:has-text("Local Variables")'), false, 'only shown inside the function');
  });

  test('the palette offers Return Node only in functions, and no events there', async (t) => {
    const e = await open(t);
    if (!e) return;
    const names = () => e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent));
    assert.ok(!(await names()).includes('Return Node'));
    assert.ok((await names()).includes('Start'));
    await e.page.click('.mb-header:has-text("Functions") button');
    await e.page.keyboard.press('Escape');
    assert.ok((await names()).includes('Return Node'));
    assert.ok(!(await names()).includes('Start'));
    assert.ok((await names()).includes('NewFunction'), 'calls to functions are offered');
  });

  test('the entry node cannot be deleted', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.mb-header:has-text("Functions") button');
    await e.page.keyboard.press('Escape');
    await e.page.click('.node .node-header');
    await e.page.keyboard.press('Delete');
    assert.equal(await e.count('.node'), 1);
    assert.match((await e.page.textContent('#status'))!, /entry node can't be deleted/);
  });
});
