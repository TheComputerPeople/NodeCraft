// What the Codebase Map shows (docs/codebase-map.md, Part 3): the boxes of the index that are in view
// (every box whose parents are all open) and the arrows between them, in one of the map's views.
// Arrows between hidden boxes are summed onto their nearest visible boxes, with how many they stand
// for, and lifted to the boxes that hold their ends side by side, which is what the map draws. Pure:
// the extension lays the scene out (ELK, map-layout.ts) and the map's webview draws it.
import { CodeIndex, Entity, EntityKind } from './code-index';
import type { FlowContext } from './flow-scene';
import { MapFilters, filterOptions, hiddenBy } from './find';

// architecture: projects, folders and files, with their imports (importers above what they import);
// structure: the types in them with their members, and inheritance (parents above children);
// calls: the call flow from a function or the entry points (call-scene.ts); flow: one function's
// control flow (flow-scene.ts).
export type MapMode = 'architecture' | 'structure' | 'calls' | 'flow';

export interface MapView {
  mode?: MapMode;
  // The call flow's start (absent: the entry points), its direction, how many levels it goes at
  // first, and the boxes opened in it; or the path of calls between two boxes.
  calls?: { root?: string; direction?: CallDirection; depth?: number; explored?: string[]; path?: { from: string; to: string } };
  // The function whose control flow is shown.
  flow?: { id: string };
  // What's hidden (languages, projects, external packages, tests).
  filters?: MapFilters;
  // Boxes the user opened.
  expanded: string[];
  // Boxes whose children are all shown, past the usual limit ("N more…" was opened).
  unlimited?: string[];
}

// unresolved: a call the index couldn't resolve (too many candidates), in the call flow; flow: a box
// of a flowchart.
export type BoxKind = EntityKind | 'externals' | 'more' | 'unresolved' | 'flow';

export interface SceneBox {
  id: string;
  parent?: string;
  label: string;
  kind: BoxKind;
  // What it is beyond its kind ("class", "function", a build system), for a second line.
  detail?: string;
  language?: string;
  // How many boxes are inside it, at every depth (what opening it would show).
  count: number;
  expandable: boolean;
  expanded: boolean;
  // An entry point (main, a test, a handler, a graph's Start…).
  entry?: string;
  path?: string;
  line?: number;
  // A type's members (the structure view), or a graph file's graphs, listed in its box.
  members?: string[];
  // In an import cycle with boxes beside it (in the call flow: recursion, calls that come back round).
  cycle?: boolean;
  // The call flow's start.
  root?: boolean;
  // A flowchart's box: what it is (decision, loop, return…), and the calls made on its lines.
  flowKind?: string;
  calls?: { label: string; id?: string }[];
}

// callees: the calls made, flowing down; callers: what reaches it, from above; both: its callers
// above it and its calls below (focus).
export type CallDirection = 'callees' | 'callers' | 'both';

// What the call flow shows: its direction, its start (absent: the entry points), how many starts, how
// many levels; or the path between two boxes (`length`: how many calls long; absent: none found).
export interface CallFlowContext {
  direction: CallDirection;
  root?: string;
  rootLabel?: string;
  starts: number;
  // Started from what nothing calls, the folder having no entry points.
  uncalled?: boolean;
  depth: number;
  path?: { from: string; to: string; fromLabel: string; toLabel: string; length?: number };
}

export type ArrowKind = 'imports' | 'calls' | 'inherits' | 'flow';

export interface SceneArrow {
  id: string;
  // For inheritance, the child; `to`, its parent.
  from: string;
  to: string;
  kind: ArrowKind;
  // How many relations of the index it stands for.
  weight: number;
  // False when any of them is a guess (an ambiguous call).
  certain: boolean;
  // A flowchart's arrow: its label (true, false, a case, loop, done, exception), and whether it goes
  // back up (a loop's return, continue).
  label?: string;
  back?: boolean;
}

// An arrow lifted to the boxes holding its ends side by side, in their nearest common open box.
export interface LiftedArrow extends SceneArrow {
  // The open box both ends are in ("" for the map itself).
  container: string;
  // Part of an import cycle among the boxes in its container.
  cycle?: boolean;
}

// What the filters can choose from: the languages and projects present.
export interface FilterOptions {
  languages: string[];
  projects: { id: string; label: string }[];
}

export interface Scene {
  mode: MapMode;
  calls?: CallFlowContext;
  flow?: FlowContext;
  options?: FilterOptions;
  filters?: MapFilters;
  boxes: SceneBox[];
  // Every arrow between the boxes that show its ends.
  arrows: SceneArrow[];
  // What the map draws: the arrows lifted and summed.
  lifted: LiftedArrow[];
}

// A box shows at most this many children before "N more…", unless opened past it.
export const MAX_CHILDREN = 60;
// The whole map shows at most this many boxes: past it, the rest fold into "N more…".
export const MAX_BOXES = 1500;
// A type's box lists this many members, then "+N more".
export const MAX_MEMBERS = 12;

const EXTERNALS = 'externals';
const CONTAINERS = new Set<BoxKind>(['project', 'module', 'externals']);
const CALLABLE = new Set(['function', 'method', 'constructor']);

// The view a folder's map opens with: the architecture, its projects open when there are a few.
export function defaultView(index: CodeIndex): MapView {
  const projects = index.entities.filter((e) => e.kind === 'project');
  return { mode: 'architecture', expanded: projects.length <= 3 ? projects.map((p) => p.id) : [] };
}

// Whether an entity holds others as boxes in a view: projects, folders and external packages
// always; files in the structure view (their types and functions); namespaces there too. A type
// lists its members instead, and a graph file its graphs.
function opensInto(e: Entity | undefined, kind: BoxKind, mode: MapMode): boolean {
  if (CONTAINERS.has(kind)) return true;
  if (mode === 'architecture') return false;
  if (kind === 'file') return true;
  return kind === 'type' && e?.detail === 'namespace';
}

export function buildScene(index: CodeIndex, view: MapView): Scene {
  const mode = view.mode ?? 'architecture';
  const expanded = new Set(view.expanded);
  const unlimited = new Set(view.unlimited ?? []);
  const byId = new Map(index.entities.map((e) => [e.id, e]));
  // Externals go in one box of their own.
  const parentOf = (e: Entity): string | undefined => e.parent ?? (e.kind === 'external' ? EXTERNALS : undefined);
  const children = new Map<string, Entity[]>();
  const roots: Entity[] = [];
  const hidden = hiddenBy(index, view.filters);
  for (const e of index.entities) {
    if (hidden.has(e.id)) continue;
    const parent = parentOf(e);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), e]);
    else roots.push(e);
  }
  const boxKids = (e: Entity | undefined, id: string, kind: BoxKind): Entity[] => (opensInto(e, kind, mode) ? children.get(id) ?? [] : []);
  // How many boxes are inside each one, in this view.
  const counts = new Map<string, number>();
  const countOf = (id: string): number => {
    const known = counts.get(id);
    if (known !== undefined) return known;
    const e = byId.get(id);
    const total = boxKids(e, id, id === EXTERNALS ? 'externals' : e!.kind).reduce((sum, c) => sum + 1 + countOf(c.id), 0);
    counts.set(id, total);
    return total;
  };

  const boxes: SceneBox[] = [];
  // The visible box each entity is shown as (itself, or its nearest visible ancestor).
  const shownAs = new Map<string, string>();
  let budget = MAX_BOXES;
  const show = (e: Entity | { id: string; kind: 'externals'; name: string }, parent?: string): void => {
    const isExternals = e.kind === 'externals';
    const entity = isExternals ? undefined : e as Entity;
    const kind: BoxKind = isExternals ? 'externals' : entity!.kind;
    const kids = boxKids(entity, e.id, kind);
    const open = expanded.has(e.id) && kids.length > 0;
    const firstEntry = entity?.entries?.[0];
    const members = mode === 'structure' && (kind === 'type' || kind === 'graph-file') && !opensInto(entity, kind, mode) ? membersOf(children.get(e.id) ?? []) : undefined;
    boxes.push({
      id: e.id, ...(parent ? { parent } : {}), label: labelOf(entity, e), kind,
      ...(entity?.detail ? { detail: entity.detail } : {}), ...(entity?.language ? { language: entity.language } : {}),
      count: countOf(e.id), expandable: kids.length > 0, expanded: open,
      ...(firstEntry ? { entry: firstEntry.name ? `${firstEntry.kind}: ${firstEntry.name}` : firstEntry.kind } : {}),
      ...(entity?.path ? { path: entity.path } : {}), ...(entity?.line ? { line: entity.line } : {}),
      ...(members?.length ? { members } : {})
    });
    budget--;
    shownAs.set(e.id, e.id);
    if (!open) return;
    const limit = unlimited.has(e.id) ? Infinity : MAX_CHILDREN;
    const fits = Math.max(0, Math.min(kids.length, limit, budget));
    for (const child of kids.slice(0, fits)) show(child, e.id);
    const rest = kids.length - fits;
    if (rest > 0) {
      boxes.push({ id: `more:${e.id}`, parent: e.id, label: `${rest} more…`, kind: 'more', count: rest, expandable: true, expanded: false });
      budget--;
    }
  };
  for (const root of roots) show(root);
  if (children.has(EXTERNALS)) show({ id: EXTERNALS, kind: 'externals', name: 'External packages' });

  // Each entity's visible box: its own, else its nearest shown ancestor; none for a hidden one.
  const visibleOf = (id: string): string | undefined => {
    if (hidden.has(id)) return undefined;
    if (shownAs.has(id)) return shownAs.get(id);
    const e = byId.get(id);
    const parent = e ? parentOf(e) : undefined;
    const found = parent ? visibleOf(parent) : undefined;
    if (found) shownAs.set(id, found);
    return found;
  };
  const shown = new Map(boxes.map((b) => [b.id, b]));
  // Is `a` inside `b` (or `b` itself)?
  const inside = (a: string, b: string): boolean => {
    for (let id: string | undefined = a; id; id = shown.get(id)?.parent) if (id === b) return true;
    return false;
  };
  const arrows = new Map<string, SceneArrow>();
  const add = (kind: ArrowKind, from: string, to: string, certain: boolean): void => {
    const a = visibleOf(from);
    const b = visibleOf(to);
    // An arrow inside one box, or between a box and what it holds, isn't drawn.
    if (!a || !b || a === b || inside(a, b) || inside(b, a)) return;
    const id = `${kind}:${a}>${b}`;
    const existing = arrows.get(id);
    if (existing) {
      existing.weight++;
      existing.certain &&= certain;
    } else {
      arrows.set(id, { id, from: a, to: b, kind, weight: 1, certain });
    }
  };
  // Each view's relations: the architecture's imports, the structure's inheritance.
  if (mode === 'architecture') for (const i of index.imports) add('imports', i.from, i.to, true);
  if (mode === 'structure') for (const i of index.inherits) if (i.to) add('inherits', i.from, i.to, true);
  const sceneArrows = [...arrows.values()];
  const lifted = liftArrows(boxes, sceneArrows);
  markCycles(boxes, lifted, 'imports');
  return { mode, boxes, arrows: sceneArrows, lifted, options: filterOptions(index), ...(view.filters ? { filters: view.filters } : {}) };
}

// A type's members (its methods and nested types), or a graph file's graphs, for its box.
function membersOf(kids: Entity[]): string[] {
  const names = kids.map((k) => (k.kind === 'graph' ? k.name : CALLABLE.has(k.detail ?? '') || k.kind === 'function' ? `${k.name}()` : k.name));
  return names.length > MAX_MEMBERS ? [...names.slice(0, MAX_MEMBERS - 1), `+${names.length - MAX_MEMBERS + 1} more`] : names;
}

// Each arrow lifted to its ends' ancestors that sit side by side in their nearest common open box,
// summed per kind.
export function liftArrows(boxes: SceneBox[], arrows: SceneArrow[]): LiftedArrow[] {
  const parentOf = new Map(boxes.map((b) => [b.id, b.parent ?? '']));
  const chain = (id: string): string[] => {
    const ids = [id];
    for (let p = parentOf.get(id); p !== undefined; p = p === '' ? undefined : parentOf.get(p)) ids.push(p);
    return ids;
  };
  const lifted = new Map<string, LiftedArrow>();
  for (const arrow of arrows) {
    // A box's arrow to itself (recursion) stays as it is, in the box's own parent.
    if (arrow.from === arrow.to) {
      if (!lifted.has(arrow.id)) lifted.set(arrow.id, { ...arrow, container: parentOf.get(arrow.from) ?? '' });
      continue;
    }
    const a = chain(arrow.from);
    const bChain = chain(arrow.to);
    const b = new Set(bChain);
    const common = a.find((id) => b.has(id)) ?? '';
    const from = a[a.indexOf(common) - 1] ?? a[a.length - 1];
    const to = bChain[bChain.indexOf(common) - 1] ?? bChain[bChain.length - 1];
    // An arrow inside one box isn't drawn; a box's own arrow to itself (recursion) is.
    if (!from || !to || (from === to && arrow.from !== arrow.to)) continue;
    const id = `${arrow.kind}:${from}>${to}`;
    const entry = lifted.get(id);
    if (entry) {
      entry.weight += arrow.weight;
      entry.certain &&= arrow.certain;
    } else {
      lifted.set(id, { id, from, to, kind: arrow.kind, weight: arrow.weight, certain: arrow.certain, container: common });
    }
  }
  return [...lifted.values()];
}

// Cycles: among the boxes side by side, those whose arrows of a kind reach each other (Tarjan's
// strongly connected components): imports in the architecture, calls in the call flow (a function
// calling itself is one too). Their arrows, and the boxes, are marked.
export function markCycles(boxes: SceneBox[], lifted: LiftedArrow[], kind: ArrowKind): void {
  const imports = lifted.filter((a) => a.kind === kind);
  const out = new Map<string, string[]>();
  for (const a of imports) out.set(a.from, [...(out.get(a.from) ?? []), a.to]);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const component = new Map<string, number>();
  let counter = 0;
  let components = 0;
  const sizes: number[] = [];
  const connect = (v: string): void => {
    // Iterative, so a long chain of imports can't overflow the stack.
    const work: { v: string; next: number }[] = [{ v, next: 0 }];
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    while (work.length) {
      const frame = work[work.length - 1];
      const targets = out.get(frame.v) ?? [];
      if (frame.next < targets.length) {
        const w = targets[frame.next++];
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length) low.set(work[work.length - 1].v, Math.min(low.get(work[work.length - 1].v)!, low.get(frame.v)!));
      if (low.get(frame.v) === index.get(frame.v)) {
        let size = 0;
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          component.set(w, components);
          size++;
          if (w === frame.v) break;
        }
        sizes[components++] = size;
      }
    }
  };
  for (const v of out.keys()) if (!index.has(v)) connect(v);
  const selfLoops = new Set(imports.filter((a) => a.from === a.to).map((a) => a.from));
  const inCycle = (id: string) => (component.has(id) && sizes[component.get(id)!] > 1) || selfLoops.has(id);
  for (const a of imports) if (inCycle(a.from) && component.get(a.from) === component.get(a.to)) a.cycle = true;
  for (const box of boxes) if (inCycle(box.id)) box.cycle = true;
}

function labelOf(entity: Entity | undefined, e: { id: string; name?: string }): string {
  if (!entity) return (e as { name: string }).name;
  return entity.kind === 'graph-file' ? entity.name.replace(/\.vgraph$/, '') : entity.name;
}

// A scene laid out (top to bottom): every box's place and size and every arrow's points, absolute.
export interface LaidBox extends SceneBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidArrow extends SceneArrow {
  // ELK's route (orthogonal), or the two ends of a curve the map draws; from `from` to `to`.
  points: { x: number; y: number }[];
  cycle?: boolean;
}

export interface LaidScene {
  mode: MapMode;
  calls?: CallFlowContext;
  flow?: FlowContext;
  options?: FilterOptions;
  filters?: MapFilters;
  width: number;
  height: number;
  boxes: LaidBox[];
  // What the map draws: between boxes in one open box, the arrows of everything inside them summed
  // (so each level reads as what depends on what).
  arrows: LaidArrow[];
  // Every arrow of the scene between the boxes it joins: drawn for a box that's pointed at.
  details: LaidArrow[];
}

// A closed box's size: its name over a smaller second line, and a type's members below.
export function boxSize(box: SceneBox): { width: number; height: number } {
  // The name, with room for the toggle, the count and the open button beside it.
  const longest = Math.max(
    box.label.length + (box.expandable ? String(box.count).length + 3 : 0),
    (box.detail ?? '').length * 0.85,
    ...(box.members ?? []).map((m) => m.length * 0.9)
  );
  const members = box.members?.length ?? 0;
  if (box.kind === 'flow') {
    // A flowchart's box: its code at full width (up to a limit), and a row of its calls.
    const code = Math.max(box.label.length * 7.8, ...(box.members ?? []).map((m) => m.length * 7.2), (box.calls ?? []).reduce((w, c) => w + c.label.length * 7 + 22, 0));
    const short = box.flowKind === 'start' || box.flowKind === 'end' || box.flowKind === 'break' || box.flowKind === 'continue';
    return { width: Math.round(Math.min(520, Math.max(short ? 90 : 120, code + 32))), height: (box.detail ? 44 : 30) + (members ? members * 15 + 6 : 0) + (box.calls?.length ? 22 : 0) };
  }
  return { width: Math.round(Math.min(360, Math.max(110, longest * 7.8 + 60))), height: 48 + (members ? members * 15 + 6 : 0) };
}

// Whether an arrow runs against the layers: inheritance is laid out from the parent down to its
// children, so the map shows parents above children.
export function laidOutReversed(arrow: SceneArrow): boolean {
  return arrow.kind === 'inherits';
}
