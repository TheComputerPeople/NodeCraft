// The Codebase Map's control flow view (docs/codebase-map.md, Part 3): one function's flowchart
// (flow.ts) as the map's boxes and arrows, top to bottom. Each box lists the calls made on its lines
// (from the index), which open their callee's flowchart. Pure, like scene.ts.
import { CodeIndex } from './code-index';
import { Flowchart } from './flow';
import { Scene, SceneArrow, SceneBox } from './scene';

// A call made in the function, on a line: the callee (an entity of the index), or a name the index
// couldn't resolve.
export interface FlowCall {
  line: number;
  id?: string;
  label: string;
}

// What the control flow view shows: the function, and where its flowchart came from.
export interface FlowContext {
  id: string;
  label: string;
  path: string;
  line: number;
  // Whether Back and Forward can go anywhere (the flowcharts opened before and after this one).
  back: boolean;
  forward: boolean;
}

// A block shows this many of its lines; the rest are "…".
export const MAX_FLOW_LINES = 8;

// The calls a function makes, by line, from the index: the certain ones. (A flowchart's box is one
// place in the code, where a guess misleads more than it helps: `list.push()` guessed as a
// workspace's `push`. The call flow shows the guesses, dashed.)
export function callsOf(index: CodeIndex, id: string): FlowCall[] {
  const byId = new Map(index.entities.map((e) => [e.id, e]));
  return index.calls.filter((c) => c.from === id && c.certain).map((c) => {
    const target = byId.get(c.to);
    return { line: c.line, id: c.to, label: target ? `${target.kind === 'type' ? 'new ' : ''}${target.name}` : c.to };
  });
}

export function buildFlowScene(chart: Flowchart, calls: FlowCall[], context: FlowContext): Scene {
  const boxes: SceneBox[] = chart.nodes.map((node) => {
    const lines = node.label.split('\n');
    const block = node.kind === 'block' || node.kind === 'await';
    const shown = block ? (lines.length > MAX_FLOW_LINES ? [...lines.slice(0, MAX_FLOW_LINES - 1), '…'] : lines) : [];
    // A decision's calls are its condition's; a block's are on any of its lines.
    const here = calls.filter((c) => c.line >= node.line && c.line <= (node.kind === 'decision' || node.kind === 'loop' ? node.line : node.endLine));
    const label = node.kind === 'start' ? context.label : block ? (node.line === node.endLine ? `line ${node.line}` : `lines ${node.line}–${node.endLine}`) : lines[0];
    return {
      id: `n:${node.id}`, label, kind: 'flow', flowKind: node.kind,
      detail: node.kind === 'start' ? `${context.path}:${context.line}` : node.kind === 'end' ? '' : block ? undefined : `line ${node.line}`,
      count: 0, expandable: false, expanded: false, path: context.path, line: node.line,
      ...(shown.length ? { members: shown } : {}),
      ...(here.length ? { calls: dedupe(here).map((c) => ({ label: c.label, ...(c.id ? { id: c.id } : {}) })) } : {})
    };
  });
  const arrows: SceneArrow[] = chart.edges.map((edge, i) => ({
    id: `flow:${i}:${edge.from}>${edge.to}`, from: `n:${edge.from}`, to: `n:${edge.to}`, kind: 'flow', weight: 1, certain: true,
    ...(edge.label ? { label: edge.label } : {}), ...(edge.back ? { back: true } : {})
  }));
  // A flowchart's arrows are drawn as they are: two between the same boxes (both branches of a
  // decision joining) keep their own labels.
  return { mode: 'flow', boxes, arrows, lifted: arrows.map((a) => ({ ...a, container: '' })), flow: context };
}

function dedupe(calls: FlowCall[]): FlowCall[] {
  const seen = new Set<string>();
  return calls.filter((c) => {
    const key = c.id ?? c.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
