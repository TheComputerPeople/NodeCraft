// The graph every language's code-class test runs (docs/node-authoring.md, gap 2): a Counter from
// the project's code, constructed, its method called and property set through Target pins, its
// getter read, and a BigCounter subclass's object used where a Counter is expected. It prints 8, 40
// and 11 (a language without inheritance builds the BigCounter on its own, with the same result).
import assert from 'node:assert/strict';
import { GraphDocument, NodeDefinition } from '../../src/core/model';

export const CODE_CLASS_OUTPUT = ['8', '40', '11'];

// Start → c = Construct Counter(5) → Print(c.Add(3)) → c.Count = 20 → Print(c.Doubled) →
// b = Construct BigCounter(1) → Print(Add(Target b, 1)), with Add's Target a Counter.
export function codeClassGraph(definitions: NodeDefinition[], language: string): GraphDocument {
  // A node's type ends with "Counter:new", after "#" or a namespace's "." or "::".
  const find = (member: string) => {
    const found = definitions.find((d) => new RegExp(`(#|\\.|::)${member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(d.type));
    assert.ok(found, `no ${member} in ${definitions.map((d) => d.type).join(', ')}`);
    return found;
  };
  // Add of a BigCounter: the base class's method, or the subclass's own in a language without
  // inheritance.
  const bigAdd = definitions.some((d) => /BigCounter:add$/i.test(d.type)) ? find('BigCounter:add') : find('Counter:add');
  // Doubled: a getter, or a pure method in a language without properties (C++, Java).
  const doubled = definitions.some((d) => /Counter:get:doubled$/i.test(d.type)) ? find('Counter:get:doubled') : find('Counter:doubled');
  const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
  const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });
  return {
    schemaVersion: 3, name: 'Counting', kind: 'class', language, variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [
        n('s', 'core:event.start'), n('c', find('Counter:new').type, { 'pin:start': 5 }), n('add', find('Counter:add').type, { 'pin:amount': 3 }), n('p1', 'core:console.print'),
        n('set', find('Counter:set:count').type, { 'pin:value': 20 }), n('get', doubled.type), n('p2', 'core:console.print'),
        n('b', find('BigCounter:new').type, { 'pin:start': 1 }), n('add2', bigAdd.type, { 'pin:amount': 1 }), n('p3', 'core:console.print')
      ],
      connections: [
        w('s', 'execOut', 'c', 'execIn'), w('c', 'execOut', 'add', 'execIn'), w('add', 'execOut', 'p1', 'execIn'), w('p1', 'execOut', 'set', 'execIn'),
        w('set', 'execOut', 'p2', 'execIn'), w('p2', 'execOut', 'b', 'execIn'), w('b', 'execOut', 'add2', 'execIn'), w('add2', 'execOut', 'p3', 'execIn'),
        w('c', 'returnValue', 'add', 'target'), w('add', 'returnValue', 'p1', 'value'), w('c', 'returnValue', 'set', 'target'),
        w('c', 'returnValue', 'get', 'target'), w('get', 'returnValue', 'p2', 'value'), w('b', 'returnValue', 'add2', 'target'), w('add2', 'returnValue', 'p3', 'value')
      ]
    }]
  };
}
