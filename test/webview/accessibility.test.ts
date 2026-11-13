// Screen readers and forced colors (docs/release.md, step 8): every control has an accessible name
// (from Chromium's own accessibility tree), nodes and pins say what they are, the status line
// announces what changed, and in forced colors nodes, pins, wires and the keyboard's focus stay
// visible.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { GraphDocument } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

// Roles a person acts on, which must have a name.
const INTERACTIVE = new Set(['button', 'textbox', 'checkbox', 'combobox', 'menuitem', 'option', 'tab', 'spinbutton', 'link', 'listbox', 'menu', 'searchbox', 'slider', 'switch', 'radio', 'treeitem', 'application']);

describe('screen readers and forced colors', () => {
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

  // The sample, with a variable, a function and a comment, so every panel has something in it.
  function richDocument(): GraphDocument {
    const document = sampleDocument();
    document.variables.push({ id: 'v_count', name: 'Count', type: { id: 'int' }, defaultValue: 0 });
    document.graphs[0].comments.push({ id: 'c1', text: 'A comment', position: { x: -40, y: -60 }, size: { width: 300, height: 200 } });
    document.graphs.push({
      id: 'Twice', name: 'Twice', kind: 'function', comments: [],
      signature: { inputs: [{ id: 'value', name: 'Value', kind: 'data', type: { id: 'float' } }], outputs: [{ id: 'result', name: 'Result', kind: 'data', type: { id: 'float' } }] },
      nodes: [
        { id: 'entry', type: 'core:function.entry', position: { x: 0, y: 0 }, properties: { graph: 'Twice' } },
        { id: 'return', type: 'core:function.return', position: { x: 300, y: 0 }, properties: { graph: 'Twice' } }
      ],
      connections: [{ id: 'e', fromNode: 'entry', fromPin: 'execOut', toNode: 'return', toPin: 'execIn' }]
    });
    return document;
  }

  async function open(t: TestContext): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document: richDocument(), definitions: [...builtinNodeDefinitions(), ...sampleDefinitions()], saveDelay: 0 });
    return editor;
  }

  // The visible interactive elements of Chromium's accessibility tree that have no name.
  async function unnamed(e: EditorPage): Promise<string[]> {
    const cdp = await e.page.context().newCDPSession(e.page);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: { ignored: boolean; role?: { value: string }; name?: { value: string }; backendDOMNodeId?: number }[] };
    const missing: string[] = [];
    for (const node of nodes) {
      const role = node.role?.value ?? '';
      if (node.ignored || !INTERACTIVE.has(role) || (node.name?.value ?? '').trim()) continue;
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId }) as { object: { objectId: string } };
      const { result } = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: 'function () { const r = this.getBoundingClientRect(); return { visible: r.width > 0 && r.height > 0, html: this.outerHTML.slice(0, 160) }; }'
      }) as { result: { value: { visible: boolean; html: string } } };
      if (result.value.visible) missing.push(`${role}: ${result.value.html}`);
    }
    await cdp.detach();
    return missing;
  }

  test('every control has an accessible name: the panels, a node selected, the menus', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.deepEqual(await unnamed(e), [], 'with the event graph open');
    await e.page.click('.node[data-node="print_true"] .node-header');
    assert.deepEqual(await unnamed(e), [], 'with a node selected');
    await e.page.keyboard.press('Shift+F10');
    await e.page.waitForSelector('#context-menu[role="menu"]');
    assert.deepEqual(await unnamed(e), [], 'with a node menu open');
    await e.page.keyboard.press('Escape');
    await e.page.keyboard.press('Escape');
    await e.page.keyboard.press('Shift+F10');
    await e.page.waitForSelector('#context-search');
    assert.deepEqual(await unnamed(e), [], 'with Add Node open');
    await e.page.keyboard.press('Escape');
    await e.page.click('.mb-item[data-kind="variable"][data-id="v_count"]');
    assert.deepEqual(await unnamed(e), [], "with a variable's details");
    await e.page.dispatchEvent('.mb-item[data-kind="variable"][data-id="v_count"]', 'contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 200 });
    await e.page.waitForSelector('.floating-menu:not([hidden])');
    assert.deepEqual(await unnamed(e), [], "with a variable's menu open");
    await e.page.keyboard.press('Escape');
    await e.page.click('.mb-item[data-kind="graph"][data-id="Twice"]');
    assert.deepEqual(await unnamed(e), [], "with a function's graph and details");
  });

  test('nodes and pins say what they are and what they are wired to', async (t) => {
    const e = await open(t);
    if (!e) return;
    const label = (selector: string) => e.page.getAttribute(selector, 'aria-label');
    assert.equal(await label('.node[data-node="branch_1"]'), 'Branch, flow control');
    assert.equal(await e.page.getAttribute('.node[data-node="branch_1"]', 'role'), 'group');
    assert.match((await label('.pin[data-node="print_true"][data-pin="value"]'))!, /^Value, .+ input, connected to Add: Result$/);
    assert.match((await label('.pin[data-node="add_1"][data-pin="b"]'))!, /^B, .+ input, value 20$/);
    assert.equal(await label('.pin[data-node="start_1"][data-pin="execOut"]'), 'Then, exec output, connected to Add: Exec');
    // The canvas names the focused node through aria-activedescendant.
    await e.page.focus('#canvas-wrap');
    assert.equal(await e.page.$eval('#canvas-wrap', (el) => document.getElementById(el.getAttribute('aria-activedescendant')!)?.getAttribute('aria-label')), 'Start, event');
  });

  test('the status line announces what changed: added, connected, deleted, compiled', async (t) => {
    const e = await open(t);
    if (!e) return;
    const status = () => e.page.textContent('#status');
    assert.equal(await e.page.getAttribute('#status', 'role'), 'status');
    await e.page.focus('#canvas-wrap');
    await e.page.keyboard.press('Escape');
    await e.page.keyboard.press('Shift+F10');
    await e.page.waitForSelector('#context-search');
    await e.page.keyboard.type('flip flop');
    await e.page.keyboard.press('Enter');
    assert.equal(await status(), 'Added Flip Flop.');
    // Connect Flip Flop's exec input from the false branch's Print.
    await e.page.keyboard.press('Enter');
    await e.page.keyboard.press('Enter');
    await e.page.waitForSelector('#context-menu[role="menu"]');
    await e.page.keyboard.press('Enter');
    await e.page.waitForSelector('#context-menu .context-title:has-text("Connect")');
    const choice = await e.page.evaluate(() => document.activeElement?.textContent ?? '');
    await e.page.keyboard.press('Enter');
    assert.match((await status())!, new RegExp(`^Connected ${choice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} to Flip Flop: Exec\\.$`));
    await e.page.keyboard.press('Escape');
    await e.page.keyboard.press('Delete');
    assert.equal(await status(), 'Deleted 1 node.');
    await e.send({ type: 'compileResult', compile: { status: 'errors', language: 'javascript', diagnostics: [{ severity: 'error', code: 'x', message: 'Broken', graphId: 'EventGraph', nodeId: 'add_1' }] } } as never);
    assert.match((await status())!, /^Compile failed: 1 error/);
    assert.match((await e.page.getAttribute('.node[data-node="add_1"]', 'aria-label'))!, /error: Broken/);
  });

  test('forced colors: nodes, exec pins, wires and the keyboard focus stay visible', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.emulateMedia({ forcedColors: 'active' });
    await e.page.focus('#canvas-wrap');
    await e.page.keyboard.press('ArrowRight');
    await e.page.keyboard.press('Enter');
    const styles = await e.page.evaluate(() => {
      const css = (selector: string, pseudo?: string) => getComputedStyle(document.querySelector(selector)!, pseudo);
      return {
        nodeBorder: css('.node[data-node="end_true"]').borderTopStyle,
        exec: css('.pin.exec').backgroundColor,
        wire: css('.edge').stroke,
        focusRow: css('.pin-row.kb-focus-row').outlineStyle,
        selected: css('.node.selected').outlineStyle
      };
    });
    assert.equal(styles.nodeBorder, 'solid');
    assert.notEqual(styles.exec, 'rgba(0, 0, 0, 0)', 'exec pins have a fill');
    assert.notEqual(styles.wire, 'none');
    assert.equal(styles.focusRow, 'solid', "the focused pin's ring");
    assert.equal(styles.selected, 'solid');
  });
});
