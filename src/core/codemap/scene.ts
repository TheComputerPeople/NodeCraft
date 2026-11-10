// What the Codebase Map shows (docs/codebase-map.md, Part 3): the boxes of the index that are in view
// (every box whose parents are all expanded) and the arrows between them. Arrows between hidden
// boxes are summed onto their nearest visible boxes, with how many they stand for. Pure: the extension
// lays the scene out (ELK, map-layout.ts) and the map's webview draws it.
import { CodeIndex, Entity, EntityKind } from './code-index';

export interface MapView {
  // Boxes the user opened.
  expanded: string[];
  // Boxes whose children are all shown, past the usual limit ("N more…" was opened).
  unlimited?: string[];
}

export type BoxKind = EntityKind | 'externals' | 'more';

export interface SceneBox {
  id: string;
  parent?: string;
  label: string;
  kind: BoxKind;
  // What it is beyond its kind ("class", "function", a build system), for a second line.
  detail?: string;
  language?: string;
  // How many boxes are inside it, at every depth (what expanding it would show).
  count: number;
  expandable: boolean;
  expanded: boolean;
  // An entry point (main, a test, a handler, a graph's Start…).
  entry?: string;
  path?: string;
  line?: number;
}

export type ArrowKind = 'imports' | 'calls' | 'inherits';

export interface SceneArrow {
  id: string;
  from: string;
  to: string;
  kind: ArrowKind;
  // How many relations of the index it stands for.
  weight: number;
  // False when any of them is a guess (an ambiguous call).
  certain: boolean;
}

export interface Scene {
  boxes: SceneBox[];
  arrows: SceneArrow[];
}

// A box shows at most this many children before "N more…", unless opened past it.
export const MAX_CHILDREN = 60;
// The whole map shows at most this many boxes: past it, the rest fold into "N more…".
export const MAX_BOXES = 1500;

const EXTERNALS = 'externals';

// The view a folder's map opens with: its projects open when there are a few.
export function defaultView(index: CodeIndex): MapView {
  const projects = index.entities.filter((e) => e.kind === 'project');
  return { expanded: projects.length <= 3 ? projects.map((p) => p.id) : [] };
}

export function buildScene(index: CodeIndex, view: MapView): Scene {
  const expanded = new Set(view.expanded);
  const unlimited = new Set(view.unlimited ?? []);
  const byId = new Map(index.entities.map((e) => [e.id, e]));
  // Externals go in one box of their own.
  const parentOf = (e: Entity): string | undefined => e.parent ?? (e.kind === 'external' ? EXTERNALS : undefined);
  const children = new Map<string, Entity[]>();
  const roots: Entity[] = [];
  for (const e of index.entities) {
    const parent = parentOf(e);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), e]);
    else roots.push(e);
  }
  // How many boxes are inside each one.
  const counts = new Map<string, number>();
  const countOf = (id: string): number => {
    const known = counts.get(id);
    if (known !== undefined) return known;
    const total = (children.get(id) ?? []).reduce((sum, c) => sum + 1 + countOf(c.id), 0);
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
    const kids = children.get(e.id) ?? [];
    const open = expanded.has(e.id) && kids.length > 0;
    const firstEntry = entity?.entries?.[0];
    boxes.push({
      id: e.id, ...(parent ? { parent } : {}), label: labelOf(entity, e), kind: isExternals ? 'externals' : entity!.kind,
      ...(entity?.detail ? { detail: entity.detail } : {}), ...(entity?.language ? { language: entity.language } : {}),
      count: countOf(e.id), expandable: kids.length > 0, expanded: open,
      ...(firstEntry ? { entry: firstEntry.name ? `${firstEntry.kind}: ${firstEntry.name}` : firstEntry.kind } : {}),
      ...(entity?.path ? { path: entity.path } : {}), ...(entity?.line ? { line: entity.line } : {})
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

  // Each entity's visible box: its own, else its nearest shown ancestor.
  const visibleOf = (id: string): string | undefined => {
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
  const declarationLevel = new Set<BoxKind>(['type', 'function', 'graph']);
  const add = (kind: ArrowKind, from: string, to: string, certain: boolean): void => {
    const a = visibleOf(from);
    const b = visibleOf(to);
    // An arrow inside one box, or between a box and what it holds, isn't drawn.
    if (!a || !b || a === b || inside(a, b) || inside(b, a)) return;
    // Calls and inheritance are drawn between declarations (types, functions, graphs); between
    // files, the imports say it.
    if (kind !== 'imports' && !(declarationLevel.has(shown.get(a)!.kind) || declarationLevel.has(shown.get(b)!.kind))) return;
    const id = `${kind}:${a}>${b}`;
    const existing = arrows.get(id);
    if (existing) {
      existing.weight++;
      existing.certain &&= certain;
    } else {
      arrows.set(id, { id, from: a, to: b, kind, weight: 1, certain });
    }
  };
  for (const i of index.imports) add('imports', i.from, i.to, true);
  for (const c of index.calls) add('calls', c.from, c.to, c.certain);
  for (const i of index.inherits) if (i.to) add('inherits', i.from, i.to, true);
  return { boxes, arrows: [...arrows.values()] };
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
  // ELK's route (orthogonal), or the two ends of a curve the map draws.
  points: { x: number; y: number }[];
  // Pointing back up (a cycle, a loop): drawn around the side.
  back?: boolean;
}

export interface LaidScene {
  width: number;
  height: number;
  boxes: LaidBox[];
  // What the map draws: between boxes in one open box, the arrows of everything inside them summed
  // (so each level reads as what depends on what).
  arrows: LaidArrow[];
  // Every arrow of the scene between the boxes it joins: drawn for a box that's pointed at.
  details: LaidArrow[];
}

// A collapsed box's size, from its label (a name over a smaller second line).
export function boxSize(box: SceneBox): { width: number; height: number } {
  // The name, with room for the toggle, the count and the open button beside it.
  const longest = Math.max(box.label.length + (box.expandable ? String(box.count).length + 3 : 0), (box.detail ?? '').length * 0.85);
  return { width: Math.round(Math.min(360, Math.max(110, longest * 7.8 + 60))), height: 48 };
}
