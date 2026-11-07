// Leaves out what no generated code reads (docs/project-integration.md, part 3): the output of a
// node nobody wires anywhere is still computed, but not kept. Projects' checkers reject storage
// that's written and never read (TypeScript's noUnusedLocals, Pyright's reportUnusedVariable), and
// it's noise in generated code. Runs between lowering and generation, for every language.
import { IrExpr, IrProgram, IrStatement } from './ir';

export function pruneUnreadSlots(program: IrProgram): IrProgram {
  let current = program;
  for (;;) {
    const read = readSlots(current);
    // The slots a generated statement uses itself, not only through its readers: loop counters
    // and Break's flag, a Delay's state, a Cast's and a construct's object.
    for (const s of allStatements(current)) for (const slot of ownSlots(s)) read.add(slot);
    const unread = new Set(current.slots.map((s) => s.id).filter((id) => !read.has(id)));
    if (!unread.size) return current;
    const next = without(current, unread);
    // Slots still written (among a call's results that are read) stay, and so the pass ends.
    if (next.slots.length === current.slots.length) return next;
    current = next;
  }
}

// Every statement of the program, nested ones included.
function allStatements(program: IrProgram): IrStatement[] {
  const all: IrStatement[] = [];
  const walk = (list: IrStatement[]) => {
    for (const s of list) {
      all.push(s);
      for (const nested of children(s)) walk(nested);
    }
  };
  for (const list of bodies(program)) walk(list);
  return all;
}

function bodies(program: IrProgram): IrStatement[][] {
  return [program.start, ...program.functions.map((f) => f.body), ...program.blocks.map((b) => b.body), ...(program.tests ?? []).map((t) => t.body)];
}

function children(s: IrStatement): IrStatement[][] {
  switch (s.kind) {
    case 'if':
      return [s.then, s.else];
    case 'for':
    case 'while':
    case 'forEach':
      return [s.body];
    case 'delay':
    case 'await':
      return [s.then];
    case 'cast':
      return [s.succeeded, s.failed];
    default:
      return [];
  }
}

function ownSlots(s: IrStatement): string[] {
  switch (s.kind) {
    case 'for':
      return [s.counter, ...(s.stop ? [s.stop] : [])];
    case 'forEach':
      return [s.index, s.element, ...(s.stop ? [s.stop] : [])];
    case 'delay':
      return [...(s.pending ? [s.pending] : []), ...(s.generation ? [s.generation] : [])];
    case 'cast':
    case 'construct':
      return [s.slot];
    default:
      return [];
  }
}

// The expressions a statement evaluates (not those of the statements nested in it).
function statementExprs(s: IrStatement): IrExpr[] {
  switch (s.kind) {
    case 'print':
      return [s.value];
    case 'assert':
      return [s.condition, s.message];
    case 'store':
    case 'setMember':
      return [s.value];
    case 'if':
    case 'while':
      return [s.condition];
    case 'call':
    case 'callFunction':
    case 'await':
      return s.args;
    case 'for':
      return [s.first, s.last];
    case 'forEach':
      return [s.array];
    case 'return':
      return s.values;
    case 'bindEvent':
    case 'unbindAll':
      return s.target ? [s.target] : [];
    case 'broadcast':
      return [...s.args, ...(s.target ? [s.target] : [])];
    case 'setObjectVariable':
      return [s.target, s.value];
    case 'delay':
      return [s.duration];
    case 'cast':
      return [s.value];
    case 'interfaceCall':
    case 'objectCall':
      return [s.target, ...s.args];
    case 'parentCall':
      return s.args;
    case 'callBlock':
    case 'construct':
      return [];
  }
}

function exprChildren(e: IrExpr): IrExpr[] {
  switch (e.kind) {
    case 'add':
    case 'binary':
      return [e.left, e.right];
    case 'toNumber':
    case 'toBoolean':
    case 'toText':
    case 'not':
    case 'isValid':
    case 'structField':
      return [e.value];
    case 'concat':
      return e.parts;
    case 'call':
    case 'callFunction':
    case 'parentCall':
      return e.args;
    case 'makeContainer':
      return e.items;
    case 'makeStruct':
      return e.fields;
    case 'objectVariable':
      return [e.target];
    case 'objectCall':
    case 'interfaceCall':
      return [e.target, ...e.args];
    default:
      return [];
  }
}

// The slots some expression reads: in statements, members' initial values, and stored event inputs.
function readSlots(program: IrProgram): Set<string> {
  const read = new Set<string>();
  const visit = (e: IrExpr) => {
    if (e.kind === 'output') read.add(e.slot);
    for (const child of exprChildren(e)) visit(child);
  };
  for (const s of allStatements(program)) for (const e of statementExprs(s)) visit(e);
  for (const m of program.members) visit(m.initial);
  for (const f of program.functions) for (const store of f.event?.stores ?? []) read.add(store.slot);
  return read;
}

// The program without the unread slots, the stores into them, and their pin values.
function without(program: IrProgram, unread: Set<string>): IrProgram {
  const keep = (results: { output: string; slot: string }[]) => (results.every((r) => unread.has(r.slot)) ? [] : results);
  const prune = (list: IrStatement[]): IrStatement[] => list.flatMap((s): IrStatement[] => {
    switch (s.kind) {
      case 'store':
        return unread.has(s.slot) ? [] : [s];
      case 'call': {
        const { resultSlot, results, ...rest } = s;
        return [{ ...rest, ...(resultSlot && !unread.has(resultSlot) ? { resultSlot } : {}), ...(results ? { results: keep(results) } : {}) }];
      }
      case 'await': {
        const { resultSlot, ...rest } = s;
        return [{ ...rest, then: prune(s.then), ...(resultSlot && !unread.has(resultSlot) ? { resultSlot } : {}) }];
      }
      case 'callFunction':
      case 'interfaceCall':
      case 'parentCall':
      case 'objectCall':
        return [{ ...s, results: keep(s.results) }];
      case 'if':
        return [{ ...s, then: prune(s.then), else: prune(s.else) }];
      case 'for':
      case 'while':
      case 'forEach':
        return [{ ...s, body: prune(s.body) }];
      case 'delay':
        return [{ ...s, then: prune(s.then) }];
      case 'cast':
        return [{ ...s, succeeded: prune(s.succeeded), failed: prune(s.failed) }];
      default:
        return [s];
    }
  });
  // A call's results are kept together while any of them is read: a slot dropped from them is gone.
  const stillWritten = new Set<string>();
  const program2: IrProgram = {
    ...program,
    start: prune(program.start),
    functions: program.functions.map((f) => ({ ...f, body: prune(f.body) })),
    blocks: program.blocks.map((b) => ({ ...b, body: prune(b.body) })),
    ...(program.tests ? { tests: program.tests.map((t) => ({ ...t, body: prune(t.body) })) } : {})
  };
  for (const s of allStatements(program2)) for (const slot of writtenSlots(s)) stillWritten.add(slot);
  const gone = new Set([...unread].filter((id) => !stillWritten.has(id)));
  return {
    ...program2,
    slots: program2.slots.filter((s) => !gone.has(s.id)),
    ...(program2.pinValues ? { pinValues: program2.pinValues.filter((p) => !(p.value.kind === 'output' && gone.has(p.value.slot))) } : {})
  };
}

function writtenSlots(s: IrStatement): string[] {
  switch (s.kind) {
    case 'store':
      return [s.slot];
    case 'call':
      return [...(s.resultSlot ? [s.resultSlot] : []), ...(s.results ?? []).map((r) => r.slot)];
    case 'await':
      return s.resultSlot ? [s.resultSlot] : [];
    case 'callFunction':
    case 'interfaceCall':
    case 'parentCall':
    case 'objectCall':
      return s.results.map((r) => r.slot);
    default:
      return ownSlots(s);
  }
}
