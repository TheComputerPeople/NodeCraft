// The reference interpreter ("Simulate"). It defines how graphs behave: every language pack's
// generated code must match it (docs/semantics.md, enforced by test/conformance).
import { LanguagePackRegistry } from './language-pack';
import { DEFAULT_LANGUAGE, builtinLanguagePacks } from './languages';
import { DebugFrame, DebugValue, Graph, GraphDocument, GraphNode, NodeDefinition, PinDefinition, RuntimeLogEvent } from './model';
import { NodeRegistry } from './registry';
import { SWITCH_STRING, isStateInput, mainExecInput, switchIntCases, switchStringCases } from './flow-control';
import { FUNCTION_ENTRY, functionGraph } from './functions';
import { CUSTOM_EVENT, DELEGATE_PIN, boundDispatcher, calledEvent, documentDispatchers, eventInputs } from './events';
import { ClassInfo, InterfaceInfo, ObjectValue, PARENT_START, classById, declaredClass, dispatcherAction, implementedInterfaces, interfaceById, nodeClass } from './objects';
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
  // The object this run is part of (src/core/objects.ts), and its class. An object of a subclass
  // has a run per class in its chain (`layers`, most derived first), sharing Self; each runs its own
  // class's graphs with its own class's variables.
  self: ObjectValue;
  ownClass?: ClassInfo;
  layers: RunState[];
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
  // The node running in this context (its visible id and title), for the debugger's call stack.
  current?: string;
  currentName?: string;
}

// Simulate's debugger (docs/debugging.md, "Debugging in Simulate"): told before each node with exec
// pins runs, it may block there until the user resumes.
export interface DebugHook {
  beforeNode(stop: DebugStop): void;
}

export interface DebugStop {
  // The call stack, innermost frame first; its first frame is the node about to run.
  stack: DebugFrame[];
  // The pure nodes this node reads (their visible ids, in its graph): a breakpoint on one of them
  // stops here, as in Unreal.
  pureSources(): string[];
  // A pin's value in a frame of the stack (0 is the innermost), read without running anything that
  // isn't pure.
  read(frame: number, nodeId: string, pinId: string): DebugValue;
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

// Simulate stops after running this many latent actions (a timer loop runs forever otherwise).
export const MAX_LATENT_ACTIONS = 10_000;

// Thrown after an error has been reported, to stop the whole run (docs/semantics.md, "Errors").
class RunStopped extends Error {}

export class GraphRuntime {
  // Simulate's virtual clock (docs/program-structure.md, "Latent actions"): pending latent actions
  // run in the order they fall due (ties in the order they were started), without waiting.
  private latent: { due: number; order: number; run: () => void }[] = [];
  private clock = 0;
  private latentOrder = 0;
  // The debugger, when Simulate runs under one, and the contexts of the calls in progress.
  debug?: DebugHook;
  private debugStack: GraphContext[] = [];
  // Set while the debugger reads a value: nothing is reported, and the debugger isn't called.
  private evaluating = false;

  constructor(
    private readonly registry: NodeRegistry,
    private readonly emit: (event: RuntimeLogEvent) => void,
    private readonly languages: LanguagePackRegistry = builtinLanguagePacks(),
    // Reads another graph file (a function library, by workspace-relative path) for Simulate.
    private readonly loadDocument?: (path: string) => GraphDocument | undefined
  ) {}

  // Runs every Start node in the document's event graphs, then its Main event with `args` (the
  // program's command-line arguments). Function graphs only run when called.
  run(doc: GraphDocument, args: string[] = []): void {
    const layers = this.instantiate(doc);
    if (typeof layers === 'string') {
      this.emit({ kind: 'error', message: layers });
      return;
    }
    const run = layers[0];
    if (!layers.some((l) => this.startEntries(l).length)) {
      this.emit({ kind: 'error', message: 'Graph has no Start node.' });
      return;
    }

    try {
      this.latent = [];
      this.clock = 0;
      this.start(run);
      this.main(run, args);
      // Then the latent actions, as their time comes.
      for (let ran = 0; this.latent.length; ran++) {
        if (ran >= MAX_LATENT_ACTIONS) {
          this.emit({ kind: 'error', message: `Simulate stopped after ${MAX_LATENT_ACTIONS} latent actions (a Delay that keeps starting itself runs forever).` });
          throw new RunStopped('latent');
        }
        this.latent.sort((a, b) => a.due - b.due || a.order - b.order);
        const next = this.latent.shift()!;
        this.clock = next.due;
        next.run();
      }
      this.emit({ kind: 'graph.complete', message: 'Graph execution completed.' });
    } catch (error) {
      if (!(error instanceof RunStopped)) throw error;
      this.emit({ kind: 'graph.complete', message: 'Graph execution stopped by an error.' });
    }
  }

  private report(context: GraphContext, event: RuntimeLogEvent): void {
    if (this.evaluating) return;
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
  private executeNode(context: GraphContext, node: GraphNode, entry?: string, via?: string): void {
    const definition = context.run.resolve(node) ?? this.fail(context, node, `Unknown node type: ${node.type}`);
    const pin = entry ?? mainExecInput(definition);
    const reentering = context.executing.has(node.id);
    if (reentering && !isStateInput(definition, pin)) this.fail(context, node, `Execution cycle through ${node.id}: exec wires loop back to a node that is still running.`);
    if (!reentering) context.executing.add(node.id);
    // A call (or a latent action resuming) enters a context; the nodes it runs in turn don't.
    const debugging = this.debug !== undefined && !this.evaluating;
    const entered = debugging && this.debugStack[this.debugStack.length - 1] !== context;
    if (entered) this.debugStack.push(context);
    try {
      if (debugging) this.debugBefore(context, node);
      this.runNode(context, node, definition, pin, via);
    } finally {
      if (!reentering) context.executing.delete(node.id);
      if (entered) this.debugStack.pop();
    }
  }

  // Tells the debugger a node is about to run. The nodes of one macro use run as one node: the
  // debugger shows the macro's node, and steps over its insides.
  private debugBefore(context: GraphContext, node: GraphNode): void {
    const visible = visibleNodeId(node.id);
    if (isExpandedNode(node.id) && context.current === visible) return;
    context.current = visible;
    // A macro's insides stand for its node (whose name expansion doesn't keep).
    context.currentName = isExpandedNode(node.id) ? 'Macro' : context.run.resolve(node)?.displayName ?? node.type;
    const stack = this.debugStack.map((c): DebugFrame => ({
      graphId: c.graph.id, graphName: c.graph.name, nodeId: c.current ?? '', nodeName: c.currentName ?? '', ...(c.run.document ? { document: c.run.document } : {})
    })).reverse();
    const contexts = [...this.debugStack].reverse();
    this.debug!.beforeNode({
      stack,
      pureSources: () => this.pureSources(context, node),
      read: (frame, nodeId, pinId) => (contexts[frame] ? this.readValue(contexts[frame], nodeId, pinId) : { unavailable: 'That call has returned.' })
    });
  }

  // A pin's value for the debugger (docs/debugging.md, "Values"): an impure node's output as it
  // stored it, a pure node's computed as reading it would, an input as the node reads it.
  private readValue(context: GraphContext, nodeId: string, pinId: string): DebugValue {
    const node = context.graph.nodes.find((n) => n.id === nodeId);
    const definition = node && context.run.resolve(node);
    // A macro's node is replaced by its insides when the graph runs.
    if (!node || !definition) return { unavailable: "No value: this node doesn't run as it is shown." };
    const input = definition.inputs.find((p) => p.id === pinId);
    const pin = input ?? definition.outputs.find((p) => p.id === pinId);
    if (!pin || pin.kind !== 'data') return { unavailable: 'No value.' };
    const operation = nativeOperation(definition);
    const stored = isPure(definition) || operation === 'set-variable' || operation === 'function-entry' || context.frame.outputs.has(outputKey(context.graph, node, pinId));
    if (!input && !stored) return { unavailable: "This node hasn't run yet." };
    this.evaluating = true;
    try {
      const value = input ? this.inputValue(context, node, definition, pinId) : this.outputValue(context, node, pinId, new Set());
      return { value: typeof value === 'string' ? JSON.stringify(value) : formatValue(value) };
    } catch (error) {
      return { unavailable: error instanceof Error ? error.message : String(error) };
    } finally {
      this.evaluating = false;
    }
  }

  // The pure nodes whose outputs feed `node`'s inputs, directly or through other pure nodes.
  private pureSources(context: GraphContext, node: GraphNode): string[] {
    const { graph } = context;
    const found = new Set<string>();
    const pending = [node.id];
    while (pending.length) {
      const id = pending.pop()!;
      for (const c of graph.connections) {
        if (c.toNode !== id || found.has(c.fromNode)) continue;
        const source = graph.nodes.find((n) => n.id === c.fromNode);
        const definition = source && context.run.resolve(source);
        if (!definition || !isPure(definition)) continue;
        found.add(c.fromNode);
        pending.push(c.fromNode);
      }
    }
    return [...new Set([...found].map(visibleNodeId))];
  }

  private runNode(context: GraphContext, node: GraphNode, definition: NodeDefinition, entry: string, via?: string): void {
    const { graph } = context;
    // Wires inside a macro's expansion aren't on screen.
    const wire = via && !isExpandedNode(via) ? { connectionId: via } : {};
    this.report(context, { kind: 'node.enter', nodeId: node.id, nodeType: node.type, ...wire });

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
        if (next) this.executeNode(context, next, c.toPin, c.id);
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
      case 'delay':
      case 'retriggerable-delay': {
        if (context.frame.depth > 0) this.fail(context, node, "Delay belongs in event graphs: a function can't wait.");
        const seconds = Math.max(0, toNumber(input('duration')));
        const key = (name: string) => outputKey(graph, node, `state:${name}`);
        const state = context.frame.state;
        exit();
        if (nativeOperation(definition) === 'retriggerable-delay') {
          // Starts over: only the latest start's countdown runs Completed.
          const started = Number(state.get(key('generation')) ?? 0) + 1;
          state.set(key('generation'), started);
          this.schedule(seconds, () => {
            if (state.get(key('generation')) === started) continueFrom('completed');
          });
        } else if (!state.get(key('pending'))) {
          state.set(key('pending'), true);
          this.schedule(seconds, () => {
            state.set(key('pending'), false);
            continueFrom('completed');
          });
        }
        return;
      }
      case 'interface-call': {
        const outputs = this.callInterface(context, node, definition, input);
        for (const [pin, value] of outputs) setOutput(pin, value);
        exit(Object.fromEntries(outputs));
        continueFrom('execOut');
        return;
      }
      case 'parent-call': {
        const name = String(node.properties.function ?? PARENT_START);
        exit();
        if (name === PARENT_START) {
          this.start(context.run, context.run.layers.indexOf(context.run) + 1);
        } else {
          const fn = this.parentFunction(context, node);
          for (const [pin, value] of this.runFunction(context, node, fn.run, fn.graph, input)) setOutput(pin, value);
        }
        continueFrom('execOut');
        return;
      }
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
          const fn = this.objectFunction(context, node, type, target);
          const outputs = this.runFunction(context, node, fn.run, fn.graph, input);
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
        // Cast To: the object as the class or interface, when it is one.
        if (implementation?.kind === 'interface' || (implementation?.kind === 'class' && implementation.operation === 'cast')) {
          const value = input('object');
          const is = value instanceof ObjectValue && this.isA(value, implementation.type.id);
          setOutput('as', is ? value : null);
          exit({ succeeded: is });
          continueFrom(is ? 'succeeded' : 'failed');
          break;
        }
        // An entry event (Main, a framework's): its chain runs.
        if (implementation?.kind === 'event') {
          exit();
          continueFrom('execOut');
          break;
        }
        if (implementation?.kind === 'class' && implementation.operation === 'construct') {
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
  // Calls are virtual, as in Unreal: a subclass's function of the same name runs instead.
  private callFunction(context: GraphContext, node: GraphNode, input: (pinId: string) => unknown): Map<string, unknown> {
    const graph = functionGraph(node, context.run.doc.graphs) ?? this.fail(context, node, 'This node calls a function that no longer exists.');
    const target = this.virtualFunction(context.run, graph.name) ?? { run: context.run, graph };
    return this.runFunction(context, node, target.run, target.graph, input);
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

  // Runs an object's Start events (a constructed object's too, as spawning runs BeginPlay): those of
  // the most derived class that has any, at or above `from` (Parent: Start runs the next ones up).
  private start(run: RunState, from = 0): void {
    const layer = run.layers.slice(from).find((l) => this.startEntries(l).length);
    if (!layer) return;
    for (const { graph, start } of this.startEntries(layer)) this.executeNode({ run: layer, graph, frame: layer.objectFrame, executing: new Set() }, start);
  }

  // The Main event of the object's most derived class that has one, with the arguments.
  private main(run: RunState, args: string[]): void {
    for (const layer of run.layers) {
      for (const graph of layer.doc.graphs.filter((g) => g.kind === 'event')) {
        for (const node of graph.nodes) {
          const implementation = layer.resolve(node)?.implementation;
          if (implementation?.kind !== 'event' || implementation.method !== 'Main') continue;
          this.runEvent({ run: layer, graph, frame: layer.objectFrame, executing: new Set() }, node, { run: layer, graph, node }, [[...args]]);
          return;
        }
      }
    }
  }

  // An object of `doc`'s class: a run per class in its chain, most derived first, or why it can't be
  // made (a parent class Simulate can't read).
  private instantiate(doc: GraphDocument, document?: string): RunState[] | string {
    const docs: { doc: GraphDocument; document?: string }[] = [{ doc, document }];
    const seen = new Set([doc.name]);
    for (let parent = doc.parent; parent;) {
      const type = classById(parent, (t) => this.registry.get(t));
      const parentDoc = type?.source && this.loadDocument?.(type.source.document);
      if (!type || !parentDoc) return `Simulate can't read the parent class ${parent.replace(/^object:/, '')}.`;
      if (seen.has(parentDoc.name)) return `${doc.name} inherits from itself.`;
      seen.add(parentDoc.name);
      docs.push({ doc: parentDoc, document: type.source!.document });
      parent = parentDoc.parent;
    }
    const layers = docs.map((d) => this.runState(d.doc, d.document));
    const self = new ObjectValue(doc.name, layers[0]);
    for (const layer of layers) Object.assign(layer, { self, layers });
    return layers;
  }

  // A function of the object by name, as virtual calls find it: the most derived class's at or
  // above layer `from`.
  private virtualFunction(run: RunState, name: string, from = 0): { run: RunState; graph: Graph } | undefined {
    for (const layer of run.layers.slice(from)) {
      const graph = layer.doc.graphs.find((g) => g.kind === 'function' && g.name === name);
      if (graph) return { run: layer, graph };
    }
    return undefined;
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
      objectFrame, bindings: new Map(), eventDepth: 0, self: undefined as unknown as ObjectValue, layers: [], ...(ownClass ? { ownClass } : {}), ...(document ? { document } : {})
    };
    // On its own: an object of one class. instantiate() links the runs of a class chain.
    Object.assign(run, { self: new ObjectValue(doc.name, run), layers: [run] });
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
    // A custom event's inputs are its own; an entry event's (Main…), its definition's data outputs.
    const params = event.node.type === CUSTOM_EVENT ? eventInputs(event.node) : (run.resolve(event.node)?.outputs ?? []);
    params.filter((p) => p.kind === 'data').forEach((p, i) => run.objectFrame.outputs.set(outputKey(event.graph, event.node, p.id), args[i]));
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
    const layers = this.instantiate(doc, own ? context.run.document : type.source?.document);
    if (typeof layers === 'string') this.fail(context, node, layers);
    const run = layers[0];
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
    const own = context.run.layers.some((l) => l.ownClass?.id === type.id);
    const value = wired ? input('target') : own ? context.run.self : undefined;
    if (!(value instanceof ObjectValue)) this.fail(context, node, `Accessed None: Target has no ${type.name}.`);
    void definition;
    // The run of the class that declares the member (an ancestor's, for an inherited one).
    const layers = (value.state as RunState).layers;
    return { type, target: layers.find((l) => l.ownClass?.id === type.id) ?? layers[0] };
  }

  private schedule(seconds: number, run: () => void): void {
    this.latent.push({ due: this.clock + seconds, order: this.latentOrder++, run });
  }

  // Whether an object is of a class (or a subclass of it), or implements an interface.
  private isA(object: ObjectValue, id: string): boolean {
    const layers = (object.state as RunState).layers;
    return layers.some((l) => l.ownClass?.id === id || l.ownClass?.interfaces?.includes(id));
  }

  // An interface function of the Target (Self when this class implements the interface): the
  // object's function of that name, or outputs at their defaults when its class gives it no body.
  private callInterface(context: GraphContext, node: GraphNode, definition: NodeDefinition, input: (pinId: string) => unknown): Map<string, unknown> {
    const definitionOf = (t: string) => this.registry.get(t);
    const iface = (typeof node.properties.interface === 'string' ? interfaceById(node.properties.interface, definitionOf) : undefined) as InterfaceInfo | undefined;
    const fn = iface?.functions.find((f) => f.id === node.properties.function) ?? this.fail(context, node, 'This interface function no longer exists.');
    const wired = context.graph.connections.some((c) => c.toNode === node.id && c.toPin === 'target');
    const own = context.run.ownClass && implementedInterfaces(context.run.ownClass, definitionOf).includes(iface!.id);
    const value = wired ? input('target') : own ? context.run.self : undefined;
    if (!(value instanceof ObjectValue)) this.fail(context, node, `Accessed None: Target has no ${iface!.name}.`);
    const found = this.virtualFunction(value.state as RunState, fn.name);
    if (found) return this.runFunction(context, node, found.run, found.graph, input);
    void definition;
    return new Map(fn.outputs.filter((p) => p.kind === 'data').map((p) => [p.id, defaultValue(p.type, context.run.types)]));
  }

  // A function of a Target object, by the name its class gives it: the object's most derived version.
  private objectFunction(context: GraphContext, node: GraphNode, type: ClassInfo, target: RunState): { run: RunState; graph: Graph } {
    const name = type.functions.find((f) => f.id === node.properties.function)?.name;
    return (name && this.virtualFunction(target, name)) || this.fail(context, node, `${type.name} no longer has this function.`);
  }

  // The parent class's version of the function a Parent node names.
  private parentFunction(context: GraphContext, node: GraphNode): { run: RunState; graph: Graph } {
    const name = String(node.properties.function);
    return this.virtualFunction(context.run, name, context.run.layers.indexOf(context.run) + 1) ?? this.fail(context, node, `The parent class has no function "${name}".`);
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
      const fn = this.objectFunction(context, node, type, target);
      return this.runFunction(context, node, fn.run, fn.graph, (id) => this.inputValue(context, node, definition, id, following)).get(pinId);
    }
    if (operation === 'interface-call' && isPure(definition)) {
      return this.callInterface(context, node, definition, (id) => this.inputValue(context, node, definition, id, following)).get(pinId);
    }
    // A pure parent function: called on every read.
    if (operation === 'parent-call' && isPure(definition)) {
      const fn = this.parentFunction(context, node);
      return this.runFunction(context, node, fn.run, fn.graph, (id) => this.inputValue(context, node, definition, id, following)).get(pinId);
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
