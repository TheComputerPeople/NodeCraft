// The messages between the Codebase Map's webview (src/map/map.ts) and the extension
// (src/extension/map-panel.ts).
import type { LaidScene, MapMode } from './scene';

// ready: the page loaded; toggle: open or close a box (or show a box's "N more…", or explore a call
// flow box further); open: show a box's code (or its graph) in an editor; mode: switch the map's view;
// calls: show the call flow from a box (no id: from the entry points); direction: the call flow's
// calls made, or callers.
export type MapMessage =
  | { type: 'ready' }
  | { type: 'toggle'; id: string }
  | { type: 'open'; id: string }
  | { type: 'mode'; mode: MapMode }
  | { type: 'calls'; id?: string }
  | { type: 'direction'; direction: 'callees' | 'callers' }
  // flow: show a function's control flow; history: Back or Forward through the flowcharts opened;
  // openLine: show the code at a line of the flowchart's file.
  | { type: 'flow'; id: string }
  | { type: 'history'; direction: 'back' | 'forward' }
  | { type: 'openLine'; line: number };

// scene: the laid-out map to draw; status: a line for the toolbar (while reading the code).
export interface MapHostMessage {
  type: 'scene' | 'status';
  scene?: LaidScene;
  title?: string;
  text?: string;
}
