// Objects (docs/program-structure.md, "Classes"): every class graph is a type, `object:<Name>`.
// Construct makes an instance (and runs its Start events, as spawning runs BeginPlay); Self is the
// object a graph belongs to; and member nodes with a Target pin use another object's variables,
// functions, custom events and event dispatchers. A class's public members are described on its
// Construct node's definition, so the compiler, Simulate and the editor learn them from the node
// registry, as structs travel with Make (src/core/user-types.ts).
import { customEvents, delegateType, documentDispatchers, eventInputs, eventName } from './events';
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
  functions: (ClassMember & { inputs: GraphPin[]; outputs: GraphPin[]; pure: boolean })[];
  events: (ClassMember & { inputs: GraphPin[] })[];
  variables: (ClassMember & { type: TypeRef })[];
  dispatchers: (ClassMember & { inputs: GraphPin[] })[];
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
      ...(g.signature?.access && g.signature.access !== 'public' ? { access: g.signature.access } : {})
    })),
    events: customEvents(doc.graphs).map(({ node }) => ({ id: eventName(node), name: eventName(node), inputs: eventInputs(node) })),
    variables: doc.variables.map((v) => ({ id: v.id, name: v.name, type: v.type, ...(v.access && v.access !== 'public' ? { access: v.access } : {}) })),
    dispatchers: documentDispatchers(doc).map((d) => ({ id: d.id, name: d.name, inputs: d.inputs }))
  };
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
    functions: doc.graphs.filter((g) => g.kind === 'function').map((g) => ({ id: g.id, name: g.name, inputs: g.signature?.inputs ?? [], outputs: g.signature?.outputs ?? [], pure: !!g.signature?.pure }))
  };
}

// ---- Nodes ------------------------------------------------------------------------------------

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
    member(INTERFACE_CALL, 'Interface Call', 'interface-call', 'Calls an interface function of the Target object.')
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
  id: pin.id, name: pin.name, kind: 'data', direction, ...(pin.type ? { type: pin.type } : {}), ...(pin.defaultValue !== undefined ? { defaultValue: pin.defaultValue } : {})
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
    return { ...base, displayName: fn.name, category: iface.name, description: `${iface.name}'s ${fn.name}, on an object that implements it.`, inputs: [...(fn.pure ? [] : [execIn]), target, ...ins], outputs: [...(fn.pure ? [] : [execOut]), ...outs] };
  }
  if (node.type === PARENT_CALL) {
    const name = String(node.properties.function ?? PARENT_START);
    if (name === PARENT_START) return { ...base, displayName: 'Parent: Start', inputs: [execIn], outputs: [execOut] };
    const inherited = own && parentFunction(own, name, definition);
    if (!inherited) return { ...base, displayName: `Parent: ${name} (missing)`, inputs: [execIn], outputs: [execOut] };
    const ins = inherited.inputs.filter((p) => p.kind === 'data').map((p) => data(p, 'input'));
    const outs = inherited.outputs.filter((p) => p.kind === 'data').map((p) => data(p, 'output'));
    return { ...base, displayName: `Parent: ${name}`, inputs: [...(inherited.pure ? [] : [execIn]), ...ins], outputs: [...(inherited.pure ? [] : [execOut]), ...outs] };
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
      return { ...base, displayName: fn.name, category, inputs: [...(fn.pure ? [] : [execIn]), target, ...ins], outputs: [...(fn.pure ? [] : [execOut]), ...outs] };
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
  return [SELF, OBJECT_GET, OBJECT_SET, OBJECT_CALL, OBJECT_EVENT, OBJECT_DISPATCHER, PARENT_CALL, INTERFACE_CALL].includes(type);
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
  return (from, to) => {
    // A class from the project's code: up the bases its member nodes record (codeClassBases).
    if (from.startsWith('native:')) {
      const seen = new Set<string>();
      for (let base = codeBases?.get(from); base && !seen.has(base); base = codeBases?.get(base)) {
        if (base === to) return true;
        seen.add(base);
      }
      return false;
    }
    const type = own?.id === from ? own : classById(from, definition);
    if (!type) return false;
    const chain = [type, ...ancestors(type, definition)];
    return chain.some((c) => c.id === to || c.interfaces?.includes(to));
  };
}

// The class each class from the project's code extends, by type id, as its member nodes record it
// (docs/node-authoring.md, gap 2).
export function codeClassBases(definitions: Iterable<NodeDefinition>): Map<string, string> {
  const bases = new Map<string, string>();
  for (const d of definitions) {
    const member = d.implementation?.kind === 'function' ? d.implementation.member : undefined;
    if (member?.base) bases.set(member.type, member.base);
  }
  return bases;
}

// ---- Values (Simulate) --------------------------------------------------------------------------

// An object in Simulate: its class's name and its own run (variables, bindings, node outputs).
export class ObjectValue {
  constructor(readonly className: string, readonly state: unknown) {}
}
