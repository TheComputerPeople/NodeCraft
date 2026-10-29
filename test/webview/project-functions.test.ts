// Project function nodes in the editor when their code changes (docs/code-as-nodes.md, "When the
// code changes"): badges, Refresh Node, Replace with, Refresh All Nodes, and stored signatures.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { GraphDocument, NodeDefinition, PinDefinition } from '../../src/core/model';
import { EditorPage, launchBrowser, sampleDefinitions } from './harness';

const data = (id: string, direction: 'input' | 'output', type = 'float'): PinDefinition => ({ id, name: id, kind: 'data', direction, type: { id: type } });

function fn(name: string, params: [string, string][], title = name): NodeDefinition {
  return {
    type: `fn:typescript:lib/score.ts#${name}`, version: 1, displayName: title, category: 'Project / score',
    inputs: [{ id: 'execIn', name: '', kind: 'exec', direction: 'input' }, ...params.map(([id, type]) => data(id, 'input', type))],
    outputs: [{ id: 'execOut', name: '', kind: 'exec', direction: 'output' }, data('returnValue', 'output')],
    implementation: { kind: 'function', language: 'typescript', path: 'lib/score.ts', name }
  };
}

const applyDamage = fn('applyDamage', [['amount', 'float']], 'Apply Damage');

// Start → Apply Damage, with the signature the node was made with stored in the document.
function documentWith(stored: NodeDefinition | undefined): GraphDocument {
  return {
    schemaVersion: 3, name: 'Game', kind: 'class', language: 'typescript', variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [
        { id: 's', type: 'core:event.start', position: { x: 100, y: 100 }, properties: {} },
        { id: 'f', type: applyDamage.type, position: { x: 400, y: 100 }, properties: {} }
      ],
      connections: [{ id: 'c1', fromNode: 's', fromPin: 'execOut', toNode: 'f', toPin: 'execIn' }]
    }],
    ...(stored ? { importedFunctions: { [stored.type]: stored } } : {})
  };
}

describe('project function nodes', () => {
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

  async function open(t: TestContext, document: GraphDocument, definitions: NodeDefinition[], functionsLoaded = true): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document, definitions: [...sampleDefinitions(), ...definitions], functionsLoaded, saveDelay: 0 });
    return editor;
  }

  const pins = (e: EditorPage) => e.page.$$eval('.pin[data-node="f"][data-direction="input"]', (els) => els.map((el) => (el as HTMLElement).dataset.pin));
  // Read now, not waited for: a missing badge is an answer.
  const badge = async (e: EditorPage) => (await e.page.$('.node[data-node="f"] .node-badge'))?.getAttribute('class') ?? null;
  const menu = async (e: EditorPage) => {
    const box = (await e.page.locator('.node[data-node="f"] .node-header').boundingBox())!;
    await e.page.mouse.click(box.x + 30, box.y + 8, { button: 'right' });
    return e.page.$$eval('#context-menu button', (els) => els.map((el) => el.textContent));
  };
  const lastSave = async (e: EditorPage) => (await e.posted()).filter((m) => m.type === 'applyDocument').pop()?.document;

  test('a changed function keeps its old pins, with a warning, until Refresh Node', async (t) => {
    const changed = fn('applyDamage', [['amount', 'float'], ['crit', 'bool']], 'Apply Damage');
    const e = await open(t, documentWith(applyDamage), [changed]);
    if (!e) return;
    assert.deepEqual(await pins(e), ['execIn', 'amount']);
    assert.equal(await badge(e), 'node-badge warning');
    assert.match((await e.page.getAttribute('.node[data-node="f"] .node-badge', 'title'))!, /parameter "crit" was added/);

    assert.equal((await menu(e))[0], 'Refresh Node');
    await e.page.locator('#context-menu button', { hasText: 'Refresh Node' }).click();
    assert.deepEqual(await pins(e), ['execIn', 'amount', 'crit']);
    assert.equal(await badge(e), null);
    await e.page.waitForFunction(() => (window as unknown as { __posted: { type: string }[] }).__posted.some((m) => m.type === 'applyDocument'));
    const saved = await lastSave(e);
    assert.deepEqual(saved?.importedFunctions?.[applyDamage.type]?.inputs.map((p) => p.id), ['execIn', 'amount', 'crit']);
    assert.equal(saved?.graphs[0].connections.length, 1, 'the exec wire is kept');
  });

  test('a missing function is an error, and Replace with offers the function it was renamed to', async (t) => {
    const renamed = fn('dealDamage', [['amount', 'float']], 'Deal Damage');
    const e = await open(t, documentWith(applyDamage), [renamed]);
    if (!e) return;
    assert.equal(await badge(e), 'node-badge error');
    assert.equal((await menu(e))[0], 'Replace with Deal Damage (lib/score.ts)');
    await e.page.locator('#context-menu button', { hasText: 'Replace with Deal Damage' }).click();
    assert.equal(await badge(e), null);
    await e.page.waitForFunction(() => (window as unknown as { __posted: { type: string }[] }).__posted.some((m) => m.type === 'applyDocument'));
    const saved = await lastSave(e);
    assert.equal(saved?.graphs[0].nodes[1].type, renamed.type);
    assert.deepEqual(Object.keys(saved?.importedFunctions ?? {}), [renamed.type], 'the old signature is dropped once unused');
  });

  test('missing functions are not flagged until the project has been scanned', async (t) => {
    const e = await open(t, documentWith(applyDamage), [], false);
    if (!e) return;
    assert.equal(await badge(e), null);
    await e.send({ type: 'definitions', definitions: sampleDefinitions(), functionsLoaded: true });
    assert.equal(await badge(e), 'node-badge error');
  });

  test('Refresh All Nodes from the host refreshes every changed node', async (t) => {
    const changed = fn('applyDamage', [['amount', 'int']], 'Apply Damage');
    const e = await open(t, documentWith(applyDamage), [changed]);
    if (!e) return;
    await e.send({ type: 'refreshAll' });
    assert.equal(await badge(e), null);
    assert.match((await e.page.textContent('#status'))!, /Refreshed 1 node/);
  });

  test('a node placed from the palette stores its signature when the graph is saved', async (t) => {
    const e = await open(t, documentWith(undefined), [applyDamage]);
    if (!e) return;
    await e.page.locator('.palette-node', { hasText: 'Apply Damage' }).dispatchEvent('mousedown');
    await e.page.waitForFunction(() => (window as unknown as { __posted: { type: string }[] }).__posted.some((m) => m.type === 'applyDocument'));
    assert.deepEqual(Object.keys((await lastSave(e))?.importedFunctions ?? {}), [applyDamage.type]);
  });

  // Node library packages (docs/language-breadth.md, "Node library versioning").
  test('a node whose package changed major version is marked until Refresh Node, which records the new version', async (t) => {
    const hit: NodeDefinition = { ...fn('hit', [['amount', 'float']], 'Hit'), type: 'combat:hit', implementation: { kind: 'code', languages: { typescript: 'return amount;' } }, library: { name: 'combat-nodes', version: '2.0.0' } };
    const document = documentWith(undefined);
    document.graphs[0].nodes[1].type = 'combat:hit';
    const e = await open(t, { ...document, metadata: { libraries: { 'combat-nodes': '1.4.0' } } }, [hit]);
    if (!e) return;
    assert.equal(await badge(e), 'node-badge warning');
    assert.match((await e.page.getAttribute('.node[data-node="f"] .node-badge', 'title'))!, /combat-nodes is now version 2\.0\.0/);
    assert.equal((await menu(e))[0], 'Refresh Node');
    await e.page.locator('#context-menu button', { hasText: 'Refresh Node' }).click();
    assert.equal(await badge(e), null);
    await e.page.waitForFunction(() => (window as unknown as { __posted: { type: string }[] }).__posted.some((m) => m.type === 'applyDocument'));
    assert.deepEqual((await lastSave(e))?.metadata?.libraries, { 'combat-nodes': '2.0.0' });
  });

  test('an async function is a latent node: a clock in its title, and Completed for its exec output', async (t) => {
    const latent: NodeDefinition = { ...applyDamage, latent: true, outputs: [{ id: 'completed', name: 'Completed', kind: 'exec', direction: 'output' }, data('returnValue', 'output')] };
    const e = await open(t, documentWith(undefined), [latent]);
    if (!e) return;
    assert.ok(await e.page.$('.node[data-node="f"] .node-header .node-latent'), 'a clock');
    assert.equal(await e.page.$('.node[data-node="s"] .node-latent'), null, 'no clock on other nodes');
    assert.ok(await e.page.$('.pin[data-node="f"][data-pin="completed"]'));
  });
});
