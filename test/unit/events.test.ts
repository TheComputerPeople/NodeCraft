// Custom events and event dispatchers (docs/program-structure.md, "Custom events and event
// dispatchers"): their rules and edits. The events fixture runs them on every target.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addDispatcher, addEventParam, deleteDispatcher, renameCustomEvent, renameDispatcher, setEventParamType } from '../../src/core/blueprint-edits';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, GraphNode } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
import { parseDocument } from '../../src/core/serializer';
import { logs, node, run, wire } from './helpers';

function doc(nodes: GraphNode[], connections: GraphDocument['graphs'][number]['connections'] = [], dispatchers?: GraphDocument['dispatchers']): GraphDocument {
  return {
    schemaVersion: 3, name: 'T', kind: 'class', language: 'javascript', variables: [], ...(dispatchers ? { dispatchers } : {}),
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes, connections }]
  };
}
const codes = (d: GraphDocument) => compileDocument(d, { registry: new NodeRegistry(), languages: builtinLanguagePacks(), generate: { sourceFileName: 't.vgraph' } }).diagnostics
  .filter((x) => x.severity === 'error').map((x) => `${x.code}@${x.nodeId}`);
const amount = { id: 'amount', name: 'Amount', kind: 'data' as const, type: { id: 'int' } };

describe('custom events', () => {
  test('a custom event shows its inputs, its red event pin, and its Call nodes take its inputs', () => {
    const d = doc([node('hit', 'core:event.custom', { name: 'Hit', inputs: [amount] }), node('call', 'core:call.event', { event: 'Hit' })]);
    const resolve = createResolver(new NodeRegistry(), d);
    const event = resolve(d.graphs[0].nodes[0])!;
    assert.deepEqual(event.outputs.map((p) => [p.id, p.type?.id]), [['delegate', 'delegate:(int)'], ['execOut', undefined], ['amount', 'int']]);
    assert.deepEqual(resolve(d.graphs[0].nodes[1])!.inputs.map((p) => p.id), ['execIn', 'amount']);
    assert.equal(resolve(d.graphs[0].nodes[1])!.displayName, 'Hit');
  });

  test('names are unique among functions, events and dispatchers; calls must find their event', () => {
    assert.deepEqual(codes(doc([node('a', 'core:event.custom', { name: 'Hit' }), node('b', 'core:event.custom', { name: 'Hit' })])), ['duplicate-event@b']);
    assert.deepEqual(codes(doc([node('s', 'core:event.start'), node('c', 'core:call.event', { event: 'Gone' })], [wire('s', 'execOut', 'c', 'execIn')])), ['event-missing@c']);
  });

  test('renaming an event renames its Call nodes', () => {
    const d = doc([node('hit', 'core:event.custom', { name: 'Hit' }), node('call', 'core:call.event', { event: 'Hit' })]);
    assert.equal(renameCustomEvent(d, d.graphs[0].nodes[0], 'Struck'), undefined);
    assert.equal(d.graphs[0].nodes[1].properties.event, 'Struck');
    addDispatcher(d);
    assert.match(renameCustomEvent(d, d.graphs[0].nodes[0], 'NewEventDispatcher') ?? '', /already a function, event or dispatcher/);
  });

  test('an event calling itself forever stops Simulate with an error', () => {
    const d = doc([node('s', 'core:event.start'), node('loop', 'core:event.custom', { name: 'Loop' }), node('c1', 'core:call.event', { event: 'Loop' }), node('c2', 'core:call.event', { event: 'Loop' })], [
      wire('s', 'execOut', 'c1', 'execIn'), wire('loop', 'execOut', 'c2', 'execIn')
    ]);
    const error = run(d).find((e) => e.kind === 'error');
    assert.match(error?.message ?? '', /Too many nested calls/);
  });
});

describe('event dispatchers', () => {
  const dispatchers = [{ id: 'scored', name: 'Scored', inputs: [amount] }];

  test('Bind needs a custom event wired into Event; dispatcher nodes need their dispatcher', () => {
    const d = doc([node('s', 'core:event.start'), node('bind', 'core:dispatcher.bind', { dispatcher: 'scored' }), node('call', 'core:dispatcher.call', { dispatcher: 'gone' })], [
      wire('s', 'execOut', 'bind', 'execIn'), wire('bind', 'execOut', 'call', 'execIn')
    ], dispatchers);
    assert.deepEqual(codes(d), ['event-unwired@bind', 'dispatcher-missing@call']);
  });

  test('an event fits a dispatcher when their parameter types agree', () => {
    const d = doc([node('e', 'core:event.custom', { name: 'E', inputs: [{ ...amount, type: { id: 'string' } }] }), node('bind', 'core:dispatcher.bind', { dispatcher: 'scored' })], [wire('e', 'delegate', 'bind', 'event')], dispatchers);
    assert.ok(codes(d).includes('type-mismatch@bind'));
  });

  test('changing a parameter drops the wires that no longer fit', () => {
    const d = doc([
      node('e', 'core:event.custom', { name: 'E', inputs: [amount] }), node('bind', 'core:dispatcher.bind', { dispatcher: 'scored' }),
      node('call', 'core:dispatcher.call', { dispatcher: 'scored' }), node('n', 'core:math.add')
    ], [wire('e', 'delegate', 'bind', 'event'), wire('n', 'result', 'call', 'amount')], structuredClone(dispatchers));
    setEventParamType(d, { dispatcher: 'scored' }, 'amount', { id: 'float' });
    assert.deepEqual(d.graphs[0].connections, []);
    addEventParam(d, { event: d.graphs[0].nodes[0] });
    assert.deepEqual((d.graphs[0].nodes[0].properties.inputs as { name: string }[]).map((p) => p.name), ['Amount', 'NewParam']);
  });

  test('renaming checks for clashes; deleting removes the nodes that use it', () => {
    const d = doc([node('call', 'core:dispatcher.call', { dispatcher: 'scored' }), node('e', 'core:event.custom', { name: 'E' })], [], structuredClone(dispatchers));
    assert.match(renameDispatcher(d, 'scored', 'E') ?? '', /already/);
    assert.equal(deleteDispatcher(d, 'scored'), 1);
    assert.equal(d.dispatchers, undefined);
    assert.deepEqual(d.graphs[0].nodes.map((n) => n.id), ['e']);
  });

  test('only a class has dispatchers', () => {
    assert.throws(() => parseDocument(JSON.stringify({ ...doc([]), kind: 'functionLibrary', dispatchers: [], graphs: [{ id: 'f', kind: 'function', nodes: [], connections: [] }] })), /only a class has event dispatchers/);
  });

  test('a dispatcher bound to an event of the object runs it with its inputs', () => {
    const d = doc([
      node('s', 'core:event.start'), node('e', 'core:event.custom', { name: 'E', inputs: [amount] }), node('p', 'core:console.print'),
      node('bind', 'core:dispatcher.bind', { dispatcher: 'scored' }), node('r', 'core:reroute'), node('call', 'core:dispatcher.call', { dispatcher: 'scored', 'pin:amount': 7 })
    ], [
      wire('e', 'execOut', 'p', 'execIn'), wire('e', 'amount', 'p', 'value'),
      wire('s', 'execOut', 'bind', 'execIn'), wire('e', 'delegate', 'r', 'in'), wire('r', 'out', 'bind', 'event'), wire('bind', 'execOut', 'call', 'execIn')
    ], dispatchers);
    assert.deepEqual(logs(run(d)), ['7']);
    assert.deepEqual(codes(d), []);
  });
});
