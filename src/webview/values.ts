// Pins' values while Simulate is paused (docs/debugging.md, "Values"): hovering a pin shows its
// value, and watched pins (Unreal's Watch this value) keep a bubble with theirs.
import { DebugValue, PinRef } from '../core/model';
import { pinDef } from './document';
import { dom } from './dom';
import { postToHost } from './host';
import { render } from './render';
import { state } from './state';

let nextRequest = 0;
const pending = new Map<number, (values: DebugValue[]) => void>();

function readValues(pins: PinRef[]): Promise<DebugValue[]> {
  const requestId = nextRequest++;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    postToHost({ type: 'readValues', requestId, pins });
  });
}

// The host's answer to readValues.
export function receiveValues(requestId: number, values: DebugValue[]): void {
  pending.get(requestId)?.(values);
  pending.delete(requestId);
}

const pinKey = (p: PinRef): string => JSON.stringify([p.graphId, p.nodeId, p.pinId]);
const paused = (): boolean => state.debug?.state === 'paused';

function ref(nodeId: string, pinId: string): PinRef | undefined {
  return state.graph ? { graphId: state.graph.id, nodeId, pinId } : undefined;
}

export function isWatched(nodeId: string, pinId: string): boolean {
  const pin = ref(nodeId, pinId);
  return !!pin && state.watches.some((w) => pinKey(w) === pinKey(pin));
}

// A watched pin's value from the latest pause, if any.
export function watchedValue(nodeId: string, pinId: string): DebugValue | undefined {
  const pin = ref(nodeId, pinId);
  return pin && state.watchValues.get(pinKey(pin));
}

export function toggleWatch(nodeId: string, pinId: string): void {
  const pin = ref(nodeId, pinId);
  if (!pin) return;
  const watched = isWatched(nodeId, pinId);
  state.watches = watched ? state.watches.filter((w) => pinKey(w) !== pinKey(pin)) : [...state.watches, pin];
  postToHost({ type: 'setWatches', watches: state.watches });
  if (!watched) void refreshWatches();
  render();
}

// The host's copy changed (another panel of the file, or the echo of ours).
export function setWatches(watches: PinRef[]): void {
  state.watches = watches;
  void refreshWatches();
  render();
}

// Reads every watched pin's value at a pause. Values stay shown while running, as in Unreal, and go
// when the run ends.
export async function refreshWatches(): Promise<void> {
  if (!paused() || !state.watches.length) return;
  const watches = state.watches;
  const values = await readValues(watches);
  state.watchValues = new Map(watches.map((w, i) => [pinKey(w), values[i] ?? { unavailable: 'No value.' }]));
  render();
}

export function clearValues(): void {
  state.watchValues = new Map();
  hideHoverValue();
}

let hovered: string | undefined;

// Shows the hovered data pin's value in a bubble next to it.
export async function showHoverValue(nodeId: string, pinId: string, handle: HTMLElement): Promise<void> {
  hideHoverValue();
  const pin = ref(nodeId, pinId);
  if (!pin || !paused() || pinDef(nodeId, pinId)?.kind !== 'data') return;
  const key = pinKey(pin);
  hovered = key;
  const [value] = await readValues([pin]);
  if (hovered !== key || !value) return;
  const bubble = dom.valueBubble;
  bubble.textContent = value.value ?? value.unavailable ?? '';
  bubble.classList.toggle('unavailable', value.value === undefined);
  const box = handle.getBoundingClientRect();
  const wrap = dom.canvasWrap.getBoundingClientRect();
  bubble.style.left = `${box.right - wrap.left + 6}px`;
  bubble.style.top = `${box.top - wrap.top - 4}px`;
  bubble.hidden = false;
}

export function hideHoverValue(): void {
  hovered = undefined;
  dom.valueBubble.hidden = true;
}
