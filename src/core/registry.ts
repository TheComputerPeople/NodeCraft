import { NodeDefinition } from './model';
import { builtinNodeDefinitions } from './builtins';

export interface Disposable {
  dispose(): void;
}

export class NodeRegistry {
  private readonly definitions = new Map<string, NodeDefinition>();
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.registerMany(builtinNodeDefinitions());
  }

  register(definition: NodeDefinition): void {
    this.definitions.set(definition.type, definition);
  }

  registerMany(definitions: NodeDefinition[]): void {
    definitions.forEach((d) => this.register(d));
  }

  // Replaces every workspace-provided definition; builtins are kept unless a library overrides them.
  replaceWorkspaceDefinitions(definitions: NodeDefinition[]): void {
    this.definitions.clear();
    this.registerMany(builtinNodeDefinitions());
    this.registerMany(definitions);
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

// Validates a parsed `*.node.json` document; returns undefined for anything that isn't a node definition.
export function parseNodeDefinition(text: string): NodeDefinition | undefined {
  const def = JSON.parse(text) as NodeDefinition;
  return def?.type && Array.isArray(def.inputs) && Array.isArray(def.outputs) ? def : undefined;
}
