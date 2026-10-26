// Test Case events in the editor (docs/debugging.md, "Test Case"): placed from the palette with a
// name no other test has, renamed in Details.
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

describe('test cases', () => {
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

  test('a Test Case is named uniquely, shows its name and is renamed in Details', async (t) => {
    if (!browser) return t.skip(skipReason);
    editor = await EditorPage.open(browser);
    const e = editor;
    await e.send({ type: 'init', document: sampleDocument(), definitions: sampleDefinitions(), saveDelay: 0 });
    for (const name of ['Assert True', 'Assert Equal']) assert.ok(await e.page.locator('.palette-node strong', { hasText: name }).count(), name);
    await e.page.locator('.palette-node', { hasText: 'Test Case' }).dispatchEvent('mousedown');
    await e.page.locator('.palette-node', { hasText: 'Test Case' }).dispatchEvent('mousedown');
    const titles = await e.page.$$eval('.node .node-title', (els) => els.map((el) => el.textContent).filter((text) => text?.startsWith('Test:')));
    assert.deepEqual(titles, ['Test: New Test', 'Test: New Test_1']);

    const field = e.page.locator('#inspector-content input[aria-label="Test Name"]');
    await field.fill('New Test');
    await field.press('Enter');
    assert.match((await e.page.textContent('#status'))!, /already a test named "New Test"/);
    await field.fill('Adds up');
    await field.press('Enter');
    const graph = await e.lastSavedGraph();
    await e.page.waitForFunction(() => [...document.querySelectorAll('.node .node-title')].some((el) => el.textContent === 'Test: Adds up'));
    assert.ok(graph.nodes.some((n) => n.type === 'core:test.case'));
  });
});
