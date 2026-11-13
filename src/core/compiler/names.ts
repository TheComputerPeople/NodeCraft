// Turns raw graph names (node ids, node types, variable names) into legal, unique identifiers for a
// target language.

export type NameStyle = 'keep' | 'snake' | 'pascal' | 'camel';

export class NameScope {
  private readonly used = new Set<string>();

  // `reserved` holds the language's keywords; `taken` holds names already used in this scope,
  // such as fixed method names.
  constructor(private readonly reserved: ReadonlySet<string>, taken: Iterable<string> = []) {
    for (const name of taken) this.used.add(name);
  }

  // Marks a name as used, as an ancestor class's member is.
  take(name: string): void {
    this.used.add(name);
  }

  claim(raw: string, style: NameStyle = 'keep', prefix = ''): string {
    let base = prefix + toIdentifier(raw, style);
    if (this.reserved.has(base)) base += '_';
    let name = base;
    for (let i = 2; this.used.has(name); i++) name = `${base}_${i}`;
    this.used.add(name);
    return name;
  }
}

// An identifier made of ASCII letters, digits and underscores that doesn't start with a digit.
export function toIdentifier(raw: string, style: NameStyle): string {
  const words = raw.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
  let name: string;
  switch (style) {
    case 'pascal':
      name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
      break;
    case 'camel':
      name = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1))).join('');
      break;
    case 'snake':
      name = words.map((w) => w.toLowerCase()).join('_');
      break;
    case 'keep':
      name = raw.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || words.join('_');
      break;
  }
  if (!name) name = 'value';
  return /^\d/.test(name) ? `_${name}` : name;
}

// Removes the common leading indentation from a code snippet and drops blank edge lines.
// A function's description as one line of a comment (docs/audit.md, step 4): every run of
// whitespace, and U+0085 (a line break in C#, which `\s` doesn't match), becomes one space.
// Languages whose comments end or join lines in other ways escape those themselves.
export function commentLine(text: string): string {
  return text.replace(/[\s\u0085]+/g, ' ').trim();
}

export function dedent(code: string): string[] {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
}

// ---- A class's public members (src/core/objects.ts) ---------------------------------------------
//
// Other files call a class's functions and events and use its variables and dispatchers by the
// names its own generated file gives them. Both claim them through claimClassMembers, in one fixed
// order (functions, events, variables, dispatchers), so they always agree.

export interface ClassMemberSpec {
  functions: { id: string; name: string; access?: string }[];
  events: { id: string; name: string }[];
  variables: { id: string; name: string; access?: string }[];
  dispatchers: { id: string; name: string }[];
}

export interface ClassMemberNames {
  functions: Map<string, string>;
  events: Map<string, string>;
  variables: Map<string, string>;
  dispatchers: Map<string, string>;
}

export interface ClassMemberStyles {
  functions: NameStyle;
  variables: NameStyle;
  dispatchers: NameStyle;
  // Put before a protected or private member's name (Python's leading underscore).
  hiddenPrefix?: string;
}

// An ancestor class's member names, and its functions (by graph id and name), nearest first.
export interface InheritedMembers {
  names: ClassMemberNames;
  functions: { id: string; name: string }[];
}

// A class from the project's code as the last ancestor (docs/code-classes-as-parents.md): its
// members' names are taken as the code has them, and a function named like one of its overridable
// methods overrides it, so it takes the method's name.
export function codeInheritedMembers(code: { overridable: { name: string }[]; members?: string[] }): InheritedMembers {
  const names = new Map([...(code.members ?? []), ...code.overridable.map((m) => m.name)].map((n) => [n, n]));
  return { names: { functions: names, events: new Map(), variables: new Map(), dispatchers: new Map() }, functions: code.overridable.map((m) => ({ id: m.name, name: m.name })) };
}

// `inherited`: the class's ancestors. Their names are taken, and a function named like one of
// theirs overrides it, so it takes that function's name.
export function claimClassMembers(scope: NameScope, spec: ClassMemberSpec, styles: ClassMemberStyles, inherited: InheritedMembers[] = []): ClassMemberNames {
  for (const ancestor of inherited) for (const names of Object.values(ancestor.names) as Map<string, string>[]) for (const name of names.values()) scope.take(name);
  const overridden = (name: string): string | undefined => {
    for (const ancestor of inherited) {
      const fn = ancestor.functions.find((f) => f.name === name);
      if (fn) return ancestor.names.functions.get(fn.id);
    }
    return undefined;
  };
  const prefix = (item: { access?: string }) => (item.access && item.access !== 'public' ? styles.hiddenPrefix ?? '' : '');
  const claim = (items: { id: string; name: string; access?: string }[], style: NameStyle) => new Map(items.map((item) => [item.id, scope.claim(item.name, style, prefix(item))]));
  const functions = new Map(spec.functions.map((f) => [f.id, overridden(f.name) ?? scope.claim(f.name, styles.functions, prefix(f))]));
  const events = claim(spec.events, styles.functions);
  const variables = claim(spec.variables, styles.variables);
  const dispatchers = claim(spec.dispatchers, styles.dispatchers);
  return { functions, events, variables, dispatchers };
}
