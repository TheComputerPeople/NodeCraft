import type { CompileDiagnostic } from './compiler/diagnostics';
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
  // Drawn without a title bar, like Unreal's variable getters.
  compact?: boolean;
  // Extra words the action menu matches when searching, as in Unreal (e.g. "if" for Branch).
  keywords?: string[];
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
  // Grouping and help text shown in the My Blueprint panel, as in Unreal.
  category?: string;
  description?: string;
}

// A box drawn around part of a graph (Unreal's comment node).
export interface GraphComment {
  id: string;
  text: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  color?: string;
}

// An input or output of a function or macro graph. Functions use data pins (plus implicit exec
// pins unless pure); macros may declare any number of exec pins.
export interface GraphPin {
  id: string;
  name: string;
  kind: PinKind;
  type?: TypeRef;
  defaultValue?: unknown;
}

export interface GraphSignature {
  inputs: GraphPin[];
  outputs: GraphPin[];
  // Pure functions have no exec pins and may be evaluated any number of times.
  pure?: boolean;
}

// Event graphs hold entry points; function and macro graphs have a signature.
export type GraphKind = 'event' | 'function' | 'macro';

export interface Graph {
  id: string;
  name: string;
  kind: GraphKind;
  signature?: GraphSignature;
  localVariables?: GraphVariable[];
  nodes: GraphNode[];
  connections: GraphConnection[];
  comments: GraphComment[];
}

// What a .vgraph file is, mirroring Unreal's asset types: a class (variables, event graphs,
// functions, macros), a library of functions, or a library of macros.
export type DocumentKind = 'class' | 'functionLibrary' | 'macroLibrary';

// The contents of a .vgraph file (schema version 2).
export interface GraphDocument {
  schemaVersion: number;
  name: string;
  kind: DocumentKind;
  language?: string;
  // Member variables; libraries have none.
  variables: GraphVariable[];
  graphs: Graph[];
  metadata?: Record<string, unknown>;
  // Fields this version doesn't know about are preserved on save.
  [extra: string]: unknown;
}

export interface RuntimeLogEvent {
  kind: 'node.enter' | 'node.exit' | 'log' | 'error' | 'graph.complete';
  // The graph the node belongs to; node ids are only unique within a graph.
  graphId?: string;
  nodeId?: string;
  nodeType?: string;
  values?: Record<string, unknown>;
  message?: string;
}

// The outcome of compiling a graph, shown in the editor's Compiler Results panel.
export interface CompileReport {
  status: 'ok' | 'warnings' | 'errors';
  diagnostics: CompileDiagnostic[];
  language: string;
  // The generated file, relative to the workspace, when compilation succeeded.
  outputFile?: string;
}

export interface RunStatus {
  state: 'running' | 'finished' | 'failed';
  message: string;
}

// A target language the editor can offer: a pack that can generate code.
export interface LanguageOption {
  id: string;
  displayName: string;
}

export interface UIMessage {
  // run: compile, then run the generated code; simulate: run in the editor's interpreter.
  type: 'ready' | 'applyDocument' | 'compile' | 'run' | 'simulate';
  document?: GraphDocument;
}

export interface HostMessage {
  type:
    | 'init'
    | 'documentChanged'
    | 'definitions'
    | 'settings'
    | 'runtimeEvent'
    | 'compileResult'
    | 'runStatus'
    | 'error';
  // Absent on 'init' when the file could not be parsed; the webview then stays read-only.
  document?: GraphDocument;
  definitions?: NodeDefinition[];
  saveDelay?: number;
  // Whether the workspace is trusted; running graphs is disabled when it isn't.
  trusted?: boolean;
  event?: RuntimeLogEvent;
  languages?: LanguageOption[];
  compile?: CompileReport;
  run?: RunStatus;
  message?: string;
}
