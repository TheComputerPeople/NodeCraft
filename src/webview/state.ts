import { PinAddress } from '../core/editing';
import { GraphDefinition, GraphNode, NodeDefinition, PinDirection, PinKind } from '../core/model';

export interface Point {
  x: number;
  y: number;
}

// A wire being dragged out of a pin.
export interface DraftConnection {
  node: string;
  pin: string;
  kind: PinKind;
  direction: PinDirection;
  startX: number;
  startY: number;
}

// An existing connection whose `side` end is being dragged to a new pin.
export interface Rewire {
  connectionId: string;
  side: 'from' | 'to';
  startX: number;
  startY: number;
}

export interface NodeDrag {
  originX: number;
  originY: number;
  items: { node: GraphNode; startX: number; startY: number }[];
  moved: boolean;
}

export interface Panning {
  startX: number;
  startY: number;
  panX: number;
  panY: number;
}

export interface GroupSelection {
  startX: number;
  startY: number;
  additive: boolean;
  base: Set<string>;
  moved: boolean;
}

export type MenuContext =
  | { kind: 'add-node'; position: Point; definitions: NodeDefinition[]; title: string; source: (PinAddress & { kind: PinKind }) | null }
  | { kind: 'node'; nodeId: string };

export interface EditorState {
  // Null until the host sends a parsable document; editing is disabled while null.
  graph: GraphDefinition | null;
  definitions: NodeDefinition[];
  defByType: Map<string, NodeDefinition>;
  selectedNodeIds: Set<string>;
  // The node shown in the Details panel; always one of selectedNodeIds, or null.
  selectedNodeId: string | null;
  draftConnection: DraftConnection | null;
  rewire: Rewire | null;
  pan: Point;
  zoom: number;
  dragging: NodeDrag | null;
  panning: Panning | null;
  selection: GroupSelection | null;
  context: MenuContext | null;
  saveTimer: ReturnType<typeof setTimeout> | undefined;
  saveDelay: number;
  dirty: boolean;
  // Nodes reached by the current/last run. The host runs a graph synchronously, so events arrive
  // in one burst; showing the whole path briefly is the only highlight a user can actually see.
  executedNodeIds: Set<string>;
  runActive: boolean;
  runtimeClearTimer: ReturnType<typeof setTimeout> | undefined;
  runtimePaintPending: boolean;
}

export const state: EditorState = {
  graph: null,
  definitions: [],
  defByType: new Map(),
  selectedNodeIds: new Set(),
  selectedNodeId: null,
  draftConnection: null,
  rewire: null,
  pan: { x: 0, y: 0 },
  zoom: 1,
  dragging: null,
  panning: null,
  selection: null,
  context: null,
  saveTimer: undefined,
  saveDelay: 150,
  dirty: false,
  executedNodeIds: new Set(),
  runActive: false,
  runtimeClearTimer: undefined,
  runtimePaintPending: false
};
