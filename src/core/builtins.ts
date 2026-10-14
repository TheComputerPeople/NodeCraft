import { NodeDefinition, PinDefinition, TypeRef } from './model';
import { containerDefinitions } from './containers';
import { flowControlDefinitions } from './flow-control';
import { functionDefinitions } from './functions';
import { macroDefinitions } from './macros';
import { eventDefinitions } from './events';
import { standardLibraryDefinitions } from './stdlib';

const t = (id: string): TypeRef => ({ id });
const dataInput = (id: string, name: string, type: string, defaultValue?: unknown): PinDefinition => ({
  id, name, kind: 'data', direction: 'input', type: t(type), defaultValue
});
const dataOutput = (id: string, name: string, type: string): PinDefinition => ({
  id, name, kind: 'data', direction: 'output', type: t(type)
});
const execInput = (id = 'execIn'): PinDefinition => ({ id, name: '', kind: 'exec', direction: 'input' });
const execOutput = (id = 'execOut', name = ''): PinDefinition => ({ id, name, kind: 'exec', direction: 'output' });

export function builtinNodeDefinitions(): NodeDefinition[] {
  return [
    {
      type: 'core:event.start', version: 1, displayName: 'Start', category: 'Flow', keywords: ['begin play', 'beginplay', 'event', 'main', 'entry'],
      description: 'Entry point for a graph.', color: '#7bd88f', inputs: [],
      outputs: [execOutput('execOut')], implementation: { kind: 'native', operation: 'start' }
    },
    {
      type: 'core:flow.branch', version: 1, displayName: 'Branch', category: 'Flow',
      description: 'Choose one execution path from a boolean value.', color: '#e6b450', keywords: ['if', 'else', 'condition'],
      inputs: [execInput(), dataInput('condition', 'Condition', 'bool', true)],
      outputs: [execOutput('true', 'True'), execOutput('false', 'False')],
      implementation: { kind: 'native', operation: 'branch' }
    },
    {
      type: 'core:math.add', version: 1, displayName: 'Add', category: 'Math',
      description: 'Add two numbers.', color: '#72a7ff',
      inputs: [execInput(), dataInput('a', 'A', 'float', 10), dataInput('b', 'B', 'float', 20)],
      outputs: [execOutput(), dataOutput('result', 'Result', 'float')],
      implementation: { kind: 'native', operation: 'add' }
    },
    {
      type: 'core:console.print', version: 1, displayName: 'Print', category: 'Debug', keywords: ['print string', 'log', 'output', 'debug'],
      description: 'Write a value to the VS Code Output panel.', color: '#bb86fc',
      inputs: [execInput(), dataInput('value', 'Value', 'any', 'Hello from Visual Scripting')],
      outputs: [execOutput()], implementation: { kind: 'native', operation: 'print' }
    },
    {
      // Bound to a declared variable through the node's `variable` property; the resolver gives
      // the pins the variable's name and type (src/core/resolve.ts).
      type: 'core:variable.set', version: 1, displayName: 'Set Variable', category: 'Variables',
      description: 'Set a variable.', color: '#ff8b7b',
      inputs: [execInput(), dataInput('value', 'Value', 'any')],
      outputs: [execOutput(), dataOutput('result', 'Value', 'any')], implementation: { kind: 'native', operation: 'set-variable' }
    },
    {
      type: 'core:variable.get', version: 1, displayName: 'Get Variable', category: 'Variables',
      description: 'Read a variable.', color: '#ff8b7b', inputs: [],
      outputs: [dataOutput('value', 'Value', 'any')], implementation: { kind: 'native', operation: 'get-variable' }
    },
    {
      // The number of Then outputs comes from the node's `pins` property (src/core/resolve.ts).
      type: 'core:flow.sequence', version: 1, displayName: 'Sequence', category: 'Flow',
      description: 'Run execution outputs in order.', color: '#e6b450', inputs: [execInput()], keywords: ['then', 'order', 'series'],
      outputs: [execOutput('then0', 'Then 0'), execOutput('then1', 'Then 1'), execOutput('then2', 'Then 2')],
      implementation: { kind: 'native', operation: 'sequence' }
    },
    {
      // Pure conversion, placed automatically when a bool or number is wired into a string input
      // (Unreal's auto-conversion nodes). Formats the value as Print does (docs/semantics.md).
      type: 'core:convert.to-string', version: 1, displayName: 'To String', category: 'Utilities', compact: true,
      description: 'Convert a value to text.', keywords: ['conversion', 'convert', 'text', 'string'],
      inputs: [dataInput('value', 'Value', 'any')], outputs: [dataOutput('result', 'Result', 'string')],
      implementation: { kind: 'native', operation: 'to-string' }
    },
    {
      // A knot that passes a wire through unchanged, for tidying wires (Unreal's reroute node).
      // Its pins match the wire it was placed on: `kind` is exec or data, `type` the data type.
      type: 'core:reroute', version: 1, displayName: 'Reroute Node', category: 'Utilities', keywords: ['knot', 'reroute', 'wire'],
      description: 'Route a wire through a point, without changing what it carries.',
      inputs: [dataInput('in', '', 'wildcard')], outputs: [dataOutput('out', '', 'wildcard')],
      implementation: { kind: 'native', operation: 'reroute' }
    },
    {
      type: 'core:flow.end', version: 1, displayName: 'End', category: 'Flow',
      description: 'End a branch of execution.', color: '#7bd88f', inputs: [execInput()], outputs: [],
      implementation: { kind: 'native', operation: 'end' }
    },
    ...flowControlDefinitions(),
    ...containerDefinitions(),
    ...functionDefinitions(),
    ...macroDefinitions(),
    ...eventDefinitions(),
    ...standardLibraryDefinitions()
  ];
}
