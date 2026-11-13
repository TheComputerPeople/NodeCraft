// The Tour (docs/release.md, step 4): New Project's other first graph, in Simulate. The conformance
// suite (new-project.test.ts) builds, checks and runs it in each language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { checkDocumentContents } from '../../src/core/document-check';
import { LanguagePackRegistry } from '../../src/core/language-pack';
import { builtinLanguagePacks } from '../../src/core/languages';
import { NodeRegistry } from '../../src/core/registry';
import { GraphRuntime } from '../../src/core/runtime';
import { compileDocument } from '../../src/core/compiler';
import { newProjectFiles } from '../../src/extension/new-project';
import { graphFileNodes } from '../../src/extension/placement';
import { TOUR_OUTPUT, TOUR_TEST, tourGraph, tourSummary } from '../../src/extension/tour';
import { logs } from './helpers';

const languages = new LanguagePackRegistry(builtinLanguagePacks().all());
const root = path.resolve('tour-project');

function registryFor(language: string): NodeRegistry {
  const registry = new NodeRegistry();
  registry.registerMany(graphFileNodes(tourSummary(language), path.join(root, 'Summary.vgraph'), root, languages) ?? []);
  return registry;
}

test('the Tour is a valid graph file, and so is its structure', () => {
  checkDocumentContents(tourGraph('typescript'));
  checkDocumentContents(tourSummary('typescript'));
});

test('Simulate: Start prints the Tour\'s lines', () => {
  const events: Parameters<typeof logs>[0] = [];
  new GraphRuntime(registryFor('javascript'), (e) => events.push(e)).run(tourGraph('javascript'));
  assert.deepEqual(events.filter((e) => e.kind === 'error'), []);
  assert.deepEqual(logs(events), TOUR_OUTPUT);
});

test('Simulate Tests: its Test Case passes', () => {
  const results = new GraphRuntime(registryFor('javascript'), () => {}).runTests(tourGraph('javascript'));
  assert.deepEqual(results.map((r) => [r.name, r.passed, r.message]), [[TOUR_TEST, true, undefined]]);
});

for (const language of builtinLanguagePacks().all().map((p) => p.id)) {
  test(`${language}: the Tour and its structure compile without problems`, () => {
    const registry = registryFor(language);
    for (const [doc, file] of [[tourGraph(language), 'Main.vgraph'], [tourSummary(language), 'Summary.vgraph']] as const) {
      const result = compileDocument(doc, { registry, languages, generate: { sourceFileName: file } });
      assert.deepEqual(result.diagnostics, [], `${file}: ${result.diagnostics.map((d) => d.message).join('; ')}`);
      assert.ok(result.output, file);
    }
  });
}

test('New Project writes the Tour and its structure when asked, and Hello otherwise', () => {
  const tour = newProjectFiles('typescript', 'Sample', { start: 'tour' });
  assert.deepEqual(tour.graphs, ['src/Main.vgraph', 'src/Summary.vgraph']);
  assert.match(tour.files['README.md'], /is the Tour/);
  const hello = newProjectFiles('typescript', 'Sample');
  assert.deepEqual(hello.graphs, ['src/Main.vgraph']);
  assert.match(hello.files['src/Main.vgraph'], /Hello from Blueprint/);
});
