// What the Codebase Map shows (src/core/codemap/scene.ts): boxes in view by what's open, counts,
// arrows summed and lifted, the limits, external packages in one box, and the two views: the
// architecture (imports, with cycles marked) and the structure (types, members, inheritance).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeIndex, Entity } from '../../src/core/codemap/code-index';
import { MAX_CHILDREN, MAX_MEMBERS, Scene, buildScene, defaultView } from '../../src/core/codemap/scene';

function entity(id: string, kind: Entity['kind'], parent?: string, extra: Partial<Entity> = {}): Entity {
  return { id, kind, name: id.replace(/^.*[:/#.]/, ''), ...(parent ? { parent } : {}), ...extra };
}

// A project with two folders: ui/ (a.ts with class A extending B, and its method A.f) and core/ (b.ts
// with class B and function g), and an external package.
function sample(): CodeIndex {
  return {
    entities: [
      entity('p:', 'project'),
      entity('m:ui', 'module', 'p:'), entity('f:ui/a.ts', 'file', 'm:ui', { path: 'ui/a.ts' }),
      entity('s:ui/a.ts#A', 'type', 'f:ui/a.ts', { path: 'ui/a.ts', line: 1, detail: 'class' }),
      entity('s:ui/a.ts#A.f', 'function', 's:ui/a.ts#A', { path: 'ui/a.ts', line: 2, detail: 'method', entries: [{ kind: 'main', name: 'f' }] }),
      entity('m:core', 'module', 'p:'), entity('f:core/b.ts', 'file', 'm:core', { path: 'core/b.ts' }),
      entity('s:core/b.ts#B', 'type', 'f:core/b.ts', { path: 'core/b.ts', line: 1, detail: 'class' }),
      entity('s:core/b.ts#g', 'function', 'f:core/b.ts', { path: 'core/b.ts', line: 5, detail: 'function' }),
      entity('x:npm:react', 'external')
    ],
    imports: [
      { from: 'f:ui/a.ts', to: 'f:core/b.ts', line: 1, source: '../core/b' },
      { from: 'f:ui/a.ts', to: 'x:npm:react', line: 2, source: 'react' }
    ],
    calls: [{ from: 's:ui/a.ts#A.f', to: 's:core/b.ts#g', path: 'ui/a.ts', line: 3, column: 1, count: 2, certain: true }],
    inherits: [{ from: 's:ui/a.ts#A', to: 's:core/b.ts#B', name: 'B', kind: 'extends' }],
    unresolved: [], unresolvedCalls: [], generated: []
  };
}

const ids = (s: Scene) => s.boxes.map((b) => b.id);
const arrows = (s: Scene) => s.arrows.map((a) => `${a.kind} ${a.from}>${a.to} ×${a.weight}`).sort();
const lifted = (s: Scene) => s.lifted.map((a) => `${a.kind} ${a.from}>${a.to} in "${a.container}"${a.cycle ? ' cycle' : ''}`).sort();

describe('the scene', () => {
  test('a closed project shows itself and what it holds; externals are one box', () => {
    const scene = buildScene(sample(), { expanded: [] });
    assert.equal(scene.mode, 'architecture');
    assert.deepEqual(ids(scene), ['p:', 'externals']);
    // The architecture's boxes stop at files: the project holds two folders and two files.
    assert.deepEqual([scene.boxes[0].count, scene.boxes[0].expandable, scene.boxes[0].expanded], [4, true, false]);
    assert.deepEqual(arrows(scene), ['imports p:>externals ×1']);
  });

  test('the architecture: folders and files, with their imports summed and lifted; files don\'t open', () => {
    const scene = buildScene(sample(), { expanded: ['p:', 'm:ui', 'm:core', 'f:ui/a.ts'] });
    assert.deepEqual(ids(scene), ['p:', 'm:ui', 'f:ui/a.ts', 'm:core', 'f:core/b.ts', 'externals']);
    assert.equal(scene.boxes.find((b) => b.id === 'f:ui/a.ts')!.expandable, false);
    assert.deepEqual(arrows(scene), ['imports f:ui/a.ts>externals ×1', 'imports f:ui/a.ts>f:core/b.ts ×1']);
    // Drawn between the boxes side by side: the folders in the project, the project and the packages.
    assert.deepEqual(lifted(scene), ['imports m:ui>m:core in "p:"', 'imports p:>externals in ""']);
  });

  test('import cycles are marked, among the boxes side by side', () => {
    const index = sample();
    index.imports.push({ from: 'f:core/b.ts', to: 'f:ui/a.ts', line: 3, source: '../ui/a' });
    const scene = buildScene(index, { expanded: ['p:'] });
    assert.deepEqual(lifted(scene), ['imports m:core>m:ui in "p:" cycle', 'imports m:ui>m:core in "p:" cycle', 'imports p:>externals in ""']);
    assert.deepEqual(scene.boxes.filter((b) => b.cycle).map((b) => b.id), ['m:ui', 'm:core']);
    // No cycle without it.
    assert.deepEqual(buildScene(sample(), { expanded: ['p:'] }).boxes.filter((b) => b.cycle), []);
  });

  test('the structure: files open into their types and functions; a type lists its members; inheritance', () => {
    const scene = buildScene(sample(), { mode: 'structure', expanded: ['p:', 'm:ui', 'm:core', 'f:ui/a.ts', 'f:core/b.ts'] });
    assert.ok(ids(scene).includes('s:ui/a.ts#A') && ids(scene).includes('s:core/b.ts#g'));
    // A's method is listed in its box, not a box of its own.
    assert.ok(!ids(scene).includes('s:ui/a.ts#A.f'));
    const a = scene.boxes.find((b) => b.id === 's:ui/a.ts#A')!;
    assert.deepEqual([a.members, a.expandable], [['f()'], false]);
    assert.deepEqual(arrows(scene), ['inherits s:ui/a.ts#A>s:core/b.ts#B ×1'], 'only inheritance: no imports or calls');
    assert.deepEqual(lifted(scene), ['inherits m:ui>m:core in "p:"']);
  });

  test('a long member list ends with how many more', () => {
    const index = sample();
    for (let i = 0; i < MAX_MEMBERS + 4; i++) index.entities.push(entity(`s:core/b.ts#B.m${i}`, 'function', 's:core/b.ts#B', { detail: 'method' }));
    const scene = buildScene(index, { mode: 'structure', expanded: ['p:', 'm:core', 'f:core/b.ts'] });
    const members = scene.boxes.find((b) => b.id === 's:core/b.ts#B')!.members!;
    assert.equal(members.length, MAX_MEMBERS);
    assert.equal(members.at(-1), '+5 more');
  });

  test('a box shows its entry point, path and line', () => {
    const scene = buildScene(sample(), { mode: 'structure', expanded: ['p:', 'm:core', 'f:core/b.ts'] });
    const g = scene.boxes.find((b) => b.id === 's:core/b.ts#g')!;
    assert.deepEqual([g.path, g.line, g.detail], ['core/b.ts', 5, 'function']);
    const index = sample();
    index.entities.find((e) => e.id === 'f:ui/a.ts')!.entries = [{ kind: 'main' }];
    assert.equal(buildScene(index, { expanded: ['p:', 'm:ui'] }).boxes.find((b) => b.id === 'f:ui/a.ts')!.entry, 'main');
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

  test("a folder's map opens on its architecture, with its projects open when there are a few", () => {
    assert.deepEqual(defaultView(sample()), { mode: 'architecture', expanded: ['p:'] });
    const many = sample();
    for (let i = 0; i < 4; i++) many.entities.push(entity(`p:extra${i}`, 'project'));
    assert.deepEqual(defaultView(many), { mode: 'architecture', expanded: [] });
  });
});
