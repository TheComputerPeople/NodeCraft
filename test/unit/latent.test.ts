// Latent actions (docs/program-structure.md, "Latent actions"): their rules. The latent fixture
// runs them on every target.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { MAX_LATENT_ACTIONS } from '../../src/core/runtime';
import { doc, logs, node, run, wire } from './helpers';

const compile = (d: GraphDocument) => compileDocument(d, { registry: new NodeRegistry(), languages: builtinLanguagePacks(), generate: { sourceFileName: 't.vgraph' } });

describe('latent actions', () => {
  test('a function can\'t wait', () => {
    const d = doc([], []);
    d.graphs.push({
      id: 'F', name: 'F', kind: 'function', comments: [], signature: { inputs: [], outputs: [] },
      nodes: [node('entry', 'core:function.entry', { graph: 'F' }), node('wait', 'core:latent.delay')], connections: [wire('entry', 'execOut', 'wait', 'execIn')]
    });
    assert.deepEqual(compile(d).diagnostics.filter((x) => x.severity === 'error').map((x) => x.code), ['latent-in-function']);
  });

  test('a Delay that starts itself again is a timer, not an exec loop; Simulate stops it after a while', () => {
    const d = doc([node('s', 'core:event.start'), node('wait', 'core:latent.delay', { 'pin:duration': 1 }), node('p', 'core:console.print', { 'pin:value': 'tick' })], [
      wire('s', 'execOut', 'wait', 'execIn'), wire('wait', 'completed', 'p', 'execIn'), wire('p', 'execOut', 'wait', 'execIn')
    ]);
    const result = compile(d);
    assert.deepEqual(result.diagnostics, []);
    // The Delay is reached from two wires, so it is a shared block the callback calls again.
    assert.match(result.output!.text, /setTimeout\(\(\) => \{[\s\S]*this\._run_wait\(\);/);
    const events = run(d);
    assert.equal(logs(events).length, MAX_LATENT_ACTIONS);
    assert.match(events.find((e) => e.kind === 'error')?.message ?? '', /latent actions/);
  });

  test('Completed reads an event\'s inputs as they are when it runs', () => {
    const amount = { id: 'n', name: 'N', kind: 'data' as const, type: { id: 'int' } };
    const d = doc([
      node('e', 'core:event.custom', { name: 'E', inputs: [amount] }), node('wait', 'core:latent.delay', { 'pin:duration': 1 }), node('p', 'core:console.print'),
      node('s', 'core:event.start'), node('c1', 'core:call.event', { event: 'E', 'pin:n': 1 }), node('c2', 'core:call.event', { event: 'E', 'pin:n': 2 })
    ], [
      wire('e', 'execOut', 'wait', 'execIn'), wire('wait', 'completed', 'p', 'execIn'), wire('e', 'n', 'p', 'value'),
      wire('s', 'execOut', 'c1', 'execIn'), wire('c1', 'execOut', 'c2', 'execIn')
    ]);
    // The second call finds the Delay waiting; when it ends, the event's input is the latest, 2.
    assert.deepEqual(logs(run(d)), ['2']);
  });
});
