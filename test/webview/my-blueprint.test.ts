// The My Blueprint panel (docs/unreal-conventions.md, "Variables").
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphDocument, UIMessage } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

describe('My Blueprint panel', () => {
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

  async function open(t: TestContext, change?: (doc: GraphDocument) => void): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    const document = sampleDocument();
    document.variables.push({ id: 'v_hp', name: 'Health', type: { id: 'float' }, defaultValue: 100 });
    change?.(document);
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document, definitions: sampleDefinitions(), saveDelay: 0 });
    return editor;
  }

  // The most recent saved document, once a save satisfying `ready` has arrived.
  async function savedDocument(e: EditorPage, ready: (doc: GraphDocument) => boolean): Promise<GraphDocument> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const saves = (await e.posted()).filter((m: UIMessage) => m.type === 'applyDocument');
      const last = saves[saves.length - 1]?.document;
      if (last && ready(last)) return last;
      if (Date.now() > deadline) throw new Error('No matching save arrived');
      await e.page.waitForTimeout(25);
    }
  }

  const sectionItems = (e: EditorPage, title: string) => e.page.$$eval('.mb-section', (sections, t) => {
    const section = sections.find((s) => s.querySelector('.mb-header span')?.textContent === t);
    return section ? [...section.querySelectorAll('.mb-item .mb-name')].map((el) => el.textContent) : null;
  }, title);
  const variableItem = (name: string) => `.mb-item[data-kind="variable"]:has(.mb-name:text-is("${name}"))`;

  async function dragVariable(e: EditorPage, name: string, to: { x: number; y: number }, modifier?: string): Promise<void> {
    const box = (await e.page.locator(variableItem(name)).boundingBox())!;
    await e.page.mouse.move(box.x + 30, box.y + box.height / 2);
    await e.page.mouse.down();
    await e.page.mouse.move(to.x - 20, to.y - 20, { steps: 5 });
    if (modifier) await e.page.keyboard.down(modifier);
    await e.page.mouse.move(to.x, to.y, { steps: 2 });
    await e.page.mouse.up();
    if (modifier) await e.page.keyboard.up(modifier);
  }

  test('lists graphs, functions, macros and variables for a class', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.deepEqual(await sectionItems(e, 'Graphs'), ['EventGraph']);
    assert.deepEqual(await sectionItems(e, 'Functions'), []);
    assert.deepEqual(await sectionItems(e, 'Variables'), ['Health']);
    assert.ok(await sectionItems(e, 'Event Dispatchers'), 'shown, for later');
  });

  test('a function library shows only functions', async (t) => {
    const e = await open(t, (doc) => {
      doc.kind = 'functionLibrary';
      doc.variables = [];
      doc.graphs = [{ id: 'F', name: 'Heal', kind: 'function', signature: { inputs: [], outputs: [] }, nodes: [], connections: [], comments: [] }];
    });
    if (!e) return;
    assert.deepEqual(await sectionItems(e, 'Functions'), ['Heal']);
    assert.equal(await sectionItems(e, 'Graphs'), null);
    assert.equal(await sectionItems(e, 'Variables'), null);
  });

  test('adding a variable names it NewVar and starts renaming it', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.mb-header button[title="Add Variable"]');
    const input = e.page.locator('.mb-item[data-kind="variable"] input');
    assert.equal(await input.inputValue(), 'NewVar');
    await input.fill('Ammo');
    await input.press('Enter');
    assert.deepEqual(await sectionItems(e, 'Variables'), ['Health', 'Ammo']);
    const saved = await savedDocument(e, (d) => d.variables.some((v) => v.name === 'Ammo'));
    assert.deepEqual(saved.variables.find((v) => v.name === 'Ammo')?.type, { id: 'bool' });
  });

  test('Details edits the selected variable; nodes and the palette follow', async (t) => {
    const e = await open(t, (doc) => doc.graphs[0].nodes.push({ id: 'get_hp', type: 'core:variable.get', position: { x: 90, y: 420 }, properties: { variable: 'v_hp' } }));
    if (!e) return;
    await e.page.click(variableItem('Health'));
    await e.page.fill('input[aria-label="Variable Name"]', 'Shield');
    await e.page.press('input[aria-label="Variable Name"]', 'Enter');
    await e.page.selectOption('select[aria-label="Variable Type"]', 'int');
    const saved = await savedDocument(e, (d) => d.variables[0]?.name === 'Shield' && d.variables[0].type.id === 'int');
    assert.equal(saved.variables[0].defaultValue, 0, 'changing type resets the default');
    assert.equal(await e.page.textContent('.node[data-node="get_hp"] .node-title'), 'Shield');
    assert.ok((await e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent))).includes('Set Shield'));
    assert.match(await e.page.textContent('#inspector') ?? '', /Used by 1 node/);
  });

  test('Ctrl-drag places Get, Alt-drag places Set, a plain drag asks', async (t) => {
    const e = await open(t);
    if (!e) return;
    await dragVariable(e, 'Health', { x: 500, y: 650 }, 'Control');
    await dragVariable(e, 'Health', { x: 800, y: 650 }, 'Alt');
    await dragVariable(e, 'Health', { x: 1100, y: 650 });
    assert.equal(await e.page.isVisible('#floating-menu'), true);
    assert.deepEqual(await e.page.$$eval('#floating-menu button', (els) => els.map((el) => el.textContent)), ['Get Health', 'Set Health']);
    await e.page.locator('#floating-menu button', { hasText: 'Set Health' }).dispatchEvent('mousedown');
    const saved = await savedDocument(e, (d) => d.graphs[0].nodes.filter((n) => n.properties.variable === 'v_hp').length === 3);
    assert.deepEqual(saved.graphs[0].nodes.filter((n) => n.properties.variable === 'v_hp').map((n) => n.type), ['core:variable.get', 'core:variable.set', 'core:variable.set']);
  });

  test('dropping a variable on an input pin places a wired Get', async (t) => {
    const e = await open(t);
    if (!e) return;
    await dragVariable(e, 'Health', await e.pinCenter('print_false', 'value'));
    const saved = await savedDocument(e, (d) => d.graphs[0].connections.some((c) => c.toNode === 'print_false' && c.toPin === 'value'));
    const wire = saved.graphs[0].connections.find((c) => c.toNode === 'print_false' && c.toPin === 'value')!;
    assert.equal(saved.graphs[0].nodes.find((n) => n.id === wire.fromNode)?.type, 'core:variable.get');
  });

  test('deleting a variable removes the nodes that use it', async (t) => {
    const e = await open(t, (doc) => doc.graphs[0].nodes.push({ id: 'get_hp', type: 'core:variable.get', position: { x: 90, y: 420 }, properties: { variable: 'v_hp' } }));
    if (!e) return;
    await e.page.click(variableItem('Health'), { button: 'right' });
    await e.page.locator('#floating-menu button', { hasText: 'Delete' }).dispatchEvent('mousedown');
    assert.equal(await e.count('.node[data-node="get_hp"]'), 0);
    assert.match(await e.page.textContent('#status') ?? '', /Deleted Health and the 1 node that used it/);
  });

  test('functions are added, renamed and opened; graphs keep their own view', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.mb-header button[title="Add Function"]');
    const input = e.page.locator('.mb-item[data-kind="graph"] input');
    await input.fill('Heal');
    await input.press('Enter');
    assert.equal(await e.page.textContent('#graph-name'), 'BlueprintDemo › Heal');
    assert.equal(await e.count('.node'), 0, 'the new function is empty');

    await e.page.click('.mb-item[data-kind="graph"]:has(.mb-name:text-is("EventGraph"))');
    assert.equal(await e.count('.node'), 7);
    const saved = await savedDocument(e, (d) => d.graphs.some((g) => g.name === 'Heal'));
    assert.equal(saved.graphs.find((g) => g.name === 'Heal')?.kind, 'function');
  });

  test('renaming a graph to a taken name is refused', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.mb-header button[title="Add Graph"]');
    const input = e.page.locator('.mb-item[data-kind="graph"] input');
    await input.fill('EventGraph');
    await input.press('Enter');
    assert.match(await e.page.textContent('#status') ?? '', /already a graph named "EventGraph"/);
    assert.deepEqual(await sectionItems(e, 'Graphs'), ['EventGraph', 'NewEventGraph']);
  });
});
