// The editor offers only what the graph's language can express (docs/language-breadth.md,
// "Capabilities, enforced"): the palette, container pickers, Class Settings and My Blueprint.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { LanguageOption } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

const full = { staticTyping: true, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true };

describe('capabilities in the editor', () => {
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

  async function open(t: TestContext, language: LanguageOption): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document: sampleDocument(), definitions: sampleDefinitions(), saveDelay: 0, languages: [language] });
    return editor;
  }

  const palette = (e: EditorPage) => e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent ?? ''));

  test('a language without latent actions, sets, maps, dispatchers or inheritance offers none of them', async (t) => {
    const e = await open(t, { id: 'javascript', displayName: 'Limited', callable: ['javascript'], capabilities: { ...full, async: false, inheritance: false, containers: ['array'], delegates: false } });
    if (!e) return;
    const names = await palette(e);
    for (const hidden of ['Delay', 'Retriggerable Delay', 'Make Set', 'Make Map']) assert.ok(!names.includes(hidden), hidden);
    for (const shown of ['Make Array', 'Print', 'Branch']) assert.ok(names.includes(shown), shown);

    assert.equal(await e.count('.mb-header:has-text("Event Dispatchers")'), 0, 'no Event Dispatchers section');
    // Class Settings: no Parent Class.
    await e.page.click('#canvas-wrap', { position: { x: 20, y: 20 } });
    assert.equal(await e.count('#inspector-content select[aria-label="Parent Class"]'), 0);

    // A variable's container picker offers only arrays.
    await e.page.click('.mb-header:has-text("Variables") button');
    await e.page.keyboard.press('Escape');
    await e.page.click('.mb-item[data-kind="variable"]');
    const containers = await e.page.$$eval('#inspector-content select[aria-label="Container Type"] option', (els) => els.map((el) => el.textContent));
    assert.deepEqual(containers, ['Single', 'Array']);
  });

  // docs/code-classes-as-parents.md, decision 3: a language that says why it has no inheritance
  // (Rust, Go) says it in Class Settings.
  test("Class Settings says why a language without inheritance can't have a Parent Class", async (t) => {
    const why = "A struct can't extend another.";
    const e = await open(t, { id: 'javascript', displayName: 'Plain', callable: ['javascript'], capabilities: { ...full, inheritance: false, noInheritance: why } });
    if (!e) return;
    await e.page.click('#canvas-wrap', { position: { x: 20, y: 20 } });
    assert.equal(await e.count('#inspector-content select[aria-label="Parent Class"]'), 0);
    assert.equal(await e.page.textContent('#inspector-content .no-inheritance'), `Plain has no inheritance. ${why}`);
  });

  test('the language list follows packs registered and removed while the editor is open', async (t) => {
    const e = await open(t, { id: 'javascript', displayName: 'JavaScript', callable: ['javascript'], capabilities: full });
    if (!e) return;
    const options = () => e.page.$$eval('#language option', (els) => els.map((el) => el.textContent));
    assert.deepEqual(await options(), ['JavaScript']);
    await e.send({ type: 'languages', languages: [{ id: 'javascript', displayName: 'JavaScript', callable: ['javascript'], capabilities: full }, { id: 'echo', displayName: 'Echo', callable: [], capabilities: { ...full, async: false } }] });
    assert.deepEqual(await options(), ['JavaScript', 'Echo']);
  });

  // docs/multi-language.md, gap 3.
  test('code nodes the language has no implementation of are left out', async (t) => {
    const e = await open(t, { id: 'javascript', displayName: 'Echo', callable: ['echo'], capabilities: full, snippetLanguages: ['echo'], snippets: ['core:math.sqrt'] });
    if (!e) return;
    const names = await palette(e);
    for (const hidden of ['Clamp', 'Slugify', 'Unique']) assert.ok(!names.includes(hidden), hidden);
    for (const shown of ['Sqrt', 'Print', 'Branch']) assert.ok(names.includes(shown), shown);
  });

  test('a language with every capability offers everything', async (t) => {
    const e = await open(t, { id: 'javascript', displayName: 'JavaScript', callable: ['javascript'], capabilities: full });
    if (!e) return;
    const names = await palette(e);
    for (const shown of ['Delay', 'Make Set', 'Make Map', 'Make Array']) assert.ok(names.includes(shown), shown);
    assert.equal(await e.count('.mb-header:has-text("Event Dispatchers")'), 1);
  });
});
