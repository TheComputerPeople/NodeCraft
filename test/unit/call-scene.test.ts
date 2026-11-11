// The call flow (src/core/codemap/call-scene.ts): from the entry points or a function, a few levels at
// a time; callers from above; graph files leading into their graphs; recursion and unresolved calls.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CallEdge } from '../../src/core/codemap/calls';
import { CALL_DEPTH, MAX_CALL_DEPTH, buildCallScene } from '../../src/core/codemap/call-scene';
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
    assert.deepEqual(scene.calls, { direction: 'callees', starts: 2, depth: 2 });
    const ids = scene.boxes.map((b) => b.id);
    assert.ok(ids.includes('s:a.ts#main') && ids.includes('g:Game.vgraph#EventGraph'));
    assert.ok(!ids.includes('g:Game.vgraph'), 'the graph file starts from its graph');
  });

  test('without entry points (a library), it starts from what nothing calls, and says so', () => {
    const index = sample();
    for (const e of index.entities) delete e.entries;
    const scene = buildCallScene(index, { mode: 'calls', expanded: [] });
    assert.deepEqual(scene.calls, { direction: 'callees', uncalled: true, starts: 2, depth: 2 });
    // main, and the graph file (leading into its graph); everything else is called by something.
    assert.ok(scene.boxes.some((b) => b.id === 's:a.ts#main') && scene.boxes.some((b) => b.id === 'g:Game.vgraph'));
    assert.ok(scene.boxes.some((b) => b.id === 'g:Game.vgraph#EventGraph'), 'the graph file leads into its graph');
  });

  test(`from a function: ${CALL_DEPTH} levels, then boxes with calls left say how many`, () => {
    const scene = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 's:a.ts#main' } });
    assert.deepEqual(boxes(scene), ['main*', 'load', 'run@', 'parse[1]', 'emit?']);
    assert.deepEqual(arrows(scene), ['load>parse', 'main>emit?', 'main>load', 'main>run?', 'run>run']);
    assert.equal(scene.boxes.find((b) => b.label === 'emit?')!.kind, 'unresolved');
    assert.deepEqual(scene.calls, { direction: 'callees', root: 's:a.ts#main', rootLabel: 'main', starts: 1, depth: 2 });
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

  test('focus: its callers above it and its calls below, so many levels each way', () => {
    const scene = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 's:a.ts#load', direction: 'both', depth: 1 } });
    // Boxes left to open say how many calls (below) or callers (above) they have left to show.
    assert.deepEqual(boxes(scene), ['load*', 'parse[1]', 'main', 'EventGraph[1]']);
    assert.deepEqual(arrows(scene), ['EventGraph>load', 'load>parse', 'main>load']);
    assert.deepEqual(scene.calls, { direction: 'both', root: 's:a.ts#load', rootLabel: 'load', starts: 1, depth: 1 });
    // Opening a caller explores further up.
    const up = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 's:a.ts#load', direction: 'both', depth: 1, explored: ['g:Game.vgraph#EventGraph'] } });
    assert.ok(arrows(up).includes('Game.vgraph>EventGraph'));
    // Both ways needs a box to start from: from the entry points, it's the calls made.
    assert.equal(buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { direction: 'both' } }).calls?.direction, 'callees');
  });

  test('how many levels the flow goes at first', () => {
    const deep = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 's:a.ts#main', depth: 3 } });
    assert.deepEqual(boxes(deep).filter((b) => /token|char/.test(b)), ['token[1]']);
    assert.equal(deep.calls?.depth, 3);
    assert.equal(buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 's:a.ts#main', depth: 99 } }).calls?.depth, MAX_CALL_DEPTH);
    assert.equal(buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { root: 's:a.ts#main', depth: 0 } }).calls?.depth, 1);
  });

  test('a path: the shortest calls from one box to another, either way round', () => {
    const path = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { path: { from: 's:a.ts#main', to: 's:a.ts#char' } } });
    assert.deepEqual(boxes(path), ['main*', 'char*', 'load', 'parse', 'token']);
    assert.deepEqual(arrows(path), ['load>parse', 'main>load', 'parse>token', 'token>char']);
    assert.deepEqual(path.calls?.path, { from: 's:a.ts#main', to: 's:a.ts#char', fromLabel: 'main', toLabel: 'char', length: 4 });
    // Asked the wrong way round, it's found the right way.
    const back = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { path: { from: 's:a.ts#char', to: 's:a.ts#main' } } });
    assert.deepEqual([back.calls?.path?.from, back.calls?.path?.to, back.calls?.path?.length], ['s:a.ts#main', 's:a.ts#char', 4]);
    // Through a graph file into its graph.
    assert.equal(buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { path: { from: 'g:Game.vgraph', to: 's:a.ts#parse' } } }).calls?.path?.length, 3);
    // None: the two ends, and no length.
    const none = buildCallScene(sample(), { mode: 'calls', expanded: [], calls: { path: { from: 's:a.ts#run', to: 's:a.ts#load' } } });
    assert.deepEqual(boxes(none), ['run*', 'load*']);
    assert.deepEqual(none.arrows, []);
    assert.equal(none.calls?.path?.length, undefined);
  });

  test('every shortest path is shown, not just one', () => {
    const index = sample();
    // main → run → parse is as short as main → load → parse.
    index.calls.push(call('s:a.ts#run', 's:a.ts#parse'));
    const scene = buildCallScene(index, { mode: 'calls', expanded: [], calls: { path: { from: 's:a.ts#main', to: 's:a.ts#parse' } } });
    assert.deepEqual(arrows(scene), ['load>parse', 'main>load', 'main>run?', 'run>parse']);
  });
});
