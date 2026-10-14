import { builtinNodeDefinitions } from './builtins';
import { NodeDefinition, PinDefinition } from './model';
import { normalizeTypeRef } from './types';

export interface Disposable {
  dispose(): void;
}

export class NodeRegistry {
  private readonly definitions = new Map<string, NodeDefinition>();
  // Definitions from the workspace, by source: node libraries, the project's functions.
  private readonly sources = new Map<string, NodeDefinition[]>();
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.registerMany(builtinNodeDefinitions());
  }

  register(definition: NodeDefinition): void {
    this.definitions.set(definition.type, normalizeNodeDefinition(definition));
  }

  registerMany(definitions: NodeDefinition[]): void {
    definitions.forEach((d) => this.register(d));
  }

  // Replaces the definitions from one workspace source. Builtins are kept unless a source
  // overrides them; later sources win over earlier ones.
  setSource(source: string, definitions: NodeDefinition[]): void {
    this.sources.set(source, definitions);
    this.definitions.clear();
    this.registerMany(builtinNodeDefinitions());
    for (const list of this.sources.values()) this.registerMany(list);
    this.listeners.forEach((listener) => listener());
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  get(type: string): NodeDefinition | undefined {
    return this.definitions.get(type);
  }

  all(): NodeDefinition[] {
    return [...this.definitions.values()];
  }
}

// Rewrites legacy pin type ids (e.g. `number`) to canonical ones.
export function normalizeNodeDefinition(def: NodeDefinition): NodeDefinition {
  const pins = (list: PinDefinition[]): PinDefinition[] => list.map((p) => (p.type ? { ...p, type: normalizeTypeRef(p.type) } : p));
  return { ...def, inputs: pins(def.inputs), outputs: pins(def.outputs) };
}

// Validates a parsed `*.node.json` document; returns undefined for anything that isn't a node definition.
export function parseNodeDefinition(text: string): NodeDefinition | undefined {
  const def = JSON.parse(text) as NodeDefinition;
  return def?.type && Array.isArray(def.inputs) && Array.isArray(def.outputs) ? def : undefined;
}
