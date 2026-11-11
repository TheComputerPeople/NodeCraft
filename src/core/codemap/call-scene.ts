// The Codebase Map's call flow (docs/codebase-map.md, Part 3): from a function (or graph, or file's
// top level), the calls it makes, a few levels at a time, flowing down; or ("callers") everything
// that reaches it, from above; or both (focus: its callers above it, its calls below). Without a
// function chosen, from every entry point. Or the path of calls from one box to another. Arrows
// always run from caller to callee, so callers sit above what they call. Pure, like scene.ts.
import { CodeIndex, Entity } from './code-index';
import { filterOptions, hiddenBy } from './find';
import type { CallEdge } from './calls';
import { CallDirection, CallFlowContext, MapView, Scene, SceneArrow, SceneBox, liftArrows, markCycles } from './scene';

export type { CallDirection } from './scene';

// Each start is explored this many levels at first (unless the view says how many, up to
// MAX_CALL_DEPTH); opening a box explores one more from it.
export const CALL_DEPTH = 2;
export const MAX_CALL_DEPTH = 6;
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
  const root = view.calls?.root && byId.has(view.calls.root) ? view.calls.root : undefined;
  // Both ways needs a box to look both ways from.
  const direction: CallDirection = view.calls?.direction === 'both' && !root ? 'callees' : view.calls?.direction ?? 'callees';
  const depthLimit = Math.max(1, Math.min(MAX_CALL_DEPTH, Math.round(view.calls?.depth ?? CALL_DEPTH)));
  const opened = new Set(view.calls?.explored ?? []);
  // The calls out of and into each box. A graph file leads into its graphs: what calls the file runs
  // them, and their calls are the graphs'.
  const graphsOf = new Map<string, string[]>();
  for (const e of index.entities) if (e.kind === 'graph' && e.parent) graphsOf.set(e.parent, [...(graphsOf.get(e.parent) ?? []), e.id]);
  const holds: CallEdge[] = [];
  for (const [file, graphs] of graphsOf) {
    const entity = byId.get(file);
    if (!entity) continue;
    for (const graph of graphs) holds.push({ from: file, to: graph, path: entity.path ?? '', line: 0, column: 0, count: 1, certain: true });
  }
  const out = new Map<string, CallEdge[]>();
  const into = new Map<string, CallEdge[]>();
  for (const call of [...index.calls, ...holds]) {
    out.set(call.from, [...(out.get(call.from) ?? []), call]);
    into.set(call.to, [...(into.get(call.to) ?? []), call]);
  }
  const path = view.calls?.path && byId.has(view.calls.path.from) && byId.has(view.calls.path.to) ? view.calls.path : undefined;
  if (path) return pathScene(index, view, byId, out, into, path.from, path.to);

  // The starts: the chosen function, or the entry points.
  // (A graph file whose graphs are entry points starts from those graphs.)
  const startsFromGraphs = (e: Entity) => e.kind === 'graph-file' && (graphsOf.get(e.id) ?? []).some((g) => byId.get(g)?.entries?.length);
  const firstEdges = direction === 'callers' ? into : out;
  const startable = (e: Entity) => byId.has(e.id) && canStartCallFlow(e) && (firstEdges.get(e.id)?.length ?? 0) > 0;
  let starts = root ? [root] : index.entities
    .filter((e) => e.entries?.length && startable(e) && !startsFromGraphs(e))
    .slice(0, MAX_ENTRY_STARTS).map((e) => e.id);
  // A folder without entry points (a library): from what nothing in it calls, as its users would.
  const fromUncalled = !root && !starts.length;
  if (fromUncalled) {
    starts = index.entities.filter((e) => startable(e) && !into.get(e.id)?.length).slice(0, MAX_ENTRY_STARTS).map((e) => e.id);
  }
  // Breadth first, each way the flow goes: each start to so many levels; an opened box one further.
  const level = new Map<string, number>(starts.map((s) => [s, 0]));
  const explored = new Set<string>();
  // The boxes explored each way, and how many calls each box has left to show.
  const exploredOut = new Set<string>();
  const exploredIn = new Set<string>();
  const explore = (edges: Map<string, CallEdge[]>, next: (call: CallEdge) => string, done: Set<string>): Map<string, number> => {
    const reached = new Map<string, number>(starts.map((s) => [s, 0]));
    const queue = [...starts];
    while (queue.length) {
      const id = queue.shift()!;
      const depth = reached.get(id)!;
      if (depth >= depthLimit && !opened.has(id)) continue;
      if (done.has(id)) continue;
      done.add(id);
      explored.add(id);
      for (const call of edges.get(id) ?? []) {
        const other = next(call);
        // Only what the index has (a call to something missing isn't drawn).
        if (reached.has(other) || !byId.has(other)) continue;
        if (level.size >= MAX_CALL_BOXES && !level.has(other)) break;
        reached.set(other, depth + 1);
        if (!level.has(other)) level.set(other, depth + 1);
        queue.push(other);
      }
    }
    return reached;
  };
  const below = direction !== 'callers' ? explore(out, (call) => call.to, exploredOut) : new Map<string, number>();
  if (direction !== 'callees') explore(into, (call) => call.from, exploredIn);
  // What a box has left to show, the way it was reached: its calls not explored yet (a box below the
  // start), or its callers (one above). The start, both ways, has shown both.
  const leftOf = (id: string): number => {
    if (id === root && direction === 'both') return 0;
    return below.has(id) ? (exploredOut.has(id) ? 0 : out.get(id)?.length ?? 0) : (exploredIn.has(id) ? 0 : into.get(id)?.length ?? 0);
  };

  const boxes: SceneBox[] = [];
  for (const [id, depth] of level) {
    const entity = byId.get(id);
    if (!entity) continue;
    // A box not explored yet says how many calls it has left to show; one the user opened can close.
    const further = leftOf(id);
    const firstEntry = entity.entries?.[0];
    boxes.push({
      id, label: labelOf(entity), kind: entity.kind, detail: whereOf(entity, byId),
      ...(entity.language ? { language: entity.language } : {}),
      count: further, expandable: further > 0 || (opened.has(id) && depth >= depthLimit), expanded: opened.has(id) && explored.has(id) && depth >= depthLimit,
      ...(firstEntry ? { entry: firstEntry.name ? `${firstEntry.kind}: ${firstEntry.name}` : firstEntry.kind } : {}),
      ...(entity.path ? { path: entity.path } : {}), ...(entity.line ? { line: entity.line } : {}),
      ...(id === root ? { root: true } : {})
    });
  }
  // The arrows of the explored boxes' calls (and callers), between boxes shown, caller to callee.
  const arrows: SceneArrow[] = [];
  const seen = new Set<string>();
  const arrowsOf = (ids: Set<string>, edges: Map<string, CallEdge[]>): void => {
    for (const id of ids) {
      for (const call of edges.get(id) ?? []) {
        if (!level.has(call.from) || !level.has(call.to)) continue;
        const arrowId = `calls:${call.from}>${call.to}`;
        if (seen.has(arrowId)) continue;
        seen.add(arrowId);
        arrows.push({ id: arrowId, from: call.from, to: call.to, kind: 'calls', weight: call.count, certain: call.certain });
      }
    }
  };
  arrowsOf(exploredOut, out);
  arrowsOf(exploredIn, into);
  // Calls left unresolved (too many candidates): a "?" box under the explored box that made them.
  if (direction !== 'callers') {
    for (const u of index.unresolvedCalls) {
      if (!exploredOut.has(u.from) || boxes.length >= MAX_CALL_BOXES || hidden.has(u.from)) continue;
      const id = `unresolved:${u.from}>${u.callee}`;
      if (seen.has(id)) continue;
      seen.add(id);
      boxes.push({ id, label: `${u.callee}?`, kind: 'unresolved', detail: `one of ${u.candidates}`, count: 0, expandable: false, expanded: false, path: u.path, line: u.line });
      arrows.push({ id: `calls:${u.from}>${id}`, from: u.from, to: id, kind: 'calls', weight: 1, certain: false });
    }
  }
  return finish(index, view, byId, boxes, arrows, { direction, ...(root ? { root, rootLabel: labelOf(byId.get(root)!) } : {}), ...(fromUncalled && starts.length ? { uncalled: true } : {}), starts: starts.length, depth: depthLimit });
}

// The calls that lead from one box to another: every box on a shortest path of calls between them
// (from the second to the first, if none leads from the first).
function pathScene(
  index: CodeIndex, view: MapView, byId: Map<string, Entity>, out: Map<string, CallEdge[]>, into: Map<string, CallEdge[]>, first: string, second: string
): Scene {
  const distances = (start: string, edges: Map<string, CallEdge[]>, next: (call: CallEdge) => string): Map<string, number> => {
    const distance = new Map([[start, 0]]);
    const queue = [start];
    while (queue.length) {
      const id = queue.shift()!;
      for (const call of edges.get(id) ?? []) {
        const other = next(call);
        if (distance.has(other) || !byId.has(other)) continue;
        distance.set(other, distance.get(id)! + 1);
        queue.push(other);
      }
    }
    return distance;
  };
  let [from, to] = [first, second];
  let fromStart = distances(from, out, (c) => c.to);
  if (!fromStart.has(to)) {
    const back = distances(to, out, (c) => c.to);
    if (back.has(from)) [from, to, fromStart] = [second, first, back];
  }
  const length = fromStart.get(to);
  const onPath = new Set<string>([from, to]);
  const arrows: SceneArrow[] = [];
  if (length !== undefined) {
    const toEnd = distances(to, into, (c) => c.from);
    for (const [id, d] of fromStart) {
      if (d + (toEnd.get(id) ?? Infinity) === length && onPath.size < MAX_CALL_BOXES) onPath.add(id);
    }
    const seen = new Set<string>();
    for (const id of onPath) {
      for (const call of out.get(id) ?? []) {
        if (!onPath.has(call.to) || fromStart.get(call.to) !== fromStart.get(id)! + 1 || toEnd.get(call.to) !== toEnd.get(id)! - 1) continue;
        const arrowId = `calls:${call.from}>${call.to}`;
        if (seen.has(arrowId)) continue;
        seen.add(arrowId);
        arrows.push({ id: arrowId, from: call.from, to: call.to, kind: 'calls', weight: call.count, certain: call.certain });
      }
    }
  }
  const boxes: SceneBox[] = [...onPath].map((id) => {
    const entity = byId.get(id)!;
    const firstEntry = entity.entries?.[0];
    return {
      id, label: labelOf(entity), kind: entity.kind, detail: whereOf(entity, byId), ...(entity.language ? { language: entity.language } : {}),
      count: 0, expandable: false, expanded: false,
      ...(firstEntry ? { entry: firstEntry.name ? `${firstEntry.kind}: ${firstEntry.name}` : firstEntry.kind } : {}),
      ...(entity.path ? { path: entity.path } : {}), ...(entity.line ? { line: entity.line } : {}),
      ...(id === from || id === to ? { root: true } : {})
    };
  });
  return finish(index, view, byId, boxes, arrows, {
    direction: 'callees', starts: 1, depth: length ?? 0,
    path: { from, to, fromLabel: labelOf(byId.get(from)!), toLabel: labelOf(byId.get(to)!), ...(length !== undefined ? { length } : {}) }
  });
}

// Groups the boxes by file, lifts the arrows and marks cycles.
function finish(index: CodeIndex, view: MapView, byId: Map<string, Entity>, boxes: SceneBox[], arrows: SceneArrow[], calls: CallFlowContext): Scene {
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
  return { mode: 'calls', boxes, arrows, lifted, options: filterOptions(index), ...(view.filters ? { filters: view.filters } : {}), calls };
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
