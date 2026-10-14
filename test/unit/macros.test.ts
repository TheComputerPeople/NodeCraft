// Macros (docs/program-structure.md, "Macros"): expansion, compiling, Simulate, signature edits,
// Collapse to Macro and macro libraries.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addGraph, addSignaturePin, collapseToMacro, setSignaturePinType } from '../../src/core/blueprint-edits';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { macroLibraryDefinitions, macroNodeType } from '../../src/core/libraries';
import { MACRO_INPUTS, MACRO_INSTANCE, MACRO_OUTPUTS, expandMacros, macroLookup } from '../../src/core/macros';
import { Graph, GraphDocument, GraphPin } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
import { logs, node, run, wire } from './helpers';

const exec = (id: string, name: string): GraphPin => ({ id, name, kind: 'exec' });
const data = (id: string, name: string, type: string, defaultValue?: unknown): GraphPin => ({ id, name, kind: 'data', type: { id: type }, ...(defaultValue !== undefined ? { defaultValue } : {}) });

// Say(In, Text = "hi") -> Out: prints Text.
function sayMacro(id = 'Say'): Graph {
  return {
    id, name: 'Say', kind: 'macro', comments: [],
    signature: { inputs: [exec('in', 'In'), data('text', 'Text', 'string', 'hi')], outputs: [exec('out', 'Out')] },
    nodes: [node('inputs', MACRO_INPUTS, { graph: id }), node('print', 'core:console.print'), node('outputs', MACRO_OUTPUTS, { graph: id })],
    connections: [wire('inputs', 'in', 'print', 'execIn'), wire('inputs', 'text', 'print', 'value'), wire('print', 'execOut', 'outputs', 'out')]
  };
}

function classDoc(eventNodes: Graph['nodes'], eventWires: Graph['connections'], macros: Graph[]): GraphDocument {
  return {
    schemaVersion: 3, name: 'Test', kind: 'class', language: 'javascript', variables: [],
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: eventNodes, connections: eventWires }, ...macros]
  };
}

function compile(document: GraphDocument, registry = new NodeRegistry()) {
  return compileDocument(document, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'test.vgraph' } });
}

describe('macro expansion', () => {
  test('an instance becomes a copy of the macro, wired through the tunnels', () => {
    const d = classDoc(
      [node('start', 'core:event.start'), node('say', MACRO_INSTANCE, { graph: 'Say', 'pin:text': 'hello' }), node('end', 'core:console.print', { 'pin:value': 'after' })],
      [wire('start', 'execOut', 'say', 'in'), wire('say', 'out', 'end', 'execIn')],
      [sayMacro()]
    );
    const { graph, problems, macros } = expandMacros(d.graphs[0], macroLookup(d.graphs, () => undefined));
    assert.deepEqual(problems, []);
    assert.deepEqual(macros, new Map([['say', 'Say']]));
    assert.deepEqual(graph.nodes.map((n) => n.id), ['start', 'say/print', 'end']);
    assert.deepEqual(graph.connections.map((c) => `${c.fromNode}.${c.fromPin}->${c.toNode}.${c.toPin}`).sort(), ['say/print.execOut->end.execIn', 'start.execOut->say/print.execIn']);
    assert.equal(graph.nodes[1].properties['pin:value'], 'hello', 'the unwired input passes on the value typed on the instance');
  });

  test('each use has its own copy; an unwired input without a value uses its default', () => {
    const d = classDoc(
      [node('start', 'core:event.start'), node('a', MACRO_INSTANCE, { graph: 'Say' }), node('b', MACRO_INSTANCE, { graph: 'Say', 'pin:text': 'two' })],
      [wire('start', 'execOut', 'a', 'in'), wire('a', 'out', 'b', 'in')],
      [sayMacro()]
    );
    assert.deepEqual(logs(run(d)), ['hi', 'two']);
  });

  test('a macro that uses itself, a missing macro and missing tunnels are problems', () => {
    const loop = sayMacro('Loop');
    loop.nodes.push(node('self', MACRO_INSTANCE, { graph: 'Loop' }));
    const noOutputs: Graph = { ...sayMacro('Broken'), nodes: sayMacro('Broken').nodes.filter((n) => n.type !== MACRO_OUTPUTS) };
    const d = classDoc(
      [node('loop', MACRO_INSTANCE, { graph: 'Loop' }), node('gone', MACRO_INSTANCE, { graph: 'Gone' }), node('broken', MACRO_INSTANCE, { graph: 'Broken' })],
      [], [loop, noOutputs]
    );
    const { problems } = expandMacros(d.graphs[0], macroLookup(d.graphs, () => undefined));
    assert.deepEqual(problems.map((p) => [p.nodeId, p.message]), [
      ['loop', 'In macro "Say": Macro "Say" uses itself.'],
      ['gone', 'This macro no longer exists.'],
      ['broken', 'Macro "Say" needs exactly one Inputs node and one Outputs node.']
    ]);
  });
});

describe('compiling macros', () => {
  test('errors inside a macro are reported once, in the macro, and problems on the instance', () => {
    const say = sayMacro();
    // Wire a string output into Branch's condition: a type error inside the macro.
    say.nodes.push(node('branch', 'core:flow.branch'), node('text', 'core:string.append'));
    const d = classDoc(
      [node('start', 'core:event.start'), node('a', MACRO_INSTANCE, { graph: 'Say' }), node('b', MACRO_INSTANCE, { graph: 'Say' }), node('gone', MACRO_INSTANCE, { graph: 'Gone' })],
      [wire('start', 'execOut', 'a', 'in'), wire('a', 'out', 'b', 'in'), wire('b', 'out', 'gone', 'in')],
      [{ ...say, connections: [...say.connections, wire('inputs', 'text', 'branch', 'condition')] }]
    );
    const { diagnostics } = compile(d);
    assert.deepEqual(diagnostics.filter((x) => x.severity === 'error').map((x) => [x.code, x.graphId, x.nodeId]), [
      ['macro-invalid', 'EventGraph', 'gone'],
      ['type-mismatch', 'Say', 'branch']
    ]);
  });

  test('Inputs and Outputs nodes outside a macro are errors', () => {
    const d = classDoc([node('start', 'core:event.start'), node('in', MACRO_INPUTS, { graph: 'Say' })], [], [sayMacro()]);
    assert.ok(compile(d).diagnostics.some((x) => x.code === 'tunnel-outside-macro' && x.nodeId === 'in'));
  });

  test('code from inside a macro is marked with the macro and its instance', () => {
    const d = classDoc(
      [node('start', 'core:event.start'), node('say', MACRO_INSTANCE, { graph: 'Say' })],
      [wire('start', 'execOut', 'say', 'in')],
      [sayMacro()]
    );
    const { output } = compile(d);
    assert.match(output!.text, /\/\/ Say: Print \(say\)\n\s*console\.log\("hi"\);/);
  });

  test('a macro library compiles to nothing, after checking its macros', () => {
    const library: GraphDocument = { schemaVersion: 3, name: 'Macros', kind: 'macroLibrary', language: 'javascript', variables: [], graphs: [sayMacro()] };
    const result = compile(library);
    assert.equal(result.output, undefined);
    assert.deepEqual(result.diagnostics, []);
  });

  test('Simulate reports an instance that can\'t be expanded', () => {
    const d = classDoc([node('start', 'core:event.start'), node('gone', MACRO_INSTANCE, { graph: 'Gone' })], [wire('start', 'execOut', 'gone', 'in')], []);
    const error = run(d).find((e) => e.kind === 'error');
    assert.deepEqual([error?.nodeId, error?.message], ['gone', 'This macro no longer exists.']);
  });

  test('Simulate reports nodes inside a macro as its instance', () => {
    const d = classDoc(
      [node('start', 'core:event.start'), node('say', MACRO_INSTANCE, { graph: 'Say' })],
      [wire('start', 'execOut', 'say', 'in')],
      [sayMacro()]
    );
    const events = run(d);
    assert.ok(events.some((e) => e.kind === 'log' && e.nodeId === 'say'));
    assert.ok(!events.some((e) => e.nodeId?.includes('/')));
  });
});

describe('macro signatures', () => {
  test('a new macro has its tunnels; pins may be exec pins', () => {
    const d = classDoc([], [], []);
    const macro = addGraph(d, 'macro');
    assert.deepEqual(macro.nodes.map((n) => n.type), [MACRO_INPUTS, MACRO_OUTPUTS]);
    const pin = addSignaturePin(d, macro.id, 'inputs', 'exec')!;
    assert.deepEqual(pin, { id: 'NewParam', name: 'NewParam', kind: 'exec' });
    const out = addSignaturePin(d, macro.id, 'outputs')!;
    assert.equal(macro.nodes.length, 2, 'no Return Node in a macro');
    setSignaturePinType(d, macro.id, 'outputs', out.id, 'exec');
    assert.deepEqual(macro.signature?.outputs, [{ id: out.id, name: 'NewParam', kind: 'exec' }]);
    setSignaturePinType(d, macro.id, 'outputs', out.id, { id: 'int' });
    assert.deepEqual(macro.signature?.outputs, [{ id: out.id, name: 'NewParam', kind: 'data', type: { id: 'int' } }]);
  });

  test('the instance takes the signature\'s pins', () => {
    const d = classDoc([node('say', MACRO_INSTANCE, { graph: 'Say' })], [], [sayMacro()]);
    const def = createResolver(new NodeRegistry(), d)(d.graphs[0].nodes[0])!;
    assert.equal(def.displayName, 'Say');
    assert.deepEqual(def.inputs.map((p) => [p.id, p.kind]), [['in', 'exec'], ['text', 'data']]);
    assert.deepEqual(def.outputs.map((p) => [p.id, p.kind]), [['out', 'exec']]);
  });
});

describe('Collapse to Macro', () => {
  test('several ways in and out become exec pins; the program does the same', () => {
    // Start → Branch(true): True → Print A, False → Print B; both → Print "end".
    const nodes = [
      node('start', 'core:event.start'), node('branch', 'core:flow.branch', { 'pin:condition': true }),
      node('a', 'core:console.print', { 'pin:value': 'A' }), node('b', 'core:console.print', { 'pin:value': 'B' }),
      node('end', 'core:console.print', { 'pin:value': 'end' })
    ];
    const wires = [wire('start', 'execOut', 'branch', 'execIn'), wire('branch', 'true', 'a', 'execIn'), wire('branch', 'false', 'b', 'execIn'), wire('a', 'execOut', 'end', 'execIn'), wire('b', 'execOut', 'end', 'execIn')];
    const d = classDoc(nodes, wires, []);
    const before = logs(run(d));
    const registry = new NodeRegistry();
    let n = 0;
    const result = collapseToMacro(d, d.graphs[0], new Set(['a', 'b']), createResolver(registry, d), () => `c${++n}`);
    assert.ok(typeof result !== 'string', String(result));
    assert.deepEqual(result.macro.signature?.inputs.map((p) => [p.name, p.kind]), [['In', 'exec'], ['In_1', 'exec']]);
    assert.deepEqual(result.macro.signature?.outputs.map((p) => [p.name, p.kind]), [['Out', 'exec'], ['Out_1', 'exec']]);
    assert.deepEqual(logs(run(d)), before);
    assert.deepEqual(compile(d).diagnostics, []);
  });

  test('events can\'t be collapsed', () => {
    const d = classDoc([node('start', 'core:event.start')], [], []);
    assert.equal(typeof collapseToMacro(d, d.graphs[0], new Set(['start']), () => undefined, () => 'c'), 'string');
  });
});

describe('macro libraries', () => {
  const library: GraphDocument = { schemaVersion: 3, name: 'Shared Macros', kind: 'macroLibrary', language: 'javascript', variables: [], graphs: [sayMacro(), {
    // Twice: Say, then Say again, using the library's own macro.
    id: 'Twice', name: 'Twice', kind: 'macro', comments: [],
    signature: { inputs: [exec('in', 'In')], outputs: [exec('out', 'Out')] },
    nodes: [node('inputs', MACRO_INPUTS, { graph: 'Twice' }), node('one', MACRO_INSTANCE, { graph: 'Say', 'pin:text': 'one' }), node('two', MACRO_INSTANCE, { graph: 'Say', 'pin:text': 'two' }), node('outputs', MACRO_OUTPUTS, { graph: 'Twice' })],
    connections: [wire('inputs', 'in', 'one', 'in'), wire('one', 'out', 'two', 'in'), wire('two', 'out', 'outputs', 'out')]
  }] };

  test('each macro is a node that embeds its graph', () => {
    const defs = macroLibraryDefinitions(library, 'lib/Shared.vgraph');
    assert.deepEqual(defs.map((d) => [d.type, d.displayName, d.category]), [
      ['macro:lib/Shared.vgraph#Say', 'Say', 'Shared Macros'],
      ['macro:lib/Shared.vgraph#Twice', 'Twice', 'Shared Macros']
    ]);
    const twice = defs[1].implementation;
    assert.ok(twice?.kind === 'macro');
    assert.ok(!twice.graph.nodes.some((n) => n.type === MACRO_INSTANCE), 'the library\'s own macros are already expanded');
  });

  test('a graph uses them, compiled and in Simulate', () => {
    const registry = new NodeRegistry();
    registry.registerMany(macroLibraryDefinitions(library, 'lib/Shared.vgraph'));
    const type = macroNodeType('lib/Shared.vgraph', 'Twice');
    const d = classDoc([node('start', 'core:event.start'), node('twice', type)], [wire('start', 'execOut', 'twice', 'in')], []);
    assert.deepEqual(logs(run(d, registry)), ['one', 'two']);
    const result = compile(d, registry);
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.output!.text, /console\.log\("one"\);[\s\S]*console\.log\("two"\);/);
  });

  test('a missing library is reported on the node', () => {
    const d = classDoc([node('start', 'core:event.start'), node('m', 'macro:lib/Gone.vgraph#X')], [wire('start', 'execOut', 'm', 'in')], []);
    assert.deepEqual(compile(d).diagnostics.map((x) => [x.code, x.nodeId]), [['macro-invalid', 'm']]);
  });
});
