// The editor in the graph language's terms (docs/language-context.md, part 2): changing the Language
// menu changes what the palette, node titles, pin tooltips, My Blueprint and the type picker call
// things, and nothing that's saved.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphDocument, LanguageOption } from '../../src/core/model';
import { builtinLanguagePacks } from '../../src/core/languages';
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

  // docs/language-context.md, part 4 and the exit check: the languages as the host describes them.
  test("a language's own nodes are offered under its name, and only where it has them", async (t) => {
    if (!browser) return t.skip(skipReason);
    const packs = builtinLanguagePacks();
    const option = (id: string): LanguageOption => {
      const pack = packs.get(id)!;
      return { id, displayName: pack.displayName, callable: pack.generator!.importLanguages, capabilities: pack.capabilities, snippetLanguages: pack.generator!.snippetLanguages, snippets: Object.keys(pack.generator!.snippets ?? {}), terms: pack.terms };
    };
    editor = await EditorPage.open(browser);
    const e = editor;
    const doc = document();
    doc.language = 'python';
    await e.send({ type: 'init', document: doc, definitions: sampleDefinitions(), saveDelay: 0, languages: ['python', 'rust', 'lua'].map(option) });
    const section = (category: string) => e.page.$$eval('#categories section', (sections, wanted) => sections.filter((s) => s.querySelector('.category-title')?.textContent === wanted).flatMap((s) => [...s.querySelectorAll('.palette-node strong')].map((el) => el.textContent)), category);
    assert.deepEqual(await section('Python / Regex'), ['Regex Matches', 'Regex Replace', 'Regex Find All']);
    assert.deepEqual(await section('Python / Hash'), ['MD5', 'SHA-1', 'SHA-256']);
    await e.page.selectOption('#language', 'rust');
    const all = await e.page.$$eval('.category-title', (els) => els.map((el) => el.textContent ?? ''));
    assert.ok(!all.some((c) => /Regex|Hash|Patterns/.test(c)), all.join(', '));
    await e.page.selectOption('#language', 'lua');
    assert.deepEqual(await section('Lua / Patterns'), ['Pattern Matches', 'Pattern Replace', 'Pattern Find All']);
    assert.deepEqual(await section('Lua / Regex'), []);
  });

  // docs/language-context.md, part 3.
  test("the palette and the Add Node menu preview the highlighted node's code, asking the host once", async (t) => {
    const e = await open(t);
    if (!e) return;
    type Request = { type: string; requestId?: number; nodeType?: string; document?: GraphDocument };
    const requests = async () => ((await e.posted()) as Request[]).filter((m) => m.type === 'previewNode');
    let answered = 0;
    // Answers the next request, once the webview has sent it.
    const answer = async (nodeType: string, code: string) => {
      await e.page.waitForFunction((after) => (window as unknown as { __posted: Request[] }).__posted.some((m) => m.type === 'previewNode' && (m.requestId ?? 0) > after), answered);
      const request = (await requests()).filter((m) => (m.requestId ?? 0) > answered).pop()!;
      assert.equal(request.nodeType, nodeType);
      answered = request.requestId ?? 0;
      await e.send({ type: 'nodePreview', requestId: request.requestId, preview: { code, kind: 'snippet' } });
      return request;
    };

    await e.page.hover('.palette-node:has(strong:text-is("Make Array"))');
    const request = await answer('core:array.make', 'return [item0];');
    assert.equal(request.document?.language, 'typescript', 'the document goes with it');
    assert.equal(await e.page.textContent('#palette-preview .node-preview-title'), 'In TypeScript');
    assert.equal(await e.page.textContent('#palette-preview .node-preview-code'), 'return [item0];');

    // Known now: no second request.
    await e.page.hover('.palette-node:has(strong:text-is("Make Set"))');
    await answer('core:set.make', 'return new Set([item0]);');
    await e.page.hover('.palette-node:has(strong:text-is("Make Array"))');
    assert.equal(await e.page.textContent('#palette-preview .node-preview-code'), 'return [item0];');
    assert.equal((await requests()).filter((m) => m.nodeType === 'core:array.make').length, 1);

    // A node with none says so.
    await e.page.hover('.palette-node:has(strong:text-is("Sequence"))');
    await e.page.waitForFunction(() => (window as unknown as { __posted: Request[] }).__posted.some((m) => m.type === 'previewNode' && m.nodeType === 'core:flow.sequence'));
    const sequence = (await requests()).filter((m) => m.nodeType === 'core:flow.sequence').pop()!;
    answered = sequence.requestId ?? 0;
    await e.send({ type: 'nodePreview', requestId: sequence.requestId });
    assert.equal(await e.page.textContent('#palette-preview .node-preview-title'), 'No TypeScript preview');

    // Another language asks again.
    await e.page.selectOption('#language', 'python');
    await e.page.hover('.palette-node:has(strong:text-is("Make List"))');
    await answer('core:array.make', 'return [item_0]');
    assert.equal(await e.page.textContent('#palette-preview .node-preview-title'), 'In Python');

    // The Add Node menu has its own.
    const box = (await e.page.locator('#canvas-wrap').boundingBox())!;
    await e.page.mouse.click(box.x + box.width - 60, box.y + box.height - 60, { button: 'right' });
    await e.page.fill('#context-search', 'branch');
    await e.page.hover('#context-results .context-node:has(strong:text-is("Branch"))');
    await answer('core:flow.branch', 'if condition:\n    pass');
    assert.equal(await e.page.textContent('#context-preview .node-preview-code'), 'if condition:\n    pass');
  });
});
