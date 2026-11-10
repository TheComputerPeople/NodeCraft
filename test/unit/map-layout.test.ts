// Laying the Codebase Map out (src/extension/map-layout*.ts): every box placed inside its open box,
// siblings apart, arrows from box to box, flowing down between layers; and fast enough for a large map.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeIndex, Entity } from '../../src/core/codemap/code-index';
import { LaidScene, buildScene } from '../../src/core/codemap/scene';
import { MapLayout } from '../../src/extension/map-layout';

// Projects of folders of files, each file importing the next ones in a chain, so the map has layers.
function index(projects: number, folders: number, files: number): CodeIndex {
  const entities: Entity[] = [];
  const imports: CodeIndex['imports'] = [];
  for (let p = 0; p < projects; p++) {
    entities.push({ id: `p:p${p}`, kind: 'project', name: `p${p}` });
    for (let m = 0; m < folders; m++) {
      entities.push({ id: `m:p${p}/m${m}`, kind: 'module', name: `m${m}`, parent: `p:p${p}` });
      for (let f = 0; f < files; f++) {
        const id = `f:p${p}/m${m}/f${f}.ts`;
        entities.push({ id, kind: 'file', name: `f${f}.ts`, parent: `m:p${p}/m${m}`, path: id.slice(2) });
        if (f > 0) imports.push({ from: `f:p${p}/m${m}/f${f - 1}.ts`, to: id, line: 1, source: '' });
      }
      if (m > 0) imports.push({ from: `f:p${p}/m${m - 1}/f0.ts`, to: `f:p${p}/m${m}/f0.ts`, line: 1, source: '' });
    }
  }
  return { entities, imports, unresolved: [], calls: [], unresolvedCalls: [], inherits: [], generated: [] };
}

describe('the map layout', () => {
  let layout: MapLayout;
  before(() => {
    layout = new MapLayout();
  });
  after(() => layout.dispose());

  function check(scene: LaidScene): void {
    const byId = new Map(scene.boxes.map((b) => [b.id, b]));
    for (const box of scene.boxes) {
      assert.ok(box.width > 0 && box.height > 0, `${box.id} has a size`);
      const parent = box.parent ? byId.get(box.parent) : undefined;
      if (parent) {
        assert.ok(box.x >= parent.x && box.y >= parent.y && box.x + box.width <= parent.x + parent.width + 0.5 && box.y + box.height <= parent.y + parent.height + 0.5, `${box.id} is inside ${parent.id}`);
      }
    }
    // Siblings don't overlap.
    const groups = new Map<string, typeof scene.boxes>();
    for (const box of scene.boxes) groups.set(box.parent ?? '', [...(groups.get(box.parent ?? '') ?? []), box]);
    for (const siblings of groups.values()) {
      for (const [i, a] of siblings.entries()) {
        for (const b of siblings.slice(i + 1)) {
          const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
          assert.ok(apart, `${a.id} and ${b.id} overlap`);
        }
      }
    }
  }

  test('boxes sit inside their open boxes, apart; arrows run from box to box, down', async () => {
    const source = index(2, 3, 4);
    const scene = await layout.layout(buildScene(source, { expanded: ['p:p0', 'p:p1', 'm:p0/m0', 'm:p0/m1', 'm:p0/m2'] }));
    check(scene);
    assert.ok(scene.arrows.length > 0);
    for (const arrow of scene.arrows) {
      const from = scene.boxes.find((b) => b.id === arrow.from)!;
      const to = scene.boxes.find((b) => b.id === arrow.to)!;
      const [start, end] = [arrow.points[0], arrow.points.at(-1)!];
      // From its source's edge, to its target's edge (within a pixel).
      const near = (p: { x: number; y: number }, b: typeof from) => p.x >= b.x - 1 && p.x <= b.x + b.width + 1 && p.y >= b.y - 1 && p.y <= b.y + b.height + 1;
      assert.ok(near(start, from) && near(end, to), `${arrow.id} joins its boxes`);
      // The chains have no cycles: every arrow points down.
      assert.ok(end.y >= start.y, `${arrow.id} points down`);
    }
  });

  test('a large map lays out in a few seconds', async () => {
    const source = index(4, 12, 30);
    const expanded = source.entities.filter((e) => e.kind === 'project' || e.kind === 'module').map((e) => e.id);
    const started = performance.now();
    const scene = await layout.layout(buildScene(source, { expanded, unlimited: expanded }));
    const ms = performance.now() - started;
    assert.ok(scene.boxes.length > 1400, `${scene.boxes.length} boxes`);
    check(scene);
    assert.ok(ms < 15000, `${Math.round(ms)} ms`);
  });
});
