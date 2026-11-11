// Objects in the editor (docs/program-structure.md, "Classes"): workspace classes as variable types,
// Construct, Self, and other classes' members with a Target pin.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { CodeClassInfo, classDefinitions, declaredClass, declaredInterface, interfaceDefinitions } from '../../src/core/objects';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

const enemy: GraphDocument = {
  schemaVersion: 3, name: 'Enemy', kind: 'class', language: 'javascript', variables: [{ id: 'health', name: 'Health', type: { id: 'int' } }],
  dispatchers: [{ id: 'died', name: 'Died', inputs: [] }],
  graphs: [
    { id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [], connections: [] },
    { id: 'Hit', name: 'Hit', kind: 'function', comments: [], signature: { inputs: [{ id: 'amount', name: 'Amount', kind: 'data', type: { id: 'int' } }], outputs: [] }, nodes: [], connections: [] }
  ]
};

const usable: GraphDocument = {
  schemaVersion: 3, name: 'Usable', kind: 'interface', language: 'javascript', variables: [],
  graphs: [{ id: 'Use', name: 'Use', kind: 'function', comments: [], signature: { inputs: [], outputs: [{ id: 'ok', name: 'OK', kind: 'data', type: { id: 'bool' } }] }, nodes: [], connections: [] }]
};

describe('objects', () => {
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
    await editor.send({ type: 'init', document: sampleDocument(), definitions: [...sampleDefinitions(), ...classDefinitions(declaredClass(enemy)!), ...interfaceDefinitions(declaredInterface(usable)!)], saveDelay: 0 });
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

  test('the palette offers Construct, Self and another class\'s members, which take a Target', async (t) => {
    const e = await open(t);
    if (!e) return;
    const names = await e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent));
    for (const name of ['Construct Enemy', 'Self', 'Is Valid', 'Hit', 'Health', 'Set Health', 'Call Died', 'Bind Event to Died']) assert.ok(names.includes(name), name);
    await e.page.locator('.palette-node', { hasText: 'Hit' }).first().dispatchEvent('mousedown');
    const doc = await saved(e, (d) => d.graphs[0].nodes.some((n) => n.type === 'core:object.call'));
    const call = doc.graphs[0].nodes.find((n) => n.type === 'core:object.call')!;
    assert.deepEqual(call.properties, { class: 'object:Enemy', function: 'Hit' });
    assert.deepEqual(await e.page.$$eval(`.pin[data-node="${call.id}"]`, (els) => els.map((el) => (el as HTMLElement).dataset.pin)), ['execIn', 'target', 'amount', 'execOut']);
  });

  test('a variable can hold an object of a workspace class', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('.mb-header:has-text("Variables") button');
    await e.page.keyboard.press('Escape');
    await e.page.click('.mb-item[data-kind="variable"]');
    await e.page.selectOption('#inspector-content select[aria-label="Variable Type"]', 'object:Enemy');
    const doc = await saved(e, (d) => d.variables.some((v) => v.type.id === 'object:Enemy'));
    assert.ok(doc);
  });

  test('Class Settings picks a parent class; Override makes a function that calls the parent\'s', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.selectOption('#inspector-content select[aria-label="Parent Class"]', 'object:Enemy');
    await e.page.click('.mb-override');
    await e.page.locator('#floating-menu button', { hasText: 'Hit' }).click();
    const doc = await saved(e, (d) => d.graphs.some((g) => g.name === 'Hit'));
    assert.equal(doc.parent, 'object:Enemy');
    const hit = doc.graphs.find((g) => g.name === 'Hit')!;
    assert.deepEqual(hit.signature?.inputs.map((p) => p.name), ['Amount']);
    assert.deepEqual(hit.nodes.map((n) => n.type), ['core:function.entry', 'core:object.parent']);
    assert.ok(hit.connections.some((c) => c.fromPin === 'amount' && c.toPin === 'amount'));
    assert.equal(await e.count('.mb-override'), 0, 'nothing left to override');
  });

  test("Class Settings lists the code's classes with their files; a class isn't a node; a missing parent says so", async (t) => {
    if (!browser) return t.skip(skipReason);
    const actor: CodeClassInfo = { kind: 'code-class', id: 'code:javascript:lib/actor.js#Actor', type: 'native:Actor', name: 'Actor', title: 'Actor', language: 'javascript', path: 'lib/actor.js', overridable: [] };
    const python: CodeClassInfo = { ...actor, id: 'code:python:actor.py#Actor', language: 'python', path: 'actor.py' };
    const definition = (info: CodeClassInfo): NodeDefinition => ({ type: info.id, version: 1, displayName: info.title, category: 'Project / Classes', inputs: [], outputs: [], implementation: { kind: 'code-class', type: info } });
    editor = await EditorPage.open(browser);
    const e = editor;
    await e.send({ type: 'init', document: sampleDocument(), definitions: [...sampleDefinitions(), ...classDefinitions(declaredClass(enemy)!), definition(actor), definition(python)], saveDelay: 0 });
    const options = await e.page.$$eval('#inspector-content select[aria-label="Parent Class"] option', (els) => els.map((el) => [(el as HTMLOptionElement).value, el.textContent]));
    assert.deepEqual(options, [['', 'None'], ['object:Enemy', 'Enemy'], ['code:javascript:lib/actor.js#Actor', 'Actor (lib/actor.js)']], "the JavaScript graph's: not Python's");
    assert.ok(!(await e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent))).includes('Actor'));
    await e.page.selectOption('#inspector-content select[aria-label="Parent Class"]', 'code:javascript:lib/actor.js#Actor');
    assert.equal((await saved(e, (d) => !!d.parent)).parent, 'code:javascript:lib/actor.js#Actor');
    // Gone from the code: still chosen, and marked missing.
    await e.send({ type: 'init', document: { ...sampleDocument(), parent: 'code:javascript:lib/gone.js#Gone' }, definitions: sampleDefinitions(), saveDelay: 0 });
    assert.equal(await e.page.$eval('#inspector-content select[aria-label="Parent Class"]', (el) => (el as HTMLSelectElement).selectedOptions[0].textContent), 'Gone (missing)');
  });

  test('Class Settings adds an interface; its functions are implemented from the Override menu', async (t) => {
    const e = await open(t);
    if (!e) return;
    const names = await e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent));
    for (const name of ['Cast To Usable', 'Cast To Enemy', 'Use']) assert.ok(names.includes(name), name);
    await e.page.selectOption('#inspector-content select[aria-label="Add Interface"]', 'interface:Usable');
    await e.page.click('.mb-override');
    await e.page.locator('#floating-menu button', { hasText: 'Use (interface)' }).click();
    const doc = await saved(e, (d) => d.graphs.some((g) => g.name === 'Use'));
    assert.deepEqual(doc.interfaces, ['interface:Usable']);
    assert.deepEqual(doc.graphs.find((g) => g.name === 'Use')!.nodes.map((n) => n.type), ['core:function.entry', 'core:function.return']);
  });
});
