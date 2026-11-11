// The messages between the Codebase Map's webview (src/map/map.ts) and the extension
// (src/extension/map-panel.ts).
import type { FoundEntity, MapFilters } from './find';
import type { CallDirection, LaidScene, MapMode } from './scene';

// ready: the page loaded; toggle: open or close a box (or show a box's "N more…", or explore a call
// flow box further); open: show a box's code (or its graph) in an editor; mode: switch the map's view;
// calls: show the call flow from a box (no id: from the entry points), which way (callers, or both:
// focus); direction: the call flow's way; depth: how many levels it goes; path: the calls that lead
// from one box to another.
export type MapMessage =
  | { type: 'ready' }
  | { type: 'toggle'; id: string }
  | { type: 'open'; id: string }
  | { type: 'mode'; mode: MapMode }
  | { type: 'calls'; id?: string; direction?: CallDirection }
  | { type: 'direction'; direction: CallDirection }
  | { type: 'depth'; depth: number }
  | { type: 'path'; from: string; to: string }
  // flow: show a function's control flow; history: Back or Forward through the places the map has
  // been (its views, call flows and flowcharts); openLine: show the code at a line of the flowchart's file.
  | { type: 'flow'; id: string }
  | { type: 'history'; direction: 'back' | 'forward' }
  | { type: 'openLine'; line: number }
  // find: the index's entities named like `query` (answered by 'found'); reveal: show an entity on
  // the map (its box opened up to, centred and selected); filters: what to hide.
  | { type: 'find'; query: string }
  | { type: 'reveal'; id: string }
  | { type: 'filters'; filters: MapFilters };

// scene: the laid-out map to draw (with `focus`, the box to centre and select, and whether Back and
// Forward go anywhere); status: a line for the toolbar (while reading the code); found: what Find found.
export interface MapHostMessage {
  type: 'scene' | 'status' | 'found';
  scene?: LaidScene;
  focus?: string;
  history?: { back: boolean; forward: boolean };
  title?: string;
  text?: string;
  query?: string;
  results?: FoundEntity[];
}
