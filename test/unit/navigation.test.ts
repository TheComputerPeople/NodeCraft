// Go to Definition and Find References (src/core/navigation.ts, docs/node-authoring.md gap 5).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FUNCTION_CALL } from '../../src/core/functions';
import { scanTypeScript } from '../../src/core/importing/typescript-scanner';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { MACRO_INSTANCE } from '../../src/core/macros';
import { GraphDocument, GraphNode, NodeDefinition } from '../../src/core/model';
import { definitionSite, findReferences } from '../../src/core/navigation';

const node = (type: string, properties: Record<string, unknown> = {}, id = 'n'): GraphNode => ({ id, type, position: { x: 0, y: 0 }, properties });
const def = (type: string, extra: Partial<NodeDefinition> = {}): NodeDefinition => ({ type, version: 1, displayName: type, category: 'Test', inputs: [], outputs: [], ...extra });
const doc: GraphDocument = {
  schemaVersion: 3, name: 'Game', kind: 'class', language: 'typescript', variables: [],
  graphs: [
    { id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], connections: [], nodes: [node('fn:typescript:lib/a.ts#hit', {}, 'a'), node('core:console.print', {}, 'p'), node('fn:typescript:lib/a.ts#old', {}, 'b')] },
    { id: 'Heal', name: 'Heal', kind: 'function', comments: [], connections: [], nodes: [node('fn:typescript:lib/a.ts#hit', {}, 'c')] }
  ]
};

describe('Go to Definition', () => {
  test("a function call or macro opens this file's graph; one whose graph is gone has nothing", () => {
    assert.deepEqual(definitionSite(node(FUNCTION_CALL, { graph: 'Heal' }), def(FUNCTION_CALL), doc), { kind: 'graph', graphId: 'Heal' });
    assert.deepEqual(definitionSite(node(MACRO_INSTANCE, { graph: 'Heal' }), def(MACRO_INSTANCE), doc), { kind: 'graph', graphId: 'Heal' });
    assert.equal(definitionSite(node(FUNCTION_CALL, { graph: 'Gone' }), def(FUNCTION_CALL), doc), undefined);
  });

  test("a library's function or macro opens its graph; project code opens its file; node files and packages are the host's", () => {
    const library = def('lib:libs/math.vgraph#Clamp', { implementation: { kind: 'function', language: 'typescript', path: 'libs/math.vgraph.ts', name: 'clamp', source: { document: 'libs/math.vgraph', graph: 'Clamp' } } });
    assert.deepEqual(definitionSite(node(library.type), library, doc), { kind: 'library', document: 'libs/math.vgraph', graphId: 'Clamp' });
    const code = def('fn:typescript:lib/a.ts#hit', { implementation: { kind: 'function', language: 'typescript', path: 'lib/a.ts', name: 'hit' } });
    assert.deepEqual(definitionSite(node(code.type), code, doc), { kind: 'code', path: 'lib/a.ts' });
    const snippet = def('math.double', { implementation: { kind: 'code', languages: { typescript: '{{value}} * 2' } } });
    assert.deepEqual(definitionSite(node(snippet.type), snippet, doc), { kind: 'node-file' });
    const packaged = def('combat.hit', { implementation: { kind: 'native', operation: 'x' }, library: { name: 'combat', version: '1.0.0' } });
    assert.deepEqual(definitionSite(node(packaged.type), packaged, doc), { kind: 'node-file' });
    assert.equal(definitionSite(node('core:console.print'), def('core:console.print', { implementation: { kind: 'native', operation: 'print' } }), doc), undefined);
  });

  test('exposed functions and class members carry their declaration lines, apart from their definitions', () => {
    const scan = scanTypeScript([
      '/** @blueprint */',
      'export function hit(): void {}',
      'export class Player {',
      '  /** @blueprint */',
      '  health = 3;',
      '  /** @blueprint */',
      '  constructor() {}',
      '  /** @blueprint */',
      '  heal(): void {}',
      '}',
      ''
    ].join('\n'));
    const exposed = exposeFunctions(scan, { language: 'typescript', path: 'lib/a.ts', exposeAll: false });
    const lines = Object.fromEntries([...exposed.lines].map(([type, line]) => [type.slice(type.indexOf('#') + 1), line]));
    assert.deepEqual(lines, { hit: 2, 'Player:new': 7, 'Player:heal': 9, 'Player:get:health': 5, 'Player:set:health': 5 });
    assert.ok(exposed.definitions.every((d) => !JSON.stringify(d).includes('"line"')), 'graph files store definitions, so a moved line must not change them');
  });
});

describe('Find References', () => {
  test('every node of the type, in every graph, and nodes still using one of its old types', () => {
    const current = def('fn:typescript:lib/a.ts#hit', { displayName: 'Hit', aliases: ['fn:typescript:lib/a.ts#old'] });
    const resolve = (n: GraphNode) => (n.type === current.type || current.aliases!.includes(n.type) ? current : undefined);
    assert.deepEqual(findReferences(doc, current.type, resolve).map((h) => [h.graphName, h.id, h.label]), [['EventGraph', 'a', 'Hit'], ['EventGraph', 'b', 'Hit'], ['Heal', 'c', 'Hit']]);
    assert.deepEqual(findReferences(doc, 'core:console.print', () => undefined).map((h) => h.id), ['p']);
  });
});
