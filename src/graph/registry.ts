import * as vscode from 'vscode';
import { NodeDefinition, PinDefinition, TypeRef } from './model';

const t = (id: string): TypeRef => ({ id });
const dataInput = (id: string, name: string, type: string, defaultValue?: unknown): PinDefinition => ({
  id, name, kind: 'data', direction: 'input', type: t(type), defaultValue
});
const dataOutput = (id: string, name: string, type: string): PinDefinition => ({
  id, name, kind: 'data', direction: 'output', type: t(type)
});
const execInput = (id = 'execIn'): PinDefinition => ({ id, name: '', kind: 'exec', direction: 'input' });
const execOutput = (id = 'execOut', name = ''): PinDefinition => ({ id, name, kind: 'exec', direction: 'output' });

const NODE_LIBRARY_GLOB = '**/*.node.json';
const RELOAD_DEBOUNCE_MS = 200;

export class NodeRegistry implements vscode.Disposable {
  private readonly definitions = new Map<string, NodeDefinition>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

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
    this.changeEmitter.fire();
  }

  get(type: string): NodeDefinition | undefined {
    return this.definitions.get(type);
  }

  all(): NodeDefinition[] {
    return [...this.definitions.values()];
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

export async function readWorkspaceNodeLibraries(): Promise<NodeDefinition[]> {
  const files = await vscode.workspace.findFiles(NODE_LIBRARY_GLOB, '**/node_modules/**', 500);
  const definitions: NodeDefinition[] = [];
  for (const file of files) {
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      const text = new TextDecoder().decode(bytes);
      const def = JSON.parse(text) as NodeDefinition;
      if (def?.type && Array.isArray(def.inputs) && Array.isArray(def.outputs)) {
        definitions.push(def);
      }
    } catch {
      // Invalid library files are ignored; the editor remains usable.
    }
  }
  return definitions;
}

// Loads workspace node libraries now and reloads them whenever a library file or the set of
// workspace folders changes.
export function watchWorkspaceNodeLibraries(registry: NodeRegistry): vscode.Disposable {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reload = async (): Promise<void> => {
    const current = ++generation;
    const definitions = await readWorkspaceNodeLibraries();
    // A newer reload started while this one was reading; its result wins.
    if (current === generation) registry.replaceWorkspaceDefinitions(definitions);
  };
  const scheduleReload = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS);
  };

  const watcher = vscode.workspace.createFileSystemWatcher(NODE_LIBRARY_GLOB);
  const subscriptions = [
    watcher,
    watcher.onDidCreate(scheduleReload),
    watcher.onDidChange(scheduleReload),
    watcher.onDidDelete(scheduleReload),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleReload)
  ];
  void reload();

  return new vscode.Disposable(() => {
    clearTimeout(timer);
    generation++;
    subscriptions.forEach((s) => s.dispose());
  });
}

export function builtinNodeDefinitions(): NodeDefinition[] {
  return [
    {
      type: 'core:event.start', version: 1, displayName: 'Start', category: 'Flow',
      description: 'Entry point for a graph.', color: '#7bd88f', inputs: [],
      outputs: [execOutput('execOut')], implementation: { kind: 'native', operation: 'start' }
    },
    {
      type: 'core:flow.branch', version: 1, displayName: 'Branch', category: 'Flow',
      description: 'Choose one execution path from a boolean value.', color: '#e6b450',
      inputs: [execInput(), dataInput('condition', 'Condition', 'bool', true)],
      outputs: [execOutput('true', 'True'), execOutput('false', 'False')],
      implementation: { kind: 'native', operation: 'branch' }
    },
    {
      type: 'core:math.add', version: 1, displayName: 'Add', category: 'Math',
      description: 'Add two numbers.', color: '#72a7ff',
      inputs: [execInput(), dataInput('a', 'A', 'number', 10), dataInput('b', 'B', 'number', 20)],
      outputs: [execOutput(), dataOutput('result', 'Result', 'number')],
      implementation: { kind: 'native', operation: 'add' }
    },
    {
      type: 'core:console.print', version: 1, displayName: 'Print', category: 'Debug',
      description: 'Write a value to the VS Code Output panel.', color: '#bb86fc',
      inputs: [execInput(), dataInput('value', 'Value', 'any', 'Hello from Visual Scripting')],
      outputs: [execOutput()], implementation: { kind: 'native', operation: 'print' }
    },
    {
      type: 'core:variable.set', version: 1, displayName: 'Set Variable', category: 'Variables',
      description: 'Set a graph variable.', color: '#ff8b7b',
      inputs: [execInput(), dataInput('name', 'Name', 'string', 'Score'), dataInput('value', 'Value', 'number', 0)],
      outputs: [execOutput()], implementation: { kind: 'native', operation: 'set-variable' }
    },
    {
      type: 'core:variable.get', version: 1, displayName: 'Get Variable', category: 'Variables',
      description: 'Read a graph variable.', color: '#ff8b7b',
      inputs: [dataInput('name', 'Name', 'string', 'Score')],
      outputs: [dataOutput('value', 'Value', 'any')], implementation: { kind: 'native', operation: 'get-variable' }
    },
    {
      type: 'core:flow.sequence', version: 1, displayName: 'Sequence', category: 'Flow',
      description: 'Run execution outputs in order.', color: '#e6b450', inputs: [execInput()],
      outputs: [execOutput('then0', 'Then 0'), execOutput('then1', 'Then 1'), execOutput('then2', 'Then 2')],
      implementation: { kind: 'native', operation: 'sequence' }
    },
    {
      type: 'core:flow.end', version: 1, displayName: 'End', category: 'Flow',
      description: 'End a branch of execution.', color: '#7bd88f', inputs: [execInput()], outputs: [],
      implementation: { kind: 'native', operation: 'end' }
    }
  ];
}
