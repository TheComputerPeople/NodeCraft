import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeRegistry } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
import { searchDocument } from '../../src/core/search';
import { parseDocument } from '../../src/core/serializer';
import { readRepoFile } from './helpers';

const doc = () => {
  const d = parseDocument(readRepoFile('sample/demo.vgraph')).document;
  d.variables.push({ id: 'v_hp', name: 'Health', type: { id: 'float' }, description: 'Hit points left' });
  d.graphs[0].comments.push({ id: 'k', text: 'Scoring logic', position: { x: 0, y: 0 }, size: { width: 10, height: 10 } });
  d.graphs[0].nodes.push({ id: 'get_hp', type: 'core:variable.get', position: { x: 0, y: 0 }, properties: { variable: 'v_hp' } });
  return d;
};
const search = (q: string) => {
  const d = doc();
  return searchDocument(d, q, createResolver(new NodeRegistry(), d.variables));
};
const summary = (q: string) => search(q).map((h) => `${h.kind}:${h.id}${h.detail ? ` (${h.detail})` : ''}`);

describe('searchDocument', () => {
  test('finds nodes by title, case-insensitively', () => {
    assert.deepEqual(summary('print'), ['node:print_true', 'node:print_false']);
  });

  test('finds nodes by an input value, saying which', () => {
    assert.deepEqual(summary('did not execute'), ['node:print_false (Value: False branch: graph did not execute.)']);
  });

  test('finds variables by name or description, and the nodes that use them', () => {
    assert.deepEqual(summary('health'), ['variable:v_hp', 'node:get_hp']);
    assert.deepEqual(summary('hit points'), ['variable:v_hp (Hit points left)']);
  });

  test('finds graphs and comments', () => {
    assert.deepEqual(summary('eventgraph'), ['graph:EventGraph']);
    assert.deepEqual(summary('scoring'), ['comment:k']);
  });

  test('carries the graph for jumping to a hit', () => {
    assert.deepEqual(search('Add').map((h) => [h.graphId, h.graphName]), [['EventGraph', 'EventGraph']]);
  });

  test('an empty query finds nothing', () => {
    assert.deepEqual(search('  '), []);
  });
});
