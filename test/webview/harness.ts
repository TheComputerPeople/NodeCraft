// Loads the real webview markup and bundle in a Chromium-based browser, with a stand-in for the
// VS Code webview API that records what the editor posts to the host.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Browser, Page, chromium } from 'playwright-core';
import { Graph, GraphDocument, HostMessage, UIMessage } from '../../src/core/model';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { parseDocument, primaryGraph } from '../../src/core/serializer';
import { renderMapHtml } from '../../src/extension/map-html';
import { renderEditorHtml } from '../../src/extension/webview-html';

const repoRoot = path.resolve(__dirname, '../../..');
const bundleDir = path.join(repoRoot, 'dist/webview');

// Returns a browser, or the reason none could be started (tests are then skipped).
export async function launchBrowser(): Promise<Browser | string> {
  if (!fs.existsSync(path.join(bundleDir, 'editor.js'))) return 'dist/webview/editor.js is missing; run `npm run compile:webview`';
  const executablePath = process.env.BLUEPRINT_TEST_BROWSER;
  if (executablePath) return chromium.launch({ executablePath });
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // Try the next installed browser.
    }
  }
  return 'No Edge or Chrome found; install one or set BLUEPRINT_TEST_BROWSER to a Chromium executable';
}

// The webview's markup, written again whenever it changes. Test files run in parallel and write the
// same text, each through a rename, so none reads a half-written page.
// The graph editor's page, or the Codebase Map's.
function harnessUrl(which: 'editor' | 'map' = 'editor'): string {
  const file = path.join(__dirname, `${which}.html`);
  const asset = (name: string): string => pathToFileURL(path.join(bundleDir, name)).href;
  const options = { cspSource: 'file:', nonce: 'test-nonce', scriptUri: asset(`${which}.js`), styleUri: asset(`${which}.css`) };
  const html = which === 'map' ? renderMapHtml(options) : renderEditorHtml(options);
  const current = (): string | undefined => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
  if (current() !== html) {
    const temp = `${file}.${process.pid}`;
    fs.writeFileSync(temp, html);
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      // Another test file replaced it at the same moment (Windows refuses the second rename).
      fs.rmSync(temp, { force: true });
      if (current() !== html) throw error;
    }
  }
  return pathToFileURL(file).href;
}

export function sampleDocument(): GraphDocument {
  return parseDocument(fs.readFileSync(path.join(repoRoot, 'sample/demo.vgraph'), 'utf8')).document;
}

export function sampleDefinitions() {
  const registry = new NodeRegistry();
  const double = parseNodeDefinition(fs.readFileSync(path.join(repoRoot, 'sample/visual-nodes/Math/Double.node.json'), 'utf8'));
  if (double) registry.register(double);
  return registry.all();
}

export interface Point {
  x: number;
  y: number;
}

export class EditorPage {
  readonly errors: string[] = [];

  private constructor(readonly page: Page) {
    page.on('pageerror', (error) => this.errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') this.errors.push(message.text());
    });
  }

  static async open(browser: Browser, which: 'editor' | 'map' = 'editor'): Promise<EditorPage> {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const editor = new EditorPage(page);
    // The webview's state (getState and setState) lasts across a reload, as VS Code keeps it.
    await page.addInitScript(() => {
      const w = window as unknown as { __posted: unknown[]; acquireVsCodeApi: () => unknown };
      w.__posted = [];
      w.acquireVsCodeApi = () => ({
        postMessage: (m: unknown) => w.__posted.push(JSON.parse(JSON.stringify(m))),
        getState: () => JSON.parse(sessionStorage.getItem('vscodeState') ?? 'null') as unknown,
        setState: (state: unknown) => sessionStorage.setItem('vscodeState', JSON.stringify(state))
      });
    });
    await page.goto(harnessUrl(which));
    return editor;
  }

  // Opens the sample graph the way the host does, with saves sent immediately.
  static async withSample(browser: Browser): Promise<EditorPage> {
    const editor = await EditorPage.open(browser);
    await editor.send({ type: 'init', document: sampleDocument(), definitions: sampleDefinitions(), saveDelay: 0 });
    return editor;
  }

  // Delivers a host message synchronously, as VS Code's postMessage would (eventually) do.
  async send(message: HostMessage): Promise<void> {
    await this.page.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), message);
  }

  posted(): Promise<UIMessage[]> {
    return this.page.evaluate(() => (window as unknown as { __posted: UIMessage[] }).__posted);
  }

  // The event graph from the most recent save, waiting for one to arrive.
  async lastSavedGraph(): Promise<Graph> {
    await this.page.waitForFunction(() => (window as unknown as { __posted: UIMessage[] }).__posted.some((m) => m.type === 'applyDocument'));
    const saves = (await this.posted()).filter((m) => m.type === 'applyDocument');
    return primaryGraph(saves[saves.length - 1].document!);
  }

  async pinCenter(nodeId: string, pinId: string): Promise<Point> {
    return this.center(`.pin[data-node="${nodeId}"][data-pin="${pinId}"]`);
  }

  async center(selector: string): Promise<Point> {
    const box = await this.page.locator(selector).boundingBox();
    if (!box) throw new Error(`No visible element for ${selector}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  // Screen position of a point along a wire (the middle by default).
  async wireMidpoint(connectionId: string, fraction = 0.5): Promise<Point> {
    return this.page.evaluate(([id, f]) => {
      const path = document.querySelector<SVGPathElement>(`.edge-hit[data-connection-id="${id}"]`);
      if (!path) throw new Error(`No wire ${id}`);
      const p = path.getPointAtLength(path.getTotalLength() * f).matrixTransform(path.getScreenCTM()!);
      return { x: p.x, y: p.y };
    }, [connectionId, fraction] as const);
  }

  async drag(from: Point, to: Point): Promise<void> {
    const mouse = this.page.mouse;
    await mouse.move(from.x, from.y);
    await mouse.down();
    await mouse.move(to.x, to.y, { steps: 8 });
    await mouse.up();
  }

  count(selector: string): Promise<number> {
    return this.page.locator(selector).count();
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}
