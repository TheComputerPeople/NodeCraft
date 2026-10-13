// Unreal's visual language (docs/unreal-conventions.md): pin and wire colors, title styles,
// compact getters, inline defaults and the Details panel.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

describe('Unreal visual language', () => {
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
    document.graphs[0].nodes.push({ id: 'get_hp', type: 'core:variable.get', position: { x: 90, y: 400 }, properties: { variable: 'v_hp' } });
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document, definitions: sampleDefinitions(), saveDelay: 0 });
    return editor;
  }

  const style = (e: EditorPage, selector: string, property: string) =>
    e.page.$eval(selector, (el, p) => (el as HTMLElement).style.getPropertyValue(p), property);
  const pin = (node: string, id: string) => `.pin[data-node="${node}"][data-pin="${id}"]`;

  test('data pins take their type color and fill when connected; exec pins are arrows', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.equal(await style(e, pin('add_1', 'result'), '--pin-color'), '#9cf24a', 'float is yellow-green');
    assert.equal(await style(e, pin('branch_1', 'condition'), '--pin-color'), '#a01919', 'bool is dark red');
    assert.equal(await style(e, pin('add_1', 'execIn'), '--pin-color'), 'var(--exec-color)');
    assert.equal(await e.page.$eval(pin('add_1', 'result'), (el) => el.classList.contains('connected')), true);
    assert.equal(await e.page.$eval(pin('print_false', 'value'), (el) => el.classList.contains('connected')), false);
  });

  test('wires take the color of the pin they leave; exec wires are marked', async (t) => {
    const e = await open(t);
    if (!e) return;
    const wire = (from: string) => e.page.$$eval('.edge:not(.draft)', (els, f) => els
      .map((el) => ({ color: (el as SVGElement).style.getPropertyValue('--wire-color'), exec: el.classList.contains('exec') }))
      .filter((w) => w.color === f), from);
    assert.equal((await wire('#9cf24a')).length, 1, 'the float wire from Add');
    assert.equal((await wire('var(--exec-color)')).length, 6);
    assert.ok((await wire('var(--exec-color)')).every((w) => w.exec));
  });

  test('title bars follow the node kind', async (t) => {
    const e = await open(t);
    if (!e) return;
    const kinds = await e.page.$$eval('.node', (els) => Object.fromEntries(els.map((el) => [(el as HTMLElement).dataset.node, (el as HTMLElement).dataset.kind])));
    assert.equal(kinds.start_1, 'event');
    assert.equal(kinds.add_1, 'function');
    assert.equal(kinds.branch_1, 'flow');
    assert.equal(kinds.get_hp, 'variable-get');
  });

  test('variable getters are compact, showing the variable name', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.equal(await e.page.$eval('.node[data-node="get_hp"]', (el) => el.classList.contains('compact')), true);
    assert.equal(await e.count('.node[data-node="get_hp"] .node-header'), 0);
    assert.equal(await e.page.textContent('.node[data-node="get_hp"] .node-title'), 'Health');
  });

  test('unconnected inputs are edited on the node; connected ones have no editor', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.equal(await e.count(`.node[data-node="print_true"] .pin-default`), 0, 'print_true.value is wired from Add');
    const field = '.node[data-node="print_false"] .pin-default[data-pin="value"]';
    assert.equal(await e.page.inputValue(field), 'False branch: graph did not execute.');
    await e.page.fill(field, 'changed');
    assert.equal((await e.lastSavedGraph()).nodes.find((n) => n.id === 'print_false')?.properties['pin:value'], 'changed');

    const condition = '.node[data-node="branch_1"] .pin-default[data-pin="condition"]';
    assert.equal(await e.page.getAttribute(condition, 'type'), 'checkbox');
  });

  test('Details describes the selected node', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.node[data-node="add_1"] .node-header');
    assert.equal(await e.page.textContent('.panel-title >> nth=1'), 'Details');
    assert.equal(await e.page.textContent('.inspector-name'), 'Add');
    assert.match(await e.page.textContent('.details-description') ?? '', /Add two numbers/);
    assert.deepEqual(await e.page.$$eval('.details-pins dt', (els) => els.map((el) => el.textContent)), ['A', 'B', 'Result']);
  });
});
