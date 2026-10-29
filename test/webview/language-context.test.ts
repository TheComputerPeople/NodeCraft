// The editor in the graph language's terms (docs/language-context.md, part 2): changing the Language
// menu changes what the palette, node titles, pin tooltips, My Blueprint and the type picker call
// things, and nothing that's saved.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphDocument, LanguageOption } from '../../src/core/model';
import { LANGUAGE_TERMS } from '../../src/core/terms';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

const capabilities = { staticTyping: true, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true };
const languages: LanguageOption[] = [
  { id: 'typescript', displayName: 'TypeScript', callable: ['typescript', 'javascript'], capabilities, terms: LANGUAGE_TERMS.typescript },
  { id: 'python', displayName: 'Python', callable: ['python'], capabilities, terms: LANGUAGE_TERMS.python }
];

function document(): GraphDocument {
  const doc = sampleDocument();
  doc.language = 'typescript';
  doc.variables.push({ id: 'scores', name: 'Scores', type: { id: 'int', container: 'array' }, defaultValue: [1, 2] });
  doc.graphs[0].nodes.push(
    { id: 'mk', type: 'core:array.make', position: { x: 600, y: 420 }, properties: { wildcards: { wildcard: 'int' } } },
    { id: 'gs', type: 'core:variable.get', position: { x: 600, y: 560 }, properties: { variable: 'scores' } }
  );
  return doc;
}

describe('language terms in the editor', () => {
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
    await editor.send({ type: 'init', document: document(), definitions: sampleDefinitions(), saveDelay: 0, languages });
    return editor;
  }

  test("changing the language shows the graph in its terms, and saves only the language", async (t) => {
    const e = await open(t);
    if (!e) return;
    const palette = () => e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent ?? ''));
    const categories = () => e.page.$$eval('.category-title', (els) => els.map((el) => el.textContent ?? ''));
    const title = () => e.page.textContent('.node[data-node="mk"] .node-title');
    const pinTip = () => e.page.getAttribute('.pin[data-node="gs"][data-pin="value"]', 'title');
    const variableType = () => e.page.textContent('.mb-item[data-kind="variable"][data-id="scores"] .mb-type');

    assert.ok((await palette()).includes('Make Array'));
    assert.equal(await title(), 'Make Array');
    assert.match((await pinTip()) ?? '', /\(integer\[\]\)$/);
    assert.equal(await variableType(), 'integer[]');

    await e.page.selectOption('#language', 'python');
    const names = await palette();
    assert.ok(names.includes('Make List') && !names.includes('Make Array'));
    assert.ok(names.includes('Make Dict') && names.includes('Make Dict From Lists'));
    assert.ok((await categories()).includes('Utilities / List'));
    assert.equal(await title(), 'Make List');
    assert.match((await pinTip()) ?? '', /\(list\[int\]\)$/);
    assert.equal(await variableType(), 'list[int]');

    // Searching by Unreal's name still finds it.
    await e.page.fill('#search', 'make array');
    assert.ok((await palette()).includes('Make List'));
    await e.page.fill('#search', '');

    // The variable's type picker: Python's words.
    await e.page.click('.mb-item[data-kind="variable"][data-id="scores"]');
    const options = (label: string) => e.page.$$eval(`#inspector-content select[aria-label="${label}"] option`, (els) => els.map((el) => el.textContent));
    assert.deepEqual((await options('Container Type')).slice(0, 4), ['Single', 'List', 'Set', 'Dict']);
    assert.ok((await options('Variable Type')).includes('str'));

    await e.page.click('#compile');
    const saved = (await e.posted()).filter((m) => m.type === 'applyDocument').pop()?.document;
    assert.equal(saved?.language, 'python');
    assert.equal(saved?.graphs[0].nodes.find((n) => n.id === 'mk')?.type, 'core:array.make');
    assert.deepEqual(saved?.variables.find((v) => v.id === 'scores')?.type, { id: 'int', container: 'array' });

    await e.page.selectOption('#language', 'typescript');
    assert.equal(await title(), 'Make Array');
  });
});
