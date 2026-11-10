// The Codebase Map's webview (src/map/map.ts): it draws the laid-out scene it's sent, opens and
// closes boxes and opens code through the extension, pans and zooms, and shows less when zoomed out.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { LaidScene } from '../../src/core/codemap/scene';
import { EditorPage, launchBrowser } from './harness';

// A project open on two files: a.ts (closed, with a class inside) importing b.ts, and an external package.
const SCENE: LaidScene = {
  mode: 'architecture',
  width: 520, height: 330,
  boxes: [
    { id: 'p:', label: 'shop', kind: 'project', count: 4, expandable: true, expanded: true, x: 0, y: 0, width: 380, height: 220, path: '' },
    { id: 'f:a.ts', parent: 'p:', label: 'a.ts', kind: 'file', language: 'typescript', count: 1, expandable: true, expanded: false, x: 20, y: 40, width: 150, height: 48, path: 'a.ts', entry: 'main' },
    { id: 'f:b.ts', parent: 'p:', label: 'b.ts', kind: 'file', language: 'typescript', count: 0, expandable: false, expanded: false, x: 20, y: 150, width: 150, height: 48, path: 'b.ts' },
    { id: 'externals', label: 'External packages', kind: 'externals', count: 1, expandable: true, expanded: false, x: 400, y: 280, width: 120, height: 48 }
  ],
  arrows: [
    { id: 'imports:f:a.ts>f:b.ts', from: 'f:a.ts', to: 'f:b.ts', kind: 'imports', weight: 3, certain: true, points: [{ x: 95, y: 88 }, { x: 95, y: 150 }] },
    { id: 'calls:f:b.ts>f:a.ts', from: 'f:b.ts', to: 'f:a.ts', kind: 'calls', weight: 1, certain: false, points: [{ x: 20, y: 174 }, { x: 20, y: 64 }], back: true },
    { id: 'imports:p:>externals', from: 'p:', to: 'externals', kind: 'imports', weight: 1, certain: true, points: [{ x: 190, y: 220 }, { x: 460, y: 280 }] }
  ],
  // The project's import of the package is a.ts's.
  details: [
    { id: 'imports:f:a.ts>f:b.ts', from: 'f:a.ts', to: 'f:b.ts', kind: 'imports', weight: 3, certain: true, points: [{ x: 95, y: 88 }, { x: 95, y: 150 }] },
    { id: 'calls:f:b.ts>f:a.ts', from: 'f:b.ts', to: 'f:a.ts', kind: 'calls', weight: 1, certain: false, points: [{ x: 20, y: 174 }, { x: 20, y: 64 }], back: true },
    { id: 'imports:f:a.ts>externals', from: 'f:a.ts', to: 'externals', kind: 'imports', weight: 1, certain: true, points: [{ x: 95, y: 88 }, { x: 460, y: 280 }] }
  ]
};

describe('the Codebase Map webview', () => {
  let browser: Browser | undefined;
  let skipReason = '';
  let page: EditorPage | undefined;

  before(async () => {
    const result = await launchBrowser();
    if (typeof result === 'string') skipReason = result;
    else browser = result;
  });
  after(async () => {
    await browser?.close();
  });
  afterEach(async () => {
    if (!page) return;
    const errors = page.errors;
    await page.close();
    page = undefined;
    assert.deepEqual(errors, [], 'the page logged errors');
  });

  async function open(t: TestContext): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    page = await EditorPage.open(browser, 'map');
    await page.send({ type: 'scene', scene: SCENE, title: 'Codebase Map: shop' } as never);
    return page;
  }

  const posted = async (e: EditorPage) => (await e.posted()).filter((m) => (m.type as string) !== 'ready').map((m) => JSON.stringify(m));

  test('it says it is ready, and draws the boxes and arrows it is sent', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.deepEqual((await e.posted()).map((m) => m.type), ['ready']);
    assert.equal(await e.page.textContent('#map-title'), 'Codebase Map: shop');
    assert.equal(await e.count('.map-box'), 4);
    assert.equal(await e.page.getAttribute('.map-box[data-id="f:a.ts"]', 'data-kind'), 'file');
    assert.equal(await e.count('.map-box.open'), 1);
    assert.equal(await e.count('.map-box.entry'), 1, 'the entry point is marked');
    assert.equal(await e.count('.map-arrow.imports'), 2);
    assert.equal(await e.count('.map-arrow.calls.guess.back'), 1, 'a guessed arrow pointing back up');
    assert.match((await e.page.textContent('#map-status'))!, /4 boxes · 3 arrows/);
    // A closed box with something inside says how much.
    assert.equal(await e.page.textContent('.map-box[data-id="f:a.ts"] .map-count'), '1');
  });

  test('pointing at a box draws its own arrows over the dimmed map, and marks the boxes they reach', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.equal(await e.count('.map-arrow.highlight'), 0);
    await e.page.hover('.map-box[data-id="f:a.ts"] .map-name');
    // a.ts imports b.ts and the package, and b.ts calls it: three arrows, two boxes reached.
    assert.equal(await e.count('.map-arrow.highlight'), 3);
    assert.equal(await e.page.$eval('#map-arrows', (el) => el.classList.contains('focused')), true);
    assert.deepEqual(await e.page.$$eval('.map-box.linked', (els) => els.map((el) => (el as HTMLElement).dataset.id).sort()), ['externals', 'f:b.ts']);
    // The project holds both files: only its arrow out, to the package.
    await e.page.hover('.map-box[data-id="p:"] .map-name');
    assert.equal(await e.count('.map-arrow.highlight'), 1);
    // Clicked, a box stays highlighted; clicking the background lets go.
    await e.page.click('.map-box[data-id="f:b.ts"] .map-name');
    const canvas = (await e.page.locator('#map-canvas').boundingBox())!;
    await e.page.mouse.move(canvas.x + canvas.width - 20, canvas.y + canvas.height - 20);
    assert.equal(await e.count('.map-box.active'), 1);
    await e.page.mouse.click(canvas.x + canvas.width - 20, canvas.y + canvas.height - 20);
    assert.equal(await e.count('.map-box.active'), 0);
    assert.equal(await e.count('.map-arrow.highlight'), 0);
  });

  test('the view switch shows the view drawn and asks for the other', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.equal(await e.page.getAttribute('.map-mode[data-mode="architecture"]', 'aria-checked'), 'true');
    await e.page.click('.map-mode[data-mode="architecture"]');
    await e.page.click('.map-mode[data-mode="structure"]');
    assert.deepEqual(await posted(e), [JSON.stringify({ type: 'mode', mode: 'structure' })], 'only a change of view is asked for');
    const structure: LaidScene = {
      mode: 'structure', width: 300, height: 200,
      boxes: [
        { id: 's:a.ts#Shape', label: 'Shape', kind: 'type', detail: 'class', count: 0, expandable: false, expanded: false, x: 0, y: 0, width: 160, height: 84, members: ['area()', 'name'] },
        { id: 's:a.ts#Circle', label: 'Circle', kind: 'type', detail: 'class', count: 0, expandable: false, expanded: false, x: 0, y: 130, width: 160, height: 48 }
      ],
      arrows: [{ id: 'inherits:s:a.ts#Circle>s:a.ts#Shape', from: 's:a.ts#Circle', to: 's:a.ts#Shape', kind: 'inherits', weight: 1, certain: true, points: [{ x: 80, y: 130 }, { x: 80, y: 84 }] }],
      details: []
    };
    await e.send({ type: 'scene', scene: structure } as never);
    assert.equal(await e.page.getAttribute('.map-mode[data-mode="structure"]', 'aria-checked'), 'true');
    assert.deepEqual(await e.page.$$eval('.map-box[data-id="s:a.ts#Shape"] .map-members li', (els) => els.map((el) => el.textContent)), ['area()', 'name']);
    assert.equal(await e.count('.map-arrow.inherits'), 1);
  });

  test('the call flow: its bar shows where it starts and which way; boxes start their own', async (t) => {
    const e = await open(t);
    if (!e) return;
    assert.equal(await e.page.isVisible('#map-calls'), false, 'no call bar in the architecture');
    // Any function, type, graph or file box can start a call flow.
    await e.page.hover('.map-box[data-id="f:a.ts"]');
    await e.page.click('.map-box[data-id="f:a.ts"] .map-calls');
    assert.equal(await e.count('.map-box[data-id="externals"] .map-calls'), 0, "a package has no calls of its own");
    const flow: LaidScene = {
      mode: 'calls', calls: { direction: 'callees', root: 's:a.ts#main', rootLabel: 'main', starts: 1 }, width: 300, height: 260,
      boxes: [
        { id: 's:a.ts#main', label: 'main', kind: 'function', detail: 'a.ts', count: 0, expandable: false, expanded: false, root: true, x: 0, y: 0, width: 140, height: 48 },
        { id: 's:a.ts#run', label: 'run', kind: 'function', detail: 'a.ts', count: 2, expandable: true, expanded: false, cycle: true, x: 0, y: 100, width: 140, height: 48 },
        { id: 'unresolved:s:a.ts#main>emit', label: 'emit?', kind: 'unresolved', detail: 'one of 8', count: 0, expandable: false, expanded: false, x: 160, y: 100, width: 120, height: 48 }
      ],
      arrows: [{ id: 'calls:s:a.ts#main>s:a.ts#run', from: 's:a.ts#main', to: 's:a.ts#run', kind: 'calls', weight: 1, certain: true, points: [{ x: 70, y: 48 }, { x: 70, y: 100 }] }],
      details: []
    };
    await e.send({ type: 'scene', scene: flow } as never);
    assert.equal(await e.page.isVisible('#map-calls'), true);
    assert.equal(await e.page.textContent('#map-root-label'), 'From main');
    assert.equal(await e.count('.map-box.root'), 1);
    assert.equal(await e.count('.map-box[data-id="s:a.ts#main"] .map-calls'), 0, 'the start has no button to start from itself');
    assert.equal(await e.page.getAttribute('.map-mode[data-mode="calls"]', 'aria-checked'), 'true');
    await e.page.click('.map-direction[data-direction="callers"]');
    await e.page.click('#map-root-clear');
    await e.page.dblclick('.map-box[data-id="s:a.ts#run"] .map-name');
    assert.deepEqual(await posted(e), [
      JSON.stringify({ type: 'calls', id: 'f:a.ts' }), JSON.stringify({ type: 'direction', direction: 'callers' }), JSON.stringify({ type: 'calls' }), JSON.stringify({ type: 'toggle', id: 's:a.ts#run' })
    ]);
    // From the entry points, the bar says how many.
    await e.send({ type: 'scene', scene: { ...flow, calls: { direction: 'callers', starts: 12 } } } as never);
    assert.equal(await e.page.textContent('#map-root-label'), 'From the entry points (12)');
    assert.equal(await e.page.isVisible('#map-root-clear'), false);
  });

  test("a flowchart: its boxes' code and calls, labelled arrows, Back and Forward, and the code at a box's line", async (t) => {
    const e = await open(t);
    if (!e) return;
    const flow: LaidScene = {
      mode: 'flow', flow: { id: 's:a.ts#total', label: 'total', path: 'a.ts', line: 1, back: true, forward: false }, width: 400, height: 300,
      boxes: [
        { id: 'n:n0', label: 'total', kind: 'flow', flowKind: 'start', detail: 'a.ts:1', count: 0, expandable: false, expanded: false, path: 'a.ts', line: 1, x: 0, y: 0, width: 120, height: 44 },
        { id: 'n:n2', label: '!items', kind: 'flow', flowKind: 'decision', detail: 'line 2', count: 0, expandable: false, expanded: false, path: 'a.ts', line: 2, x: 0, y: 80, width: 140, height: 44 },
        { id: 'n:n4', label: 'line 4', kind: 'flow', flowKind: 'block', count: 0, expandable: false, expanded: false, path: 'a.ts', line: 4, x: 0, y: 160, width: 200, height: 74, members: ['sum(i)'], calls: [{ label: 'sum', id: 's:a.ts#sum' }, { label: 'emit?' }] }
      ],
      arrows: [
        { id: 'flow:0', from: 'n:n0', to: 'n:n2', kind: 'flow', weight: 1, certain: true, points: [{ x: 60, y: 44 }, { x: 60, y: 80 }] },
        { id: 'flow:1', from: 'n:n2', to: 'n:n4', kind: 'flow', weight: 1, certain: true, label: 'false', points: [{ x: 60, y: 124 }, { x: 60, y: 160 }] }
      ],
      details: []
    };
    await e.send({ type: 'scene', scene: flow } as never);
    assert.equal(await e.page.isVisible('#map-flow'), true);
    assert.equal(await e.page.textContent('#map-flow-label'), 'Control flow of total');
    assert.equal(await e.page.isDisabled('#map-flow-back'), false);
    assert.equal(await e.page.isDisabled('#map-flow-forward'), true);
    assert.equal(await e.count('.map-box.flow-decision'), 1);
    assert.deepEqual(await e.page.$$eval('.map-box[data-id="n:n4"] .flow-code li', (els) => els.map((el) => el.textContent)), ['sum(i)']);
    assert.deepEqual(await e.page.$$eval('.map-arrow-label', (els) => els.map((el) => el.textContent)), ['false']);
    // A call with a callee opens its flowchart; one the index couldn't resolve doesn't.
    assert.equal(await e.count('.map-box[data-id="n:n4"] button.flow-call'), 1);
    assert.equal(await e.count('.map-box[data-id="n:n4"] span.flow-call'), 1);
    await e.page.click('.map-box[data-id="n:n4"] button.flow-call');
    await e.page.click('#map-flow-back');
    await e.page.dblclick('.map-box[data-id="n:n2"] .map-name');
    assert.deepEqual(await posted(e), [
      JSON.stringify({ type: 'flow', id: 's:a.ts#sum' }), JSON.stringify({ type: 'history', direction: 'back' }), JSON.stringify({ type: 'openLine', line: 2 })
    ]);
  });

  test('a function box opens its control flow', async (t) => {
    const e = await open(t);
    if (!e) return;
    const fnScene: LaidScene = { ...SCENE, boxes: [...SCENE.boxes, { id: 's:b.ts#g', parent: 'p:', label: 'g', kind: 'function', count: 0, expandable: false, expanded: false, x: 200, y: 150, width: 120, height: 48, path: 'b.ts', line: 3 }] };
    await e.send({ type: 'scene', scene: fnScene } as never);
    assert.equal(await e.count('.map-box[data-id="f:a.ts"] .map-flow-open'), 0, 'a file has no flowchart');
    await e.page.hover('.map-box[data-id="s:b.ts#g"]');
    await e.page.click('.map-box[data-id="s:b.ts#g"] .map-flow-open');
    assert.deepEqual(await posted(e), [JSON.stringify({ type: 'flow', id: 's:b.ts#g' })]);
  });

  test('import cycles are marked on their boxes and arrows', async (t) => {
    const e = await open(t);
    if (!e) return;
    const cyclic: LaidScene = {
      ...SCENE,
      boxes: SCENE.boxes.map((b) => (b.id === 'f:a.ts' || b.id === 'f:b.ts' ? { ...b, cycle: true } : b)),
      arrows: SCENE.arrows.map((a) => (a.from.startsWith('f:') && a.to.startsWith('f:') ? { ...a, cycle: true } : a))
    };
    await e.send({ type: 'scene', scene: cyclic } as never);
    assert.equal(await e.count('.map-box.cycle'), 2);
    assert.equal(await e.count('.map-arrow.cycle'), 2);
    assert.match((await e.page.getAttribute('.map-box[data-id="f:a.ts"]', 'title'))!, /import cycle/);
  });

  test('double-clicking a box opens or closes it; one with nothing inside opens its code', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.dblclick('.map-box[data-id="f:a.ts"] .map-name');
    await e.page.dblclick('.map-box[data-id="f:b.ts"] .map-name');
    await e.page.click('.map-box[data-id="externals"] .map-toggle');
    assert.deepEqual(await posted(e), [
      JSON.stringify({ type: 'toggle', id: 'f:a.ts' }), JSON.stringify({ type: 'open', id: 'f:b.ts' }), JSON.stringify({ type: 'toggle', id: 'externals' })
    ]);
  });

  test("a box's open button shows its code", async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.hover('.map-box[data-id="f:a.ts"]');
    await e.page.click('.map-box[data-id="f:a.ts"] .map-open');
    assert.deepEqual(await posted(e), [JSON.stringify({ type: 'open', id: 'f:a.ts' })]);
  });

  test('the wheel zooms around the pointer; dragging pans; zoomed out, boxes show less', async (t) => {
    const e = await open(t);
    if (!e) return;
    const transform = () => e.page.$eval('#map-world', (el) => (el as HTMLElement).style.transform);
    const before = await transform();
    const box = (await e.page.locator('#map-canvas').boundingBox())!;
    await e.page.mouse.move(box.x + 300, box.y + 200);
    for (let i = 0; i < 12; i++) await e.page.mouse.wheel(0, 300);
    const zoomed = await transform();
    assert.notEqual(zoomed, before);
    assert.equal(await e.page.$eval('#map-canvas', (el) => el.classList.contains('far')), true, 'zoomed out: less detail');
    assert.equal(await e.page.isVisible('.map-box[data-id="f:a.ts"] .map-detail'), false);
    await e.drag({ x: box.x + 600, y: box.y + 400 }, { x: box.x + 650, y: box.y + 430 });
    assert.notEqual(await transform(), zoomed, 'dragging the background pans');
    await e.page.click('#map-fit');
    assert.equal(await e.page.$eval('#map-canvas', (el) => el.classList.contains('far')), false, 'Fit shows the whole map, near enough to read');
  });

  test('a new scene keeps the view where it is', async (t) => {
    const e = await open(t);
    if (!e) return;
    const box = (await e.page.locator('#map-canvas').boundingBox())!;
    await e.drag({ x: box.x + 600, y: box.y + 400 }, { x: box.x + 700, y: box.y + 450 });
    const panned = await e.page.$eval('#map-world', (el) => (el as HTMLElement).style.transform);
    await e.send({ type: 'scene', scene: { ...SCENE, boxes: SCENE.boxes.slice(0, 3) } } as never);
    assert.equal(await e.count('.map-box'), 3);
    assert.equal(await e.page.$eval('#map-world', (el) => (el as HTMLElement).style.transform), panned);
  });

  test('Find: Ctrl+F, what the index has, picked with the keys or the mouse', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.page.click('#map-canvas', { position: { x: 600, y: 300 } });
    await e.page.keyboard.press('Control+f');
    assert.equal(await e.page.evaluate(() => document.activeElement?.id), 'map-find');
    await e.page.keyboard.type('sc');
    await e.page.waitForFunction(() => (window as unknown as { __posted: { type: string }[] }).__posted.some((m) => m.type === 'find'));
    assert.deepEqual(await posted(e), [JSON.stringify({ type: 'find', query: 'sc' })]);
    // An answer to an older query is ignored.
    await e.send({ type: 'found', query: 's', results: [{ id: 'f:s.ts', label: 's.ts', kind: 'file', where: 's.ts' }] } as never);
    assert.equal(await e.page.isVisible('#map-found'), false);
    await e.send({
      type: 'found', query: 'sc', results: [
        { id: 's:a.ts#Score', label: 'Score', kind: 'type', where: 'a.ts:3' },
        { id: 'f:score.ts', label: 'score.ts', kind: 'file', where: 'score.ts' }
      ]
    } as never);
    assert.equal(await e.page.isVisible('#map-found'), true);
    assert.equal(await e.count('.map-found-item'), 2);
    assert.match((await e.page.textContent('.map-found-item.active'))!, /Score.*type.*a\.ts:3/);
    await e.page.keyboard.press('ArrowDown');
    assert.equal(await e.page.getAttribute('.map-found-item.active', 'data-id'), 'f:score.ts');
    await e.page.keyboard.press('Enter');
    assert.equal(await e.page.isVisible('#map-found'), false);
    // Or with the mouse, after looking again.
    await e.page.click('#map-find');
    await e.page.click('.map-found-item[data-id="s:a.ts#Score"]');
    assert.deepEqual((await posted(e)).slice(1), [JSON.stringify({ type: 'reveal', id: 'f:score.ts' }), JSON.stringify({ type: 'reveal', id: 's:a.ts#Score' })]);
    // Nothing found says so.
    await e.page.fill('#map-find', 'zz');
    await e.send({ type: 'found', query: 'zz', results: [] } as never);
    assert.equal(await e.page.textContent('#map-found'), 'Nothing found');
  });

  test('a scene with a focus centres and selects that box', async (t) => {
    const e = await open(t);
    if (!e) return;
    await e.send({ type: 'scene', scene: SCENE, focus: 'f:b.ts' } as never);
    assert.equal(await e.count('.map-box.active[data-id="f:b.ts"]'), 1, 'selected');
    const canvas = (await e.page.locator('#map-canvas').boundingBox())!;
    const box = (await e.page.locator('.map-box[data-id="f:b.ts"]').boundingBox())!;
    assert.ok(Math.abs(box.x + box.width / 2 - (canvas.x + canvas.width / 2)) < 2, 'centred across');
    assert.ok(Math.abs(box.y + box.height / 2 - (canvas.y + canvas.height / 2)) < 2, 'centred down');
    assert.ok(box.width >= 149, 'readable');
  });

  test('Filter: languages, projects, packages and tests to hide; the button says how many are', async (t) => {
    const e = await open(t);
    if (!e) return;
    const options = { languages: ['python', 'typescript'], projects: [{ id: 'p:app', label: 'app' }, { id: 'p:tools', label: 'tools' }] };
    await e.send({ type: 'scene', scene: { ...SCENE, options } } as never);
    assert.equal(await e.page.isVisible('#map-filters'), false);
    await e.page.click('#map-filter');
    assert.equal(await e.page.getAttribute('#map-filter', 'aria-expanded'), 'true');
    assert.deepEqual(await e.page.$$eval('#map-filters legend', (els) => els.map((el) => el.textContent)), ['Languages', 'Projects', 'Show']);
    assert.equal(await e.count('#map-filters input:checked'), 6, 'everything shown');
    await e.page.uncheck('#map-filters input[data-key="language:python"]');
    await e.page.uncheck('#map-filters input[data-key="tests"]');
    assert.deepEqual((await posted(e)).slice(-1), [JSON.stringify({ type: 'filters', filters: { languages: ['python'], tests: false } })]);
    await e.send({ type: 'scene', scene: { ...SCENE, options, filters: { languages: ['python'], tests: false } } } as never);
    assert.equal(await e.page.textContent('#map-filter'), 'Filter (2)');
    // Clicking elsewhere closes it; opened again, it shows what's hidden.
    await e.page.click('#map-canvas', { position: { x: 600, y: 300 } });
    assert.equal(await e.page.isVisible('#map-filters'), false);
    await e.page.click('#map-filter');
    assert.equal(await e.page.isChecked('#map-filters input[data-key="language:python"]'), false);
    assert.equal(await e.page.isChecked('#map-filters input[data-key="externals"]'), true);
    await e.page.keyboard.press('Escape');
    assert.equal(await e.page.isVisible('#map-filters'), false);
  });
});
