// Objects (docs/program-structure.md, "Classes"): every class graph is a type, `object:<Name>`.
// Construct makes an instance (and runs its Start events, as spawning runs BeginPlay); Self is the
// object a graph belongs to; and member nodes with a Target pin use another object's variables,
// functions, custom events and event dispatchers. A class's public members are described on its
// Construct node's definition, so the compiler, Simulate and the editor learn them from the node
// registry, as structs travel with Make (src/core/user-types.ts).
import { customEvents, delegateType, documentDispatchers, eventInputs, eventName } from './events';
import { GraphDocument, GraphNode, GraphPin, NodeDefinition, PinDefinition } from './model';
import { TypeRef } from './types';
import { TypeSource } from './user-types';

export interface ClassMember {
  id: string;
  name: string;
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
    functions: doc.graphs.filter((g) => g.kind === 'function').map((g) => ({
      id: g.id, name: g.name, inputs: g.signature?.inputs ?? [], outputs: g.signature?.outputs ?? [], pure: !!g.signature?.pure
    })),
    events: customEvents(doc.graphs).map(({ node }) => ({ id: eventName(node), name: eventName(node), inputs: eventInputs(node) })),
    variables: doc.variables.map((v) => ({ id: v.id, name: v.name, type: v.type })),
    dispatchers: documentDispatchers(doc).map((d) => ({ id: d.id, name: d.name, inputs: d.inputs }))
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
    member(PARENT_CALL, 'Parent', 'parent-call', "Runs the parent class's version of this function (or of Start).")
  ];
}

// Construct <Class>: a new object of the class, its Start events run.
export function classDefinitions(type: ClassInfo): NodeDefinition[] {
  return [{
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
  return [SELF, OBJECT_GET, OBJECT_SET, OBJECT_CALL, OBJECT_EVENT, OBJECT_DISPATCHER, PARENT_CALL].includes(type);
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

// The class hierarchy test for types.ts: whether `from` is `to` or one of its subclasses.
export function subclassTest(definition: (type: string) => NodeDefinition | undefined, own?: ClassInfo): (from: string, to: string) => boolean {
  return (from, to) => {
    const type = own?.id === from ? own : classById(from, definition);
    return !!type && (type.id === to || ancestors(type, definition).some((a) => a.id === to));
  };
}

// ---- Values (Simulate) --------------------------------------------------------------------------

// An object in Simulate: its class's name and its own run (variables, bindings, node outputs).
export class ObjectValue {
  constructor(readonly className: string, readonly state: unknown) {}
}
