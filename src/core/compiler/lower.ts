// Turns a graph document into Visual IR, reporting everything that stops it from compiling.
// The rules implemented here are those of docs/semantics.md.
import { Graph, GraphDocument, GraphNode, NodeDefinition, PinDefinition } from '../model';
import { NodeRegistry } from '../registry';
import { NodeResolver, createResolver, isPure } from '../resolve';
import { canConnect, formatType } from '../types';
import { CompileDiagnostic, hasErrors } from './diagnostics';
import { IrBlock, IrCallee, IrCodeHelper, IrExpr, IrImport, IrMember, IrProgram, IrSlot, IrStatement, ProgramTypes, SourceRef, exprType } from './ir';

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
  // Exec targets of each node's exec outputs, in connection order.
  execTargets: Map<string, Map<string, string[]>>;
  // Number of exec wires into each node.
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

  private readonly resolve: NodeResolver;
  // Reroute and pure nodes being followed for the current input, to catch data loops.
  private readonly following = new Set<string>();

  constructor(private readonly doc: GraphDocument, private readonly options: LowerOptions) {
    this.resolve = createResolver(options.registry, doc.variables);
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

    const eventGraphs: GraphInfo[] = [];
    for (const graph of this.doc.graphs) {
      if (graph.kind !== 'event') {
        if (graph.nodes.length) this.warning('graph-not-compiled', `${graph.kind === 'function' ? 'Function' : 'Macro'} "${graph.name}" isn't compiled yet; calling functions and macros arrives in a later version.`, graph.id);
        continue;
      }
      eventGraphs.push(this.analyze(graph));
    }

    const entries = eventGraphs.flatMap((info) => info.graph.nodes.filter((n) => n.type === START).map((start) => ({ info, start })));
    if (!entries.length) this.warning('no-start', 'The graph has no Start event, so the generated start method does nothing.');

    for (const info of eventGraphs) this.checkExecCycles(info);
    if (hasErrors(this.diagnostics)) return { diagnostics: this.diagnostics };

    const start = entries.flatMap(({ info, start: node }) => this.lowerNode(info, node.id));
    if (hasErrors(this.diagnostics)) return { diagnostics: this.diagnostics };

    return {
      diagnostics: this.diagnostics,
      program: {
        className: this.doc.name,
        members: [...this.members.values()],
        slots: [...this.slots.values()],
        helpers: [...this.helpers.values()],
        imports: [...this.imports.values()],
        blocks: [...this.blocks.values()],
        start
      }
    };
  }

  // ---- Validation ----------------------------------------------------------------------------

  private analyze(graph: Graph): GraphInfo {
    const info: GraphInfo = { graph, nodes: new Map(), definitions: new Map(), execTargets: new Map(), execIndegree: new Map(), dataSources: new Map() };
    for (const node of graph.nodes) {
      if (info.nodes.has(node.id)) {
        this.error('duplicate-node', `Two nodes share the id "${node.id}".`, graph.id, node.id);
        continue;
      }
      info.nodes.set(node.id, node);
      const def = this.resolve(node);
      if (def) info.definitions.set(node.id, def);
      else this.error('unknown-node-type', `Unknown node type "${node.type}". Its node library may be missing.`, graph.id, node.id);
    }

    for (const c of graph.connections) {
      const fromDef = info.definitions.get(c.fromNode);
      const toDef = info.definitions.get(c.toNode);
      if (!info.nodes.has(c.fromNode) || !info.nodes.has(c.toNode)) {
        this.warning('dangling-connection', `Connection "${c.id}" refers to a node that doesn't exist; it is ignored.`, graph.id);
        continue;
      }
      // Wires on unknown nodes were already reported with the node.
      if (!fromDef || !toDef) continue;
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
        const outputs = info.execTargets.get(c.fromNode) ?? new Map<string, string[]>();
        outputs.set(c.fromPin, [...(outputs.get(c.fromPin) ?? []), c.toNode]);
        info.execTargets.set(c.fromNode, outputs);
        info.execIndegree.set(c.toNode, (info.execIndegree.get(c.toNode) ?? 0) + 1);
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

  // Exec wires must not loop (docs/semantics.md, "Execution flow"). Reports each loop once.
  private checkExecCycles(info: GraphInfo): void {
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (nodeId: string): void => {
      state.set(nodeId, 'visiting');
      for (const targets of info.execTargets.get(nodeId)?.values() ?? []) {
        for (const target of targets) {
          const seen = state.get(target);
          if (seen === 'visiting') this.error('exec-cycle', 'Exec wires loop back to this node. Loops need a loop node (arriving in a later version).', info.graph.id, target);
          else if (!seen) visit(target);
        }
      }
      state.set(nodeId, 'done');
    };
    for (const node of info.graph.nodes) if (!state.has(node.id)) visit(node.id);
  }

  // ---- Statements ----------------------------------------------------------------------------

  // Statements for `nodeId` and everything that runs after it. A node with several exec wires into
  // it becomes a shared block, called from each path, so its code isn't duplicated.
  private lowerNode(info: GraphInfo, nodeId: string, ownBlock?: string): IrStatement[] {
    const node = info.nodes.get(nodeId);
    const def = info.definitions.get(nodeId);
    if (!node || !def) return [];
    const source: SourceRef = { graphId: info.graph.id, nodeId, title: def.displayName };
    const key = JSON.stringify([info.graph.id, nodeId]);
    if ((info.execIndegree.get(nodeId) ?? 0) > 1 && ownBlock !== key) {
      if (!this.blocks.has(key)) {
        const block: IrBlock = { id: key, name: `run_${nodeId}`, body: [] };
        this.blocks.set(key, block);
        block.body = this.lowerNode(info, nodeId, key);
      }
      return [{ kind: 'callBlock', block: key, source }];
    }

    const next = (pin: string): IrStatement[] => (info.execTargets.get(nodeId)?.get(pin) ?? []).flatMap((target) => this.lowerNode(info, target));
    const input = (pinId: string): IrExpr => this.inputExpr(info, node, def, pinId);

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
    if (def.outputs.filter((p) => p.kind === 'data').length > 1) {
      this.warning('extra-outputs', `"${def.displayName}" has several data outputs; only "${output?.name || output?.id}" is produced.`, info.graph.id, nodeId);
    }
    return [
      {
        kind: 'call',
        callee,
        args: dataInputs(def).map((p) => this.inputExpr(info, node, def, p.id)),
        ...(output ? { resultSlot: this.slot(info, node, def, output.id) } : {}),
        source
      },
      ...next(execOut)
    ];
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
        return { kind: 'call', callee, args: dataInputs(sourceDef).map((p) => this.inputExpr(info, sourceNode, sourceDef, p.id)) };
      });
    }
    if (operation === 'get-variable' || operation === 'set-variable') {
      const member = this.variableMember(info, sourceNode, sourceDef);
      return member ? { kind: 'member', member: member.id } : { kind: 'default', type: pin?.type };
    }
    return { kind: 'output', slot: this.slot(info, sourceNode, sourceDef, source.pin) };
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

  // The member a Get/Set node is bound to (src/core/resolve.ts).
  private variableMember(info: GraphInfo, node: GraphNode, _def: NodeDefinition): IrMember | undefined {
    const id = node.properties.variable;
    if (typeof id !== 'string' || !id) {
      this.error('variable-unbound', 'This variable node has no variable. Delete it and drag a variable in from My Blueprint.', info.graph.id, node.id);
      return undefined;
    }
    const member = this.members.get(id);
    if (!member) this.error('unknown-variable', 'This node uses a variable that no longer exists.', info.graph.id, node.id);
    return member;
  }

  private slot(info: GraphInfo, node: GraphNode, def: NodeDefinition, pinId: string): string {
    const id = JSON.stringify([info.graph.id, node.id, pinId]);
    if (!this.slots.has(id)) {
      const pin = def.outputs.find((p) => p.id === pinId);
      this.slots.set(id, { id, name: `${node.id}_${pinId}`, type: pin?.type, source: { graphId: info.graph.id, nodeId: node.id, title: def.displayName } });
    }
    return id;
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
    this.imports.set(def.type, imported);
    return imported;
  }

  private codeHelper(info: GraphInfo, node: GraphNode, def: NodeDefinition): IrCodeHelper | undefined {
    const existing = this.helpers.get(def.type);
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
      id: def.type,
      name: def.type,
      params: dataInputs(def).map((p) => ({ pinId: p.id, type: p.type })),
      returns: def.outputs.find((p) => p.kind === 'data')?.type,
      code: sources[language]
    };
    this.helpers.set(def.type, helper);
    return helper;
  }

  private programView(): ProgramTypes {
    return { members: [...this.members.values()], slots: [...this.slots.values()], helpers: [...this.helpers.values()], imports: [...this.imports.values()] };
  }

  private error(code: string, message: string, graphId?: string, nodeId?: string): void {
    this.diagnostics.push({ severity: 'error', code, message, ...(graphId ? { graphId } : {}), ...(nodeId ? { nodeId } : {}) });
  }

  private warning(code: string, message: string, graphId?: string, nodeId?: string): void {
    this.diagnostics.push({ severity: 'warning', code, message, ...(graphId ? { graphId } : {}), ...(nodeId ? { nodeId } : {}) });
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

