// Find in Blueprint (Ctrl+F) and Find in All Blueprints (Ctrl+Shift+F).
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

describe('find', () => {
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
    const document = sampleDocument();
    document.variables.push({ id: 'v_hp', name: 'Health', type: { id: 'float' } });
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document, definitions: sampleDefinitions(), saveDelay: 0 });
    return editor;
  }

  const results = (e: EditorPage) => e.page.$$eval('#find-list li', (els) => els.map((el) => el.textContent));

  test('Ctrl+F searches this file as you type; clicking a result selects and centers it', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.mouse.click(700, 650);
    await e.page.keyboard.press('Control+F');
    assert.equal(await e.page.isVisible('#find-results'), true);
    await e.page.keyboard.type('print');
    assert.deepEqual(await results(e), ['nodePrintin EventGraph', 'nodePrintin EventGraph']);

    await e.page.locator('#find-list li').nth(1).click();
    assert.deepEqual(await e.page.$$eval('.node.selected', (els) => els.map((el) => (el as HTMLElement).dataset.node)), ['print_false']);
  });

  test('finds input values and variables', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.keyboard.press('Control+F');
    await e.page.fill('#find-input', 'did not');
    assert.deepEqual(await results(e), ['nodePrint: False branch: graph did not execute.in EventGraph']);
    await e.page.fill('#find-input', 'health');
    await e.page.locator('#find-list li').first().click();
    assert.equal(await e.page.getAttribute('.mb-item[data-kind="variable"]', 'class'), 'mb-item selected', 'the variable is selected in My Blueprint');
  });

  test('All files asks the host and shows its results grouped by file', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.keyboard.press('Control+Shift+F');
    assert.equal(await e.page.isChecked('#find-all'), true);
    await e.page.keyboard.type('Add');
    await e.page.waitForFunction(() => (window as unknown as { __posted: { type: string; query?: string }[] }).__posted.some((m) => m.type === 'findInAll' && m.query === 'Add'));

    await e.send({ type: 'findResults', results: [
      { kind: 'node', id: 'add_1', label: 'Add', graphId: 'EventGraph', graphName: 'EventGraph', uri: 'file:///this.vgraph', file: 'this.vgraph', current: true },
      { kind: 'node', id: 'n9', label: 'Add', graphId: 'G', graphName: 'G', uri: 'file:///other.vgraph', file: 'other.vgraph', current: false }
    ] });
    assert.deepEqual(await results(e), ['this.vgraph', 'nodeAddin EventGraph', 'other.vgraph', 'nodeAddin G']);

    await e.page.locator('#find-list li', { hasText: 'in G' }).click();
    const reveal = (await e.posted()).filter((m) => m.type === 'reveal').pop();
    assert.deepEqual(reveal?.target, { kind: 'node', id: 'n9', graphId: 'G', uri: 'file:///other.vgraph' });
  });

  test('a reveal from the host selects the node', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.send({ type: 'reveal', target: { kind: 'node', id: 'branch_1', graphId: 'EventGraph' } });
    assert.deepEqual(await e.page.$$eval('.node.selected', (els) => els.map((el) => (el as HTMLElement).dataset.node)), ['branch_1']);
  });

  test('openFind from the host (Ctrl+Shift+F in VS Code) opens Find in All Blueprints', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.send({ type: 'openFind', findAll: true });
    assert.equal(await e.page.isVisible('#find-results'), true);
    assert.equal(await e.page.isChecked('#find-all'), true);
  });
});
