// The cross-language example (examples/multi-language, docs/multi-language.md, gap 4): a TypeScript
// graph calls the Python pricing service through a project function. Its generated file is what the
// compiler writes today, and running it prints the order's total.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { scanTypeScript } from '../../src/core/importing/typescript-scanner';
import { builtinLanguagePacks } from '../../src/core/languages';
import { NodeRegistry } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { repoRoot } from '../unit/helpers';

const example = path.join(repoRoot, 'examples/multi-language');
const read = (file: string) => fs.readFileSync(path.join(example, file), 'utf8').replace(/\r\n/g, '\n');

describe('the cross-language example', () => {
  test('its graph compiles to the generated file next to it', () => {
    const registry = new NodeRegistry();
    registry.registerMany(exposeFunctions(scanTypeScript(read('web/pricing.ts')), { language: 'typescript', path: 'web/pricing.ts', exposeAll: false }).definitions);
    const doc = parseDocument(read('web/Checkout.vgraph')).document;
    const result = compileDocument(doc, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Checkout.vgraph', outputDir: 'web', importExtension: 'ts', moduleFormat: 'esm' } });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.output!.text, read('web/Checkout.vgraph.ts'));
  });

  test('running it asks Python for the prices', (t) => {
    const python = process.platform === 'win32' ? ['py', '-3'] : ['python3'];
    if (spawnSync(python[0], [...python.slice(1), '--version']).status !== 0) return t.skip('Python 3 was not found');
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', "const { Checkout } = await import('./Checkout.vgraph.ts'); new Checkout().start();"], { cwd: path.join(example, 'web'), encoding: 'utf8' });
    assert.equal(output.trim(), '4.5');
  });
});
