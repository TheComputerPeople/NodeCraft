// Function and macro metadata in the editor (docs/node-authoring.md, gap 6): set in Details, drawn
// on the nodes (Compact Node Title, Deprecated, Advanced pins), and kept out of the palette.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphDocument } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

// The sample graph plus Heal (a function with metadata) and a call of it.
function documentWithHeal(signature: Record<string, unknown>): GraphDocument {
  const document = sampleDocument();
  document.graphs.push({
    id: 'Heal', name: 'Heal', kind: 'function', comments: [],
    signature: { inputs: [{ id: 'amount', name: 'Amount', kind: 'data', type: { id: 'float' } }, { id: 'bonus', name: 'Bonus', kind: 'data', type: { id: 'float' }, advanced: true }], outputs: [], ...signature },
    nodes: [{ id: 'entry', type: 'core:function.entry', position: { x: 0, y: 0 }, properties: { graph: 'Heal' } }],
    connections: []
  });
  document.graphs[0].nodes.push({ id: 'call', type: 'core:function.call', position: { x: 600, y: 420 }, properties: { graph: 'Heal' } });
  return document;
}

describe('function metadata', () => {
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

  async function open(t: TestContext, document: GraphDocument): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document, definitions: sampleDefinitions(), saveDelay: 0 });
    return editor;
  }

  const saved = async (e: EditorPage, ready: (d: GraphDocument) => boolean): Promise<GraphDocument> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const doc = (await e.posted()).filter((m) => m.type === 'applyDocument').pop()?.document;
      if (doc && ready(doc)) return doc;
      if (Date.now() > deadline) throw new Error('No matching save arrived');
      await e.page.waitForTimeout(25);
    }
  };

  test('Details sets Keywords, Compact Node Title, Deprecated with its message, and Advanced View', async (t) => {
    const e = await open(t, documentWithHeal({}));
    if (!e) return;
    await e.page.click('.mb-item:has-text("Heal")');
    const fill = async (label: string, value: string) => {
      await e.page.fill(`#inspector-content input[aria-label="${label}"]`, value);
      await e.page.press(`#inspector-content input[aria-label="${label}"]`, 'Enter');
    };
    await fill('Keywords', 'mend, cure');
    await fill('Compact Node Title', '+HP');
    await e.page.check('#inspector-content input[aria-label="Deprecated"]');
    await fill('Deprecation Message', 'Use Restore instead.');
    await e.page.check('#inspector-content input[aria-label="Amount Advanced View"]');
    const doc = await saved(e, (d) => d.graphs.find((g) => g.id === 'Heal')?.signature?.inputs[0].advanced === true);
    const signature = doc.graphs.find((g) => g.id === 'Heal')!.signature!;
    assert.deepEqual([signature.keywords, signature.compactTitle, signature.deprecated], [['mend', 'cure'], '+HP', { message: 'Use Restore instead.' }]);
  });

  test('a compact title draws the call like an operator; deprecated warns and leaves the palette', async (t) => {
    const e = await open(t, documentWithHeal({ compactTitle: '+HP', deprecated: { message: 'Use Restore instead.' } }));
    if (!e) return;
    const call = '.node[data-node="call"]';
    assert.equal(await e.page.$eval(call, (el) => el.classList.contains('compact') && el.classList.contains('operator')), true);
    assert.equal(await e.page.textContent(`${call} .node-title`), '+HP');
    assert.equal(await e.page.getAttribute(`${call} .node-badge.warning`, 'title'), '"Heal" is deprecated: Use Restore instead.');
    const names = await e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent));
    assert.ok(!names.includes('Heal'), 'not offered');
  });

  test('advanced inputs fold under the arrow until it is opened, or they are set', async (t) => {
    const e = await open(t, documentWithHeal({}));
    if (!e) return;
    const bonus = '.pin[data-node="call"][data-pin="bonus"]';
    assert.equal(await e.page.$(bonus), null, 'folded');
    assert.ok(await e.page.$('.pin[data-node="call"][data-pin="amount"]'));
    await e.page.click('.node[data-node="call"] .node-advanced');
    assert.ok(await e.page.$(bonus), 'shown');
    const doc = await saved(e, (d) => d.graphs[0].nodes.some((n) => n.id === 'call' && n.properties.showAdvanced === true));
    assert.ok(doc);
    await e.page.click('.node[data-node="call"] .node-advanced');
    assert.equal(await e.page.$(bonus), null, 'folded again');

    // A set value keeps it shown.
    const document = documentWithHeal({});
    document.graphs[0].nodes.find((n) => n.id === 'call')!.properties['pin:bonus'] = 5;
    await e.send({ type: 'documentChanged', document });
    await e.page.waitForSelector(bonus);
  });
});
