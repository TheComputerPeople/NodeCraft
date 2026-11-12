// The graphs every language's code-parents test runs (docs/code-classes-as-parents.md), and the
// corpus's layouts with inheritance too: an Actor from the project's code, with a constructor taking
// a name, a health property, a method (greet), an overridable method (hit), an abstract one
// (describe) and a template method (turn) calling both. A Knight graph extends it: its Start sets
// health and greets on Self, Event hit says so and calls Parent: hit, and describe is a function. A
// Game graph constructs a Knight and runs turn. Together they print CODE_PARENTS_OUTPUT.
import assert from 'node:assert/strict';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { CodeClassInfo, OVERRIDE_EVENT, PARENT_CALL } from '../../src/core/objects';

export const CODE_PARENTS_OUTPUT = ['Bors has 50', 'Bors is a knight', 'Knight blocks', 'Bors takes 3', 'Bors has 47'];

export interface Code {
  info: CodeClassInfo;
  definitions: NodeDefinition[];
}

const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin });

// The code's Actor among a project's nodes: the class graphs may extend, with its members. (A Lua
// module returning the class names none: `code:lua:actor.lua#`.)
export function actorCode(definitions: NodeDefinition[]): Code {
  const found = definitions.find((d) => d.implementation?.kind === 'code-class' && /((#|\.|::|\\)Actor|actor\.lua#)$/i.test(d.implementation.type.id));
  assert.ok(found?.implementation?.kind === 'code-class', `no Actor that graphs may extend in ${definitions.map((d) => d.type).join(', ')}`);
  return { info: found.implementation.type, definitions };
}

// An Actor member node's type, by its name in any case ("greet", "set:health"). (A Lua module that
// returns the class names no class: "#:greet".)
export function member(code: Code, name: string): string {
  const found = code.definitions.find((d) => d.type.toLowerCase().endsWith(`actor:${name}`) || d.type.endsWith(`#:${name}`));
  assert.ok(found, `no Actor:${name} in ${code.definitions.map((d) => d.type).join(', ')}`);
  return found.type;
}

export function method(code: Code, name: string) {
  const found = code.info.overridable.find((m) => m.name.toLowerCase() === name);
  assert.ok(found, `${name} isn't overridable`);
  return found;
}

// The graph class extending the Actor, named `name`.
export function knightGraph(language: string, code: Code, name = 'Knight'): GraphDocument {
  const hit = method(code, 'hit');
  const describe = method(code, 'describe').name;
  return {
    schemaVersion: 3, name, kind: 'class', language, parent: code.info.id, variables: [],
    graphs: [
      {
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          // Start: health = 50 and greet, both on Self (their Target unwired).
          n('s', 'core:event.start'), n('set', member(code, 'set:health'), { 'pin:value': 50 }), n('greet', member(code, 'greet')), n('p1', 'core:console.print'),
          // Event hit: says so, then runs the code's hit.
          n('hit', OVERRIDE_EVENT, { method: hit.name }), n('p2', 'core:console.print', { 'pin:value': 'Knight blocks' }), n('parent', PARENT_CALL, { function: hit.name })
        ],
        connections: [
          w('s', 'execOut', 'set', 'execIn'), w('set', 'execOut', 'greet', 'execIn'), w('greet', 'execOut', 'p1', 'execIn'), w('greet', 'returnValue', 'p1', 'value'),
          w('hit', 'execOut', 'p2', 'execIn'), w('p2', 'execOut', 'parent', 'execIn'), w('hit', hit.inputs[0].id, 'parent', hit.inputs[0].id)
        ]
      },
      {
        id: 'Describe', name: describe, kind: 'function', comments: [],
        signature: { inputs: [], outputs: [{ id: 'returnValue', name: 'Return Value', kind: 'data', type: { id: 'string' } }] },
        nodes: [n('entry', 'core:function.entry', { graph: 'Describe' }), n('return', 'core:function.return', { graph: 'Describe', 'pin:returnValue': 'a knight' })],
        connections: [w('entry', 'execOut', 'return', 'execIn')]
      }
    ]
  };
}

// The graph class named `name` whose Start constructs the `knight` class (named "Bors") and runs the
// code's turn on it.
export function gameGraph(language: string, code: Code, name = 'Game', knight = 'Knight'): GraphDocument {
  return {
    schemaVersion: 3, name, kind: 'class', language, variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [n('s', 'core:event.start'), n('make', `object:${knight}.construct`, { 'pin:name': 'Bors' }), n('turn', member(code, 'turn'))],
      connections: [w('s', 'execOut', 'make', 'execIn'), w('make', 'execOut', 'turn', 'execIn'), w('make', 'object', 'turn', 'target')]
    }]
  };
}
