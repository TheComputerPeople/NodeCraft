// Custom events and event dispatchers (docs/program-structure.md, "Custom events and event
// dispatchers"). A Custom Event node (in an event graph) has a name and parameters, edited in
// Details; Call nodes run it right away, as Unreal does. An Event Dispatcher is declared in My
// Blueprint with parameters; its Call node runs every event bound to it, in the order they were
// bound. A Custom Event's red delegate pin is wired into Bind (and Unbind) to say which event.
import { Graph, GraphDocument, GraphNode, GraphPin, NodeDefinition, PinDefinition } from './model';
import { TypeRef, formatType, isTypeRef } from './types';

export const CUSTOM_EVENT = 'core:event.custom';
export const CALL_EVENT = 'core:call.event';
export const CALL_DISPATCHER = 'core:dispatcher.call';
export const BIND_EVENT = 'core:dispatcher.bind';
export const UNBIND_EVENT = 'core:dispatcher.unbind';
export const UNBIND_ALL = 'core:dispatcher.unbind-all';

// The pin on a Custom Event node that stands for the event itself, as Unreal's red square pin.
export const DELEGATE_PIN = 'delegate';

export interface Dispatcher {
  id: string;
  name: string;
  inputs: GraphPin[];
  description?: string;
}

const EVENT_COLOR = '#9c1a1a';
const DISPATCHER_COLOR = '#1a5a9c';
const execIn: PinDefinition = { id: 'execIn', name: '', kind: 'exec', direction: 'input' };
const execOut: PinDefinition = { id: 'execOut', name: '', kind: 'exec', direction: 'output' };

export function eventDefinitions(): NodeDefinition[] {
  const native = (operation: string) => ({ kind: 'native' as const, operation });
  return [
    {
      type: CUSTOM_EVENT, version: 1, displayName: 'Custom Event', category: 'Events', color: EVENT_COLOR, keywords: ['custom event', 'event', 'add custom event'],
      description: 'An event of this blueprint, run by its Call nodes or by an event dispatcher it is bound to.',
      inputs: [], outputs: [execOut], implementation: native('custom-event')
    },
    {
      type: CALL_EVENT, version: 1, displayName: 'Call Event', category: 'Events', color: DISPATCHER_COLOR,
      description: 'Runs a custom event of this blueprint.', inputs: [execIn], outputs: [execOut], implementation: native('call-event')
    },
    {
      type: CALL_DISPATCHER, version: 1, displayName: 'Call', category: 'Event Dispatchers', color: DISPATCHER_COLOR,
      description: 'Runs every event bound to the dispatcher, in the order they were bound.', inputs: [execIn], outputs: [execOut], implementation: native('call-dispatcher')
    },
    {
      type: BIND_EVENT, version: 1, displayName: 'Bind Event to', category: 'Event Dispatchers', color: DISPATCHER_COLOR,
      description: 'Binds an event to the dispatcher. Binding an event twice binds it once.', inputs: [execIn], outputs: [execOut], implementation: native('bind-event')
    },
    {
      type: UNBIND_EVENT, version: 1, displayName: 'Unbind Event from', category: 'Event Dispatchers', color: DISPATCHER_COLOR,
      description: 'Unbinds an event from the dispatcher.', inputs: [execIn], outputs: [execOut], implementation: native('unbind-event')
    },
    {
      type: UNBIND_ALL, version: 1, displayName: 'Unbind all Events from', category: 'Event Dispatchers', color: DISPATCHER_COLOR,
      description: 'Unbinds every event from the dispatcher.', inputs: [execIn], outputs: [execOut], implementation: native('unbind-all')
    }
  ];
}

export function isEventNode(type: string): boolean {
  return type === CUSTOM_EVENT || type === CALL_EVENT;
}

export function isDispatcherNode(type: string): boolean {
  return type === CALL_DISPATCHER || type === BIND_EVENT || type === UNBIND_EVENT || type === UNBIND_ALL;
}

// A Custom Event node's name and parameters (stored on the node, as Unreal does).
export function eventName(node: GraphNode): string {
  return typeof node.properties.name === 'string' && node.properties.name ? node.properties.name : 'CustomEvent';
}

export function eventInputs(node: GraphNode): GraphPin[] {
  const inputs: unknown = node.properties.inputs;
  if (!Array.isArray(inputs)) return [];
  // A parameter broken in the file is left out, rather than breaking the editor and the compiler.
  return inputs.every(isPin) ? inputs : inputs.filter(isPin);
}

function isPin(value: unknown): value is GraphPin {
  if (typeof value !== 'object' || value === null) return false;
  const pin = value as Record<string, unknown>;
  return typeof pin.id === 'string' && !!pin.id && typeof pin.name === 'string' && (pin.kind === 'data' || pin.kind === 'exec') && (pin.type === undefined || isTypeRef(pin.type));
}

// Every Custom Event node of the document, with its graph.
export function customEvents(graphs: readonly Graph[] | undefined): { graph: Graph; node: GraphNode }[] {
  return (graphs ?? []).flatMap((graph) => graph.nodes.filter((n) => n.type === CUSTOM_EVENT).map((node) => ({ graph, node })));
}

// The Custom Event a Call node runs, by name.
export function calledEvent(node: GraphNode, graphs: readonly Graph[] | undefined): { graph: Graph; node: GraphNode } | undefined {
  const name = node.properties.event;
  return typeof name === 'string' ? customEvents(graphs).find((e) => eventName(e.node) === name) : undefined;
}

export function boundDispatcher(node: GraphNode, dispatchers: readonly Dispatcher[] | undefined): Dispatcher | undefined {
  const id = node.properties.dispatcher;
  return typeof id === 'string' ? dispatchers?.find((d) => d.id === id) : undefined;
}

// The type of an event that takes these parameters: an event fits a dispatcher when they agree.
export function delegateType(inputs: readonly GraphPin[]): TypeRef {
  return { id: `delegate:(${inputs.filter((p) => p.kind === 'data').map((p) => formatType(p.type)).join(', ')})` };
}

const data = (pin: GraphPin, direction: PinDefinition['direction']): PinDefinition => ({
  id: pin.id, name: pin.name, kind: 'data', direction, ...(pin.type ? { type: pin.type } : {}), ...(pin.defaultValue !== undefined ? { defaultValue: pin.defaultValue } : {})
});

// Custom Event, Call and dispatcher nodes with their names and parameters.
export function eventNodeDefinition(base: NodeDefinition, node: GraphNode, doc: { graphs?: readonly Graph[]; dispatchers?: readonly Dispatcher[] }): NodeDefinition {
  if (node.type === CUSTOM_EVENT) {
    const inputs = eventInputs(node);
    return {
      ...base, displayName: eventName(node),
      outputs: [{ id: DELEGATE_PIN, name: '', kind: 'data', direction: 'output', type: delegateType(inputs) }, ...base.outputs, ...inputs.filter((p) => p.kind === 'data').map((p) => data(p, 'output'))]
    };
  }
  if (node.type === CALL_EVENT) {
    const target = calledEvent(node, doc.graphs);
    return {
      ...base, displayName: target ? eventName(target.node) : `Missing event ${String(node.properties.event ?? '')}`,
      inputs: [...base.inputs, ...(target ? eventInputs(target.node) : []).filter((p) => p.kind === 'data').map((p) => data(p, 'input'))]
    };
  }
  const dispatcher = boundDispatcher(node, doc.dispatchers);
  const name = dispatcher?.name ?? 'Missing dispatcher';
  const params = (dispatcher?.inputs ?? []).filter((p) => p.kind === 'data');
  if (node.type === CALL_DISPATCHER) return { ...base, displayName: `Call ${name}`, inputs: [...base.inputs, ...params.map((p) => data(p, 'input'))] };
  if (node.type === UNBIND_ALL) return { ...base, displayName: `Unbind all Events from ${name}` };
  const verb = node.type === BIND_EVENT ? 'Bind Event to' : 'Unbind Event from';
  return { ...base, displayName: `${verb} ${name}`, inputs: [...base.inputs, { id: 'event', name: 'Event', kind: 'data', direction: 'input', type: delegateType(params) }] };
}

export function documentDispatchers(doc: Pick<GraphDocument, 'dispatchers'> | undefined): Dispatcher[] {
  return Array.isArray(doc?.dispatchers) ? doc!.dispatchers : [];
}
