// Breakpoints on nodes (docs/debugging.md, "Breakpoints"): F9, Ctrl+Shift+F9, the node menu and
// the markers. The host keeps them; the editor sends each change as 'setBreakpoints'.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphBreakpoint } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

describe('breakpoints', () => {
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

  async function open(t: TestContext, breakpoints: GraphBreakpoint[] = []): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document: sampleDocument(), definitions: sampleDefinitions(), saveDelay: 0, breakpoints });
    return editor;
  }

  const lastSent = async (e: EditorPage): Promise<GraphBreakpoint[] | undefined> =>
    (await e.posted()).filter((m) => m.type === 'setBreakpoints').pop()?.breakpoints;

  test('F9 toggles the selected node\'s breakpoint, drawn on its corner', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.keyboard.press('F9');
    assert.match((await e.page.textContent('#status'))!, /Select a node/);
    assert.equal(await lastSent(e), undefined);

    await e.page.click('.node[data-node="branch_1"] .node-header');
    await e.page.keyboard.press('F9');
    assert.deepEqual(await lastSent(e), [{ graphId: 'EventGraph', nodeId: 'branch_1', enabled: true }]);
    assert.equal(await e.count('.node[data-node="branch_1"] .node-breakpoint:not(.disabled)'), 1);
    assert.equal(await e.count('.node-breakpoint'), 1);

    await e.page.keyboard.press('F9');
    assert.deepEqual(await lastSent(e), []);
    assert.equal(await e.count('.node-breakpoint'), 0);
    assert.deepEqual((await e.posted()).filter((m) => m.type === 'applyDocument'), [], 'breakpoints never change the file');
  });

  test('the node menu adds, disables, enables and removes a breakpoint', async (t) => {
    const e = await open(t);
    if (!e) return;
    const menu = async (label: string): Promise<void> => {
      const box = (await e.page.locator('.node[data-node="branch_1"] .node-header').boundingBox())!;
      await e.page.mouse.click(box.x + 30, box.y + 8, { button: 'right' });
      await e.page.locator('#context-menu button', { hasText: label }).click();
    };
    await menu('Add Breakpoint');
    assert.equal(await e.count('.node[data-node="branch_1"] .node-breakpoint:not(.disabled)'), 1);
    await menu('Disable Breakpoint');
    assert.deepEqual(await lastSent(e), [{ graphId: 'EventGraph', nodeId: 'branch_1', enabled: false }]);
    assert.equal(await e.count('.node[data-node="branch_1"] .node-breakpoint.disabled'), 1);
    await menu('Enable Breakpoint');
    assert.equal(await e.count('.node[data-node="branch_1"] .node-breakpoint:not(.disabled)'), 1);
    await menu('Remove Breakpoint');
    assert.deepEqual(await lastSent(e), []);
    assert.equal(await e.count('.node-breakpoint'), 0);
  });

  test('breakpoints arrive from the host; Ctrl+Shift+F9 removes them all', async (t) => {
    const e = await open(t, [
      { graphId: 'EventGraph', nodeId: 'add_1', enabled: true },
      { graphId: 'EventGraph', nodeId: 'branch_1', enabled: false }
    ]);
    if (!e) return;
    assert.equal(await e.count('.node-breakpoint'), 2);
    await e.send({ type: 'breakpoints', breakpoints: [{ graphId: 'EventGraph', nodeId: 'add_1', enabled: true }] });
    assert.equal(await e.count('.node-breakpoint'), 1, 'another panel changed them');
    await e.page.keyboard.press('Control+Shift+F9');
    assert.deepEqual(await lastSent(e), []);
    assert.equal(await e.count('.node-breakpoint'), 0);
  });

  test('deleting a node removes its breakpoint', async (t) => {
    const e = await open(t, [{ graphId: 'EventGraph', nodeId: 'print_false', enabled: true }]);
    if (!e) return;
    await e.page.click('.node[data-node="print_false"] .node-header');
    await e.page.keyboard.press('Delete');
    await e.lastSavedGraph();
    assert.deepEqual(await lastSent(e), []);
  });
});
