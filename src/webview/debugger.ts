// Simulate's debugger in the editor (docs/debugging.md): the node it paused at, Resume and the
// step buttons, and the call stack in graph terms, as Unreal's Blueprint Debugger shows it.
import { definitionFor } from '../core/editing';
import { DebugAction, DebugStackFrame, DebugState } from '../core/model';
import { lookupDefinition } from './document';
import { dom, escapeHtml } from './dom';
import { postToHost } from './host';
import { openGraph } from './my-blueprint';
import { render } from './render';
import { state } from './state';
import { centerOnNode } from './view';

const ACTIONS: { action: DebugAction; label: string; keys: string; whilePaused: boolean }[] = [
  { action: 'resume', label: 'Resume', keys: 'F5', whilePaused: true },
  { action: 'stepOver', label: 'Step Over', keys: 'F10', whilePaused: true },
  { action: 'stepInto', label: 'Step Into', keys: 'F11', whilePaused: true },
  { action: 'stepOut', label: 'Step Out', keys: 'Shift+F11', whilePaused: true },
  { action: 'stop', label: 'Stop', keys: 'Shift+F5', whilePaused: false }
];

dom.debugActions.innerHTML = ACTIONS.map((a) => `<button data-debug-action="${a.action}" title="${a.label} (${a.keys})">${a.label}</button>`).join('');
dom.debugActions.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
  button.addEventListener('click', () => postToHost({ type: 'debugAction', action: button.dataset.debugAction as DebugAction }));
});

// The node the debugger paused at, when it is in the graph on the canvas.
export function pausedNodeId(): string | undefined {
  const top = state.debug?.stack?.[0];
  return top?.here && top.graphId === state.graph?.id ? top.nodeId : undefined;
}

export function showDebugState(debug: DebugState): void {
  state.debug = debug.state === 'ended' ? null : debug;
  dom.debugger.hidden = !state.debug;
  const paused = debug.state === 'paused' && !!debug.stack?.length;
  dom.debugActions.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.disabled = !paused && ACTIONS.find((a) => a.action === button.dataset.debugAction)!.whilePaused;
  });
  const top = debug.stack?.[0];
  dom.debugTitle.textContent = paused && top ? `Paused at ${frameNodeName(top)}` : 'Running';
  dom.callStack.innerHTML = '';
  (debug.stack ?? []).forEach((frame, i) => {
    const item = document.createElement('li');
    item.className = (i === 0 ? 'current' : '') + (frame.here ? '' : ' elsewhere');
    item.innerHTML = `<span class="frame-node">${escapeHtml(frameNodeName(frame))}</span> <span class="frame-graph">${escapeHtml(frame.graphName)}</span>${frame.here ? '' : ` <span class="frame-file">${escapeHtml(frame.fileName)}</span>`}`;
    item.title = 'Show this node';
    item.addEventListener('click', () => showFrame(frame));
    dom.callStack.appendChild(item);
  });
  if (paused && top?.here) showFrame(top, true);
  else render();
}

// The node's title as this editor shows it, when the frame is in this file.
function frameNodeName(frame: DebugStackFrame): string {
  const node = frame.here ? state.document?.graphs.find((g) => g.id === frame.graphId)?.nodes.find((n) => n.id === frame.nodeId) : undefined;
  return node ? definitionFor(node, lookupDefinition).displayName : frame.nodeName;
}

// Opens the frame's graph and brings its node into view (centered when it is off screen, or
// always when `onlyIfHidden` is false).
function showFrame(frame: DebugStackFrame, onlyIfHidden = false): void {
  if (!frame.here) {
    postToHost({ type: 'reveal', target: { uri: frame.uri, kind: 'node', id: frame.nodeId, graphId: frame.graphId } });
    return;
  }
  if (frame.graphId !== state.graph?.id) openGraph(frame.graphId);
  render();
  const el = dom.world.querySelector<HTMLElement>(`.node[data-node="${CSS.escape(frame.nodeId)}"]`);
  const view = dom.canvasWrap.getBoundingClientRect();
  const box = el?.getBoundingClientRect();
  const visible = box && box.left >= view.left && box.right <= view.right && box.top >= view.top && box.bottom <= view.bottom;
  if (!onlyIfHidden || !visible) centerOnNode(frame.nodeId);
}
