import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDocument } from '../../src/core/model';
import { CURRENT_SCHEMA_VERSION, createEmptyDocument, parseDocument, primaryGraph, serializeDocument } from '../../src/core/serializer';
import { readRepoFile, run } from './helpers';

const v2 = (overrides: Record<string, unknown>): string => JSON.stringify({
  schemaVersion: 2, name: 'Doc', kind: 'class', variables: [],
  graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', nodes: [], connections: [], comments: [] }],
  ...overrides
});
const graph = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, name: id, kind, nodes: [], connections: [], ...extra });

describe('parseDocument', () => {
  test('blank text yields an empty class named after the file, with an event graph', () => {
    const { document, migratedFrom } = parseDocument('  \n', 'MyGraph');
    assert.equal(document.name, 'MyGraph');
    assert.equal(document.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(document.kind, 'class');
    assert.deepEqual(document.graphs.map((g) => [g.id, g.kind]), [['EventGraph', 'event']]);
    assert.equal(migratedFrom, undefined);
  });

  test('parses the v2 sample without migrating it', () => {
    const { document, migratedFrom } = parseDocument(readRepoFile('sample/demo.vgraph'));
    assert.equal(migratedFrom, undefined);
    assert.equal(document.name, 'BlueprintDemo');
    assert.equal(primaryGraph(document).nodes.length, 7);
    assert.equal(primaryGraph(document).connections.length, 7);
  });

  test('fills optional fields with defaults', () => {
    const { document } = parseDocument(JSON.stringify({ schemaVersion: 2, graphs: [graph('Main', 'event'), graph('Helper', 'function')] }), 'Fallback');
    assert.equal(document.name, 'Fallback');
    assert.equal(document.kind, 'class');
    assert.equal(document.language, 'javascript');
    assert.deepEqual(document.variables, []);
    assert.deepEqual(document.metadata, {});
    assert.deepEqual(document.graphs[0].comments, []);
    assert.deepEqual(document.graphs[1].signature, { inputs: [], outputs: [] });
  });

  const invalid: [string, string, RegExp][] = [
    ['a JSON array', '[]', /expected a JSON object/],
    ['a newer schema version', v2({ schemaVersion: 99 }), /schema version 99, which is newer/],
    ['no graphs', v2({ graphs: [] }), /at least one graph/],
    ['an unknown document kind', v2({ kind: 'widget' }), /unknown kind "widget"/],
    ['an unknown graph kind', v2({ graphs: [graph('G', 'state')] }), /unknown kind "state"/],
    ['duplicate graph ids', v2({ graphs: [graph('G', 'event'), graph('G', 'function')] }), /duplicate graph id "G"/],
    ['an event graph in a function library', v2({ kind: 'functionLibrary', graphs: [graph('G', 'event')] }), /functionLibrary cannot contain event graph/],
    ['a function in a macro library', v2({ kind: 'macroLibrary', graphs: [graph('G', 'function')] }), /macroLibrary cannot contain function graph/],
    ['variables in a library', v2({ kind: 'functionLibrary', graphs: [graph('F', 'function')], variables: [{ id: 'v', name: 'v', type: { id: 'int' } }] }), /cannot have variables/],
    ['an event graph with a signature', v2({ graphs: [graph('G', 'event', { signature: { inputs: [], outputs: [] } })] }), /cannot have a signature/],
    ['a graph without node arrays', v2({ graphs: [{ id: 'G', kind: 'event' }] }), /needs nodes and connections arrays/],
    ['a v1 document without node arrays', '{"schemaVersion":1,"nodes":{}}', /expected nodes and connections arrays/]
  ];
  for (const [label, text, message] of invalid) {
    test(`rejects ${label}`, () => assert.throws(() => parseDocument(text), message));
  }

  test('propagates JSON syntax errors', () => {
    assert.throws(() => parseDocument('{"graphs":'), SyntaxError);
  });
});

describe('migrating schema 1 to 2', () => {
  const v1Text = readRepoFile('test/fixtures/demo-v1.vgraph');

  test('the v1 sample migrates to exactly the committed v2 sample', () => {
    const { document, migratedFrom } = parseDocument(v1Text);
    assert.equal(migratedFrom, 1);
    assert.deepEqual(document, parseDocument(readRepoFile('sample/demo.vgraph')).document);
  });

  test('keeps every node, connection, property and metadata field', () => {
    const v1 = JSON.parse(v1Text);
    const { document } = parseDocument(v1Text);
    const eventGraph = primaryGraph(document);
    assert.equal(eventGraph.id, 'EventGraph');
    assert.deepEqual(eventGraph.nodes, v1.nodes);
    assert.deepEqual(eventGraph.connections, v1.connections);
    assert.deepEqual(document.metadata, v1.metadata);
    assert.equal(document.name, v1.name);
    assert.equal(document.language, v1.language);
  });

  test('normalizes variable types and preserves unknown fields', () => {
    const { document } = parseDocument(JSON.stringify({
      nodes: [], connections: [],
      variables: [{ id: 'v1', name: 'Score', type: { id: 'number' }, defaultValue: 3 }],
      customTool: { keep: true }
    }));
    assert.deepEqual(document.variables, [{ id: 'v1', name: 'Score', type: { id: 'float' }, defaultValue: 3 }]);
    assert.deepEqual(document.customTool, { keep: true });
  });

  test('the migrated graph runs exactly like the v2 sample', () => {
    const fromV1 = run(parseDocument(v1Text).document);
    const fromV2 = run(parseDocument(readRepoFile('sample/demo.vgraph')).document);
    assert.deepEqual(fromV1, fromV2);
  });
});

describe('serializeDocument', () => {
  test('round-trips through parseDocument', () => {
    const original = createEmptyDocument('RoundTrip');
    assert.deepEqual(parseDocument(serializeDocument(original)).document, original);
  });

  test('writes known fields in a fixed order, then unknown ones', () => {
    const scrambled = {
      metadata: {}, extra: 1, graphs: [{ comments: [], connections: [], nodes: [], kind: 'event', name: 'G', id: 'G' }],
      variables: [], language: 'javascript', kind: 'class', name: 'N', schemaVersion: 2
    } as unknown as GraphDocument;
    const parsed = JSON.parse(serializeDocument(scrambled));
    assert.deepEqual(Object.keys(parsed), ['schemaVersion', 'name', 'kind', 'language', 'variables', 'graphs', 'metadata', 'extra']);
    assert.deepEqual(Object.keys(parsed.graphs[0]), ['id', 'name', 'kind', 'nodes', 'connections', 'comments']);
  });

  test('uses two-space indentation, LF line endings and a trailing newline', () => {
    const text = serializeDocument(createEmptyDocument('Format'));
    assert.ok(text.endsWith('}\n'));
    assert.ok(!text.includes('\r'));
    assert.match(text, /^\{\n  "schemaVersion": 3,/);
  });
});

describe('primaryGraph', () => {
  test('is the first event graph, or the first graph in a library', () => {
    const cls = parseDocument(v2({ graphs: [graph('Helper', 'function'), graph('Main', 'event')] })).document;
    assert.equal(primaryGraph(cls).id, 'Main');
    const library = parseDocument(v2({ kind: 'functionLibrary', graphs: [graph('F1', 'function'), graph('F2', 'function')] })).document;
    assert.equal(primaryGraph(library).id, 'F1');
  });
});
