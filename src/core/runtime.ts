// The reference interpreter ("Simulate"). It defines how graphs behave: every language pack's
// generated code must match it (docs/semantics.md, enforced by test/conformance).
import { LanguagePackRegistry } from './language-pack';
import { DEFAULT_LANGUAGE, builtinLanguagePacks } from './languages';
import { Graph, GraphDocument, GraphNode, NodeDefinition, PinDefinition, RuntimeLogEvent } from './model';
import { NodeRegistry } from './registry';
import { SWITCH_STRING, isStateInput, mainExecInput, switchIntCases, switchStringCases } from './flow-control';
import { FUNCTION_ENTRY, functionGraph } from './functions';
import { CUSTOM_EVENT, DELEGATE_PIN, boundDispatcher, calledEvent, documentDispatchers, eventInputs } from './events';
import { ClassInfo, ObjectValue, declaredClass, dispatcherAction, nodeClass } from './objects';
import { expandDocument, isExpandedNode, macroProblemKey, visibleNodeId } from './macros';
import { StructValue, TypeLookup, expandSplitPins, typeLookup } from './user-types';
import { NodeResolver, createResolver, createUnsplitResolver, isPure } from './resolve';
import { defaultValue, formatValue, fromStored, toBoolean, toNumber } from './values';

interface RunState {
  doc: GraphDocument;
  // Member variables by id, shared by every graph in the run.
  variables: Map<string, unknown>;
  resolve: NodeResolver;
  language: string;
  // A function library's file (workspace-relative), when the run is in another document.
  document?: string;
  // Why macro instances that couldn't be expanded can't be (src/core/macros.ts).
  macroProblems: Map<string, string>;
  // The workspace's structs and enums (src/core/user-types.ts).
  types: TypeLookup;
  // The object's frame, where custom events run wherever they are called from.
  objectFrame: Frame;
  // The events bound to each event dispatcher, in the order they were bound (each with the object
  // it belongs to).
  bindings: Map<string, BoundEvent[]>;
  // The object this run is (src/core/objects.ts), and its class.
  self: ObjectValue;
  ownClass?: ClassInfo;
  // How many custom events are running inside one another.
  eventDepth: number;
}

// What one run of a graph keeps: the event graphs share one frame (the object's), and each call
// of a function gets its own, so recursion works (docs/program-structure.md, "Functions").
interface Frame {
  // Latest output values of impure nodes, keyed by graph, node and pin.
  outputs: Map<string, unknown>;
  // What flow-control nodes remember between runs (Do Once's closed flag, …), keyed like outputs.
  state: Map<string, unknown>;
  // A function call's inputs (by signature pin id) and local variables (by id).
  params: Map<string, unknown>;
  locals: Map<string, unknown>;
  // How many function calls deep this frame is.
  depth: number;
}

interface GraphContext {
  run: RunState;
  graph: Graph;
  frame: Frame;
  // Nodes currently on the execution call stack; reaching one again is an exec cycle.
  executing: Set<string>;
}

interface BoundEvent {
  run: RunState;
  graph: Graph;
  node: GraphNode;
}

// Thrown by a Return Node to end its function's call with these output values.
class ReturnSignal {
  constructor(readonly values: Map<string, unknown>) {}
}

// Simulate stops runaway recursion with an error instead of overflowing the stack. Each graph call
// takes many JavaScript frames, so the limit stays well inside the extension host's stack; calls
// that still run out of stack (functions and events nested in each other) stop the same way.
export const MAX_CALL_DEPTH = 250;
const OUT_OF_STACK = `Too many nested calls: the graph keeps calling itself.`;

// Simulate stops a loop after this many passes, as Unreal's editor does; generated code has no limit.
export const MAX_LOOP_PASSES = 1_000_000;

// Thrown after an error has been reported, to stop the whole run (docs/semantics.md, "Errors").
class RunStopped extends Error {}

export class GraphRuntime {
  constructor(
    private readonly registry: NodeRegistry,
    private readonly emit: (event: RuntimeLogEvent) => void,
    private readonly languages: LanguagePackRegistry = builtinLanguagePacks(),
    // Reads another graph file (a function library, by workspace-relative path) for Simulate.
    private readonly loadDocument?: (path: string) => GraphDocument | undefined
  ) {}

  // Runs every Start node in the document's event graphs. Function graphs only run when called.
  run(doc: GraphDocument): void {
    const run = this.runState(doc);
    if (!this.startEntries(run).length) {
      this.emit({ kind: 'error', message: 'Graph has no Start node.' });
      return;
    }

    try {
      this.start(run);
      this.emit({ kind: 'graph.complete', message: 'Graph execution completed.' });
    } catch (error) {
      if (!(error instanceof RunStopped)) throw error;
      this.emit({ kind: 'graph.complete', message: 'Graph execution stopped by an error.' });
    }
  }

  private report(context: GraphContext, event: RuntimeLogEvent): void {
    const inner = event.nodeId !== undefined && isExpandedNode(event.nodeId);
    const { values, ...rest } = event;
    this.emit({
      graphId: context.graph.id, ...(context.run.document ? { document: context.run.document } : {}), ...rest,
      ...(inner ? { nodeId: visibleNodeId(event.nodeId!) } : values !== undefined ? { values } : {})
    });
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
      context.frame.outputs.set(outputKey(graph, node, pinId), value);
    };
    const continueFrom = (pinId: string): void => {
      for (const c of graph.connections) {
        if (c.fromNode !== node.id || c.fromPin !== pinId) continue;
        const next = graph.nodes.find((n) => n.id === c.toNode);
        if (next) this.executeNode(context, next, c.toPin);
      }
    };

    switch (nativeOperation(definition)) {
      case 'macro-instance':
        this.fail(context, node, this.macroProblem(context, node));
        return;
      case 'macro-inputs':
      case 'macro-outputs':
        this.fail(context, node, 'Inputs and Outputs nodes belong in macro graphs.');
        return;
      case 'function-entry':
        continueFrom('execOut');
        exit();
        return;
      case 'custom-event':
        exit(Object.fromEntries(eventInputs(node).map((p) => [p.name, context.frame.outputs.get(outputKey(graph, node, p.id))])));
        continueFrom('execOut');
        return;
      case 'call-event': {
        const target = calledEvent(node, context.run.doc.graphs) ?? this.fail(context, node, `There is no custom event named "${String(node.properties.event ?? '')}".`);
        const args = definition.inputs.filter((p) => p.kind === 'data').map((p) => input(p.id));
        exit();
        this.runEvent(context, node, { run: context.run, ...target }, args);
        continueFrom('execOut');
        return;
      }
      case 'call-dispatcher':
      case 'bind-event':
      case 'unbind-event':
      case 'unbind-all': {
        const dispatcher = boundDispatcher(node, documentDispatchers(context.run.doc)) ?? this.fail(context, node, 'This node uses an event dispatcher that no longer exists.');
        const operation = nativeOperation(definition);
        const action = operation === 'call-dispatcher' ? 'call' : operation === 'bind-event' ? 'bind' : operation === 'unbind-event' ? 'unbind' : 'unbind-all';
        exit();
        this.dispatch(context, node, definition, context.run, dispatcher.id, action, input);
        continueFrom('execOut');
        return;
      }
      case 'self':
        return;
      case 'object-set':
      case 'object-call':
      case 'object-event':
      case 'object-dispatcher': {
        const { type, target } = this.target(context, node, definition, input);
        const operation = nativeOperation(definition);
        if (operation === 'object-set') {
          const value = input('value');
          target.variables.set(String(node.properties.variable), value);
          exit({ value });
        } else if (operation === 'object-call') {
          const graph = target.doc.graphs.find((g) => g.id === node.properties.function && g.kind === 'function') ?? this.fail(context, node, `${type.name} no longer has this function.`);
          const outputs = this.runFunction(context, node, target, graph, input);
          for (const [pin, value] of outputs) setOutput(pin, value);
          exit(Object.fromEntries(outputs));
        } else if (operation === 'object-event') {
          const event = calledEvent({ ...node, properties: { event: node.properties.event } }, target.doc.graphs) ?? this.fail(context, node, `${type.name} no longer has this event.`);
          exit();
          this.runEvent(context, node, { run: target, ...event }, definition.inputs.filter((p) => p.kind === 'data' && p.id !== 'target').map((p) => input(p.id)));
        } else {
          exit();
          this.dispatch(context, node, definition, target, String(node.properties.dispatcher), dispatcherAction(node), input);
        }
        continueFrom('execOut');
        return;
      }
      case 'function-return':
        if (context.frame.depth === 0) this.fail(context, node, 'A Return Node belongs in a function graph.');
        exit();
        throw new ReturnSignal(new Map(definition.inputs.filter((p) => p.kind === 'data').map((p) => [p.id, input(p.id)])));
      case 'call-function': {
        const outputs = this.callFunction(context, node, input);
        for (const [pin, value] of outputs) setOutput(pin, value);
        exit(Object.fromEntries(outputs));
        continueFrom('execOut');
        return;
      }
    }

    const user = definition.implementation;
    if (user?.kind === 'struct' && user.operation === 'set-members') {
      const result = this.setMembers(context, node, definition, input);
      setOutput('result', result);
      exit({ result });
      continueFrom('execOut');
      return;
    }
    if (user?.kind === 'enum' && user.operation === 'switch') {
      const selection = input('selection');
      const chosen = user.type.enumerators.find((e) => e.name === selection);
      exit({ selection });
      if (chosen) continueFrom(chosen.id);
      return;
    }

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
        this.variables(context, id).set(id, value);
        exit({ [definition.inputs.find((p) => p.id === 'value')?.name ?? id]: value });
        continueFrom('execOut');
        break;
      }
      case 'end':
        break;
      default: {
        const implementation = definition.implementation;
        if (implementation?.kind === 'class') {
          const object = this.construct(context, node, implementation.type);
          setOutput('object', object);
          exit();
          continueFrom('execOut');
          break;
        }
        if (implementation?.kind === 'function' && implementation.source) {
          const outputs = this.callLibrary(context, node, implementation.source, input);
          for (const [pin, value] of outputs) setOutput(pin, value);
          exit(Object.fromEntries(outputs));
          continueFrom(definition.outputs.find((p) => p.kind === 'exec')?.id ?? 'execOut');
          break;
        }
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
    const get = (name: string): unknown => context.frame.state.get(key(name));
    const set = (name: string, value: unknown): void => {
      context.frame.state.set(key(name), value);
    };
    const output = (pinId: string): unknown => context.frame.outputs.get(outputKey(context.graph, node, pinId));
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

  // Runs the function a call node calls, in a new frame, and returns its outputs by pin id. Reaching
  // the end without a Return Node returns the outputs' defaults.
  private callFunction(context: GraphContext, node: GraphNode, input: (pinId: string) => unknown): Map<string, unknown> {
    const graph = functionGraph(node, context.run.doc.graphs) ?? this.fail(context, node, 'This node calls a function that no longer exists.');
    return this.runFunction(context, node, context.run, graph, input);
  }

  // A function of a graph library (another .vgraph file), run from that file.
  private callLibrary(context: GraphContext, node: GraphNode, source: { document: string; graph: string }, input: (pinId: string) => unknown): Map<string, unknown> {
    const doc = this.loadDocument?.(source.document) ?? this.fail(context, node, `Simulate can't read the function library ${source.document}.`);
    const graph = doc.graphs.find((g) => g.id === source.graph && g.kind === 'function') ?? this.fail(context, node, `${source.document} no longer has this function.`);
    const run = this.runState(doc, source.document);
    const expanded = run.doc.graphs.find((g) => g.id === graph.id) ?? graph;
    return this.runFunction(context, node, run, expanded, input);
  }

  private startEntries(run: RunState): { graph: Graph; start: GraphNode }[] {
    return run.doc.graphs.filter((g) => g.kind === 'event').flatMap((graph) => graph.nodes.filter((n) => n.type === 'core:event.start').map((start) => ({ graph, start })));
  }

  // Runs an object's Start events (a constructed object's too, as spawning runs BeginPlay).
  private start(run: RunState): void {
    for (const { graph, start } of this.startEntries(run)) this.executeNode({ run, graph, frame: run.objectFrame, executing: new Set() }, start);
  }

  // A run of `doc`, with the macros it uses expanded (each use is a copy of the macro's nodes), and
  // its member variables at their defaults.
  private runState(original: GraphDocument, document?: string): RunState {
    const expanded = expandDocument(original, (type) => this.registry.get(type));
    const problems = expanded.problems;
    // Split struct pins become Make and Break nodes (src/core/user-types.ts).
    const unsplit = createUnsplitResolver(this.registry, expanded.doc);
    const doc = { ...expanded.doc, graphs: expanded.doc.graphs.map((g) => expandSplitPins(g, unsplit, (type) => this.registry.get(type))) };
    const language = doc.language || DEFAULT_LANGUAGE;
    const objectFrame: Frame = { outputs: new Map(), state: new Map(), params: new Map(), locals: new Map(), depth: 0 };
    const ownClass = declaredClass(original);
    const run: RunState = {
      doc, variables: new Map(), language, resolve: createResolver(this.registry, doc), macroProblems: problems, types: typeLookup(this.registry.all(), language),
      objectFrame, bindings: new Map(), eventDepth: 0, self: undefined as unknown as ObjectValue, ...(ownClass ? { ownClass } : {}), ...(document ? { document } : {})
    };
    (run as { self: ObjectValue }).self = new ObjectValue(doc.name, run);
    for (const variable of doc.variables) run.variables.set(variable.id, variable.defaultValue !== undefined ? fromStored(variable.defaultValue, variable.type, run.types) : defaultValue(variable.type, run.types));
    return run;
  }

  private runFunction(context: GraphContext, node: GraphNode, run: RunState, graph: Graph, input: (pinId: string) => unknown): Map<string, unknown> {
    if (context.frame.depth >= MAX_CALL_DEPTH) this.fail(context, node, `Too many nested calls (${MAX_CALL_DEPTH}): the function keeps calling itself.`);
    const signature = graph.signature ?? { inputs: [], outputs: [] };
    const frame: Frame = {
      outputs: new Map(), state: new Map(), depth: context.frame.depth + 1,
      params: new Map(signature.inputs.filter((p) => p.kind === 'data').map((p) => [p.id, input(p.id)])),
      locals: new Map((graph.localVariables ?? []).map((v) => [v.id, v.defaultValue !== undefined ? fromStored(v.defaultValue, v.type, run.types) : defaultValue(v.type, run.types)]))
    };
    const outputs = signature.outputs.filter((p) => p.kind === 'data');
    const entry = graph.nodes.find((n) => n.type === FUNCTION_ENTRY) ?? this.fail(context, node, `Function "${graph.name}" has no Function Entry node.`);
    try {
      this.executeNode({ run, graph, frame, executing: new Set() }, entry);
    } catch (error) {
      if (error instanceof RangeError) this.fail(context, node, OUT_OF_STACK);
      if (!(error instanceof ReturnSignal)) throw error;
      return new Map(outputs.map((p) => [p.id, error.values.has(p.id) ? error.values.get(p.id) : defaultValue(p.type, run.types)]));
    }
    return new Map(outputs.map((p) => [p.id, defaultValue(p.type, run.types)]));
  }

  // Set members in: the struct with the node's member pins changed. A struct read from a variable
  // (its Get node) is written back to the variable, as Unreal's by-reference input does.
  private setMembers(context: GraphContext, node: GraphNode, definition: NodeDefinition, input: (pinId: string) => unknown): StructValue | null {
    const value = input('struct');
    if (!(value instanceof StructValue)) return null;
    const members = definition.inputs.filter((p) => p.kind === 'data' && p.id !== 'struct');
    const result = value.with(new Map(members.map((p) => [p.id, input(p.id)])));
    const wire = context.graph.connections.find((c) => c.toNode === node.id && c.toPin === 'struct');
    const source = wire && context.graph.nodes.find((n) => n.id === wire.fromNode);
    const sourceDefinition = source && context.run.resolve(source);
    if (source && sourceDefinition && nativeOperation(sourceDefinition) === 'get-variable') {
      const id = this.variableId(context, source);
      this.variables(context, id).set(id, result);
    }
    return result;
  }

  // Runs a custom event with these inputs, in the object's frame (its outputs keep the inputs).
  private runEvent(context: GraphContext, caller: GraphNode, event: BoundEvent, args: unknown[]): void {
    const run = event.run;
    if (run.eventDepth >= MAX_CALL_DEPTH) this.fail(context, caller, `Too many nested calls (${MAX_CALL_DEPTH}): the event keeps calling itself.`);
    eventInputs(event.node).filter((p) => p.kind === 'data').forEach((p, i) => run.objectFrame.outputs.set(outputKey(event.graph, event.node, p.id), args[i]));
    run.eventDepth++;
    try {
      this.executeNode({ run, graph: event.graph, frame: run.objectFrame, executing: new Set() }, event.node);
    } catch (error) {
      if (error instanceof RangeError) this.fail(context, caller, OUT_OF_STACK);
      throw error;
    } finally {
      run.eventDepth--;
    }
  }

  // Calls, binds or unbinds a dispatcher of `owner` (this object, or a Target object). Bound events
  // are this object's.
  private dispatch(context: GraphContext, node: GraphNode, definition: NodeDefinition, owner: RunState, dispatcher: string, action: string, input: (pinId: string) => unknown): void {
    const bound = owner.bindings.get(dispatcher) ?? [];
    if (action === 'call') {
      const args = definition.inputs.filter((p) => p.kind === 'data' && p.id !== 'target').map((p) => input(p.id));
      // Events bound or unbound while running don't change this broadcast.
      for (const event of [...bound]) this.runEvent(context, node, event, args);
    } else if (action === 'unbind-all') {
      owner.bindings.set(dispatcher, []);
    } else {
      const wired = this.wiredEvent(context, node) ?? this.fail(context, node, "Wire a Custom Event's red pin into Event.");
      const event: BoundEvent = { run: context.run, ...wired };
      const others = bound.filter((b) => b.node !== event.node || b.graph !== event.graph || b.run !== event.run);
      // Binding an event twice binds it once, where it was first bound.
      owner.bindings.set(dispatcher, action === 'bind' ? (others.length === bound.length ? [...bound, event] : bound) : others);
    }
  }

  // A new object of `type`, its Start events run: of this document's class, or of another class
  // read from its file.
  private construct(context: GraphContext, node: GraphNode, type: ClassInfo): ObjectValue {
    const own = context.run.ownClass?.id === type.id;
    const doc = own ? context.run.doc : type.source && this.loadDocument?.(type.source.document);
    if (!doc) this.fail(context, node, `Simulate can't read ${type.name}'s file${type.source ? ` (${type.source.document})` : ''}.`);
    const run = this.runState(doc, own ? context.run.document : type.source?.document);
    try {
      this.start(run);
    } catch (error) {
      if (error instanceof RangeError) this.fail(context, node, OUT_OF_STACK);
      throw error;
    }
    return run.self;
  }

  // The class a member node uses and the object it acts on: its Target, else this object (for its
  // own class). Unreal stops with "Accessed None" when the Target is empty.
  private target(context: GraphContext, node: GraphNode, definition: NodeDefinition, input: (pinId: string) => unknown): { type: ClassInfo; target: RunState } {
    const type = nodeClass(node, context.run.ownClass, (t) => this.registry.get(t)) ?? this.fail(context, node, `There is no class ${String(node.properties.class ?? '').replace(/^object:/, '')}.`);
    const wired = context.graph.connections.some((c) => c.toNode === node.id && c.toPin === 'target');
    const value = wired ? input('target') : type.id === context.run.ownClass?.id ? context.run.self : undefined;
    if (!(value instanceof ObjectValue)) this.fail(context, node, `Accessed None: Target has no ${type.name}.`);
    void definition;
    return { type, target: value.state as RunState };
  }

  // The custom event wired into a Bind or Unbind node's Event pin (through reroutes).
  private wiredEvent(context: GraphContext, node: GraphNode): { graph: Graph; node: GraphNode } | undefined {
    const { graph } = context;
    let wire = graph.connections.find((c) => c.toNode === node.id && c.toPin === 'event');
    const seen = new Set<string>();
    while (wire && !seen.has(wire.fromNode)) {
      seen.add(wire.fromNode);
      const from = graph.nodes.find((n) => n.id === wire!.fromNode);
      if (from?.type === CUSTOM_EVENT && wire.fromPin === DELEGATE_PIN) return { graph, node: from };
      if (from?.type !== 'core:reroute') return undefined;
      wire = graph.connections.find((c) => c.toNode === from.id && c.toPin === 'in');
    }
    return undefined;
  }

  // Where a variable lives: the call's locals, or the object's members.
  private variables(context: GraphContext, id: string): Map<string, unknown> {
    return context.frame.locals.has(id) ? context.frame.locals : context.run.variables;
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
    if (!connection || !source) return unconnectedValue(node, pin, pinId, context.run.types);
    return this.outputValue(context, source, connection.fromPin, following);
  }

  private outputValue(context: GraphContext, node: GraphNode, pinId: string, following: Set<string>): unknown {
    const definition = context.run.resolve(node) ?? this.fail(context, node, `Unknown node type: ${node.type}`);
    const operation = nativeOperation(definition);
    // Get is pure and read on every use; Set's output is the variable's current value.
    if (operation === 'get-variable' || operation === 'set-variable') {
      const id = this.variableId(context, node);
      return this.variables(context, id).get(id) ?? null;
    }
    if (operation === 'macro-instance') this.fail(context, node, this.macroProblem(context, node));
    if (operation === 'self') return context.run.self;
    if (operation === 'is-valid') return this.inputValue(context, node, definition, 'object', following) instanceof ObjectValue;
    if (operation === 'object-get' || operation === 'object-set') {
      const { target } = this.target(context, node, definition, (id) => this.inputValue(context, node, definition, id, following));
      return target.variables.get(String(node.properties.variable)) ?? null;
    }
    if (operation === 'object-call' && isPure(definition)) {
      const { type, target } = this.target(context, node, definition, (id) => this.inputValue(context, node, definition, id, following));
      const graph = target.doc.graphs.find((g) => g.id === node.properties.function && g.kind === 'function') ?? this.fail(context, node, `${type.name} no longer has this function.`);
      return this.runFunction(context, node, target, graph, (id) => this.inputValue(context, node, definition, id, following)).get(pinId);
    }
    // A function's inputs, read from its entry node.
    if (operation === 'function-entry') return context.frame.params.get(pinId) ?? defaultValue(definition.outputs.find((p) => p.id === pinId)?.type, context.run.types);
    // Make and Break are pure; so are an enum's == and !=.
    const user = definition.implementation;
    if (user?.kind === 'struct' && user.operation === 'make') {
      return new StructValue(user.type, new Map(user.type.fields.map((f) => [f.id, this.inputValue(context, node, definition, f.id, following)])));
    }
    if (user?.kind === 'struct' && user.operation === 'break') {
      const value = this.inputValue(context, node, definition, 'struct', following);
      return value instanceof StructValue ? value.get(pinId) : null;
    }
    if (user?.kind === 'enum' && (user.operation === 'equal' || user.operation === 'not-equal')) {
      const same = this.inputValue(context, node, definition, 'a', following) === this.inputValue(context, node, definition, 'b', following);
      return user.operation === 'equal' ? same : !same;
    }
    // A pure function's call: called on every read.
    if (operation === 'call-function' && isPure(definition)) {
      const outputs = this.callFunction(context, node, (id) => this.inputValue(context, node, definition, id, following));
      return outputs.get(pinId);
    }
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
    const implementation = definition.implementation;
    if (implementation?.kind === 'function' && implementation.source && isPure(definition)) {
      const source = implementation.source;
      return follow('Pure nodes are wired in a loop.', () => this.callLibrary(context, node, source, (id) => this.inputValue(context, node, definition, id, following)).get(pinId));
    }
    if ((kind === 'code' || kind === 'function') && isPure(definition)) {
      return follow('Pure nodes are wired in a loop.', () => this.callNode(context, node, definition, (id) => this.inputValue(context, node, definition, id, following)));
    }

    // Impure: the value from the node's latest run, or the type default before it has run.
    const pin = definition.outputs.find((p) => p.id === pinId);
    const key = outputKey(context.graph, node, pinId);
    return context.frame.outputs.has(key) ? context.frame.outputs.get(key) : defaultValue(pin?.type, context.run.types);
  }

  private macroProblem(context: GraphContext, node: GraphNode): string {
    return context.run.macroProblems.get(macroProblemKey(context.graph.id, node.id)) ?? 'This macro can\'t be used.';
  }

  // The id of the variable a Get/Set node is bound to (src/core/resolve.ts).
  private variableId(context: GraphContext, node: GraphNode): string {
    const id = node.properties.variable;
    if (typeof id !== 'string' || !id) this.fail(context, node, 'This variable node has no variable.');
    if (!context.run.variables.has(id) && !context.frame.locals.has(id)) this.fail(context, node, 'This node uses a variable that no longer exists.');
    return id;
  }
}

function unconnectedValue(node: GraphNode, pin: PinDefinition | undefined, pinId: string, types: TypeLookup): unknown {
  const stored = node.properties[`pin:${pinId}`];
  if (stored !== undefined) return fromStored(stored, pin?.type, types);
  if (pin?.defaultValue !== undefined) return fromStored(pin.defaultValue, pin?.type, types);
  return defaultValue(pin?.type, types);
}

function outputKey(graph: Graph, node: GraphNode, pinId: string): string {
  return JSON.stringify([graph.id, node.id, pinId]);
}

function nativeOperation(definition: NodeDefinition): string {
  return definition.implementation?.kind === 'native' ? definition.implementation.operation : '';
}
