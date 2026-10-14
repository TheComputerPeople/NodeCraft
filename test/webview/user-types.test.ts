// Structs and enums in the editor (docs/program-structure.md, "Structs and enums"): the structure
// and enumeration editors, the type pickers, enum pin values and Set Members' member choice.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphDocument } from '../../src/core/model';
import { declaredType, userTypeDefinitions } from '../../src/core/user-types';
import { EditorPage, launchBrowser, sampleDefinitions, sampleDocument } from './harness';

const team: GraphDocument = {
  schemaVersion: 3, name: 'Team', kind: 'enumeration', language: 'javascript', variables: [], graphs: [], metadata: {},
  enumerators: [{ id: 'red', name: 'Red' }, { id: 'blue', name: 'Light Blue' }]
};
const stats: GraphDocument = {
  schemaVersion: 3, name: 'Stats', kind: 'structure', language: 'javascript', graphs: [], metadata: {},
  variables: [{ id: 'health', name: 'Health', type: { id: 'float' }, defaultValue: 100 }, { id: 'team', name: 'Team', type: { id: 'enum:Team' } }]
};

function definitions() {
  return [...sampleDefinitions(), ...userTypeDefinitions(declaredType(team)!), ...userTypeDefinitions(declaredType(stats)!)];
}

describe('structs and enums', () => {
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
    await editor.send({ type: 'init', document, definitions: definitions(), saveDelay: 0 });
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

  test('a structure opens in its field editor; fields are added, typed and reordered', async (t) => {
    const e = await open(t, structuredClone(stats));
    if (!e) return;
    assert.equal(await e.page.isVisible('#type-editor'), true);
    assert.equal(await e.page.isVisible('#palette'), false);
    assert.equal(await e.count('.type-member[data-member]'), 2);
    await e.page.click('#type-editor .type-add');
    await e.page.fill('.type-member[data-member="var_MemberVar"] input[aria-label="Field Name"]', 'Name');
    await e.page.press('.type-member[data-member="var_MemberVar"] input[aria-label="Field Name"]', 'Enter');
    await e.page.selectOption('.type-member[data-member="var_MemberVar"] select[aria-label="Name Type"]', 'string');
    const options = await e.page.$$eval('.type-member[data-member="var_MemberVar"] select[aria-label="Name Type"] option', (els) => els.map((el) => el.textContent));
    assert.ok(options.includes('Team'), 'enums are offered');
    assert.ok(!options.includes('Stats'), 'a structure can\'t contain itself');
    await e.page.click('.type-member[data-member="var_MemberVar"] button[aria-label="Move up"]');
    const doc = await saved(e, (d) => d.variables.length === 3 && d.variables[1].name === 'Name');
    assert.deepEqual(doc.variables.map((v) => [v.name, v.type.id]), [['Health', 'float'], ['Name', 'string'], ['Team', 'enum:Team']]);
    assert.equal(await e.page.isVisible('.type-member[data-member="team"] select[aria-label="Default Value"]'), true, 'an enum field\'s default is picked from its values');
  });

  test('an enumeration opens in its value editor; its last value can\'t be removed', async (t) => {
    const e = await open(t, structuredClone(team));
    if (!e) return;
    await e.page.click('#type-editor .type-add');
    await e.page.fill('.type-member[data-member="NewEnumerator"] input[aria-label="Display Name"]', 'Dark Green');
    await e.page.press('.type-member[data-member="NewEnumerator"] input[aria-label="Display Name"]', 'Enter');
    const doc = await saved(e, (d) => d.enumerators?.length === 3 && d.enumerators[2].name === 'Dark Green');
    assert.deepEqual(doc.enumerators!.map((v) => v.name), ['Red', 'Light Blue', 'Dark Green']);
    for (const id of ['red', 'blue']) await e.page.click(`.type-member[data-member="${id}"] button[aria-label="Remove"]`);
    await e.page.click('.type-member[data-member="NewEnumerator"] button[aria-label="Remove"]');
    assert.match((await e.page.textContent('#status'))!, /at least one value/);
  });

  test('graphs offer the types\' nodes; enum pins pick a value; Set Members shows the chosen fields', async (t) => {
    const doc = sampleDocument();
    doc.graphs[0].nodes.push(
      { id: 'eq', type: 'enum:Team.equal', position: { x: 600, y: 420 }, properties: {} },
      { id: 'members', type: 'struct:Stats.set-members', position: { x: 600, y: 560 }, properties: {} }
    );
    const e = await open(t, doc);
    if (!e) return;
    const names = await e.page.$$eval('.palette-node strong', (els) => els.map((el) => el.textContent));
    for (const name of ['Make Stats', 'Break Stats', 'Switch on Team']) assert.ok(names.includes(name), name);

    await e.page.selectOption('select.pin-default[data-pin="b"]', 'blue');
    const withValue = await saved(e, (d) => d.graphs[0].nodes.some((n) => n.id === 'eq' && n.properties['pin:b'] === 'blue'));
    assert.ok(withValue);

    assert.deepEqual(await e.page.$$eval('.pin[data-node="members"]', (els) => els.map((el) => (el as HTMLElement).dataset.pin)), ['execIn', 'struct', 'execOut', 'result']);
    await e.page.click('.node[data-node="members"] .node-header');
    await e.page.check('#inspector-content input[aria-label="Health"]');
    assert.deepEqual(await e.page.$$eval('.pin[data-node="members"]', (els) => els.map((el) => (el as HTMLElement).dataset.pin)), ['execIn', 'struct', 'health', 'execOut', 'result']);
  });

  test('variable types include structs and enums', async (t) => {
    const e = await open(t, sampleDocument());
    if (!e) return;
    await e.page.click('.mb-header:has-text("Variables") button');
    await e.page.keyboard.press('Escape');
    await e.page.click('.mb-item[data-kind="variable"]');
    const options = await e.page.$$eval('#inspector-content select[aria-label="Variable Type"] option', (els) => els.map((el) => el.textContent));
    assert.ok(options.includes('Stats') && options.includes('Team'));
    await e.page.selectOption('#inspector-content select[aria-label="Variable Type"]', 'enum:Team');
    await e.page.selectOption('#inspector-content select[aria-label="Default Value"]', 'blue');
    const doc = await saved(e, (d) => d.variables.some((v) => v.type.id === 'enum:Team' && v.defaultValue === 'blue'));
    assert.ok(doc);
  });
});
