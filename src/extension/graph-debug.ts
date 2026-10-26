// A debugging session the graph editors show (docs/debugging.md): Simulate's, in a worker, or a
// language's debugger on generated code (src/extension/code-debug.ts). Either way the editors show
// the node it stopped at, the call stack in graph terms and pins' values.
import * as vscode from 'vscode';
import { DebugAction, DebugFrame, DebugValue, PinRef } from '../core/model';
import { SimulateSession } from './simulate-session';

// A frame with its graph file; frames outside generated code (`external`) name their own file.
export interface GraphStackFrame extends DebugFrame {
  uri: vscode.Uri;
  external?: boolean;
}

export interface GraphDebug {
  // The call stack while paused, innermost first.
  readonly stack: GraphStackFrame[] | undefined;
  act(action: DebugAction): void;
  // Pins' values while paused (pins of `file`'s graphs).
  read(file: vscode.Uri, pins: PinRef[]): Promise<DebugValue[]>;
  // The workspace's breakpoints changed.
  breakpointsChanged(): void;
}

const NOT_PAUSED: DebugValue = { unavailable: 'Values are read while paused.' };
export const NOT_RUNNING: DebugValue = { unavailable: "No value: this graph isn't running." };

// Simulate under the debugger. `fileUri` turns a frame's workspace-relative file into a URI.
export class SimulateDebug implements GraphDebug {
  stack: GraphStackFrame[] | undefined;

  constructor(readonly session: SimulateSession, private readonly fileUri: (document: string | undefined) => vscode.Uri, private readonly breakpoints: () => Parameters<SimulateSession['setBreakpoints']>[0]) {}

  paused(stack: DebugFrame[]): void {
    this.stack = stack.map((frame) => ({ ...frame, uri: this.fileUri(frame.document) }));
  }

  resumed(): void {
    this.stack = undefined;
  }

  act(action: DebugAction): void {
    if (action === 'stop') this.session.stop();
    else this.session.resume(action === 'resume' ? 'continue' : action);
  }

  // Each pin is read in the innermost frame running its graph.
  async read(file: vscode.Uri, pins: PinRef[]): Promise<DebugValue[]> {
    const stack = this.stack;
    if (!stack) return pins.map(() => NOT_PAUSED);
    const frames = pins.map((pin) => stack.findIndex((f) => f.graphId === pin.graphId && f.uri.toString() === file.toString()));
    const reads = pins.flatMap((pin, i) => (frames[i] >= 0 ? [{ frame: frames[i], nodeId: pin.nodeId, pinId: pin.pinId }] : []));
    const values = reads.length ? await this.session.read(reads) : [];
    let next = 0;
    return frames.map((frame) => (frame >= 0 ? values[next++] ?? NOT_PAUSED : NOT_RUNNING));
  }

  breakpointsChanged(): void {
    this.session.setBreakpoints(this.breakpoints());
  }
}
