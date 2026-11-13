// Nodes and pins from the keyboard (docs/release.md, step 7): the canvas takes focus, the arrow keys
// move between nodes and their pins, a pin's menu connects it (Connect to) or adds a node from it
// (Add Node from Here), F2 edits a pin's value, and Ctrl+arrows nudge.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { Graph, UIMessage } from '../../src/core/model';
import { primaryGraph } from '../../src/core/serializer';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

describe('nodes and pins from the keyboard', () => {
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
    await editor.send({ type: 'init', document: sampleDocument(), definitions: [...builtinNodeDefinitions(), ...sampleDefinitions()], saveDelay: 0 });
    return editor;
  }

  async function saved(e: EditorPage, ready: (graph: Graph) => boolean): Promise<Graph> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const saves = (await e.posted()).filter((m: UIMessage) => m.type === 'applyDocument');
      const last = saves[saves.length - 1]?.document;
      if (last && ready(primaryGraph(last))) return primaryGraph(last);
      if (Date.now() > deadline) throw new Error('No matching save arrived');
      await e.page.waitForTimeout(25);
    }
  }

  // What the keyboard is on: the node, and the pin when it's on one.
  const focus = (e: EditorPage) => e.page.evaluate(() => {
    const el = document.getElementById('graph-focus');
    const canvas = document.getElementById('canvas-wrap')!;
    return {
      node: el?.dataset.node ?? null,
      pin: el?.classList.contains('pin') ? el.dataset.pin ?? null : null,
      canvasFocused: document.activeElement === canvas,
      activedescendant: canvas.getAttribute('aria-activedescendant')
    };
  });

  // Moves the keyboard to a node: from wherever it is, by pressing the arrow keys toward it.
  async function arrowTo(e: EditorPage, nodeId: string): Promise<void> {
    for (let i = 0; i < 12; i++) {
      const at = await focus(e);
      if (at.node === nodeId && !at.pin) return;
      const [from, to] = await e.page.evaluate(([a, b]) => [a, b].map((id) => {
        const r = document.querySelector<HTMLElement>(`.node[data-node="${id}"]`)!.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }), [at.node ?? '', nodeId] as const);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      await e.page.keyboard.press(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft') : (dy > 0 ? 'ArrowDown' : 'ArrowUp'));
    }
    assert.equal((await focus(e)).node, nodeId, `reached ${nodeId}`);
  }

  test('Tab reaches the graph: the keyboard starts on the first node, and the arrows move and select', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.focus('#canvas-wrap');
    let at = await focus(e);
    assert.equal(at.canvasFocused, true);
    assert.equal(at.node, 'start_1', 'the top-left node');
    assert.equal(at.activedescendant, 'graph-focus');
    assert.equal(await e.page.getAttribute('#canvas-wrap', 'role'), 'application');
    await e.page.keyboard.press('ArrowRight');
    at = await focus(e);
    assert.notEqual(at.node, 'start_1');
    assert.deepEqual(await e.page.$$eval('.node.selected', (els) => els.map((el) => (el as HTMLElement).dataset.node)), [at.node], 'selection follows');
    await arrowTo(e, 'branch_1');
    assert.equal((await e.posted()).filter((m) => m.type === 'applyDocument').length, 0, 'the arrows alone move nothing');
  });

  test('Enter goes into a node\'s pins, the arrows move between them, Escape comes back out', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.focus('#canvas-wrap');
    await arrowTo(e, 'branch_1');
    await e.page.keyboard.press('Enter');
    assert.deepEqual(await focus(e), { node: 'branch_1', pin: 'execIn', canvasFocused: true, activedescendant: 'graph-focus' });
    await e.page.keyboard.press('ArrowDown');
    assert.equal((await focus(e)).pin, 'condition');
    await e.page.keyboard.press('ArrowRight');
    assert.equal((await focus(e)).pin, 'false', 'the output on the same row');
    await e.page.keyboard.press('ArrowUp');
    assert.equal((await focus(e)).pin, 'true');
    await e.page.keyboard.press('Escape');
    assert.deepEqual([(await focus(e)).node, (await focus(e)).pin], ['branch_1', null]);
  });

  test('Add Node from Here adds a node wired to the pin', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.focus('#canvas-wrap');
    await arrowTo(e, 'end_true');
    await arrowTo(e, 'print_true');
    await e.page.keyboard.press('Enter');
    // To Print's exec output.
    for (let i = 0; i < 4 && (await focus(e)).pin !== 'execOut'; i++) await e.page.keyboard.press('ArrowRight');
    assert.equal((await focus(e)).pin, 'execOut');
    await e.page.keyboard.press('Enter');
    await e.page.waitForSelector('#context-menu[role="menu"]');
    for (let i = 0; i < 6 && !(await e.page.evaluate(() => document.activeElement?.textContent ?? '')).startsWith('Add Node from Here'); i++) await e.page.keyboard.press('ArrowDown');
    await e.page.keyboard.press('Enter');
    await e.page.waitForSelector('#context-search');
    await e.page.keyboard.type('flip flop');
    await e.page.keyboard.press('Enter');
    const graph = await saved(e, (g) => g.nodes.some((n) => n.type === 'core:flow.flip-flop'));
    const added = graph.nodes.find((n) => n.type === 'core:flow.flip-flop')!;
    assert.ok(graph.connections.some((c) => c.fromNode === 'print_true' && c.fromPin === 'execOut' && c.toNode === added.id), JSON.stringify(graph.connections));
  });

  test('Connect to lists the pins a pin can be wired to, and wires the one chosen', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.focus('#canvas-wrap');
    await arrowTo(e, 'print_false');
    await e.page.keyboard.press('Enter');
    // Print's Value input.
    for (let i = 0; i < 4 && (await focus(e)).pin !== 'value'; i++) await e.page.keyboard.press('ArrowDown');
    assert.equal((await focus(e)).pin, 'value');
    await e.page.keyboard.press('Shift+F10');
    await e.page.waitForSelector('#context-menu[role="menu"]');
    assert.equal(await e.page.evaluate(() => document.activeElement?.textContent), 'Connect to…', 'the first item');
    await e.page.keyboard.press('Enter');
    await e.page.waitForSelector('#context-menu .context-title:has-text("Connect")');
    const choices = await e.page.$$eval('#context-menu button[role="menuitem"]', (els) => els.map((el) => el.textContent));
    assert.ok(choices.includes('Add: Result'), choices.join(', '));
    while ((await e.page.evaluate(() => document.activeElement?.textContent)) !== 'Add: Result') await e.page.keyboard.press('ArrowDown');
    await e.page.keyboard.press('Enter');
    const graph = await saved(e, (g) => g.connections.some((c) => c.toNode === 'print_false' && c.toPin === 'value'));
    assert.ok(graph.connections.some((c) => c.fromNode === 'add_1' && c.fromPin === 'result' && c.toNode === 'print_false' && c.toPin === 'value'));
  });

  test('F2 on a pin edits its value on the node; Enter gives the keyboard back', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.focus('#canvas-wrap');
    await arrowTo(e, 'add_1');
    await e.page.keyboard.press('Enter');
    for (let i = 0; i < 4 && (await focus(e)).pin !== 'b'; i++) await e.page.keyboard.press('ArrowDown');
    await e.page.keyboard.press('F2');
    assert.equal(await e.page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.dataset.pin), 'b');
    await e.page.keyboard.type('7');
    await e.page.keyboard.press('Enter');
    assert.deepEqual([(await focus(e)).canvasFocused, (await focus(e)).pin], [true, 'b']);
    const graph = await saved(e, (g) => g.nodes.find((n) => n.id === 'add_1')?.properties['pin:b'] === 7);
    assert.equal(graph.nodes.find((n) => n.id === 'add_1')?.properties['pin:b'], 7);
  });

  test('Escape on a node leaves nothing selected, so Shift+F10 opens Add Node', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.focus('#canvas-wrap');
    await e.page.keyboard.press('ArrowRight');
    await e.page.keyboard.press('Escape');
    assert.equal(await e.count('.node.selected'), 0);
    await e.page.keyboard.press('Shift+F10');
    await e.page.waitForSelector('#context-search');
  });

  test('a click puts the keyboard on the node clicked', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.node[data-node="print_false"] .node-header');
    const at = await focus(e);
    assert.deepEqual([at.node, at.canvasFocused], ['print_false', true]);
    assert.equal(await e.page.$eval('#canvas-wrap', (el) => el.classList.contains('keyboard')), false, 'no ring after a click');
    await e.page.keyboard.press('ArrowLeft');
    assert.equal(await e.page.$eval('#canvas-wrap', (el) => el.classList.contains('keyboard')), true, 'the ring once the keyboard is used');
  });
});
