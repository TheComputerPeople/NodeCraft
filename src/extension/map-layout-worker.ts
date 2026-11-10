// The Codebase Map's layout worker (map-layout.ts): a scene in, its boxes and arrows placed out.
// Each open box's contents are laid out on their own (ELK's layered algorithm, top to bottom), which
// keeps large maps fast. An arrow between boxes in different open boxes is lifted to the two boxes
// holding its ends inside their nearest common box: the map draws those lifted arrows (summed, and
// routed by ELK), so each level reads as what depends on what; a box's own arrows, unlifted, are
// drawn when it's pointed at (`details`).
import { parentPort } from 'node:worker_threads';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import ELK from 'elkjs/lib/elk.bundled.js';
import { LaidArrow, LaidBox, LaidScene, Scene, SceneArrow, boxSize } from '../core/codemap/scene';

const elk = new ELK();

const LAYERED: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.nodeNodeBetweenLayers': '44',
  'elk.spacing.edgeNode': '16',
  'elk.spacing.edgeEdge': '8',
  'elk.spacing.componentComponent': '36',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
  'elk.layered.thoroughness': '4',
  'elk.layered.mergeEdges': 'true',
  // Boxes with nothing between them pack into rows, not one long line.
  'elk.aspectRatio': '1.6'
};
// An open box: room for its title above what it holds.
const OPEN: Record<string, string> = { ...LAYERED, 'elk.padding': '[top=40,left=14,bottom=14,right=14]' };
const ROOT = '__root';

export async function layoutScene(scene: Scene): Promise<LaidScene> {
  const nodes = new Map<string, ElkNode>();
  const root: ElkNode = { id: ROOT, layoutOptions: LAYERED, children: [], edges: [] };
  nodes.set(ROOT, root);
  for (const box of scene.boxes) nodes.set(box.id, box.expanded ? { id: box.id, layoutOptions: OPEN, children: [], edges: [] } : { id: box.id, ...boxSize(box) });
  const parentOf = new Map<string, string>();
  for (const box of scene.boxes) {
    const parent = box.parent && nodes.has(box.parent) ? box.parent : ROOT;
    parentOf.set(box.id, parent);
    nodes.get(parent)!.children!.push(nodes.get(box.id)!);
  }
  for (const box of scene.boxes) {
    const node = nodes.get(box.id)!;
    if (box.expanded && !node.children?.length) Object.assign(node, boxSize(box), { children: undefined, edges: undefined });
  }

  // Each arrow lifted, by kind, to its ends' ancestors that are siblings in their nearest common box.
  const chain = (id: string): string[] => {
    const ids = [id];
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) ids.push(p);
    return ids;
  };
  const lifted = new Map<string, SceneArrow & { container: string }>();
  for (const arrow of scene.arrows) {
    const a = chain(arrow.from);
    const bChain = chain(arrow.to);
    const b = new Set(bChain);
    const common = a.find((id) => b.has(id))!;
    const from = a[a.indexOf(common) - 1];
    const to = bChain[bChain.indexOf(common) - 1];
    if (!from || !to || from === to) continue;
    const id = `${arrow.kind}:${from}>${to}`;
    const entry = lifted.get(id);
    if (entry) {
      entry.weight += arrow.weight;
      entry.certain &&= arrow.certain;
    } else {
      lifted.set(id, { id, from, to, kind: arrow.kind, weight: arrow.weight, certain: arrow.certain, container: common });
    }
  }
  for (const l of lifted.values()) nodes.get(l.container)!.edges!.push({ id: l.id, sources: [l.from], targets: [l.to] });
  const laid = await elk.layout(root);

  // Absolute places: ELK gives each node relative to its parent, each edge relative to its box.
  const at = new Map<string, { x: number; y: number; width: number; height: number }>([[ROOT, { x: 0, y: 0, width: laid.width ?? 0, height: laid.height ?? 0 }]]);
  const boxes: LaidBox[] = [];
  const byId = new Map(scene.boxes.map((b) => [b.id, b]));
  const routes = new Map<string, { x: number; y: number }[]>();
  const place = (node: ElkNode, ox: number, oy: number): void => {
    for (const edge of (node.edges ?? []) as ElkExtendedEdge[]) {
      const section = edge.sections?.[0];
      if (section) routes.set(edge.id, [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => ({ x: p.x + ox, y: p.y + oy })));
    }
    for (const child of node.children ?? []) {
      const x = ox + (child.x ?? 0);
      const y = oy + (child.y ?? 0);
      at.set(child.id, { x, y, width: child.width ?? 0, height: child.height ?? 0 });
      boxes.push({ ...byId.get(child.id)!, x, y, width: child.width ?? 0, height: child.height ?? 0 });
      place(child, x, y);
    }
  };
  place(laid, 0, 0);

  // A two-point arrow between boxes: bottom to top when the target is below, else from the side,
  // around (a back arrow).
  const between = (arrow: SceneArrow): LaidArrow | undefined => {
    const from = at.get(arrow.from);
    const to = at.get(arrow.to);
    if (!from || !to) return undefined;
    const down = to.y >= from.y + from.height;
    const points = down
      ? [{ x: from.x + from.width / 2, y: from.y + from.height }, { x: to.x + to.width / 2, y: to.y }]
      : [{ x: from.x, y: from.y + from.height / 2 }, { x: to.x, y: to.y + to.height / 2 }];
    return { ...arrow, points, ...(down ? {} : { back: true }) };
  };
  const arrows: LaidArrow[] = [...lifted.values()].flatMap(({ container: _container, ...arrow }) => {
    const routed = routes.get(arrow.id);
    const laidArrow = routed ? { ...arrow, points: routed } : between(arrow);
    return laidArrow ? [laidArrow] : [];
  });
  const details: LaidArrow[] = scene.arrows.flatMap((arrow) => {
    // An arrow between siblings is its own lifted arrow: the same route.
    const routed = routes.get(`${arrow.kind}:${arrow.from}>${arrow.to}`);
    const laidArrow = routed && lifted.get(`${arrow.kind}:${arrow.from}>${arrow.to}`)?.weight === arrow.weight ? { ...arrow, points: routed } : between(arrow);
    return laidArrow ? [laidArrow] : [];
  });
  return { width: laid.width ?? 0, height: laid.height ?? 0, boxes, arrows, details };
}

parentPort?.on('message', (request: { id: number; scene: Scene }) => {
  layoutScene(request.scene).then(
    (scene) => parentPort?.postMessage({ id: request.id, scene }),
    (error: unknown) => parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  );
});
