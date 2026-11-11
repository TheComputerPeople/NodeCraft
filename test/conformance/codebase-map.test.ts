// The Codebase Map's exit check (docs/codebase-map.md, "Exit check"), on the corpus of project layouts
// in all 12 languages:
// - each layout's architecture shows its projects, folders and the imports between them, as written
//   by hand in corpus-map-expected.ts;
// - its call flow from its entry points reaches its graphs and the project functions they call;
// - its structure shows its types' parents;
// - every view is laid out top to bottom: each arrow points down except loops' and recursion's back
//   edges (inheritance points up, at the parent above), and boxes sit apart, inside their open boxes;
// - the control flow of one function per language is laid out the same way;
// - and the index is fast enough: this repository and each layout in under 5 seconds on a cold cache,
//   a changed file in under a second.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_CALL_DEPTH, buildCallScene } from '../../src/core/codemap/call-scene';
import { CodeIndex } from '../../src/core/codemap/code-index';
import { buildFlowScene } from '../../src/core/codemap/flow-scene';
import { LaidScene, buildScene, laidOutReversed } from '../../src/core/codemap/scene';
import { JsonFactsCache, factsVersion, indexFolder } from '../../src/extension/code-indexer';
import { MapLayout } from '../../src/extension/map-layout';
import { ParseService } from '../../src/extension/parse-service';
import { FLOW_CASES } from '../unit/code-flow-cases';
import { corpusWorkDir, prepareLayout } from './corpus';
import { LAYOUTS } from './corpus-layouts';
import { CALLS, EXPECTED, INHERITS, id } from './corpus-map-expected';

const repoRoot = path.resolve(__dirname, '../../..');
const grammarDir = path.join(repoRoot, 'grammars');

// What's wrong with a laid-out view: an arrow pointing up that isn't a back edge, boxes overlapping,
// a box outside the open box holding it.
function layoutProblems(scene: LaidScene): string[] {
  const problems: string[] = [];
  const byId = new Map(scene.boxes.map((b) => [b.id, b]));
  for (const arrow of scene.arrows) {
    if (arrow.back || arrow.cycle) continue;
    const [start, end] = [arrow.points[0], arrow.points.at(-1)!];
    const down = laidOutReversed(arrow) ? start.y >= end.y - 0.5 : end.y >= start.y - 0.5;
    if (!down) problems.push(`${arrow.id} points ${laidOutReversed(arrow) ? 'down, away from the parent' : 'up'}`);
  }
  const siblings = new Map<string, LaidScene['boxes']>();
  for (const box of scene.boxes) siblings.set(box.parent ?? '', [...(siblings.get(box.parent ?? '') ?? []), box]);
  for (const group of siblings.values()) {
    for (const [i, a] of group.entries()) {
      for (const b of group.slice(i + 1)) {
        if (!(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y)) problems.push(`${a.id} and ${b.id} overlap`);
      }
    }
  }
  for (const box of scene.boxes) {
    const parent = box.parent ? byId.get(box.parent) : undefined;
    if (parent && !(box.x >= parent.x - 0.5 && box.y >= parent.y - 0.5 && box.x + box.width <= parent.x + parent.width + 0.5 && box.y + box.height <= parent.y + parent.height + 0.5)) {
      problems.push(`${box.id} is outside ${parent.id}`);
    }
  }
  return problems;
}

// The fastest of up to three runs, stopping at the first within `limit` ms: a time measured while
// other test files build C++ and Java beside this one is the machine's, not the index's.
async function fastest<T extends { milliseconds: number }>(limit: number, run: () => Promise<T>): Promise<T> {
  let best = await run();
  for (let i = 1; i < 3 && best.milliseconds >= limit; i++) {
    const next = await run();
    if (next.milliseconds < best.milliseconds) best = next;
  }
  return best;
}

// Everything open: every project and folder (and in the structure view, every file and namespace),
// past the limits.
function allOpen(index: CodeIndex, structure: boolean): string[] {
  return index.entities.filter((e) => e.kind === 'project' || e.kind === 'module'
    || (structure && (e.kind === 'file' || e.kind === 'graph-file' || (e.kind === 'type' && e.detail === 'namespace')))).map((e) => e.id);
}

describe("the Codebase Map's exit check", () => {
  let parser: ParseService;
  let layout: MapLayout;
  let workDir: string;
  before(() => {
    parser = new ParseService(grammarDir);
    layout = new MapLayout();
    workDir = corpusWorkDir();
  });
  after(async () => {
    await layout.dispose();
    await parser.dispose();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  for (const l of LAYOUTS) {
    test(`${l.name}: its architecture, call flow and structure, laid out top to bottom`, async () => {
      const { root, result } = await prepareLayout(l, workDir);
      assert.deepEqual(result.compileErrors, []);
      // (Its first index: nothing cached.)
      const { index, files, milliseconds } = await fastest(5000, () => indexFolder(root, { parser }));
      assert.ok(milliseconds < 5000, `${l.name}: ${files} files indexed in ${Math.round(milliseconds)} ms`);

      // The architecture: its projects and folders, and the imports between its files.
      const open = allOpen(index, false);
      const architecture = buildScene(index, { mode: 'architecture', expanded: open, unlimited: open });
      const shown = new Set(architecture.boxes.map((b) => b.id));
      for (const e of index.entities) if (e.kind === 'project' || e.kind === 'module') assert.ok(shown.has(e.id), `${l.name}: ${e.id} is on the map`);
      const imports = new Set(architecture.arrows.filter((a) => a.kind === 'imports').map((a) => `${a.from} > ${a.to}`));
      for (const edge of EXPECTED[l.name].imports) {
        const [from, to] = edge.split(' > ');
        assert.ok(imports.has(`${id(from)} > ${id(to)}`), `${l.name}: the architecture shows ${edge}`);
      }

      // The call flow from the entry points reaches the graphs and the functions they call. (The
      // calls from an entry point or a graph; CALLS has others for the index.)
      const calls = buildCallScene(index, { mode: 'calls', expanded: [], calls: { depth: MAX_CALL_DEPTH } });
      assert.ok(calls.calls && calls.calls.starts > 0 && !calls.calls.uncalled, `${l.name}: the call flow starts from entry points`);
      const entries = new Set(index.entities.filter((e) => e.entries?.length).map((e) => e.id));
      let fromEntries = 0;
      for (const edge of CALLS[l.name]) {
        const [from, to] = edge.split(' > ');
        if (!from.startsWith('g:') && !entries.has(from)) continue;
        const found = calls.arrows.some((a) => a.to === to && (from.endsWith('*') ? a.from.startsWith(from.slice(0, -1)) : a.from === from));
        assert.ok(found, `${l.name}: the call flow from the entry points shows ${edge}`);
        if (!from.startsWith('g:')) fromEntries++;
      }
      // Each layout's own program is one of them (a library's, its graphs' events).
      assert.ok(fromEntries > 0 || CALLS[l.name].every((edge) => edge.startsWith('g:')), `${l.name}: a call from its entry point is checked`);

      // The structure: types point at their parents.
      const opened = allOpen(index, true);
      const structure = buildScene(index, { mode: 'structure', expanded: opened, unlimited: opened });
      for (const edge of INHERITS[l.name] ?? []) {
        const [from, to] = edge.split(' > ');
        assert.ok(structure.arrows.some((a) => a.kind === 'inherits' && a.from === from && a.to === to), `${l.name}: the structure shows ${edge}`);
      }

      for (const [view, scene] of [['architecture', architecture], ['structure', structure], ['call flow', calls]] as const) {
        const laid = await layout.layout(scene);
        assert.ok(laid.boxes.length > 0, `${l.name}: the ${view} has boxes`);
        assert.deepEqual(layoutProblems(laid), [], `${l.name}: the ${view}`);
      }
    });
  }

  for (const c of FLOW_CASES) {
    test(`the control flow of a function in ${c.grammar}, laid out top to bottom, its loop coming back up`, async () => {
      const chart = await parser.flow(c.grammar, c.code, c.line);
      assert.ok(chart);
      const scene = buildFlowScene(chart, [], { id: 's:total', label: chart.name, path: 'total', line: chart.line });
      assert.ok(scene.arrows.some((a) => a.back), 'a back edge');
      const laid = await layout.layout(scene);
      assert.deepEqual(layoutProblems(laid), []);
      // The start at the top, the end at the bottom.
      const start = laid.boxes.find((b) => b.flowKind === 'start')!;
      const end = laid.boxes.find((b) => b.flowKind === 'end')!;
      assert.ok(laid.boxes.every((b) => b.y >= start.y && b.y <= end.y), 'between the start and the end');
    });
  }

  test('scale: this repository in under 5 seconds cold, and a changed file in under a second', async (t) => {
    const cold = await fastest(5000, () => indexFolder(repoRoot, { parser }));
    assert.ok(cold.files > 300, `${cold.files} files`);
    assert.ok(cold.milliseconds < 5000, `this repository: ${cold.files} files in ${Math.round(cold.milliseconds)} ms`);

    // A change: the index is built again from the cache, parsing only the changed file. (In a copy of
    // this repository's code, left as it is.)
    const cache = new JsonFactsCache(path.join(workDir, 'scale-cache.json'), factsVersion(grammarDir));
    const copy = fs.mkdtempSync(path.join(workDir, 'scale-repo-'));
    for (const name of fs.readdirSync(repoRoot)) {
      if (/^(\.|node_modules$|out$|dist$|grammars$)/.test(name)) continue;
      fs.cpSync(path.join(repoRoot, name), path.join(copy, name), { recursive: true, filter: (p) => !/[\\/](node_modules|\.vscode-test|out|dist)$/.test(p) });
    }
    const first = await indexFolder(copy, { parser, cache });
    assert.ok(first.files >= cold.files * 0.9, `the copy has ${first.files} files`);
    // (Each try changes the file again.)
    let change = 0;
    const warm = await fastest(1000, async () => {
      fs.appendFileSync(path.join(copy, 'src/core/codemap/hover.ts'), `\nexport function changed${++change}(): number {\n  return 1;\n}\n`);
      const result = await indexFolder(copy, { parser, cache });
      assert.equal(result.parsed, 1);
      assert.ok(result.index.entities.some((e) => e.id === `s:src/core/codemap/hover.ts#changed${change}`));
      return result;
    });
    assert.ok(warm.milliseconds < 1000, `a changed file: ${warm.files} files in ${Math.round(warm.milliseconds)} ms`);
    t.diagnostic(`this repository's ${cold.files} files cold in ${Math.round(cold.milliseconds)} ms; a changed file in ${Math.round(warm.milliseconds)} ms`);
  });
});
