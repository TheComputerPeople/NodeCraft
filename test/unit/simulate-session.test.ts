// Simulate under the debugger in its worker thread (docs/debugging.md, "Debugging in Simulate"):
// the worker blocks while paused and resumes on the host's commands.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DebugFrame, RuntimeLogEvent } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { SimulateBreakpoint } from '../../src/core/debugger';
import { SimulateSession } from '../../src/extension/simulate-session';
import { readRepoFile } from './helpers';

interface Recorder {
  events: RuntimeLogEvent[];
  pauses: DebugFrame[][];
  ended: Promise<void>;
  // Resolves at the next pause.
  nextPause(): Promise<DebugFrame[]>;
}

function start(breakpoints: SimulateBreakpoint[]): { session: SimulateSession; recorder: Recorder } {
  const events: RuntimeLogEvent[] = [];
  const pauses: DebugFrame[][] = [];
  let waiting: ((stack: DebugFrame[]) => void) | undefined;
  let ended!: () => void;
  const recorder: Recorder = {
    events, pauses,
    ended: new Promise((resolve) => (ended = resolve)),
    nextPause: () => new Promise((resolve) => (waiting = resolve))
  };
  const session = new SimulateSession({
    definitions: new NodeRegistry().all(),
    document: parseDocument(readRepoFile('sample/demo.vgraph')).document,
    openDocuments: {},
    args: [],
    breakpoints
  }, {
    event: (event) => events.push(event),
    paused: (stack) => {
      pauses.push(stack);
      waiting?.(stack);
    },
    resumed: () => {},
    ended: () => ended()
  });
  return { session, recorder };
}

const prints = (events: RuntimeLogEvent[]): string[] => events.filter((e) => e.kind === 'log').map((e) => e.message ?? '');

describe('Simulate session', () => {
  test('pauses at a breakpoint, steps by node and continues to the end', async () => {
    const { session, recorder } = start([{ graphId: 'EventGraph', nodeId: 'branch_1' }]);
    const first = await recorder.nextPause();
    assert.deepEqual(first.map((f) => [f.graphName, f.nodeId]), [['EventGraph', 'branch_1']]);
    assert.deepEqual(prints(recorder.events), [], 'nothing printed yet');
    const next = recorder.nextPause();
    session.resume('stepOver');
    assert.equal((await next)[0].nodeId, 'print_true');
    session.resume('continue');
    await recorder.ended;
    assert.deepEqual(prints(recorder.events), ['30']);
    assert.equal(recorder.events.at(-1)?.kind, 'graph.complete');
    assert.equal(session.running, false);
  });

  test('breakpoints changed while paused apply to the rest of the run', async () => {
    const { session, recorder } = start([{ graphId: 'EventGraph', nodeId: 'add_1' }]);
    await recorder.nextPause();
    session.setBreakpoints([{ graphId: 'EventGraph', nodeId: 'end_true' }]);
    const next = recorder.nextPause();
    session.resume('continue');
    assert.equal((await next)[0].nodeId, 'end_true');
    session.resume('continue');
    await recorder.ended;
    assert.deepEqual(recorder.pauses.map((s) => s[0].nodeId), ['add_1', 'end_true']);
  });

  test('Stop ends a paused run', async () => {
    const { session, recorder } = start([{ graphId: 'EventGraph', nodeId: 'start_1' }]);
    await recorder.nextPause();
    session.stop();
    await recorder.ended;
    assert.deepEqual(prints(recorder.events), []);
    assert.equal(recorder.events.at(-1)?.message, 'Simulate stopped.');
  });
});
