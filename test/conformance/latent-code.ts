// The graph every language's async-function test runs (docs/node-authoring.md, gap 4): a latent
// fetchDouble from the project's code, started from a Sequence's first output. Its Completed runs
// after the Sequence's second output, as a Delay's would, so it prints "started" and then 8.
import assert from 'node:assert/strict';
import { GraphDocument, NodeDefinition } from '../../src/core/model';

export const LATENT_CODE_OUTPUT = ['started', '8'];

// Start → Sequence: Then 0 → Fetch Double(4) → Completed → Print(Return Value); Then 1 → Print("started").
export function latentCodeGraph(definitions: NodeDefinition[], language: string): GraphDocument {
  const fetch = definitions.find((d) => /(#|\.)fetch_?double$/i.test(d.type));
  assert.ok(fetch, `no fetchDouble in ${definitions.map((d) => d.type).join(', ')}`);
  assert.equal(fetch.latent, true);
  assert.deepEqual(fetch.outputs.map((p) => p.id), ['completed', 'returnValue']);
  const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
  return {
    schemaVersion: 3, name: 'Fetching', kind: 'class', language, variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [
        n('s', 'core:event.start'), n('seq', 'core:flow.sequence', { pins: 2 }), n('f', fetch.type, { 'pin:value': 4 }),
        n('p1', 'core:console.print'), n('p2', 'core:console.print', { 'pin:value': 'started' })
      ],
      connections: [
        w('s', 'execOut', 'seq', 'execIn'), w('seq', 'then0', 'f', 'execIn'), w('f', 'completed', 'p1', 'execIn'),
        w('f', 'returnValue', 'p1', 'value'), w('seq', 'then1', 'p2', 'execIn')
      ]
    }]
  };
}
