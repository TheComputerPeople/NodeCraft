// Simulate under the debugger in its worker thread (docs/debugging.md, "Debugging in Simulate"):
// the worker blocks while paused and resumes on the host's commands.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DebugFrame, GraphDocument, NodeDefinition, RuntimeLogEvent } from '../../src/core/model';
import type { TestResult } from '../../src/core/runtime';
import { NodeRegistry } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { SimulateBreakpoint } from '../../src/core/debugger';
import { SimulateSession, simulateExamples } from '../../src/extension/simulate-session';
import { doc, node, readRepoFile, wire } from './helpers';

interface Recorder {
  events: RuntimeLogEvent[];
  pauses: DebugFrame[][];
  ended: Promise<void>;
  tests?: TestResult[];
  // Resolves at the next pause.
  nextPause(): Promise<DebugFrame[]>;
}

function start(breakpoints: SimulateBreakpoint[], document: GraphDocument = parseDocument(readRepoFile('sample/demo.vgraph')).document, tests = false): { session: SimulateSession; recorder: Recorder } {
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
    document,
    openDocuments: {},
    args: [],
    breakpoints,
    tests
  }, {
    event: (event) => events.push(event),
    paused: (stack) => {
      pauses.push(stack);
      waiting?.(stack);
    },
    resumed: () => {},
    tests: (results) => (recorder.tests = results),
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

  test('reads values while paused', async () => {
    const { session, recorder } = start([{ graphId: 'EventGraph', nodeId: 'print_true' }]);
    await recorder.nextPause();
    const values = await session.read([{ frame: 0, nodeId: 'print_true', pinId: 'value' }, { frame: 0, nodeId: 'add_1', pinId: 'result' }]);
    assert.deepEqual(values, [{ value: '30' }, { value: '30' }]);
    session.resume('continue');
    await recorder.ended;
    assert.deepEqual(await session.read([{ frame: 0, nodeId: 'add_1', pinId: 'result' }]), [{ unavailable: 'Values are read while paused.' }]);
  });

  test('Stop ends a paused run', async () => {
    const { session, recorder } = start([{ graphId: 'EventGraph', nodeId: 'start_1' }]);
    await recorder.nextPause();
    session.stop();
    await recorder.ended;
    assert.deepEqual(prints(recorder.events), []);
    assert.equal(recorder.events.at(-1)?.message, 'Simulate stopped.');
  });

  // docs/audit.md, third pass: every Simulate runs in the worker, so one that would take hours (a
  // loop in a loop, each well inside the loop limit) leaves the extension host free, and Stop ends it.
  test('Stop ends a run without breakpoints that would take hours', async () => {
    const long = doc([
      node('s', 'core:event.start'),
      node('outer', 'core:flow.for-loop', { 'pin:lastIndex': 999999 }),
      node('inner', 'core:flow.for-loop', { 'pin:lastIndex': 999999 })
    ], [wire('s', 'execOut', 'outer', 'execIn'), wire('outer', 'loopBody', 'inner', 'execIn')]);
    const { session, recorder } = start([], long);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(session.running, true, 'still running');
    session.stop();
    await recorder.ended;
    assert.equal(recorder.events.at(-1)?.message, 'Simulate stopped.');
  });

  test("a tests run gives the graph's test results", async () => {
    const tested = doc([node('t', 'core:test.case', { name: 'Holds' }), node('a', 'core:test.assert-true', { 'pin:condition': true })], [wire('t', 'execOut', 'a', 'execIn')]);
    const { recorder } = start([], tested, true);
    await recorder.ended;
    assert.deepEqual(recorder.tests?.map((t) => [t.name, t.passed]), [['Holds', true]]);
    assert.ok(recorder.events.some((e) => e.kind === 'test.pass' && e.test === 'Holds'));
  });
});

describe("Test Node Library's examples in Simulate", () => {
  const codeNode = (type: string, code: string, examples: NodeDefinition['examples']): NodeDefinition => ({
    type, version: 1, displayName: type, category: 'Test',
    inputs: [{ id: 'value', name: 'Value', kind: 'data', direction: 'input', type: { id: 'float' } }],
    outputs: [{ id: 'result', name: 'Result', kind: 'data', direction: 'output', type: { id: 'float' } }],
    implementation: { kind: 'code', languages: { typescript: code } },
    examples
  });

  test('run in a worker and report', async () => {
    const report = await simulateExamples([codeNode('test.halve', 'return ${value} / 2;', [{ inputs: { value: 9 }, outputs: { result: 4.5 } }])], 'typescript', { timeoutMs: 30000 });
    assert.deepEqual(report.results.map((r) => [r.fixture, r.status]), [['test.halve', 'passed']]);
  });

  test("an example that doesn't finish in time fails, and the worker is ended", async () => {
    const slow = codeNode('test.slow', 'for (let i = 0; i < 1e15; i++) {} return 0;', [{ inputs: { value: 1 }, outputs: { result: 0 } }]);
    const started = Date.now();
    const report = await simulateExamples([slow, codeNode('test.plain', 'return 1;', undefined)], 'typescript', { timeoutMs: 500 });
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(report.results.map((r) => [r.fixture, r.status]), [['test.slow', 'failed'], ['test.plain', 'not-applicable']]);
    assert.match(report.results[0].message ?? '', /didn't finish the examples in 1 second: an example may never end/);
  });

  test('Stop ends them', async () => {
    const stop = new AbortController();
    const running = simulateExamples([codeNode('test.slow', 'for (let i = 0; i < 1e15; i++) {} return 0;', [{ inputs: { value: 1 }, outputs: { result: 0 } }])], 'typescript', { timeoutMs: 60000, signal: stop.signal });
    setTimeout(() => stop.abort(), 200);
    const report = await running;
    assert.equal(report.results[0].message, 'Stopped before Simulate finished the examples.');
  });
});
