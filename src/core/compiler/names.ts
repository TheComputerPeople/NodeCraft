// Turns raw graph names (node ids, node types, variable names) into legal, unique identifiers for a
// target language.

export type NameStyle = 'keep' | 'snake' | 'pascal';

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
