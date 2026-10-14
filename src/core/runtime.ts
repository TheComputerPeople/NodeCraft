// The reference interpreter ("Simulate"). It defines how graphs behave: every language pack's
// generated code must match it (docs/semantics.md, enforced by test/conformance).
import { LanguagePackRegistry } from './language-pack';
import { DEFAULT_LANGUAGE, builtinLanguagePacks } from './languages';
import { Graph, GraphDocument, GraphNode, NodeDefinition, PinDefinition, RuntimeLogEvent } from './model';
import { NodeRegistry } from './registry';
import { SWITCH_STRING, isStateInput, mainExecInput, switchIntCases, switchStringCases } from './flow-control';
import { NodeResolver, createResolver, isPure } from './resolve';
import { defaultValue, formatValue, fromStored, toBoolean, toNumber } from './values';

interface RunState {
  // Member variables by id, shared by every graph in the run.
  variables: Map<string, unknown>;
  resolve: NodeResolver;
  // Latest output values of impure nodes, keyed by graph, node and pin.
  outputs: Map<string, unknown>;
  // What flow-control nodes remember between runs (Do Once's closed flag, …), keyed like outputs.
  state: Map<string, unknown>;
  language: string;
}

interface GraphContext {
  run: RunState;
  graph: Graph;
  // Nodes currently on the execution call stack; reaching one again is an exec cycle.
  executing: Set<string>;
}

// Simulate stops a loop after this many passes, as Unreal's editor does; generated code has no limit.
export const MAX_LOOP_PASSES = 1_000_000;

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
    const run: RunState = { variables: new Map(), outputs: new Map(), state: new Map(), language: doc.language || DEFAULT_LANGUAGE, resolve: createResolver(this.registry, doc.variables, doc.importedFunctions) };
    for (const variable of doc.variables) run.variables.set(variable.id, variable.defaultValue !== undefined ? fromStored(variable.defaultValue, variable.type) : defaultValue(variable.type));

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

  // Runs `node` through its exec input `entry` (its main one by default). Re-entering a node that
  // is still running is a cycle, except through an input that only changes its state (a loop's
  // Break, Gate's Close, …), as in Unreal.
  private executeNode(context: GraphContext, node: GraphNode, entry?: string): void {
    const definition = context.run.resolve(node) ?? this.fail(context, node, `Unknown node type: ${node.type}`);
    const pin = entry ?? mainExecInput(definition);
    const reentering = context.executing.has(node.id);
    if (reentering && !isStateInput(definition, pin)) this.fail(context, node, `Execution cycle through ${node.id}: exec wires loop back to a node that is still running.`);
    if (!reentering) context.executing.add(node.id);
    try {
      this.runNode(context, node, definition, pin);
    } finally {
      if (!reentering) context.executing.delete(node.id);
    }
  }

  private runNode(context: GraphContext, node: GraphNode, definition: NodeDefinition, entry: string): void {
    const { graph } = context;
    this.report(context, { kind: 'node.enter', nodeId: node.id, nodeType: node.type });

    let exited = false;
    const exit = (values?: Record<string, unknown>): void => {
      if (exited) return;
      exited = true;
      this.report(context, { kind: 'node.exit', nodeId: node.id, nodeType: node.type, values });
    };
    const input = (pinId: string): unknown => this.inputValue(context, node, definition, pinId);
    const setOutput = (pinId: string, value: unknown): void => {
      context.run.outputs.set(outputKey(graph, node, pinId), value);
    };
    const continueFrom = (pinId: string): void => {
      for (const c of graph.connections) {
        if (c.fromNode !== node.id || c.fromPin !== pinId) continue;
        const next = graph.nodes.find((n) => n.id === c.toNode);
        if (next) this.executeNode(context, next, c.toPin);
      }
    };

    if (this.runFlowControl(context, node, definition, entry, input, setOutput, continueFrom)) {
      exit();
      return;
    }

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
        definition.outputs.filter((p) => p.kind === 'exec').forEach((p) => continueFrom(p.id));
        break;
      case 'reroute':
        continueFrom('out');
        break;
      case 'set-variable': {
        const id = this.variableId(context, node);
        const value = input('value');
        context.run.variables.set(id, value);
        exit({ [definition.inputs.find((p) => p.id === 'value')?.name ?? id]: value });
        continueFrom('execOut');
        break;
      }
      case 'end':
        break;
      default: {
        const result = this.callNode(context, node, definition, input);
        const output = definition.outputs.find((p) => p.kind === 'data');
        if (output) setOutput(output.id, result);
        exit(output ? { [output.id]: result } : {});
        continueFrom(definition.outputs.find((p) => p.kind === 'exec')?.id ?? 'execOut');
        break;
      }
    }

    exit();
  }

  // Flow-control nodes (docs/program-structure.md, "Flow control"); the compiler lowers them to the
  // same rules (src/core/compiler/lower.ts). Returns false for other nodes.
  private runFlowControl(
    context: GraphContext, node: GraphNode, definition: NodeDefinition, entry: string,
    input: (pinId: string) => unknown, setOutput: (pinId: string, value: unknown) => void, continueFrom: (pinId: string) => void
  ): boolean {
    const key = (name: string) => JSON.stringify([context.graph.id, node.id, name]);
    const get = (name: string): unknown => context.run.state.get(key(name));
    const set = (name: string, value: unknown): void => {
      context.run.state.set(key(name), value);
    };
    const output = (pinId: string): unknown => context.run.outputs.get(outputKey(context.graph, node, pinId));
    // Runs `init` the first time any of the node's inputs runs.
    const initOnce = (init: () => void): void => {
      if (get('initialized')) return;
      set('initialized', true);
      init();
    };
    let passes = 0;
    const pass = (): void => {
      if (++passes > MAX_LOOP_PASSES) this.fail(context, node, `Infinite loop detected: the loop ran ${MAX_LOOP_PASSES.toLocaleString('en-US')} times.`);
    };

    switch (nativeOperation(definition)) {
      case 'for-loop': {
        if (entry === 'break') {
          set('stop', true);
          return true;
        }
        set('stop', false);
        let index = toNumber(input('firstIndex'));
        for (; index <= toNumber(input('lastIndex')) && !get('stop'); index++) {
          pass();
          setOutput('index', index);
          continueFrom('loopBody');
        }
        setOutput('index', index);
        continueFrom('completed');
        return true;
      }
      case 'while-loop':
        while (toBoolean(input('condition'))) {
          pass();
          continueFrom('loopBody');
        }
        continueFrom('completed');
        return true;
      case 'for-each': {
        if (entry === 'break') {
          set('stop', true);
          return true;
        }
        set('stop', false);
        // The array is read before each pass, as Unreal's For Each Loop reads it.
        let index = 0;
        for (; ; index++) {
          const array = input('array');
          if (!Array.isArray(array) || index >= array.length || get('stop')) break;
          pass();
          setOutput('index', index);
          setOutput('element', array[index]);
          continueFrom('loopBody');
        }
        setOutput('index', index);
        continueFrom('completed');
        return true;
      }
      case 'do-once':
        if (entry === 'reset') {
          set('closed', false);
          return true;
        }
        initOnce(() => set('closed', toBoolean(input('startClosed'))));
        if (!get('closed')) {
          set('closed', true);
          continueFrom('completed');
        }
        return true;
      case 'do-n': {
        if (entry === 'reset') {
          setOutput('counter', 0);
          return true;
        }
        const counter = Number(output('counter') ?? 0);
        if (counter < toNumber(input('n'))) {
          setOutput('counter', counter + 1);
          continueFrom('exit');
        }
        return true;
      }
      case 'gate':
        initOnce(() => set('open', !toBoolean(input('startClosed'))));
        if (entry === 'open') set('open', true);
        else if (entry === 'close') set('open', false);
        else if (entry === 'toggle') set('open', !get('open'));
        else if (get('open')) continueFrom('exit');
        return true;
      case 'flip-flop': {
        const isA = !output('isA');
        setOutput('isA', isA);
        continueFrom(isA ? 'a' : 'b');
        return true;
      }
      case 'multigate': {
        if (entry === 'reset') {
          set('initialized', false);
          return true;
        }
        const outputs = definition.outputs.filter((p) => p.kind === 'exec').map((p) => p.id);
        initOnce(() => {
          const start = toNumber(input('startIndex'));
          set('next', start >= 0 ? start : 0);
        });
        if (Number(get('next')) >= outputs.length && toBoolean(input('loop'))) set('next', 0);
        const current = Number(get('next'));
        if (current < outputs.length) {
          set('next', current + 1);
          continueFrom(outputs[current]);
        }
        return true;
      }
      case 'switch': {
        const selection = input('selection');
        const cases: unknown[] = node.type === SWITCH_STRING ? switchStringCases(node) : switchIntCases(node);
        const match = cases.findIndex((value) => (node.type === SWITCH_STRING ? String(selection ?? '') === value : toNumber(selection) === value));
        continueFrom(match >= 0 ? `case${match}` : 'default');
        return true;
      }
    }
    return false;
  }

  // Runs a code node's snippet and returns its first data output. Project functions can't run
  // inside the editor (docs/code-as-nodes.md, "Simulate").
  private callNode(context: GraphContext, node: GraphNode, definition: NodeDefinition, input: (pinId: string) => unknown): unknown {
    const implementation = definition.implementation;
    if (implementation?.kind === 'function') {
      this.fail(context, node, `Simulate can't run your project's code ("${definition.displayName}" is ${implementation.name} in ${implementation.path}). Use Run to run the generated code.`);
    }
    if (implementation?.kind !== 'code') this.fail(context, node, `No runtime implementation for ${node.type}.`);
    const pack = this.languages.get(context.run.language) ?? this.fail(context, node, `Unknown graph language "${context.run.language}".`);
    if (!pack.simulator) this.fail(context, node, `Simulate can't run code node ${node.type}: ${pack.displayName} code can't run inside the editor.`);
    const sources = implementation.languages;
    const sourceLanguage = pack.simulator.sourceLanguages.find((key) => sources[key] !== undefined)
      ?? this.fail(context, node, `Code node ${node.type} has no ${pack.simulator.sourceLanguages.join(' or ')} implementation.`);
    const inputs = definition.inputs.filter((p) => p.kind === 'data').map((p) => ({ id: p.id, value: input(p.id) }));
    try {
      return pack.simulator.run(sources[sourceLanguage], inputs);
    } catch (error) {
      this.fail(context, node, error instanceof Error ? error.message : String(error));
    }
  }

  // `following` holds the reroute and pure nodes being followed for one input, to catch data loops.
  private inputValue(context: GraphContext, node: GraphNode, definition: NodeDefinition, pinId: string, following = new Set<string>()): unknown {
    const { graph } = context;
    const pin = definition.inputs.find((p) => p.id === pinId);
    const connection = graph.connections.find((c) => c.toNode === node.id && c.toPin === pinId);
    const source = connection && graph.nodes.find((n) => n.id === connection.fromNode);
    if (!connection || !source) return unconnectedValue(node, pin, pinId);
    return this.outputValue(context, source, connection.fromPin, following);
  }

  private outputValue(context: GraphContext, node: GraphNode, pinId: string, following: Set<string>): unknown {
    const definition = context.run.resolve(node) ?? this.fail(context, node, `Unknown node type: ${node.type}`);
    const operation = nativeOperation(definition);
    // Get is pure and read on every use; Set's output is the variable's current value.
    if (operation === 'get-variable' || operation === 'set-variable') return context.run.variables.get(this.variableId(context, node)) ?? null;
    // Pure conversion: evaluated on every read.
    if (operation === 'to-string') return formatValue(this.inputValue(context, node, definition, 'value', following));
    // Make Array/Set/Map: a new container on every read.
    if (operation === 'make-array' || operation === 'make-set' || operation === 'make-map') {
      const items = definition.inputs.filter((p) => p.kind === 'data').map((p) => this.inputValue(context, node, definition, p.id, following));
      if (operation === 'make-array') return items;
      if (operation === 'make-set') return new Set(items);
      const map = new Map<unknown, unknown>();
      for (let i = 0; i + 1 < items.length; i += 2) map.set(items[i], items[i + 1]);
      return map;
    }
    const follow = (loopMessage: string, value: () => unknown): unknown => {
      if (following.has(node.id)) this.fail(context, node, loopMessage);
      following.add(node.id);
      try {
        return value();
      } finally {
        following.delete(node.id);
      }
    };
    // Reroutes pass through whatever feeds them.
    if (operation === 'reroute') return follow('Reroute nodes are wired in a loop.', () => this.inputValue(context, node, definition, 'in', following));
    // Pure code and function nodes run on every read (docs/semantics.md, "Data flow").
    const kind = definition.implementation?.kind;
    if ((kind === 'code' || kind === 'function') && isPure(definition)) {
      return follow('Pure nodes are wired in a loop.', () => this.callNode(context, node, definition, (id) => this.inputValue(context, node, definition, id, following)));
    }

    // Impure: the value from the node's latest run, or the type default before it has run.
    const pin = definition.outputs.find((p) => p.id === pinId);
    const key = outputKey(context.graph, node, pinId);
    return context.run.outputs.has(key) ? context.run.outputs.get(key) : defaultValue(pin?.type);
  }

  // The id of the variable a Get/Set node is bound to (src/core/resolve.ts).
  private variableId(context: GraphContext, node: GraphNode): string {
    const id = node.properties.variable;
    if (typeof id !== 'string' || !id) this.fail(context, node, 'This variable node has no variable.');
    if (!context.run.variables.has(id)) this.fail(context, node, 'This node uses a variable that no longer exists.');
    return id;
  }
}

function unconnectedValue(node: GraphNode, pin: PinDefinition | undefined, pinId: string): unknown {
  const stored = node.properties[`pin:${pinId}`];
  if (stored !== undefined) return fromStored(stored, pin?.type);
  if (pin?.defaultValue !== undefined) return fromStored(pin.defaultValue, pin?.type);
  return defaultValue(pin?.type);
}

function outputKey(graph: Graph, node: GraphNode, pinId: string): string {
  return JSON.stringify([graph.id, node.id, pinId]);
}

function nativeOperation(definition: NodeDefinition): string {
  return definition.implementation?.kind === 'native' ? definition.implementation.operation : '';
}
