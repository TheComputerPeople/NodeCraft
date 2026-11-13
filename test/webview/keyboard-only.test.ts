// Phase 14's exit check (docs/release.md, step 9): a graph built from the keyboard alone. From a
// class with only Start: Tab to the graph, add a Branch and a Print with Add Node, wire them with
// Connect to and Add Node from Here, set Print's text with F2, and compile with F7, each step
// announced on the status line. The graph saved then prints the text in Simulate.
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { GraphDocument, UIMessage } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { GraphRuntime } from '../../src/core/runtime';
import { primaryGraph } from '../../src/core/serializer';
import { EditorPage, launchBrowser } from './harness';

describe('a graph built from the keyboard alone', () => {
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

  test('add, wire, set a value and compile, with no mouse, every step announced', async (t) => {
    if (!browser) return t.skip(skipReason);
    const start: GraphDocument = {
      schemaVersion: 3, name: 'Greeter', kind: 'class', language: 'javascript', variables: [],
      graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], connections: [], nodes: [{ id: 'start', type: 'core:event.start', position: { x: 0, y: 0 }, properties: {} }] }]
    };
    const e = editor = await EditorPage.open(browser);
    await e.send({ type: 'init', document: start, definitions: builtinNodeDefinitions(), saveDelay: 0 });
    const page = e.page;
    const status = async () => (await page.textContent('#status'))?.trim();
    const focusedText = () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    const focusOn = () => page.evaluate(() => {
      const el = document.getElementById('graph-focus');
      return { node: el?.closest<HTMLElement>('.node')?.dataset.node ?? null, pin: el?.classList.contains('pin') ? el.dataset.pin ?? null : null, label: el?.getAttribute('aria-label') ?? '' };
    });
    // Down a menu to the item, by its text.
    const choose = async (text: string) => {
      for (let i = 0; i < 40 && (await focusedText()) !== text; i++) await page.keyboard.press('ArrowDown');
      assert.equal(await focusedText(), text);
      await page.keyboard.press('Enter');
    };

    // Tab until the graph has the keyboard: it starts on Start.
    for (let i = 0; i < 80 && !(await page.evaluate(() => document.activeElement?.id === 'canvas-wrap')); i++) await page.keyboard.press('Tab');
    assert.equal((await focusOn()).label, 'Start, event');

    // Start's exec output → Add Node from Here → Print, wired to it.
    await page.keyboard.press('Enter');
    assert.deepEqual((await focusOn()).pin, 'execOut');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#context-menu[role="menu"]');
    await choose('Add Node from Here…');
    await page.waitForSelector('#context-search');
    await page.keyboard.type('print');
    await page.keyboard.press('Enter');
    assert.match((await status())!, /^Added Print, connected to /);
    const print = (await focusOn()).node!;
    assert.match((await focusOn()).label, /^Print, function/);

    // Nothing selected, then Add Node: a Branch, on its own.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+F10');
    await page.waitForSelector('#context-search');
    await page.keyboard.type('branch');
    await page.keyboard.press('Enter');
    assert.equal(await status(), 'Added Branch.');
    const branch = (await focusOn()).node!;

    // Branch's exec input ← Print's exec output, with Connect to.
    await page.keyboard.press('Enter');
    assert.equal((await focusOn()).pin, 'execIn');
    await page.keyboard.press('Shift+F10');
    await page.waitForSelector('#context-menu[role="menu"]');
    await choose('Connect to…');
    await page.waitForSelector('#context-menu .context-title:has-text("Connect")');
    await choose('Print: Then');
    assert.equal(await status(), 'Connected Print: Then to Branch: Exec.');
    assert.match((await focusOn()).label, /^Exec, exec input, connected to Print: Then$/);

    // Back to Print, by the arrow keys, and its text with F2.
    await page.keyboard.press('Escape');
    for (let i = 0; i < 6 && (await focusOn()).node !== print; i++) await page.keyboard.press('ArrowLeft');
    assert.equal((await focusOn()).node, print);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 4 && (await focusOn()).pin !== 'value'; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('F2');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Hello from the keyboard');
    await page.keyboard.press('Enter');
    assert.match((await focusOn()).label, /^Value, .+ input, value Hello from the keyboard$/);

    // Compile.
    await page.keyboard.press('F7');
    assert.ok((await e.posted()).some((m: UIMessage) => m.type === 'compile'), 'F7 asked the host to compile');
    // The host's answer, as the extension sends it.
    await e.send({ type: 'compileResult', compile: { status: 'ok', language: 'javascript', diagnostics: [], outputFile: 'Greeter.vgraph.js' } });
    assert.equal(await status(), 'Compiled to Greeter.vgraph.js');

    // The graph saved: Start → Print → Branch, and it prints the text.
    const saves = (await e.posted()).filter((m: UIMessage) => m.type === 'applyDocument');
    const doc = saves[saves.length - 1].document!;
    const graph = primaryGraph(doc);
    assert.ok(graph.connections.some((c) => c.fromNode === 'start' && c.fromPin === 'execOut' && c.toNode === print));
    assert.ok(graph.connections.some((c) => c.fromNode === print && c.toNode === branch && c.toPin === 'execIn'));
    const printed: string[] = [];
    new GraphRuntime(new NodeRegistry(), (event) => event.kind === 'log' && printed.push(event.message ?? '')).run(doc);
    assert.deepEqual(printed, ['Hello from the keyboard']);
  });
});
