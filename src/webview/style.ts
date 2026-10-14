// Unreal's visual language: pin and wire colors by type, title styles by node kind
// (docs/unreal-conventions.md, "Pin and wire colors" and "Node title styles").
import { NodeDefinition, PinDefinition } from '../core/model';
import { TypeRef, parseTypeId } from '../core/types';

const TYPE_COLORS: Record<string, string> = {
  bool: '#a01919',
  int: '#1fe3aa',
  float: '#9cf24a',
  string: '#f72bc9',
  object: '#1f9fef',
  struct: '#1e5fc4',
  enum: '#106f61',
  native: '#a374e5'
};
const NEUTRAL = '#8c8484';

// Exec pins and wires use a CSS variable, so they stay visible on light themes.
export const EXEC_COLOR = 'var(--exec-color)';

export function typeColor(type: TypeRef | undefined): string {
  if (!type) return NEUTRAL;
  const { category } = parseTypeId(type.id);
  return TYPE_COLORS[category === 'primitive' ? type.id : category] ?? NEUTRAL;
}

export function pinColor(pin: PinDefinition | undefined): string {
  return pin?.kind === 'exec' ? EXEC_COLOR : typeColor(pin?.type);
}

export type NodeKind = 'event' | 'function' | 'pure' | 'flow' | 'variable-get' | 'variable-set' | 'reroute';

const FLOW_OPERATIONS = new Set(['branch', 'sequence', 'end']);

export function nodeKind(def: NodeDefinition): NodeKind {
  const operation = def.implementation?.kind === 'native' ? def.implementation.operation : '';
  if (operation === 'get-variable') return 'variable-get';
  if (operation === 'set-variable') return 'variable-set';
  if (operation === 'reroute') return 'reroute';
  if (def.type.startsWith('core:event.')) return 'event';
  if (FLOW_OPERATIONS.has(operation)) return 'flow';
  const hasExec = [...def.inputs, ...def.outputs].some((p) => p.kind === 'exec');
  return hasExec ? 'function' : 'pure';
}

// Header colors per kind; variable nodes take their variable's type color instead.
const KIND_COLORS: Record<NodeKind, string> = {
  event: '#9c1a1a',
  function: '#1a5a9c',
  pure: '#3f7f2a',
  flow: '#5a5a5a',
  'variable-get': NEUTRAL,
  'variable-set': NEUTRAL,
  reroute: NEUTRAL
};

export function headerColor(def: NodeDefinition): string {
  const kind = nodeKind(def);
  if (kind === 'variable-get' || kind === 'variable-set' || kind === 'reroute') {
    const data = [...def.inputs, ...def.outputs].find((p) => p.kind === 'data');
    return typeColor(data?.type);
  }
  return KIND_COLORS[kind];
}
