// Simulate's debugger (docs/debugging.md, "Debugging in Simulate"): pausing at breakpoints and
// stepping by node, with the call stack in graph terms.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DebugCommand, SimulateBreakpoint, SimulateDebugger } from '../../src/core/debugger';
import { GraphDocument, RuntimeLogEvent } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { GraphRuntime } from '../../src/core/runtime';
import { doc, logs, node, wire } from './helpers';

// Start → Print (Greater's result) → call F → Print "after"; F prints "in F".
function program(): GraphDocument {
  const d = doc(
    [node('s', 'core:event.start'), node('gt', 'core:math.greater', { 'pin:a': 2, 'pin:b': 1 }), node('p1', 'core:console.print'),
      node('c', 'core:function.call', { graph: 'F' }), node('p2', 'core:console.print', { 'pin:value': 'after' })],
    [wire('s', 'execOut', 'p1', 'execIn'), wire('gt', 'returnValue', 'p1', 'value'), wire('p1', 'execOut', 'c', 'execIn'), wire('c', 'execOut', 'p2', 'execIn')]
  );
  d.graphs.push({
    id: 'F', name: 'F', kind: 'function', comments: [], signature: { inputs: [], outputs: [] },
    nodes: [node('entry', 'core:function.entry', { graph: 'F' }), node('fp', 'core:console.print', { 'pin:value': 'in F' })],
    connections: [wire('entry', 'execOut', 'fp', 'execIn')]
  });
  return d;
}

// Runs `d` under the debugger, answering each pause with the next of `commands` (then Continue).
// Returns each pause as "graph:node@depth" and the run's events.
function debug(d: GraphDocument, breakpoints: SimulateBreakpoint[], commands: DebugCommand[] = []): { pauses: string[]; stacks: string[][]; events: RuntimeLogEvent[] } {
  const events: RuntimeLogEvent[] = [];
  const pauses: string[] = [];
  const stacks: string[][] = [];
  const runtime = new GraphRuntime(new NodeRegistry(), (event) => events.push(event));
  runtime.debug = new SimulateDebugger(breakpoints, (stop) => {
    pauses.push(`${stop.stack[0].graphId}:${stop.stack[0].nodeId}@${stop.stack.length}`);
    stacks.push(stop.stack.map((f) => `${f.graphName}/${f.nodeId}`));
    return commands.shift() ?? 'continue';
  });
  runtime.run(d);
  return { pauses, stacks, events };
}

describe('Simulate debugger', () => {
  test('pauses at an enabled breakpoint before the node runs, then continues to the end', () => {
    let printedBeforePause: string[] = [];
    const events: RuntimeLogEvent[] = [];
    const runtime = new GraphRuntime(new NodeRegistry(), (event) => events.push(event));
    runtime.debug = new SimulateDebugger([{ graphId: 'EventGraph', nodeId: 'p2' }], () => {
      printedBeforePause = logs(events);
      return 'continue';
    });
    runtime.run(program());
    assert.deepEqual(printedBeforePause, ['true', 'in F']);
    assert.deepEqual(logs(events), ['true', 'in F', 'after']);
    assert.equal(events.at(-1)?.kind, 'graph.complete');
  });

  test('a breakpoint on a pure node pauses at the node that reads it', () => {
    assert.deepEqual(debug(program(), [{ graphId: 'EventGraph', nodeId: 'gt' }]).pauses, ['EventGraph:p1@1']);
  });

  test('breakpoints in another file or graph don\'t match', () => {
    assert.deepEqual(debug(program(), [{ document: 'lib/Other.vgraph', graphId: 'EventGraph', nodeId: 'p1' }, { graphId: 'G', nodeId: 'p1' }]).pauses, []);
  });

  test('Step Into enters a function graph; Step Out returns to the caller\'s next node', () => {
    const { pauses, stacks } = debug(program(), [{ graphId: 'EventGraph', nodeId: 'c' }], ['stepInto', 'stepInto', 'stepOut']);
    assert.deepEqual(pauses, ['EventGraph:c@1', 'F:entry@2', 'F:fp@2', 'EventGraph:p2@1']);
    assert.deepEqual(stacks[2], ['F/fp', 'EventGraph/c'], 'the call stack lists the calling node');
  });

  test('Step Over runs a function call to its end', () => {
    assert.deepEqual(debug(program(), [{ graphId: 'EventGraph', nodeId: 'p1' }], ['stepOver', 'stepOver', 'stepOver']).pauses, ['EventGraph:p1@1', 'EventGraph:c@1', 'EventGraph:p2@1']);
  });

  test('a breakpoint inside a function pauses on every call', () => {
    const d = program();
    d.graphs[0].nodes.push(node('c2', 'core:function.call', { graph: 'F' }));
    d.graphs[0].connections.push(wire('p2', 'execOut', 'c2', 'execIn'));
    assert.deepEqual(debug(d, [{ graphId: 'F', nodeId: 'fp' }]).pauses, ['F:fp@2', 'F:fp@2']);
  });

  test('breakpoints set while running take effect at the next node', () => {
    const events: RuntimeLogEvent[] = [];
    const pauses: string[] = [];
    const runtime = new GraphRuntime(new NodeRegistry(), (event) => events.push(event));
    const debuggerHook: SimulateDebugger = new SimulateDebugger([], (stop) => {
      pauses.push(stop.stack[0].nodeId);
      return 'continue';
    }, () => {
      if (logs(events).length === 1) debuggerHook.setBreakpoints([{ graphId: 'EventGraph', nodeId: 'p2' }]);
    });
    runtime.debug = debuggerHook;
    runtime.run(program());
    assert.deepEqual(pauses, ['p2']);
  });

  test('without a debugger, a run reports no pauses and behaves as before', () => {
    const events: RuntimeLogEvent[] = [];
    new GraphRuntime(new NodeRegistry(), (event) => events.push(event)).run(program());
    assert.deepEqual(logs(events), ['true', 'in F', 'after']);
  });
});
