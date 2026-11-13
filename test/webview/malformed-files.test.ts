// Graph files broken by hand or by a bad merge (docs/audit.md, step 3): mutated fixture graphs that
// parseDocument accepts open in the editor without a page error. (Those it rejects never reach the
// editor: the host opens them read-only with parseDocument's error.)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Browser } from 'playwright-core';
import { GraphDocument } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { EditorPage, launchBrowser } from './harness';

const repoRoot = path.resolve(__dirname, '../../..');

// The same mutations as the compile fuzzer (test/unit/document-check.test.ts), plus HTML in text.
function mutatedFiles(seed: number, count: number): { file: string; document: GraphDocument }[] {
  const dir = path.join(repoRoot, 'test/fixtures/graphs');
  const seeds = fs.readdirSync(dir).filter((f) => f.endsWith('.vgraph')).map((f) => ({ file: f, json: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as unknown }));
  const REPLACEMENTS = [null, 0, -1, 1.5, '', 'x', '__proto__', {}, [], true, 'string', 'int', 'exec', 99999999999, 'object:Nope', '<img src=x onerror=alert(1)>'];
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  const paths = (value: unknown, at: string[] = [], into: string[][] = []): string[][] => {
    into.push(at);
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) paths(v, [...at, k], into);
    return into;
  };
  const files: { file: string; document: GraphDocument }[] = [];
  while (files.length < count) {
    const s = pick(seeds);
    const copy = structuredClone(s.json);
    const all = paths(copy).filter((p) => p.length);
    for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n; i++) {
      const at = pick(all);
      let parent: any = copy;
      for (const k of at.slice(0, -1)) parent = parent?.[k];
      if (!parent || typeof parent !== 'object') continue;
      const key = at[at.length - 1];
      const r = rand();
      if (r < 0.2 && !Array.isArray(parent)) delete parent[key];
      else if (r < 0.3 && Array.isArray(parent)) parent.push(structuredClone(parent[Number(key)]));
      else parent[key] = structuredClone(pick(REPLACEMENTS));
    }
    try {
      files.push({ file: s.file, document: parseDocument(JSON.stringify(copy), 'Fuzz').document });
    } catch {
      // Rejected with a readable error (checked by the unit test).
    }
  }
  return files;
}

describe('malformed graph files', () => {
  let browser: Browser | undefined;
  let skipReason = '';

  before(async () => {
    const result = await launchBrowser();
    if (typeof result === 'string') skipReason = result;
    else browser = result;
  });
  after(async () => {
    await browser?.close();
  });

  test('open in the editor without a page error', async (t) => {
    if (!browser) return t.skip(skipReason);
    const definitions = new NodeRegistry().all();
    const errors: string[] = [];
    for (const { file, document } of mutatedFiles(2024, 120)) {
      const editor = await EditorPage.open(browser);
      await editor.send({ type: 'init', document, definitions, saveDelay: 0 });
      await editor.page.waitForTimeout(20);
      for (const error of editor.errors) errors.push(`${file}: ${error}\n${JSON.stringify(document)}`);
      await editor.close();
    }
    assert.deepEqual(errors, []);
  });
});
