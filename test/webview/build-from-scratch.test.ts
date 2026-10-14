// Phase 2's exit check, automated: build the sample graph from an empty file using only Unreal's
// gestures (hold-key placement, the action menu, dragging from pins, inline values, F7), then
// confirm the result compiles and runs like the sample (prints 30).
import { after, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, RuntimeLogEvent } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { GraphRuntime } from '../../src/core/runtime';
import { createEmptyDocument } from '../../src/core/serializer';
import { EditorPage, launchBrowser, sampleDefinitions } from './harness';

describe('building the sample graph with Unreal gestures', () => {
  let browser: Browser | undefined;
  let skipReason = '';
  before(async () => {
    const result = await launchBrowser();
    if (typeof result === 'string') skipReason = result;
    else browser = result;
  });
  after(async () => {
    await browser?.close();
  });

  test('from an empty file to a graph that compiles and prints 30', async (t: TestContext) => {
    if (!browser) return t.skip(skipReason);
    const e = await EditorPage.open(browser);
    try {
      await e.send({ type: 'init', document: createEmptyDocument('Demo', 'typescript'), definitions: sampleDefinitions(), saveDelay: 0 });
      const nodeOfType = async (type: string) => (await saved(e)).graphs[0].nodes.filter((n) => n.type === type).map((n) => n.id).pop()!;

      // Hold P and click: a Start event (Unreal's BeginPlay shortcut).
      await e.page.keyboard.down('p');
      await e.page.mouse.click(320, 200);
      await e.page.keyboard.up('p');
      const start = await waitForNode(e, 'core:event.start');

      // Drag from Start's exec output to empty space, then pick Add from the action menu.
      const execOut = await e.pinCenter(start, 'execOut');
      await e.drag(execOut, { x: execOut.x + 160, y: execOut.y });
      await e.page.fill('#context-search', 'add');
      await e.page.locator('#context-results .context-node', { hasText: 'Add' }).first().dispatchEvent('mousedown');
      const add = await waitForNode(e, 'core:math.add');

      // Hold B and click: a Branch; wire Add's exec output into it. (B comes straight after the
      // menu closes: its search field must not keep the key.)
      await e.page.keyboard.down('b');
      await e.page.mouse.click(820, 200);
      await e.page.keyboard.up('b');
      const branch = await waitForNode(e, 'core:flow.branch');
      await e.drag(await e.pinCenter(add, 'execOut'), await e.pinCenter(branch, 'execIn'));

      // True → a Print from the action menu, fed by Add's result.
      const trueOut = await e.pinCenter(branch, 'true');
      await e.drag(trueOut, { x: trueOut.x + 150, y: trueOut.y - 60 });
      await e.page.fill('#context-search', 'print');
      await e.page.locator('#context-results .context-node', { hasText: 'Print' }).first().dispatchEvent('mousedown');
      const printTrue = await nodeOfType('core:console.print');
      await e.drag(await e.pinCenter(add, 'result'), await e.pinCenter(printTrue, 'value'));

      // False → another Print, its text typed on the node.
      const falseOut = await e.pinCenter(branch, 'false');
      await e.drag(falseOut, { x: falseOut.x + 150, y: falseOut.y + 120 });
      await e.page.fill('#context-search', 'print');
      await e.page.locator('#context-results .context-node', { hasText: 'Print' }).first().dispatchEvent('mousedown');
      const prints = (await saved(e)).graphs[0].nodes.filter((n) => n.type === 'core:console.print').map((n) => n.id);
      const printFalse = prints.find((id) => id !== printTrue)!;
      await e.page.fill(`.node[data-node="${printFalse}"] .pin-default[data-pin="value"]`, 'False branch');

      // Clicking the canvas ends the inline edit, then F7 compiles, as in Unreal.
      await e.page.mouse.click(700, 780);
      await e.page.keyboard.press('F7');
      assert.ok((await e.posted()).some((m) => m.type === 'compile'));
      assert.deepEqual(e.errors, []);

      const doc = await saved(e);
      const registry = new NodeRegistry();
      const compiled = compileDocument(doc, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Demo.vgraph' } });
      assert.deepEqual(compiled.diagnostics, [], 'the graph compiles cleanly');
      const events: RuntimeLogEvent[] = [];
      new GraphRuntime(registry, (event) => events.push(event)).run(doc);
      assert.deepEqual(events.filter((ev) => ev.kind === 'log').map((ev) => ev.message), ['30']);
    } finally {
      await e.close();
    }
  });
});

async function saved(e: EditorPage): Promise<GraphDocument> {
  await e.lastSavedGraph();
  return (await e.posted()).filter((m) => m.type === 'applyDocument').pop()!.document!;
}

// The id of the newest node of `type`, once a save containing it has arrived.
async function waitForNode(e: EditorPage, type: string): Promise<string> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const posted = await e.posted();
    const doc = posted.filter((m) => m.type === 'applyDocument').pop()?.document;
    const id = doc?.graphs[0].nodes.filter((n) => n.type === type).map((n) => n.id).pop();
    if (id) return id;
    if (Date.now() > deadline) throw new Error(`No ${type} node was saved`);
    await e.page.waitForTimeout(25);
  }
}
