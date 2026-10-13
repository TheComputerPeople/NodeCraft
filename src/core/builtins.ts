import { NodeDefinition, PinDefinition, TypeRef } from './model';

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
      outputs: [execOutput(), dataOutput('value', 'Value', 'any')], implementation: { kind: 'native', operation: 'set-variable' }
    },
    {
      type: 'core:variable.get', version: 1, displayName: 'Get Variable', category: 'Variables',
      description: 'Read a variable.', color: '#ff8b7b', inputs: [],
      outputs: [dataOutput('value', 'Value', 'any')], implementation: { kind: 'native', operation: 'get-variable' }
    },
    {
      type: 'core:flow.sequence', version: 1, displayName: 'Sequence', category: 'Flow',
      description: 'Run execution outputs in order.', color: '#e6b450', inputs: [execInput()],
      outputs: [execOutput('then0', 'Then 0'), execOutput('then1', 'Then 1'), execOutput('then2', 'Then 2')],
      implementation: { kind: 'native', operation: 'sequence' }
    },
    {
      type: 'core:flow.end', version: 1, displayName: 'End', category: 'Flow',
      description: 'End a branch of execution.', color: '#7bd88f', inputs: [execInput()], outputs: [],
      implementation: { kind: 'native', operation: 'end' }
    }
  ];
}
