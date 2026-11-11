// Turns a graph document into Visual IR, reporting everything that stops it from compiling.
// The rules implemented here are those of docs/semantics.md.
import { Graph, GraphDocument, GraphNode, NodeDefinition, PinDefinition } from '../model';
import { deprecationMessage } from '../metadata';
import { NodeRegistry } from '../registry';
import { describeFunction, functionStatus, isFunctionType } from '../imported-functions';
import { libraryChange, libraryChangeMessage } from '../node-packages';
import { SWITCH_STRING, isStateInput, mainExecInput, switchIntCases, switchStringCases } from '../flow-control';
import { adoptedTypes, hasWildcard } from '../containers';
import { NodeResolver, REROUTE, createResolver, createUnsplitResolver, isPure } from '../resolve';
import { canConnect, formatType } from '../types';
import { CompileDiagnostic, hasErrors } from './diagnostics';
import { IrBlock, IrCallee, IrCodeHelper, IrDeclaration, IrDispatcher, IrExpr, IrFunction, IrImport, IrMember, IrPinValue, IrProgram, IrSlot, IrStatement, IrTest, ProgramTypes, SourceRef, exprType, readsStorageOnly } from './ir';
import { FUNCTION_ENTRY, functionGraph } from '../functions';
import { CUSTOM_EVENT, DELEGATE_PIN, boundDispatcher, calledEvent, documentDispatchers, eventInputs, eventName } from '../events';
import { CODE_CLASS_PREFIX, ClassInfo, CodeClassInfo, InterfaceInfo, OVERRIDE_EVENT, PARENT_START, abstractLeft, codeClassById, codeParentMethod, codeParentOf, ancestors, canAccess, declaredClass, declaredInterface, dispatcherAction, implementedInterfaces, interfaceById, isObjectNode, nodeClass, parentFunction, subclassTest, codeClassBases, codeClasses } from '../objects';
import { MACRO_INPUTS, MACRO_INSTANCE, MACRO_OUTPUTS, MacroLookup, expandMacros, isMacroInnerNode, macroLookup, visibleNodeId } from '../macros';
import { TypeLookup, UserType, declaredType, expandSplitPins, isUserTypeId, typeLookup, userTypeProblems } from '../user-types';
import { TypeRef, setClassHierarchy } from '../types';
import { TEST_CASE, assertEqualMessage, assertTrueMessage, testName } from '../tests';
import { toIdentifier } from './names';
import { toNumber } from '../values';

export interface LowerOptions {
  registry: NodeRegistry;
  // Display name of the target language, for messages.
  languageName: string;
  // Keys of a code node's `languages` map the target can use, most preferred first.
  snippetLanguages: string[];
  // Languages of project code the target can import (docs/code-as-nodes.md, "Node identity").
  importLanguages: string[];
  // The pack's own implementations of library nodes, by node type (CodeGenerator.snippets).
  snippets?: Record<string, string>;
  // Display names of other languages, for messages (the registered packs').
  languageNames?: (id: string) => string | undefined;
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
  // Pins the debugger can read, by graph, node and pin.
  private readonly pinValues = new Map<string, IrPinValue>();
  private readonly helpers = new Map<string, IrCodeHelper>();
  private readonly imports = new Map<string, IrImport>();
  private readonly blocks = new Map<string, IrBlock>();
  private readonly functions: IrFunction[] = [];
  // The function graph being lowered, if any: its slots and locals belong to each call.
  private currentFunction: string | undefined;
  // The custom event whose method is being lowered: its inputs are that method's parameters.
  private currentEvent: string | undefined;

  private readonly resolve: NodeResolver;
  private readonly macros: MacroLookup;
  // The workspace's structs and enums (src/core/user-types.ts).
  private readonly types: TypeLookup;
  // The class this document declares, as other objects see it (src/core/objects.ts), and its
  // ancestors, nearest first.
  private readonly ownClass: ClassInfo | undefined;
  private readonly ancestors: ClassInfo[];
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
    this.types = typeLookup(options.registry.all(), doc.language);
    this.ownClass = declaredClass(doc);
    const definition = (type: string) => options.registry.get(type);
    this.ancestors = this.ownClass ? ancestors(this.ownClass, definition) : [];
    // An object of a subclass connects where its parent class is expected.
    setClassHierarchy(subclassTest(definition, this.ownClass, codeClassBases(options.registry.all())));
  }

  run(): LowerResult {
    this.checkUserTypes();
    if (this.doc.kind === 'structure' || this.doc.kind === 'enumeration' || this.doc.kind === 'interface') return this.declaration();
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
        initial: this.initialExpr(variable.defaultValue, variable.type),
        ...(variable.access && variable.access !== 'public' ? { access: variable.access } : {})
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
          initial: this.initialExpr(local.defaultValue, local.type)
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

    for (const info of [...eventGraphs, ...functionGraphs]) this.checkExecCycles(info);
    if (hasErrors(this.diagnostics)) return { diagnostics: this.diagnostics };

    // Custom events are methods too; registered first, so Call nodes anywhere find them. So are
    // entry events (Main, framework packs' events), whose methods something outside runs.
    const isEntryEvent = (info: GraphInfo, node: GraphNode) => info.definitions.get(node.id)?.implementation?.kind === 'event';
    const events = eventGraphs.flatMap((info) => info.graph.nodes.filter((n) => n.type === CUSTOM_EVENT || isEntryEvent(info, n)).map((node) => ({ info, node, fn: this.registerEvent(info, node) })));
    for (const info of functionGraphs) this.lowerFunction(info);
    for (const { info, node, fn } of events) this.lowerEvent(info, node, fn);
    const tests = this.lowerTests(eventGraphs);
    const start = entries.flatMap(({ info, start: node }) => this.lowerNode(info, node.id));
    this.checkInheritance();
    if (hasErrors(this.diagnostics)) return { diagnostics: this.diagnostics };

    const program: IrProgram = {
      className: this.doc.name,
      ...(this.doc.kind === 'functionLibrary' ? { library: true } : {}),
      members: [...this.members.values()],
      slots: [...this.slots.values()],
      helpers: [...this.helpers.values()],
      imports: [...this.imports.values()],
      blocks: [...this.blocks.values()],
      functions: this.functions,
      start,
      ...(tests.length ? { tests } : {}),
      pinValues: this.debugPins(),
      ...(this.ownClass ? { classInfo: this.ownClass } : {}),
      ...(this.ancestors.length ? { ancestors: this.ancestors } : {}),
      ...this.interfacePlan(),
      hasStart: entries.length > 0,
      dispatchers: documentDispatchers(this.doc).map((d): IrDispatcher => ({ id: d.id, name: d.name, params: d.inputs.filter((p) => p.kind === 'data').map((p) => ({ id: p.id, name: p.name, type: p.type })) }))
    };
    this.importTypes(program);
    if (hasErrors(this.diagnostics)) return { diagnostics: this.diagnostics };
    return { diagnostics: this.diagnostics, program };
  }

  // ---- Structs and enums (src/core/user-types.ts) ---------------------------------------------

  // A structure or enumeration document: the type it declares, with the fields' initial values.
  private declaration(): LowerResult {
    const iface = declaredInterface(this.doc);
    if (iface) {
      const names = new Set<string>();
      for (const fn of iface.functions) {
        if (names.has(fn.name)) this.error('duplicate-member', `${iface.name} has two functions named "${fn.name}".`, fn.id);
        names.add(fn.name);
      }
      const program: IrProgram = { className: this.doc.name, members: [], slots: [], helpers: [], imports: [], blocks: [], functions: [], start: [], declaration: { kind: 'interface', type: iface } };
      this.importTypes(program);
      if (hasErrors(this.diagnostics)) return { diagnostics: this.diagnostics };
      return { diagnostics: this.diagnostics, program };
    }
    const type = declaredType(this.doc);
    if (!type) return { diagnostics: this.diagnostics };
    const names = new Set<string>();
    const items = type.kind === 'struct' ? type.fields : type.enumerators;
    for (const item of items) {
      if (!item.name.trim()) this.error('unnamed-member', `Every ${type.kind === 'struct' ? 'field' : 'value'} of ${type.name} needs a name.`);
      else if (names.has(item.name)) this.error('duplicate-member', `${type.name} has two ${type.kind === 'struct' ? 'fields' : 'values'} named "${item.name}".`);
      names.add(item.name);
    }
    if (type.kind === 'enum' && !type.enumerators.length) this.error('empty-enum', `${type.name} needs at least one value.`);
    if (type.kind === 'struct' && !type.fields.length) this.error('empty-struct', `${type.name} needs at least one field.`);
    if (type.kind === 'struct') {
      for (const field of type.fields) if (field.type.id === type.id) this.error('recursive-struct', `${type.name} can't contain itself (field "${field.name}").`);
    }
    const declaration: IrDeclaration = type.kind === 'struct'
      ? { kind: 'struct', type, initial: type.fields.map((f) => this.initialExpr(f.defaultValue, f.type)) }
      : { kind: 'enum', type };
    const program: IrProgram = { className: this.doc.name, members: [], slots: [], helpers: [], imports: [], blocks: [], functions: [], start: [], declaration };
    this.importTypes(program);
    if (hasErrors(this.diagnostics)) return { diagnostics: this.diagnostics };
    return { diagnostics: this.diagnostics, program };
  }

  private languageName(id: string): string {
    return this.options.languageNames?.(id) ?? LANGUAGE_NAMES[id] ?? id;
  }

  // Types from another language's graph files, or not declared at all (docs/multi-language.md).
  private checkUserTypes(): void {
    const own = [declaredType(this.doc)?.id, this.ownClass?.id, declaredInterface(this.doc)?.id];
    const names = { graph: this.options.languageName, of: (id: string) => this.languageName(id) };
    for (const p of userTypeProblems(this.doc, own, this.resolve, this.options.registry.all(), names)) this.error(p.code, p.message, p.graphId, p.nodeId);
  }

  // Imports for every struct and enum the program mentions, from their generated files. Sets and
  // maps keyed by them aren't supported yet: their order and hashing differ between languages.
  private importTypes(program: IrProgram): void {
    const used = new Map<string, UserType>();
    const visit = (value: unknown): void => {
      if (typeof value === 'string') {
        const type = isUserTypeId(value) ? this.types(value) : undefined;
        if (type && !used.has(value)) {
          used.set(value, type);
          // A struct's fields may hold other structs and enums the generated code then refers to.
          if (type.kind === 'struct') for (const f of type.fields) visit(f.type);
          // A class's ancestors and interfaces: generated code names its members after theirs.
          if (type.kind === 'class' && type.parent) visit(type.parent);
          if (type.kind === 'class') for (const i of type.interfaces ?? []) visit(i);
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      const record = value as Record<string, unknown>;
      if ((record.container === 'set' || record.container === 'map') && typeof record.id === 'string' && isUserTypeId(record.id)) {
        this.error('unsupported-key-type', `Sets and map keys of ${record.id.slice(record.id.indexOf(':') + 1)} aren't supported yet.`);
      }
      for (const [key, item] of Object.entries(record)) if (key !== 'userType' && key !== 'source') visit(item);
    };
    const { declaration, ...rest } = program;
    visit(rest);
    if (declaration?.kind === 'struct') {
      declaration.type.fields.forEach((f) => visit(f.type));
      declaration.initial.forEach(visit);
    }
    for (const [id, type] of [...used].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if ((declaration && declaration.type.id === id) || this.ownClass?.id === id) continue;
      if (type.language && type.language !== (this.doc.language || type.language)) continue;
      const name = toIdentifier(type.name, 'pascal');
      const source = type.source;
      program.imports.push({
        id, name, language: type.language ?? this.doc.language ?? '', path: source?.generatedPath ?? '', params: [], userType: type,
        ...(source?.module ? { module: source.module } : {})
      });
    }
  }

  // A variable's or field's initial value: its stored default, else its type's default.
  private initialExpr(stored: unknown, type: TypeRef | undefined): IrExpr {
    return stored !== undefined ? this.literalOf(stored, type) : { kind: 'default', type };
  }

  // A value written on the graph (JSON) as an expression of `type`: enums are stored by their
  // value's id, structs as an object of the fields that differ from their defaults.
  private literalOf(value: unknown, type: TypeRef | undefined): IrExpr {
    if (!type) return { kind: 'literal', value };
    if (type.container) {
      const element: TypeRef = { id: type.id };
      if (!isUserTypeId(type.id) && !(type.valueType && isUserTypeId(type.valueType.id))) return { kind: 'literal', value };
      if (!Array.isArray(value)) return { kind: 'default', type };
      const items = type.container === 'map'
        ? value.flatMap((pair) => (Array.isArray(pair) && pair.length === 2 ? [this.literalOf(pair[0], element), this.literalOf(pair[1], type.valueType)] : []))
        : value.map((item) => this.literalOf(item, element));
      return { kind: 'makeContainer', type, items };
    }
    const user = this.types(type.id);
    if (user?.kind === 'enum') {
      const enumerator = user.enumerators.find((e) => e.id === value) ?? user.enumerators[0];
      return enumerator ? { kind: 'enumValue', type: user.id, value: enumerator.id } : { kind: 'default', type };
    }
    if (user?.kind === 'struct') {
      const stored = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      if (!user.fields.some((f) => stored[f.id] !== undefined)) return { kind: 'default', type };
      return { kind: 'makeStruct', type: user.id, fields: user.fields.map((f) => this.initialExpr(stored[f.id] ?? f.defaultValue, f.type)) };
    }
    return { kind: 'literal', value };
  }

  // An unconnected input's value: stored on the node, else the pin's default, else the type default.
  private unconnectedExpr(node: GraphNode, pin: PinDefinition | undefined, pinId: string): IrExpr {
    // A member of the class from the code this class extends (or of a class it extends): Self, as
    // for a graph parent's members (docs/code-classes-as-parents.md, part 2).
    if (pinId === 'target' && pin?.type && this.isCodeSelf(pin.type.id)) {
      const implementation = this.resolve(node)?.implementation;
      if (implementation?.kind === 'function' && implementation.member && implementation.member.kind !== 'construct') return { kind: 'self' };
    }
    const stored = node.properties[`pin:${pinId}`];
    if (stored !== undefined) return this.literalOf(stored, pin?.type);
    if (pin?.defaultValue !== undefined) return this.literalOf(pin.defaultValue, pin.type);
    return { kind: 'default', type: pin?.type };
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
      // As in Unreal: a function runs to its end at once, so it can't wait.
      if (info.definitions.get(node.id)?.latent) this.error('latent-in-function', `${info.definitions.get(node.id)!.displayName} belongs in event graphs: a function can't wait.`, graph.id, node.id);
      if (info.definitions.get(node.id)?.implementation?.kind === 'event' && !node.type.startsWith('core:event.')) this.error('event-in-function', 'Events belong in event graphs, not in functions.', graph.id, node.id);
    }
    const signature = graph.signature ?? { inputs: [], outputs: [] };
    const fn: IrFunction = {
      id: graph.id,
      name: graph.name,
      params: signature.inputs.filter((p) => p.kind === 'data').map((p) => ({ id: p.id, name: p.name, type: p.type })),
      outputs: signature.outputs.filter((p) => p.kind === 'data').map((p) => ({ id: p.id, name: p.name, type: p.type })),
      pure: !!signature.pure,
      ...(signature.description ? { description: signature.description } : {}),
      ...(this.ownClass && parentFunction(this.ownClass, graph.name, (t) => this.options.registry.get(t)) ? { overrides: true } : {}),
      ...(signature.access && signature.access !== 'public' ? { access: signature.access } : {}),
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

  // ---- Custom events (src/core/events.ts) ----------------------------------------------------

  private registerEvent(info: GraphInfo, node: GraphNode): IrFunction {
    const implementation = info.definitions.get(node.id)?.implementation;
    const entry = implementation?.kind === 'event' ? implementation.method : undefined;
    const name = entry ?? eventName(node);
    const clash = this.functions.find((f) => f.name === name) ?? this.doc.graphs.find((g) => g.kind === 'function' && g.name === name);
    if (clash) this.error('duplicate-event', entry ? `A class has one ${info.definitions.get(node.id)?.displayName} event.` : `There is already a function or event named "${name}".`, info.graph.id, node.id);
    // An entry event's inputs are its definition's data outputs; a custom event's, its own.
    const params = entry
      ? (info.definitions.get(node.id)?.outputs ?? []).filter((p) => p.kind === 'data').map((p) => ({ id: p.id, name: p.name, type: p.type }))
      : eventInputs(node).filter((p) => p.kind === 'data').map((p) => ({ id: p.id, name: p.name, type: p.type }));
    const fn: IrFunction = {
      id: eventFunctionId(info.graph.id, node.id),
      name,
      params,
      outputs: [],
      pure: false,
      body: [],
      event: { stores: [], ...(entry ? { entry } : {}) }
    };
    this.functions.push(fn);
    return fn;
  }

  // Test Case events: each a method of its own, which no other code calls.
  private lowerTests(eventGraphs: GraphInfo[]): IrTest[] {
    const tests: IrTest[] = [];
    for (const info of eventGraphs) {
      for (const node of info.graph.nodes.filter((n) => n.type === TEST_CASE)) {
        const name = testName(node);
        if (tests.some((t) => t.name === name)) this.error('duplicate-test', `There is already a test named "${name}".`, info.graph.id, node.id);
        tests.push({ id: eventFunctionId(info.graph.id, node.id), name, body: this.lowerNode(info, node.id) });
      }
    }
    return tests;
  }

  private lowerEvent(info: GraphInfo, node: GraphNode, fn: IrFunction): void {
    this.currentEvent = fn.id;
    try {
      fn.body = this.lowerNode(info, node.id);
    } finally {
      this.currentEvent = undefined;
    }
  }

  // The custom event wired into a Bind or Unbind node's Event pin (through reroutes).
  private wiredEvent(info: GraphInfo, node: GraphNode): string | undefined {
    let source = info.dataSources.get(inputKey(node.id, 'event'));
    const seen = new Set<string>();
    while (source && !seen.has(source.node)) {
      seen.add(source.node);
      const from = info.nodes.get(source.node);
      if (from?.type === CUSTOM_EVENT && source.pin === DELEGATE_PIN) return eventFunctionId(info.graph.id, from.id);
      if (from?.type !== REROUTE) break;
      source = info.dataSources.get(inputKey(from.id, 'in'));
    }
    this.error('event-unwired', "Wire a Custom Event's red pin into Event.", info.graph.id, node.id);
    return undefined;
  }

  // ---- Objects (src/core/objects.ts) ---------------------------------------------------------

  // The interface an interface call uses, or an error.
  private callInterface(info: GraphInfo, node: GraphNode): InterfaceInfo | undefined {
    const iface = typeof node.properties.interface === 'string' ? interfaceById(node.properties.interface, (t) => this.options.registry.get(t)) : undefined;
    if (!iface) this.error('interface-missing', `There is no interface ${String(node.properties.interface ?? '').replace(/^interface:/, '')} in the workspace.`, info.graph.id, node.id);
    return iface;
  }

  // An interface call's Target: wired, else Self when this class implements the interface.
  private interfaceTarget(info: GraphInfo, node: GraphNode, def: NodeDefinition, iface: InterfaceInfo): IrExpr {
    if (info.dataSources.has(inputKey(node.id, 'target'))) return this.inputExpr(info, node, def, 'target');
    if (this.ownClass && implementedInterfaces(this.ownClass, (t) => this.options.registry.get(t)).includes(iface.id)) return { kind: 'self' };
    this.error('target-missing', `Connect an object that implements ${iface.name} to Target.`, info.graph.id, node.id);
    return { kind: 'default', type: { id: iface.id } };
  }

  // A protected member is for its class and subclasses, a private one for its class alone.
  private checkAccess(info: GraphInfo, node: GraphNode, type: ClassInfo): void {
    const member = node.properties.variable !== undefined ? type.variables.find((v) => v.id === node.properties.variable)
      : node.properties.function !== undefined ? type.functions.find((f) => f.id === node.properties.function) : undefined;
    if (member && !canAccess(member.access, type.id, this.ownClass, (t) => this.options.registry.get(t))) {
      this.error('member-access', `"${member.name}" is ${member.access} to ${type.name}${member.access === 'protected' ? ' and its subclasses' : ''}.`, info.graph.id, node.id);
    }
  }

  // The class a member node uses, or an error.
  private memberClass(info: GraphInfo, node: GraphNode): ClassInfo | undefined {
    const type = nodeClass(node, this.ownClass, (t) => this.options.registry.get(t));
    if (!type) this.error('class-missing', `There is no class ${String(node.properties.class ?? '').replace(/^object:/, '')} in the workspace.`, info.graph.id, node.id);
    return type;
  }

  // Whether this object is a `type` from the code: its code parent, or a class that one extends.
  private isCodeSelf(type: string): boolean {
    if (!this.ownClass || !type.startsWith('native:')) return false;
    const code = codeParentOf(this.ownClass, (t) => this.options.registry.get(t));
    if (!code) return false;
    if (code.type === type) return true;
    const bases = codeClassBases(this.options.registry.all());
    const seen = new Set<string>();
    for (let base = bases.get(code.type); base && !seen.has(base); base = bases.get(base)) {
      if (base === type) return true;
      seen.add(base);
    }
    return false;
  }

  // Whether a member of `type` is this object's own (its class's or an ancestor's).
  private isOwn(type: ClassInfo): boolean {
    return type.id === this.ownClass?.id || this.ancestors.some((a) => a.id === type.id);
  }

  // The interfaces the class declares itself (those its ancestors implement are theirs already), each
  // with the functions neither it nor an ancestor gives a body; and every interface it implements.
  private interfacePlan(): Pick<IrProgram, 'interfaces' | 'allInterfaces'> {
    const own = this.ownClass;
    if (!own) return {};
    const definition = (t: string) => this.options.registry.get(t);
    const inherited = new Set(this.ancestors.flatMap((a) => implementedInterfaces(a, definition)));
    const bodies = new Set([own, ...this.ancestors].flatMap((c) => c.functions.map((f) => f.name)));
    const all = implementedInterfaces(own, definition).map((id) => interfaceById(id, definition)).filter((i): i is InterfaceInfo => !!i);
    const mine = all.filter((i) => (own.interfaces ?? []).includes(i.id) && !inherited.has(i.id));
    return {
      ...(mine.length ? { interfaces: mine.map((type) => ({ type, stubs: type.functions.filter((f) => !bodies.has(f.name)) })) } : {}),
      ...(all.length ? { allInterfaces: all } : {})
    };
  }

  // A class from the code as the parent: it must be there, marked to be extended, and in the graph's
  // language. (Generated code for it comes with docs/code-classes-as-parents.md, steps 4 to 6.)
  private checkCodeParent(id: string): void {
    const code = codeClassById(id, (t) => this.options.registry.get(t));
    const [, language, rest] = /^code:([^:]+):(.*)$/.exec(id) ?? [];
    const [path, name] = (rest ?? '').split('#');
    if (!code) {
      this.error('parent-missing', `There is no class ${name} in ${path} to inherit from: it isn't there, or isn't marked @blueprint (or has no marked members).`);
      return;
    }
    if (!this.options.importLanguages.includes(language)) {
      this.error('wrong-language', `${code.title} is a ${this.languageName(language)} class (${code.path}); a ${this.options.languageName} graph can't extend it.`);
      return;
    }
    this.checkOverrides(code);
    this.error('code-parent-unsupported', `Generated code can't extend a class from your code (${code.title}) in ${this.options.languageName} yet.`);
  }

  // What this class overrides of its code parent: functions with the method's name and signature,
  // events for methods returning nothing, each method once; abstract methods left say so.
  private checkOverrides(code: CodeClassInfo): void {
    const own = this.ownClass!;
    const definition = (t: string) => this.options.registry.get(t);
    const signature = (pins: { kind: string; type?: TypeRef }[]) => JSON.stringify(pins.filter((p) => p.kind === 'data').map((p) => p.type?.id ?? 'any'));
    const functions = new Map(this.doc.graphs.filter((g) => g.kind === 'function').map((g) => [g.name, g]));
    for (const method of code.overridable) {
      const fn = functions.get(method.name);
      if (fn && (signature(fn.signature?.inputs ?? []) !== signature(method.inputs) || signature(fn.signature?.outputs ?? []) !== signature(method.outputs) || fn.signature?.pure)) {
        this.error('override-mismatch', `"${method.name}" overrides ${code.title}'s method, so it needs the same inputs and outputs, and isn't pure.`, fn.id);
      }
    }
    const events = new Map<string, number>();
    for (const graph of this.doc.graphs.filter((g) => g.kind === 'event')) {
      for (const node of graph.nodes.filter((n) => n.type === OVERRIDE_EVENT)) {
        const name = String(node.properties.method ?? '');
        const method = code.overridable.find((m) => m.name === name);
        events.set(name, (events.get(name) ?? 0) + 1);
        if (!method) this.error('override-missing', `${code.title} has no method "${name}" to override (it isn't there, or isn't marked overridable).`, graph.id, node.id);
        else if (method.outputs.length) this.error('override-returns', `${name} returns a value: override it as a function, from My Blueprint's Override.`, graph.id, node.id);
        else if (events.get(name) === 2 || functions.has(name)) this.error('override-duplicate', `${name} is overridden twice: keep one event or function for it.`, graph.id, node.id);
      }
    }
    const left = abstractLeft(own, definition);
    if (left.length) this.warning('abstract-left', `${own.name} doesn't override ${list(left)}, abstract in ${code.title}, so it can't be constructed yet; a class extending it can override them.`);
  }

  // The parent class must exist and not loop; a subclass's members must not take its ancestors'
  // names, except functions that override with the same signature.
  private checkInheritance(): void {
    const own = this.ownClass;
    // Interfaces: each must exist, and a function named like one of theirs implements it, so it
    // keeps its signature.
    const definition = (t: string) => this.options.registry.get(t);
    const signatureOf = (pins: { kind: string; type?: TypeRef }[]) => JSON.stringify(pins.filter((p) => p.kind === 'data').map((p) => p.type?.id ?? 'any'));
    for (const id of own?.interfaces ?? []) {
      const iface = interfaceById(id, definition);
      if (!iface) {
        this.error('interface-missing', `There is no interface ${id.replace(/^interface:/, '')} in the workspace.`);
        continue;
      }
      for (const fn of own!.functions) {
        const declared = iface.functions.find((f) => f.name === fn.name);
        if (declared && (signatureOf(declared.inputs) !== signatureOf(fn.inputs) || signatureOf(declared.outputs) !== signatureOf(fn.outputs) || declared.pure !== fn.pure)) {
          this.error('interface-mismatch', `"${fn.name}" implements ${iface.name}'s function, so it needs the same inputs, outputs and Pure setting.`, fn.id);
        }
      }
    }
    if (!own?.parent) return;
    const parentName = own.parent.replace(/^object:/, '').replace(/^code:.*#/, '');
    // A class from the project's code at the top of the chain (docs/code-classes-as-parents.md).
    const top = (this.ancestors[this.ancestors.length - 1] ?? own).parent;
    if (top?.startsWith(CODE_CLASS_PREFIX)) {
      this.checkCodeParent(top);
      if (top === own.parent) return;
    }
    if (!this.ancestors.length) {
      this.error('parent-missing', `There is no class ${parentName} in the workspace to inherit from.`);
      return;
    }
    // ancestors() stops where the chain loops back: the last one's parent is already in it.
    const last = this.ancestors[this.ancestors.length - 1].parent;
    if (last && (last === own.id || this.ancestors.some((a) => a.id === last))) this.error('parent-loop', `${own.name} can't inherit from itself, directly or through ${parentName}.`);
    const inherited = this.ancestors.flatMap((a) => [...a.variables.map((v) => v.name), ...a.events.map((e) => e.name), ...a.dispatchers.map((d) => d.name)]);
    for (const name of [...own.variables.map((v) => v.name), ...own.events.map((e) => e.name), ...own.dispatchers.map((d) => d.name)]) {
      if (inherited.includes(name)) this.error('inherited-name', `${parentName} already has a member named "${name}".`);
    }
    const signature = (pins: { kind: string; type?: TypeRef }[]) => JSON.stringify(pins.filter((p) => p.kind === 'data').map((p) => p.type?.id ?? 'any'));
    for (const fn of own.functions) {
      const base = parentFunction(own, fn.name, (t) => this.options.registry.get(t));
      if (base && (signature(base.inputs) !== signature(fn.inputs) || signature(base.outputs) !== signature(fn.outputs) || base.pure !== fn.pure)) {
        this.error('override-mismatch', `"${fn.name}" overrides ${base.owner.name}'s function, so it needs the same inputs, outputs and Pure setting.`, fn.id);
      }
    }
  }

  // The object a member node acts on: its Target pin, else (for its own class) Self.
  private targetExpr(info: GraphInfo, node: GraphNode, def: NodeDefinition, type: ClassInfo): IrExpr {
    if (info.dataSources.has(inputKey(node.id, 'target'))) return this.inputExpr(info, node, def, 'target');
    if (this.isOwn(type)) return { kind: 'self' };
    this.error('target-missing', `Connect a ${type.name} to Target.`, info.graph.id, node.id);
    return { kind: 'default', type: { id: type.id } };
  }

  private lowerObjectNode(info: GraphInfo, node: GraphNode, def: NodeDefinition, next: (out: string) => IrStatement[], input: (pinId: string) => IrExpr, source: SourceRef): IrStatement[] | undefined {
    const operation = nativeOperation(def);
    const implementation = def.implementation;
    if (implementation?.kind === 'class' && implementation.operation === 'construct') {
      const slot = this.slot(info, node, def, 'object');
      const definition = (t: string) => this.options.registry.get(t);
      // A class whose code parent's abstract methods aren't all overridden can't be made.
      const own = implementation.type.id === this.ownClass?.id ? this.ownClass : implementation.type;
      const left = abstractLeft(own, definition);
      if (left.length) this.error('construct-abstract', `${implementation.type.name} can't be constructed: it doesn't override ${list(left)}, abstract in ${codeParentOf(own, definition)!.title}.`, info.graph.id, node.id);
      const args = dataInputs(def).map((p) => input(p.id));
      return [{ kind: 'construct', type: implementation.type.id, slot, ...(args.length ? { args } : {}), source }, ...next('execOut')];
    }
    if (implementation?.kind === 'interface' || (implementation?.kind === 'class' && implementation.operation === 'cast')) {
      const slot = this.slot(info, node, def, 'as');
      return [{ kind: 'cast', value: input('object'), type: implementation.type.id, slot, succeeded: next('succeeded'), failed: next('failed'), source }];
    }
    if (operation === 'interface-call') {
      const iface = this.callInterface(info, node);
      if (!iface) return next('execOut');
      const results = def.outputs.filter((p) => p.kind === 'data').map((p) => ({ output: p.id, slot: this.slot(info, node, def, p.id) }));
      return [{ kind: 'interfaceCall', target: this.interfaceTarget(info, node, def, iface), type: iface.id, function: String(node.properties.function), args: dataInputs(def).filter((p) => p.id !== 'target').map((p) => input(p.id)), results, source }, ...next('execOut')];
    }
    if (operation === 'parent-call') {
      const name = String(node.properties.function ?? PARENT_START);
      if (!this.ownClass?.parent) {
        this.error('parent-missing', 'Only a class with a parent class can call its parent.', info.graph.id, node.id);
        return next('execOut');
      }
      const definition = (t: string) => this.options.registry.get(t);
      if (name === PARENT_START) {
        // Start is a graph class's: a class straight from the code has none.
        if (!this.ancestors.length) {
          this.error('parent-missing', "The parent class is your code's, which has no Start to call.", info.graph.id, node.id);
          return next('execOut');
        }
        return [{ kind: 'parentCall', start: true, args: [], results: [], source }, ...next('execOut')];
      }
      if (!parentFunction(this.ownClass, name, definition)) {
        // The code's version of a method this class overrides (docs/code-classes-as-parents.md).
        const method = codeParentMethod(this.ownClass, name, definition);
        if (!method) {
          this.error('parent-missing', `The parent class has no function "${name}".`, info.graph.id, node.id);
          return next('execOut');
        }
        if (method.abstract) {
          this.error('parent-abstract', `${name} is abstract in ${method.owner.title}: the code has no version of it to call.`, info.graph.id, node.id);
          return next('execOut');
        }
      }
      const results = def.outputs.filter((p) => p.kind === 'data').map((p) => ({ output: p.id, slot: this.slot(info, node, def, p.id) }));
      return [{ kind: 'parentCall', function: name, args: dataInputs(def).map((p) => input(p.id)), results, source }, ...next('execOut')];
    }
    if (!['object-set', 'object-call', 'object-event', 'object-dispatcher'].includes(operation)) return undefined;
    const type = this.memberClass(info, node);
    if (!type) return next('execOut');
    this.checkAccess(info, node, type);
    const target = this.targetExpr(info, node, def, type);
    const args = dataInputs(def).filter((p) => p.id !== 'target' && p.id !== 'event').map((p) => input(p.id));
    switch (operation) {
      case 'object-set':
        return [{ kind: 'setObjectVariable', target, type: type.id, variable: String(node.properties.variable), value: input('value'), source }, ...next('execOut')];
      case 'object-call': {
        const results = def.outputs.filter((p) => p.kind === 'data').map((p) => ({ output: p.id, slot: this.slot(info, node, def, p.id) }));
        return [{ kind: 'objectCall', target, type: type.id, function: String(node.properties.function), args, results, source }, ...next('execOut')];
      }
      case 'object-event':
        return [{ kind: 'objectCall', target, type: type.id, event: String(node.properties.event), args, results: [], source }, ...next('execOut')];
      default: {
        const dispatcher = String(node.properties.dispatcher);
        const action = dispatcherAction(node);
        if (action === 'call') return [{ kind: 'broadcast', dispatcher, args, target, type: type.id, source }, ...next('execOut')];
        if (action === 'unbind-all') return [{ kind: 'unbindAll', dispatcher, target, type: type.id, source }, ...next('execOut')];
        const event = this.wiredEvent(info, node);
        return [...(event ? [{ kind: 'bindEvent' as const, dispatcher, event, bind: action === 'bind', target, type: type.id, source }] : []), ...next('execOut')];
      }
    }
  }

  // ---- Validation ----------------------------------------------------------------------------

  // A graph with the macros it uses expanded in place (src/core/macros.ts), and its split struct pins
  // turned into Make and Break nodes (src/core/user-types.ts).
  private analyzeExpanded(graph: Graph): GraphInfo {
    // A deprecated macro's instances are gone once expanded, so they warn here.
    for (const node of graph.nodes) {
      const def = node.type === MACRO_INSTANCE || node.type.startsWith('macro:') ? this.resolve(node) : undefined;
      if (def?.deprecated) this.warning('deprecated', deprecationMessage(def), graph.id, node.id);
    }
    const expansion = expandMacros(graph, this.macros);
    for (const problem of expansion.problems) this.error('macro-invalid', problem.message, graph.id, problem.nodeId);
    for (const [id, name] of expansion.macros) this.macroNames.set(JSON.stringify([graph.id, id]), name);
    const expanded = expandSplitPins(expansion.graph, createUnsplitResolver(this.options.registry, this.doc), (type) => this.options.registry.get(type));
    // The wires of an instance that couldn't be expanded aren't checked: the instance is reported.
    const unexpanded = new Set(expansion.problems.map((p) => p.nodeId).filter((id) => expanded.nodes.some((n) => n.id === id)));
    this.quietInner = true;
    try {
      return this.analyze(expanded, unexpanded);
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
      this.checkLibrary(graph, node);
      if (typeof node.properties.class === 'string' && isObjectNode(node.type)) this.memberClass({ graph } as GraphInfo, node);
      if (typeof node.properties.interface === 'string' && isObjectNode(node.type)) this.callInterface({ graph } as GraphInfo, node);
      if ((node.type === MACRO_INPUTS || node.type === MACRO_OUTPUTS) && graph.kind !== 'macro') {
        this.error('tunnel-outside-macro', 'Inputs and Outputs nodes belong in macro graphs.', graph.id, node.id);
      }
      const def = this.resolve(node);
      if (def) info.definitions.set(node.id, def);
      // A missing macro library is reported where the macro is expanded.
      else if (!isFunctionType(node.type) && !node.type.startsWith('macro:')) this.error('unknown-node-type', `Unknown node type "${node.type}". Its node library may be missing.`, graph.id, node.id);
      // As in Unreal, a deprecated node still compiles, with a warning.
      if (def?.deprecated) this.warning('deprecated', deprecationMessage(def), graph.id, node.id);
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

  // A node of a package that changed major version since the graph recorded it: it still compiles,
  // with a warning until it is refreshed (docs/language-breadth.md, "Node library versioning").
  private checkLibrary(graph: Graph, node: GraphNode): void {
    const change = libraryChange(this.doc, this.options.registry.get(node.type));
    if (change) this.warning('library-changed', libraryChangeMessage(change), graph.id, node.id);
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
  // continue, so they can't close a loop; nor does a Delay's Completed, which runs later (a timer
  // loop, as in Unreal). Reports each loop once.
  private checkExecCycles(info: GraphInfo): void {
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (nodeId: string): void => {
      state.set(nodeId, 'visiting');
      const latent = !!info.definitions.get(nodeId)?.latent;
      for (const [pin, targets] of info.execTargets.get(nodeId) ?? []) {
        if (latent && pin === 'completed') continue;
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
        const event = this.currentEvent;
        this.currentEvent = undefined;
        try {
          block.body = this.lowerNode(info, nodeId, pin, key);
        } finally {
          this.currentEvent = event;
        }
      }
      return [{ kind: 'callBlock', block: key, source }];
    }

    const next = (out: string): IrStatement[] => (info.execTargets.get(nodeId)?.get(out) ?? []).flatMap((target) => this.lowerNode(info, target.node, target.pin));
    const input = (pinId: string): IrExpr => this.inputExpr(info, node, def, pinId);
    const flowStatements = this.lowerFlowControl(info, node, def, pin, next, input, source);
    if (flowStatements) return flowStatements;

    switch (nativeOperation(def)) {
      case 'start':
      case 'test-case':
        return next('execOut');
      case 'assert-true': {
        const message = input('message');
        const text: IrExpr = message.kind === 'literal'
          ? { kind: 'literal', value: assertTrueMessage(String(message.value ?? '')) }
          : { kind: 'concat', parts: [{ kind: 'literal', value: 'Assert failed: ' }, { kind: 'toText', value: message }] };
        return [{ kind: 'assert', condition: { kind: 'toBoolean', value: input('condition') }, message: text, source }, ...next('execOut')];
      }
      case 'assert-equal': {
        const actual = input('actual');
        const expected = input('expected');
        const message = input('message');
        const [before, between] = assertEqualMessage('\u0000', '\u0001', '').split(/\u0001|\u0000/);
        const note: IrExpr[] = message.kind === 'literal'
          ? (message.value ? [{ kind: 'literal', value: `: ${String(message.value)}` }] : [])
          : [{ kind: 'literal', value: ': ' }, { kind: 'toText', value: message }];
        const text: IrExpr = { kind: 'concat', parts: [{ kind: 'literal', value: before }, { kind: 'toText', value: expected }, { kind: 'literal', value: between }, { kind: 'toText', value: actual }, ...note] };
        // Two unconnected inputs are compared here, not in the generated code, where type checkers
        // reject comparing two constants (TypeScript's TS2367, mypy's strict equality).
        if (actual.kind === 'literal' && expected.kind === 'literal') {
          if (actual.value === expected.value) return next('execOut');
          return [{ kind: 'assert', condition: { kind: 'literal', value: false }, message: text, source }, ...next('execOut')];
        }
        return [{ kind: 'assert', condition: { kind: 'binary', op: '==', left: actual, right: expected }, message: text, source }, ...next('execOut')];
      }
      case 'add':
        return [
          { kind: 'store', slot: this.slot(info, node, def, 'result'), value: { kind: 'add', left: { kind: 'toNumber', value: input('a') }, right: { kind: 'toNumber', value: input('b') } }, source },
          ...next('execOut')
        ];
      case 'print': {
        const value = input('value');
        this.checkPrintable(info, nodeId, value);
        return [{ kind: 'print', value, source }, ...next('execOut')];
      }
      case 'branch': {
        // An unconnected condition picks its side here: the other can't run, and type checkers
        // reject it as unreachable (TypeScript's allowUnreachableCode: false).
        const condition = input('condition');
        if (condition.kind === 'literal') return next(condition.value ? 'true' : 'false');
        return [{ kind: 'if', condition: { kind: 'toBoolean', value: condition }, then: next('true'), else: next('false'), source }];
      }
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
      case 'custom-event':
        return next('execOut');
      case 'delay':
      case 'retriggerable-delay': {
        const retriggerable = nativeOperation(def) === 'retriggerable-delay';
        const pending = retriggerable ? undefined : this.stateSlot(info, node, def, 'pending', 'bool');
        const generation = retriggerable ? this.stateSlot(info, node, def, 'generation', 'int') : undefined;
        // The chain after Completed runs later, from no event's method: an event's inputs are read
        // as they are then (their latest values), as Unreal reads an event node's outputs.
        const event = this.currentEvent;
        this.currentEvent = undefined;
        let then: IrStatement[];
        try {
          then = next('completed');
        } finally {
          this.currentEvent = event;
        }
        return [{ kind: 'delay', duration: { kind: 'toNumber', value: input('duration') }, ...(pending ? { pending } : {}), ...(generation ? { generation } : {}), then, source }];
      }
      case 'call-event': {
        const target = calledEvent(node, this.doc.graphs);
        if (!target) {
          this.error('event-missing', `There is no custom event named "${String(node.properties.event ?? '')}".`, info.graph.id, nodeId);
          return next('execOut');
        }
        return [{ kind: 'callFunction', function: eventFunctionId(target.graph.id, target.node.id), args: dataInputs(def).map((p) => input(p.id)), results: [], source }, ...next('execOut')];
      }
      case 'call-dispatcher':
      case 'bind-event':
      case 'unbind-event':
      case 'unbind-all': {
        const dispatcher = boundDispatcher(node, documentDispatchers(this.doc));
        if (!dispatcher) {
          this.error('dispatcher-missing', 'This node uses an event dispatcher that no longer exists.', info.graph.id, nodeId);
          return next('execOut');
        }
        const operation = nativeOperation(def);
        if (operation === 'call-dispatcher') return [{ kind: 'broadcast', dispatcher: dispatcher.id, args: dataInputs(def).map((p) => input(p.id)), source }, ...next('execOut')];
        if (operation === 'unbind-all') return [{ kind: 'unbindAll', dispatcher: dispatcher.id, source }, ...next('execOut')];
        const event = this.wiredEvent(info, node);
        return [...(event ? [{ kind: 'bindEvent' as const, dispatcher: dispatcher.id, event, bind: operation === 'bind-event', source }] : []), ...next('execOut')];
      }
      // Expanded away, or reported: a macro that can't be expanded, a tunnel outside a macro.
      case 'macro-instance':
      case 'macro-inputs':
      case 'macro-outputs':
        return [];
    }

    const objectStatements = this.lowerObjectNode(info, node, def, next, input, source);
    if (objectStatements) return objectStatements;
    const user = def.implementation;
    if (user?.kind === 'struct' && user.operation === 'set-members') {
      // The struct with the chosen fields changed; one read from a variable is written back to it.
      const result = this.slot(info, node, def, 'result');
      const wire = info.dataSources.get(inputKey(nodeId, 'struct'));
      const sourceNode = wire && info.nodes.get(wire.node);
      const sourceDef = wire && info.definitions.get(wire.node);
      const member = sourceNode && sourceDef && nativeOperation(sourceDef) === 'get-variable' ? this.variableMember(info, sourceNode, sourceDef) : undefined;
      const current: IrExpr = member ? { kind: 'member', member: member.id } : { kind: 'output', slot: result };
      const changed = new Set(dataInputs(def).map((p) => p.id).filter((id) => id !== 'struct'));
      const value: IrExpr = { kind: 'makeStruct', type: user.type.id, fields: user.type.fields.map((f) => (changed.has(f.id) ? input(f.id) : { kind: 'structField', value: current, type: user.type.id, field: f.id })) };
      const statements: IrStatement[] = member
        ? [{ kind: 'setMember', member: member.id, value, source }, { kind: 'store', slot: result, value: current, source }]
        : [{ kind: 'store', slot: result, value: input('struct'), source }, { kind: 'store', slot: result, value, source }];
      return [...statements, ...next('execOut')];
    }
    if (user?.kind === 'enum' && user.operation === 'switch') {
      // An unconnected selection picks its output here, as Branch's condition does.
      const chosen = input('selection');
      if (chosen.kind === 'literal') return next(user.type.enumerators.find((e) => e.id === chosen.value)?.id ?? user.type.enumerators[0]?.id ?? '');
      const selection = this.stateSlot(info, node, def, 'selection', user.type.id);
      const read: IrExpr = { kind: 'output', slot: selection };
      // Values with nothing wired to their output need no test.
      const chain = user.type.enumerators.reduceRight<IrStatement[]>((otherwise, e) => {
        const then = next(e.id);
        return then.length ? [{ kind: 'if', condition: { kind: 'binary', op: '==', left: read, right: { kind: 'enumValue', type: user.type.id, value: e.id } }, then, else: otherwise, source }] : otherwise;
      }, []);
      return [{ kind: 'store', slot: selection, value: input('selection'), source }, ...chain];
    }

    // An entry event (Main, a framework's event): its method runs the chain after it.
    if (def.implementation?.kind === 'event') return next('execOut');
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
    // An async function: Completed runs when it finishes, from no event's method, as a Delay's does.
    if (def.latent) {
      const event = this.currentEvent;
      this.currentEvent = undefined;
      let then: IrStatement[];
      try {
        then = next('completed');
      } finally {
        this.currentEvent = event;
      }
      return [{ kind: 'await', callee, args, ...(output ? { resultSlot: this.slot(info, node, def, output.id) } : {}), then, source }];
    }
    // ExpandBoolAsExecs: the result picks True or False.
    const execs = def.implementation?.kind === 'function' ? def.implementation.execs : undefined;
    if (execs === 'bool') {
      const result = this.stateSlot(info, node, def, 'result', 'bool');
      return [{ kind: 'call', callee, args, resultSlot: result, source }, { kind: 'if', condition: { kind: 'output', slot: result }, then: next('true'), else: next('false'), source }];
    }
    // ExpandEnumAsExecs: the result picks the output of its value, as Switch on an enum does.
    if (typeof execs === 'object') {
      const result = this.stateSlot(info, node, def, 'result', execs.enum);
      const read: IrExpr = { kind: 'output', slot: result };
      const chain = def.outputs.filter((p) => p.kind === 'exec').reduceRight<IrStatement[]>((otherwise, pin) => {
        const then = next(pin.id);
        return then.length ? [{ kind: 'if', condition: { kind: 'binary', op: '==', left: read, right: { kind: 'enumValue', type: execs.enum, value: pin.id } }, then, else: otherwise, source }] : otherwise;
      }, []);
      return [{ kind: 'call', callee, args, resultSlot: result, source }, ...chain];
    }
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

  // An input's value. The debugger can read the input, and the output feeding it, where the value
  // is only read from storage.
  private inputExpr(info: GraphInfo, node: GraphNode, def: NodeDefinition, pinId: string): IrExpr {
    const value = this.readInput(info, node, def, pinId);
    if (readsStorageOnly(value)) {
      this.debugPin(info.graph.id, node.id, pinId, value);
      const source = info.dataSources.get(inputKey(node.id, pinId));
      if (source) this.debugPin(info.graph.id, source.node, source.pin, value);
    }
    return value;
  }

  private debugPin(graphId: string, nodeId: string, pinId: string, value: IrExpr): void {
    // Nodes copied from a macro, or standing in for a split pin, aren't on screen.
    if (visibleNodeId(nodeId) !== nodeId) return;
    const key = JSON.stringify([graphId, nodeId, pinId]);
    if (!this.pinValues.has(key)) this.pinValues.set(key, { graphId, nodeId, pinId, value });
  }

  // Every impure node's stored outputs, and the pins read from storage.
  private debugPins(): IrPinValue[] {
    for (const slot of this.slots.values()) {
      const [graphId, nodeId, pinId] = JSON.parse(slot.id) as string[];
      if (!pinId.startsWith('state:')) this.debugPin(graphId, nodeId, pinId, { kind: 'output', slot: slot.id });
    }
    return [...this.pinValues.values()];
  }

  private readInput(info: GraphInfo, node: GraphNode, def: NodeDefinition, pinId: string): IrExpr {
    const pin = def.inputs.find((p) => p.id === pinId);
    const source = info.dataSources.get(inputKey(node.id, pinId));
    if (!source) return this.unconnectedExpr(node, pin, pinId);

    const sourceNode = info.nodes.get(source.node);
    const sourceDef = info.definitions.get(source.node);
    if (!sourceNode || !sourceDef) return { kind: 'default', type: pin?.type };
    // Get is pure, and Set's output is the variable's new value: both read the member where used.
    const operation = nativeOperation(sourceDef);
    // Pure conversions are inlined where their value is used.
    if (operation === 'to-string') {
      const value = this.inputExpr(info, sourceNode, sourceDef, 'value');
      this.checkPrintable(info, sourceNode.id, value);
      return { kind: 'toText', value };
    }
    if (operation === 'self') return { kind: 'self' };
    if (operation === 'interface-call' && isPure(sourceDef)) {
      const iface = this.callInterface(info, sourceNode);
      if (!iface) return { kind: 'default', type: pin?.type };
      return {
        kind: 'interfaceCall', target: this.interfaceTarget(info, sourceNode, sourceDef, iface), type: iface.id, function: String(sourceNode.properties.function),
        args: dataInputs(sourceDef).filter((p) => p.id !== 'target').map((p) => this.inputExpr(info, sourceNode, sourceDef, p.id)),
        ...(sourceDef.outputs.filter((p) => p.kind === 'data').length > 1 ? { output: source.pin } : {})
      };
    }
    // A pure parent function: called where its value is used.
    if (operation === 'parent-call' && isPure(sourceDef)) {
      return {
        kind: 'parentCall', function: String(sourceNode.properties.function), args: dataInputs(sourceDef).map((p) => this.inputExpr(info, sourceNode, sourceDef, p.id)),
        ...(sourceDef.outputs.filter((p) => p.kind === 'data').length > 1 ? { output: source.pin } : {})
      };
    }
    if (operation === 'is-valid') return { kind: 'isValid', value: this.inputExpr(info, sourceNode, sourceDef, 'object') };
    if (operation === 'object-get' || operation === 'object-set' || (operation === 'object-call' && isPure(sourceDef))) {
      const type = this.memberClass(info, sourceNode);
      if (!type) return { kind: 'default', type: pin?.type };
      this.checkAccess(info, sourceNode, type);
      const target = this.targetExpr(info, sourceNode, sourceDef, type);
      if (operation !== 'object-call') return { kind: 'objectVariable', target, type: type.id, variable: String(sourceNode.properties.variable) };
      return this.follow(info, sourceNode, 'Pure nodes are wired in a loop.', pin, () => ({
        kind: 'objectCall', target, type: type.id, function: String(sourceNode.properties.function),
        args: dataInputs(sourceDef).filter((p) => p.id !== 'target').map((p) => this.inputExpr(info, sourceNode, sourceDef, p.id)),
        ...(sourceDef.outputs.filter((p) => p.kind === 'data').length > 1 ? { output: source.pin } : {})
      }));
    }
    // Make Array/Set/Map is pure: a new container wherever its value is used, as in Unreal.
    if (operation === 'make-array' || operation === 'make-set' || operation === 'make-map') {
      const type = sourceDef.outputs[0]?.type ?? { id: 'any', container: 'array' };
      return this.follow(info, sourceNode, 'Pure nodes are wired in a loop.', pin, () => ({
        kind: 'makeContainer', type, items: sourceDef.inputs.filter((p) => p.kind === 'data').map((p) => this.inputExpr(info, sourceNode, sourceDef, p.id))
      }));
    }
    const user = sourceDef.implementation;
    if (user?.kind === 'struct' && user.operation === 'make') {
      return this.follow(info, sourceNode, 'Pure nodes are wired in a loop.', pin, () => ({
        kind: 'makeStruct', type: user.type.id, fields: user.type.fields.map((f) => this.inputExpr(info, sourceNode, sourceDef, f.id))
      }));
    }
    if (user?.kind === 'struct' && user.operation === 'break') {
      return this.follow(info, sourceNode, 'Pure nodes are wired in a loop.', pin, () => ({
        kind: 'structField', value: this.inputExpr(info, sourceNode, sourceDef, 'struct'), type: user.type.id, field: source.pin
      }));
    }
    if (user?.kind === 'enum' && (user.operation === 'equal' || user.operation === 'not-equal')) {
      return this.follow(info, sourceNode, 'Pure nodes are wired in a loop.', pin, () => ({
        kind: 'binary', op: user.operation === 'equal' ? '==' : '!=', left: this.inputExpr(info, sourceNode, sourceDef, 'a'), right: this.inputExpr(info, sourceNode, sourceDef, 'b')
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
    // A custom event's inputs: its method's parameters inside its own flow; elsewhere, the values
    // it last ran with, which its method keeps in slots.
    if (operation === 'custom-event' || sourceDef.implementation?.kind === 'event') {
      const event = eventFunctionId(info.graph.id, sourceNode.id);
      if (source.pin === DELEGATE_PIN) return { kind: 'default', type: pin?.type };
      if (this.currentEvent === event) return { kind: 'param', function: event, id: source.pin };
      const slot = this.slot(info, sourceNode, sourceDef, source.pin);
      const stores = this.functions.find((f) => f.id === event)?.event?.stores;
      if (stores && !stores.some((s) => s.param === source.pin)) stores.push({ param: source.pin, slot });
      return { kind: 'output', slot };
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

    // An int input compared as it is: a float wired into it is truncated first, through an int slot
    // (docs/semantics.md, "Values").
    const asInt = (value: IrExpr, name: string): [IrStatement[], IrExpr] => {
      const type = exprType(value, this.programView());
      if (type?.id !== 'float' || type.container) return [[], value];
      const slot = state(name, 'int');
      return [[store(slot, value)], read(slot)];
    };

    // A loop's Break only when something is wired to it: else its stop flag is never set, and
    // checkers report the condition that reads it as always true.
    const breakWired = info.graph.connections.some((c) => c.toNode === node.id && c.toPin === 'break');
    switch (nativeOperation(def)) {
      case 'for-loop': {
        const stop = def.inputs.some((p) => p.id === 'break') && breakWired ? state('stop', 'bool') : undefined;
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
        const stop = def.inputs.some((p) => p.id === 'break') && breakWired ? state('stop', 'bool') : undefined;
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
        const [readN, n] = asInt(input('n'), 'n');
        return [...readN, when({ kind: 'binary', op: '<', left: read(counter), right: n }, [
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
        // An unconnected Start Index or Loop is decided here, as Branch's condition is.
        const start = input('startIndex');
        const [readStart, startIndex] = asInt(start, 'startIndex');
        const first = start.kind === 'literal'
          ? (Math.trunc(toNumber(start.value)) >= 0 ? [store(position, int(Math.trunc(toNumber(start.value))))] : [])
          : [...readStart, when({ kind: 'binary', op: '>=', left: startIndex, right: int(0) }, [store(position, startIndex)])];
        const loop = truthy(input('loop'));
        const wrapped: IrExpr = { kind: 'binary', op: '>=', left: read(position), right: int(outputs.length) };
        const restart = loop.kind === 'literal'
          ? (loop.value ? [when(wrapped, [store(position, int(0))])] : [])
          : [when({ kind: 'binary', op: '&&', left: wrapped, right: loop }, [store(position, int(0))])];
        // out0 if current is 0, else out1 if 1, …
        const dispatch = outputs.reduceRight<IrStatement[]>((otherwise, out, i) => [when({ kind: 'binary', op: '==', left: read(current), right: int(i) }, next(out), otherwise)], []);
        const go: IrStatement[] = [
          store(current, read(position)),
          store(position, { kind: 'binary', op: '+', left: read(position), right: int(1) }),
          ...dispatch
        ];
        return [
          initOnce([store(position, int(0)), ...first]),
          ...restart,
          // Looping, an output is always left after the restart.
          ...(loop.kind === 'literal' && loop.value ? go : [when({ kind: 'binary', op: '<', left: read(position), right: int(outputs.length) }, go)])
        ];
      }
      case 'switch': {
        const selection = state('selection', node.type === SWITCH_STRING ? 'string' : 'int');
        const values: unknown[] = node.type === SWITCH_STRING ? switchStringCases(node) : switchIntCases(node);
        // An unconnected selection picks its case here, as Branch's condition does.
        const chosen = input('selection');
        if (chosen.kind === 'literal') {
          const i = values.findIndex((value) => (node.type === SWITCH_STRING ? String(chosen.value ?? '') === value : Math.trunc(toNumber(chosen.value)) === value));
          return next(i < 0 ? 'default' : `case${i}`);
        }
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
    // A generic function (docs/node-authoring.md, gap 10) is imported once for each set of types its
    // wildcard pins took, so each call has its own signature; the language infers the rest.
    const adopted = adoptedTypes(node);
    const id = Object.keys(adopted).length ? `${def.type}|${JSON.stringify(adopted)}` : def.type;
    const existing = this.imports.get(id);
    if (existing) return existing;
    const implementation = def.implementation;
    if (implementation?.kind !== 'function') return undefined;
    // A library generated for several languages: the generated file in one this graph imports.
    const language = [implementation.language, ...Object.keys(implementation.variants ?? {})].find((l) => this.options.importLanguages.includes(l));
    if (!language) {
      const library = implementation.source;
      const message = library
        ? `"${def.displayName}" is in a ${[implementation.language, ...Object.keys(implementation.variants ?? {})].map((l) => this.languageName(l)).join(' and ')} function library (${library.document}); add ${this.options.languageName} to its languages to call it from this graph.`
        : `"${def.displayName}" is ${this.languageName(implementation.language)} code (${implementation.path}); a ${this.options.languageName} graph can't call it.`;
      this.error('wrong-language', message, info.graph.id, node.id);
      return undefined;
    }
    const target = language === implementation.language ? implementation : implementation.variants![language];
    const imported: IrImport = {
      id,
      name: target.name,
      language,
      path: target.path,
      ...(target.module ? { module: target.module } : {}),
      ...(implementation.member ? { member: implementation.member } : {}),
      ...(implementation.member?.kind === 'construct' ? { bases: this.codeBases(implementation.member.type) } : {}),
      ...(implementation.results ? { results: implementation.results } : {}),
      ...(target === implementation && implementation.linkage ? { linkage: implementation.linkage } : {}),
      params: dataInputs(def).map((p) => ({ pinId: p.id, type: p.type, ...(target === implementation && implementation.borrowed?.includes(p.id) ? { borrowed: true } : {}) })),
      // A function with @execs returns a bool or an enum, which its exec outputs stand for.
      returns: implementation.execs === 'bool' ? { id: 'bool' } : typeof implementation.execs === 'object' ? { id: implementation.execs.enum } : def.outputs.find((p) => p.kind === 'data')?.type
    };
    const outputs = def.outputs.filter((p) => p.kind === 'data');
    // Several outputs, or (code with out parameters) one that isn't the returned value.
    if (outputs.length > 1 || implementation.results) imported.outputs = outputs.map((p) => ({ id: p.id, name: p.name, type: p.type }));
    this.imports.set(id, imported);
    return imported;
  }

  // The classes a class from the project's code extends, nearest first.
  private codeBases(type: string): { name: string; module?: string }[] {
    const classes = codeClasses(this.options.registry.all());
    const bases: { name: string; module?: string }[] = [];
    const seen = new Set([type]);
    for (let base = classes.get(type)?.base; base && !seen.has(base); base = classes.get(base)?.base) {
      seen.add(base);
      const known = classes.get(base);
      if (!known) break;
      bases.push({ name: known.name, ...(known.module ? { module: known.module } : {}) });
    }
    return bases;
  }

  private codeHelper(info: GraphInfo, node: GraphNode, def: NodeDefinition): IrCodeHelper | undefined {
    // A wildcard node (Add on an array of int, or of string) needs a helper per element type.
    const key = JSON.stringify([def.type, dataInputs(def).map((p) => p.type ?? null), def.outputs.find((p) => p.kind === 'data')?.type ?? null]);
    const existing = this.helpers.get(key);
    if (existing) return existing;
    if (def.implementation?.kind !== 'code') return undefined;
    const sources = def.implementation.languages;
    const language = this.options.snippetLanguages.find((key) => sources[key] !== undefined);
    const own = this.options.snippets?.[def.type];
    if (!language && own === undefined) {
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
      code: language ? sources[language] : own!
    };
    this.helpers.set(key, helper);
    return helper;
  }

  private programView(): ProgramTypes {
    return {
      members: [...this.members.values()], slots: [...this.slots.values()], helpers: [...this.helpers.values()], imports: [...this.imports.values()], functions: this.functions,
      className: this.doc.name, ...(this.ownClass ? { classInfo: this.ownClass } : {}), ...this.interfacePlan()
    };
  }

  // An object prints as nothing useful, and differently in each language: Unreal prints one's name
  // with Get Display Name, which arrives later.
  private checkPrintable(info: GraphInfo, nodeId: string, value: IrExpr): void {
    const type = exprType(value, this.programView());
    if (type && !type.container && type.id.startsWith('object:')) this.error('print-object', "An object can't be printed; print one of its variables.", info.graph.id, nodeId);
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
    if (nodeId && isMacroInnerNode(nodeId) && this.quietInner) return;
    const visible = nodeId && visibleNodeId(nodeId);
    const diagnostic: CompileDiagnostic = { severity, code, message, ...(graphId ? { graphId } : {}), ...(visible ? { nodeId: visible } : {}) };
    if (!this.diagnostics.some((d) => d.severity === severity && d.code === code && d.message === message && d.graphId === diagnostic.graphId && d.nodeId === diagnostic.nodeId)) this.diagnostics.push(diagnostic);
  }
}

// The IrFunction id of a custom event's method.
function eventFunctionId(graphId: string, nodeId: string): string {
  return JSON.stringify(['event', graphId, nodeId]);
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

// When no pack registry names them (lowerDocument called directly).
const LANGUAGE_NAMES: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python' };

// "a", "a and b", "a, b and c".
function list(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
