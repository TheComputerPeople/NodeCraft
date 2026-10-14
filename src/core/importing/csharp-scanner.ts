// Reads the static methods of a C# file that can become nodes: names, parameters, types, defaults
// and XML documentation comments (docs/program-structure.md, "C# language pack"). Like the other
// scanners it parses only declarations and skips bodies by matching brackets.
import { TypeRef } from '../types';
import { DocComment, ModuleScan, NO_DOC, ScannedParam, isMarked, parseDocText } from './symbols';

type TokenKind = 'name' | 'number' | 'string' | 'char' | 'punct';

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  start: number;
  end: number;
  // The /// documentation lines directly before this token.
  doc?: string[];
}

// ---- Tokens ------------------------------------------------------------------------------------

export function tokenizeCSharp(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let doc: string[] | undefined;
  let atLineStart = true;
  const push = (kind: TokenKind, start: number, startLine: number): void => {
    tokens.push({ kind, text: source.slice(start, i), line: startLine, start, end: i, ...(doc ? { doc } : {}) });
    doc = undefined;
    atLineStart = false;
  };
  const count = (from: number): void => {
    for (let k = from; k < i; k++) if (source[k] === '\n') line++;
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') {
      line++;
      i++;
      atLineStart = true;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // Preprocessor directives take the rest of the line.
    if (ch === '#' && atLineStart) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('///', i)) {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      (doc ??= []).push(source.slice(i + 3, stop));
      i = stop;
      continue;
    }
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      const start = i;
      i = end < 0 ? source.length : end + 2;
      count(start);
      continue;
    }
    const start = i;
    const startLine = line;
    // String literals: "…", @"…", $"…", $@"…", @$"…", and raw """…""" (optionally with $).
    const prefix = /^(\$+@?|@\$+|@)?(?=")/.exec(source.slice(i, i + 4))?.[0];
    if (prefix !== undefined && source[i + prefix.length] === '"') {
      i += prefix.length;
      readString(prefix);
      count(start);
      push('string', start, startLine);
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < source.length && source[i] !== "'" && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      i++;
      push('char', start, startLine);
      continue;
    }
    if (/[A-Za-z_@À-￿]/.test(ch)) {
      i++;
      while (i < source.length && /[\wÀ-￿]/.test(source[i])) i++;
      push('name', start, startLine);
      continue;
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(source[i + 1] ?? ''))) {
      while (i < source.length && /[\w.]/.test(source[i]) && !(source[i] === '.' && !/\d/.test(source[i + 1] ?? ''))) i++;
      // Exponents: 1e-5.
      if (/[eE]$/.test(source.slice(start, i)) && /[+-]/.test(source[i])) {
        i++;
        while (i < source.length && /\w/.test(source[i])) i++;
      }
      push('number', start, startLine);
      continue;
    }
    i++;
    if (ch === '=' && source[i] === '>') i++;
    else if (ch === '?' && source[i] === '?') i++;
    push('punct', start, startLine);
  }
  return tokens;

  // Reads a string's body from `i` (at its first quote).
  function readString(prefix: string): void {
    const interpolated = prefix.includes('$');
    const verbatim = prefix.includes('@');
    // Raw strings ("""…""") can't be verbatim: @"""… is a verbatim string that starts with a quote.
    if (!verbatim && source.startsWith('"""', i)) {
      let quotes = 0;
      while (source[i] === '"') {
        quotes++;
        i++;
      }
      const close = '"'.repeat(quotes);
      const end = source.indexOf(close, i);
      i = end < 0 ? source.length : end + quotes;
      return;
    }
    i++;
    while (i < source.length) {
      const c = source[i];
      if (c === '"') {
        if (verbatim && source[i + 1] === '"') {
          i += 2;
          continue;
        }
        i++;
        return;
      }
      if (c === '\\' && !verbatim) {
        i += 2;
        continue;
      }
      if (c === '\n' && !verbatim) return;
      if (interpolated && c === '{') {
        if (source[i + 1] === '{') {
          i += 2;
          continue;
        }
        skipInterpolation();
        continue;
      }
      i++;
    }
  }

  // Skips `{ expression }` inside an interpolated string, including nested strings and braces.
  function skipInterpolation(): void {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          i++;
          return;
        }
      } else if (c === '"' || (c === '@' && source[i + 1] === '"') || (c === '$' && /["@$]/.test(source[i + 1] ?? ''))) {
        const nested = /^(\$+@?|@\$+|@)?/.exec(source.slice(i, i + 3))![0];
        i += nested.length;
        readString(nested);
        continue;
      }
      i++;
    }
  }
}

// ---- Declarations -------------------------------------------------------------------------------

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const TYPE_KEYWORDS = new Set(['class', 'struct', 'record', 'interface', 'enum']);
const MODIFIERS = new Set(['public', 'private', 'protected', 'internal', 'static', 'sealed', 'abstract', 'partial', 'readonly', 'unsafe', 'new', 'file', 'virtual', 'override', 'extern', 'async', 'required', 'ref']);

// What scanning C# adds to a ModuleScan.
export interface CSharpScan extends ModuleScan {
  // The file has top-level statements (it is a program's entry point).
  topLevelStatements: boolean;
}

export function scanCSharp(source: string): CSharpScan {
  const tokens = tokenizeCSharp(source);
  const result: CSharpScan = { functions: [], skipped: [], topLevelStatements: false };
  const text = (start: number, end: number) => (end > start ? source.slice(tokens[start].start, tokens[end - 1].end) : '');
  const at = (i: number, value: string) => tokens[i]?.text === value && tokens[i].kind !== 'string';
  const skipGroup = (i: number): number => {
    const stack: string[] = [];
    for (let j = i; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.kind !== 'punct') continue;
      if (OPEN[t.text]) stack.push(OPEN[t.text]);
      else if (t.text === stack[stack.length - 1]) {
        stack.pop();
        if (!stack.length) return j + 1;
      }
    }
    return tokens.length;
  };
  const skipAngles = (i: number): number => {
    let depth = 0;
    for (let j = i; j < tokens.length; j++) {
      if (tokens[j].text === '<') depth++;
      else if (tokens[j].text === '>' && --depth === 0) return j + 1;
    }
    return tokens.length;
  };
  // The end of a statement or member starting at `i`: after its `;` or its `{…}` body.
  const skipMember = (i: number): number => {
    for (let j = i; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.kind === 'punct' && (t.text === '(' || t.text === '[')) j = skipGroup(j) - 1;
      else if (t.text === '{' && t.kind === 'punct') {
        const end = skipGroup(j);
        // Property initializers and expression bodies continue to a `;`.
        return at(end, ';') ? end + 1 : end;
      } else if (t.text === ';') return j + 1;
    }
    return tokens.length;
  };

  // Declarations in a namespace or at file level, from `i` to `end`, inside `namespace`.
  const members = (i: number, end: number, namespace: string, fileLevel: boolean): void => {
    while (i < end) {
      const t = tokens[i];
      if (at(i, 'using') || at(i, 'extern')) {
        i = skipMember(i);
        continue;
      }
      if (at(i, '[')) {
        i = skipGroup(i);
        continue;
      }
      if (at(i, 'namespace')) {
        let j = i + 1;
        while (j < end && !at(j, ';') && !at(j, '{')) j++;
        const name = text(i + 1, j).replace(/\s+/g, '');
        const full = namespace ? `${namespace}.${name}` : name;
        if (at(j, ';')) {
          members(j + 1, end, full, false);
          return;
        }
        const close = skipGroup(j);
        members(j + 1, close - 1, full, false);
        i = close;
        continue;
      }
      // A type declaration: modifiers, then class/struct/record/interface/enum (or delegate).
      let j = i;
      const modifiers: string[] = [];
      while (j < end && tokens[j].kind === 'name' && MODIFIERS.has(tokens[j].text)) modifiers.push(tokens[j++].text);
      if (j < end && TYPE_KEYWORDS.has(tokens[j].text)) {
        const kind = tokens[j].text;
        if (kind === 'record' && (at(j + 1, 'class') || at(j + 1, 'struct'))) j++;
        const name = tokens[j + 1]?.text ?? '';
        let k = j + 2;
        const generic = at(k, '<');
        if (generic) k = skipAngles(k);
        while (k < end && !at(k, '{') && !at(k, ';')) k = at(k, '(') ? skipGroup(k) : k + 1;
        if (at(k, ';')) {
          i = k + 1;
          continue;
        }
        const close = skipGroup(k);
        const accessible = !modifiers.includes('private') && !modifiers.includes('protected') && !modifiers.includes('file');
        if (kind !== 'enum' && kind !== 'interface') classMembers(k + 1, close - 1, namespace ? `${namespace}.${name}` : name, accessible, generic);
        i = close;
        continue;
      }
      if (at(j, 'delegate')) {
        i = skipMember(i);
        continue;
      }
      // Anything else at file level is a top-level statement (or a local function in one).
      if (fileLevel && t) result.topLevelStatements = true;
      i = skipMember(i);
    }
  };

  // Members of a class, record or struct: static methods can become nodes.
  const classMembers = (i: number, end: number, className: string, accessible: boolean, generic: boolean): void => {
    while (i < end) {
      if (at(i, '[')) {
        i = skipGroup(i);
        continue;
      }
      const first = i;
      const doc = tokens[first].doc;
      const modifiers: string[] = [];
      while (i < end && tokens[i].kind === 'name' && MODIFIERS.has(tokens[i].text)) modifiers.push(tokens[i++].text);
      // Nested types aren't scanned.
      if (i < end && TYPE_KEYWORDS.has(tokens[i].text)) {
        while (i < end && !at(i, '{') && !at(i, ';')) i++;
        i = at(i, '{') ? skipGroup(i) : i + 1;
        continue;
      }
      // A method: return type, name, optional <T>, then (parameters).
      let k = i;
      while (k < end && !at(k, '(') && !at(k, '{') && !at(k, ';') && !at(k, '=')) k = at(k, '<') ? skipAngles(k) : k + 1;
      if (!at(k, '(') || k - i < 2) {
        i = skipMember(first);
        continue;
      }
      const genericMethod = at(k - 1, '>');
      const nameIndex = genericMethod ? findGenericStart(k - 1) - 1 : k - 1;
      const name = tokens[nameIndex]?.text ?? '';
      const returnText = text(i, nameIndex);
      const close = skipGroup(k);
      const memberEnd = skipMember(close);
      if (!modifiers.includes('static') || !/^[A-Za-z_]\w*$/.test(name) || name === className.split('.').pop() || returnText === '') {
        i = memberEnd;
        continue;
      }
      const docComment = parseXmlDoc(doc);
      const skip = (reason: string) => result.skipped.push({ name, line: tokens[first].line, reason, marked: isMarked(docComment), container: className });
      const access = modifiers.includes('public') || modifiers.includes('internal');
      if (!access || !accessible) skip('it isn\'t public or internal, so generated code can\'t call it');
      else if (generic) skip('methods of generic classes can\'t be nodes yet');
      else if (genericMethod) skip('generic methods can\'t be nodes yet');
      else if (modifiers.includes('async') || /^(Task|ValueTask)\b|^System\.Threading\.Tasks\./.test(returnText)) skip('async methods become latent nodes with Phase 4\'s latent actions');
      else if (modifiers.includes('extern')) skip('extern methods can\'t be nodes');
      else {
        const params = parseParams(k + 1, close - 1);
        if ('reason' in params) skip(params.reason);
        else {
          const returns = mapReturn(returnText);
          if ('reason' in returns) skip(returns.reason);
          else result.functions.push({ name, line: tokens[first].line, params, returns: returns.type, doc: docComment, container: className });
        }
      }
      i = memberEnd;
    }
  };

  const findGenericStart = (closeIndex: number): number => {
    let depth = 0;
    for (let j = closeIndex; j >= 0; j--) {
      if (tokens[j].text === '>') depth++;
      else if (tokens[j].text === '<' && --depth === 0) return j;
    }
    return 0;
  };

  const parseParams = (start: number, end: number): ScannedParam[] | { reason: string } => {
    const params: ScannedParam[] = [];
    let from = start;
    const pieces: [number, number][] = [];
    let angles = 0;
    for (let j = start; j < end; j++) {
      const t = tokens[j];
      if (t.kind === 'punct' && (t.text === '(' || t.text === '[' || t.text === '{')) {
        j = skipGroup(j) - 1;
        continue;
      }
      if (t.text === '<') angles++;
      else if (t.text === '>') angles--;
      else if (t.text === ',' && angles === 0) {
        pieces.push([from, j]);
        from = j + 1;
      }
    }
    if (end > start) pieces.push([from, end]);
    for (const [a, b] of pieces) {
      let s = a;
      while (at(s, '[')) s = skipGroup(s);
      if (at(s, 'this')) s++;
      if (['ref', 'out', 'in', 'params', 'scoped'].includes(tokens[s]?.text ?? '')) return { reason: 'ref, out, in and params parameters can\'t be pins yet' };
      const eq = tokens.slice(s, b).findIndex((t) => t.text === '=' && t.kind === 'punct');
      const declEnd = eq < 0 ? b : s + eq;
      const nameToken = tokens[declEnd - 1];
      if (!nameToken || nameToken.kind !== 'name' || declEnd - s < 2) return { reason: 'its parameters couldn\'t be read' };
      const type = mapCSharpType(text(s, declEnd - 1));
      const param: ScannedParam = { name: nameToken.text.replace(/^@/, ''), ...(type ? { type } : {}) };
      if (eq >= 0) {
        const value = literal(tokens.slice(declEnd + 1, b));
        if (value !== undefined) param.defaultValue = value;
      }
      params.push(param);
    }
    return params;
  };

  members(0, tokens.length, '', true);
  return result;
}

// ---- Documentation ------------------------------------------------------------------------------

// XML documentation: <summary> is the description; @tags may appear anywhere in it (or after it).
function parseXmlDoc(lines: string[] | undefined): DocComment {
  if (!lines?.length) return NO_DOC;
  const text = lines.map((l) => l.replace(/^ ?/, '')).join('\n');
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? '';
  const rest = text.replace(/<summary>[\s\S]*?<\/summary>/, '');
  const plain = (s: string) => s.replace(/<see\s+cref="([^"]*)"\s*\/>/g, '$1').replace(/<[^>]+>/g, '');
  const parsed = parseDocText(plain(summary).split('\n'));
  const tags = parseDocText(plain(rest).split('\n')).tags;
  return { description: parsed.description, tags: [...parsed.tags, ...tags] };
}

// ---- Types -------------------------------------------------------------------------------------

const SIMPLE: Record<string, TypeRef | undefined> = {
  bool: { id: 'bool' }, Boolean: { id: 'bool' },
  int: { id: 'int' }, Int32: { id: 'int' },
  double: { id: 'float' }, Double: { id: 'float' },
  string: { id: 'string' }, String: { id: 'string' },
  object: undefined, Object: undefined, dynamic: undefined
};

function mapReturn(text: string): { type: TypeRef | null | undefined } | { reason: string } {
  const t = normalize(text);
  if (t === 'void') return { type: null };
  return { type: mapCSharpType(t) };
}

// A C# type, as text, in canonical form. Only types generated C# can pass on exactly map to
// canonical types (double is float, int is int); others are native.
export function mapCSharpType(text: string): TypeRef | undefined {
  const t = normalize(text).replace(/^System\./, '').replace(/^global::/, '');
  if (t.endsWith('?')) {
    const inner = mapCSharpType(t.slice(0, -1));
    return inner && !inner.nullable && !inner.id.startsWith('native:') ? { ...inner, nullable: true } : { id: `native:${t}` };
  }
  if (t in SIMPLE) return SIMPLE[t];
  const generic = /^(?:Collections\.Generic\.)?(List|HashSet|Dictionary)<(.*)>$/.exec(t);
  if (generic) {
    const args = splitTop(generic[2]);
    const element = (s: string): TypeRef | undefined | 'native' => {
      const mapped = mapCSharpType(s);
      return mapped && (mapped.container || mapped.nullable || mapped.id.startsWith('native:')) ? 'native' : mapped;
    };
    if (generic[1] !== 'Dictionary' && args.length === 1) {
      const e = element(args[0]);
      if (e === 'native') return { id: `native:${t}` };
      return { id: e?.id ?? 'any', container: generic[1] === 'List' ? 'array' : 'set' };
    }
    if (generic[1] === 'Dictionary' && args.length === 2) {
      const key = element(args[0]);
      const value = element(args[1]);
      if (!key || key === 'native' || value === 'native') return { id: `native:${t}` };
      return { id: key.id, container: 'map', valueType: value ?? { id: 'any' } };
    }
  }
  return { id: `native:${t}` };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s*([<>,?[\]])\s*/g, '$1').replace(/,/g, ', ').trim();
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<' || text[i] === '(') depth++;
    else if (text[i] === '>' || text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(text.slice(from).trim());
  return parts;
}

// ---- Values ------------------------------------------------------------------------------------

function literal(tokens: Token[]): unknown {
  const negative = tokens.length === 2 && tokens[0].text === '-';
  const t = negative ? tokens[1] : tokens.length === 1 ? tokens[0] : undefined;
  if (!t) return undefined;
  if (t.kind === 'number') {
    const n = Number(t.text.replace(/_/g, '').replace(/[dDfFmM]$/, '').replace(/[uUlL]+$/, ''));
    return Number.isFinite(n) ? (negative ? -n : n) : undefined;
  }
  if (negative) return undefined;
  if (t.kind === 'name') return t.text === 'true' ? true : t.text === 'false' ? false : t.text === 'null' ? null : undefined;
  if (t.kind === 'string' && t.text.startsWith('"') && !t.text.startsWith('"""')) {
    return t.text.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,4}|.)/g, (_m, esc: string) => {
      switch (esc[0]) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case '0': return '\0';
        case 'u':
        case 'x':
          return String.fromCharCode(parseInt(esc.slice(1), 16));
        default: return esc;
      }
    });
  }
  if (t.kind === 'string' && t.text.startsWith('@"')) return t.text.slice(2, -1).replace(/""/g, '"');
  return undefined;
}
