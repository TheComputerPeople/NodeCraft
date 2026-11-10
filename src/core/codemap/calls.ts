// Calls and inheritance in the code index (docs/codebase-map.md, Part 2): each call site resolved to
// the declarations it may call, statically. A call on this/self or super looks in the caller's type
// and its bases; a plain call in the file, the files it imports and its package; a call on a type
// or module name in that type or module; anything else, every same-named method in sight. A call
// with one answer in sight is certain; one that could be several is drawn to each (ambiguous); a
// name declared too often to guess is left unresolved; a name the workspace doesn't declare is a
// library's and isn't shown.
import { BaseFact, CallFact, Declaration } from './facts';
import type { IndexFile, IndexGraph } from './code-index';

export interface CallEdge {
  // The function, method, graph or file (its top level) that calls, and what it calls.
  from: string;
  to: string;
  // Where the first such call is, and how many there are.
  path: string;
  line: number;
  column: number;
  count: number;
  // False when the call could be to any of several (each gets an edge) or was guessed by name.
  certain: boolean;
}

export interface UnresolvedCall {
  from: string;
  callee: string;
  path: string;
  line: number;
  column: number;
  // How many declarations of that name the workspace has.
  candidates: number;
}

export interface InheritEdge {
  from: string;
  // The type it extends or implements; absent when it's not the workspace's (a library's).
  to?: string;
  name: string;
  kind: 'extends' | 'implements';
}

// A call that could be to more of these than this isn't drawn: it's unresolved.
export const MAX_CANDIDATES = 5;

// Languages where a method calls its type's methods without `this`.
const IMPLICIT_SELF = new Set(['java', 'c_sharp', 'cpp', 'ruby', 'gdscript']);

interface Ref {
  path: string;
  // Its qualified name in its file ("A.f"), and its type's ("A"; "" for a free function).
  qualified: string;
  owner: string;
  name: string;
  kind: Declaration['kind'];
  // The entity it's shown as.
  id: string;
}

const isTypeKind = (kind: Declaration['kind']) => !['function', 'method', 'constructor', 'namespace'].includes(kind);
const isCallable = (kind: Declaration['kind']) => kind === 'function' || kind === 'method' || kind === 'constructor';

export interface CallInput {
  files: IndexFile[];
  graphs: IndexGraph[];
  // Each file's declarations' entity ids, by qualified name (a generated file's are its graph's).
  declarationIds: Map<string, Map<string, string>>;
  // Where each file is shown (its own entity, its graph's, or undefined for support code).
  shownAs: Map<string, string | undefined>;
  // The files each file's imports resolved to.
  importedFiles: Map<string, string[]>;
  // The files of a file's package (Go's folder, Java's package, C#'s and PHP's namespace).
  samePackage: (file: IndexFile) => string[];
  // The names a file's imports bind, and the files they resolved to (`local m = require(...)`).
  aliases: Map<string, Map<string, string[]>>;
}

export function linkCalls(input: CallInput): { calls: CallEdge[]; unresolvedCalls: UnresolvedCall[]; inherits: InheritEdge[] } {
  // Every declaration, by name, by file, and by its type.
  const byName = new Map<string, Ref[]>();
  const byFile = new Map<string, Ref[]>();
  const members = new Map<string, Ref[]>();
  const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  const files = new Map(input.files.map((f) => [f.path, f]));
  for (const file of input.files) {
    const ids = input.declarationIds.get(file.path);
    if (!ids) continue;
    for (const d of file.facts.declarations) {
      const qualified = [...d.container, d.name].join('.');
      const id = ids.get(qualified);
      if (!id) continue;
      const ref: Ref = { path: file.path, qualified, owner: d.container.join('.'), name: d.name, kind: d.kind, id };
      push(byName, d.name, ref);
      push(byFile, file.path, ref);
      // Members by their type's name: Go's methods and Rust's impls can be in another file.
      if (d.container.length) push(members, d.container[d.container.length - 1], ref);
    }
  }

  // Base types, by the type's name: resolved where the type is.
  const basesOf = new Map<string, { base: BaseFact; path: string }[]>();
  for (const file of input.files) for (const base of file.facts.bases) push(basesOf, `${file.path}#${base.of ?? ''}`, { base, path: file.path });
  const typeNamed = (name: string, from: string): Ref | undefined => {
    const simple = name.split(/::|\.|\\/).pop()!;
    const candidates = (byName.get(simple) ?? []).filter((r) => isTypeKind(r.kind));
    const visible = candidates.filter((r) => visibleFrom(from).has(r.path));
    const pick = visible.length ? visible : candidates;
    return pick.length === 1 ? pick[0] : visible.find((r) => r.path === from) ?? undefined;
  };
  // A type's bases, transitively (by name: a type may be declared in several files, partially).
  const ancestors = (owner: string, path: string, seen = new Set<string>()): Ref[] => {
    const found: Ref[] = [];
    for (const { base } of basesOf.get(`${path}#${owner}`) ?? []) {
      const type = typeNamed(base.name, path);
      if (!type || seen.has(type.id)) continue;
      seen.add(type.id);
      found.push(type, ...ancestors(type.qualified, type.path, seen));
    }
    return found;
  };
  // A type's methods named `name`, in its own declaration and its bases'.
  const methodsOf = (owner: string, path: string, name: string, withBases: boolean): Ref[] => {
    const all = (members.get(owner.split('.').pop() ?? owner) ?? []).filter((r) => r.name === name && isCallable(r.kind) && (r.owner === owner || r.owner.endsWith(`.${owner}`) || owner.endsWith(r.owner)));
    // The type's own declaration first (the same file, then what it sees): a name can be declared
    // in many files (C++'s generated headers each carry the runtime's classes).
    const here = all.filter((r) => r.path === path);
    const seen = all.filter((r) => visibleFrom(path).has(r.path));
    const own = here.length ? here : seen.length ? seen : all.length === 1 ? all : [];
    if (own.length || !withBases) return own;
    for (const base of ancestors(owner, path)) {
      const inherited = methodsOf(base.qualified, base.path, name, false);
      if (inherited.length) return inherited;
    }
    return [];
  };

  // The files a file sees: itself, what it imports, its package, and the sources of the headers it includes.
  const visibleCache = new Map<string, Set<string>>();
  function visibleFrom(path: string): Set<string> {
    let visible = visibleCache.get(path);
    if (visible) return visible;
    visible = new Set([path, ...(input.importedFiles.get(path) ?? [])]);
    const file = files.get(path);
    if (file) for (const p of input.samePackage(file)) visible.add(p);
    for (const header of input.importedFiles.get(path) ?? []) {
      if (!/\.(h|hh|hpp|hxx)$/.test(header)) continue;
      const stem = header.replace(/\.[^.]+$/, '');
      for (const ext of ['.c', '.cc', '.cpp', '.cxx']) if (files.has(stem + ext)) visible.add(stem + ext);
    }
    visibleCache.set(path, visible);
    return visible;
  }

  const calls = new Map<string, CallEdge>();
  const unresolvedCalls: UnresolvedCall[] = [];
  const addCall = (from: string, to: string, path: string, call: { line: number; column: number }, certain: boolean): void => {
    if (from === to && !certain) return;
    const key = `${from}>${to}`;
    const existing = calls.get(key);
    if (existing) {
      existing.count++;
      existing.certain ||= certain;
      return;
    }
    calls.set(key, { from, to, path, line: call.line, column: call.column, count: 1, certain });
  };

  // Generated code's calls, kept apart: a graph's own calls come from its nodes (below), so the
  // generated code adds only certain calls out of the graph that its nodes don't already give.
  const generatedCalls: { from: string; to: string; path: string; call: CallFact }[] = [];
  for (const file of input.files) {
    const shown = input.shownAs.get(file.path);
    const ids = input.declarationIds.get(file.path);
    if (!shown || !ids) continue;
    const generated = shown.startsWith('g:');
    const grammar = file.facts.grammar;
    for (const call of file.facts.calls) {
      const from = (call.in && ids.get(call.in)) || shown;
      const caller = call.in ? (byFile.get(file.path) ?? []).find((r) => r.qualified === call.in) : undefined;
      // The type the call is in: a method's type, or the type itself (a field's initializer).
      const ownType = caller ? (isTypeKind(caller.kind) ? caller.qualified : caller.owner) : '';
      const found = resolve(call, file.path, grammar, ownType);
      if (generated) {
        if (found.certain) for (const ref of found.refs) if (!ref.id.startsWith(shown)) generatedCalls.push({ from: shown, to: ref.id, path: file.path, call });
      } else if (found.refs.length) {
        for (const ref of found.refs) addCall(from, ref.id, file.path, call, found.certain);
      } else if (found.candidates > MAX_CANDIDATES) {
        unresolvedCalls.push({ from, callee: call.callee, path: file.path, line: call.line, column: call.column, candidates: found.candidates });
      }
    }
  }

  function resolve(call: CallFact, path: string, grammar: string, ownType: string): { refs: Ref[]; certain: boolean; candidates: number } {
    const visible = visibleFrom(path);
    const named = byName.get(call.callee) ?? [];
    const inSight = named.filter((r) => visible.has(r.path));
    const certain = (refs: Ref[]) => ({ refs, certain: true, candidates: refs.length });
    // Constructing a type: the type (its constructor when it declares one).
    if (call.new) {
      const types = inSight.filter((r) => isTypeKind(r.kind));
      const pick = types.length ? types : named.filter((r) => isTypeKind(r.kind));
      return pick.length === 1 ? certain(pick) : guess(pick);
    }
    const receiver = call.receiver;
    if (receiver === 'self' || receiver === 'super') {
      if (!ownType) return guess(named.filter((r) => isCallable(r.kind)));
      const refs = receiver === 'self' ? methodsOf(ownType, path, call.callee, true) : ancestors(ownType, path).flatMap((b) => methodsOf(b.qualified, b.path, call.callee, false)).slice(0, 1);
      return refs.length ? certain(refs) : { refs: [], certain: false, candidates: 0 };
    }
    if (receiver === undefined) {
      if (ownType && IMPLICIT_SELF.has(grammar)) {
        const own = methodsOf(ownType, path, call.callee, true);
        if (own.length) return certain(own);
      }
      // A free function: in this file first, then in sight.
      const free = inSight.filter((r) => isCallable(r.kind) && (r.owner === '' || !isTypeKind(kindOf(r.path, r.owner))));
      const here = free.filter((r) => r.path === path);
      if (here.length) return certain(here.slice(0, 1));
      if (free.length === 1) return certain(free);
      // A type called like a function (Python's `A()`, Rust's `A::new` is a receiver): its constructor.
      const types = inSight.filter((r) => isTypeKind(r.kind));
      if (types.length === 1) return certain(types);
      if (free.length) return guess(free);
      return guess(named.filter((r) => isCallable(r.kind) && r.owner === ''));
    }
    if (receiver === '?') return guess(inSight.filter((r) => isCallable(r.kind) && r.owner !== ''), named);
    // A module bound to a name by an import: its functions (and its types' static methods).
    const aliased = input.aliases.get(path)?.get(receiver);
    if (aliased) {
      const refs = named.filter((r) => aliased.includes(r.path) && (isCallable(r.kind) || isTypeKind(r.kind)));
      const free = refs.filter((r) => r.owner === '' || !isTypeKind(kindOf(r.path, r.owner)));
      const pick = free.length ? free : refs;
      if (pick.length === 1) return certain(pick);
      if (pick.length) return guess(pick);
    }
    // A type's static method, or a module's or table's function (Go's package, Lua's table, a Python module).
    const simple = receiver.split(/::|\.|\\/).pop()!;
    const type = typeNamed(receiver, path);
    if (type && /^[A-Z]/.test(simple)) {
      const refs = methodsOf(type.qualified, type.path, call.callee, true);
      if (refs.length) return certain(refs);
    }
    const inModule = named.filter((r) => isCallable(r.kind) && (
      (r.owner !== '' && r.owner.split('.').pop() === simple) ||
      (r.owner === '' && visible.has(r.path) && (stemOf(r.path) === simple || files.get(r.path)?.facts.package === simple))
    ));
    if (inModule.length === 1) return certain(inModule);
    if (inModule.length) return guess(inModule);
    // A method on an object of unknown type: every method of that name in sight, else anywhere.
    const methods = inSight.filter((r) => isCallable(r.kind) && r.owner !== '');
    if (methods.length === 1) return { refs: methods, certain: false, candidates: 1 };
    return guess(methods, named);
  }

  // Several candidates: each is drawn, unless there are too many to guess among. `all` counts the
  // workspace's declarations of the name, when none are in sight.
  function guess(refs: Ref[], all: Ref[] = refs): { refs: Ref[]; certain: boolean; candidates: number } {
    const pick = refs.length ? refs : all.filter((r) => isCallable(r.kind) || isTypeKind(r.kind));
    // Declared only by several graphs' generated code, outside any graph: the generated code's support
    // code (C++'s headers each carry it). Not the workspace's own: not shown.
    if (pick.length > 1 && pick.every((r) => r.id.startsWith('g:') && !r.id.includes('#'))) return { refs: [], certain: false, candidates: 0 };
    return pick.length && pick.length <= MAX_CANDIDATES ? { refs: pick, certain: false, candidates: pick.length } : { refs: [], certain: false, candidates: pick.length };
  }

  function kindOf(path: string, qualified: string): Declaration['kind'] {
    return (byFile.get(path) ?? []).find((r) => r.qualified === qualified)?.kind ?? 'namespace';
  }

  // Graphs call their functions and macros, other graphs' library functions, and project code.
  for (const graph of input.graphs) {
    const fileId = `g:${graph.path}`;
    for (const g of graph.document.graphs) {
      const from = `${fileId}#${g.id}`;
      for (const node of g.nodes) {
        const at = { line: 0, column: 0 };
        if ((node.type === 'core:function.call' || node.type === 'core:macro.instance') && typeof node.properties?.graph === 'string') {
          addCall(from, `${fileId}#${node.properties.graph}`, graph.path, at, true);
          continue;
        }
        const library = /^lib:(.+)#(.+)$/.exec(node.type);
        if (library) {
          addCall(from, `g:${library[1]}#${library[2]}`, graph.path, at, true);
          continue;
        }
        const code = /^fn:[^:]+:(.+)#(.+)$/.exec(node.type);
        if (code) {
          const ids = input.declarationIds.get(code[1]);
          const name = code[2];
          let id = ids?.get(name) ?? [...(ids?.entries() ?? [])].find(([q]) => q.split('.').pop() === name.split('.').pop())?.[1];
          // A C or C++ header declares it; a source file defines it (the one with the header's name first).
          if (!id && /\.(h|hh|hpp|hxx)$/.test(code[1])) {
            const simple = name.split(/::|\./).pop()!;
            const stem = stemOf(code[1]);
            const defined = (byName.get(simple) ?? []).filter((r) => isCallable(r.kind) && /\.(c|cc|cpp|cxx)$/.test(r.path));
            id = (defined.find((r) => stemOf(r.path) === stem) ?? (defined.length === 1 ? defined[0] : undefined))?.id;
          }
          if (id) addCall(from, id, graph.path, at, true);
        }
      }
    }
  }

  // Generated code's calls that the graph's nodes don't give (a class member's node, say).
  const fromNodes = new Set([...calls.values()].filter((c) => c.from.startsWith('g:')).map((c) => `${c.from.split('#')[0]}>${c.to}`));
  for (const { from, to, path, call } of generatedCalls) {
    if (!fromNodes.has(`${from}>${to}`)) addCall(from, to, path, call, true);
  }

  // Inheritance: each base resolved to the workspace's type, or kept by name (a library's).
  const inherits: InheritEdge[] = [];
  for (const file of input.files) {
    const ids = input.declarationIds.get(file.path);
    const shown = input.shownAs.get(file.path);
    if (!ids || !shown) continue;
    const generated = shown.startsWith('g:');
    for (const base of file.facts.bases) {
      const from = base.of ? ids.get(base.of) ?? [...ids.entries()].find(([q]) => q.split('.').pop() === base.of)?.[1] : shown;
      if (!from) continue;
      const type = typeNamed(base.name, file.path);
      // GDScript: a base named by its class_name is that file's class.
      const named = !type && file.facts.grammar === 'gdscript' ? input.files.find((f) => f.facts.grammar === 'gdscript' && f.facts.package === base.name) : undefined;
      const to = type?.id ?? (named ? input.shownAs.get(named.path) : undefined);
      // Generated code's bases are the graph's parent (another graph, or a class in code); its
      // support code's (the runtime's Object) aren't shown.
      if (generated && (!to || to.startsWith(shown))) continue;
      inherits.push({ from, ...(to && to !== from ? { to } : {}), name: base.name, kind: type && type.kind === 'interface' ? 'implements' : base.kind });
    }
  }

  return { calls: [...calls.values()], unresolvedCalls, inherits };
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.includes('.') ? base.slice(0, base.indexOf('.')) : base;
}
