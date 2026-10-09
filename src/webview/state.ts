import { PinAddress } from '../core/editing';
import { CompileReport, Graph, GraphDocument, GraphNode, LanguageOption, NodeDefinition, PinDirection, PinKind } from '../core/model';

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
// Existing connections whose `side` end is being dragged to a new pin: one wire (Ctrl+click on a
// wire) or every wire on a pin (Ctrl+drag from the pin, as in Unreal).
export interface Rewire {
  connectionIds: string[];
  side: 'from' | 'to';
  startX: number;
  startY: number;
  // Releasing away from a pin removes the wire (single-wire rewire) or cancels (moving all).
  dropRemoves: boolean;
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
  // Right-button presses pan when dragged and open a context menu when not (as in Unreal).
  button: number;
  moved: boolean;
  // The node under a right-button press, for its context menu.
  nodeId: string | null;
}

// Marquee modes, as in Unreal: drag replaces, Shift+drag adds, Ctrl+drag removes.
export type SelectionMode = 'replace' | 'add' | 'remove';

export interface GroupSelection {
  startX: number;
  startY: number;
  mode: SelectionMode;
  base: Set<string>;
  moved: boolean;
}

export type MenuContext =
  | { kind: 'add-node'; position: Point; definitions: NodeDefinition[]; title: string; source: (PinAddress & { kind: PinKind }) | null }
  | { kind: 'node'; nodeId: string };

export interface EditorState {
  // Null until the host sends a parsable document; editing is disabled while null.
  document: GraphDocument | null;
  // The graph on the canvas: one of document.graphs, or null when there is no document.
  graph: Graph | null;
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
  // Target languages offered in the toolbar.
  languages: LanguageOption[];
  // The latest compile result, and whether the graph changed since (Unreal shows that as "?").
  compile: CompileReport | null;
  compileState: 'unknown' | 'dirty' | 'compiling' | CompileReport['status'];
  // The pin under the pointer; its wires are highlighted.
  hoverPin: PinAddress | null;
  // A placement key held down (B, S, P, ...): clicking the canvas places that node.
  heldKey: string | null;
}

export const state: EditorState = {
  document: null,
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
  runtimePaintPending: false,
  languages: [],
  compile: null,
  compileState: 'unknown',
  hoverPin: null,
  heldKey: null
};
