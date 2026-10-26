// Reads the free functions of a C++ header that can become nodes (docs/language-breadth.md,
// "C++"): names, namespaces, parameters, types, defaults and documentation comments (/// or /** */,
// with the @blueprint marker as in the other languages). Like the other scanners it parses only
// declarations and skips bodies by matching brackets; classes, templates and macros aren't read.
import { TypeRef } from '../types';
import { DocComment, ModuleScan, NO_DOC, ScannedParam, isMarked, parseDocText } from './symbols';

type TokenKind = 'name' | 'number' | 'string' | 'char' | 'punct';

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  start: number;
  end: number;
  // The documentation comment directly before this token.
  doc?: string[];
}

export function tokenizeCpp(source: string): Token[] {
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
    // Preprocessor directives take the rest of the line, and lines they continue with "\".
    if (ch === '#' && atLineStart) {
      while (i < source.length && !(source[i] === '\n' && source[i - 1] !== '\\')) {
        if (source[i] === '\n') line++;
        i++;
      }
      continue;
    }
    if (source.startsWith('///', i) || source.startsWith('//!', i)) {
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
      if (source.startsWith('/**', start) && !source.startsWith('/**/', start)) {
        doc = source.slice(start + 3, end < 0 ? source.length : end).split('\n').map((l) => l.replace(/^\s*\*? ?/, ''));
      }
      count(start);
      continue;
    }
    const start = i;
    const startLine = line;
    // Raw strings: R"delimiter(...)delimiter", with an optional encoding prefix.
    const raw = /^(u8|u|U|L)?R"([^(\s]*)\(/.exec(source.slice(i, i + 24));
    if (raw) {
      const close = source.indexOf(`)${raw[2]}"`, i + raw[0].length);
      i = close < 0 ? source.length : close + raw[2].length + 2;
      count(start);
      push('string', start, startLine);
      continue;
    }
    const quoted = /^(u8|u|U|L)?(["'])/.exec(source.slice(i, i + 3));
    if (quoted) {
      const quote = quoted[2];
      i += quoted[0].length;
      while (i < source.length && source[i] !== quote && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      i++;
      push(quote === '"' ? 'string' : 'char', start, startLine);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      while (i < source.length && /\w/.test(source[i])) i++;
      push('name', start, startLine);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      while (i < source.length && /[\w.']/.test(source[i])) {
        // An exponent's sign belongs to the number.
        if (/[eE]/.test(source[i]) && /[+-]/.test(source[i + 1] ?? '') && !/^0[xX]/.test(source.slice(start, i))) i += 2;
        else i++;
      }
      push('number', start, startLine);
      continue;
    }
    i += source.startsWith('::', i) ? 2 : 1;
    push('punct', start, startLine);
  }
  return tokens;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const SPECIFIERS = new Set(['inline', 'constexpr', 'consteval', 'extern', 'static', 'virtual', 'explicit', 'friend', 'noexcept']);
const TYPE_KEYWORDS = new Set(['class', 'struct', 'union', 'enum', 'typedef', 'using', 'concept']);

export function scanCpp(source: string): ModuleScan {
  const tokens = tokenizeCpp(source);
  const result: ModuleScan = { functions: [], skipped: [] };
  const text = (start: number, end: number) => (end > start ? source.slice(tokens[start].start, tokens[end - 1].end) : '');
  const at = (i: number, value: string) => tokens[i]?.text === value && tokens[i].kind === 'punct' || (tokens[i]?.kind === 'name' && tokens[i].text === value);
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
      if (at(j, '(')) j = skipGroup(j) - 1;
      else if (tokens[j].text === '<') depth++;
      else if (tokens[j].text === '>' && --depth === 0) return j + 1;
      else if (tokens[j].text === '>>') {
        depth -= 2;
        if (depth <= 0) return j + 1;
      }
    }
    return tokens.length;
  };
  // The end of a declaration starting at `i`: after its `;` or its `{…}` body.
  const skipDeclaration = (i: number): number => {
    for (let j = i; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.kind === 'punct' && (t.text === '(' || t.text === '[')) j = skipGroup(j) - 1;
      else if (t.kind === 'punct' && t.text === '{') {
        const end = skipGroup(j);
        return at(end, ';') ? end + 1 : end;
      } else if (t.kind === 'punct' && t.text === ';') return j + 1;
    }
    return tokens.length;
  };

  const declarations = (i: number, end: number, namespace: string): void => {
    // Documentation before an attribute belongs to the declaration after it.
    let attributeDoc: string[] | undefined;
    while (i < end) {
      // Attributes: [[nodiscard]] and the like.
      if (at(i, '[') && at(i + 1, '[')) {
        attributeDoc = tokens[i].doc ?? attributeDoc;
        i = skipGroup(i);
        continue;
      }
      if (at(i, 'namespace')) {
        let j = i + 1;
        while (j < end && !at(j, '{') && !at(j, ';') && !at(j, '=')) j++;
        if (!at(j, '{')) {
          i = skipDeclaration(i);
          continue;
        }
        const name = text(i + 1, j).replace(/\s+/g, '').replace(/^inline/, '');
        const close = skipGroup(j);
        declarations(j + 1, close - 1, name ? (namespace ? `${namespace}::${name}` : name) : namespace);
        i = close;
        continue;
      }
      // extern "C" { ... }
      if (at(i, 'extern') && tokens[i + 1]?.kind === 'string' && at(i + 2, '{')) {
        const close = skipGroup(i + 2);
        declarations(i + 3, close - 1, namespace);
        i = close;
        continue;
      }
      const first = i;
      const doc = tokens[first].doc ?? attributeDoc;
      attributeDoc = undefined;
      if (at(i, 'template')) {
        const docComment = parseDoc(doc);
        const after = skipAngles(i + 1);
        const nameIndex = functionName(after, end);
        if (nameIndex !== undefined && isMarked(docComment)) result.skipped.push({ name: tokens[nameIndex].text, line: tokens[first].line, reason: 'templates can\'t be nodes yet', marked: true });
        i = skipDeclaration(after);
        continue;
      }
      if (TYPE_KEYWORDS.has(tokens[i].text) && tokens[i].kind === 'name') {
        i = skipDeclaration(i);
        continue;
      }
      const specifiers: string[] = [];
      while (i < end && tokens[i].kind === 'name' && SPECIFIERS.has(tokens[i].text)) specifiers.push(tokens[i++].text);
      const nameIndex = functionName(i, end);
      if (nameIndex === undefined) {
        i = skipDeclaration(first);
        continue;
      }
      const name = tokens[nameIndex].text;
      const open = nameIndex + 1;
      const close = skipGroup(open);
      const declEnd = skipDeclaration(close);
      const returnText = text(i, nameIndex).replace(/\b(inline|constexpr|static|extern)\b/g, '').trim();
      const docComment = parseDoc(doc);
      const skip = (reason: string) => result.skipped.push({ name, line: tokens[first].line, reason, marked: isMarked(docComment), ...(namespace ? { container: namespace } : {}) });
      if (tokens[nameIndex - 1]?.text === '::' || /\boperator\b/.test(text(i, open))) {
        // A member function defined outside its class, or an operator: not a free function.
      } else if (specifiers.includes('static')) skip('static functions can\'t be called from generated code (they belong to their file)');
      else if (returnText === '' || returnText === 'auto') skip('its return type has to be written out');
      else {
        const params = parseParams(open + 1, close - 1);
        const returns = mapReturn(returnText);
        if ('reason' in params) skip(params.reason);
        else if ('reason' in returns) skip(returns.reason);
        else result.functions.push({ name, line: tokens[first].line, params, returns: returns.type, doc: docComment, ...(namespace ? { container: namespace } : {}) });
      }
      i = declEnd;
    }
  };

  // The index of a declared function's name: the name before `(` at the top of the declaration,
  // after a return type.
  const functionName = (i: number, end: number): number | undefined => {
    for (let k = i; k < end; k++) {
      if (at(k, '<')) {
        k = skipAngles(k) - 1;
        continue;
      }
      if (at(k, ';') || at(k, '{') || at(k, '=')) return undefined;
      if (at(k, '(')) return k > i && tokens[k - 1].kind === 'name' ? k - 1 : undefined;
    }
    return undefined;
  };

  const parseParams = (start: number, end: number): ScannedParam[] | { reason: string } => {
    if (end <= start || (end - start === 1 && at(start, 'void'))) return [];
    const pieces: [number, number][] = [];
    let from = start;
    let angles = 0;
    for (let j = start; j < end; j++) {
      const t = tokens[j];
      if (t.kind === 'punct' && (t.text === '(' || t.text === '[' || t.text === '{')) {
        j = skipGroup(j) - 1;
        continue;
      }
      if (t.text === '<') angles++;
      else if (t.text === '>') angles--;
      else if (t.text === '>>') angles -= 2;
      else if (t.text === ',' && angles === 0) {
        pieces.push([from, j]);
        from = j + 1;
      }
    }
    pieces.push([from, end]);
    const params: ScannedParam[] = [];
    for (const [a, b] of pieces) {
      if (at(a, '...') || text(a, b).includes('...')) return { reason: 'variadic functions can\'t be nodes' };
      const eq = tokens.slice(a, b).findIndex((t) => t.text === '=' && t.kind === 'punct');
      const declEnd = eq < 0 ? b : a + eq;
      const nameToken = tokens[declEnd - 1];
      if (!nameToken || nameToken.kind !== 'name' || declEnd - a < 2) return { reason: 'its parameters need names' };
      const typeText = text(a, declEnd - 1);
      const mapped = mapParam(typeText);
      if ('reason' in mapped) return mapped;
      const param: ScannedParam = { name: nameToken.text, ...(mapped.type ? { type: mapped.type } : {}) };
      if (eq >= 0) {
        const value = literal(tokens.slice(declEnd + 1, b));
        if (value !== undefined) param.defaultValue = value;
      }
      params.push(param);
    }
    return params;
  };

  declarations(0, tokens.length, '');
  return result;
}

function parseDoc(lines: string[] | undefined): DocComment {
  if (!lines?.length) return NO_DOC;
  return parseDocText(lines.map((l) => l.replace(/^ ?/, '').replace(/^[\\@]brief\s+/, '')));
}

// ---- Types -------------------------------------------------------------------------------------

const SIMPLE: Record<string, TypeRef> = {
  bool: { id: 'bool' },
  int: { id: 'int' }, long: { id: 'int' }, 'long long': { id: 'int' }, short: { id: 'int' }, 'long int': { id: 'int' }, 'long long int': { id: 'int' },
  int64_t: { id: 'int' }, int32_t: { id: 'int' }, 'std::int64_t': { id: 'int' }, 'std::int32_t': { id: 'int' }, 'std::size_t': { id: 'int' }, size_t: { id: 'int' },
  double: { id: 'float' }, float: { id: 'float' },
  'std::string': { id: 'string' }, 'std::string_view': { id: 'string' }
};

function mapReturn(text: string): { type: TypeRef | null | undefined } | { reason: string } {
  const t = normalize(text);
  if (t === 'void') return { type: null };
  if (/[&*]$/.test(t)) return { reason: 'functions returning references or pointers can\'t be nodes yet' };
  return { type: mapCppType(t) };
}

// A parameter's type: by value or by const reference. Other references and pointers would let
// the function change the caller's value, which pins can't show yet.
function mapParam(text: string): { type: TypeRef | undefined } | { reason: string } {
  let t = normalize(text);
  if (/&&$/.test(t)) return { reason: 'rvalue reference parameters can\'t be pins yet' };
  if (/&$/.test(t)) {
    if (!/^const\b/.test(t) && !/\bconst&$/.test(t)) return { reason: 'non-const reference parameters can\'t be pins yet' };
    t = t.replace(/&$/, '').replace(/^const /, '').replace(/ const$/, '');
  } else if (/\*$/.test(t)) return { reason: 'pointer parameters can\'t be pins yet' };
  return { type: mapCppType(t.replace(/^const /, '')) };
}

// A C++ type, as text, in canonical form. Only types generated code passes on exactly are canonical
// (double is float, long long is int, std::vector is array); others are native.
export function mapCppType(text: string): TypeRef | undefined {
  const t = normalize(text);
  if (t in SIMPLE) return SIMPLE[t];
  const generic = /^std::(vector|set)<(.*)>$/.exec(t);
  if (generic) {
    const element = mapCppType(generic[2]);
    if (!element || element.container || element.id.startsWith('native:')) return { id: `native:${t}` };
    return { id: element.id, container: generic[1] === 'vector' ? 'array' : 'set' };
  }
  return { id: `native:${t}` };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s*([<>,&*:])\s*/g, '$1').replace(/,/g, ', ').replace(/::/g, '::').trim();
}

// ---- Values ------------------------------------------------------------------------------------

function literal(tokens: Token[]): unknown {
  const negative = tokens.length === 2 && tokens[0].text === '-';
  const t = negative ? tokens[1] : tokens.length === 1 ? tokens[0] : undefined;
  if (!t) return undefined;
  if (t.kind === 'number') {
    const n = Number(t.text.replace(/'/g, '').replace(/[fFlL]$/, '').replace(/[uUlL]+$/, ''));
    return Number.isFinite(n) ? (negative ? -n : n) : undefined;
  }
  if (negative) return undefined;
  if (t.kind === 'name') return t.text === 'true' ? true : t.text === 'false' ? false : undefined;
  if (t.kind === 'string' && t.text.startsWith('"')) {
    return t.text.slice(1, -1).replace(/\\(x[0-9a-fA-F]{1,2}|.)/g, (_m, esc: string) => {
      switch (esc[0]) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case '0': return '\0';
        case 'x': return String.fromCharCode(parseInt(esc.slice(1), 16));
        default: return esc;
      }
    });
  }
  return undefined;
}
