// When Simulate's debugger pauses (docs/debugging.md, "Debugging in Simulate"): at an enabled
// breakpoint, or where a step arrives. Stepping is by node: Step Into pauses at the next node that
// runs anywhere, Step Over at the next one no deeper in calls than now, Step Out at the next one
// shallower than now.
import { DebugHook, DebugStop } from './runtime';

export type DebugCommand = 'continue' | 'stepOver' | 'stepInto' | 'stepOut';

// An enabled breakpoint; `document` is the graph file relative to the workspace, or absent for the
// file being simulated (as in RuntimeLogEvent).
export interface SimulateBreakpoint {
  document?: string;
  graphId: string;
  nodeId: string;
}

export class SimulateDebugger implements DebugHook {
  private command: DebugCommand = 'continue';
  // How many calls deep the last pause was.
  private depth = 0;

  constructor(
    private breakpoints: SimulateBreakpoint[],
    // Shows the pause and blocks until the user resumes, returning how. The stop reads values
    // until then.
    private readonly pause: (stop: DebugStop, reason: 'breakpoint' | 'step') => DebugCommand,
    // Called before each node, to take breakpoint changes made while running.
    private readonly poll: () => void = () => {}
  ) {}

  setBreakpoints(breakpoints: SimulateBreakpoint[]): void {
    this.breakpoints = breakpoints;
  }

  beforeNode(stop: DebugStop): void {
    this.poll();
    const depth = stop.stack.length;
    const stepped = this.command === 'stepInto'
      || (this.command === 'stepOver' && depth <= this.depth)
      || (this.command === 'stepOut' && depth < this.depth);
    if (!stepped && !this.atBreakpoint(stop)) return;
    this.command = this.pause(stop, stepped ? 'step' : 'breakpoint');
    this.depth = depth;
  }

  private atBreakpoint(stop: DebugStop): boolean {
    const top = stop.stack[0];
    const here = this.breakpoints.filter((b) => b.graphId === top.graphId && b.document === top.document);
    if (!here.length) return false;
    if (here.some((b) => b.nodeId === top.nodeId)) return true;
    const sources = new Set(stop.pureSources());
    return here.some((b) => sources.has(b.nodeId));
  }
}
