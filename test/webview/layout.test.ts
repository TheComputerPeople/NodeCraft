// The editor's layout at different window sizes (docs/roadmap.md, Phase 5's narrow-editor issue):
// toolbar buttons never wrap, the side panels narrow and collapse to strips, and the canvas keeps
// its room.
import { after, afterEach, before, describe, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'playwright-core';
import { EditorPage, launchBrowser } from './harness';

describe('layout', () => {
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

  async function open(t: TestContext, width: number, height: number): Promise<EditorPage | undefined> {
    if (!browser) {
      t.skip(skipReason);
      return undefined;
    }
    editor = await EditorPage.withSample(browser);
    await editor.page.setViewportSize({ width, height });
    return editor;
  }

  const collapsed = (e: EditorPage, panel: 'left' | 'details') => e.page.evaluate((p) => document.getElementById('app')!.classList.contains(`${p}-collapsed`), panel);
  const width = async (e: EditorPage, selector: string) => (await e.page.locator(selector).boundingBox())?.width ?? 0;

  // Every toolbar button on one line, in one row, inside the bar; the bar scrolls only if needed.
  async function assertToolbarFits(e: EditorPage): Promise<void> {
    const boxes = await e.page.$$eval('#toolbar button:not([hidden])', (els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.id, top: Math.round(r.top), height: Math.round(r.height) };
    }));
    const heights = new Set(boxes.map((b) => b.height));
    assert.equal(heights.size, 1, `a button wrapped: ${JSON.stringify(boxes)}`);
    assert.equal(new Set(boxes.map((b) => b.top)).size, 1, 'the buttons are in one row');
    const bar = (await e.page.locator('#toolbar').boundingBox())!;
    for (const id of ['#graph-name', '#status']) {
      const box = await e.page.locator(id).boundingBox();
      if (box && box.width > 0) assert.ok(box.x + box.width <= bar.x + bar.width + 1, `${id} stays inside the toolbar`);
    }
  }

  test('at the size of a docked editor, everything fits and both panels are open', async (t) => {
    const e = await open(t, 1088, 592);
    if (!e) return;
    await assertToolbarFits(e);
    assert.equal(await e.page.evaluate(() => { const bar = document.getElementById('toolbar')!; return bar.scrollWidth <= bar.clientWidth; }), true, 'nothing needs scrolling');
    assert.equal(await collapsed(e, 'left'), false);
    assert.equal(await collapsed(e, 'details'), false);
    assert.ok(await width(e, '#canvas-wrap') >= 520);
    const help = await e.page.$eval('#help', (el) => getComputedStyle(el).textOverflow);
    assert.equal(help, 'ellipsis');
  });

  test('in a narrow editor, Details collapses to a strip that opens it again', async (t) => {
    const e = await open(t, 700, 600);
    if (!e) return;
    await assertToolbarFits(e);
    assert.equal(await collapsed(e, 'details'), true);
    assert.equal(await collapsed(e, 'left'), false);
    assert.equal(await e.page.isVisible('#inspector-content'), false);
    assert.ok(await width(e, '#canvas-wrap') >= 400, 'the canvas keeps its room');

    await e.page.click('#inspector .panel-strip');
    assert.equal(await collapsed(e, 'details'), false, 'the user opened it');
    assert.equal(await e.page.isVisible('#inspector-content'), true);
    await e.page.setViewportSize({ width: 680, height: 600 });
    assert.equal(await collapsed(e, 'details'), false, "the user's choice outlasts a resize");
    await e.page.click('#inspector .panel-toggle');
    assert.equal(await collapsed(e, 'details'), true);
  });

  test('in a very narrow editor, both panels collapse', async (t) => {
    const e = await open(t, 480, 600);
    if (!e) return;
    assert.equal(await collapsed(e, 'left'), true);
    assert.equal(await collapsed(e, 'details'), true);
    assert.ok(await width(e, '#canvas-wrap') >= 400);
    assert.equal(await e.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the page itself never scrolls sideways');
  });

  test('a wide editor\'s panels hide and show with their buttons', async (t) => {
    const e = await open(t, 1600, 900);
    if (!e) return;
    const before = await width(e, '#canvas-wrap');
    await e.page.click('#my-blueprint .panel-toggle');
    assert.equal(await collapsed(e, 'left'), true);
    assert.ok(await width(e, '#canvas-wrap') > before + 150, 'the canvas takes the room');
    await e.page.click('#left .panel-strip');
    assert.equal(await collapsed(e, 'left'), false);
    assert.equal(await e.page.isVisible('#palette'), true);
  });
});
