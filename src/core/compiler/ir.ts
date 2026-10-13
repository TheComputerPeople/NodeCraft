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
  | { kind: 'toBoolean'; value: IrExpr };

export type IrStatement =
  | { kind: 'print'; value: IrExpr; source: SourceRef }
  | { kind: 'store'; slot: string; value: IrExpr; source: SourceRef }
  | { kind: 'setMember'; member: string; value: IrExpr; source: SourceRef }
  | { kind: 'if'; condition: IrExpr; then: IrStatement[]; else: IrStatement[]; source: SourceRef }
  // Runs a code node's snippet; its first data output, if any, goes to `resultSlot`.
  | { kind: 'callCode'; helper: string; args: IrExpr[]; resultSlot?: string; source: SourceRef }
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
  blocks: IrBlock[];
  // Body of the class's start method: every Start node, in graph and node order.
  start: IrStatement[];
}

// Static type of an expression, as far as it is known.
export function exprType(expr: IrExpr, program: Pick<IrProgram, 'members' | 'slots'>): TypeRef | undefined {
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
  }
}

function literalType(value: unknown): TypeRef | undefined {
  if (typeof value === 'number') return { id: Number.isInteger(value) ? 'int' : 'float' };
  if (typeof value === 'string') return { id: 'string' };
  if (typeof value === 'boolean') return { id: 'bool' };
  return undefined;
}
