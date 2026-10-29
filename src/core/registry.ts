import { builtinNodeDefinitions } from './builtins';
import { NodeDefinition, PinDefinition } from './model';
import { adoptUserTypes } from './user-types';
import { normalizeTypeRef } from './types';

export interface Disposable {
  dispose(): void;
}

export class NodeRegistry {
  // As registered.
  private readonly definitions = new Map<string, NodeDefinition>();
  // Former node types, to the definitions that took them over (NodeDefinition.aliases).
  private readonly aliases = new Map<string, NodeDefinition>();
  // Code functions with the workspace's structs and enums they name (src/core/user-types.ts),
  // worked out again from the definitions as registered whenever they change.
  private readonly adopted = new Map<string, NodeDefinition>();
  // Definitions from the workspace, by source: node libraries, the project's functions.
  private readonly sources = new Map<string, NodeDefinition[]>();
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.registerMany(builtinNodeDefinitions());
  }

  register(definition: NodeDefinition): void {
    this.add(definition);
    this.adoptTypes();
  }

  registerMany(definitions: NodeDefinition[]): void {
    definitions.forEach((d) => this.add(d));
    this.adoptTypes();
  }

  // Replaces the definitions from one workspace source. Builtins are kept unless a source
  // overrides them; later sources win over earlier ones.
  setSource(source: string, definitions: NodeDefinition[]): void {
    this.sources.set(source, definitions);
    this.definitions.clear();
    this.aliases.clear();
    builtinNodeDefinitions().forEach((d) => this.add(d));
    for (const list of this.sources.values()) list.forEach((d) => this.add(d));
    this.adoptTypes();
    this.listeners.forEach((listener) => listener());
  }

  private add(definition: NodeDefinition): void {
    const normalized = normalizeNodeDefinition(definition);
    this.definitions.set(definition.type, normalized);
    for (const alias of definition.aliases ?? []) this.aliases.set(alias, normalized);
  }

  private adoptTypes(): void {
    this.adopted.clear();
    for (const def of adoptUserTypes([...this.definitions.values()])) this.adopted.set(def.type, def);
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  get(type: string): NodeDefinition | undefined {
    const def = this.definitions.get(type) ?? this.aliases.get(type);
    return def && (this.adopted.get(def.type) ?? def);
  }

  all(): NodeDefinition[] {
    return [...this.definitions.values()].map((d) => this.adopted.get(d.type) ?? d);
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
