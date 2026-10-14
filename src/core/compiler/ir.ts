// Visual IR: a language-neutral program produced from a graph document. Language packs turn it into
// source code. Names here are raw (taken from graph ids); each generator makes them legal and
// unique in its language.
import { TypeRef } from '../types';

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
  // A pure node: the callee is evaluated where the value is used, every time.
  | { kind: 'call'; callee: IrCallee; args: IrExpr[] };

// What a call runs: a code node's snippet (a helper) or a function the generated file imports.
export type IrCallee = { kind: 'helper' | 'import'; id: string };

export type IrStatement =
  | { kind: 'print'; value: IrExpr; source: SourceRef }
  | { kind: 'store'; slot: string; value: IrExpr; source: SourceRef }
  | { kind: 'setMember'; member: string; value: IrExpr; source: SourceRef }
  | { kind: 'if'; condition: IrExpr; then: IrStatement[]; else: IrStatement[]; source: SourceRef }
  // Runs an impure node's snippet or function; its first data output, if any, goes to `resultSlot`.
  | { kind: 'call'; callee: IrCallee; args: IrExpr[]; resultSlot?: string; source: SourceRef }
  // Runs a shared block: a node reached by more than one exec wire, plus everything after it.
  | { kind: 'callBlock'; block: string; source: SourceRef };

// A member variable of the generated class.
export interface IrMember {
  id: string;
  name: string;
  type?: TypeRef;
  initial: IrExpr;
}

// Storage for one output pin of an impure node.
export interface IrSlot {
  id: string;
  // Suggested base name, e.g. "add_1_result".
  name: string;
  type?: TypeRef;
  source: SourceRef;
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
}

export interface IrBlock {
  id: string;
  name: string;
  body: IrStatement[];
}

export interface IrProgram {
  className: string;
  members: IrMember[];
  slots: IrSlot[];
  helpers: IrCodeHelper[];
  imports: IrImport[];
  blocks: IrBlock[];
  // Body of the class's start method: every Start node, in graph and node order.
  start: IrStatement[];
}

// Static type of an expression, as far as it is known.
export type ProgramTypes = Pick<IrProgram, 'members' | 'slots' | 'helpers' | 'imports'>;

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
    case 'call':
      return calleeSignature(expr.callee, program)?.returns;
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
