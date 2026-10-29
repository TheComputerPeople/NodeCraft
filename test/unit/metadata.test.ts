// Unreal's function metadata for graph functions and macros (src/core/metadata.ts,
// docs/node-authoring.md gap 6): Keywords, Compact Node Title, Deprecated and Advanced pins on the
// nodes made from a signature, and Deprecated's compile warning.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDocument } from '../../src/core/compiler';
import { FUNCTION_CALL, FUNCTION_ENTRY, FUNCTION_RETURN } from '../../src/core/functions';
import { builtinLanguagePacks } from '../../src/core/languages';
import { libraryDefinitions } from '../../src/core/libraries';
import { MACRO_INPUTS, MACRO_INSTANCE, MACRO_OUTPUTS } from '../../src/core/macros';
import { deprecationMessage, parseKeywords } from '../../src/core/metadata';
import { GraphDocument, GraphSignature, NodeDefinition } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
import { parseDocument, serializeDocument } from '../../src/core/serializer';

const METADATA: Partial<GraphSignature> = { keywords: ['mend', 'cure'], compactTitle: '+HP', deprecated: { message: 'Use Restore instead.' } };
const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}`, fromNode, fromPin, toNode, toPin });

// Start → Heal(Amount, Bonus) → Mend (a macro); Heal and Mend carry the metadata, Bonus is advanced.
function document(kind: GraphDocument['kind'] = 'class'): GraphDocument {
  return {
    schemaVersion: 3, name: 'Medic', kind, language: 'typescript', variables: [],
    graphs: [
      {
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [n('s', 'core:event.start'), n('call', FUNCTION_CALL, { graph: 'Heal', 'pin:amount': 2 }), n('m', MACRO_INSTANCE, { graph: 'Mend' })],
        connections: [w('s', 'execOut', 'call', 'execIn'), w('call', 'execOut', 'm', 'execIn')]
      },
      {
        id: 'Heal', name: 'Heal', kind: 'function', comments: [],
        signature: { inputs: [{ id: 'amount', name: 'Amount', kind: 'data', type: { id: 'float' } }, { id: 'bonus', name: 'Bonus', kind: 'data', type: { id: 'float' }, advanced: true }], outputs: [], ...METADATA },
        nodes: [n('entry', FUNCTION_ENTRY, { graph: 'Heal' }), n('ret', FUNCTION_RETURN, { graph: 'Heal' })],
        connections: [w('entry', 'execOut', 'ret', 'execIn')]
      },
      {
        id: 'Mend', name: 'Mend', kind: 'macro', comments: [],
        signature: { inputs: [{ id: 'in', name: 'In', kind: 'exec' }, { id: 'times', name: 'Times', kind: 'data', type: { id: 'int' }, advanced: true }], outputs: [{ id: 'out', name: 'Out', kind: 'exec' }], ...METADATA },
        nodes: [n('i', MACRO_INPUTS, { graph: 'Mend' }), n('o', MACRO_OUTPUTS, { graph: 'Mend' })],
        connections: [w('i', 'in', 'o', 'out')]
      }
    ]
  };
}

describe('function and macro metadata', () => {
  test('call and macro nodes take Keywords, Compact Node Title, Deprecated and Advanced pins', () => {
    const doc = document();
    const resolve = createResolver(new NodeRegistry(), doc);
    for (const id of ['call', 'm']) {
      const def = resolve(doc.graphs[0].nodes.find((node) => node.id === id)!)!;
      assert.deepEqual([def.keywords, def.compactTitle, def.deprecated], [['mend', 'cure'], '+HP', { message: 'Use Restore instead.' }], id);
      assert.deepEqual(def.inputs.filter((p) => p.advanced).map((p) => p.id), [id === 'call' ? 'bonus' : 'times']);
    }
    assert.equal(deprecationMessage({ displayName: 'Heal', deprecated: {} } as NodeDefinition), '"Heal" is deprecated.');
    assert.equal(deprecationMessage({ displayName: 'Heal', deprecated: { message: 'Use Restore.' } } as NodeDefinition), '"Heal" is deprecated: Use Restore.');
  });

  test("a function library's functions take them too", () => {
    const library = document('functionLibrary');
    library.graphs = library.graphs.filter((g) => g.kind === 'function');
    const [heal] = libraryDefinitions(library, { documentPath: 'libs/medic.vgraph', generatedPath: 'libs/medic.vgraph.ts', exports: { names: new Map([['Heal', 'heal']]) } });
    assert.deepEqual([heal.keywords, heal.compactTitle, heal.deprecated], [['mend', 'cure'], '+HP', { message: 'Use Restore instead.' }]);
    assert.deepEqual(heal.inputs.filter((p) => p.advanced).map((p) => p.id), ['bonus']);
  });

  test('a deprecated function or macro still compiles, with a warning on each node using it', () => {
    const result = compileDocument(document(), { registry: new NodeRegistry(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'medic.vgraph' } });
    assert.ok(result.output, 'it compiles');
    assert.deepEqual(result.diagnostics.map((d) => [d.severity, d.code, d.nodeId, d.message]), [
      ['warning', 'deprecated', 'm', '"Mend" is deprecated: Use Restore instead.'],
      ['warning', 'deprecated', 'call', '"Heal" is deprecated: Use Restore instead.']
    ]);
  });

  test('the file keeps the metadata', () => {
    const doc = document();
    const back = parseDocument(serializeDocument(doc)).document;
    assert.deepEqual(back.graphs[1].signature, doc.graphs[1].signature);
  });

  test('keywords are words separated by spaces or commas, each once', () => {
    assert.deepEqual(parseKeywords(' mend, cure  heal,mend '), ['mend', 'cure', 'heal']);
  });
});
