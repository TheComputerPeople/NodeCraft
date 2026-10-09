import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_SCHEMA_VERSION, createEmptyGraph, parseGraph, serializeGraph } from '../../src/core/serializer';
import { readRepoFile } from './helpers';

describe('parseGraph', () => {
  test('blank text yields an empty graph named after the file', () => {
    const g = parseGraph('  \n', 'MyGraph');
    assert.equal(g.name, 'MyGraph');
    assert.equal(g.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.connections, []);
  });

  test('fills optional fields with defaults', () => {
    const g = parseGraph('{"nodes":[],"connections":[]}', 'Fallback');
    assert.equal(g.name, 'Fallback');
    assert.equal(g.language, 'javascript');
    assert.deepEqual(g.variables, []);
    assert.deepEqual(g.metadata, {});
  });

  test('rejects documents without node and connection arrays', () => {
    assert.throws(() => parseGraph('{"nodes":{}}'), /expected nodes and connections arrays/);
  });

  test('propagates JSON syntax errors', () => {
    assert.throws(() => parseGraph('{"nodes":'), SyntaxError);
  });

  test('parses the sample graph', () => {
    const g = parseGraph(readRepoFile('sample/demo.vgraph'));
    assert.equal(g.name, 'BlueprintDemo');
    assert.equal(g.nodes.length, 7);
    assert.equal(g.connections.length, 7);
  });
});

describe('serializeGraph', () => {
  test('round-trips through parseGraph', () => {
    const original = createEmptyGraph('RoundTrip');
    assert.deepEqual(parseGraph(serializeGraph(original)), original);
  });

  test('uses two-space indentation, LF line endings and a trailing newline', () => {
    const text = serializeGraph(createEmptyGraph('Format'));
    assert.ok(text.endsWith('}\n'));
    assert.ok(!text.includes('\r'));
    assert.match(text, /^\{\n  "schemaVersion"/);
  });
});
