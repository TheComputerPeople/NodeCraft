// Snippet nodes written by hand (src/core/node-files.ts, docs/node-authoring.md gap 8): New Node's
// starting point, and the problems a node file shows while it's edited.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { SnippetLanguage, newNodeDefinition, nodeFileProblems } from '../../src/core/node-files';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { readRepoFile } from './helpers';

const packs = builtinLanguagePacks();
const language = (id: string): SnippetLanguage => {
  const pack = packs.get(id)!;
  return { id, displayName: pack.displayName, snippetLanguages: pack.generator!.snippetLanguages, ...(pack.generator!.snippets ? { snippets: pack.generator!.snippets } : {}) };
};
const node = (languages: Record<string, string>): NodeDefinition => ({
  type: 'user.math.scale', version: 1, displayName: 'Scale', category: 'Math',
  inputs: [{ id: 'execIn', name: '', kind: 'exec', direction: 'input' }, { id: 'value', name: 'Value', kind: 'data', direction: 'input', type: { id: 'float' } }],
  outputs: [{ id: 'execOut', name: '', kind: 'exec', direction: 'output' }, { id: 'result', name: 'Result', kind: 'data', direction: 'output', type: { id: 'float' } }],
  implementation: { kind: 'code', languages }
});

describe('node file problems', () => {
  test('a placeholder with no such input', () => {
    assert.deepEqual(nodeFileProblems(node({ typescript: 'return ${value} * ${factor};', python: 'return ${value}' }), []), [
      { severity: 'warning', message: 'The typescript snippet uses ${factor}, but "Scale" has no data input "factor".', at: '${factor}' }
    ]);
  });

  test("a language the workspace's graphs use with no snippet for it; a TypeScript graph also takes a javascript one", () => {
    const problems = nodeFileProblems(node({ javascript: 'return ${value};' }), [language('typescript'), language('python')]);
    assert.deepEqual(problems.map((p) => [p.severity, p.message]), [
      ['information', 'No Python snippet: Python graphs in this workspace can\'t use "Scale". Add a "python" entry to its languages.']
    ]);
  });

  test('nodes that are not snippets have nothing to check', () => {
    assert.deepEqual(nodeFileProblems({ ...node({}), implementation: { kind: 'native', operation: 'x' } }, [language('python')]), []);
  });
});

describe('New Node', () => {
  test('an input, an output and a snippet for each language the graphs use, valid against the schema', () => {
    const def = newNodeDefinition('Clamp Health', 'Combat|Health', [language('typescript'), language('python'), language('csharp')]);
    assert.equal(def.type, 'user.combat.health.clamp-health');
    assert.deepEqual(def.implementation, { kind: 'code', languages: { typescript: 'return ${value};', python: 'return ${value}', csharp: 'return ${value};' } });
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(JSON.parse(readRepoFile('schemas/node.schema.json')));
    assert.ok(validate(JSON.parse(JSON.stringify(def))), ajv.errorsText(validate.errors));
    assert.ok(parseNodeDefinition(JSON.stringify(def)), 'the registry reads it');
    assert.deepEqual(nodeFileProblems(def, [language('typescript'), language('python'), language('csharp')]), []);
  });

  test('a graph using it compiles', () => {
    const def = newNodeDefinition('Pass', 'My Nodes', [language('typescript')]);
    const registry = new NodeRegistry();
    registry.register(def);
    const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
    const document: GraphDocument = {
      schemaVersion: 3, name: 'Uses', kind: 'class', language: 'typescript', variables: [],
      graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [n('s', 'core:event.start'), n('p', def.type, { 'pin:value': 2 })], connections: [{ id: 'c', fromNode: 's', fromPin: 'execOut', toNode: 'p', toPin: 'execIn' }] }]
    };
    const result = compileDocument(document, { registry, languages: packs, generate: { sourceFileName: 'uses.vgraph' } });
    assert.deepEqual(result.diagnostics, []);
  });

  test('with no graphs yet, the snippet is TypeScript', () => {
    assert.deepEqual(newNodeDefinition('Pass', 'My Nodes', []).implementation, { kind: 'code', languages: { typescript: 'return ${value};' } });
  });
});
