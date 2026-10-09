import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CompileResult, compileDocument } from '../../src/core/compiler';
import { NameScope, dedent, toIdentifier } from '../../src/core/compiler/names';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument } from '../../src/core/model';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { doc, node, readRepoFile, repoRoot, wire } from './helpers';

export function fixtureRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.register(parseNodeDefinition(readRepoFile('sample/visual-nodes/Math/Double.node.json'))!);
  return registry;
}

export function compileAs(d: GraphDocument, language: string, sourceFileName = 'graph.vgraph', moduleFormat?: 'esm' | 'commonjs'): CompileResult {
  return compileDocument({ ...d, language }, { registry: fixtureRegistry(), languages: builtinLanguagePacks(), generate: { sourceFileName, moduleFormat } });
}

// Compares generated code with a committed golden file; UPDATE_GOLDEN=1 rewrites the goldens.
function matchesGolden(text: string, goldenName: string): void {
  const file = path.join(repoRoot, 'test/fixtures/codegen', goldenName);
  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  assert.equal(text, fs.readFileSync(file, 'utf8'), `${goldenName} differs from its golden file (run with UPDATE_GOLDEN=1 to accept)`);
}

const sample = () => parseDocument(readRepoFile('sample/demo.vgraph')).document;
const features = () => parseDocument(readRepoFile('test/fixtures/graphs/features.vgraph')).document;

describe('TypeScript and JavaScript generation', () => {
  for (const [label, load] of [['demo', sample], ['features', features]] as const) {
    for (const [language, ext] of [['typescript', 'ts'], ['javascript', 'js']]) {
      test(`${label} matches its ${language} golden file`, () => {
        const result = compileAs(load(), language, `${label}.vgraph`);
        assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
        assert.equal(result.output?.fileName, `${label}.vgraph.${ext}`);
        matchesGolden(result.output!.text, `${label}.vgraph.${ext}`);
      });
    }
  }

  test('JavaScript for CommonJS projects exports with module.exports', () => {
    const text = compileAs(sample(), 'javascript', 'demo.vgraph', 'commonjs').output!.text;
    assert.match(text, /^class BlueprintDemo \{/m);
    assert.match(text, /module\.exports = \{ BlueprintDemo \};\n$/);
  });

  test('records the line where each node starts', () => {
    const output = compileAs(sample(), 'typescript', 'demo.vgraph').output!;
    const lines = output.text.split('\n');
    for (const { nodeId, line } of output.nodeLines) {
      assert.match(lines[line - 2], new RegExp(`// .+ \\(${nodeId}\\)$`), `marker above line ${line} for ${nodeId}`);
    }
    assert.deepEqual(output.nodeLines.map((l) => l.nodeId), ['add_1', 'branch_1', 'print_true', 'print_false']);
  });

  test('only includes the format helper when a value has no static type', () => {
    assert.doesNotMatch(compileAs(sample(), 'typescript').output!.text, /function formatValue/);
    assert.match(compileAs(features(), 'typescript').output!.text, /function formatValue/);
  });

  test('makes class and member names legal and unique', () => {
    const d = doc(
      [node('s', 'core:event.start'), node('set', 'core:variable.set', { 'pin:name': 'class', 'pin:value': 1 })],
      [wire('s', 'execOut', 'set', 'execIn')]
    );
    d.name = 'my cool-graph';
    const text = compileAs(d, 'typescript').output!.text;
    assert.match(text, /export class MyCoolGraph \{/);
    assert.match(text, /\n {2}class_: unknown = null;/);
    assert.match(text, /this\.class_ = 1;/);
  });

  test('reports languages without a generator', () => {
    const result = compileAs(sample(), 'cobol');
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['unknown-language']);
  });
});

describe('identifier helpers', () => {
  test('toIdentifier converts between styles', () => {
    assert.equal(toIdentifier('BlueprintDemo', 'snake'), 'blueprint_demo');
    assert.equal(toIdentifier('user.math.double', 'pascal'), 'UserMathDouble');
    assert.equal(toIdentifier('HTTPServer v2', 'snake'), 'http_server_v_2');
    assert.equal(toIdentifier('add-1', 'keep'), 'add_1');
    assert.equal(toIdentifier('1st', 'keep'), '_1st');
    assert.equal(toIdentifier('***', 'keep'), 'value');
  });

  test('NameScope avoids keywords and duplicates', () => {
    const scope = new NameScope(new Set(['class']), ['start']);
    assert.deepEqual([scope.claim('class'), scope.claim('start'), scope.claim('a b'), scope.claim('a_b')], ['class_', 'start_2', 'a_b', 'a_b_2']);
  });

  test('dedent strips shared indentation and blank edges', () => {
    assert.deepEqual(dedent('\n    if (x) {\n      y();\n    }\n'), ['if (x) {', '  y();', '}']);
  });
});
