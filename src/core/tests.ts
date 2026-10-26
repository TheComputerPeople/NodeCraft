// Tests in graphs (docs/debugging.md, "Test Case"): a Test Case event per test, and Assert nodes.
// Each test runs on a new object of the class (its Start doesn't run), and fails at the first
// Assert that doesn't hold.
import { Graph, GraphDocument, GraphNode, NodeDefinition, PinDefinition } from './model';

export const TEST_CASE = 'core:test.case';
export const ASSERT_TRUE = 'core:test.assert-true';
export const ASSERT_EQUAL = 'core:test.assert-equal';

const TEST_COLOR = '#9c1a1a';
const ASSERT_COLOR = '#4e7c9c';

const exec = (id: string, direction: PinDefinition['direction'], name = ''): PinDefinition => ({ id, name, kind: 'exec', direction });

export function testDefinitions(): NodeDefinition[] {
  const message: PinDefinition = { id: 'message', name: 'Message', kind: 'data', direction: 'input', type: { id: 'string' }, defaultValue: '' };
  return [
    {
      type: TEST_CASE, version: 1, displayName: 'Test Case', category: 'Testing', color: TEST_COLOR, keywords: ['test', 'unit test', 'automation'],
      description: 'A test of this class: Run Tests runs it on a new object, and it passes unless an Assert fails.',
      inputs: [], outputs: [exec('execOut', 'output')], implementation: { kind: 'native', operation: 'test-case' }
    },
    {
      type: ASSERT_TRUE, version: 1, displayName: 'Assert True', category: 'Testing', color: ASSERT_COLOR, keywords: ['assert', 'check', 'expect', 'test'],
      description: 'Fails the test (or stops the run) when Condition is false.',
      inputs: [exec('execIn', 'input'), { id: 'condition', name: 'Condition', kind: 'data', direction: 'input', type: { id: 'bool' }, defaultValue: false }, message],
      outputs: [exec('execOut', 'output')], implementation: { kind: 'native', operation: 'assert-true' }
    },
    {
      type: ASSERT_EQUAL, version: 1, displayName: 'Assert Equal', category: 'Testing', color: ASSERT_COLOR, keywords: ['assert', 'equal', 'equals', 'expect', 'test'],
      description: 'Fails the test (or stops the run) when Actual isn\'t equal to Expected.',
      inputs: [
        exec('execIn', 'input'),
        { id: 'actual', name: 'Actual', kind: 'data', direction: 'input', type: { id: 'wildcard' } },
        { id: 'expected', name: 'Expected', kind: 'data', direction: 'input', type: { id: 'wildcard' } },
        message
      ],
      outputs: [exec('execOut', 'output')], implementation: { kind: 'native', operation: 'assert-equal' }
    }
  ];
}

export function testName(node: GraphNode): string {
  return typeof node.properties.name === 'string' && node.properties.name.trim() ? node.properties.name.trim() : 'Test';
}

// A Test Case node shows its test's name.
export function testCaseDefinition(base: NodeDefinition, node: GraphNode): NodeDefinition {
  return { ...base, displayName: `Test: ${testName(node)}` };
}

// The document's tests, in graph and node order.
export function testCases(doc: Pick<GraphDocument, 'graphs'>): { graph: Graph; node: GraphNode; name: string }[] {
  return doc.graphs.filter((g) => g.kind === 'event').flatMap((graph) => graph.nodes.filter((n) => n.type === TEST_CASE).map((node) => ({ graph, node, name: testName(node) })));
}

// What a failing Assert says; generated code builds the same text.
export function assertTrueMessage(message: string): string {
  return message ? `Assert failed: ${message}` : 'Assert failed';
}

export function assertEqualMessage(actual: string, expected: string, message: string): string {
  return `Expected ${expected}, got ${actual}${message ? `: ${message}` : ''}`;
}
