// Menus from the keyboard (docs/release.md, step 6): Shift+F10 and the Menu key open the menu a
// right-click would, the Add Node menu's results are chosen with the arrow keys and Enter, every menu
// moves with the arrow keys and closes with Escape, and My Blueprint's items and the palette's
// buttons work without a mouse.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { GraphDocument, UIMessage } from '../../src/core/model';
import { primaryGraph } from '../../src/core/serializer';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

describe('menus from the keyboard', () => {
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
    document.variables.push({ id: 'v_count', name: 'Count', type: { id: 'int' }, defaultValue: 0 });
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document, definitions: [...builtinNodeDefinitions(), ...sampleDefinitions()], saveDelay: 0 });
    return editor;
  }

  async function saved(e: EditorPage, ready: (doc: GraphDocument) => boolean): Promise<GraphDocument> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const saves = (await e.posted()).filter((m: UIMessage) => m.type === 'applyDocument');
      const last = saves[saves.length - 1]?.document;
      if (last && ready(last)) return last;
      if (Date.now() > deadline) throw new Error('No matching save arrived');
      await e.page.waitForTimeout(25);
    }
  }

  const focused = (e: EditorPage) => e.page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { id: el?.id ?? '', role: el?.getAttribute('role') ?? '', text: el?.textContent?.trim() ?? '', active: el?.getAttribute('aria-activedescendant') ?? '' };
  });

  test('Shift+F10 with nothing selected opens Add Node; the arrow keys and Enter add a result', async (t) => {
    const e = await open(t);
    if (!e) return;
    const before = primaryGraph(sampleDocument()).nodes.length;
    await e.page.keyboard.press('Shift+F10');
    await e.page.waitForSelector('#context-search');
    let at = await focused(e);
    assert.equal(at.id, 'context-search', 'the search field has focus');
    assert.equal(at.role, 'combobox');
    assert.equal(at.active, 'context-option-0', 'the first result is the one Enter adds');
    await e.page.keyboard.type('branch');
    await e.page.keyboard.press('ArrowDown');
    await e.page.keyboard.press('ArrowUp');
    at = await focused(e);
    assert.equal(at.active, 'context-option-0');
    assert.equal(await e.page.getAttribute('#context-option-0', 'aria-selected'), 'true');
    assert.match(await e.page.textContent('#context-option-0') ?? '', /Branch/);
    await e.page.keyboard.press('Enter');
    const doc = await saved(e, (d) => primaryGraph(d).nodes.length > before);
    assert.ok(primaryGraph(doc).nodes.some((n) => n.type === 'core:flow.branch'), 'Branch was added');
    assert.equal(await e.page.isHidden('#context-menu'), true, 'the menu closed');
  });

  test('the arrow keys move through the results, and Escape closes the menu', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.keyboard.press('Shift+F10');
    await e.page.waitForSelector('#context-search');
    await e.page.keyboard.press('ArrowDown');
    await e.page.keyboard.press('ArrowDown');
    assert.equal((await focused(e)).active, 'context-option-2');
    await e.page.keyboard.press('Escape');
    assert.equal(await e.page.isHidden('#context-menu'), true);
  });

  test('the Menu key on a selected node opens its menu; the arrow keys move and Enter acts', async (t) => {
    const e = await open(t);
    if (!e) return;
    const graph = primaryGraph(sampleDocument());
    const target = graph.nodes.find((n) => n.type !== 'core:event.start') ?? graph.nodes[0];
    await e.page.click(`.node[data-node="${target.id}"] .node-title, .node[data-node="${target.id}"] .node-header`);
    await e.page.keyboard.press('ContextMenu');
    await e.page.waitForSelector('#context-menu[role="menu"]');
    const first = await focused(e);
    assert.equal(first.role, 'menuitem', 'the first item has focus');
    // Down to Duplicate, wherever it is.
    for (let i = 0; i < 20 && (await focused(e)).text !== 'Duplicate'; i++) await e.page.keyboard.press('ArrowDown');
    assert.equal((await focused(e)).text, 'Duplicate');
    await e.page.keyboard.press('End');
    assert.equal((await focused(e)).text, 'Delete Node');
    await e.page.keyboard.press('Home');
    assert.equal((await focused(e)).text, first.text);
    for (let i = 0; i < 20 && (await focused(e)).text !== 'Duplicate'; i++) await e.page.keyboard.press('ArrowDown');
    await e.page.keyboard.press('Enter');
    const doc = await saved(e, (d) => primaryGraph(d).nodes.length === graph.nodes.length + 1);
    assert.equal(primaryGraph(doc).nodes.filter((n) => n.type === target.type).length, graph.nodes.filter((n) => n.type === target.type).length + 1);
    assert.equal(await e.page.isHidden('#context-menu'), true);
  });

  test('Escape closes a node menu without acting', async (t) => {
    const e = await open(t);
    if (!e) return;
    const graph = primaryGraph(sampleDocument());
    await e.page.click(`.node[data-node="${graph.nodes[0].id}"] .node-title, .node[data-node="${graph.nodes[0].id}"] .node-header`);
    await e.page.keyboard.press('Shift+F10');
    await e.page.waitForSelector('#context-menu[role="menu"]');
    await e.page.keyboard.press('Escape');
    assert.equal(await e.page.isHidden('#context-menu'), true);
    assert.equal((await e.posted()).filter((m) => m.type === 'applyDocument').length, 0, 'nothing changed');
  });

  test("My Blueprint's items: Tab reaches them, the context menu works from the keyboard, Enter acts", async (t) => {
    const e = await open(t);
    if (!e) return;
    const item = '.mb-item[data-kind="variable"][data-id="v_count"]';
    await e.page.focus(item);
    assert.equal(await e.page.evaluate((s) => document.activeElement === document.querySelector(s), item), true, 'the item takes focus');
    // The browser's context menu event, as Shift+F10 or the Menu key sends it to the focused item.
    await e.page.dispatchEvent(item, 'contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 200 });
    await e.page.waitForSelector('.floating-menu:not([hidden])');
    assert.equal((await focused(e)).role, 'menuitem');
    for (let i = 0; i < 5 && (await focused(e)).text !== 'Rename'; i++) await e.page.keyboard.press('ArrowDown');
    assert.equal((await focused(e)).text, 'Rename');
    await e.page.keyboard.press('Escape');
    assert.equal(await e.page.isHidden('.floating-menu'), true);
    assert.equal(await e.page.evaluate((s) => document.activeElement === document.querySelector(s), item), true, 'focus goes back to the item');
    // Enter selects the variable, as a click does; focus stays on it through the redraw.
    await e.page.keyboard.press('Enter');
    await e.page.waitForSelector(`${item}.selected`);
    assert.equal(await e.page.evaluate((s) => document.activeElement === document.querySelector(s), item), true, 'still focused after the redraw');
  });

  test('a press on the graph takes the keyboard from My Blueprint: Delete then deletes the node, not the item', async (t) => {
    const e = await open(t);
    if (!e) return;
    const graph = primaryGraph(sampleDocument());
    const target = graph.nodes.find((n) => n.type !== 'core:event.start') ?? graph.nodes[0];
    await e.page.focus('.mb-item[data-kind="variable"][data-id="v_count"]');
    await e.page.click(`.node[data-node="${target.id}"] .node-title, .node[data-node="${target.id}"] .node-header`);
    await e.page.keyboard.press('Delete');
    const doc = await saved(e, (d) => primaryGraph(d).nodes.length === graph.nodes.length - 1);
    assert.ok(!primaryGraph(doc).nodes.some((n) => n.id === target.id), 'the node was deleted');
    assert.ok(doc.variables.some((v) => v.id === 'v_count'), 'the variable is still there');
  });

  test("a palette button adds its node with Enter", async (t) => {
    const e = await open(t);
    if (!e) return;
    const count = primaryGraph(sampleDocument()).nodes.length;
    await e.page.fill('#search', 'Flip Flop');
    await e.page.focus('.palette-node');
    await e.page.keyboard.press('Enter');
    const doc = await saved(e, (d) => primaryGraph(d).nodes.length === count + 1);
    assert.ok(primaryGraph(doc).nodes.some((n) => n.type === 'core:flow.flip-flop'));
  });
});
