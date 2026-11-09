// The graph tabs above the canvas and Back and Forward (docs/unreal-conventions.md, "Graph tabs").
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import * as edits from '../../src/core/blueprint-edits';
import { GraphDocument, UIMessage } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

// The sample with two functions and a macro: EventGraph, Heal, Damage and Twice.
function documentWithGraphs(): GraphDocument {
  const doc = sampleDocument();
  for (const [kind, name] of [['function', 'Heal'], ['function', 'Damage'], ['macro', 'Twice']] as const) {
    const graph = edits.addGraph(doc, kind);
    edits.renameGraph(doc, graph.id, name);
  }
  return doc;
}

describe('graph tabs', () => {
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

  async function open(t: TestContext, document = documentWithGraphs()): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document, definitions: sampleDefinitions(), saveDelay: 0 });
    return editor;
  }

  const tabNames = (e: EditorPage) => e.page.$$eval('.graph-tab .graph-tab-name', (els) => els.map((el) => el.textContent));
  const activeTab = (e: EditorPage) => e.page.textContent('.graph-tab.active .graph-tab-name');
  const tab = (name: string) => `.graph-tab:has(.graph-tab-name:text-is("${name}"))`;
  const openFromMyBlueprint = (e: EditorPage, name: string) => e.page.click(`.mb-item[data-kind="graph"]:has(.mb-name:text-is("${name}"))`);
  const shown = async (e: EditorPage) => (await e.page.textContent('#graph-name'))?.split(' › ')[1];

  test('each graph opened gets a tab, marked with its kind; a tab shows its graph', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.deepEqual(await tabNames(e), ['EventGraph']);
    assert.equal(await e.count('.graph-tab-close'), 0, 'the only tab has no close button');

    await openFromMyBlueprint(e, 'Heal');
    await openFromMyBlueprint(e, 'Twice');
    await openFromMyBlueprint(e, 'Heal');
    assert.deepEqual(await tabNames(e), ['EventGraph', 'Heal', 'Twice'], 'a graph opened again has no second tab');
    assert.equal(await activeTab(e), 'Heal');
    assert.deepEqual(await e.page.$$eval('.graph-tab', (els) => els.map((el) => (el as HTMLElement).dataset.kind)), ['event', 'function', 'macro']);
    assert.equal(await e.page.getAttribute(tab('Heal'), 'aria-selected'), 'true');

    await e.page.click(tab('EventGraph'));
    assert.equal(await shown(e), 'EventGraph');
    assert.equal(await e.count('.node[data-node="branch_1"]'), 1, "the event graph's nodes are on the canvas");
    assert.equal(await e.page.isVisible('.mb-item.active:has(.mb-name:text-is("EventGraph"))'), true, 'My Blueprint follows the tab');
  });

  test('Back and Forward go through the graphs shown: buttons, the mouse and the host', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.equal(await e.page.isDisabled('#graph-back'), true);
    await openFromMyBlueprint(e, 'Heal');
    await openFromMyBlueprint(e, 'Damage');

    await e.page.click('#graph-back');
    assert.equal(await shown(e), 'Heal');
    await e.page.click('#graph-back');
    assert.equal(await shown(e), 'EventGraph');
    assert.equal(await e.page.isDisabled('#graph-back'), true);
    await e.page.click('#graph-forward');
    assert.equal(await shown(e), 'Heal');

    // The host sends Alt+Right and Alt+Left; the editor tells it when they apply.
    const history = (await e.posted()).filter((m: UIMessage) => m.type === 'graphHistory').pop();
    assert.deepEqual({ back: history?.canGoBack, forward: history?.canGoForward }, { back: true, forward: true });
    await e.send({ type: 'navigateGraph', direction: 'forward' });
    assert.equal(await shown(e), 'Damage');
    assert.equal(await e.page.isDisabled('#graph-forward'), true);

    // The mouse's Back and Forward buttons.
    const mouse = (button: number) => e.page.evaluate((b) => {
      const canvas = document.getElementById('canvas-wrap')!;
      canvas.dispatchEvent(new MouseEvent('mousedown', { button: b, bubbles: true, cancelable: true }));
      canvas.dispatchEvent(new MouseEvent('mouseup', { button: b, bubbles: true, cancelable: true }));
    }, button);
    await mouse(3);
    assert.equal(await shown(e), 'Heal');
    await mouse(4);
    assert.equal(await shown(e), 'Damage');

    // Visiting a graph after going back drops the graphs ahead.
    await e.page.click('#graph-back');
    await openFromMyBlueprint(e, 'Twice');
    assert.equal(await e.page.isDisabled('#graph-forward'), true);
  });

  test('tabs close by their button, a middle-click and their menu; Back reopens one', async (t) => {
    const e = await open(t);
    if (!e) return;
    for (const name of ['Heal', 'Damage', 'Twice']) await openFromMyBlueprint(e, name);
    await e.page.click(tab('Heal'));

    // Closing the shown tab shows the one shown before it.
    await e.page.click(`${tab('Heal')} .graph-tab-close`);
    assert.deepEqual(await tabNames(e), ['EventGraph', 'Damage', 'Twice']);
    assert.equal(await activeTab(e), 'Twice');

    await e.page.click(tab('Damage'), { button: 'middle' });
    assert.deepEqual(await tabNames(e), ['EventGraph', 'Twice']);

    // Closing Heal showed Twice, so Back goes to Heal, reopening its tab.
    await e.page.click('#graph-back');
    assert.equal(await shown(e), 'Heal', 'Back reopens a closed graph');
    assert.deepEqual(await tabNames(e), ['EventGraph', 'Twice', 'Heal']);

    const menu = async (name: string, item: string) => {
      await e.page.click(tab(name), { button: 'right' });
      await e.page.locator('#floating-menu button', { hasText: item }).dispatchEvent('mousedown');
    };
    await menu('EventGraph', 'Close Tabs to the Right');
    assert.deepEqual(await tabNames(e), ['EventGraph']);
    assert.equal(await shown(e), 'EventGraph');
    await openFromMyBlueprint(e, 'Heal');
    await menu('Heal', 'Close Other Tabs');
    assert.deepEqual(await tabNames(e), ['Heal']);
    assert.equal(await e.count('.graph-tab-close'), 0);
    await e.page.click(tab('Heal'), { button: 'right' });
    assert.equal(await e.page.isVisible('#floating-menu'), false, 'the last tab has nothing to close');
  });

  test('a tab dragged along the strip moves', async (t) => {
    const e = await open(t);
    if (!e) return;
    await openFromMyBlueprint(e, 'Heal');
    await openFromMyBlueprint(e, 'Damage');
    const last = (await e.page.locator(tab('Damage')).boundingBox())!;
    await e.drag(await e.center(tab('EventGraph')), { x: last.x + last.width - 4, y: last.y + last.height / 2 });
    assert.deepEqual(await tabNames(e), ['Heal', 'Damage', 'EventGraph']);
    assert.equal(await activeTab(e), 'EventGraph', 'pressing a tab shows it');
  });

  test('renaming a graph renames its tab; deleting it closes the tab', async (t) => {
    const e = await open(t);
    if (!e) return;
    await openFromMyBlueprint(e, 'Heal');
    await openFromMyBlueprint(e, 'Damage');
    await e.page.dblclick('.mb-item[data-kind="graph"]:has(.mb-name:text-is("Damage"))');
    await e.page.fill('.mb-item[data-kind="graph"] input', 'Hurt');
    await e.page.keyboard.press('Enter');
    assert.deepEqual(await tabNames(e), ['EventGraph', 'Heal', 'Hurt']);
    assert.equal(await e.page.textContent('#graph-name'), 'BlueprintDemo › Hurt');

    await e.page.click('.mb-item[data-kind="graph"]:has(.mb-name:text-is("Hurt"))', { button: 'right' });
    await e.page.locator('#floating-menu button', { hasText: 'Delete' }).dispatchEvent('mousedown');
    assert.deepEqual(await tabNames(e), ['EventGraph', 'Heal']);
    assert.equal(await shown(e), 'Heal');
    assert.equal(await e.page.isDisabled('#graph-forward'), true);
  });

  test("an undo that removes a graph closes its tab; the other tabs stay", async (t) => {
    const e = await open(t);
    if (!e) return;
    await openFromMyBlueprint(e, 'Heal');
    await openFromMyBlueprint(e, 'Twice');
    const changed = documentWithGraphs();
    changed.graphs = changed.graphs.filter((g) => g.name !== 'Twice');
    await e.send({ type: 'documentChanged', document: changed });
    assert.deepEqual(await tabNames(e), ['EventGraph', 'Heal']);
    assert.equal(await shown(e), 'Heal');
  });

  test('the tabs and the graph shown come back when the editor reloads', async (t) => {
    const e = await open(t);
    if (!e) return;
    await openFromMyBlueprint(e, 'Twice');
    await openFromMyBlueprint(e, 'Heal');
    await e.page.click('#graph-back');
    await e.page.reload();
    await e.send({ type: 'init', document: documentWithGraphs(), definitions: sampleDefinitions(), saveDelay: 0 });
    assert.deepEqual(await tabNames(e), ['EventGraph', 'Twice', 'Heal']);
    assert.equal(await shown(e), 'Twice');
    await e.page.click('#graph-forward');
    assert.equal(await shown(e), 'Heal');
  });

  test('keyboard: arrows move between tabs, Delete closes one, and neither touches the nodes', async (t) => {
    const e = await open(t);
    if (!e) return;
    await openFromMyBlueprint(e, 'Heal');
    await e.page.click(tab('EventGraph'));
    await e.page.keyboard.press('Control+a');
    const nodes = await e.count('.node');
    assert.ok(nodes > 0);
    await e.page.focus(tab('EventGraph'));
    await e.page.keyboard.press('ArrowRight');
    assert.equal(await shown(e), 'Heal');
    await e.page.keyboard.press('ArrowLeft');
    assert.equal(await shown(e), 'EventGraph');
    await e.page.keyboard.press('Delete');
    assert.deepEqual(await tabNames(e), ['Heal']);
    await e.page.click(tab('Heal'));
    await e.page.click('#graph-back');
    assert.equal(await e.count('.node'), nodes, 'no node was deleted');
  });

  test('a structure file has no tabs', async (t) => {
    const e = await open(t, { schemaVersion: 3, name: 'Stats', kind: 'structure', language: 'javascript', graphs: [], metadata: {}, variables: [{ id: 'hp', name: 'Health', type: { id: 'float' }, defaultValue: 0 }] });
    if (!e) return;
    assert.equal(await e.page.isVisible('#graph-tabs'), false);
    assert.equal(await e.page.textContent('#graph-name'), 'Stats');
  });
});
