// Turns a graph document into Visual IR, reporting everything that stops it from compiling.
// The rules implemented here are those of docs/semantics.md.
import { Graph, GraphDocument, GraphNode, NodeDefinition, PinDefinition } from '../model';
import { NodeRegistry } from '../registry';
import { describeFunction, functionStatus, isFunctionType } from '../imported-functions';
import { SWITCH_STRING, isStateInput, mainExecInput, switchIntCases, switchStringCases } from '../flow-control';
import { hasWildcard } from '../containers';
import { NodeResolver, REROUTE, createResolver, isPure } from '../resolve';
import { canConnect, formatType } from '../types';
import { CompileDiagnostic, hasErrors } from './diagnostics';
import { IrBlock, IrCallee, IrCodeHelper, IrExpr, IrFunction, IrImport, IrMember, IrProgram, IrSlot, IrStatement, ProgramTypes, SourceRef, exprType } from './ir';
import { FUNCTION_ENTRY, functionGraph } from '../functions';
import { MACRO_INPUTS, MACRO_OUTPUTS, MacroLookup, expandMacros, isExpandedNode, macroLookup, visibleNodeId } from '../macros';

export interface LowerOptions {
  registry: NodeRegistry;
  // Display name of the target language, for messages.
  languageName: string;
  // Keys of a code node's `languages` map the target can use, most preferred first.
  snippetLanguages: string[];
  // Languages of project code the target can import (docs/code-as-nodes.md, "Node identity").
  importLanguages: string[];
}

export interface LowerResult {
  // Absent when there are errors.
  program?: IrProgram;
  diagnostics: CompileDiagnostic[];
}

export function lowerDocument(doc: GraphDocument, options: LowerOptions): LowerResult {
  return new Lowerer(doc, options).run();
}

interface PinRef {
  node: string;
  pin: string;
}

// What lowering needs to know about one event graph, gathered and validated up front.
interface GraphInfo {
  graph: Graph;
  nodes: Map<string, GraphNode>;
  definitions: Map<string, NodeDefinition>;
  // The exec inputs each node's exec outputs are wired to, in connection order.
  execTargets: Map<string, Map<string, PinRef[]>>;
  // Number of exec wires into each exec input, keyed by `inputKey`.
  execIndegree: Map<string, number>;
  // The output wired into each data input, keyed by `inputKey`.
  dataSources: Map<string, PinRef>;
}

const START = 'core:event.start';

class Lowerer {
  private readonly diagnostics: CompileDiagnostic[] = [];
  private readonly members = new Map<string, IrMember>();
  private readonly slots = new Map<string, IrSlot>();
  private readonly helpers = new Map<string, IrCodeHelper>();
  private readonly imports = new Map<string, IrImport>();
  private readonly blocks = new Map<string, IrBlock>();
  private readonly functions: IrFunction[] = [];
  // The function graph being lowered, if any: its slots and locals belong to each call.
  private currentFunction: string | undefined;

  private readonly resolve: NodeResolver;
  private readonly macros: MacroLookup;
  // Reroute and pure nodes being followed for the current input, to catch data loops.
  private readonly following = new Set<string>();
  // While checking a graph with macros expanded in it: problems with the macros' own nodes were
  // reported in the macro graphs, so they aren't repeated at each use.
  private quietInner = false;
  // The macro each expanded instance uses, by graph and node id: code from inside a macro is
  // marked "Macro: Node".
  private readonly macroNames = new Map<string, string>();

  constructor(private readonly doc: GraphDocument, private readonly options: LowerOptions) {
    this.resolve = createResolver(options.registry, doc);
    this.macros = macroLookup(doc.graphs, (type) => options.registry.get(type));
  }

  run(): LowerResult {
    const names = new Set<string>();
    for (const variable of this.doc.variables) {
      if (this.members.has(variable.id) || names.has(variable.name)) {
        this.error('duplicate-variable', `Variable "${variable.name}" is declared more than once.`);
        continue;
      }
      names.add(variable.name);
      this.members.set(variable.id, {
        id: variable.id,
        name: variable.name,
        type: variable.type,
        initial: variable.defaultValue !== undefined ? { kind: 'literal', value: variable.defaultValue } : { kind: 'default', type: variable.type }
      });
    }

    // Each function's local variables: members scoped to the function.
    for (const graph of this.doc.graphs) {
      if (graph.kind !== 'function') continue;
      const localNames = new Set<string>();
      for (const local of graph.localVariables ?? []) {
        if (this.members.has(local.id) || localNames.has(local.name)) {
          this.error('duplicate-variable', `Local variable "${local.name}" is declared more than once.`, graph.id);
          continue;
        }
        localNames.add(local.name);
        this.members.set(local.id, {
          id: local.id, name: local.name, type: local.type, function: graph.id,
          initial: local.defaultValue !== undefined ? { kind: 'literal', value: local.defaultValue } : { kind: 'default', type: local.type }
        });
      }
    }

    const eventGraphs: GraphInfo[] = [];
    const functionGraphs: GraphInfo[] = [];
    for (const graph of this.doc.graphs) {
      if (graph.kind === 'event') eventGraphs.push(this.analyzeExpanded(graph));
      else if (graph.kind === 'function') functionGraphs.push(this.analyzeExpanded(graph));
      // Macros compile where they are used; their own wiring is checked here.
      else this.analyze(graph);
    }
    // A macro library only holds macros: there is no code to generate.
    if (this.doc.kind === 'macroLibrary') return { diagnostics: this.diagnostics };

    const entries = eventGraphs.flatMap((info) => info.graph.nodes.filter((n) => n.type === START).map((start) => ({ info, start })));
    if (!entries.length && this.doc.kind === 'class') this.warning('no-start', 'The graph has no Start event, so the generated start method does nothing.');

    for (const info of [...eventGraphs, ...functionGraphs]) this.checkExecCycles(info);
    if (hasErrors(this.diagnostics)) return { diagnostics: this.diagnostics };

    for (const info of functionGraphs) this.lowerFunction(info);
    const start = entries.flatMap(({ info, start: node }) => this.lowerNode(info, node.id));
    if (hasErrors(this.diagnostics)) return { diagnostics: this.diagnostics };

    return {
      diagnostics: this.diagnostics,
      program: {
        className: this.doc.name,
        ...(this.doc.kind === 'functionLibrary' ? { library: true } : {}),
        members: [...this.members.values()],
        slots: [...this.slots.values()],
        helpers: [...this.helpers.values()],
        imports: [...this.imports.values()],
        blocks: [...this.blocks.values()],
        functions: this.functions,
        start
      }
    };
  }

  // ---- Functions (docs/program-structure.md, "Functions") -----------------------------------

  // A function graph's body, from its Function Entry node.
  private lowerFunction(info: GraphInfo): void {
    const graph = info.graph;
    const entries = graph.nodes.filter((n) => n.type === FUNCTION_ENTRY);
    if (entries.length !== 1) {
      this.error('function-entry', `Function "${graph.name}" needs exactly one Function Entry node.`, graph.id, entries[1]?.id);
      return;
    }
    for (const node of graph.nodes) {
      if (node.type.startsWith('core:event.')) this.error('event-in-function', 'Events belong in event graphs, not in functions.', graph.id, node.id);
    }
    const signature = graph.signature ?? { inputs: [], outputs: [] };
    const fn: IrFunction = {
      id: graph.id,
      name: graph.name,
      params: signature.inputs.filter((p) => p.kind === 'data').map((p) => ({ id: p.id, name: p.name, type: p.type })),
      outputs: signature.outputs.filter((p) => p.kind === 'data').map((p) => ({ id: p.id, name: p.name, type: p.type })),
      pure: !!signature.pure,
      ...(signature.description ? { description: signature.description } : {}),
      body: []
    };
    // Registered before the body, so calls inside it (recursion) can find it.
    this.functions.push(fn);
    this.currentFunction = graph.id;
    try {
      fn.body = this.lowerNode(info, entries[0].id);
    } finally {
      this.currentFunction = undefined;
    }
  }

  // ---- Validation ----------------------------------------------------------------------------

  // A graph with the macros it uses expanded in place (src/core/macros.ts).
  private analyzeExpanded(graph: Graph): GraphInfo {
    const expansion = expandMacros(graph, this.macros);
    for (const problem of expansion.problems) this.error('macro-invalid', problem.message, graph.id, problem.nodeId);
    for (const [id, name] of expansion.macros) this.macroNames.set(JSON.stringify([graph.id, id]), name);
    // The wires of an instance that couldn't be expanded aren't checked: the instance is reported.
    const unexpanded = new Set(expansion.problems.map((p) => p.nodeId).filter((id) => expansion.graph.nodes.some((n) => n.id === id)));
    if (expansion.graph === graph) return this.analyze(graph, unexpanded);
    this.quietInner = true;
    try {
      return this.analyze(expansion.graph, unexpanded);
    } finally {
      this.quietInner = false;
    }
  }

  private analyze(graph: Graph, unchecked: ReadonlySet<string> = new Set()): GraphInfo {
    const info: GraphInfo = { graph, nodes: new Map(), definitions: new Map(), execTargets: new Map(), execIndegree: new Map(), dataSources: new Map() };
    for (const node of graph.nodes) {
      if (info.nodes.has(node.id)) {
        this.error('duplicate-node', `Two nodes share the id "${node.id}".`, graph.id, node.id);
        continue;
      }
      info.nodes.set(node.id, node);
      if (isFunctionType(node.type)) this.checkFunction(graph, node);
      if ((node.type === MACRO_INPUTS || node.type === MACRO_OUTPUTS) && graph.kind !== 'macro') {
        this.error('tunnel-outside-macro', 'Inputs and Outputs nodes belong in macro graphs.', graph.id, node.id);
      }
      const def = this.resolve(node);
      if (def) info.definitions.set(node.id, def);
      // A missing macro library is reported where the macro is expanded.
      else if (!isFunctionType(node.type) && !node.type.startsWith('macro:')) this.error('unknown-node-type', `Unknown node type "${node.type}". Its node library may be missing.`, graph.id, node.id);
      // Unreal: "The type of … is undetermined. Connect something to it."
      if (def && node.type !== REROUTE && [...def.inputs, ...def.outputs].some((p) => hasWildcard(p.type))) {
        this.error('wildcard-unresolved', `"${def.displayName}" doesn't know its type yet. Connect a wire to one of its gray pins.`, graph.id, node.id);
      }
    }

    for (const c of graph.connections) {
      const fromDef = info.definitions.get(c.fromNode);
      const toDef = info.definitions.get(c.toNode);
      if (!info.nodes.has(c.fromNode) || !info.nodes.has(c.toNode)) {
        this.warning('dangling-connection', `Connection "${c.id}" refers to a node that doesn't exist; it is ignored.`, graph.id);
        continue;
      }
      // Wires on unknown nodes were already reported with the node.
      if (!fromDef || !toDef || unchecked.has(c.fromNode) || unchecked.has(c.toNode)) continue;
      const from = fromDef.outputs.find((p) => p.id === c.fromPin);
      const to = toDef.inputs.find((p) => p.id === c.toPin);
      if (!from || !to) {
        this.error('missing-pin', `A wire uses pin "${!from ? c.fromPin : c.toPin}", which "${(!from ? fromDef : toDef).displayName}" doesn't have.`, graph.id, !from ? c.fromNode : c.toNode);
        continue;
      }
      if (from.kind !== to.kind) {
        this.error('pin-kind-mismatch', `An ${from.kind} pin is wired to a ${to.kind} pin.`, graph.id, c.toNode);
        continue;
      }
      if (from.kind === 'exec') {
        const outputs = info.execTargets.get(c.fromNode) ?? new Map<string, PinRef[]>();
        outputs.set(c.fromPin, [...(outputs.get(c.fromPin) ?? []), { node: c.toNode, pin: c.toPin }]);
        info.execTargets.set(c.fromNode, outputs);
        const key = inputKey(c.toNode, c.toPin);
        info.execIndegree.set(key, (info.execIndegree.get(key) ?? 0) + 1);
        continue;
      }
      if (!canConnect(from.type, to.type)) {
        this.error('type-mismatch', `"${to.name || to.id}" expects ${formatType(to.type)} but is wired to ${formatType(from.type)}.`, graph.id, c.toNode);
        continue;
      }
      const key = inputKey(c.toNode, c.toPin);
      if (info.dataSources.has(key)) {
        this.warning('multiple-inputs', `"${to.name || to.id}" has more than one wire; only the first is used.`, graph.id, c.toNode);
        continue;
      }
      info.dataSources.set(key, { node: c.fromNode, pin: c.fromPin });
    }
    return info;
  }

  // A project function node whose code changed or disappeared can't compile until it is
  // refreshed or replaced (docs/code-as-nodes.md, "When the code changes").
  private checkFunction(graph: Graph, node: GraphNode): void {
    const stored = this.doc.importedFunctions?.[node.type];
    const status = functionStatus(stored, this.options.registry.get(node.type), () => this.options.registry.all());
    const { name, path } = describeFunction(node.type, stored);
    if (status.state === 'changed') {
      this.error('function-changed', `${name} in ${path} changed: ${status.changes.join('; ')}. Right-click the node and choose Refresh Node.`, graph.id, node.id);
    } else if (status.state === 'missing') {
      const [candidate] = status.candidates;
      const hint = status.candidates.length === 1 && candidate.implementation?.kind === 'function'
        ? ` Was it renamed or moved to ${candidate.implementation.name} in ${candidate.implementation.path}? Right-click the node and choose Replace with ${candidate.displayName}.`
        : '';
      this.error('function-missing', `${name} in ${path} no longer exists, or is no longer marked @blueprint.${hint}`, graph.id, node.id);
    }
  }

  // Exec wires must not loop (docs/semantics.md, "Execution flow"); loops come from loop nodes.
  // Wires into inputs that only change a node's state (Break, Reset, Gate's Open and Close) don't
  // continue, so they can't close a loop. Reports each loop once.
  private checkExecCycles(info: GraphInfo): void {
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (nodeId: string): void => {
      state.set(nodeId, 'visiting');
      for (const targets of info.execTargets.get(nodeId)?.values() ?? []) {
        for (const target of targets) {
          const def = info.definitions.get(target.node);
          if (def && isStateInput(def, target.pin)) continue;
          const seen = state.get(target.node);
          if (seen === 'visiting') this.error('exec-cycle', 'Exec wires loop back to this node. Use a loop node (For Loop, While Loop) to repeat.', info.graph.id, target.node);
          else if (!seen) visit(target.node);
        }
      }
      state.set(nodeId, 'done');
    };
    for (const node of info.graph.nodes) if (!state.has(node.id)) visit(node.id);
  }

  // ---- Statements ----------------------------------------------------------------------------

  // Statements for running `nodeId` through its exec input `entry` (its main one by default), and
  // everything that runs after it. An input with several exec wires into it becomes a shared
  // block, called from each path, so its code isn't duplicated.
  private lowerNode(info: GraphInfo, nodeId: string, entry?: string, ownBlock?: string): IrStatement[] {
    const node = info.nodes.get(nodeId);
    const def = info.definitions.get(nodeId);
    if (!node || !def) return [];
    const pin = entry ?? mainExecInput(def);
    const source = this.sourceRef(info, nodeId, def);
    const key = JSON.stringify([info.graph.id, nodeId, pin]);
    // Inside a function, shared code is written out on each path instead: a block method couldn't
    // see the call's locals.
    if (!this.currentFunction && (info.execIndegree.get(inputKey(nodeId, pin)) ?? 0) > 1 && ownBlock !== key) {
      if (!this.blocks.has(key)) {
        const main = pin === mainExecInput(def);
        const block: IrBlock = { id: key, name: main ? `run_${nodeId}` : `run_${nodeId}_${pin}`, body: [] };
        this.blocks.set(key, block);
        block.body = this.lowerNode(info, nodeId, pin, key);
      }
      return [{ kind: 'callBlock', block: key, source }];
    }

    const next = (out: string): IrStatement[] => (info.execTargets.get(nodeId)?.get(out) ?? []).flatMap((target) => this.lowerNode(info, target.node, target.pin));
    const input = (pinId: string): IrExpr => this.inputExpr(info, node, def, pinId);
    const flowStatements = this.lowerFlowControl(info, node, def, pin, next, input, source);
    if (flowStatements) return flowStatements;

    switch (nativeOperation(def)) {
      case 'start':
        return next('execOut');
      case 'add':
        return [
          { kind: 'store', slot: this.slot(info, node, def, 'result'), value: { kind: 'add', left: { kind: 'toNumber', value: input('a') }, right: { kind: 'toNumber', value: input('b') } }, source },
          ...next('execOut')
        ];
      case 'print':
        return [{ kind: 'print', value: input('value'), source }, ...next('execOut')];
      case 'branch':
        return [{ kind: 'if', condition: { kind: 'toBoolean', value: input('condition') }, then: next('true'), else: next('false'), source }];
      case 'sequence':
        return def.outputs.filter((p) => p.kind === 'exec').map((p) => p.id).flatMap(next);
      case 'reroute':
        // Exec reroutes pass execution straight on.
        return next('out');
      case 'function-entry':
        if (info.graph.kind !== 'function') this.error('entry-outside-function', 'A Function Entry node belongs in its function graph.', info.graph.id, nodeId);
        return next('execOut');
      case 'function-return':
        if (info.graph.kind !== 'function') {
          this.error('return-outside-function', 'A Return Node belongs in a function graph.', info.graph.id, nodeId);
          return [];
        }
        return [{ kind: 'return', values: dataInputs(def).map((p) => input(p.id)), source }];
      case 'call-function': {
        const target = this.calledFunction(info, node);
        if (!target) return next('execOut');
        const results = def.outputs.filter((p) => p.kind === 'data').map((p) => ({ output: p.id, slot: this.slot(info, node, def, p.id) }));
        return [{ kind: 'callFunction', function: target.id, args: dataInputs(def).map((p) => input(p.id)), results, source }, ...next('execOut')];
      }
      case 'set-variable': {
        const member = this.variableMember(info, node, def);
        if (!member) return next('execOut');
        const value = input('value');
        const valueType = exprType(value, this.programView());
        if (!canConnect(valueType, member.type)) {
          this.error('variable-type-mismatch', `Set ${member.name} assigns ${formatType(valueType)} to a variable of type ${formatType(member.type)}.`, info.graph.id, nodeId);
        }
        return [{ kind: 'setMember', member: member.id, value, source }, ...next('execOut')];
      }
      case 'end':
        return [];
      // Expanded away, or reported: a macro that can't be expanded, a tunnel outside a macro.
      case 'macro-instance':
      case 'macro-inputs':
      case 'macro-outputs':
        return [];
    }

    if (def.implementation?.kind !== 'code' && def.implementation?.kind !== 'function') {
      this.error('no-codegen', `"${def.displayName}" can't be compiled to ${this.options.languageName}.`, info.graph.id, nodeId);
      return [];
    }
    const execOut = def.outputs.find((p) => p.kind === 'exec')?.id ?? 'execOut';
    const callee = this.callee(info, node, def);
    // Keep going after an error, so every node on the path is checked.
    if (!callee) return next(execOut);
    const output = def.outputs.find((p) => p.kind === 'data');
    const args = dataInputs(def).map((p) => this.inputExpr(info, node, def, p.id));
    // An imported function with several outputs (a graph library's) fills a slot per output.
    if (callee.kind === 'import' && this.imports.get(callee.id)?.outputs) {
      const results = def.outputs.filter((p) => p.kind === 'data').map((p) => ({ output: p.id, slot: this.slot(info, node, def, p.id) }));
      return [{ kind: 'call', callee, args, results, source }, ...next(execOut)];
    }
    if (def.outputs.filter((p) => p.kind === 'data').length > 1) {
      this.warning('extra-outputs', `"${def.displayName}" has several data outputs; only "${output?.name || output?.id}" is produced.`, info.graph.id, nodeId);
    }
    return [{ kind: 'call', callee, args, ...(output ? { resultSlot: this.slot(info, node, def, output.id) } : {}), source }, ...next(execOut)];
  }

  // ---- Expressions ---------------------------------------------------------------------------

  private inputExpr(info: GraphInfo, node: GraphNode, def: NodeDefinition, pinId: string): IrExpr {
    const pin = def.inputs.find((p) => p.id === pinId);
    const source = info.dataSources.get(inputKey(node.id, pinId));
    if (!source) return unconnectedExpr(node, pin, pinId);

    const sourceNode = info.nodes.get(source.node);
    const sourceDef = info.definitions.get(source.node);
    if (!sourceNode || !sourceDef) return { kind: 'default', type: pin?.type };
    // Get is pure, and Set's output is the variable's new value: both read the member where used.
    const operation = nativeOperation(sourceDef);
    // Pure conversions are inlined where their value is used.
    if (operation === 'to-string') return { kind: 'toText', value: this.inputExpr(info, sourceNode, sourceDef, 'value') };
    // Make Array/Set/Map is pure: a new container wherever its value is used, as in Unreal.
    if (operation === 'make-array' || operation === 'make-set' || operation === 'make-map') {
      const type = sourceDef.outputs[0]?.type ?? { id: 'any', container: 'array' };
      return this.follow(info, sourceNode, 'Pure nodes are wired in a loop.', pin, () => ({
        kind: 'makeContainer', type, items: sourceDef.inputs.filter((p) => p.kind === 'data').map((p) => this.inputExpr(info, sourceNode, sourceDef, p.id))
      }));
    }
    // Reroutes are transparent: read whatever feeds them.
    if (operation === 'reroute') {
      return this.follow(info, sourceNode, 'Reroute nodes are wired in a loop.', pin, () => this.inputExpr(info, sourceNode, sourceDef, 'in'));
    }
    // Pure code and function nodes are evaluated where their value is used (docs/semantics.md).
    const kind = sourceDef.implementation?.kind;
    if (isPure(sourceDef) && (kind === 'code' || kind === 'function')) {
      return this.follow(info, sourceNode, 'Pure nodes are wired in a loop.', pin, () => {
        const callee = this.callee(info, sourceNode, sourceDef);
        if (!callee) return { kind: 'default', type: pin?.type };
        const several = callee.kind === 'import' && !!this.imports.get(callee.id)?.outputs;
        return { kind: 'call', callee, args: dataInputs(sourceDef).map((p) => this.inputExpr(info, sourceNode, sourceDef, p.id)), ...(several ? { output: source.pin } : {}) };
      });
    }
    if (operation === 'get-variable' || operation === 'set-variable') {
      const member = this.variableMember(info, sourceNode, sourceDef);
      return member ? { kind: 'member', member: member.id } : { kind: 'default', type: pin?.type };
    }
    // A function's inputs, read from its entry node.
    if (operation === 'function-entry') {
      if (!this.currentFunction) return { kind: 'default', type: pin?.type };
      return { kind: 'param', function: this.currentFunction, id: source.pin };
    }
    // A pure function's call: called where its value is used, every time.
    if (operation === 'call-function' && isPure(sourceDef)) {
      return this.follow(info, sourceNode, 'Pure nodes are wired in a loop.', pin, () => {
        const target = this.calledFunction(info, sourceNode);
        if (!target) return { kind: 'default', type: pin?.type };
        return { kind: 'callFunction', function: target.id, args: dataInputs(sourceDef).map((p) => this.inputExpr(info, sourceNode, sourceDef, p.id)), output: source.pin };
      });
    }
    return { kind: 'output', slot: this.slot(info, sourceNode, sourceDef, source.pin) };
  }

  // ---- Flow control (docs/program-structure.md, "Flow control") -----------------------------

  // Statements for a flow-control node entered through `entry`, or undefined for other nodes.
  // Remembered state (Do Once's closed flag, Gate's open flag, …) lives in slots on the object.
  private lowerFlowControl(
    info: GraphInfo, node: GraphNode, def: NodeDefinition, entry: string,
    next: (out: string) => IrStatement[], input: (pinId: string) => IrExpr, source: SourceRef
  ): IrStatement[] | undefined {
    const bool = (value: boolean): IrExpr => ({ kind: 'literal', value });
    const int = (value: number): IrExpr => ({ kind: 'literal', value });
    const read = (slot: string): IrExpr => ({ kind: 'output', slot });
    const store = (slot: string, value: IrExpr): IrStatement => ({ kind: 'store', slot, value, source });
    const when = (condition: IrExpr, then: IrStatement[], otherwise: IrStatement[] = []): IrStatement => ({ kind: 'if', condition, then, else: otherwise, source });
    const state = (name: string, type: string) => this.stateSlot(info, node, def, name, type);
    // Unconnected inputs are literals; folding keeps `!true` out of generated code.
    const truthy = (value: IrExpr): IrExpr => (value.kind === 'literal' ? bool(Boolean(value.value)) : { kind: 'toBoolean', value });
    const not = (value: IrExpr): IrExpr => (value.kind === 'literal' ? bool(!value.value) : { kind: 'not', value });
    // Runs `init` the first time any of the node's inputs runs (Unreal reads Start Closed then).
    const initOnce = (init: IrStatement[]): IrStatement => {
      const done = state('initialized', 'bool');
      return when(not(read(done)), [store(done, bool(true)), ...init]);
    };

    switch (nativeOperation(def)) {
      case 'for-loop': {
        const stop = def.inputs.some((p) => p.id === 'break') ? state('stop', 'bool') : undefined;
        if (entry === 'break') return stop ? [store(stop, bool(true))] : [];
        return [
          ...(stop ? [store(stop, bool(false))] : []),
          { kind: 'for', counter: this.slot(info, node, def, 'index'), first: input('firstIndex'), last: input('lastIndex'), ...(stop ? { stop } : {}), body: next('loopBody'), source },
          ...next('completed')
        ];
      }
      case 'while-loop':
        return [{ kind: 'while', condition: truthy(input('condition')), body: next('loopBody'), source }, ...next('completed')];
      case 'for-each': {
        const stop = def.inputs.some((p) => p.id === 'break') ? state('stop', 'bool') : undefined;
        if (entry === 'break') return stop ? [store(stop, bool(true))] : [];
        return [
          ...(stop ? [store(stop, bool(false))] : []),
          {
            kind: 'forEach', array: input('array'), index: this.slot(info, node, def, 'index'), element: this.slot(info, node, def, 'element'),
            ...(stop ? { stop } : {}), body: next('loopBody'), source
          },
          ...next('completed')
        ];
      }
      case 'do-once': {
        const closed = state('closed', 'bool');
        if (entry === 'reset') return [store(closed, bool(false))];
        return [
          initOnce([store(closed, truthy(input('startClosed')))]),
          when(not(read(closed)), [store(closed, bool(true)), ...next('completed')])
        ];
      }
      case 'do-n': {
        const counter = this.slot(info, node, def, 'counter');
        if (entry === 'reset') return [store(counter, int(0))];
        return [when({ kind: 'binary', op: '<', left: read(counter), right: input('n') }, [
          store(counter, { kind: 'binary', op: '+', left: read(counter), right: int(1) }),
          ...next('exit')
        ])];
      }
      case 'gate': {
        const open = state('open', 'bool');
        const init = initOnce([store(open, not(truthy(input('startClosed'))))]);
        switch (entry) {
          case 'open':
            return [init, store(open, bool(true))];
          case 'close':
            return [init, store(open, bool(false))];
          case 'toggle':
            return [init, store(open, not(read(open)))];
          default:
            return [init, when(read(open), next('exit'))];
        }
      }
      case 'flip-flop': {
        const isA = this.slot(info, node, def, 'isA');
        return [store(isA, not(read(isA))), when(read(isA), next('a'), next('b'))];
      }
      case 'multigate': {
        const initialized = state('initialized', 'bool');
        const position = state('next', 'int');
        if (entry === 'reset') return [store(initialized, bool(false))];
        const outputs = def.outputs.filter((p) => p.kind === 'exec').map((p) => p.id);
        const current = state('current', 'int');
        // out0 if current is 0, else out1 if 1, …
        const dispatch = outputs.reduceRight<IrStatement[]>((otherwise, out, i) => [when({ kind: 'binary', op: '==', left: read(current), right: int(i) }, next(out), otherwise)], []);
        return [
          initOnce([store(position, int(0)), when({ kind: 'binary', op: '>=', left: input('startIndex'), right: int(0) }, [store(position, input('startIndex'))])]),
          when({ kind: 'binary', op: '&&', left: { kind: 'binary', op: '>=', left: read(position), right: int(outputs.length) }, right: truthy(input('loop')) }, [store(position, int(0))]),
          when({ kind: 'binary', op: '<', left: read(position), right: int(outputs.length) }, [
            store(current, read(position)),
            store(position, { kind: 'binary', op: '+', left: read(position), right: int(1) }),
            ...dispatch
          ])
        ];
      }
      case 'switch': {
        const selection = state('selection', node.type === SWITCH_STRING ? 'string' : 'int');
        const values: unknown[] = node.type === SWITCH_STRING ? switchStringCases(node) : switchIntCases(node);
        const chain = values.reduceRight<IrStatement[]>(
          (otherwise, value, i) => [when({ kind: 'binary', op: '==', left: read(selection), right: { kind: 'literal', value } }, next(`case${i}`), otherwise)],
          next('default')
        );
        return [store(selection, input('selection')), ...chain];
      }
    }
    return undefined;
  }

  // A slot for state a node remembers between runs (not one of its outputs).
  private stateSlot(info: GraphInfo, node: GraphNode, def: NodeDefinition, name: string, type: string): string {
    const id = JSON.stringify([info.graph.id, node.id, `state:${name}`]);
    if (!this.slots.has(id)) {
      this.slots.set(id, { id, name: `${node.id}_${name}`, type: { id: type }, source: this.sourceRef(info, node.id, def), ...this.scope(info) });
    }
    return id;
  }

  // Evaluates `value` for a node feeding an input, reporting a loop if that node is already being
  // followed for the same input.
  private follow(info: GraphInfo, node: GraphNode, loopMessage: string, pin: PinDefinition | undefined, value: () => IrExpr): IrExpr {
    if (this.following.has(node.id)) {
      this.error('data-cycle', loopMessage, info.graph.id, node.id);
      return { kind: 'default', type: pin?.type };
    }
    this.following.add(node.id);
    try {
      return value();
    } finally {
      this.following.delete(node.id);
    }
  }

  // The member (or function local) a Get/Set node is bound to (src/core/resolve.ts).
  private variableMember(info: GraphInfo, node: GraphNode, _def: NodeDefinition): IrMember | undefined {
    const id = node.properties.variable;
    if (typeof id !== 'string' || !id) {
      this.error('variable-unbound', 'This variable node has no variable. Delete it and drag a variable in from My Blueprint.', info.graph.id, node.id);
      return undefined;
    }
    const member = this.members.get(id);
    if (!member) this.error('unknown-variable', 'This node uses a variable that no longer exists.', info.graph.id, node.id);
    else if (member.function && member.function !== info.graph.id) {
      this.error('local-outside-function', `"${member.name}" is a local variable of another function.`, info.graph.id, node.id);
      return undefined;
    }
    return member;
  }

  // The function graph a call node calls.
  private calledFunction(info: GraphInfo, node: GraphNode): Graph | undefined {
    const target = functionGraph(node, this.doc.graphs);
    if (!target) this.error('function-missing', 'This node calls a function that no longer exists.', info.graph.id, node.id);
    return target;
  }

  private slot(info: GraphInfo, node: GraphNode, def: NodeDefinition, pinId: string): string {
    const id = JSON.stringify([info.graph.id, node.id, pinId]);
    if (!this.slots.has(id)) {
      const pin = def.outputs.find((p) => p.id === pinId);
      this.slots.set(id, { id, name: `${node.id}_${pinId}`, type: pin?.type, source: this.sourceRef(info, node.id, def), ...this.scope(info) });
    }
    return id;
  }

  // Slots of nodes in a function graph live in each call.
  private scope(info: GraphInfo): { function?: string } {
    return info.graph.kind === 'function' ? { function: info.graph.id } : {};
  }

  private callee(info: GraphInfo, node: GraphNode, def: NodeDefinition): IrCallee | undefined {
    if (def.implementation?.kind === 'function') {
      const imported = this.importFor(info, node, def);
      return imported && { kind: 'import', id: imported.id };
    }
    const helper = this.codeHelper(info, node, def);
    return helper && { kind: 'helper', id: helper.id };
  }

  // A function from the project's code, which the generated file imports.
  private importFor(info: GraphInfo, node: GraphNode, def: NodeDefinition): IrImport | undefined {
    const existing = this.imports.get(def.type);
    if (existing) return existing;
    const implementation = def.implementation;
    if (implementation?.kind !== 'function') return undefined;
    if (!this.options.importLanguages.includes(implementation.language)) {
      this.error('wrong-language', `"${def.displayName}" is ${languageName(implementation.language)} code (${implementation.path}); a ${this.options.languageName} graph can't call it.`, info.graph.id, node.id);
      return undefined;
    }
    const imported: IrImport = {
      id: def.type,
      name: implementation.name,
      language: implementation.language,
      path: implementation.path,
      ...(implementation.module ? { module: implementation.module } : {}),
      params: dataInputs(def).map((p) => ({ pinId: p.id, type: p.type })),
      returns: def.outputs.find((p) => p.kind === 'data')?.type
    };
    const outputs = def.outputs.filter((p) => p.kind === 'data');
    if (outputs.length > 1) imported.outputs = outputs.map((p) => ({ id: p.id, name: p.name, type: p.type }));
    this.imports.set(def.type, imported);
    return imported;
  }

  private codeHelper(info: GraphInfo, node: GraphNode, def: NodeDefinition): IrCodeHelper | undefined {
    // A wildcard node (Add on an array of int, or of string) needs a helper per element type.
    const key = JSON.stringify([def.type, dataInputs(def).map((p) => p.type ?? null), def.outputs.find((p) => p.kind === 'data')?.type ?? null]);
    const existing = this.helpers.get(key);
    if (existing) return existing;
    if (def.implementation?.kind !== 'code') return undefined;
    const sources = def.implementation.languages;
    const language = this.options.snippetLanguages.find((key) => sources[key] !== undefined);
    if (!language) {
      const wanted = this.options.snippetLanguages.map((key) => `"${key}"`).join(' or ');
      this.error('missing-snippet', `"${def.displayName}" has no ${this.options.languageName} implementation; add a ${wanted} entry to its languages.`, info.graph.id, node.id);
      return undefined;
    }
    const helper: IrCodeHelper = {
      id: key,
      // "core:math.clamp" becomes math_clamp: the namespace adds nothing to a method name.
      name: def.type.replace(/^[\w-]+:/, ''),
      params: dataInputs(def).map((p) => ({ pinId: p.id, type: p.type })),
      returns: def.outputs.find((p) => p.kind === 'data')?.type,
      code: sources[language]
    };
    this.helpers.set(key, helper);
    return helper;
  }

  private programView(): ProgramTypes {
    return { members: [...this.members.values()], slots: [...this.slots.values()], helpers: [...this.helpers.values()], imports: [...this.imports.values()], functions: this.functions };
  }

  // Where IR came from: a node inside an expanded macro is its instance node, the one the user sees.
  private sourceRef(info: GraphInfo, nodeId: string, def: NodeDefinition): SourceRef {
    const visible = visibleNodeId(nodeId);
    const macro = visible !== nodeId ? this.macroNames.get(JSON.stringify([info.graph.id, visible])) : undefined;
    return { graphId: info.graph.id, nodeId: visible, title: macro ? `${macro}: ${def.displayName}` : def.displayName };
  }

  // A node inside an expanded macro is reported as its instance node, the one the user sees.
  private error(code: string, message: string, graphId?: string, nodeId?: string): void {
    this.report('error', code, message, graphId, nodeId);
  }

  private warning(code: string, message: string, graphId?: string, nodeId?: string): void {
    this.report('warning', code, message, graphId, nodeId);
  }

  private report(severity: CompileDiagnostic['severity'], code: string, message: string, graphId?: string, nodeId?: string): void {
    if (nodeId && isExpandedNode(nodeId) && this.quietInner) return;
    const visible = nodeId && visibleNodeId(nodeId);
    const diagnostic: CompileDiagnostic = { severity, code, message, ...(graphId ? { graphId } : {}), ...(visible ? { nodeId: visible } : {}) };
    if (!this.diagnostics.some((d) => d.severity === severity && d.code === code && d.message === message && d.graphId === diagnostic.graphId && d.nodeId === diagnostic.nodeId)) this.diagnostics.push(diagnostic);
  }
}

// An unconnected input's value: stored on the node, else the pin's default, else the type default.
function unconnectedExpr(node: GraphNode, pin: PinDefinition | undefined, pinId: string): IrExpr {
  const stored = node.properties[`pin:${pinId}`];
  if (stored !== undefined) return { kind: 'literal', value: stored };
  if (pin?.defaultValue !== undefined) return { kind: 'literal', value: pin.defaultValue };
  return { kind: 'default', type: pin?.type };
}

function inputKey(nodeId: string, pinId: string): string {
  return JSON.stringify([nodeId, pinId]);
}

function nativeOperation(def: NodeDefinition): string {
  return def.implementation?.kind === 'native' ? def.implementation.operation : '';
}

function dataInputs(def: NodeDefinition): PinDefinition[] {
  return def.inputs.filter((p) => p.kind === 'data');
}

const LANGUAGE_NAMES: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python' };

function languageName(id: string): string {
  return LANGUAGE_NAMES[id] ?? id;
}

