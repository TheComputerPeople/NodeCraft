// Messages between the extension host and Simulate's debug worker (src/extension/simulate-worker.ts).
import { DebugCommand, SimulateBreakpoint } from '../core/debugger';
import { DebugFrame, DebugValue, RuntimeLogEvent } from '../core/model';

// A pin to read while paused, in a frame of the stack (0 is the innermost).
export interface ValueRead {
  frame: number;
  nodeId: string;
  pinId: string;
}

export type WorkerMessage =
  | { kind: 'event'; event: RuntimeLogEvent }
  | { kind: 'paused'; stack: DebugFrame[]; reason: 'breakpoint' | 'step' }
  | { kind: 'resumed' }
  | { kind: 'values'; id: number; values: DebugValue[] }
  | { kind: 'done' };

export type SimulateCommand =
  | { kind: 'resume'; command: DebugCommand }
  | { kind: 'breakpoints'; breakpoints: SimulateBreakpoint[] }
  | { kind: 'read'; id: number; reads: ValueRead[] };
