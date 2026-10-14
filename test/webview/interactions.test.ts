// Unreal-parity gestures and shortcuts (docs/unreal-conventions.md).
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { Graph } from '../../src/core/model';
import { EditorPage, launchBrowser } from './harness';

describe('Unreal gestures and shortcuts', () => {
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
    editor = await EditorPage.withSample(browser);
    return editor;
  }

  const selected = (e: EditorPage) => e.page.$$eval('.node.selected', (els) => els.map((el) => (el as HTMLElement).dataset.node).sort());
  const transform = (e: EditorPage) => e.page.$eval('#world', (el) => (el as HTMLElement).style.transform);
  const header = (id: string) => `.node[data-node="${id}"] .node-header`;
  const wiresInto = (g: Graph, node: string, pin: string) => g.connections.filter((c) => c.toNode === node && c.toPin === pin).map((c) => `${c.fromNode}.${c.fromPin}`);

  test('right-click opens menus; right-drag pans without a menu', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.mouse.click(700, 650, { button: 'right' });
    assert.equal(await e.page.textContent('#context-menu .context-title'), 'Add Node');
    await e.page.keyboard.press('Escape');

    const box = (await e.page.locator('.node[data-node="add_1"]').boundingBox())!;
    await e.page.mouse.click(box.x + 40, box.y + 10, { button: 'right' });
    assert.equal(await e.page.textContent('#context-menu .context-title'), 'Add');
    await e.page.keyboard.press('Escape');

    const before = await transform(e);
    await e.page.mouse.move(700, 650);
    await e.page.mouse.down({ button: 'right' });
    await e.page.mouse.move(800, 700, { steps: 6 });
    await e.page.mouse.up({ button: 'right' });
    assert.notEqual(await transform(e), before, 'the view panned');
    assert.equal(await e.page.isVisible('#context-menu'), false, 'no menu after a drag');
  });

  test('Shift+click adds to the selection; Ctrl+click toggles', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('add_1'));
    await e.page.click(header('branch_1'), { modifiers: ['Shift'] });
    assert.deepEqual(await selected(e), ['add_1', 'branch_1']);
    await e.page.click(header('branch_1'), { modifiers: ['Shift'] });
    assert.deepEqual(await selected(e), ['add_1', 'branch_1'], 'Shift never removes');
    await e.page.click(header('branch_1'), { modifiers: ['Control'] });
    assert.deepEqual(await selected(e), ['add_1']);
    await e.page.click(header('start_1'), { modifiers: ['Control'] });
    assert.deepEqual(await selected(e), ['add_1', 'start_1']);
  });

  test('marquee: Shift+drag adds and Ctrl+drag removes', async (t) => {
    const e = await open(t);
    if (!e) return;
    const marquee = async (id: string, modifier?: string) => {
      const b = (await e.page.locator(`.node[data-node="${id}"]`).boundingBox())!;
      if (modifier) await e.page.keyboard.down(modifier);
      await e.drag({ x: b.x - 15, y: b.y - 15 }, { x: b.x + 30, y: b.y + 30 });
      if (modifier) await e.page.keyboard.up(modifier);
    };
    await marquee('start_1');
    assert.deepEqual(await selected(e), ['start_1']);
    await marquee('add_1', 'Shift');
    assert.deepEqual(await selected(e), ['add_1', 'start_1']);
    await marquee('start_1', 'Control');
    assert.deepEqual(await selected(e), ['add_1']);
  });

  test('a new wire from an exec output replaces its old wire; exec inputs keep several', async (t) => {
    const e = await open(t);
    if (!e) return;
    // branch_1.true currently drives print_true; print_false is already driven by branch_1.false.
    await e.drag(await e.pinCenter('branch_1', 'true'), await e.pinCenter('print_false', 'execIn'));
    const g = await e.lastSavedGraph();
    assert.deepEqual(g.connections.filter((c) => c.fromNode === 'branch_1' && c.fromPin === 'true').map((c) => c.toNode), ['print_false']);
    assert.deepEqual(wiresInto(g, 'print_false', 'execIn').sort(), ['branch_1.false', 'branch_1.true']);
  });

  test('Ctrl+drag from a pin moves its wires; releasing on empty space leaves them', async (t) => {
    const e = await open(t);
    if (!e) return;
    const from = await e.pinCenter('print_true', 'value');
    await e.page.keyboard.down('Control');
    await e.drag(from, { x: from.x - 60, y: from.y + 250 });
    await e.page.keyboard.up('Control');
    assert.equal(await e.count('.edge:not(.draft)'), 7, 'nothing changed');

    await e.page.keyboard.down('Control');
    await e.drag(await e.pinCenter('print_true', 'value'), await e.pinCenter('print_false', 'value'));
    await e.page.keyboard.up('Control');
    const g = await e.lastSavedGraph();
    assert.deepEqual(wiresInto(g, 'print_true', 'value'), []);
    assert.deepEqual(wiresInto(g, 'print_false', 'value'), ['add_1.result']);
  });

  test('hovering a pin highlights its wires', async (t) => {
    const e = await open(t);
    if (!e) return;
    const pin = await e.pinCenter('add_1', 'result');
    await e.page.mouse.move(pin.x, pin.y);
    assert.equal(await e.count('.edge.hover'), 1);
    await e.page.mouse.move(700, 650);
    assert.equal(await e.count('.edge.hover'), 0);
  });

  test('F7 compiles', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.mouse.click(700, 650);
    await e.page.keyboard.press('F7');
    assert.ok((await e.posted()).some((m) => m.type === 'compile'));
  });

  test('arrow keys move the selection and Ctrl+D duplicates it', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('add_1'));
    await e.page.keyboard.press('ArrowRight');
    await e.page.keyboard.press('ArrowDown');
    const moved = (await e.lastSavedGraph()).nodes.find((n) => n.id === 'add_1')!;
    assert.deepEqual(moved.position, { x: 406, y: 161 });

    await e.page.keyboard.press('Control+D');
    assert.equal(await e.count('.node'), 8);
  });

  test('the wheel scrolls an open menu instead of zooming', async (t) => {
    const e = await open(t);
    if (!e) return;
    for (const target of ['background', 'node']) {
      if (target === 'background') await e.page.mouse.click(700, 650, { button: 'right' });
      else {
        const box = (await e.page.locator('.node[data-node="start_1"]').boundingBox())!;
        await e.page.mouse.click(box.x + 40, box.y + 10, { button: 'right' });
      }
      // A short menu doesn't scroll; limit its height so this one must.
      await e.page.$eval('#context-menu', (el) => { (el as HTMLElement).style.maxHeight = '120px'; });
      const menu = (await e.page.locator('#context-menu').boundingBox())!;
      const before = await transform(e);
      await e.page.mouse.move(menu.x + menu.width / 2, menu.y + menu.height / 2);
      await e.page.mouse.wheel(0, 200);
      await e.page.waitForFunction(() => document.getElementById('context-menu')!.scrollTop > 0);
      assert.equal(await transform(e), before, `wheel over the ${target} menu did not zoom`);
      await e.page.keyboard.press('Escape');
    }
  });

  test('Home zooms to fit the selection', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('end_false'));
    const before = await transform(e);
    await e.page.keyboard.press('Home');
    assert.notEqual(await transform(e), before);
    const box = (await e.page.locator('.node[data-node="end_false"]').boundingBox())!;
    const canvas = (await e.page.locator('#canvas-wrap').boundingBox())!;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    assert.ok(Math.abs(center.x - (canvas.x + canvas.width / 2)) < canvas.width / 4, 'the node is near the middle');
  });

  test('holding B, S, P, G, M, N, O, F or D and clicking places the node, as in Unreal', async (t) => {
    const e = await open(t);
    if (!e) return;
    const keys = [
      ['b', 'core:flow.branch'], ['s', 'core:flow.sequence'], ['p', 'core:event.start'], ['g', 'core:flow.gate'],
      ['m', 'core:flow.multigate'], ['n', 'core:flow.do-n'], ['o', 'core:flow.do-once'], ['d', 'core:latent.delay'], ['f', 'core:flow.for-each-loop']
    ];
    for (const [i, [key, type]] of keys.entries()) {
      await e.page.keyboard.down(key);
      // Spaced apart (two rows, the second below the tallest node of the first) so each click lands on
      // empty canvas, not a placed node.
      await e.page.mouse.click(i < 4 ? 300 + i * 320 : [300, 520, 740, 960, 1210][i - 4], i < 4 ? 560 : 760);
      await e.page.keyboard.up(key);
      // Saves are sent asynchronously; wait for the one that contains the placed node.
      await e.page.waitForFunction((t) => (window as unknown as { __posted: { type: string; document?: { graphs: { nodes: { type: string; position: { y: number } }[] }[] } }[] }).__posted
        .some((m) => m.type === 'applyDocument' && m.document!.graphs[0].nodes.some((n) => n.type === t && n.position.y > 400)), type, { timeout: 2000 });
    }
    // Without a held key, a click on the background just clears the selection.
    const count = await e.count('.node');
    await e.page.mouse.click(700, 820);
    assert.equal(await e.count('.node'), count);
  });
});
