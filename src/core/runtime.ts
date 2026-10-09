// The reference interpreter ("Simulate"). It defines how graphs behave: every language pack's
// generated code must match it (docs/semantics.md, enforced by test/conformance).
import { LanguagePackRegistry } from './language-pack';
import { DEFAULT_LANGUAGE, builtinLanguagePacks } from './languages';
import { Graph, GraphDocument, GraphNode, NodeDefinition, PinDefinition, RuntimeLogEvent } from './model';
import { NodeRegistry } from './registry';
import { defaultValue, formatValue, toBoolean, toNumber } from './values';

interface RunState {
  // Shared by every graph in the run, like a class's member variables.
  variables: Map<string, unknown>;
  // Latest output values of impure nodes, keyed by graph, node and pin.
  outputs: Map<string, unknown>;
  language: string;
}

interface GraphContext {
  run: RunState;
  graph: Graph;
  // Nodes currently on the execution call stack; reaching one again is an exec cycle.
  executing: Set<string>;
}

// Thrown after an error has been reported, to stop the whole run (docs/semantics.md, "Errors").
class RunStopped extends Error {}

export class GraphRuntime {
  constructor(
    private readonly registry: NodeRegistry,
    private readonly emit: (event: RuntimeLogEvent) => void,
    private readonly languages: LanguagePackRegistry = builtinLanguagePacks()
  ) {}

  // Runs every Start node in the document's event graphs. Function and macro graphs only run when
  // called, which arrives with Phase 4.
  run(doc: GraphDocument): void {
    const run: RunState = { variables: new Map(), outputs: new Map(), language: doc.language || DEFAULT_LANGUAGE };
    for (const variable of doc.variables) run.variables.set(variable.name, variable.defaultValue ?? defaultValue(variable.type));

    const entries = doc.graphs
      .filter((g) => g.kind === 'event')
      .flatMap((graph) => graph.nodes.filter((n) => n.type === 'core:event.start').map((start) => ({ graph, start })));
    if (entries.length === 0) {
      this.emit({ kind: 'error', message: 'Graph has no Start node.' });
      return;
    }

    try {
      for (const { graph, start } of entries) this.executeNode({ run, graph, executing: new Set() }, start);
      this.emit({ kind: 'graph.complete', message: 'Graph execution completed.' });
    } catch (error) {
      if (!(error instanceof RunStopped)) throw error;
      this.emit({ kind: 'graph.complete', message: 'Graph execution stopped by an error.' });
    }
  }

  private report(context: GraphContext, event: RuntimeLogEvent): void {
    this.emit({ graphId: context.graph.id, ...event });
  }

  // Reports an error on `node` and stops the run.
  private fail(context: GraphContext, node: GraphNode, message: string): never {
    this.report(context, { kind: 'error', nodeId: node.id, nodeType: node.type, message });
    throw new RunStopped(message);
  }

  private executeNode(context: GraphContext, node: GraphNode): void {
    if (context.executing.has(node.id)) this.fail(context, node, `Execution cycle through ${node.id}: exec wires loop back to a node that is still running.`);
    context.executing.add(node.id);
    try {
      this.runNode(context, node);
    } finally {
      context.executing.delete(node.id);
    }
  }

  private runNode(context: GraphContext, node: GraphNode): void {
    const { graph } = context;
    const definition = this.registry.get(node.type) ?? this.fail(context, node, `Unknown node type: ${node.type}`);
    this.report(context, { kind: 'node.enter', nodeId: node.id, nodeType: node.type });

    let exited = false;
    const exit = (values?: Record<string, unknown>): void => {
      if (exited) return;
      exited = true;
      this.report(context, { kind: 'node.exit', nodeId: node.id, nodeType: node.type, values });
    };
    const input = (pinId: string): unknown => this.inputValue(context, node, definition, pinId, new Set());
    const setOutput = (pinId: string, value: unknown): void => {
      context.run.outputs.set(outputKey(graph, node, pinId), value);
    };
    const continueFrom = (pinId: string): void => {
      for (const c of graph.connections) {
        if (c.fromNode !== node.id || c.fromPin !== pinId) continue;
        const next = graph.nodes.find((n) => n.id === c.toNode);
        if (next) this.executeNode(context, next);
      }
    };

    switch (nativeOperation(definition)) {
      case 'start':
        continueFrom('execOut');
        break;
      case 'add': {
        const result = toNumber(input('a')) + toNumber(input('b'));
        setOutput('result', result);
        exit({ result });
        continueFrom('execOut');
        break;
      }
      case 'print':
        this.report(context, { kind: 'log', nodeId: node.id, nodeType: node.type, message: formatValue(input('value')) });
        exit();
        continueFrom('execOut');
        break;
      case 'branch':
        continueFrom(toBoolean(input('condition')) ? 'true' : 'false');
        break;
      case 'sequence':
        ['then0', 'then1', 'then2'].forEach((pin) => continueFrom(pin));
        break;
      case 'set-variable': {
        const name = String(input('name') ?? '');
        const value = input('value');
        context.run.variables.set(name, value);
        exit({ [name]: value });
        continueFrom('execOut');
        break;
      }
      case 'end':
        break;
      default:
        if (definition.implementation?.kind !== 'code') this.fail(context, node, `No runtime implementation for ${node.type}.`);
        this.runCodeNode(context, node, definition, input, setOutput);
        exit(Object.fromEntries(definition.outputs.filter((p) => p.kind === 'data').slice(0, 1).map((p) => [p.id, context.run.outputs.get(outputKey(graph, node, p.id))])));
        continueFrom(definition.outputs.find((p) => p.kind === 'exec')?.id ?? 'execOut');
        break;
    }

    exit();
  }

  private runCodeNode(
    context: GraphContext,
    node: GraphNode,
    definition: NodeDefinition,
    input: (pinId: string) => unknown,
    setOutput: (pinId: string, value: unknown) => void
  ): void {
    if (definition.implementation?.kind !== 'code') return;
    const pack = this.languages.get(context.run.language) ?? this.fail(context, node, `Unknown graph language "${context.run.language}".`);
    if (!pack.simulator) this.fail(context, node, `Simulate can't run code node ${node.type}: ${pack.displayName} code can't run inside the editor.`);
    const sources = definition.implementation.languages;
    const sourceLanguage = pack.simulator.sourceLanguages.find((key) => sources[key] !== undefined)
      ?? this.fail(context, node, `Code node ${node.type} has no ${pack.simulator.sourceLanguages.join(' or ')} implementation.`);
    const inputs = definition.inputs.filter((p) => p.kind === 'data').map((p) => ({ id: p.id, value: input(p.id) }));
    let result: unknown;
    try {
      result = pack.simulator.run(sources[sourceLanguage], inputs);
    } catch (error) {
      this.fail(context, node, error instanceof Error ? error.message : String(error));
    }
    const output = definition.outputs.find((p) => p.kind === 'data');
    if (output) setOutput(output.id, result);
  }

  // `evaluating` holds the pure nodes being evaluated for this input, to detect data cycles.
  private inputValue(context: GraphContext, node: GraphNode, definition: NodeDefinition, pinId: string, evaluating: Set<string>): unknown {
    const { graph } = context;
    const pin = definition.inputs.find((p) => p.id === pinId);
    const connection = graph.connections.find((c) => c.toNode === node.id && c.toPin === pinId);
    const source = connection && graph.nodes.find((n) => n.id === connection.fromNode);
    if (!connection || !source) return unconnectedValue(node, pin, pinId);
    return this.outputValue(context, source, connection.fromPin, evaluating);
  }

  private outputValue(context: GraphContext, node: GraphNode, pinId: string, evaluating: Set<string>): unknown {
    const definition = this.registry.get(node.type);
    if (!definition) this.fail(context, node, `Unknown node type: ${node.type}`);
    const pin = definition.outputs.find((p) => p.id === pinId);

    if (nativeOperation(definition) === 'get-variable') {
      // Pure: evaluated on every read.
      if (evaluating.has(node.id)) this.fail(context, node, `Data cycle through ${node.id}: its inputs depend on its own output.`);
      evaluating.add(node.id);
      const name = String(this.inputValue(context, node, definition, 'name', evaluating) ?? '');
      evaluating.delete(node.id);
      return context.run.variables.get(name) ?? null;
    }

    // Impure: the value from the node's latest run, or the type default before it has run.
    const key = outputKey(context.graph, node, pinId);
    return context.run.outputs.has(key) ? context.run.outputs.get(key) : defaultValue(pin?.type);
  }
}

function unconnectedValue(node: GraphNode, pin: PinDefinition | undefined, pinId: string): unknown {
  const stored = node.properties[`pin:${pinId}`];
  if (stored !== undefined) return stored;
  if (pin?.defaultValue !== undefined) return pin.defaultValue;
  return defaultValue(pin?.type);
}

function outputKey(graph: Graph, node: GraphNode, pinId: string): string {
  return JSON.stringify([graph.id, node.id, pinId]);
}

function nativeOperation(definition: NodeDefinition): string {
  return definition.implementation?.kind === 'native' ? definition.implementation.operation : '';
}
