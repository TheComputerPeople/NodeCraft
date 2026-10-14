import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

const WIRES = '.edge:not(.draft)';

describe('webview editor', () => {
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

  // Opens the sample graph, or skips the test when no browser is available.
  async function openSample(t: TestContext): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    editor = await EditorPage.withSample(browser);
    return editor;
  }

  test('renders the sample graph and announces readiness', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    assert.equal(await e.count('.node'), 7);
    assert.equal(await e.count(WIRES), 7);
    assert.equal(await e.page.textContent('#graph-name'), 'BlueprintDemo › EventGraph');
    assert.equal((await e.posted())[0]?.type, 'ready');
  });

  test('box-selects nodes by dragging on the background', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    const start = await e.page.locator('.node[data-node="start_1"]').boundingBox();
    const add = await e.page.locator('.node[data-node="add_1"]').boundingBox();
    assert.ok(start && add);
    const from = { x: start.x - 20, y: Math.min(start.y, add.y) - 20 };
    const to = { x: add.x + add.width + 10, y: Math.max(start.y + start.height, add.y + add.height) + 10 };

    await e.page.mouse.move(from.x, from.y);
    await e.page.mouse.down();
    await e.page.mouse.move(to.x, to.y, { steps: 8 });
    assert.equal(await e.page.isVisible('#selection-box'), true, 'marquee is visible while dragging');
    await e.page.mouse.up();

    assert.equal(await e.page.isVisible('#selection-box'), false);
    assert.deepEqual(await e.page.$$eval('.node.selected', (els) => els.map((el) => (el as HTMLElement).dataset.node).sort()), ['add_1', 'start_1']);

    await e.page.mouse.click(from.x, from.y);
    assert.equal(await e.count('.node.selected'), 0, 'clicking empty canvas clears the selection');
  });

  test('Alt+click on a wire removes it', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    const mid = await e.wireMidpoint('c1');
    await e.page.keyboard.down('Alt');
    await e.page.mouse.click(mid.x, mid.y);
    await e.page.keyboard.up('Alt');
    assert.equal(await e.count(WIRES), 6);
    assert.ok(!(await e.lastSavedGraph()).connections.some((c) => c.id === 'c1'));
  });

  test('dragging between compatible pins connects them', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    await e.drag(await e.pinCenter('add_1', 'result'), await e.pinCenter('print_false', 'value'));
    assert.equal(await e.count(WIRES), 8);
    const saved = await e.lastSavedGraph();
    assert.ok(saved.connections.some((c) => c.fromNode === 'add_1' && c.fromPin === 'result' && c.toNode === 'print_false' && c.toPin === 'value'));
  });

  test('dragging between incompatible pins does nothing', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    await e.drag(await e.pinCenter('start_1', 'execOut'), await e.pinCenter('print_false', 'value'));
    assert.equal(await e.count(WIRES), 7);
    assert.ok(!(await e.posted()).some((m) => m.type === 'applyDocument'));
  });

  test('dropping a wire on empty canvas offers compatible nodes and wires up the choice', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    const from = await e.pinCenter('add_1', 'result');
    await e.drag(from, { x: from.x + 40, y: from.y + 380 });
    assert.equal(await e.page.isVisible('#context-menu'), true);
    assert.equal(await e.page.textContent('#context-menu .context-title > span'), 'Add Connected Node');
    const offered = await e.page.$$eval('#context-results strong', (els) => els.map((el) => el.textContent));
    assert.ok(offered.includes('Print'));
    assert.ok(!offered.includes('Start'), 'Start has no inputs, so it cannot take the wire');

    await e.page.locator('#context-results .context-node', { hasText: 'Print' }).first().dispatchEvent('mousedown');
    assert.equal(await e.count('.node'), 8);
    const saved = await e.lastSavedGraph();
    const created = saved.nodes.find((n) => !['start_1', 'add_1', 'branch_1', 'print_true', 'print_false', 'end_true', 'end_false'].includes(n.id));
    assert.ok(created, 'a new node was saved');
    assert.ok(saved.connections.some((c) => c.fromNode === 'add_1' && c.fromPin === 'result' && c.toNode === created.id && c.toPin === 'value'));
  });

  test('Delete removes the selected node and its wires', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    await e.page.click('.node[data-node="print_true"] .node-header');
    await e.page.keyboard.press('Delete');
    assert.equal(await e.count('.node'), 6);
    assert.equal(await e.count(WIRES), 4);
  });

  test('stays read-only when the host has no parsable graph', async (t) => {
    if (!browser) return t.skip(skipReason);
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', definitions: sampleDefinitions(), saveDelay: 0 });
    await editor.send({ type: 'error', message: 'Cannot open graph: bad JSON' });
    assert.ok((await editor.count('.palette-node')) > 0, 'the palette still loads');
    await editor.page.locator('.palette-node').first().dispatchEvent('mousedown');
    await editor.page.mouse.click(800, 400);
    assert.equal(await editor.count('.node'), 0);
    assert.ok(!(await editor.posted()).some((m) => m.type === 'applyDocument'));
    assert.equal(await editor.page.textContent('#status'), 'Cannot open graph: bad JSON');
  });

  test('the palette offers Get and Set for each variable, and places bound nodes', async (t) => {
    if (!browser) return t.skip(skipReason);
    editor = await EditorPage.open(browser);
    const document = sampleDocument();
    document.variables.push({ id: 'v_health', name: 'Health', type: { id: 'float' }, defaultValue: 100 });
    await editor.send({ type: 'init', document, definitions: sampleDefinitions(), saveDelay: 0 });
    const names = await editor.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent));
    assert.ok(names.includes('Health') && names.includes('Set Health'), 'Get and Set entries for the variable');
    assert.ok(!names.includes('Get Variable') && !names.includes('Set Variable'), 'no unbound variable nodes');

    await editor.page.locator('.palette-node', { hasText: 'Set Health' }).dispatchEvent('mousedown');
    const placed = (await editor.lastSavedGraph()).nodes.find((n) => n.type === 'core:variable.set');
    assert.equal(placed?.properties.variable, 'v_health');
    assert.equal(await editor.page.textContent(`.node[data-node="${placed!.id}"] .node-title`), 'Set Health');
  });

  test('searching matches keywords, as Unreal does', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    await e.page.fill('#search', 'if');
    assert.deepEqual(await e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent)), ['Branch']);
  });

  test('highlights nodes reached by a run', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    await e.send({ type: 'runtimeEvent', event: { kind: 'node.enter', nodeId: 'start_1' } });
    await e.page.waitForSelector('.node.executing[data-node="start_1"]');
    assert.equal(await e.count('.node.executing'), 1);
  });

  test('ignores run highlights from other graphs', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    await e.send({ type: 'runtimeEvent', event: { kind: 'node.enter', graphId: 'OtherGraph', nodeId: 'start_1' } });
    await e.send({ type: 'runtimeEvent', event: { kind: 'node.enter', graphId: 'EventGraph', nodeId: 'add_1' } });
    await e.page.waitForSelector('.node.executing[data-node="add_1"]');
    assert.equal(await e.count('.node.executing[data-node="start_1"]'), 0);
  });

  test('disables Run and Simulate in an untrusted workspace until trust is granted', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    await e.send({ type: 'settings', trusted: false });
    for (const button of ['#run', '#simulate']) {
      assert.equal(await e.page.isDisabled(button), true, `${button} is disabled`);
      await e.page.locator(button).click({ force: true });
    }
    assert.ok(!(await e.posted()).some((m) => m.type === 'run' || m.type === 'simulate'), 'disabled buttons send nothing');
    assert.equal(await e.page.isDisabled('#compile'), false, 'compiling only writes text, so it stays available');

    await e.send({ type: 'settings', trusted: true });
    await e.page.click('#run');
    await e.page.click('#simulate');
    assert.deepEqual((await e.posted()).map((m) => m.type).filter((type) => type === 'run' || type === 'simulate'), ['run', 'simulate']);
  });
});

describe('compiling from the editor', () => {
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

  async function openSample(t: TestContext): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    editor = await EditorPage.open(browser);
    await editor.send({
      type: 'init', document: sampleDocument(), definitions: sampleDefinitions(), saveDelay: 60000,
      languages: [{ id: 'typescript', displayName: 'TypeScript' }, { id: 'python', displayName: 'Python' }, { id: 'javascript', displayName: 'JavaScript' }]
    });
    return editor;
  }

  const errorReport = {
    status: 'errors' as const,
    language: 'javascript',
    diagnostics: [
      { severity: 'error' as const, code: 'missing-snippet', message: 'Print has a problem.', graphId: 'EventGraph', nodeId: 'print_true' },
      { severity: 'warning' as const, code: 'no-start', message: 'A graph-level warning.' }
    ]
  };

  test('Compile sends pending edits first, then asks the host to compile', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    await e.page.click('.node[data-node="end_true"] .node-header');
    await e.page.keyboard.press('Delete');
    await e.page.click('#compile');
    const types = (await e.posted()).map((m) => m.type);
    assert.deepEqual(types.slice(-2), ['applyDocument', 'compile']);
    assert.equal(await e.page.getAttribute('#compile', 'data-state'), 'compiling');
  });

  test('errors open Compiler Results and badge the node, and a result selects its node', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    await e.send({ type: 'compileResult', compile: errorReport });
    assert.equal(await e.page.getAttribute('#compile', 'data-state'), 'errors');
    assert.equal(await e.page.isVisible('#compiler-results'), true);
    assert.equal(await e.page.textContent('#results-title'), 'Compiler Results: 1 error, 1 warning');
    assert.equal(await e.page.textContent('.node[data-node="print_true"] .node-badge'), 'ERROR!');
    assert.equal(await e.count('.node-badge'), 1, 'only the node the error is about gets a badge');
    assert.equal(await e.page.textContent('#status'), 'Compile failed: 1 error');

    await e.page.click('#results-list li.has-node');
    assert.deepEqual(await e.page.$$eval('.node.selected', (els) => els.map((el) => (el as HTMLElement).dataset.node)), ['print_true']);
  });

  test('a clean compile hides Compiler Results; editing afterwards marks the graph as needing a compile', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    await e.send({ type: 'compileResult', compile: errorReport });
    await e.send({ type: 'compileResult', compile: { status: 'ok', language: 'javascript', diagnostics: [], outputFile: 'demo.vgraph.js' } });
    assert.equal(await e.page.isVisible('#compiler-results'), false);
    assert.equal(await e.count('.node-badge'), 0);
    assert.equal(await e.page.getAttribute('#compile', 'data-state'), 'ok');
    assert.equal(await e.page.textContent('#status'), 'Compiled to demo.vgraph.js');

    await e.page.click('.node[data-node="end_true"] .node-header');
    await e.page.keyboard.press('Delete');
    assert.equal(await e.page.getAttribute('#compile', 'data-state'), 'dirty');
  });

  test('the language picker shows the graph language and changing it saves the graph', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    assert.deepEqual(await e.page.$$eval('#language option', (els) => els.map((el) => el.textContent)), ['TypeScript', 'Python', 'JavaScript']);
    assert.equal(await e.page.inputValue('#language'), 'javascript');
    await e.page.selectOption('#language', 'python');
    await e.page.click('#compile');
    const saved = (await e.posted()).filter((m) => m.type === 'applyDocument').pop();
    assert.equal(saved?.document?.language, 'python');
  });

  test('run status messages appear in the status bar', async (t) => {
    const e = await openSample(t);
    if (!e) return;
    await e.send({ type: 'runStatus', run: { state: 'running', message: 'Running TypeScript…' } });
    assert.equal(await e.page.textContent('#status'), 'Running TypeScript…');
  });
});
