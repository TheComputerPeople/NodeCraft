import type { LanguageCapabilities } from './language-pack';
import type { CompileDiagnostic } from './compiler/diagnostics';
import type { DefinitionSite } from './navigation';
import type { SearchHit } from './search';
import type { LanguageTerms } from './terms';
import type { NodePreview } from './preview';
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
  // Unreal's AdvancedDisplay: folded under the node's arrow until opened, wired or set.
  advanced?: boolean;
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
  // What the node needs from a graph's language beyond what its kind and pin types already say
  // (src/core/capabilities.ts), e.g. "async" for a latent node of a library.
  requires?: Capability[];
  // The package it comes from (src/core/node-packages.ts), set when packages are resolved.
  library?: { name: string; version: string };
  // Node types that used to mean this node: graphs that still use one get this node, and are
  // saved with its type (a function library's functions were "fn:" nodes of its generated file).
  aliases?: string[];
  // A latent node (docs/program-structure.md, "Latent actions"; Delay, or an async function from
  // code): drawn with a clock, and its Completed output runs later, from the latent queue.
  latent?: boolean;
  // Unreal's CompactNodeTitle: drawn without a title bar, this text large in the middle (as + is).
  compactTitle?: string;
  // Unreal's DeprecatedFunction: left out of the palette; its nodes show and compile with a warning.
  deprecated?: { message?: string };
  // Inputs and the outputs they give, which Test Node Library runs in each language
  // (src/core/node-examples.ts).
  examples?: NodeExample[];
}

// One example of a node: its inputs' values, and the values its outputs give then (by pin id).
export interface NodeExample {
  description?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

// A language feature a graph can need (docs/language-breadth.md, "Capabilities, enforced").
export type Capability = 'classes' | 'inheritance' | 'interfaces' | 'async' | 'delegates' | 'generics' | 'exceptions' | 'array' | 'set' | 'map';

export type NodeImplementation =
  | { kind: 'native'; operation: string }
  | { kind: 'code'; languages: Record<string, string>; defaultLanguage?: string }
  | FunctionImplementation
  | MacroImplementation
  // A struct's Make, Break and Set Members, and an enum's Switch on, == and != (src/core/user-types.ts).
  | { kind: 'struct'; operation: 'make' | 'break' | 'set-members'; type: StructInfo }
  | { kind: 'enum'; operation: 'switch' | 'equal' | 'not-equal'; type: EnumInfo }
  // An entry event that something outside the graph runs, by calling the method generated for it:
  // Main (Run calls it with the program's arguments) and framework packs' events
  // (docs/program-structure.md, "Entry points and framework packs"). Its data outputs are the
  // method's parameters; `method` is its name before each language's naming style.
  | { kind: 'event'; method: string }
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
  // The module's language ("typescript", "python", …); a library's first language.
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
  // A library generated for several languages: the function in each of its other languages.
  variants?: Record<string, FunctionVariant>;
  // A member of a class in the project's code (docs/node-authoring.md, gap 2): `name` is the class
  // other code imports, and generated code constructs it, or calls or reads or writes the member on
  // the Target pin's object.
  member?: CodeMember;
  // A function of the project's code with several outputs (docs/node-authoring.md, gap 3): how the
  // code gives them.
  results?: CodeResults;
  // The input pins the code takes by shared reference (Rust's &str and &[T]): generated code passes
  // a borrow of the value.
  borrowed?: string[];
  // C++: a C function, in a header without extern "C" of its own: generated code includes the
  // header in extern "C", so the call links to the C object file.
  linkage?: 'c';
  // Unreal's ExpandBoolAsExecs and ExpandEnumAsExecs (`@execs`, gap 6): the bool or graph enum it
  // returns picks one of its exec outputs, which stand for its Return Value. 'enum' is asked for (a
  // return type that may be a graph enum); { enum } is the enum it turned out to be
  // (src/core/user-types.ts, adoptUserTypes).
  execs?: 'bool' | 'enum' | { enum: string };
}

// How a function in the project's code gives several outputs.
export interface CodeResults {
  // fields: members of the value it returns (an object, a record); tuple: the positions of the tuple,
  // array or list of values it returns; out: its out parameters, after the inputs (and the value it
  // returns, when `returnValue`, as the first output).
  kind: 'fields' | 'tuple' | 'out';
  // Each output's name in the code, in pin order (for out, the out parameters').
  names: string[];
  // Each out parameter's type as the code spells it, for languages that declare its variable (C++).
  types?: string[];
  returnValue?: boolean;
  // Go: a last `error` result, which isn't an output: when it isn't nil, the run stops with it.
  error?: boolean;
}

export interface CodeMember {
  kind: 'construct' | 'method' | 'get' | 'set';
  // The method's or property's name in the code (absent for construct).
  name?: string;
  // The class's type ("native:Warrior"), and the type of the class it extends, so an object of it
  // wires where the base class is expected.
  type: string;
  base?: string;
}

// A library function as another language's generated file has it.
export interface FunctionVariant {
  path: string;
  name: string;
  module?: string;
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
  // An input shown under the node's arrow (Unreal's Advanced View).
  advanced?: boolean;
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
  // Unreal's metadata (src/core/metadata.ts): more words the action menu finds it by, a compact
  // title, and whether it's deprecated (with a message saying what to use instead).
  keywords?: string[];
  compactTitle?: string;
  deprecated?: { message?: string };
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
  // A structure's, enumeration's or function library's other target languages: it's generated for
  // each of them too, so graphs in any of them use it (docs/multi-language.md, gap 2;
  // docs/node-authoring.md, gap 1).
  languages?: string[];
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
  // test.pass, test.fail: a test finished (Run Tests in Simulate); `test` is its name.
  kind: 'node.enter' | 'node.exit' | 'log' | 'error' | 'graph.complete' | 'test.pass' | 'test.fail';
  // The graph the node belongs to; node ids are only unique within a graph.
  graphId?: string;
  // Set when the node is in another graph file (a function library's), relative to the workspace.
  document?: string;
  nodeId?: string;
  nodeType?: string;
  // node.enter: the exec wire execution arrived through, if any (the editor pulses it).
  connectionId?: string;
  test?: string;
  values?: Record<string, unknown>;
  message?: string;
}

// A frame of the call stack in graph terms (docs/debugging.md): the graph, and the node running in
// it (in the frames below the top, the node that made the call).
export interface DebugFrame {
  graphId: string;
  graphName: string;
  nodeId: string;
  // The node's title, for frames in files the editor doesn't have open.
  nodeName: string;
  // Set when the graph is in another graph file, relative to the workspace (as in RuntimeLogEvent).
  document?: string;
}

// A pin's value while paused, as text, or why there is none.
export interface DebugValue {
  value?: string;
  unavailable?: string;
}

// A pin whose value the editor asks for (hovered or watched).
export interface PinRef {
  graphId: string;
  nodeId: string;
  pinId: string;
}

// What the debugger's buttons and keys do (F5, F10, F11, Shift+F11, Shift+F5).
export type DebugAction = 'resume' | 'stepOver' | 'stepInto' | 'stepOut' | 'stop';

// A frame as an editor panel shows it: which file it is in, and whether that is the panel's own.
export interface DebugStackFrame extends DebugFrame {
  uri: string;
  fileName: string;
  here: boolean;
  // A frame outside generated code (a library's, the runtime's), named by its own function.
  external?: boolean;
}

// A debug Simulate session, as the editor shows it. While paused, `stack` is the call stack,
// innermost first; its first frame's node is about to run.
export interface DebugState {
  state: 'running' | 'paused' | 'ended';
  stack?: DebugStackFrame[];
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
  // The keys of a code node's snippets it can use, and the node types its pack implements itself;
  // the editor hides code nodes with neither (docs/multi-language.md, gap 3).
  snippetLanguages?: string[];
  snippets?: string[];
  // What it can express; the editor hides the rest.
  capabilities?: LanguageCapabilities;
  // Its words for containers and types (src/core/terms.ts), for the editor to show.
  terms?: LanguageTerms;
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

// A breakpoint on a node (docs/debugging.md): editor state, never part of the graph file.
export interface GraphBreakpoint {
  graphId: string;
  nodeId: string;
  enabled: boolean;
}

// A function library file and its contents, for Collapse to Function in Library.
export interface LibraryFile {
  // Relative to the workspace folder, with "/" separators.
  path: string;
  document: GraphDocument;
}

export interface UIMessage {
  // run: compile, then run the generated code; simulate: run in the editor's interpreter.
  // findInAll: search every graph in the workspace; reveal: open another file at a hit.
  // setBreakpoints, setWatches: the file's breakpoints or watched pins changed; debugAction: a
  // debugger button; readValues: pins' values while paused (answered by 'debugValues').
  // debug: compile, then run the generated code under the language's debugger.
  // pickFunctionLibrary: ask which function library to collapse into (answered by
  // 'functionLibrary'); saveLibrary: write that library with the new function.
  // goToDefinition: open where `nodeType` is defined (`site`, outside this file); findReferences:
  // every node of `nodeType` in the workspace (answered by 'findResults').
  // previewNode: the code a node of `nodeType` with `properties` becomes in `document`'s language
  // (answered by 'nodePreview'; docs/language-context.md, part 3).
  // graphHistory: whether the graph tabs' Back and Forward can go anywhere (`canGoBack`,
  // `canGoForward`), for the host's Alt+Left and Alt+Right.
  type: 'ready' | 'applyDocument' | 'compile' | 'run' | 'simulate' | 'debug' | 'findInAll' | 'reveal' | 'setBreakpoints' | 'setWatches' | 'debugAction' | 'readValues' | 'pickFunctionLibrary' | 'saveLibrary' | 'goToDefinition' | 'findReferences' | 'previewNode' | 'graphHistory';
  canGoBack?: boolean;
  canGoForward?: boolean;
  document?: GraphDocument;
  nodeType?: string;
  properties?: Record<string, unknown>;
  site?: DefinitionSite;
  library?: LibraryFile;
  breakpoints?: GraphBreakpoint[];
  watches?: PinRef[];
  action?: DebugAction;
  requestId?: number;
  pins?: PinRef[];
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
    // Back or Forward through the graphs shown (`direction`), from Alt+Left and Alt+Right.
    | 'navigateGraph'
    // Refresh every project function node whose code changed (Unreal's Refresh All Nodes).
    | 'refreshAll'
    // The file's breakpoints (also part of 'init').
    | 'breakpoints'
    // The file's watched pins (also part of 'init').
    | 'watches'
    // The languages changed (a pack registered or removed); `languages` is the new list.
    | 'languages'
    // Simulate's debugger paused, resumed or ended.
    | 'debugState'
    // Answers 'readValues', in the order asked.
    | 'debugValues'
    // Answers 'pickFunctionLibrary': the library chosen (none when the pick was cancelled).
    | 'functionLibrary'
    // Answers 'previewNode': the node's code (none when it has no preview).
    | 'nodePreview'
    | 'error';
  preview?: NodePreview;
  library?: LibraryFile;
  breakpoints?: GraphBreakpoint[];
  watches?: PinRef[];
  debug?: DebugState;
  requestId?: number;
  values?: DebugValue[];
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
  direction?: 'back' | 'forward';
  target?: RevealTarget;
  message?: string;
}
