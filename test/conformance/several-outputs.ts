// The graph every language's several-outputs test runs (docs/node-authoring.md, gap 3): a divide
// function from the project's code, with Quotient and Remainder outputs however the language gives
// them (out parameters, a tuple, an object's or record's fields), each printed. It prints 3 and 2.
import assert from 'node:assert/strict';
import { GraphDocument, NodeDefinition } from '../../src/core/model';

export const SEVERAL_OUTPUTS_OUTPUT = ['3', '2'];

// Start → Divide(17, 5) → Print(Quotient) → Print(Remainder).
export function severalOutputsGraph(definitions: NodeDefinition[], language: string): GraphDocument {
  const divide = definitions.find((d) => /(#|\.|::|\\)divide$/i.test(d.type));
  assert.ok(divide, `no divide in ${definitions.map((d) => d.type).join(', ')}`);
  assert.deepEqual(divide.outputs.filter((p) => p.kind === 'data').map((p) => p.id), ['quotient', 'remainder']);
  const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
  return {
    schemaVersion: 3, name: 'Dividing', kind: 'class', language, variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [n('s', 'core:event.start'), n('d', divide.type, { 'pin:a': 17, 'pin:b': 5 }), n('p1', 'core:console.print'), n('p2', 'core:console.print')],
      connections: [
        w('s', 'execOut', 'd', 'execIn'), w('d', 'execOut', 'p1', 'execIn'), w('p1', 'execOut', 'p2', 'execIn'),
        w('d', 'quotient', 'p1', 'value'), w('d', 'remainder', 'p2', 'value')
      ]
    }]
  };
}
