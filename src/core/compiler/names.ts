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
  functions: { id: string; name: string }[];
  events: { id: string; name: string }[];
  variables: { id: string; name: string }[];
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
}

export function claimClassMembers(scope: NameScope, spec: ClassMemberSpec, styles: ClassMemberStyles): ClassMemberNames {
  const claim = (items: { id: string; name: string }[], style: NameStyle) => new Map(items.map((item) => [item.id, scope.claim(item.name, style)]));
  const functions = claim(spec.functions, styles.functions);
  const events = claim(spec.events, styles.functions);
  const variables = claim(spec.variables, styles.variables);
  const dispatchers = claim(spec.dispatchers, styles.dispatchers);
  return { functions, events, variables, dispatchers };
}
