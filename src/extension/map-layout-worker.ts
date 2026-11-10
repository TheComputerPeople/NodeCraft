// The Codebase Map's layout worker (map-layout.ts): a scene in, its boxes and arrows placed out.
// Each open box's contents are laid out on their own (ELK's layered algorithm, top to bottom), which
// keeps large maps fast. The map draws the scene's lifted arrows (summed, between boxes side by side,
// routed by ELK), so each level reads as what depends on what; a box's own arrows (`details`) are
// drawn when it's pointed at. Inheritance is laid out from parents down to their children.
import { parentPort } from 'node:worker_threads';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import ELK from 'elkjs/lib/elk.bundled.js';
import { LaidArrow, LaidBox, LaidScene, Scene, SceneArrow, boxSize, laidOutReversed } from '../core/codemap/scene';

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

type Point = { x: number; y: number };

export async function layoutScene(scene: Scene): Promise<LaidScene> {
  const nodes = new Map<string, ElkNode>();
  const root: ElkNode = { id: ROOT, layoutOptions: LAYERED, children: [], edges: [] };
  nodes.set(ROOT, root);
  for (const box of scene.boxes) nodes.set(box.id, box.expanded ? { id: box.id, layoutOptions: OPEN, children: [], edges: [] } : { id: box.id, ...boxSize(box) });
  for (const box of scene.boxes) {
    const parent = box.parent && nodes.has(box.parent) ? nodes.get(box.parent)! : root;
    parent.children!.push(nodes.get(box.id)!);
  }
  for (const box of scene.boxes) {
    const node = nodes.get(box.id)!;
    if (box.expanded && !node.children?.length) Object.assign(node, boxSize(box), { children: undefined, edges: undefined });
  }
  // The lifted arrows, in the open box holding both ends; inheritance from parent to child.
  for (const l of scene.lifted) {
    const container = nodes.get(l.container || ROOT) ?? root;
    const [source, target] = laidOutReversed(l) ? [l.to, l.from] : [l.from, l.to];
    container.edges?.push({ id: l.id, sources: [source], targets: [target] });
  }
  const laid = await elk.layout(root);

  // Absolute places: ELK gives each node relative to its parent, each edge relative to its box.
  const at = new Map<string, { x: number; y: number; width: number; height: number }>([[ROOT, { x: 0, y: 0, width: laid.width ?? 0, height: laid.height ?? 0 }]]);
  const boxes: LaidBox[] = [];
  const byId = new Map(scene.boxes.map((b) => [b.id, b]));
  const routes = new Map<string, Point[]>();
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

  // An arrow's points from its `from` to its `to`: ELK's route (reversed back for inheritance), or a
  // curve between the boxes, down, or around the side when it runs against the layers.
  const pointsOf = (arrow: SceneArrow, routed: Point[] | undefined): { points: Point[]; back?: boolean } | undefined => {
    const reversed = laidOutReversed(arrow);
    if (routed) return { points: reversed ? [...routed].reverse() : routed };
    const top = at.get(reversed ? arrow.to : arrow.from);
    const bottom = at.get(reversed ? arrow.from : arrow.to);
    if (!top || !bottom) return undefined;
    const down = bottom.y >= top.y + top.height;
    const points = down
      ? [{ x: top.x + top.width / 2, y: top.y + top.height }, { x: bottom.x + bottom.width / 2, y: bottom.y }]
      : [{ x: top.x, y: top.y + top.height / 2 }, { x: bottom.x, y: bottom.y + bottom.height / 2 }];
    return { points: reversed ? points.reverse() : points, ...(down ? {} : { back: true }) };
  };
  const arrows: LaidArrow[] = scene.lifted.flatMap(({ container: _container, ...arrow }) => {
    const placed = pointsOf(arrow, routes.get(arrow.id));
    return placed ? [{ ...arrow, ...placed }] : [];
  });
  const liftedById = new Map(scene.lifted.map((l) => [l.id, l]));
  const details: LaidArrow[] = scene.arrows.flatMap((arrow) => {
    // An arrow between boxes side by side is its own lifted arrow: the same route.
    const same = liftedById.get(arrow.id);
    const placed = pointsOf(arrow, same && same.weight === arrow.weight ? routes.get(arrow.id) : undefined);
    return placed ? [{ ...arrow, ...placed, ...(same?.cycle ? { cycle: true } : {}) }] : [];
  });
  return { mode: scene.mode, ...(scene.calls ? { calls: scene.calls } : {}), ...(scene.flow ? { flow: scene.flow } : {}), width: laid.width ?? 0, height: laid.height ?? 0, boxes, arrows, details };
}

parentPort?.on('message', (request: { id: number; scene: Scene }) => {
  layoutScene(request.scene).then(
    (scene) => parentPort?.postMessage({ id: request.id, scene }),
    (error: unknown) => parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  );
});
