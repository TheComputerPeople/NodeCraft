// The Codebase Map's webview (src/map/map.ts): it draws the laid-out scene it's sent, opens and
// closes boxes and opens code through the extension, pans and zooms, and shows less when zoomed out.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { LaidScene } from '../../src/core/codemap/scene';
import { EditorPage, launchBrowser } from './harness';

// A project open on two files: a.ts (closed, with a class inside) importing b.ts, and an external package.
const SCENE: LaidScene = {
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
});
