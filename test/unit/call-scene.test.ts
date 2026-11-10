// The call flow (src/core/codemap/call-scene.ts): from the entry points or a function, a few levels at
// a time; callers from above; graph files leading into their graphs; recursion and unresolved calls.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CallEdge } from '../../src/core/codemap/calls';
import { CALL_DEPTH, buildCallScene } from '../../src/core/codemap/call-scene';
import { CodeIndex, Entity } from '../../src/core/codemap/code-index';
import { Scene } from '../../src/core/codemap/scene';

const fn = (id: string, extra: Partial<Entity> = {}): Entity => ({ id, kind: 'function', name: id.replace(/^.*#/, ''), parent: 'f:a.ts', path: 'a.ts', ...extra });
const call = (from: string, to: string, certain = true): CallEdge => ({ from, to, path: 'a.ts', line: 1, column: 1, count: 1, certain });

// main → load → parse → token → char (a chain deeper than the first levels); main → run → run
// (recursion); a graph file Game with a Start graph calling load.
function sample(): CodeIndex {
  return {
    entities: [
      { id: 'p:', kind: 'project', name: 'p' }, { id: 'f:a.ts', kind: 'file', name: 'a.ts', parent: 'p:', path: 'a.ts' },
      fn('s:a.ts#main', { entries: [{ kind: 'main', name: 'main' }] }), fn('s:a.ts#load'), fn('s:a.ts#parse'), fn('s:a.ts#token'), fn('s:a.ts#char'), fn('s:a.ts#run'),
      { id: 'g:Game.vgraph', kind: 'graph-file', name: 'Game.vgraph', parent: 'p:', path: 'Game.vgraph', entries: [{ kind: 'event', name: 'Start' }] },
      { id: 'g:Game.vgraph#EventGraph', kind: 'graph', name: 'EventGraph', parent: 'g:Game.vgraph', path: 'Game.vgraph', entries: [{ kind: 'event', name: 'Start' }] }
    ],
    calls: [
      call('s:a.ts#main', 's:a.ts#load'), call('s:a.ts#load', 's:a.ts#parse'), call('s:a.ts#parse', 's:a.ts#token'), call('s:a.ts#token', 's:a.ts#char'),
      call('s:a.ts#main', 's:a.ts#run', false), call('s:a.ts#run', 's:a.ts#run'),
      call('g:Game.vgraph#EventGraph', 's:a.ts#load')
    ],
    unresolvedCalls: [{ from: 's:a.ts#main', callee: 'emit', path: 'a.ts', line: 9, column: 3, candidates: 8 }],
    imports: [], unresolved: [], inherits: [], generated: []
  };
}

// The call boxes (not the file boxes grouping them).
const boxes = (s: Scene) => s.boxes.filter((b) => !b.id.startsWith('in:')).map((b) => `${b.label}${b.expandable ? `[${b.count}]` : ''}${b.root ? '*' : ''}${b.cycle ? '@' : ''}`);
const arrows = (s: Scene) => s.arrows.map((a) => `${a.from.replace(/^[a-z]:/, '').replace(/^.*#/, '')}>${a.to.replace(/^.*[#>]/, '')}${a.certain ? '' : '?'}`).sort();

describe('the call flow', () => {
  test('without a function chosen, it starts from the entry points (a graph file from its Start graph)', () => {
    const scene = buildCallScene(sample(), { mode: 'calls', expanded: [] });
    assert.equal(scene.mode, 'calls');
    assert.deepEqual(scene.calls, { direction: 'callees', starts: 2 });
    const ids = scene.boxes.map((b) => b.id);
    assert.ok(ids.includes('s:a.ts#main') && ids.includes('g:Game.vgraph#EventGraph'));
    assert.ok(!ids.includes('g:Game.vgraph'), 'the graph file starts from its graph');
  });

  test(`from a function: ${CALL_DEPTH} levels, then boxes with calls left say how many`, () => {
    const scene = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 's:a.ts#main' } });
    assert.deepEqual(boxes(scene), ['main*', 'load', 'run@', 'parse[1]', 'emit?']);
    assert.deepEqual(arrows(scene), ['load>parse', 'main>emit?', 'main>load', 'main>run?', 'run>run']);
    assert.equal(scene.boxes.find((b) => b.label === 'emit?')!.kind, 'unresolved');
    assert.deepEqual(scene.calls, { direction: 'callees', root: 's:a.ts#main', rootLabel: 'main', starts: 1 });
  });

  test('opening a box explores one level further; closing it again hides that level', () => {
    const opened = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 's:a.ts#main', explored: ['s:a.ts#parse'] } });
    assert.deepEqual(boxes(opened).filter((b) => /parse|token/.test(b)), ['parse[0]', 'token[1]']);
    assert.equal(opened.boxes.find((b) => b.label === 'parse')!.expanded, true);
    const closed = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 's:a.ts#main', explored: [] } });
    assert.ok(!boxes(closed).some((b) => b.startsWith('token')));
  });

  test('callers: everything that reaches a function, still drawn caller to callee', () => {
    const scene = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 's:a.ts#load', direction: 'callers' } });
    assert.deepEqual(boxes(scene).sort(), ['EventGraph', 'Game', 'load*', 'main']);
    assert.deepEqual(arrows(scene), ['EventGraph>load', 'Game.vgraph>EventGraph', 'main>load']);
  });

  test('boxes are grouped in the file (or graph file) each is in; calls between files are lifted to them', () => {
    const scene = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 'g:Game.vgraph#EventGraph' } });
    const parents = Object.fromEntries(scene.boxes.map((b) => [b.id, b.parent ?? '']));
    assert.equal(parents['g:Game.vgraph#EventGraph'], 'in:g:Game.vgraph');
    assert.equal(parents['s:a.ts#load'], 'in:f:a.ts');
    assert.deepEqual(scene.boxes.filter((b) => b.id.startsWith('in:')).map((b) => [b.id, b.label, b.expanded]), [['in:g:Game.vgraph', 'Game', true], ['in:f:a.ts', 'a.ts', true]]);
    assert.deepEqual(scene.lifted.map((l) => `${l.from}>${l.to} in "${l.container}"`).sort(), ['in:g:Game.vgraph>in:f:a.ts in ""', 's:a.ts#load>s:a.ts#parse in "in:f:a.ts"']);
  });

  test('a graph file leads into its graphs, and on into what they call', () => {
    const scene = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 'g:Game.vgraph' } });
    assert.deepEqual(arrows(scene), ['EventGraph>load', 'Game.vgraph>EventGraph']);
  });
});
