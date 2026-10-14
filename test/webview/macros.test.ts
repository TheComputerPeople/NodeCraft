// Macros in the editor (docs/program-structure.md, "Macros"): creating one, editing its signature
// (with exec pins) in Details, using it from another graph, and Collapse to Macro.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphDocument } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

describe('macros', () => {
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

  // Adds a macro with an exec input and an exec output, and returns to the event graph.
  async function addMacro(e: EditorPage): Promise<void> {
    await e.page.click('.mb-header:has-text("Macros") button');
    await e.page.keyboard.press('Escape');
    for (const side of ['input', 'output']) {
      await e.page.click(`#inspector-content button:has-text("Add ${side}")`);
      await e.page.selectOption('#inspector-content select[aria-label="NewParam Type"] >> nth=-1', 'exec');
    }
  }

  test('a new macro opens with its Inputs and Outputs; its pins may be exec pins', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.mb-header:has-text("Macros") button');
    await e.page.keyboard.press('Escape');
    assert.equal(await e.page.textContent('#inspector-content .inspector-type'), 'Macro');
    assert.equal(await e.page.isVisible('#inspector-content input[aria-label="Pure"]'), false, 'macros have no Pure setting');
    assert.equal(await e.count('.node'), 2);

    await e.page.click('#inspector-content button:has-text("Add input")');
    await e.page.selectOption('#inspector-content select[aria-label="NewParam Type"]', 'exec');
    assert.equal(await e.page.isVisible('#inspector-content select[aria-label="NewParam Type Container"]'), false, 'exec pins have no container');
    await e.page.click('#inspector-content button:has-text("Add input")');
    const doc = await saved(e, (d) => (d.graphs.find((g) => g.kind === 'macro')?.signature?.inputs.length ?? 0) === 2);
    const macro = doc.graphs.find((g) => g.kind === 'macro')!;
    assert.deepEqual(macro.nodes.map((n) => n.type), ['core:macro.inputs', 'core:macro.outputs']);
    assert.deepEqual(macro.signature?.inputs.map((p) => [p.name, p.kind]), [['NewParam', 'exec'], ['NewParam_1', 'data']]);
    const pins = await e.page.$$eval('.pin[data-node="inputs"]', (els) => els.map((el) => (el as HTMLElement).dataset.pin));
    assert.deepEqual(pins, ['NewParam', 'NewParam_1'], 'the Inputs node shows the macro\'s inputs');
  });

  test('the tunnels cannot be deleted', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.mb-header:has-text("Macros") button');
    await e.page.keyboard.press('Escape');
    await e.page.click('.node[data-node="inputs"] .node-header');
    await e.page.keyboard.press('Delete');
    assert.equal(await e.count('.node'), 2);
    assert.match((await e.page.textContent('#status'))!, /Inputs and Outputs nodes can't be deleted/);
  });

  test('dragging a macro from My Blueprint onto a graph places an instance; double-clicking it opens the macro', async (t) => {
    const e = await open(t);
    if (!e) return;
    await addMacro(e);
    await e.page.click('.mb-item[data-kind="graph"]:has(.mb-name:text-is("EventGraph"))');
    const item = (await e.page.locator('.mb-item[data-kind="graph"]:has(.mb-name:text-is("NewMacro"))').boundingBox())!;
    await e.drag({ x: item.x + 20, y: item.y + 8 }, { x: 900, y: 650 });
    const doc = await saved(e, (d) => d.graphs[0].nodes.some((n) => n.type === 'core:macro.instance'));
    const instance = doc.graphs[0].nodes.find((n) => n.type === 'core:macro.instance')!;
    assert.equal(instance.properties.graph, 'NewMacro');
    const pins = await e.page.$$eval(`.pin[data-node="${instance.id}"]`, (els) => els.map((el) => (el as HTMLElement).dataset.pin));
    assert.deepEqual(pins, ['NewParam', 'NewParam_1']);

    await e.page.dblclick(`.node[data-node="${instance.id}"] .node-header`);
    assert.equal(await e.page.isVisible('.node[data-node="inputs"]'), true, 'the macro graph is open');
  });

  test('the palette offers the blueprint\'s macros, but not a macro inside itself', async (t) => {
    const e = await open(t);
    if (!e) return;
    const names = () => e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent));
    await e.page.click('.mb-header:has-text("Macros") button');
    await e.page.keyboard.press('Escape');
    const inside = await names();
    assert.ok(!inside.includes('NewMacro'));
    assert.ok(!inside.includes('Start') && !inside.includes('Return Node') && !inside.includes('Inputs'));
    await e.page.click('.mb-item[data-kind="graph"]:has(.mb-name:text-is("EventGraph"))');
    assert.ok((await names()).includes('NewMacro'));
  });

  test('Collapse to Macro moves the selection into a new macro and uses it in its place', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.node[data-node="add_1"] .node-header');
    const box = (await e.page.locator('.node[data-node="add_1"] .node-header').boundingBox())!;
    await e.page.mouse.click(box.x + 30, box.y + 8, { button: 'right' });
    await e.page.locator('#context-menu button', { hasText: 'Collapse to Macro' }).click();
    await e.page.keyboard.press('Escape');
    const doc = await saved(e, (d) => d.graphs.some((g) => g.kind === 'macro'));
    const macro = doc.graphs.find((g) => g.kind === 'macro')!;
    assert.deepEqual(macro.nodes.map((n) => n.type).sort(), ['core:macro.inputs', 'core:macro.outputs', 'core:math.add']);
    assert.ok(doc.graphs[0].nodes.some((n) => n.type === 'core:macro.instance' && n.properties.graph === macro.id));
    assert.ok(!doc.graphs[0].nodes.some((n) => n.id === 'add_1'));
  });
});
