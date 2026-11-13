import { PinAddress } from '../core/editing';
import type { PaletteEntry } from './document';
import { CompileReport, DebugState, DebugValue, Graph, GraphBreakpoint, GraphDocument, GraphNode, LanguageOption, NodeDefinition, PinDirection, PinKind, PinRef } from '../core/model';

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
  // The node, pin or comment title under a right-button press, for their context menus.
  nodeId: string | null;
  pin: PinAddress | null;
  commentId: string | null;
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
  | { kind: 'add-node'; position: Point; entries: PaletteEntry[]; allEntries: PaletteEntry[]; title: string; source: (PinAddress & { kind: PinKind }) | null }
  | { kind: 'node'; nodeId: string }
  | { kind: 'comment'; commentId: string };

export interface EditorState {
  // Null until the host sends a parsable document; editing is disabled while null.
  document: GraphDocument | null;
  // The graph on the canvas: one of document.graphs, or null when there is no document.
  graph: Graph | null;
  // The definitions as the host sent them, and in the graph language's terms (src/core/terms.ts),
  // which is what the editor shows and looks up.
  sourceDefinitions: NodeDefinition[];
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
  // Whether the host has scanned the project's functions, so one that isn't found is really gone.
  functionsLoaded: boolean;
  // The latest compile result, and whether the graph changed since (Unreal shows that as "?").
  compile: CompileReport | null;
  compileState: 'unknown' | 'dirty' | 'compiling' | CompileReport['status'];
  // The pin under the pointer; its wires are highlighted.
  hoverPin: PinAddress | null;
  // A placement key held down (B, S, P, ...): clicking the canvas places that node.
  heldKey: string | null;
  // The action menu's "Context Sensitive" checkbox, remembered while the editor is open.
  contextSensitive: boolean;
  // The variable selected in My Blueprint (its settings show in Details), if any.
  selectedVariableId: string | null;
  // An event dispatcher selected in My Blueprint, shown in Details.
  selectedDispatcherId: string | null;
  // A variable being dragged from My Blueprint onto the canvas.
  // A variable (or, with functionId, a function or macro) being dragged from My Blueprint onto the graph.
  variableDrag: { variableId: string; functionId?: string; dispatcherId?: string; startX: number; startY: number; moved: boolean } | null;
  // The view (pan and zoom) last used for each graph, restored when switching back.
  viewByGraph: Map<string, { pan: Point; zoom: number }>;
  // The file's breakpoints, in every graph (kept by the host, per workspace).
  breakpoints: GraphBreakpoint[];
  // Simulate's debugger, while a debug run is in progress.
  debug: DebugState | null;
  // Exec wires execution just went through, with when (performance.now()): each pulses briefly.
  pulses: Map<string, number>;
  // Watched pins (kept by the host, per workspace), and their values at the latest pause.
  watches: PinRef[];
  watchValues: Map<string, DebugValue>;
  // The node, or a node's pin, the keyboard is on (src/webview/keyboard.ts), and whether the keyboard
  // was used last (the focus ring shows only then).
  focus: { node: string; pin?: string } | null;
  keyboard: boolean;
}

export const state: EditorState = {
  document: null,
  graph: null,
  sourceDefinitions: [],
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
  functionsLoaded: true,
  compile: null,
  compileState: 'unknown',
  hoverPin: null,
  heldKey: null,
  contextSensitive: true,
  selectedVariableId: null,
  selectedDispatcherId: null,
  variableDrag: null,
  viewByGraph: new Map(),
  breakpoints: [],
  debug: null,
  pulses: new Map(),
  watches: [],
  watchValues: new Map(),
  focus: null,
  keyboard: false
};
