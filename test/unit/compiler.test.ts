import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CompileDiagnostic } from '../../src/core/compiler/diagnostics';
import { IrStatement } from '../../src/core/compiler/ir';
import { LowerResult, lowerDocument } from '../../src/core/compiler/lower';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { doc, node, readRepoFile, wire } from './helpers';

function registryWith(...extra: NodeDefinition[]): NodeRegistry {
  const registry = new NodeRegistry();
  extra.forEach((d) => registry.register(d));
  return registry;
}

const lower = (d: GraphDocument, registry = new NodeRegistry()): LowerResult =>
  lowerDocument(d, { registry, languageName: 'TypeScript', snippetLanguages: ['typescript', 'javascript'], importLanguages: ['typescript', 'javascript'] });

const codes = (diagnostics: CompileDiagnostic[], severity: 'error' | 'warning') =>
  diagnostics.filter((d) => d.severity === severity).map((d) => d.code);

// Statement kinds, flattening if-branches, for compact structural assertions.
const shape = (statements: IrStatement[]): unknown[] => statements.map((s) =>
  s.kind === 'if' ? { if: { then: shape(s.then), else: shape(s.else) } } : `${s.kind}:${s.source.nodeId}`);

const codeNode = (type: string, languages: Record<string, string>, outputs = 1): NodeDefinition => ({
  type, version: 1, displayName: 'Double', category: 'Test',
  inputs: [{ id: 'execIn', name: '', kind: 'exec', direction: 'input' }, { id: 'value', name: 'Value', kind: 'data', direction: 'input', type: { id: 'float' } }],
  outputs: [
    { id: 'execOut', name: '', kind: 'exec', direction: 'output' },
    ...Array.from({ length: outputs }, (_, i) => ({ id: `out${i}`, name: `Out ${i}`, kind: 'data' as const, direction: 'output' as const, type: { id: 'float' } }))
  ],
  implementation: { kind: 'code', languages }
});

describe('lowerDocument: the sample graph', () => {
  const result = lower(parseDocument(readRepoFile('sample/demo.vgraph')).document);

  test('compiles without diagnostics', () => {
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.program);
  });

  test('produces the expected structure', () => {
    const program = result.program!;
    assert.equal(program.className, 'BlueprintDemo');
    assert.deepEqual(shape(program.start), [
      'store:add_1',
      { if: { then: ['print:print_true'], else: ['print:print_false'] } }
    ]);
    assert.deepEqual(program.slots.map((s) => s.name), ['add_1_result']);
    assert.deepEqual(program.blocks, []);
    assert.deepEqual(program.members, []);
  });

  test('wraps Add inputs and the Branch condition in conversions', () => {
    const [store, branch] = result.program!.start;
    assert.equal(store.kind === 'store' && store.value.kind === 'add' && store.value.left.kind, 'toNumber');
    assert.equal(branch.kind === 'if' && branch.condition.kind, 'toBoolean');
  });
});

describe('lowerDocument: execution flow', () => {
  test('a node reached by two wires becomes a shared block', () => {
    const result = lower(doc(
      [node('s', 'core:event.start'), node('q', 'core:flow.sequence'), node('p', 'core:console.print', { 'pin:value': 'x' }), node('e', 'core:flow.end')],
      [wire('s', 'execOut', 'q', 'execIn'), wire('q', 'then0', 'p', 'execIn'), wire('q', 'then1', 'p', 'execIn'), wire('p', 'execOut', 'e', 'execIn')]
    ));
    const program = result.program!;
    assert.deepEqual(shape(program.start), ['callBlock:p', 'callBlock:p']);
    assert.equal(program.blocks.length, 1);
    assert.deepEqual(shape(program.blocks[0].body), ['print:p']);
  });

  test('Start nodes from every event graph run in order', () => {
    const d = doc([node('s', 'core:event.start'), node('p', 'core:console.print')], [wire('s', 'execOut', 'p', 'execIn')]);
    d.graphs.push({ id: 'Second', name: 'Second', kind: 'event', comments: [], nodes: [node('s2', 'core:event.start'), node('p2', 'core:console.print')], connections: [wire('s2', 'execOut', 'p2', 'execIn')] });
    assert.deepEqual(shape(lower(d).program!.start), ['print:p', 'print:p2']);
  });

  test('exec cycles are errors', () => {
    const result = lower(doc(
      [node('s', 'core:event.start'), node('a', 'core:console.print'), node('b', 'core:console.print')],
      [wire('s', 'execOut', 'a', 'execIn'), wire('a', 'execOut', 'b', 'execIn'), wire('b', 'execOut', 'a', 'execIn')]
    ));
    assert.deepEqual(codes(result.diagnostics, 'error'), ['exec-cycle']);
    assert.equal(result.program, undefined);
  });

  test('a graph without Start compiles with a warning', () => {
    const result = lower(doc([node('p', 'core:console.print')], []));
    assert.deepEqual(codes(result.diagnostics, 'warning'), ['no-start']);
    assert.deepEqual(result.program?.start, []);
  });
});

describe('lowerDocument: data flow', () => {
  test('reading an impure node that never ran still reads its slot', () => {
    const result = lower(doc(
      [node('s', 'core:event.start'), node('add', 'core:math.add'), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'p', 'execIn'), wire('add', 'result', 'p', 'value')]
    ));
    const [print] = result.program!.start;
    assert.equal(print.kind === 'print' && print.value.kind, 'output');
  });

  test('unconnected inputs use the stored value, else the pin default', () => {
    const result = lower(doc(
      [node('s', 'core:event.start'), node('add', 'core:math.add', { 'pin:a': 5 })],
      [wire('s', 'execOut', 'add', 'execIn')]
    ));
    const [store] = result.program!.start;
    assert.ok(store.kind === 'store' && store.value.kind === 'add');
    if (store.kind !== 'store' || store.value.kind !== 'add') return;
    assert.deepEqual(store.value.left, { kind: 'toNumber', value: { kind: 'literal', value: 5 } });
    assert.deepEqual(store.value.right, { kind: 'toNumber', value: { kind: 'literal', value: 20 } });
  });

  test('wires between incompatible types are errors', () => {
    const result = lower(doc(
      [node('s', 'core:event.start'), node('add', 'core:math.add'), node('br', 'core:flow.branch')],
      [wire('s', 'execOut', 'br', 'execIn'), wire('add', 'result', 'br', 'condition')]
    ));
    assert.deepEqual(codes(result.diagnostics, 'error'), ['type-mismatch']);
  });

  test('wires to missing nodes are ignored with a warning', () => {
    const result = lower(doc([node('s', 'core:event.start')], [wire('s', 'execOut', 'ghost', 'execIn')]));
    assert.deepEqual(codes(result.diagnostics, 'warning'), ['dangling-connection']);
    assert.ok(result.program);
  });

  test('unknown node types are errors', () => {
    const result = lower(doc([node('s', 'core:event.start'), node('x', 'lib.gone')], []));
    assert.deepEqual(codes(result.diagnostics, 'error'), ['unknown-node-type']);
  });
});

describe('lowerDocument: variables', () => {
  test('declared variables become members with their defaults', () => {
    const d = doc([], [], [{ id: 'v', name: 'Lives', type: { id: 'int' }, defaultValue: 3 }]);
    assert.deepEqual(lower(d).program!.members, [{ id: 'v', name: 'Lives', type: { id: 'int' }, initial: { kind: 'literal', value: 3 } }]);
  });

  test('Get and Set nodes use the member they are bound to', () => {
    const result = lower(doc(
      [node('s', 'core:event.start'), node('set', 'core:variable.set', { variable: 'v', 'pin:value': 2 }), node('get', 'core:variable.get', { variable: 'v' }), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'set', 'execIn'), wire('set', 'execOut', 'p', 'execIn'), wire('get', 'value', 'p', 'value')],
      [{ id: 'v', name: 'Lives', type: { id: 'int' } }]
    ));
    assert.deepEqual(result.diagnostics, []);
    const [set, print] = result.program!.start;
    assert.ok(set.kind === 'setMember' && set.member === 'v');
    assert.ok(print.kind === 'print' && print.value.kind === 'member' && print.value.member === 'v');
  });

  test('a variable node without a variable is an error', () => {
    const result = lower(doc([node('s', 'core:event.start'), node('set', 'core:variable.set')], [wire('s', 'execOut', 'set', 'execIn')]));
    assert.deepEqual(codes(result.diagnostics, 'error'), ['variable-unbound']);
  });

  test('a variable node whose variable was deleted is an error', () => {
    const result = lower(doc([node('s', 'core:event.start'), node('set', 'core:variable.set', { variable: 'gone' })], [wire('s', 'execOut', 'set', 'execIn')]));
    assert.deepEqual(codes(result.diagnostics, 'error'), ['unknown-variable']);
  });

  test('assigning an incompatible value is an error', () => {
    const result = lower(doc(
      [node('s', 'core:event.start'), node('set', 'core:variable.set', { variable: 'a', 'pin:value': 1 })],
      [wire('s', 'execOut', 'set', 'execIn')],
      [{ id: 'a', name: 'Alive', type: { id: 'bool' } }]
    ));
    assert.deepEqual(codes(result.diagnostics, 'error'), ['variable-type-mismatch']);
  });
});

describe('lowerDocument: code nodes', () => {
  const graphWith = (type: string) => doc(
    [node('s', 'core:event.start'), node('d', type, { 'pin:value': 4 })],
    [wire('s', 'execOut', 'd', 'execIn')]
  );

  test('use the preferred snippet and store the first output', () => {
    const result = lower(graphWith('t.double'), registryWith(codeNode('t.double', { javascript: 'return value * 2;', typescript: 'return value * 2 as number;' })));
    const helper = result.program!.helpers[0];
    assert.equal(helper.code, 'return value * 2 as number;');
    assert.deepEqual(helper.params, [{ pinId: 'value', type: { id: 'float' } }]);
    const [call] = result.program!.start;
    assert.ok(call.kind === 'call' && call.callee.kind === 'helper' && call.resultSlot);
  });

  test('without a snippet for the language are errors', () => {
    const result = lower(graphWith('t.py'), registryWith(codeNode('t.py', { python: 'return value * 2' })));
    assert.deepEqual(codes(result.diagnostics, 'error'), ['missing-snippet']);
    assert.match(result.diagnostics[0].message, /no TypeScript implementation; add a "typescript" or "javascript" entry/);
  });

  test('with several data outputs produce only the first, with a warning', () => {
    const result = lower(graphWith('t.multi'), registryWith(codeNode('t.multi', { javascript: 'return 1;' }, 2)));
    assert.deepEqual(codes(result.diagnostics, 'warning'), ['extra-outputs']);
  });
});

// A function from project code, as the importer describes it (docs/code-as-nodes.md).
const projectFunction = (name: string, options: { pure?: boolean; language?: string; path?: string } = {}): NodeDefinition => ({
  type: `fn:${options.language ?? 'typescript'}:${options.path ?? 'lib/math.ts'}#${name}`, version: 1, displayName: name, category: 'Project',
  inputs: [
    ...(options.pure ? [] : [{ id: 'execIn', name: '', kind: 'exec' as const, direction: 'input' as const }]),
    { id: 'value', name: 'Value', kind: 'data', direction: 'input', type: { id: 'float' } }
  ],
  outputs: [
    ...(options.pure ? [] : [{ id: 'execOut', name: '', kind: 'exec' as const, direction: 'output' as const }]),
    { id: 'returnValue', name: 'Return Value', kind: 'data', direction: 'output', type: { id: 'float' } }
  ],
  implementation: { kind: 'function', language: options.language ?? 'typescript', path: options.path ?? 'lib/math.ts', name }
});

describe('lowerDocument: pure nodes and project functions', () => {
  test('a pure node is evaluated where each value is used', () => {
    const double = projectFunction('double', { pure: true });
    const result = lower(doc(
      [node('s', 'core:event.start'), node('d', double.type, { 'pin:value': 4 }), node('p1', 'core:console.print'), node('p2', 'core:console.print')],
      [wire('s', 'execOut', 'p1', 'execIn'), wire('p1', 'execOut', 'p2', 'execIn'), wire('d', 'returnValue', 'p1', 'value'), wire('d', 'returnValue', 'p2', 'value')]
    ), registryWith(double));
    assert.deepEqual(result.diagnostics, []);
    const call = { kind: 'call', callee: { kind: 'import', id: double.type }, args: [{ kind: 'literal', value: 4 }] };
    assert.deepEqual(result.program!.start.map((s) => s.kind === 'print' && s.value), [call, call]);
    assert.deepEqual(result.program!.slots, [], 'pure nodes need no storage');
  });

  test('an impure project function is called once, its result stored, and imported', () => {
    const save = projectFunction('save');
    const result = lower(doc(
      [node('s', 'core:event.start'), node('f', save.type)],
      [wire('s', 'execOut', 'f', 'execIn')]
    ), registryWith(save));
    const [call] = result.program!.start;
    assert.ok(call.kind === 'call' && call.callee.kind === 'import' && call.resultSlot);
    assert.deepEqual(result.program!.imports, [{
      id: save.type, name: 'save', language: 'typescript', path: 'lib/math.ts',
      params: [{ pinId: 'value', type: { id: 'float' } }], returns: { id: 'float' }
    }]);
  });

  test('a function in another language is an error on each node that calls it', () => {
    const fn = projectFunction('double', { language: 'python', path: 'lib/math.py' });
    const result = lower(doc(
      [node('s', 'core:event.start'), node('a', fn.type), node('b', fn.type)],
      [wire('s', 'execOut', 'a', 'execIn'), wire('a', 'execOut', 'b', 'execIn')]
    ), registryWith(fn));
    assert.deepEqual(codes(result.diagnostics, 'error'), ['wrong-language', 'wrong-language']);
    assert.match(result.diagnostics[0].message, /"double" is Python code \(lib\/math\.py\); a TypeScript graph can't call it/);
  });

  test('pure nodes wired in a loop are an error', () => {
    const double = projectFunction('double', { pure: true });
    const result = lower(doc(
      [node('s', 'core:event.start'), node('a', double.type), node('b', double.type), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'p', 'execIn'), wire('a', 'returnValue', 'b', 'value'), wire('b', 'returnValue', 'a', 'value'), wire('a', 'returnValue', 'p', 'value')]
    ), registryWith(double));
    assert.deepEqual(codes(result.diagnostics, 'error'), ['data-cycle']);
  });
});

describe('lowerDocument: graph kinds', () => {
  test('function graphs with nodes are skipped with a warning', () => {
    const d = doc([], []);
    d.graphs.push({ id: 'Helper', name: 'Helper', kind: 'function', signature: { inputs: [], outputs: [] }, comments: [], nodes: [node('p', 'core:console.print')], connections: [] });
    assert.ok(codes(lower(d).diagnostics, 'warning').includes('graph-not-compiled'));
  });
});

describe('lowerDocument: flow control', () => {
  test('a wire back into a loop\'s Break is not a cycle; into its main input it is', () => {
    const graph = (target: string) => doc(
      [node('s', 'core:event.start'), node('f', 'core:flow.for-loop-with-break'), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'f', 'execIn'), wire('f', 'loopBody', 'p', 'execIn'), wire('p', 'execOut', 'f', target)]
    );
    assert.deepEqual(codes(lower(graph('break')).diagnostics, 'error'), []);
    assert.deepEqual(codes(lower(graph('execIn')).diagnostics, 'error'), ['exec-cycle']);
  });

  test('Switch cases become one if/else-if chain from the same node', () => {
    const result = lower(doc([node('s', 'core:event.start'), node('sw', 'core:flow.switch-int', { 'pin:selection': 1 }), node('a', 'core:console.print'), node('b', 'core:console.print')],
      [wire('s', 'execOut', 'sw', 'execIn'), wire('sw', 'case0', 'a', 'execIn'), wire('sw', 'case1', 'b', 'execIn')]));
    assert.deepEqual(shape(result.program!.start), ['store:sw', { if: { then: ['print:a'], else: [{ if: { then: ['print:b'], else: [] } }] } }]);
  });
});
