import type { CompileDiagnostic } from './compiler/diagnostics';
import type { SearchHit } from './search';
import type { TypeRef } from './types';
import type { EnumInfo, Enumerator, StructInfo } from './user-types';
import type { Dispatcher } from './events';
import type { ClassInfo, InterfaceInfo } from './objects';

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
  // A pin of a split struct pin: the struct pin and the field it stands for (src/core/user-types.ts).
  split?: { pin: string; field: string };
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
  | { kind: 'subgraph'; graph: string }
  | FunctionImplementation
  | MacroImplementation
  // A struct's Make, Break and Set Members, and an enum's Switch on, == and != (src/core/user-types.ts).
  | { kind: 'struct'; operation: 'make' | 'break' | 'set-members'; type: StructInfo }
  | { kind: 'enum'; operation: 'switch' | 'equal' | 'not-equal'; type: EnumInfo }
  // A class's Construct node, which carries the class's public members, and its Cast To node; an
  // interface's Cast To node, which carries its functions (src/core/objects.ts).
  | { kind: 'class'; operation: 'construct' | 'cast'; type: ClassInfo }
  | { kind: 'interface'; operation: 'cast'; type: InterfaceInfo };

// A macro of a macro library (src/core/libraries.ts): its graph, with the library's other macros
// already expanded in it, so it can be expanded anywhere (src/core/macros.ts).
export interface MacroImplementation {
  kind: 'macro';
  graph: Graph;
  // The library's .vgraph file (workspace-relative) and the macro's graph id.
  source: { document: string; graph: string };
  // The library's language: graphs in other languages can't use it. Absent: any language.
  language?: string;
  // Why the macro can't be used, e.g. it uses itself.
  error?: string;
}

// A function in the project's own code, which generated code imports (docs/code-as-nodes.md).
export interface FunctionImplementation {
  kind: 'function';
  // The module's language: "typescript", "javascript" or "python".
  language: string;
  // The module's path relative to the workspace folder, with "/" separators.
  path: string;
  // The function's exported name.
  name: string;
  // Python: the module's import name, e.g. "game.combat".
  module?: string;
  // A function of a graph library: its .vgraph file (workspace-relative) and function graph, so
  // Simulate can run it (src/core/libraries.ts).
  source?: { document: string; graph: string };
}

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

// Who may use a class's variable or function, as Unreal's Private flag and Access Specifier:
// anyone (the default), the class and its subclasses, or the class alone.
export type Access = 'public' | 'protected' | 'private';

export interface GraphVariable {
  id: string;
  name: string;
  type: TypeRef;
  defaultValue?: unknown;
  access?: Access;
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
  // Shown on call nodes and in the palette, as Unreal's function Description and Category.
  description?: string;
  category?: string;
  // A class function's Access Specifier (public when absent).
  access?: Access;
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
// Structures and enumerations declare a type and have no graphs (src/core/user-types.ts).
export type DocumentKind = 'class' | 'functionLibrary' | 'macroLibrary' | 'structure' | 'enumeration' | 'interface';

// The contents of a .vgraph file (schema version 3).
export interface GraphDocument {
  schemaVersion: number;
  name: string;
  kind: DocumentKind;
  language?: string;
  // Member variables; a structure's fields; libraries and enumerations have none.
  variables: GraphVariable[];
  graphs: Graph[];
  // An enumeration's values, in order.
  enumerators?: Enumerator[];
  // A class's event dispatchers (src/core/events.ts).
  dispatchers?: Dispatcher[];
  // A class's parent class ("object:<Name>"), as Unreal's Parent Class in Class Settings.
  parent?: string;
  // The interfaces ("interface:<Name>") a class implements, as in Class Settings.
  interfaces?: string[];
  // The signature of each project function the graphs call, by node type, as it was when its
  // nodes were made or last refreshed (docs/code-as-nodes.md, "When the code changes").
  importedFunctions?: Record<string, NodeDefinition>;
  metadata?: Record<string, unknown>;
  // Fields this version doesn't know about are preserved on save.
  [extra: string]: unknown;
}

export interface RuntimeLogEvent {
  kind: 'node.enter' | 'node.exit' | 'log' | 'error' | 'graph.complete';
  // The graph the node belongs to; node ids are only unique within a graph.
  graphId?: string;
  // Set when the node is in another graph file (a function library's), relative to the workspace.
  document?: string;
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
  // Languages of project functions a graph in this language can call (docs/code-as-nodes.md).
  callable: string[];
}

// A Find in All Blueprints hit: a search hit plus the file it is in.
export interface FileSearchHit extends SearchHit {
  uri: string;
  // Workspace-relative path, for display.
  file: string;
  // The hit is in the document of the editor that asked.
  current: boolean;
}

// Where to jump to: a hit in the current document, or in another file (`uri`).
export interface RevealTarget {
  uri?: string;
  kind: SearchHit['kind'];
  id: string;
  graphId?: string;
}

export interface UIMessage {
  // run: compile, then run the generated code; simulate: run in the editor's interpreter.
  // findInAll: search every graph in the workspace; reveal: open another file at a hit.
  type: 'ready' | 'applyDocument' | 'compile' | 'run' | 'simulate' | 'findInAll' | 'reveal';
  document?: GraphDocument;
  query?: string;
  target?: RevealTarget;
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
    | 'findResults'
    | 'reveal'
    | 'openFind'
    // Refresh every project function node whose code changed (Unreal's Refresh All Nodes).
    | 'refreshAll'
    | 'error';
  // Absent on 'init' when the file could not be parsed; the webview then stays read-only.
  document?: GraphDocument;
  definitions?: NodeDefinition[];
  // Whether the project's functions have been scanned, so a missing one is really gone.
  functionsLoaded?: boolean;
  saveDelay?: number;
  // Whether the workspace is trusted; running graphs is disabled when it isn't.
  trusted?: boolean;
  event?: RuntimeLogEvent;
  languages?: LanguageOption[];
  compile?: CompileReport;
  run?: RunStatus;
  results?: FileSearchHit[];
  // openFind: search every file (Find in All Blueprints) rather than this one.
  findAll?: boolean;
  target?: RevealTarget;
  message?: string;
}
