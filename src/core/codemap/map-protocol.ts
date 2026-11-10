// The messages between the Codebase Map's webview (src/map/map.ts) and the extension
// (src/extension/map-panel.ts).
import type { LaidScene } from './scene';

// ready: the page loaded; toggle: open or close a box (or show a box's "N more…"); open: show a
// box's code (or its graph) in an editor.
export type MapMessage =
  | { type: 'ready' }
  | { type: 'toggle'; id: string }
  | { type: 'open'; id: string };

// scene: the laid-out map to draw; status: a line for the toolbar (while reading the code).
export interface MapHostMessage {
  type: 'scene' | 'status';
  scene?: LaidScene;
  title?: string;
  text?: string;
}
