// Messages between the extension host and Simulate's debug worker (src/extension/simulate-worker.ts).
import { DebugCommand, SimulateBreakpoint } from '../core/debugger';
import { DebugFrame, RuntimeLogEvent } from '../core/model';

export type WorkerMessage =
  | { kind: 'event'; event: RuntimeLogEvent }
  | { kind: 'paused'; stack: DebugFrame[]; reason: 'breakpoint' | 'step' }
  | { kind: 'resumed' }
  | { kind: 'done' };

export type SimulateCommand =
  | { kind: 'resume'; command: DebugCommand }
  | { kind: 'breakpoints'; breakpoints: SimulateBreakpoint[] };
