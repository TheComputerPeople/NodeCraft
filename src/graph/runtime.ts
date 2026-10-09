import { NodeRegistry } from './registry';
import { GraphDefinition, GraphNode, NodeDefinition, RuntimeLogEvent } from './model';

interface RuntimeContext {
  variables: Record<string, unknown>;
  // Nodes that have run at least once during this execution.
  visited: Set<string>;
  // Nodes currently on the execution call stack; re-entering one is a cycle.
  executing: Set<string>;
}

export class GraphRuntime {
  constructor(private readonly registry: NodeRegistry, private readonly emit: (event: RuntimeLogEvent) => void) {}

  run(graph: GraphDefinition): void {
    const context: RuntimeContext = { variables: {}, visited: new Set(), executing: new Set() };
    for (const variable of graph.variables) context.variables[variable.name] = variable.defaultValue;

    const starts = graph.nodes.filter((n) => n.type === 'core:event.start');
    if (starts.length === 0) {
      this.emit({ kind: 'error', message: 'Graph has no Start node.' });
      return;
    }

    for (const start of starts) {
      this.executeNode(graph, start, context);
    }
    this.emit({ kind: 'graph.complete', message: 'Graph execution completed.' });
  }

  private executeNode(graph: GraphDefinition, node: GraphNode, context: RuntimeContext): void {
    if (context.visited.has(node.id) && node.type !== 'core:flow.sequence') return;
    // Sequence nodes may run more than once, so they are the only way to loop back onto the stack.
    if (context.executing.has(node.id)) {
      this.emit({ kind: 'error', nodeId: node.id, nodeType: node.type, message: `Execution cycle through ${node.id} was stopped.` });
      return;
    }
    context.visited.add(node.id);
    context.executing.add(node.id);
    try {
      this.runNode(graph, node, context);
    } finally {
      context.executing.delete(node.id);
    }
  }

  private runNode(graph: GraphDefinition, node: GraphNode, context: RuntimeContext): void {
    const definition = this.registry.get(node.type);
    if (!definition) {
      this.emit({ kind: 'error', nodeId: node.id, nodeType: node.type, message: `Unknown node type: ${node.type}` });
      return;
    }

    this.emit({ kind: 'node.enter', nodeId: node.id, nodeType: node.type });

    let exited = false;
    const exit = (values?: Record<string, unknown>): void => {
      if (exited) return;
      exited = true;
      this.emit({ kind: 'node.exit', nodeId: node.id, nodeType: node.type, values });
    };

    const input = (pinId: string): unknown => this.inputValue(graph, node, pinId, context, new Set());

    const continueFrom = (pinId: string): void => {
      graph.connections
        .filter((c) => c.fromNode === node.id && c.fromPin === pinId)
        .map((c) => graph.nodes.find((n) => n.id === c.toNode))
        .filter((n): n is GraphNode => !!n)
        .forEach((next) => this.executeNode(graph, next, context));
    };

    switch (nativeOperation(definition)) {
      case 'start':
        continueFrom('execOut');
        break;
      case 'add': {
        const a = Number(input('a') ?? 0);
        const b = Number(input('b') ?? 0);
        node.properties['runtime:result'] = a + b;
        exit({ result: a + b });
        continueFrom('execOut');
        break;
      }
      case 'print': {
        const value = input('value');
        this.emit({ kind: 'log', nodeId: node.id, nodeType: node.type, message: String(value ?? '') });
        exit();
        continueFrom('execOut');
        break;
      }
      case 'branch':
        continueFrom(Boolean(input('condition')) ? 'true' : 'false');
        break;
      case 'sequence':
        ['then0', 'then1', 'then2'].forEach((pin) => continueFrom(pin));
        break;
      case 'set-variable': {
        const name = String(input('name') ?? '');
        context.variables[name] = input('value');
        exit({ [name]: context.variables[name] });
        continueFrom('execOut');
        break;
      }
      case 'end':
        break;
      default:
        if (definition.implementation?.kind === 'code') {
          if (graph.language && graph.language !== 'javascript' && graph.language !== 'typescript') {
            this.emit({ kind: 'error', nodeId: node.id, nodeType: node.type, message: `Code node ${node.type} needs a JavaScript runtime adapter for this MVP. Graph language is ${graph.language}.` });
            break;
          }
          const code = definition.implementation.languages.javascript ?? definition.implementation.languages.typescript;
          if (!code) {
            this.emit({ kind: 'error', nodeId: node.id, nodeType: node.type, message: `No JavaScript implementation for ${node.type}.` });
            break;
          }
          const dataInputs = definition.inputs.filter((p) => p.kind === 'data');
          // Pin ids are used as parameter names when they are valid identifiers, so code can refer
          // to them directly; otherwise a generated name is used and only ${pinId} reaches it.
          const paramByPin = new Map(dataInputs.map((p, i) => [p.id, isIdentifier(p.id) ? p.id : `__pin${i}`]));
          const values = dataInputs.map((p) => input(p.id));
          try {
            const body = code.replace(/\$\{([^}]+)\}/g, (_m, name: string) => paramByPin.get(name) ?? name);
            const fn = new Function(...paramByPin.values(), body) as (...args: unknown[]) => unknown;
            const result = fn(...values);
            const outputPins = definition.outputs.filter((p) => p.kind === 'data');
            if (outputPins[0]) node.properties[`runtime:${outputPins[0].id}`] = result;
            exit(outputPins[0] ? { [outputPins[0].id]: result } : {});
            continueFrom(definition.outputs.find((p) => p.kind === 'exec')?.id ?? 'execOut');
          } catch (error) {
            this.emit({ kind: 'error', nodeId: node.id, nodeType: node.type, message: error instanceof Error ? error.message : String(error) });
          }
        } else {
          this.emit({ kind: 'error', nodeId: node.id, nodeType: node.type, message: `No runtime implementation for ${node.type}.` });
        }
        break;
    }

    exit();
  }

  // `evaluating` guards against data-only cycles between pure nodes (e.g. two Get Variable
  // nodes feeding each other's Name pin).
  private inputValue(graph: GraphDefinition, node: GraphNode, pinId: string, context: RuntimeContext, evaluating: Set<string>): unknown {
    const connection = graph.connections.find((c) => c.toNode === node.id && c.toPin === pinId);
    if (!connection) return node.properties[`pin:${pinId}`];
    const source = graph.nodes.find((n) => n.id === connection.fromNode);
    if (!source) return undefined;
    return this.outputValue(graph, source, connection.fromPin, context, evaluating);
  }

  private outputValue(graph: GraphDefinition, node: GraphNode, pinId: string, context: RuntimeContext, evaluating: Set<string>): unknown {
    const definition = this.registry.get(node.type);
    if (!definition) return undefined;
    switch (nativeOperation(definition)) {
      case 'add':
        if (pinId === 'result') return node.properties['runtime:result'];
        return undefined;
      case 'get-variable': {
        if (pinId !== 'value' || evaluating.has(node.id)) return undefined;
        evaluating.add(node.id);
        const name = this.inputValue(graph, node, 'name', context, evaluating);
        evaluating.delete(node.id);
        return context.variables[String(name ?? '')];
      }
      default:
        if (definition.implementation?.kind === 'code') {
          return node.properties[`runtime:${pinId}`];
        }
        return undefined;
    }
  }
}

function nativeOperation(definition: NodeDefinition): string {
  return definition.implementation?.kind === 'native' ? definition.implementation.operation : '';
}

// The syntax check alone would accept parameter lists like "a, b" or "a = 1", hence the regex.
function isIdentifier(name: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  try {
    new Function(name, '');
    return true;
  } catch {
    return false;
  }
}
