// The graph every language's generic-function test runs (docs/node-authoring.md, gap 10): a code
// function `first<T>(items: T[]): T` is a node with wildcard pins. Wired to an array of ints, it
// takes int (as the editor records when the wire is made), and generated code leaves the
// language to infer T. It prints 3.
import assert from 'node:assert/strict';
import { GraphDocument, NodeDefinition } from '../../src/core/model';

export const GENERICS_OUTPUT = ['3'];

// Start → Print(First(Scores)), Scores an array of ints [3, 1, 2].
export function genericsGraph(definitions: NodeDefinition[], language: string): GraphDocument {
  const first = definitions.find((d) => /(#|\.)first$/i.test(d.type));
  assert.ok(first, `no first in ${definitions.map((d) => d.type).join(', ')}`);
  assert.deepEqual(first.inputs.filter((p) => p.kind === 'data').map((p) => p.type), [{ id: 'wildcard', container: 'array' }]);
  const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
  return {
    schemaVersion: 3, name: 'Firsts', kind: 'class', language,
    variables: [{ id: 'scores', name: 'Scores', type: { id: 'int', container: 'array' }, defaultValue: [3, 1, 2] }],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [n('s', 'core:event.start'), n('get', 'core:variable.get', { variable: 'scores' }), n('first', first.type, { wildcards: { wildcard: 'int' } }), n('p', 'core:console.print')],
      connections: [w('s', 'execOut', 'first', 'execIn'), w('first', 'execOut', 'p', 'execIn'), w('get', 'value', 'first', 'items'), w('first', 'returnValue', 'p', 'value')]
    }]
  };
}
