// Visual IR: a language-neutral program produced from a graph document. Language packs turn it into
// source code. Names here are raw (taken from graph ids); each generator makes them legal and
// unique in its language.
import { TypeRef } from '../types';
import type { ClassMemberSpec } from './names';
import { EnumInfo, StructInfo, UserType } from '../user-types';
import type { ClassInfo, InterfaceInfo } from '../objects';

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
  // The parent class's version of a pure function (by name), reading one of its outputs.
  | { kind: 'parentCall'; function: string; args: IrExpr[]; output?: string }
  // A pure interface function (by graph id) of the Target object, reading one of its outputs.
  | { kind: 'interfaceCall'; target: IrExpr; type: string; function: string; args: IrExpr[]; output?: string };

// `+` and `-` are integer arithmetic on counters; the rest give booleans.
export type BinaryOp = '<' | '<=' | '>=' | '==' | '!=' | '&&' | '||' | '+' | '-';

// What a call runs: a code node's snippet (a helper) or a function the generated file imports.
export type IrCallee = { kind: 'helper' | 'import'; id: string };

export type IrStatement =
  | { kind: 'print'; value: IrExpr; source: SourceRef }
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
  | { kind: 'construct'; type: string; slot: string; source: SourceRef }
  | { kind: 'setObjectVariable'; target: IrExpr; type: string; variable: string; value: IrExpr; source: SourceRef }
  // A Delay: unless it is already waiting (`pending`, a bool slot), `then` runs after `duration`
  // seconds while the code after it goes on. A retriggerable one starts over instead: `generation`
  // (an int slot) counts the starts, and only the latest one's countdown runs `then`.
  | { kind: 'delay'; duration: IrExpr; pending?: string; generation?: string; then: IrStatement[]; source: SourceRef }
  // Cast To: `succeeded` runs with the value (as `type`, a class or interface) in `slot` when it is one,
  // else `failed`.
  | { kind: 'cast'; value: IrExpr; type: string; slot: string; succeeded: IrStatement[]; failed: IrStatement[]; source: SourceRef }
  // Calls an interface function (by graph id) of the Target object, each output into a slot.
  | { kind: 'interfaceCall'; target: IrExpr; type: string; function: string; args: IrExpr[]; results: { output: string; slot: string }[]; source: SourceRef }
  // Runs the parent class's version of a function (by name; each output into a slot), or its start.
  | { kind: 'parentCall'; function?: string; start?: boolean; args: IrExpr[]; results: { output: string; slot: string }[]; source: SourceRef }
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
  params: { pinId: string; type?: TypeRef }[];
  returns?: TypeRef;
  // A function with several outputs (a graph library's): its result holds them, shaped as the
  // language returns several values (an object, a tuple, a named tuple).
  outputs?: { id: string; name: string; type?: TypeRef }[];
  // A struct or enum the program uses (`id` is its type id), imported from its generated file.
  userType?: UserType;
}

// The type a structure or enumeration document declares, with each field's initial value.
export type IrDeclaration =
  | { kind: 'struct'; type: StructInfo; initial: IrExpr[] }
  | { kind: 'enum'; type: EnumInfo }
  | { kind: 'interface'; type: InterfaceInfo };

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
  // The interfaces the class itself declares (not those its ancestors already implement), with the
  // functions it gives no body, which get empty ones.
  interfaces?: { type: InterfaceInfo; stubs: ClassInfo['functions'] }[];
  // Every interface the class and its ancestors implement: generated code names their functions.
  allInterfaces?: InterfaceInfo[];
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

// The structs and enums a program uses, by type id.
export function userTypes(program: Pick<IrProgram, 'imports'>): Map<string, UserType> {
  return new Map(program.imports.flatMap((i) => (i.userType ? [[i.id, i.userType] as const] : [])));
}

// Static type of an expression, as far as it is known.
export type ProgramTypes = Pick<IrProgram, 'members' | 'slots' | 'helpers' | 'imports' | 'functions' | 'className' | 'classInfo' | 'ancestors' | 'allInterfaces' | 'declaration'>;

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
      const fn = program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === expr.function);
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
    events: program.functions.filter((f) => f.event).map((f) => ({ id: f.id, name: f.name })),
    variables: program.members.filter((m) => !m.function).map((m) => ({ id: m.id, name: m.name, ...(m.access ? { access: m.access } : {}) })),
    dispatchers: (program.dispatchers ?? []).map((d) => ({ id: d.id, name: d.name }))
  };
}
