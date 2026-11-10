// The Codebase Map's call flow (docs/codebase-map.md, Part 3): from a function (or graph, or file's
// top level), the calls it makes, a few levels at a time, flowing down; or ("callers") everything
// that reaches it, from above. Without a function chosen, from every entry point. Arrows always run
// from caller to callee, so callers sit above what they call either way. Pure, like scene.ts.
import { CodeIndex, Entity } from './code-index';
import { filterOptions, hiddenBy } from './find';
import type { CallEdge } from './calls';
import { MapView, Scene, SceneArrow, SceneBox, liftArrows, markCycles } from './scene';

export type CallDirection = 'callees' | 'callers';

// Each start is explored this many levels at first; opening a box explores one more from it.
export const CALL_DEPTH = 2;
// At most this many boxes; past it, a box's further calls are left to open.
export const MAX_CALL_BOXES = 400;
// Without a chosen function, at most this many entry points start the flow.
export const MAX_ENTRY_STARTS = 40;

const CALLABLE_KINDS = new Set(['function', 'graph', 'graph-file', 'type', 'file']);

// Whether the call flow can start from an entity (functions, types' constructors, graphs, files' top levels).
export function canStartCallFlow(entity: Entity | undefined): boolean {
  return !!entity && CALLABLE_KINDS.has(entity.kind);
}

export function buildCallScene(index: CodeIndex, view: MapView): Scene {
  const hidden = hiddenBy(index, view.filters);
  const byId = new Map(index.entities.filter((e) => !hidden.has(e.id)).map((e) => [e.id, e]));
  const direction: CallDirection = view.calls?.direction ?? 'callees';
  const root = view.calls?.root && byId.has(view.calls.root) ? view.calls.root : undefined;
  const opened = new Set(view.calls?.explored ?? []);
  // The calls out of (or, for callers, into) each box. A graph file leads into its graphs: what calls
  // the file runs them, and their calls are the graphs'.
  const graphsOf = new Map<string, string[]>();
  for (const e of index.entities) if (e.kind === 'graph' && e.parent) graphsOf.set(e.parent, [...(graphsOf.get(e.parent) ?? []), e.id]);
  const holds: CallEdge[] = [];
  for (const [file, graphs] of graphsOf) {
    const entity = byId.get(file)!;
    for (const graph of graphs) holds.push({ from: file, to: graph, path: entity.path ?? '', line: 0, column: 0, count: 1, certain: true });
  }
  const edges = new Map<string, CallEdge[]>();
  for (const call of [...index.calls, ...holds]) {
    const key = direction === 'callees' ? call.from : call.to;
    edges.set(key, [...(edges.get(key) ?? []), call]);
  }
  const next = (call: CallEdge) => (direction === 'callees' ? call.to : call.from);

  // The starts: the chosen function, or the entry points.
  // (A graph file whose graphs are entry points starts from those graphs.)
  const startsFromGraphs = (e: Entity) => e.kind === 'graph-file' && (graphsOf.get(e.id) ?? []).some((g) => byId.get(g)?.entries?.length);
  const starts = root ? [root] : index.entities
    .filter((e) => byId.has(e.id) && e.entries?.length && canStartCallFlow(e) && !startsFromGraphs(e) && (edges.get(e.id)?.length ?? 0) > 0)
    .slice(0, MAX_ENTRY_STARTS).map((e) => e.id);
  // Breadth first: each start to CALL_DEPTH levels; an opened box one level further.
  const level = new Map<string, number>(starts.map((s) => [s, 0]));
  const explored = new Set<string>();
  const queue = [...starts];
  while (queue.length) {
    const id = queue.shift()!;
    const depth = level.get(id)!;
    if (depth >= CALL_DEPTH && !opened.has(id)) continue;
    if (explored.has(id)) continue;
    explored.add(id);
    for (const call of edges.get(id) ?? []) {
      const other = next(call);
      // Only what the index has (a call to something missing isn't drawn).
      if (level.has(other) || !byId.has(other)) continue;
      if (level.size >= MAX_CALL_BOXES) break;
      level.set(other, depth + 1);
      queue.push(other);
    }
  }

  const boxes: SceneBox[] = [];
  for (const [id, depth] of level) {
    const entity = byId.get(id);
    if (!entity) continue;
    // A box not explored yet says how many calls it has left to show; one the user opened can close.
    const further = explored.has(id) ? 0 : edges.get(id)?.length ?? 0;
    const firstEntry = entity.entries?.[0];
    boxes.push({
      id, label: labelOf(entity), kind: entity.kind, detail: whereOf(entity, byId),
      ...(entity.language ? { language: entity.language } : {}),
      count: further, expandable: further > 0 || (opened.has(id) && depth >= CALL_DEPTH), expanded: opened.has(id) && explored.has(id) && depth >= CALL_DEPTH,
      ...(firstEntry ? { entry: firstEntry.name ? `${firstEntry.kind}: ${firstEntry.name}` : firstEntry.kind } : {}),
      ...(entity.path ? { path: entity.path } : {}), ...(entity.line ? { line: entity.line } : {}),
      ...(id === root ? { root: true } : {})
    });
  }
  // The arrows of the explored boxes' calls, between boxes shown, caller to callee.
  const arrows: SceneArrow[] = [];
  const seen = new Set<string>();
  for (const id of explored) {
    for (const call of edges.get(id) ?? []) {
      if (!level.has(call.from) || !level.has(call.to)) continue;
      const arrowId = `calls:${call.from}>${call.to}`;
      if (seen.has(arrowId)) continue;
      seen.add(arrowId);
      arrows.push({ id: arrowId, from: call.from, to: call.to, kind: 'calls', weight: call.count, certain: call.certain });
    }
  }
  // Calls left unresolved (too many candidates): a "?" box under the explored box that made them.
  if (direction === 'callees') {
    for (const u of index.unresolvedCalls) {
      if (!explored.has(u.from) || boxes.length >= MAX_CALL_BOXES || hidden.has(u.from)) continue;
      const id = `unresolved:${u.from}>${u.callee}`;
      if (seen.has(id)) continue;
      seen.add(id);
      boxes.push({ id, label: `${u.callee}?`, kind: 'unresolved', detail: `one of ${u.candidates}`, count: 0, expandable: false, expanded: false, path: u.path, line: u.line });
      arrows.push({ id: `calls:${u.from}>${id}`, from: u.from, to: id, kind: 'calls', weight: 1, certain: false });
    }
  }
  // Grouped by the file (or graph file) each is in, so calls within a file stay together and calls
  // between files read as arrows between them; a file's boxes pack into rows.
  const groups = new Map<string, Entity>();
  for (const box of boxes) {
    const home = homeOf(box.id, byId) ?? (box.kind === 'unresolved' ? homeOf(box.id.slice('unresolved:'.length).split('>')[0], byId) : undefined);
    if (!home) continue;
    const group = `in:${home.id}`;
    if (!groups.has(group)) groups.set(group, home);
    box.parent = group;
  }
  boxes.unshift(...[...groups].map(([id, home]): SceneBox => ({
    id, label: labelOf(home).replace(/^new /, ''), kind: home.kind, ...(home.path ? { path: home.path } : {}), ...(home.language ? { language: home.language } : {}),
    count: 0, expandable: false, expanded: true
  })));
  const lifted = liftArrows(boxes, arrows);
  // Recursion and calls that come back round: their boxes and arrows are marked as cycles.
  markCycles(boxes, lifted, 'calls');
  return {
    mode: 'calls', boxes, arrows, lifted, options: filterOptions(index), ...(view.filters ? { filters: view.filters } : {}),
    calls: { direction, ...(root ? { root, rootLabel: labelOf(byId.get(root)!) } : {}), starts: starts.length }
  };
}

// The file or graph file an entity is in (a file or graph file is in itself).
function homeOf(id: string, byId: Map<string, Entity>): Entity | undefined {
  for (let e = byId.get(id); e; e = e.parent ? byId.get(e.parent) : undefined) {
    if (e.kind === 'file' || e.kind === 'graph-file') return e;
  }
  return undefined;
}

function labelOf(entity: Entity): string {
  return entity.kind === 'graph-file' ? entity.name.replace(/\.vgraph$/, '') : entity.kind === 'type' ? `new ${entity.name}` : entity.name;
}

// Where an entity lives: its type and file ("Counter · features.ts"), or a graph's file.
function whereOf(entity: Entity, byId: Map<string, Entity>): string {
  const parts: string[] = [];
  for (let p = entity.parent ? byId.get(entity.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) {
    if (p.kind === 'type' || p.kind === 'graph-file') parts.push(p.kind === 'graph-file' ? p.name.replace(/\.vgraph$/, '') : p.name);
    if (p.kind === 'file' || p.kind === 'graph-file') {
      if (p.kind === 'file') parts.push(p.name);
      break;
    }
  }
  if (entity.kind === 'file') return 'top level';
  return parts.join(' · ') || entity.detail || entity.kind;
}
