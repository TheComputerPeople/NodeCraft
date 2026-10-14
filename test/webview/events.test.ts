// Custom events and event dispatchers in the editor (docs/program-structure.md, "Custom events and
// event dispatchers"): placing and naming a custom event, its inputs in Details, calling it, and
// declaring, dragging and assigning an event dispatcher.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphDocument } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

describe('custom events and event dispatchers', () => {
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
  const paletteNames = (e: EditorPage) => e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent));

  test('a custom event gets a free name, takes inputs in Details, and can be called', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.locator('.palette-node', { hasText: 'Custom Event' }).first().dispatchEvent('mousedown');
    assert.equal(await e.page.textContent('#inspector-content .inspector-type'), 'Custom Event');
    await e.page.fill('#inspector-content input[aria-label="Event Name"]', 'On Hit');
    await e.page.press('#inspector-content input[aria-label="Event Name"]', 'Enter');
    await e.page.click('#inspector-content button:has-text("Add input")');
    await e.page.selectOption('#inspector-content select[aria-label="NewParam Type"]', 'float');
    const doc = await saved(e, (d) => d.graphs[0].nodes.some((n) => n.type === 'core:event.custom' && n.properties.name === 'On Hit' && (n.properties.inputs as unknown[])?.length === 1));
    const event = doc.graphs[0].nodes.find((n) => n.type === 'core:event.custom')!;
    assert.deepEqual(await e.page.$$eval(`.pin[data-node="${event.id}"]`, (els) => els.map((el) => (el as HTMLElement).dataset.pin)), ['delegate', 'execOut', 'NewParam']);
    assert.ok((await paletteNames(e)).includes('On Hit'), 'the event can be called');

    await e.page.locator('.palette-node', { hasText: 'Custom Event' }).first().dispatchEvent('mousedown');
    const second = await saved(e, (d) => d.graphs[0].nodes.filter((n) => n.type === 'core:event.custom').length === 2);
    assert.deepEqual(second.graphs[0].nodes.filter((n) => n.type === 'core:event.custom').map((n) => n.properties.name), ['On Hit', 'CustomEvent']);
  });

  test('an event dispatcher is declared in My Blueprint, and Assign binds a new event to it', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.mb-header:has-text("Event Dispatchers") button');
    await e.page.keyboard.press('Enter');
    assert.equal(await e.page.textContent('#inspector-content .inspector-type'), 'Event Dispatcher');
    await e.page.click('#inspector-content button:has-text("Add input")');
    for (const name of ['Call NewEventDispatcher', 'Bind Event to NewEventDispatcher']) assert.ok((await paletteNames(e)).includes(name), name);

    const item = (await e.page.locator('.mb-item[data-kind="dispatcher"]').boundingBox())!;
    await e.drag({ x: item.x + 20, y: item.y + 8 }, { x: 900, y: 650 });
    assert.deepEqual(await e.page.$$eval('#floating-menu button', (els) => els.map((el) => el.textContent)), ['Call', 'Bind', 'Unbind', 'Unbind all', 'Assign']);
    await e.page.locator('#floating-menu button', { hasText: 'Assign' }).click();
    const doc = await saved(e, (d) => d.graphs[0].nodes.some((n) => n.type === 'core:dispatcher.bind'));
    const bind = doc.graphs[0].nodes.find((n) => n.type === 'core:dispatcher.bind')!;
    const event = doc.graphs[0].nodes.find((n) => n.type === 'core:event.custom')!;
    assert.equal(event.properties.name, 'NewEventDispatcher_Event');
    assert.deepEqual((event.properties.inputs as { name: string }[]).map((p) => p.name), ['NewParam']);
    assert.ok(doc.graphs[0].connections.some((c) => c.fromNode === event.id && c.fromPin === 'delegate' && c.toNode === bind.id && c.toPin === 'event'));
    assert.deepEqual(doc.dispatchers?.map((d) => d.name), ['NewEventDispatcher']);
  });
});
