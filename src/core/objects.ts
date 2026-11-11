// Objects (docs/program-structure.md, "Classes"): every class graph is a type, `object:<Name>`.
// Construct makes an instance (and runs its Start events, as spawning runs BeginPlay); Self is the
// object a graph belongs to; and member nodes with a Target pin use another object's variables,
// functions, custom events and event dispatchers. A class's public members are described on its
// Construct node's definition, so the compiler, Simulate and the editor learn them from the node
// registry, as structs travel with Make (src/core/user-types.ts).
import { customEvents, delegateType, documentDispatchers, eventInputs, eventName } from './events';
import { FunctionMetadata, signatureMetadata } from './metadata';
import { Access, GraphDocument, GraphNode, GraphPin, NodeDefinition, PinDefinition } from './model';
import { TypeRef } from './types';
import { TypeSource } from './user-types';

export interface ClassMember {
  id: string;
  name: string;
  // Public when absent.
  access?: Access;
}

export interface ClassInfo {
  kind: 'class';
  // The pin type id, "object:<Name>".
  id: string;
  name: string;
  language?: string;
  source?: TypeSource;
  // The parent class ("object:<Name>"): its members are this class's too.
  parent?: string;
  // The interfaces ("interface:<Name>") it implements.
  interfaces?: string[];
  // In the order generated code names them (see each language's class member names).
  functions: (ClassMember & FunctionMetadata & { inputs: GraphPin[]; outputs: GraphPin[]; pure: boolean })[];
  events: (ClassMember & { inputs: GraphPin[] })[];
  variables: (ClassMember & { type: TypeRef })[];
  dispatchers: (ClassMember & { inputs: GraphPin[] })[];
  // The code parent's methods it overrides as events (OVERRIDE_EVENT nodes), by name.
  overrides?: string[];
}

export function classTypeId(name: string): string {
  return `object:${name}`;
}

// The class a class document declares (functions by graph id, events by name).
export function declaredClass(doc: GraphDocument, source?: TypeSource): ClassInfo | undefined {
  if (doc.kind !== 'class') return undefined;
  return {
    kind: 'class', id: classTypeId(doc.name), name: doc.name, ...(doc.language ? { language: doc.language } : {}), ...(source ? { source } : {}),
    ...(doc.parent ? { parent: doc.parent } : {}),
    ...(doc.interfaces?.length ? { interfaces: doc.interfaces } : {}),
    functions: doc.graphs.filter((g) => g.kind === 'function').map((g) => ({
      id: g.id, name: g.name, inputs: g.signature?.inputs ?? [], outputs: g.signature?.outputs ?? [], pure: !!g.signature?.pure,
      ...(g.signature?.access && g.signature.access !== 'public' ? { access: g.signature.access } : {}),
      ...signatureMetadata(g.signature)
    })),
    events: customEvents(doc.graphs).map(({ node }) => ({ id: eventName(node), name: eventName(node), inputs: eventInputs(node) })),
    variables: doc.variables.map((v) => ({ id: v.id, name: v.name, type: v.type, ...(v.access && v.access !== 'public' ? { access: v.access } : {}) })),
    dispatchers: documentDispatchers(doc).map((d) => ({ id: d.id, name: d.name, inputs: d.inputs })),
    ...overrideEvents(doc)
  };
}

function overrideEvents(doc: GraphDocument): { overrides?: string[] } {
  const names = [...new Set(doc.graphs.filter((g) => g.kind === 'event').flatMap((g) => g.nodes.filter((n) => n.type === OVERRIDE_EVENT).map((n) => String(n.properties.method ?? ''))))].filter(Boolean);
  return names.length ? { overrides: names } : {};
}

// An interface: function signatures that classes implementing it give bodies (Unreal's Blueprint
// Interface).
export interface InterfaceInfo {
  kind: 'interface';
  // The pin type id, "interface:<Name>".
  id: string;
  name: string;
  language?: string;
  source?: TypeSource;
  functions: ClassInfo['functions'];
}

export function interfaceTypeId(name: string): string {
  return `interface:${name}`;
}

export function declaredInterface(doc: GraphDocument, source?: TypeSource): InterfaceInfo | undefined {
  if (doc.kind !== 'interface') return undefined;
  return {
    kind: 'interface', id: interfaceTypeId(doc.name), name: doc.name, ...(doc.language ? { language: doc.language } : {}), ...(source ? { source } : {}),
    functions: doc.graphs.filter((g) => g.kind === 'function').map((g) => ({ id: g.id, name: g.name, inputs: g.signature?.inputs ?? [], outputs: g.signature?.outputs ?? [], pure: !!g.signature?.pure, ...signatureMetadata(g.signature) }))
  };
}

// ---- Nodes ------------------------------------------------------------------------------------

// A class or interface function's metadata, for its call nodes (src/core/metadata.ts).
function metadataOf(fn: FunctionMetadata): FunctionMetadata {
  return { ...(fn.keywords ? { keywords: fn.keywords } : {}), ...(fn.compactTitle ? { compactTitle: fn.compactTitle } : {}), ...(fn.deprecated ? { deprecated: fn.deprecated } : {}) };
}

export const SELF = 'core:object.self';
export const IS_VALID = 'core:object.is-valid';
export const OBJECT_GET = 'core:object.get';
export const OBJECT_SET = 'core:object.set';
export const OBJECT_CALL = 'core:object.call';
export const OBJECT_EVENT = 'core:object.event';
export const OBJECT_DISPATCHER = 'core:object.dispatcher';
// Unreal's "Parent: <Function>" (and "Parent: BeginPlay"): runs the parent class's version.
export const PARENT_CALL = 'core:object.parent';
export const PARENT_START = 'Start';
// A function of an interface, called on an object that implements it (Unreal's interface call).
export const INTERFACE_CALL = 'core:interface.call';
// A method of the class from the code this class extends, overridden as an event (Unreal's
// implementable and native events; docs/code-classes-as-parents.md, part 2): `properties.method`.
export const OVERRIDE_EVENT = 'core:event.override';

// What an object dispatcher node does with the dispatcher.
export type DispatcherAction = 'call' | 'bind' | 'unbind' | 'unbind-all';

const OBJECT_COLOR = '#1f9fef';
const execIn: PinDefinition = { id: 'execIn', name: '', kind: 'exec', direction: 'input' };
const execOut: PinDefinition = { id: 'execOut', name: '', kind: 'exec', direction: 'output' };

export function constructNodeType(type: ClassInfo): string {
  return `${type.id}.construct`;
}

export function objectDefinitions(): NodeDefinition[] {
  const native = (operation: string) => ({ kind: 'native' as const, operation });
  const member = (type: string, displayName: string, operation: string, description: string): NodeDefinition => ({
    type, version: 1, displayName, category: 'Objects', color: OBJECT_COLOR, description, inputs: [], outputs: [], implementation: native(operation)
  });
  return [
    {
      type: SELF, version: 1, displayName: 'Self', category: 'Objects', color: OBJECT_COLOR, compact: true, keywords: ['self', 'this', 'reference to self', 'get a reference to self'],
      description: 'The object this graph belongs to.', inputs: [], outputs: [{ id: 'self', name: 'Self', kind: 'data', direction: 'output' }], implementation: native('self')
    },
    {
      type: IS_VALID, version: 1, displayName: 'Is Valid', category: 'Objects', color: '#3f7f2a', keywords: ['valid', 'null', 'none'],
      description: 'True if the object reference points at an object.', inputs: [{ id: 'object', name: 'Object', kind: 'data', direction: 'input', type: { id: 'any' } }],
      outputs: [{ id: 'returnValue', name: 'Return Value', kind: 'data', direction: 'output', type: { id: 'bool' } }], implementation: native('is-valid')
    },
    member(OBJECT_GET, 'Get', 'object-get', "Reads a variable of the Target object."),
    member(OBJECT_SET, 'Set', 'object-set', "Sets a variable of the Target object."),
    member(OBJECT_CALL, 'Call Function', 'object-call', 'Calls a function of the Target object.'),
    member(OBJECT_EVENT, 'Call Event', 'object-event', 'Runs a custom event of the Target object.'),
    member(OBJECT_DISPATCHER, 'Event Dispatcher', 'object-dispatcher', "Calls, binds or unbinds the Target object's event dispatcher."),
    member(PARENT_CALL, 'Parent', 'parent-call', "Runs the parent class's version of this function (or of Start)."),
    member(INTERFACE_CALL, 'Interface Call', 'interface-call', 'Calls an interface function of the Target object.'),
    { ...member(OVERRIDE_EVENT, 'Event', 'override-event', "Runs when the class's code calls this method: this class's version of it."), color: '#8f1e1e' }
  ];
}

// Cast To <Class or Interface>: Cast Succeeded with the object as that type, else Cast Failed.
function castDefinition(type: ClassInfo | InterfaceInfo): NodeDefinition {
  return {
    type: `${type.id}.cast`, version: 1, displayName: `Cast To ${type.name}`, category: 'Utilities|Casting', color: OBJECT_COLOR,
    keywords: ['cast', 'cast to', 'is a', type.name],
    description: `Cast Succeeded runs when the object is a ${type.name}${type.kind === 'interface' ? ' (its class implements it)' : ''}, with it as one; else Cast Failed.`,
    inputs: [execIn, { id: 'object', name: 'Object', kind: 'data', direction: 'input', type: { id: 'any' } }],
    outputs: [
      { id: 'succeeded', name: 'Cast Succeeded', kind: 'exec', direction: 'output' }, { id: 'failed', name: 'Cast Failed', kind: 'exec', direction: 'output' },
      { id: 'as', name: `As ${type.name}`, kind: 'data', direction: 'output', type: { id: type.id } }
    ],
    implementation: type.kind === 'class' ? { kind: 'class', operation: 'cast', type } : { kind: 'interface', operation: 'cast', type }
  };
}

// An interface's Cast To node, which carries its functions.
export function interfaceDefinitions(type: InterfaceInfo): NodeDefinition[] {
  return [castDefinition(type)];
}

// Construct <Class>: a new object of the class, its Start events run; and Cast To <Class>.
export function classDefinitions(type: ClassInfo): NodeDefinition[] {
  return [castDefinition(type), {
    type: constructNodeType(type), version: 1, displayName: `Construct ${type.name}`, category: 'Objects', color: OBJECT_COLOR,
    keywords: ['construct', 'create', 'new', 'spawn', 'construct object from class'],
    description: `A new ${type.name}. Its Start events run first, as spawning runs BeginPlay.`,
    inputs: [execIn], outputs: [execOut, { id: 'object', name: 'Return Value', kind: 'data', direction: 'output', type: { id: type.id } }],
    implementation: { kind: 'class', operation: 'construct', type }
  }];
}

// The class a node's `properties.class` names: the document's own, or a workspace class.
export function nodeClass(node: GraphNode, own: ClassInfo | undefined, definition: (type: string) => NodeDefinition | undefined): ClassInfo | undefined {
  const id = node.properties.class;
  if (typeof id !== 'string') return undefined;
  if (own && own.id === id) return own;
  const implementation = definition(`${id}.construct`)?.implementation;
  return implementation?.kind === 'class' ? implementation.type : undefined;
}

const data = (pin: GraphPin, direction: PinDefinition['direction']): PinDefinition => ({
  id: pin.id, name: pin.name, kind: 'data', direction, ...(pin.type ? { type: pin.type } : {}), ...(pin.defaultValue !== undefined ? { defaultValue: pin.defaultValue } : {}),
  ...(pin.advanced && direction === 'input' ? { advanced: true } : {})
});

// Self, and the member nodes, with the pins of the member they use on the Target object.
export function objectNodeDefinition(base: NodeDefinition, node: GraphNode, own: ClassInfo | undefined, definition: (type: string) => NodeDefinition | undefined): NodeDefinition {
  if (node.type === SELF) return own ? { ...base, outputs: [{ ...base.outputs[0], type: { id: own.id } }] } : base;
  if (node.type === INTERFACE_CALL) {
    const iface = typeof node.properties.interface === 'string' ? interfaceById(node.properties.interface, definition) : undefined;
    const fn = iface?.functions.find((f) => f.id === node.properties.function);
    const target: PinDefinition = { id: 'target', name: 'Target', kind: 'data', direction: 'input', type: { id: String(node.properties.interface ?? 'interface:') } };
    if (!iface || !fn) return { ...base, displayName: `Missing interface function`, inputs: [execIn, target], outputs: [execOut] };
    const ins = fn.inputs.filter((p) => p.kind === 'data').map((p) => data(p, 'input'));
    const outs = fn.outputs.filter((p) => p.kind === 'data').map((p) => data(p, 'output'));
    return { ...base, displayName: fn.name, category: iface.name, description: `${iface.name}'s ${fn.name}, on an object that implements it.`, ...metadataOf(fn), inputs: [...(fn.pure ? [] : [execIn]), target, ...ins], outputs: [...(fn.pure ? [] : [execOut]), ...outs] };
  }
  if (node.type === PARENT_CALL) {
    const name = String(node.properties.function ?? PARENT_START);
    if (name === PARENT_START) return { ...base, displayName: 'Parent: Start', inputs: [execIn], outputs: [execOut] };
    const inherited = own && parentFunction(own, name, definition);
    if (!inherited) {
      // The code's own version of a method this class overrides (not an abstract one: it has none).
      const method = own && codeParentMethod(own, name, definition);
      if (method && !method.abstract) return { ...base, displayName: `Parent: ${name}`, inputs: [execIn, ...method.inputs], outputs: [execOut, ...method.outputs] };
      return { ...base, displayName: `Parent: ${name} (${method ? 'abstract: the code has no version of it' : 'missing'})`, inputs: [execIn], outputs: [execOut] };
    }
    const ins = inherited.inputs.filter((p) => p.kind === 'data').map((p) => data(p, 'input'));
    const outs = inherited.outputs.filter((p) => p.kind === 'data').map((p) => data(p, 'output'));
    return { ...base, displayName: `Parent: ${name}`, inputs: [...(inherited.pure ? [] : [execIn]), ...ins], outputs: [...(inherited.pure ? [] : [execOut]), ...outs] };
  }
  if (node.type === OVERRIDE_EVENT) {
    const name = String(node.properties.method ?? '');
    const method = own && codeParentMethod(own, name, definition);
    if (!method) return { ...base, displayName: `Event ${name} (missing)`, outputs: [execOut] };
    return {
      ...base, displayName: `Event ${name}`, category: method.owner.title,
      description: `Runs when ${method.owner.title}'s code calls ${name}: this class's version of it${method.abstract ? '' : ', in place of the code\'s (Parent: ' + name + ' runs that)'}.`,
      outputs: [execOut, ...method.inputs.map((p) => ({ ...p, direction: 'output' as const }))]
    };
  }
  const type = nodeClass(node, own, definition);
  const target: PinDefinition = { id: 'target', name: 'Target', kind: 'data', direction: 'input', type: { id: type?.id ?? String(node.properties.class ?? 'object:') } };
  // A missing class or member keeps the node's exec pins, so its wires stay and the error says why.
  const impure = node.type !== OBJECT_GET && !(node.type === OBJECT_CALL && type?.functions.find((f) => f.id === node.properties.function)?.pure);
  const missing = (what: string): NodeDefinition => ({ ...base, displayName: `Missing ${what}`, inputs: [...(impure ? [execIn] : []), target], outputs: impure ? [execOut] : [] });
  if (!type) return missing('class');
  const category = type.name;
  switch (node.type) {
    case OBJECT_GET:
    case OBJECT_SET: {
      const variable = type.variables.find((v) => v.id === node.properties.variable);
      if (!variable) return missing('variable');
      const value: PinDefinition = { id: 'value', name: variable.name, kind: 'data', direction: 'input', type: variable.type };
      if (node.type === OBJECT_GET) return { ...base, displayName: variable.name, category, compact: false, inputs: [target], outputs: [{ ...value, direction: 'output' }] };
      return { ...base, displayName: `Set ${variable.name}`, category, inputs: [execIn, target, value], outputs: [execOut, { ...value, id: 'result', direction: 'output' }] };
    }
    case OBJECT_CALL: {
      const fn = type.functions.find((f) => f.id === node.properties.function);
      if (!fn) return missing('function');
      const ins = fn.inputs.filter((p) => p.kind === 'data').map((p) => data(p, 'input'));
      const outs = fn.outputs.filter((p) => p.kind === 'data').map((p) => data(p, 'output'));
      return { ...base, displayName: fn.name, category, ...metadataOf(fn), inputs: [...(fn.pure ? [] : [execIn]), target, ...ins], outputs: [...(fn.pure ? [] : [execOut]), ...outs] };
    }
    case OBJECT_EVENT: {
      const event = type.events.find((e) => e.id === node.properties.event);
      if (!event) return missing('event');
      return { ...base, displayName: event.name, category, inputs: [execIn, target, ...event.inputs.filter((p) => p.kind === 'data').map((p) => data(p, 'input'))], outputs: [execOut] };
    }
    case OBJECT_DISPATCHER: {
      const dispatcher = type.dispatchers.find((d) => d.id === node.properties.dispatcher);
      if (!dispatcher) return missing('event dispatcher');
      const params = dispatcher.inputs.filter((p) => p.kind === 'data');
      const action = dispatcherAction(node);
      const titles: Record<DispatcherAction, string> = { call: 'Call', bind: 'Bind Event to', unbind: 'Unbind Event from', 'unbind-all': 'Unbind all Events from' };
      const extra: PinDefinition[] = action === 'call' ? params.map((p) => data(p, 'input'))
        : action === 'unbind-all' ? []
        : [{ id: 'event', name: 'Event', kind: 'data', direction: 'input', type: delegateType(params) }];
      return { ...base, displayName: `${titles[action]} ${dispatcher.name}`, category, inputs: [execIn, target, ...extra], outputs: [execOut] };
    }
  }
  return base;
}

export function dispatcherAction(node: GraphNode): DispatcherAction {
  const action = node.properties.action;
  return action === 'bind' || action === 'unbind' || action === 'unbind-all' ? action : 'call';
}

export function isObjectNode(type: string): boolean {
  return [SELF, OBJECT_GET, OBJECT_SET, OBJECT_CALL, OBJECT_EVENT, OBJECT_DISPATCHER, PARENT_CALL, INTERFACE_CALL, OVERRIDE_EVENT].includes(type);
}

export function interfaceById(id: string, definition: (type: string) => NodeDefinition | undefined): InterfaceInfo | undefined {
  const implementation = definition(`${id}.cast`)?.implementation;
  return implementation?.kind === 'interface' ? implementation.type : undefined;
}

// The interfaces a class implements, with its ancestors' (each once).
export function implementedInterfaces(type: ClassInfo, definition: (type: string) => NodeDefinition | undefined): string[] {
  return [...new Set([type, ...ancestors(type, definition)].flatMap((c) => c.interfaces ?? []))];
}

// ---- Inheritance ----------------------------------------------------------------------------------

// A workspace class by type id, from its Construct node's definition.
export function classById(id: string, definition: (type: string) => NodeDefinition | undefined): ClassInfo | undefined {
  const implementation = definition(`${id}.construct`)?.implementation;
  return implementation?.kind === 'class' ? implementation.type : undefined;
}

// A class's ancestors, nearest first (stopping at a missing class or a loop).
export function ancestors(type: ClassInfo, definition: (type: string) => NodeDefinition | undefined): ClassInfo[] {
  const chain: ClassInfo[] = [];
  const seen = new Set([type.id]);
  for (let parent = type.parent; parent && !seen.has(parent);) {
    seen.add(parent);
    const info = classById(parent, definition);
    if (!info) break;
    chain.push(info);
    parent = info.parent;
  }
  return chain;
}

// The nearest ancestor's function of that name: what an override replaces, and Parent calls.
export function parentFunction(type: ClassInfo, name: string, definition: (type: string) => NodeDefinition | undefined): (ClassInfo['functions'][number] & { owner: ClassInfo }) | undefined {
  for (const ancestor of ancestors(type, definition)) {
    const fn = ancestor.functions.find((f) => f.name === name);
    if (fn) return { ...fn, owner: ancestor };
  }
  return undefined;
}

// Whether code in class `from` may use a member of class `owner` with this access: anyone a public
// one, the class and its subclasses a protected one, the class alone a private one.
export function canAccess(access: Access | undefined, owner: string, from: ClassInfo | undefined, definition: (type: string) => NodeDefinition | undefined): boolean {
  if (!access || access === 'public') return true;
  if (from?.id === owner) return true;
  return access === 'protected' && !!from && ancestors(from, definition).some((a) => a.id === owner);
}

// The class hierarchy test for types.ts: whether an object of class `from` is a `to` (the class, an
// ancestor, or an interface it or an ancestor implements).
export function subclassTest(definition: (type: string) => NodeDefinition | undefined, own?: ClassInfo, codeBases?: ReadonlyMap<string, string>): (from: string, to: string) => boolean {
  // A class from the project's code: up the bases its member nodes record (codeClassBases).
  const codeIs = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    for (let base = codeBases?.get(from); base && !seen.has(base); base = codeBases?.get(base)) {
      if (base === to) return true;
      seen.add(base);
    }
    return false;
  };
  return (from, to) => {
    if (from.startsWith('native:')) return codeIs(from, to);
    const type = own?.id === from ? own : classById(from, definition);
    if (!type) return false;
    const chain = [type, ...ancestors(type, definition)];
    if (chain.some((c) => c.id === to || c.interfaces?.includes(to))) return true;
    // A graph class extending a class from the code is that class, and each class it extends
    // (docs/code-classes-as-parents.md, part 2).
    const code = codeClassById(chain[chain.length - 1].parent, definition);
    return !!code && (code.type === to || codeIs(code.type, to));
  };
}

// A method of the class from the code this class extends that a subclass may override, with that class.
export function codeParentMethod(type: ClassInfo, name: string, definition: (type: string) => NodeDefinition | undefined): (CodeOverridable & { owner: CodeClassInfo }) | undefined {
  const code = codeParentOf(type, definition);
  const method = code?.overridable.find((m) => m.name === name);
  return code && method ? { ...method, owner: code } : undefined;
}

// The abstract methods of the code parent no class in the chain overrides (as a function or an
// event): the class can't be constructed until none are left.
export function abstractLeft(type: ClassInfo, definition: (type: string) => NodeDefinition | undefined): string[] {
  const code = codeParentOf(type, definition);
  if (!code) return [];
  const chain = [type, ...ancestors(type, definition)];
  const given = new Set(chain.flatMap((c) => [...c.functions.map((f) => f.name), ...(c.overrides ?? [])]));
  return code.overridable.filter((m) => m.abstract && !given.has(m.name)).map((m) => m.name);
}

// Construct <Class> with the parent constructor's parameters as inputs, when the class (or an
// ancestor) extends a class from the code that takes them (docs/code-classes-as-parents.md, decision 2).
export function constructWithParentInputs(base: NodeDefinition, definition: (type: string) => NodeDefinition | undefined): NodeDefinition {
  const implementation = base.implementation;
  if (implementation?.kind !== 'class' || implementation.operation !== 'construct') return base;
  const init = codeParentOf(implementation.type, definition)?.init;
  if (!init?.length) return base;
  return { ...base, inputs: [...base.inputs.filter((p) => p.kind === 'exec'), ...init, ...base.inputs.filter((p) => p.kind !== 'exec')] };
}

// The class from the code a graph class extends, directly or through its graph ancestors.
export function codeParentOf(type: ClassInfo, definition: (type: string) => NodeDefinition | undefined): CodeClassInfo | undefined {
  const chain = [type, ...ancestors(type, definition)];
  return codeClassById(chain[chain.length - 1].parent, definition);
}

// A class from the project's code that graph classes may extend (docs/code-classes-as-parents.md),
// carried by a definition of its own whose type is its id. Not a node: the palette leaves it out.
export interface CodeClassInfo {
  kind: 'code-class';
  // "code:<language>:<path>#<Class>": what a graph class's `parent` names.
  id: string;
  // Its objects' pin type ("native:Actor"), and its base class's.
  type: string;
  base?: string;
  // Its name in the code (with its namespace or module path, as its member nodes' implementations
  // have it), and its name in the editor.
  name: string;
  title: string;
  language: string;
  path: string;
  module?: string;
  // Can't be constructed until a subclass gives its abstract methods bodies.
  abstract?: boolean;
  // Its constructor's parameters: Construct <GraphClass>'s inputs, passed on to it. Absent when the
  // class declares no constructor.
  init?: PinDefinition[];
  // Their types as the code writes them (C++, Java: CodeSpelling).
  initSpelling?: string[];
  // The methods a graph class may override: marked `@blueprint overridable`, or abstract; never one
  // the language seals. Their data pins.
  overridable: CodeOverridable[];
  // The names of all its methods and properties, marked or not: a generated subclass names its own
  // members apart from them.
  members?: string[];
}

export interface CodeOverridable {
  name: string;
  inputs: PinDefinition[];
  outputs: PinDefinition[];
  abstract?: boolean;
  protected?: boolean;
  latent?: boolean;
  // Its types as the code writes them (C++, Java), which an override repeats.
  spelling?: CodeSpelling;
}

// A code method's types as the code writes them: each parameter's, the return type's, and (C++)
// what follows the parameters (`const`, `noexcept`).
export interface CodeSpelling {
  params: string[];
  returns?: string;
  qualifiers?: string;
}

export const CODE_CLASS_PREFIX = 'code:';

// The code class a parent id names, from its definition.
export function codeClassById(id: string | undefined, definition: (type: string) => NodeDefinition | undefined): CodeClassInfo | undefined {
  if (!id?.startsWith(CODE_CLASS_PREFIX)) return undefined;
  const implementation = definition(id)?.implementation;
  return implementation?.kind === 'code-class' ? implementation.type : undefined;
}

// A class from the project's code, as its member nodes record it (docs/node-authoring.md, gap 2):
// the name generated code uses for it, and the class it extends.
export interface CodeClass {
  type: string;
  base?: string;
  name: string;
  module?: string;
  language: string;
}

// The project's classes that have member nodes, by type id.
export function codeClasses(definitions: Iterable<NodeDefinition>): Map<string, CodeClass> {
  const classes = new Map<string, CodeClass>();
  for (const d of definitions) {
    const implementation = d.implementation?.kind === 'function' ? d.implementation : undefined;
    const member = implementation?.member;
    if (!implementation || !member || classes.has(member.type)) continue;
    classes.set(member.type, { type: member.type, ...(member.base ? { base: member.base } : {}), name: implementation.name, ...(implementation.module ? { module: implementation.module } : {}), language: implementation.language });
  }
  return classes;
}

// The class each class from the project's code extends, by type id.
export function codeClassBases(definitions: Iterable<NodeDefinition>): Map<string, string> {
  const all = [...definitions];
  const bases = new Map([...codeClasses(all).values()].flatMap((c) => (c.base ? [[c.type, c.base] as [string, string]] : [])));
  // (A class graph classes may extend says so too, with or without member nodes.)
  for (const d of all) if (d.implementation?.kind === 'code-class' && d.implementation.type.base) bases.set(d.implementation.type.type, d.implementation.type.base);
  return bases;
}

// ---- Values (Simulate) --------------------------------------------------------------------------

// An object in Simulate: its class's name and its own run (variables, bindings, node outputs).
export class ObjectValue {
  constructor(readonly className: string, readonly state: unknown) {}
}
