// Graph editing tools: copy/cut/paste and comment boxes (docs/unreal-conventions.md, "Nodes").
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { Graph } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

describe('editing tools', () => {
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

  // Dispatches a clipboard event the way VS Code routes Ctrl+C/X/V; returns the copied text.
  const clipboard = (e: EditorPage, type: 'copy' | 'cut' | 'paste', text = '') => e.page.evaluate(([kind, data]) => {
    const transfer = new DataTransfer();
    if (data) transfer.setData('text/plain', data);
    document.dispatchEvent(new ClipboardEvent(kind, { clipboardData: transfer, bubbles: true, cancelable: true }));
    return transfer.getData('text/plain');
  }, [type, text] as const);

  async function savedGraph(e: EditorPage, ready: (g: Graph) => boolean): Promise<Graph> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const g = await e.lastSavedGraph().catch(() => undefined);
      if (g && ready(g)) return g;
      if (Date.now() > deadline) throw new Error('No matching save arrived');
      await e.page.waitForTimeout(25);
    }
  }

  const header = (id: string) => `.node[data-node="${id}"] .node-header`;

  test('copy then paste adds the nodes and their wires at the pointer', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('add_1'));
    await e.page.click(header('print_true'), { modifiers: ['Shift'] });
    const text = await clipboard(e, 'copy');
    assert.match(text, /blueprint-visual-scripting\/nodes/);

    await e.page.mouse.move(500, 700);
    await clipboard(e, 'paste', text);
    assert.equal(await e.count('.node'), 9);
    assert.equal(await e.page.textContent('#status'), 'Pasted 2 nodes.');
    const g = await savedGraph(e, (graph) => graph.nodes.length === 9);
    const pasted = g.nodes.slice(-2);
    assert.ok(g.connections.some((c) => c.fromNode === pasted[0].id && c.toNode === pasted[1].id), 'the wire between them was pasted too');
    assert.deepEqual(await e.page.$$eval('.node.selected', (els) => els.length), 2, 'the pasted nodes are selected');
  });

  test('cut removes the nodes', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('end_true'));
    const text = await clipboard(e, 'cut');
    assert.ok(text);
    assert.equal(await e.count('.node'), 6);
  });

  test('pasting text that is not nodes does nothing', async (t) => {
    const e = await open(t);
    if (!e) return;
    await clipboard(e, 'paste', 'just some text');
    assert.equal(await e.count('.node'), 7);
  });

  test('C wraps the selection in a comment, ready to name', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('add_1'));
    await e.page.keyboard.press('c');
    const input = e.page.locator('.comment-rename');
    assert.equal(await input.inputValue(), 'Comment');
    await input.fill('Do the maths');
    await input.press('Enter');
    const g = await savedGraph(e, (graph) => graph.comments[0]?.text === 'Do the maths');
    const comment = g.comments[0];
    const add = g.nodes.find((n) => n.id === 'add_1')!;
    assert.ok(comment.position.x < add.position.x && comment.position.y < add.position.y, 'the box surrounds the node');
  });

  test('dragging a comment title moves the nodes inside it', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('add_1'));
    await e.page.keyboard.press('c');
    await e.page.keyboard.press('Enter');
    const title = (await e.page.locator('.comment-title').boundingBox())!;
    await e.drag({ x: title.x + 20, y: title.y + 10 }, { x: title.x + 120, y: title.y + 60 });
    const g = await savedGraph(e, (graph) => graph.nodes.find((n) => n.id === 'add_1')!.position.x !== 390);
    const add = g.nodes.find((n) => n.id === 'add_1')!;
    assert.deepEqual(add.position, { x: 490, y: 195 });
    assert.equal(g.nodes.find((n) => n.id === 'branch_1')!.position.x, 700, 'nodes outside the box stay put');
  });

  test('holding C and clicking places a comment; Delete removes it but not nodes', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.mouse.click(600, 700);
    await e.page.keyboard.down('c');
    await e.page.mouse.click(400, 650);
    await e.page.keyboard.up('c');
    await e.page.keyboard.press('Enter');
    assert.equal(await e.count('.comment'), 1);
    await e.page.click('.comment-title');
    await e.page.keyboard.press('Delete');
    assert.equal(await e.count('.comment'), 0);
    assert.equal(await e.count('.node'), 7);
  });

  test('the corner handle resizes a comment', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('start_1'));
    await e.page.keyboard.press('c');
    await e.page.keyboard.press('Enter');
    const before = (await e.page.locator('.comment').boundingBox())!;
    const handle = (await e.page.locator('.comment-resize').boundingBox())!;
    await e.drag({ x: handle.x + 7, y: handle.y + 7 }, { x: handle.x + 107, y: handle.y + 57 });
    const after = (await e.page.locator('.comment').boundingBox())!;
    assert.ok(after.width > before.width + 90 && after.height > before.height + 40);
  });

  test('double-clicking a wire inserts a reroute knot of the same kind', async (t) => {
    const e = await open(t);
    if (!e) return;
    const exec = await e.wireMidpoint('c1');
    await e.page.mouse.dblclick(exec.x, exec.y);
    // Partway along: the middle of this wire passes under the Branch node.
    const data = await e.wireMidpoint('c7', 0.2);
    await e.page.mouse.dblclick(data.x, data.y);
    const g = await savedGraph(e, (graph) => graph.nodes.filter((n) => n.type === 'core:reroute').length === 2);
    const knots = g.nodes.filter((n) => n.type === 'core:reroute');
    assert.deepEqual(knots.map((k) => k.properties), [{ kind: 'exec' }, { kind: 'data', type: { id: 'float' } }]);
    assert.ok(!g.connections.some((c) => c.id === 'c1' || c.id === 'c7'));
    assert.ok(g.connections.some((c) => c.fromNode === 'add_1' && c.toNode === knots[1].id));
    assert.ok(g.connections.some((c) => c.fromNode === knots[1].id && c.toNode === 'print_true' && c.toPin === 'value'));
    assert.equal(await e.count('.node.knot'), 2);
  });

  test('Sequence grows with Add pin and shrinks from a pin menu', async (t) => {
    if (!browser) return t.skip(skipReason);
    editor = await EditorPage.open(browser);
    const document = sampleDocument();
    document.graphs[0].nodes.push({ id: 'seq', type: 'core:flow.sequence', position: { x: 400, y: 380 }, properties: {} });
    await editor.send({ type: 'init', document, definitions: sampleDefinitions(), saveDelay: 0 });
    const e = editor;
    const thenPins = () => e.page.$$eval('.pin[data-node="seq"][data-direction="output"]', (els) => els.map((el) => (el as HTMLElement).dataset.pin));
    assert.deepEqual(await thenPins(), ['then0', 'then1', 'then2']);
    await e.page.click('.node[data-node="seq"] .add-pin');
    assert.deepEqual(await thenPins(), ['then0', 'then1', 'then2', 'then3']);
    const pin = await e.pinCenter('seq', 'then1');
    await e.page.mouse.click(pin.x, pin.y, { button: 'right' });
    await e.page.locator('#context-menu button', { hasText: 'Remove Execution Pin' }).click();
    assert.deepEqual(await thenPins(), ['then0', 'then1', 'then2']);
  });

  test('Shift+W aligns the selection to the top; Q straightens a wire', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click(header('start_1'));
    await e.page.click(header('add_1'), { modifiers: ['Shift'] });
    await e.page.keyboard.press('Shift+W');
    let g = await savedGraph(e, (graph) => graph.nodes.find((n) => n.id === 'start_1')!.position.y === 145);
    assert.equal(g.nodes.find((n) => n.id === 'add_1')!.position.y, 145);

    await e.page.click(header('print_true'));
    await e.page.keyboard.press('q');
    g = await savedGraph(e, (graph) => graph.nodes.find((n) => n.id === 'print_true')!.position.y !== 80);
    const from = await e.pinCenter('branch_1', 'true');
    const to = await e.pinCenter('print_true', 'execIn');
    assert.ok(Math.abs(from.y - to.y) < 1, `pins level after straightening (${from.y} vs ${to.y})`);
  });

  test('the node menu distributes three nodes evenly', async (t) => {
    const e = await open(t);
    if (!e) return;
    for (const [i, id] of ['start_1', 'add_1', 'branch_1'].entries()) await e.page.click(header(id), i ? { modifiers: ['Shift'] } : undefined);
    const box = (await e.page.locator('.node[data-node="add_1"]').boundingBox())!;
    await e.page.mouse.click(box.x + 60, box.y + 10, { button: 'right' });
    await e.page.click('#context-menu button[data-action="distribute-horizontal"]');
    const boxes = await Promise.all(['start_1', 'add_1', 'branch_1'].map((id) => e.page.locator(`.node[data-node="${id}"]`).boundingBox()));
    const gap1 = boxes[1]!.x - (boxes[0]!.x + boxes[0]!.width);
    const gap2 = boxes[2]!.x - (boxes[1]!.x + boxes[1]!.width);
    assert.ok(Math.abs(gap1 - gap2) < 1, `equal gaps (${gap1} vs ${gap2})`);
  });

  test('wiring a number into a string input inserts a To String node', async (t) => {
    if (!browser) return t.skip(skipReason);
    editor = await EditorPage.open(browser);
    const document = sampleDocument();
    document.variables.push({ id: 'v_label', name: 'Label', type: { id: 'string' } });
    document.graphs[0].nodes.push({ id: 'set_label', type: 'core:variable.set', position: { x: 400, y: 380 }, properties: { variable: 'v_label' } });
    await editor.send({ type: 'init', document, definitions: sampleDefinitions(), saveDelay: 0 });
    const e = editor;
    await e.drag(await e.pinCenter('add_1', 'result'), await e.pinCenter('set_label', 'value'));
    const g = await savedGraph(e, (graph) => graph.nodes.some((n) => n.type === 'core:convert.to-string'));
    const conv = g.nodes.find((n) => n.type === 'core:convert.to-string')!;
    assert.ok(g.connections.some((c) => c.fromNode === 'add_1' && c.toNode === conv.id));
    assert.ok(g.connections.some((c) => c.fromNode === conv.id && c.toNode === 'set_label' && c.toPin === 'value'));
    assert.equal(await e.page.textContent('#status'), 'Added a To String conversion.');
  });

  test('unchecking Context Sensitive lists every node when dragging from a pin', async (t) => {
    const e = await open(t);
    if (!e) return;
    const from = await e.pinCenter('add_1', 'result');
    await e.drag(from, { x: from.x + 40, y: from.y + 380 });
    const names = () => e.page.$$eval('#context-results strong', (els) => els.map((el) => el.textContent));
    assert.ok(!(await names()).includes('Start'));
    await e.page.uncheck('#context-sensitive');
    assert.ok((await names()).includes('Start'));
  });

  test('Promote to Variable makes a typed variable with a wired Get', async (t) => {
    const e = await open(t);
    if (!e) return;
    const pin = await e.pinCenter('print_false', 'value');
    await e.page.mouse.click(pin.x, pin.y, { button: 'right' });
    await e.page.locator('#context-menu button', { hasText: 'Promote to Variable' }).click();
    await savedGraph(e, (g) => g.nodes.some((n) => n.type === 'core:variable.get'));
    const saved = (await e.posted()).filter((m) => m.type === 'applyDocument').pop()!.document!;
    const variable = saved.variables.find((v) => v.name === 'Value')!;
    assert.deepEqual(variable.type, { id: 'any' });
    assert.equal(variable.defaultValue, 'False branch: graph did not execute.', 'the pin value becomes the default');
    const graph = saved.graphs[0];
    const get = graph.nodes.find((n) => n.type === 'core:variable.get' && n.properties.variable === variable.id)!;
    assert.ok(graph.connections.some((c) => c.fromNode === get.id && c.toNode === 'print_false' && c.toPin === 'value'));
    assert.deepEqual(await e.page.$$eval('.mb-item[data-kind="variable"] .mb-name', (els) => els.map((el) => el.textContent)), ['Value']);
  });

  // Unreal tells apart what was right-clicked: a pin gets its pin actions above its node's actions,
  // a comment gets its own menu.
  const menuTitle = (e: EditorPage) => e.page.textContent('#context-menu .context-title');
  const menuHeadings = (e: EditorPage) => e.page.$$eval('#context-menu .context-heading', (els) => els.map((el) => el.textContent));
  const menuButtons = (e: EditorPage) => e.page.$$eval('#context-menu button', (els) => els.map((el) => el.textContent));

  test('right-clicking a pin shows its pin actions above the node actions', async (t) => {
    const e = await open(t);
    if (!e) return;
    const pin = await e.pinCenter('start_1', 'execOut');
    await e.page.mouse.click(pin.x, pin.y, { button: 'right' });
    assert.equal(await menuTitle(e), 'Start');
    assert.deepEqual(await menuHeadings(e), ['Pin Actions', 'Node Actions', 'Alignment']);
    const buttons = await menuButtons(e);
    assert.equal(buttons[0], 'Break Link(s)');
    assert.ok(buttons.includes('Duplicate') && buttons.includes('Delete Node'));
    await e.page.locator('#context-menu button', { hasText: 'Break Link(s)' }).click();
    await savedGraph(e, (g) => !g.connections.some((c) => c.fromNode === 'start_1'));
    assert.equal(await e.page.isVisible('#context-menu'), false);
  });

  test('a pin with no actions of its own still opens its node menu', async (t) => {
    if (!browser) return t.skip(skipReason);
    const document = sampleDocument();
    document.graphs[0].nodes.push({ id: 'lonely', type: 'core:flow.end', position: { x: 400, y: 380 }, properties: {} });
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document, definitions: sampleDefinitions(), saveDelay: 0 });
    const e = editor;
    const pin = await e.pinCenter('lonely', 'execIn');
    await e.page.mouse.click(pin.x, pin.y, { button: 'right' });
    assert.equal(await menuTitle(e), 'End');
    assert.deepEqual(await menuHeadings(e), ['Alignment'], 'no empty Pin Actions section');
    assert.equal((await menuButtons(e))[0], 'Duplicate');
  });

  test('right-clicking a comment title opens the comment menu: Rename and Delete', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.mouse.click(600, 700);
    await e.page.keyboard.down('c');
    await e.page.mouse.click(400, 650);
    await e.page.keyboard.up('c');
    await e.page.keyboard.press('Enter');
    const title = (await e.page.locator('.comment-title').boundingBox())!;

    await e.page.mouse.click(title.x + 20, title.y + 8, { button: 'right' });
    assert.equal(await menuTitle(e), 'Comment');
    assert.deepEqual(await menuButtons(e), ['Rename', 'Delete Comment']);
    await e.page.locator('#context-menu button', { hasText: 'Rename' }).click();
    await e.page.locator('.comment-rename').fill('Setup');
    await e.page.keyboard.press('Enter');
    await savedGraph(e, (g) => g.comments[0]?.text === 'Setup');

    await e.page.mouse.click(title.x + 20, title.y + 8, { button: 'right' });
    assert.equal(await menuTitle(e), 'Setup');
    await e.page.locator('#context-menu button', { hasText: 'Delete Comment' }).click();
    assert.equal(await e.count('.comment'), 0);
    assert.equal(await e.count('.node'), 7, 'nodes are kept');
  });
});
