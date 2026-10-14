// Unreal's standard flow-control macros as built-in nodes (docs/program-structure.md, "Flow
// control"): loops, Do Once, Do N, Gate, MultiGate, Flip Flop and Switch. Their pins follow Unreal.
import { GraphNode, NodeDefinition, PinDefinition } from './model';

const exec = (id: string, name: string, direction: PinDefinition['direction']): PinDefinition => ({ id, name, kind: 'exec', direction });
const data = (id: string, name: string, direction: PinDefinition['direction'], type: string, defaultValue?: unknown): PinDefinition => ({
  id, name, kind: 'data', direction, type: { id: type }, ...(defaultValue !== undefined ? { defaultValue } : {})
});

export const FOR_LOOP = 'core:flow.for-loop';
export const FOR_LOOP_WITH_BREAK = 'core:flow.for-loop-with-break';
export const WHILE_LOOP = 'core:flow.while-loop';
export const DO_ONCE = 'core:flow.do-once';
export const DO_N = 'core:flow.do-n';
export const GATE = 'core:flow.gate';
export const MULTIGATE = 'core:flow.multigate';
export const FLIP_FLOP = 'core:flow.flip-flop';
export const SWITCH_INT = 'core:flow.switch-int';
export const SWITCH_STRING = 'core:flow.switch-string';

const COLOR = '#e6b450';

function flow(type: string, displayName: string, operation: string, description: string, inputs: PinDefinition[], outputs: PinDefinition[], keywords: string[]): NodeDefinition {
  return { type, version: 1, displayName, category: 'Flow', description, color: COLOR, inputs, outputs, implementation: { kind: 'native', operation }, keywords };
}

export function flowControlDefinitions(): NodeDefinition[] {
  const loopOutputs = [exec('loopBody', 'Loop Body', 'output'), data('index', 'Index', 'output', 'int'), exec('completed', 'Completed', 'output')];
  return [
    flow(FOR_LOOP, 'For Loop', 'for-loop', 'Runs Loop Body for each Index from First Index to Last Index, then Completed.',
      [exec('execIn', '', 'input'), data('firstIndex', 'First Index', 'input', 'int', 0), data('lastIndex', 'Last Index', 'input', 'int', 0)], loopOutputs, ['loop', 'for', 'repeat', 'iterate']),
    flow(FOR_LOOP_WITH_BREAK, 'For Loop with Break', 'for-loop', 'Like For Loop; running Break stops the loop after the current Loop Body.',
      [exec('execIn', '', 'input'), data('firstIndex', 'First Index', 'input', 'int', 0), data('lastIndex', 'Last Index', 'input', 'int', 0), exec('break', 'Break', 'input')], loopOutputs, ['loop', 'for', 'break', 'stop']),
    flow(WHILE_LOOP, 'While Loop', 'while-loop', 'Runs Loop Body while Condition is true, then Completed.',
      [exec('execIn', '', 'input'), data('condition', 'Condition', 'input', 'bool', false)], [exec('loopBody', 'Loop Body', 'output'), exec('completed', 'Completed', 'output')], ['loop', 'while', 'repeat']),
    flow(DO_ONCE, 'Do Once', 'do-once', 'Runs Completed the first time only, until Reset.',
      [exec('execIn', '', 'input'), exec('reset', 'Reset', 'input'), data('startClosed', 'Start Closed', 'input', 'bool', false)], [exec('completed', 'Completed', 'output')], ['once', 'single', 'first time']),
    flow(DO_N, 'Do N', 'do-n', 'Runs Exit the first N times, until Reset.',
      [exec('enter', 'Enter', 'input'), data('n', 'N', 'input', 'int', 1), exec('reset', 'Reset', 'input')], [exec('exit', 'Exit', 'output'), data('counter', 'Counter', 'output', 'int')], ['times', 'count', 'limit']),
    flow(GATE, 'Gate', 'gate', 'Runs Exit for Enter while open. Open, Close and Toggle change it.',
      [exec('enter', 'Enter', 'input'), exec('open', 'Open', 'input'), exec('close', 'Close', 'input'), exec('toggle', 'Toggle', 'input'), data('startClosed', 'Start Closed', 'input', 'bool', false)],
      [exec('exit', 'Exit', 'output')], ['gate', 'open', 'close', 'block']),
    flow(MULTIGATE, 'MultiGate', 'multigate', 'Each run goes to the next output in turn. With Loop, it starts over after the last.',
      [exec('execIn', '', 'input'), exec('reset', 'Reset', 'input'), data('loop', 'Loop', 'input', 'bool', false), data('startIndex', 'Start Index', 'input', 'int', -1)],
      [exec('out0', 'Out 0', 'output'), exec('out1', 'Out 1', 'output')], ['multigate', 'round robin', 'cycle', 'next']),
    flow(FLIP_FLOP, 'Flip Flop', 'flip-flop', 'Alternates between A and B, starting with A.',
      [exec('execIn', '', 'input')], [exec('a', 'A', 'output'), exec('b', 'B', 'output'), data('isA', 'Is A', 'output', 'bool')], ['toggle', 'alternate', 'flipflop']),
    flow(SWITCH_INT, 'Switch on Int', 'switch', 'Runs the output for Selection\'s value, else Default.',
      [exec('execIn', '', 'input'), data('selection', 'Selection', 'input', 'int', 0)], [exec('case0', '0', 'output'), exec('case1', '1', 'output'), exec('default', 'Default', 'output')], ['switch', 'case', 'select']),
    flow(SWITCH_STRING, 'Switch on String', 'switch', 'Runs the output whose name equals Selection, else Default.',
      [exec('execIn', '', 'input'), data('selection', 'Selection', 'input', 'string', '')], [exec('default', 'Default', 'output')], ['switch', 'case', 'select', 'string'])
  ];
}

// Exec inputs that only change a node's state and don't continue (Unreal's Reset, Break, Open,
// Close, Toggle). Wiring back into them from downstream is not a cycle.
const STATE_INPUTS: Record<string, string[]> = {
  'for-loop': ['break'],
  'do-once': ['reset'],
  'do-n': ['reset'],
  gate: ['open', 'close', 'toggle'],
  multigate: ['reset']
};

export function isStateInput(def: NodeDefinition, pinId: string): boolean {
  const operation = def.implementation?.kind === 'native' ? def.implementation.operation : '';
  return STATE_INPUTS[operation]?.includes(pinId) ?? false;
}

// The exec input that runs a node: its first one.
export function mainExecInput(def: NodeDefinition): string {
  return def.inputs.find((p) => p.kind === 'exec')?.id ?? 'execIn';
}

// ---- Nodes with outputs added on the node, as Sequence's ----------------------------------------

export const DEFAULT_MULTIGATE_PINS = 2;
export const DEFAULT_SWITCH_INT_PINS = 2;

export function pinCount(node: GraphNode, fallback: number): number {
  const pins = Number(node.properties.pins);
  return Number.isInteger(pins) && pins >= 1 ? pins : fallback;
}

// Switch on Int's cases: Start Index, Start Index + 1, … (Unreal's "Start Index" and "Add pin").
export function switchIntCases(node: GraphNode): number[] {
  const start = Number(node.properties.start);
  const first = Number.isInteger(start) ? start : 0;
  return Array.from({ length: pinCount(node, DEFAULT_SWITCH_INT_PINS) }, (_, i) => first + i);
}

// Switch on String's cases, edited in Details (Unreal's "Pin Names").
export function switchStringCases(node: GraphNode): string[] {
  const cases = node.properties.cases;
  return Array.isArray(cases) ? cases.map(String) : [];
}

// A node's definition with the outputs its properties add (src/core/resolve.ts).
export function flowControlDefinition(base: NodeDefinition, node: GraphNode): NodeDefinition {
  if (node.type === MULTIGATE) {
    const outputs = Array.from({ length: pinCount(node, DEFAULT_MULTIGATE_PINS) }, (_, i) => exec(`out${i}`, `Out ${i}`, 'output'));
    return { ...base, outputs };
  }
  if (node.type === SWITCH_INT) {
    const cases = switchIntCases(node).map((value, i) => exec(`case${i}`, String(value), 'output'));
    return { ...base, outputs: [...cases, exec('default', 'Default', 'output')] };
  }
  if (node.type === SWITCH_STRING) {
    const cases = switchStringCases(node).map((value, i) => exec(`case${i}`, value, 'output'));
    return { ...base, outputs: [...cases, exec('default', 'Default', 'output')] };
  }
  return base;
}
