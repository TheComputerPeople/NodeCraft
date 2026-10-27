// Reads the methods of a Java file that can become nodes (docs/language-breadth.md, "Java"):
// `public static` methods marked `@blueprint` in their Javadoc comment, in the file's classes
// (nested ones too), with their parameters, types and documentation. Like the other scanners it
// parses only declarations and skips bodies by matching brackets.
import { TypeRef } from '../types';
import { DocComment, ModuleScan, NO_DOC, ScannedParam, isMarked, parseDocText } from './symbols';

type TokenKind = 'name' | 'number' | 'string' | 'char' | 'punct';

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  start: number;
  end: number;
  // The Javadoc comment directly before this token.
  doc?: string[];
}

export function tokenizeJava(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let doc: string[] | undefined;
  const push = (kind: TokenKind, start: number, startLine: number): void => {
    tokens.push({ kind, text: source.slice(start, i), line: startLine, start, end: i, ...(doc ? { doc } : {}) });
    doc = undefined;
  };
  const count = (from: number): void => {
    for (let k = from; k < i; k++) if (source[k] === '\n') line++;
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const start = i;
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? source.length : close + 2;
      // A Javadoc comment (/** … */) documents what follows; others don't.
      if (source.startsWith('/**', start) && !source.startsWith('/**/', start)) {
        doc = source.slice(start + 3, Math.max(start + 3, i - 2)).split('\n').map((l) => l.replace(/^\s*\*? ?/, ''));
      }
      count(start);
      continue;
    }
    const start = i;
    const startLine = line;
    // Text blocks ("""…""") and strings.
    if (source.startsWith('"""', i)) {
      const close = source.indexOf('"""', i + 3);
      i = close < 0 ? source.length : close + 3;
      count(start);
      push('string', start, startLine);
      continue;
    }
    if (ch === '"' || ch === '\'') {
      i++;
      while (i < source.length && source[i] !== ch && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      i++;
      push(ch === '"' ? 'string' : 'char', start, startLine);
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      while (i < source.length && /[\w$]/.test(source[i])) i++;
      push('name', start, startLine);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      while (i < source.length && /[\w.]/.test(source[i])) i++;
      push('number', start, startLine);
      continue;
    }
    i += source.startsWith('...', i) ? 3 : 1;
    push('punct', start, startLine);
  }
  return tokens;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const MODIFIERS = new Set(['public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'native', 'strictfp', 'default', 'transient', 'volatile', 'sealed', 'non']);
const TYPE_KEYWORDS = new Set(['class', 'interface', 'enum', 'record']);

export function scanJava(source: string): ModuleScan {
  const tokens = tokenizeJava(source);
  const result: ModuleScan = { functions: [], skipped: [] };
  const at = (i: number, value: string) => tokens[i]?.text === value && tokens[i].kind !== 'string' && tokens[i].kind !== 'char';
  const text = (start: number, end: number) => (end > start ? source.slice(tokens[start].start, tokens[end - 1].end) : '');
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
      if (at(j, '<')) depth++;
      else if (at(j, '>') && --depth === 0) return j + 1;
    }
    return tokens.length;
  };
  // An annotation (@Name, @a.b.Name, with arguments in parentheses), or undefined.
  const skipAnnotation = (i: number): number | undefined => {
    if (!at(i, '@') || at(i + 1, 'interface')) return undefined;
    let j = i + 1;
    while (tokens[j]?.kind === 'name' && at(j + 1, '.')) j += 2;
    j++;
    return at(j, '(') ? skipGroup(j) : j;
  };
  // The end of a member starting at `i`: after its `;` or its body.
  const skipMember = (i: number): number => {
    for (let j = i; j < tokens.length; j++) {
      if (at(j, '(') || at(j, '[')) j = skipGroup(j) - 1;
      else if (at(j, '{')) return skipGroup(j);
      else if (at(j, ';')) return j + 1;
    }
    return tokens.length;
  };

  // The package, to qualify the classes.
  let i = 0;
  let pkg = '';
  while (i < tokens.length && (skipAnnotation(i) !== undefined || at(i, 'package') || at(i, 'import'))) {
    const annotation = skipAnnotation(i);
    if (annotation !== undefined) {
      i = annotation;
      continue;
    }
    const end = skipMember(i);
    if (at(i, 'package')) pkg = text(i + 1, end - 1).replace(/\s+/g, '');
    i = end;
  }

  // The members of a type's body (or the file), between `from` and `to`.
  const members = (from: number, to: number, container: string): void => {
    let j = from;
    while (j < to) {
      const first = j;
      const doc = tokens[first]?.doc;
      const modifiers = new Set<string>();
      for (;;) {
        const annotation = skipAnnotation(j);
        if (annotation !== undefined) {
          j = annotation;
          continue;
        }
        if (tokens[j]?.kind === 'name' && MODIFIERS.has(tokens[j].text)) {
          modifiers.add(tokens[j].text);
          j++;
          if (at(j, '-') && at(j + 1, 'sealed')) j += 2;
          continue;
        }
        break;
      }
      if (j >= to) break;
      if (at(j, ';')) {
        j++;
        continue;
      }
      // A nested type: its members, qualified by its name.
      if (tokens[j].kind === 'name' && TYPE_KEYWORDS.has(tokens[j].text) && tokens[j + 1]?.kind === 'name') {
        const name = tokens[j + 1].text;
        let k = j + 2;
        while (k < to && !at(k, '{')) k = at(k, '(') ? skipGroup(k) : at(k, '<') ? skipAngles(k) : k + 1;
        const close = skipGroup(k);
        const inner = container ? `${container}.${name}` : name;
        // An enum's constants come before its members, up to the first `;`.
        let body = k + 1;
        if (tokens[j].text === 'enum') {
          while (body < close - 1 && !at(body, ';')) body = at(body, '(') || at(body, '{') ? skipGroup(body) : body + 1;
          body++;
        }
        members(body, close - 1, inner);
        j = close;
        continue;
      }
      if (at(j, '{')) {
        // An initializer block.
        j = skipGroup(j);
        continue;
      }
      // A method: [<T>] type name ( … ); a field or constructor otherwise.
      let k = j;
      const generic = at(k, '<');
      if (generic) k = skipAngles(k);
      const typeStart = k;
      while (k < to && !at(k, '(') && !at(k, '=') && !at(k, ';') && !at(k, '{')) k = at(k, '<') ? skipAngles(k) : at(k, '[') ? skipGroup(k) : k + 1;
      if (!at(k, '(') || k - typeStart < 2 || tokens[k - 1].kind !== 'name') {
        j = skipMember(j);
        continue;
      }
      const name = tokens[k - 1].text;
      const returnText = text(typeStart, k - 1);
      const close = skipGroup(k);
      const throwsClause = at(close, 'throws');
      const end = skipMember(close);
      const docComment = parseDoc(doc);
      const skip = (reason: string) => result.skipped.push({ name, line: tokens[first].line, reason, marked: isMarked(docComment), ...(container ? { container: qualified(container) } : {}) });
      if (!container) {
        // Not in a type: nothing to scan.
      } else if (!modifiers.has('public') || !modifiers.has('static')) skip('it isn\'t public static, so generated code can\'t call it on its own');
      else if (generic) skip('generic methods can\'t be nodes yet');
      else if (throwsClause) skip('methods that declare checked exceptions can\'t be nodes yet');
      else {
        const params = parseParams(k + 1, close - 1);
        if ('reason' in params) skip(params.reason);
        else {
          const returns = returnText === 'void' ? null : mapJavaType(returnText);
          result.functions.push({ name, line: tokens[first].line, params, returns, doc: docComment, container: qualified(container) });
        }
      }
      j = end;
    }
  };
  const qualified = (container: string) => (pkg ? `${pkg}.${container}` : container);

  const parseParams = (start: number, end: number): ScannedParam[] | { reason: string } => {
    if (end <= start) return [];
    const pieces: [number, number][] = [];
    let from = start;
    let angles = 0;
    for (let j = start; j < end; j++) {
      if (at(j, '(') || at(j, '[')) {
        j = skipGroup(j) - 1;
        continue;
      }
      if (at(j, '<')) angles++;
      else if (at(j, '>')) angles--;
      else if (at(j, ',') && angles === 0) {
        pieces.push([from, j]);
        from = j + 1;
      }
    }
    if (from < end) pieces.push([from, end]);
    const params: ScannedParam[] = [];
    for (const [a, b] of pieces) {
      let s = a;
      for (;;) {
        const annotation = skipAnnotation(s);
        if (annotation !== undefined) s = annotation;
        else if (at(s, 'final')) s++;
        else break;
      }
      if (text(s, b).includes('...')) return { reason: 'varargs methods can\'t be nodes' };
      if (tokens[b - 1]?.kind !== 'name' || b - 1 <= s) return { reason: 'a parameter has no name, so it can\'t be a pin' };
      params.push({ name: tokens[b - 1].text, type: mapJavaType(text(s, b - 1)) });
    }
    return params;
  };

  members(i, tokens.length, '');
  return result;
}

function parseDoc(lines: string[] | undefined): DocComment {
  if (!lines?.length) return NO_DOC;
  return parseDocText(lines);
}

// ---- Types -------------------------------------------------------------------------------------

const SIMPLE: Record<string, TypeRef> = {
  long: { id: 'int' }, double: { id: 'float' }, boolean: { id: 'bool' }, String: { id: 'string' }, 'java.lang.String': { id: 'string' }
};

// A Java type, as text, in canonical form. Only the types generated code passes exactly map to
// canonical ones (long, double, boolean, String, ArrayList of their boxed types); Java won't narrow
// a long to an int implicitly, so int and the rest are native.
export function mapJavaType(text: string): TypeRef {
  const t = text.replace(/\s+/g, ' ').replace(/\s*([<>,.[\]])\s*/g, '$1').replace(/,/g, ', ').trim();
  if (t in SIMPLE) return SIMPLE[t];
  const list = /^(?:java\.util\.)?ArrayList<(Long|Double|Boolean|String)>$/.exec(t);
  if (list) return { id: { Long: 'int', Double: 'float', Boolean: 'bool', String: 'string' }[list[1]]!, container: 'array' };
  return { id: `native:${t}` };
}
