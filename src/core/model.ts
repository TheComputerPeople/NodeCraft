import type { TypeRef } from './types';

export type { TypeRef } from './types';

export type PinKind = 'exec' | 'data';
export type PinDirection = 'input' | 'output';

export interface PinDefinition {
  id: string;
  name: string;
  kind: PinKind;
  direction: PinDirection;
  type?: TypeRef;
  defaultValue?: unknown;
}

export interface NodeDefinition {
  type: string;
  version: number;
  displayName: string;
  category: string;
  description?: string;
  color?: string;
  inputs: PinDefinition[];
  outputs: PinDefinition[];
  implementation?: NodeImplementation;
}

export type NodeImplementation =
  | { kind: 'native'; operation: string }
  | { kind: 'code'; languages: Record<string, string>; defaultLanguage?: string }
  | { kind: 'subgraph'; graph: string };

export interface GraphNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  properties: Record<string, unknown>;
}

export interface GraphConnection {
  id: string;
  fromNode: string;
  fromPin: string;
  toNode: string;
  toPin: string;
}

export interface GraphVariable {
  id: string;
  name: string;
  type: TypeRef;
  defaultValue?: unknown;
}

export interface GraphDefinition {
  schemaVersion: number;
  name: string;
  language?: string;
  variables: GraphVariable[];
  nodes: GraphNode[];
  connections: GraphConnection[];
  metadata?: Record<string, unknown>;
}

export interface RuntimeLogEvent {
  kind: 'node.enter' | 'node.exit' | 'log' | 'error' | 'graph.complete';
  nodeId?: string;
  nodeType?: string;
  values?: Record<string, unknown>;
  message?: string;
}

export interface UIMessage {
  type:
    | 'ready'
    | 'applyGraph'
    | 'runGraph'
    | 'createNode'
    | 'log';
  graph?: GraphDefinition;
  nodeType?: string;
  position?: { x: number; y: number };
  message?: string;
}

export interface HostMessage {
  type:
    | 'init'
    | 'graphChanged'
    | 'definitions'
    | 'settings'
    | 'runtimeEvent'
    | 'error';
  // Absent on 'init' when the document could not be parsed; the webview then stays read-only.
  graph?: GraphDefinition;
  definitions?: NodeDefinition[];
  saveDelay?: number;
  event?: RuntimeLogEvent;
  message?: string;
}
