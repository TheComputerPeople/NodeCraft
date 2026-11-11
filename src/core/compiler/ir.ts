// Visual IR: a language-neutral program produced from a graph document. Language packs turn it into
// source code. Names here are raw (taken from graph ids); each generator makes them legal and
// unique in its language.
import type { CodeMember, CodeResults } from '../model';
import { TypeRef } from '../types';
import type { ClassMemberSpec } from './names';
import { EnumInfo, StructInfo, UserType } from '../user-types';
import type { ClassInfo, CodeClassInfo, InterfaceInfo } from '../objects';

// The node a piece of IR came from, for diagnostics and node markers in generated code.
export interface SourceRef {
  graphId: string;
  nodeId: string;
  // The node's display name, e.g. "Print".
  title: string;
}

export type IrExpr =
  // A JSON value written on the graph (an unconnected input's default).
  | { kind: 'literal'; value: unknown }
  | { kind: 'default'; type?: TypeRef }
  | { kind: 'member'; member: string }
  // The stored output of an impure node.
  | { kind: 'output'; slot: string }
  | { kind: 'add'; left: IrExpr; right: IrExpr }
  // Conversions from docs/semantics.md ("Values"); generators skip them when the static type
  // already matches.
  | { kind: 'toNumber'; value: IrExpr }
  | { kind: 'toBoolean'; value: IrExpr }
  // The value as text, following docs/semantics.md ("Values").
  | { kind: 'toText'; value: IrExpr }
  // Text values joined.
  | { kind: 'concat'; parts: IrExpr[] }
  // A pure node: the callee is evaluated where the value is used, every time. `output` picks one
  // output of an imported function with several (IrImport.outputs).
  | { kind: 'call'; callee: IrCallee; args: IrExpr[]; output?: string }
  // Comparisons and logic on values whose types already match (flow control's own bookkeeping).
  | { kind: 'binary'; op: BinaryOp; left: IrExpr; right: IrExpr }
  | { kind: 'not'; value: IrExpr }
  // A new array, set or map (`type`) of the items; for a map, items alternate key and value.
  | { kind: 'makeContainer'; type: TypeRef; items: IrExpr[] }
  // An input of the function being generated (its Function Entry node's output).
  | { kind: 'param'; function: string; id: string }
  // A pure call of a function graph, reading one of its outputs.
  | { kind: 'callFunction'; function: string; args: IrExpr[]; output: string }
  // A new struct value (`type` is "struct:<Name>") from its fields, in the struct's order.
  | { kind: 'makeStruct'; type: string; fields: IrExpr[] }
  // One field (by id) of a struct value.
  | { kind: 'structField'; value: IrExpr; type: string; field: string }
  // An enum's value (`value` is the enumerator's id).
  | { kind: 'enumValue'; type: string; value: string }
  // The object the code runs in (src/core/objects.ts).
  | { kind: 'self' }
  // True if an object reference points at an object.
  | { kind: 'isValid'; value: IrExpr }
  // A variable of the Target object, of class `type` ("object:<Name>").
  | { kind: 'objectVariable'; target: IrExpr; type: string; variable: string }
  // A pure function of the Target object, reading one of its outputs when it has several.
  | { kind: 'objectCall'; target: IrExpr; type: string; function: string; args: IrExpr[]; output?: string }
  // The parent class's version of a pure function (by name), reading one of its outputs. `code`: the
  // version in the class from the project's code the chain ends in, a method of that name.
  | { kind: 'parentCall'; function: string; args: IrExpr[]; output?: string; code?: boolean }
  // A pure interface function (by graph id) of the Target object, reading one of its outputs.
  | { kind: 'interfaceCall'; target: IrExpr; type: string; function: string; args: IrExpr[]; output?: string };

// `+` and `-` are integer arithmetic on counters; the rest give booleans.
export type BinaryOp = '<' | '<=' | '>=' | '==' | '!=' | '&&' | '||' | '+' | '-';

// What a call runs: a code node's snippet (a helper) or a function the generated file imports.
export type IrCallee = { kind: 'helper' | 'import'; id: string };

export type IrStatement =
  | { kind: 'print'; value: IrExpr; source: SourceRef }
  // Fails (throws) with `message`, a text value, unless `condition` holds (Assert nodes).
  | { kind: 'assert'; condition: IrExpr; message: IrExpr; source: SourceRef }
  | { kind: 'store'; slot: string; value: IrExpr; source: SourceRef }
  | { kind: 'setMember'; member: string; value: IrExpr; source: SourceRef }
  | { kind: 'if'; condition: IrExpr; then: IrStatement[]; else: IrStatement[]; source: SourceRef }
  // Runs an impure node's snippet or function; its first data output, if any, goes to `resultSlot`,
  // or each output to a slot (`results`) for an imported function with several.
  | { kind: 'call'; callee: IrCallee; args: IrExpr[]; resultSlot?: string; results?: { output: string; slot: string }[]; source: SourceRef }
  // For Loop: `counter` (a slot) runs from `first` to `last` (both included; `last` is read before
  // each pass, as Unreal does). The loop also ends when `stop` (a bool slot) is set by Break.
  | { kind: 'for'; counter: string; first: IrExpr; last: IrExpr; stop?: string; body: IrStatement[]; source: SourceRef }
  | { kind: 'while'; condition: IrExpr; body: IrStatement[]; source: SourceRef }
  // For Each Loop: `index` and `element` (slots) take each position of `array`, which is read
  // before each pass, as Unreal does; `stop` as for `for`.
  | { kind: 'forEach'; array: IrExpr; index: string; element: string; stop?: string; body: IrStatement[]; source: SourceRef }
  // Calls a function graph; each output goes to a slot.
  | { kind: 'callFunction'; function: string; args: IrExpr[]; results: { output: string; slot: string }[]; source: SourceRef }
  // Ends the function, returning the values of its outputs (in signature order).
  | { kind: 'return'; values: IrExpr[]; source: SourceRef }
  // Runs a shared block: a node reached by more than one exec wire, plus everything after it.
  | { kind: 'callBlock'; block: string; source: SourceRef }
  // Binds (or unbinds) a custom event of this object (an IrFunction's id) to an event dispatcher of
  // this object, or (with `target`) of another object of class `type`.
  | { kind: 'bindEvent'; dispatcher: string; event: string; bind: boolean; target?: IrExpr; type?: string; source: SourceRef }
  | { kind: 'unbindAll'; dispatcher: string; target?: IrExpr; type?: string; source: SourceRef }
  // Runs every event bound to the dispatcher, in the order they were bound.
  | { kind: 'broadcast'; dispatcher: string; args: IrExpr[]; target?: IrExpr; type?: string; source: SourceRef }
  // A new object of class `type` into `slot`, its Start events run.
  // `args`: the parent constructor's, for a class extending code that takes them (docs/code-classes-as-parents.md).
  | { kind: 'construct'; type: string; slot: string; args?: IrExpr[]; source: SourceRef }
  | { kind: 'setObjectVariable'; target: IrExpr; type: string; variable: string; value: IrExpr; source: SourceRef }
  // A Delay: unless it is already waiting (`pending`, a bool slot), `then` runs after `duration`
  // seconds while the code after it goes on. A retriggerable one starts over instead: `generation`
  // (an int slot) counts the starts, and only the latest one's countdown runs `then`.
  | { kind: 'delay'; duration: IrExpr; pending?: string; generation?: string; then: IrStatement[]; source: SourceRef }
  // An async function from the project's code (docs/node-authoring.md, gap 4): called at once, the
  // code after it going on; when it finishes, its value (if it gives one) goes into `resultSlot`
  // and `then` runs, from the latent queue. A failure stops the run with its error.
  | { kind: 'await'; callee: IrCallee; args: IrExpr[]; resultSlot?: string; then: IrStatement[]; source: SourceRef }
  // Cast To: `succeeded` runs with the value (as `type`, a class or interface) in `slot` when it is one,
  // else `failed`.
  | { kind: 'cast'; value: IrExpr; type: string; slot: string; succeeded: IrStatement[]; failed: IrStatement[]; source: SourceRef }
  // Calls an interface function (by graph id) of the Target object, each output into a slot.
  | { kind: 'interfaceCall'; target: IrExpr; type: string; function: string; args: IrExpr[]; results: { output: string; slot: string }[]; source: SourceRef }
  // Runs the parent class's version of a function (by name; each output into a slot), or its start.
  // `code`: the version in the class from the project's code the chain ends in, a method of that name.
  | { kind: 'parentCall'; function?: string; start?: boolean; code?: boolean; args: IrExpr[]; results: { output: string; slot: string }[]; source: SourceRef }
  // Calls a function (each output into a slot) or runs a custom event (by name) of the Target object.
  | { kind: 'objectCall'; target: IrExpr; type: string; function?: string; event?: string; args: IrExpr[]; results: { output: string; slot: string }[]; source: SourceRef };

// A member variable of the generated class, or (with `function`) a local variable of a function,
// which starts at its initial value on every call.
export interface IrMember {
  id: string;
  name: string;
  type?: TypeRef;
  initial: IrExpr;
  function?: string;
  // A member variable's access (public when absent).
  access?: 'protected' | 'private';
}

// Storage for one output pin of an impure node (or a node's remembered state). Slots of nodes in a
// function (`function`) are local to each call, so recursion works.
export interface IrSlot {
  id: string;
  // Suggested base name, e.g. "add_1_result".
  name: string;
  type?: TypeRef;
  source: SourceRef;
  function?: string;
}

// A function graph, generated as a method.
export interface IrFunction {
  // The graph id.
  id: string;
  name: string;
  params: { id: string; name: string; type?: TypeRef }[];
  outputs: { id: string; name: string; type?: TypeRef }[];
  pure: boolean;
  description?: string;
  body: IrStatement[];
  // Replaces the parent class's function of the same name (C# needs `override`).
  overrides?: boolean;
  // Overrides the method of this name of the class from the project's code the class extends
  // (docs/code-classes-as-parents.md): generated with the code's names for it and its parameters
  // (`params[].name`). A function, or an override event (with `event`).
  code?: string;
  // Its access (public when absent).
  access?: 'protected' | 'private';
  // A custom event (docs/program-structure.md, "Custom events and event dispatchers"): its inputs
  // read outside its own flow are kept in these slots when it runs, as Unreal keeps an event's
  // outputs.
  event?: { stores: { param: string; slot: string }[]; entry?: string };
}

// An event dispatcher of the class: bound events take these parameters.
export interface IrDispatcher {
  id: string;
  name: string;
  params: { id: string; name: string; type?: TypeRef }[];
}

// A code node's snippet, wrapped as a function of its data inputs.
export interface IrCodeHelper {
  id: string;
  // Suggested base name, derived from the node type.
  name: string;
  params: { pinId: string; type?: TypeRef }[];
  returns?: TypeRef;
  code: string;
}

// A function from the project's code (docs/code-as-nodes.md, "Generated imports").
export interface IrImport {
  // The node type.
  id: string;
  // The function's exported name.
  name: string;
  language: string;
  // The module's workspace-relative path.
  path: string;
  // Python: the module's import name.
  module?: string;
  // Each argument; `borrowed` when the code takes it by shared reference (FunctionImplementation).
  params: { pinId: string; type?: TypeRef; borrowed?: boolean }[];
  // C++: a C function, whose header is included in extern "C" (FunctionImplementation.linkage).
  linkage?: 'c';
  returns?: TypeRef;
  // A function with several outputs (a graph library's): its result holds them, shaped as the
  // language returns several values (an object, a tuple, a named tuple).
  outputs?: { id: string; name: string; type?: TypeRef }[];
  // A struct or enum the program uses (`id` is its type id), imported from its generated file.
  userType?: UserType;
  // A member of a class in the project's code: `name` is the class, and the first param the Target
  // (but not for construct).
  member?: CodeMember;
  // Construct: the classes the class extends, nearest first, as far as the workspace knows them
  // (C++ keeps the object as each, so members of any of them reach it).
  bases?: { name: string; module?: string }[];
  // A project function with several outputs: how its code gives them (with `outputs`).
  results?: CodeResults;
}

// Imports of one name from one module share one local name (a class's member nodes all import
// the class).
export function importKey(i: IrImport): string {
  return `${i.path}\u0000${i.module ?? ''}\u0000${i.name}`;
}

// The type a structure or enumeration document declares, with each field's initial value.
export type IrDeclaration =
  | { kind: 'struct'; type: StructInfo; initial: IrExpr[] }
  | { kind: 'enum'; type: EnumInfo }
  | { kind: 'interface'; type: InterfaceInfo };

// A pin whose value a paused debugger can read (docs/debugging.md, "Values"): its storage in the
// generated code (an impure node's slot, a variable, a function input) or a literal.
export interface IrPinValue {
  graphId: string;
  nodeId: string;
  pinId: string;
  value: IrExpr;
}

// Whether running the statements can reach their end: not when the last returns, or is an if
// whose two sides both return. A function's fallback return goes there only then (Java refuses an
// unreachable statement, TypeScript's allowUnreachableCode: false too).
export function canComplete(statements: IrStatement[]): boolean {
  const last = statements[statements.length - 1];
  if (!last) return true;
  if (last.kind === 'return') return false;
  if (last.kind === 'if') return canComplete(last.then) || canComplete(last.else);
  return true;
}

// Expressions that only read storage, so evaluating them in a paused frame runs nothing.
export function readsStorageOnly(e: IrExpr): boolean {
  switch (e.kind) {
    case 'literal':
    case 'member':
    case 'output':
    case 'param':
    case 'self':
    case 'enumValue':
      return true;
    case 'structField':
      return readsStorageOnly(e.value);
    case 'objectVariable':
      return readsStorageOnly(e.target);
    default:
      return false;
  }
}

export interface IrBlock {
  id: string;
  name: string;
  body: IrStatement[];
}

export interface IrProgram {
  className: string;
  // A function library: free functions (TypeScript, JavaScript, Python) or a static class (C#)
  // instead of a class with a start method.
  library?: boolean;
  members: IrMember[];
  slots: IrSlot[];
  helpers: IrCodeHelper[];
  imports: IrImport[];
  blocks: IrBlock[];
  functions: IrFunction[];
  // Body of the class's start method: every Start node, in graph and node order.
  start: IrStatement[];
  // A structure or enumeration document: the generated file declares this type instead of a class.
  declaration?: IrDeclaration;
  dispatchers?: IrDispatcher[];
  // A class: its public members, as other files see them (src/core/objects.ts).
  classInfo?: ClassInfo;
  // Its ancestors, nearest first, when it has a parent class.
  ancestors?: ClassInfo[];
  // Whether the graph has Start nodes: a subclass without any keeps its parent's start.
  hasStart?: boolean;
  // The classes from the project's code that the chains of this class and the classes it uses end
  // in (docs/code-classes-as-parents.md): generated code names members apart from theirs. The
  // class's own code parent is imported too (`imports`, by its id).
  codeClasses?: CodeClassInfo[];
  // The class leaves abstract methods of its code parent for a subclass to override.
  abstract?: boolean;
  // The interfaces the class itself declares (not those its ancestors already implement), with the
  // functions it gives no body, which get empty ones.
  interfaces?: { type: InterfaceInfo; stubs: ClassInfo['functions'] }[];
  // Every interface the class and its ancestors implement: generated code names their functions.
  allInterfaces?: InterfaceInfo[];
  // Pins the debugger can read, for GeneratedCode.pinExpressions.
  pinValues?: IrPinValue[];
  // The class's Test Case events (docs/debugging.md, "Test Case"): each a method a test runs on a
  // new object.
  tests?: IrTest[];
}

export interface IrTest {
  id: string;
  name: string;
  body: IrStatement[];
}

// An interface a program knows: one it implements, or one it imports.
export function interfaceInfo(program: Pick<IrProgram, 'imports' | 'allInterfaces' | 'declaration'>, id: string): InterfaceInfo | undefined {
  if (program.declaration?.kind === 'interface' && program.declaration.type.id === id) return program.declaration.type;
  const known = program.allInterfaces?.find((i) => i.id === id);
  if (known) return known;
  const type = program.imports.find((i) => i.id === id)?.userType;
  return type?.kind === 'interface' ? type : undefined;
}

// The class an "object:<Name>" type names: the program's own, or one it imports.
export function classInfo(program: Pick<IrProgram, 'imports' | 'classInfo'> & { ancestors?: ClassInfo[] }, id: string): ClassInfo | undefined {
  if (program.classInfo?.id === id) return program.classInfo;
  const ancestor = program.ancestors?.find((a) => a.id === id);
  if (ancestor) return ancestor;
  const type = program.imports.find((i) => i.id === id)?.userType;
  return type?.kind === 'class' ? type : undefined;
}

// Whether a class's parent is a class from the project's code ("code:<language>:<path>#<Class>"),
// not a graph class.
export function isCodeClassId(id: string | undefined): boolean {
  return !!id?.startsWith('code:');
}

// The class from the project's code that the chain of class `id` (the program's own when absent)
// ends in (docs/code-classes-as-parents.md).
export function codeParentInfo(program: Pick<IrProgram, 'imports' | 'classInfo'> & { ancestors?: ClassInfo[]; codeClasses?: CodeClassInfo[] }, id?: string): CodeClassInfo | undefined {
  const seen = new Set<string>();
  for (let info = id ? classInfo(program, id) : program.classInfo; info && !seen.has(info.id);) {
    seen.add(info.id);
    if (isCodeClassId(info.parent)) return program.codeClasses?.find((c) => c.id === info!.parent);
    info = info.parent ? classInfo(program, info.parent) : undefined;
  }
  return undefined;
}

// Whether a function reads one of its parameters, in its body or its event's stores. (C++ warns of
// an override's parameter it doesn't.)
export function readsParam(fn: IrFunction, id: string): boolean {
  if (fn.event?.stores.some((s) => s.param === id)) return true;
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!value || typeof value !== 'object') return false;
    const node = value as Record<string, unknown>;
    if (node.kind === 'param' && node.function === fn.id && node.id === id) return true;
    return Object.values(node).some(visit);
  };
  return visit(fn.body);
}

// The data pins of a function's or event's inputs: the parameters a call passes, in order.
export function dataPins<P extends { kind: string; type?: TypeRef }>(pins: readonly P[] | undefined): P[] {
  return pins?.filter((p) => p.kind === 'data') ?? [];
}

// The parameters a dispatcher's Call passes: this object's dispatcher, or (with `target`) another class's.
export function broadcastParams(program: Pick<IrProgram, 'imports' | 'classInfo' | 'dispatchers'> & { ancestors?: ClassInfo[] }, s: Extract<IrStatement, { kind: 'broadcast' }>): { type?: TypeRef }[] {
  if (s.target && s.type) return dataPins(classInfo(program, s.type)?.dispatchers.find((d) => d.id === s.dispatcher)?.inputs);
  return program.dispatchers?.find((d) => d.id === s.dispatcher)?.params ?? [];
}

// The parameters an interface, parent or object call passes, in order.
type TargetCall = Extract<IrStatement | IrExpr, { kind: 'interfaceCall' | 'parentCall' | 'objectCall' }>;
export function targetCallParams(program: Pick<IrProgram, 'imports' | 'classInfo' | 'allInterfaces' | 'declaration'> & { ancestors?: ClassInfo[]; codeClasses?: CodeClassInfo[] }, call: TargetCall): { type?: TypeRef }[] {
  switch (call.kind) {
    case 'interfaceCall':
      return dataPins(interfaceInfo(program, call.type)?.functions.find((f) => f.id === call.function)?.inputs);
    case 'parentCall':
      if (call.code) return dataPins(codeParentInfo(program)?.overridable.find((m) => m.name === call.function)?.inputs);
      return dataPins(program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === call.function)?.inputs);
    case 'objectCall': {
      const info = classInfo(program, call.type);
      return dataPins(call.function !== undefined ? info?.functions.find((f) => f.id === call.function)?.inputs : 'event' in call ? info?.events.find((e) => e.id === call.event)?.inputs : undefined);
    }
  }
}

// The structs and enums a program uses, by type id.
export function userTypes(program: Pick<IrProgram, 'imports'>): Map<string, UserType> {
  return new Map(program.imports.flatMap((i) => (i.userType ? [[i.id, i.userType] as const] : [])));
}

// Static type of an expression, as far as it is known.
export type ProgramTypes = Pick<IrProgram, 'members' | 'slots' | 'helpers' | 'imports' | 'functions' | 'className' | 'classInfo' | 'ancestors' | 'allInterfaces' | 'declaration' | 'codeClasses'>;

export function exprType(expr: IrExpr, program: ProgramTypes): TypeRef | undefined {
  switch (expr.kind) {
    case 'literal':
      return literalType(expr.value);
    case 'default':
      return expr.type;
    case 'member':
      return program.members.find((m) => m.id === expr.member)?.type;
    case 'output':
      return program.slots.find((s) => s.id === expr.slot)?.type;
    case 'add':
    case 'toNumber':
      return { id: 'float' };
    case 'toBoolean':
      return { id: 'bool' };
    case 'toText':
    case 'concat':
      return { id: 'string' };
    case 'call': {
      const signature = calleeSignature(expr.callee, program);
      if (expr.output && signature && 'outputs' in signature) return signature.outputs?.find((o) => o.id === expr.output)?.type;
      return signature?.returns;
    }
    case 'binary':
      return expr.op === '+' || expr.op === '-' ? exprType(expr.left, program) : { id: 'bool' };
    case 'not':
      return { id: 'bool' };
    case 'makeContainer':
      return expr.type;
    case 'param':
      return program.functions.find((f) => f.id === expr.function)?.params.find((p) => p.id === expr.id)?.type;
    case 'callFunction':
      return program.functions.find((f) => f.id === expr.function)?.outputs.find((o) => o.id === expr.output)?.type;
    case 'makeStruct':
    case 'enumValue':
      return { id: expr.type };
    case 'structField': {
      const type = program.imports.find((i) => i.id === expr.type)?.userType;
      return type?.kind === 'struct' ? type.fields.find((f) => f.id === expr.field)?.type : undefined;
    }
    case 'self':
      return { id: `object:${program.className}` };
    case 'isValid':
      return { id: 'bool' };
    case 'objectVariable':
      return classInfo(program, expr.type)?.variables.find((v) => v.id === expr.variable)?.type;
    case 'objectCall': {
      const outputs = classInfo(program, expr.type)?.functions.find((f) => f.id === expr.function)?.outputs.filter((p) => p.kind === 'data') ?? [];
      return (expr.output ? outputs.find((p) => p.id === expr.output) : outputs[0])?.type;
    }
    case 'interfaceCall': {
      const outputs = interfaceInfo(program, expr.type)?.functions.find((f) => f.id === expr.function)?.outputs.filter((p) => p.kind === 'data') ?? [];
      return (expr.output ? outputs.find((p) => p.id === expr.output) : outputs[0])?.type;
    }
    case 'parentCall': {
      const fn = expr.code ? codeParentInfo(program)?.overridable.find((m) => m.name === expr.function) : program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === expr.function);
      const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
      return (expr.output ? outputs.find((p) => p.id === expr.output) : outputs[0])?.type;
    }
  }
}

export function calleeSignature(callee: IrCallee, program: Pick<IrProgram, 'helpers' | 'imports'>): IrCodeHelper | IrImport | undefined {
  return callee.kind === 'helper' ? program.helpers.find((h) => h.id === callee.id) : program.imports.find((i) => i.id === callee.id);
}

function literalType(value: unknown): TypeRef | undefined {
  if (typeof value === 'number') return { id: Number.isInteger(value) ? 'int' : 'float' };
  if (typeof value === 'string') return { id: 'string' };
  if (typeof value === 'boolean') return { id: 'bool' };
  return undefined;
}

// A program's public members, in the order claimClassMembers names them (src/core/compiler/names.ts).
export function programClassSpec(program: IrProgram): ClassMemberSpec {
  return {
    functions: program.functions.filter((f) => !f.event).map((f) => ({ id: f.id, name: f.name, ...(f.access ? { access: f.access } : {}) })),
    // (An override event is named by the code: it isn't one of the class's events.)
    events: program.functions.filter((f) => f.event && !f.code).map((f) => ({ id: f.id, name: f.name })),
    variables: program.members.filter((m) => !m.function).map((m) => ({ id: m.id, name: m.name, ...(m.access ? { access: m.access } : {}) })),
    dispatchers: (program.dispatchers ?? []).map((d) => ({ id: d.id, name: d.name }))
  };
}
