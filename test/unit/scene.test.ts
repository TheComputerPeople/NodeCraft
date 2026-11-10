// What the Codebase Map shows (src/core/codemap/scene.ts): boxes in view by what's open, counts,
// arrows summed onto visible boxes, the limits, and external packages in one box.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeIndex, Entity } from '../../src/core/codemap/code-index';
import { MAX_CHILDREN, buildScene, defaultView } from '../../src/core/codemap/scene';

function entity(id: string, kind: Entity['kind'], parent?: string, extra: Partial<Entity> = {}): Entity {
  return { id, kind, name: id.replace(/^.*[:/#.]/, ''), ...(parent ? { parent } : {}), ...extra };
}

// A project with two folders: ui/ (a.ts with class A and its method A.f) and core/ (b.ts with g), and
// an external package.
function sample(): CodeIndex {
  return {
    entities: [
      entity('p:', 'project'),
      entity('m:ui', 'module', 'p:'), entity('f:ui/a.ts', 'file', 'm:ui', { path: 'ui/a.ts' }),
      entity('s:ui/a.ts#A', 'type', 'f:ui/a.ts', { path: 'ui/a.ts', line: 1, detail: 'class' }),
      entity('s:ui/a.ts#A.f', 'function', 's:ui/a.ts#A', { path: 'ui/a.ts', line: 2, detail: 'method', entries: [{ kind: 'main', name: 'f' }] }),
      entity('m:core', 'module', 'p:'), entity('f:core/b.ts', 'file', 'm:core', { path: 'core/b.ts' }),
      entity('s:core/b.ts#g', 'function', 'f:core/b.ts', { path: 'core/b.ts', line: 1 }),
      entity('x:npm:react', 'external')
    ],
    imports: [
      { from: 'f:ui/a.ts', to: 'f:core/b.ts', line: 1, source: '../core/b' },
      { from: 'f:ui/a.ts', to: 'x:npm:react', line: 2, source: 'react' }
    ],
    calls: [
      { from: 's:ui/a.ts#A.f', to: 's:core/b.ts#g', path: 'ui/a.ts', line: 3, column: 1, count: 2, certain: true },
      { from: 's:ui/a.ts#A.f', to: 's:ui/a.ts#A.f', path: 'ui/a.ts', line: 4, column: 1, count: 1, certain: true }
    ],
    unresolved: [], unresolvedCalls: [], inherits: [], generated: []
  };
}

const ids = (s: ReturnType<typeof buildScene>) => s.boxes.map((b) => b.id);
const arrows = (s: ReturnType<typeof buildScene>) => s.arrows.map((a) => `${a.kind} ${a.from}>${a.to} ×${a.weight}${a.certain ? '' : ' ?'}`).sort();

describe('the scene', () => {
  test('a closed project shows itself and what it holds; externals are one box', () => {
    const scene = buildScene(sample(), { expanded: [] });
    assert.deepEqual(ids(scene), ['p:', 'externals']);
    const project = scene.boxes[0];
    assert.deepEqual([project.count, project.expandable, project.expanded], [7, true, false]);
    assert.deepEqual(scene.boxes[1].count, 1);
    // The project's import of the package is drawn between the boxes that show them.
    assert.deepEqual(arrows(scene), ['imports p:>externals ×1']);
  });

  test('opening boxes shows their children; arrows inside one box aren\'t drawn', () => {
    const scene = buildScene(sample(), { expanded: ['p:'] });
    assert.deepEqual(ids(scene), ['p:', 'm:ui', 'm:core', 'externals']);
    assert.deepEqual(scene.boxes.filter((b) => b.parent === 'p:').map((b) => b.id), ['m:ui', 'm:core']);
    assert.deepEqual(arrows(scene), ['imports m:ui>externals ×1', 'imports m:ui>m:core ×1']);
  });

  test('calls are drawn between declarations, summed; a call to itself isn\'t drawn', () => {
    const scene = buildScene(sample(), { expanded: ['p:', 'm:ui', 'f:ui/a.ts', 's:ui/a.ts#A', 'm:core', 'f:core/b.ts'] });
    assert.ok(ids(scene).includes('s:ui/a.ts#A.f') && ids(scene).includes('s:core/b.ts#g'));
    assert.deepEqual(arrows(scene).filter((a) => a.startsWith('calls')), ['calls s:ui/a.ts#A.f>s:core/b.ts#g ×1']);
    // Between files, the import says it: no call arrow from a file box.
    const files = buildScene(sample(), { expanded: ['p:', 'm:ui', 'm:core'] });
    assert.deepEqual(arrows(files).filter((a) => a.startsWith('calls')), []);
  });

  test('a box shows its entry point, path and line', () => {
    const scene = buildScene(sample(), { expanded: ['p:', 'm:ui', 'f:ui/a.ts', 's:ui/a.ts#A'] });
    const f = scene.boxes.find((b) => b.id === 's:ui/a.ts#A.f')!;
    assert.deepEqual([f.entry, f.path, f.line, f.detail], ['main: f', 'ui/a.ts', 2, 'method']);
  });

  test('a box shows its first children and "N more…"; opened, all of them', () => {
    const index = sample();
    for (let i = 0; i < MAX_CHILDREN + 5; i++) index.entities.push(entity(`f:core/x${i}.ts`, 'file', 'm:core'));
    const limited = buildScene(index, { expanded: ['p:', 'm:core'] });
    const more = limited.boxes.find((b) => b.kind === 'more')!;
    assert.deepEqual([more.id, more.parent, more.label], ['more:m:core', 'm:core', '6 more…']);
    assert.equal(limited.boxes.filter((b) => b.parent === 'm:core').length, MAX_CHILDREN + 1);
    const all = buildScene(index, { expanded: ['p:', 'm:core'], unlimited: ['m:core'] });
    assert.equal(all.boxes.filter((b) => b.parent === 'm:core').length, MAX_CHILDREN + 6);
  });

  test('a folder\'s map opens with its projects open when there are a few', () => {
    assert.deepEqual(defaultView(sample()), { expanded: ['p:'] });
    const many = sample();
    for (let i = 0; i < 4; i++) many.entities.push(entity(`p:extra${i}`, 'project'));
    assert.deepEqual(defaultView(many), { expanded: [] });
  });
});
