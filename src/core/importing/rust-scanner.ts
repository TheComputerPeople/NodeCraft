// Reads the functions of a Rust file that can become nodes (docs/language-breadth.md, "Rust"):
// `pub` (or `pub(crate)`) free functions marked with `/// @blueprint`, in the file's module or in
// inline modules inside it, with their parameters, types and documentation. Like the other scanners
// it parses only declarations and skips bodies by matching brackets.
import { TypeRef } from '../types';
import { DocComment, ModuleScan, NO_DOC, ScannedClass, ScannedFunction, ScannedParam, isMarked, markDeprecated, parseDocText, tupleOutputs } from './symbols';

type TokenKind = 'name' | 'number' | 'string' | 'char' | 'lifetime' | 'punct';

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  start: number;
  end: number;
  doc?: string[];
}

export function tokenizeRust(source: string): Token[] {
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
    // Outer doc comments document the next item; //! and plain comments don't.
    if (source.startsWith('///', i) && !source.startsWith('////', i)) {
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
      // Block comments nest in Rust.
      const start = i;
      const isDoc = source.startsWith('/**', i) && !source.startsWith('/**/', i);
      let depth = 0;
      while (i < source.length) {
        if (source.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (source.startsWith('*/', i)) {
          depth--;
          i += 2;
          if (!depth) break;
        } else i++;
      }
      if (isDoc) doc = source.slice(start + 3, i - 2).split('\n').map((l) => l.replace(/^\s*\*? ?/, ''));
      count(start);
      continue;
    }
    const start = i;
    const startLine = line;
    // Raw strings: r"…", r#"…"#, with an optional b prefix.
    const raw = /^b?r(#*)"/.exec(source.slice(i, i + 16));
    if (raw) {
      const close = source.indexOf(`"${raw[1]}`, i + raw[0].length);
      i = close < 0 ? source.length : close + 1 + raw[1].length;
      count(start);
      push('string', start, startLine);
      continue;
    }
    if (ch === '"' || (ch === 'b' && source[i + 1] === '"')) {
      i += ch === 'b' ? 2 : 1;
      while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
      i++;
      count(start);
      push('string', start, startLine);
      continue;
    }
    // A char ('a', '\n') or a lifetime ('a, 'static).
    if (ch === '\'') {
      const char = /^'(\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'])'/u.exec(source.slice(i, i + 12));
      if (char) {
        i += char[0].length;
        push('char', start, startLine);
      } else {
        i++;
        while (i < source.length && /\w/.test(source[i])) i++;
        push('lifetime', start, startLine);
      }
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      while (i < source.length && /\w/.test(source[i])) i++;
      push('name', start, startLine);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      while (i < source.length && /[\w.]/.test(source[i]) && !(source[i] === '.' && source[i + 1] === '.')) i++;
      push('number', start, startLine);
      continue;
    }
    for (const op of ['::', '->', '=>', '..']) {
      if (source.startsWith(op, i)) {
        i += op.length;
        break;
      }
    }
    if (i === start) i++;
    push('punct', start, startLine);
  }
  return tokens;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const SKIPPED_ITEMS = new Set(['struct', 'enum', 'union', 'trait', 'impl', 'type', 'const', 'static', 'use', 'macro_rules', 'extern']);

export function scanRust(source: string): ModuleScan {
  const tokens = tokenizeRust(source);
  const result: ModuleScan = { functions: [], skipped: [] };
  // The lines of items marked #[deprecated].
  const deprecatedLines = new Map<number, { message?: string }>();
  const text = (start: number, end: number) => (end > start ? source.slice(tokens[start].start, tokens[end - 1].end) : '');
  const at = (i: number, value: string) => tokens[i]?.text === value && tokens[i].kind !== 'string' && tokens[i].kind !== 'char';
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
      if (at(j, '(') || at(j, '[')) j = skipGroup(j) - 1;
      else if (at(j, '<')) depth++;
      else if (at(j, '>') && --depth === 0) return j + 1;
    }
    return tokens.length;
  };
  // The end of an item starting at `i`: after its `;` or its `{…}` body.
  const skipItem = (i: number): number => {
    for (let j = i; j < tokens.length; j++) {
      if (at(j, '(') || at(j, '[')) j = skipGroup(j) - 1;
      else if (at(j, '{')) return skipGroup(j);
      else if (at(j, ';')) return j + 1;
    }
    return tokens.length;
  };

  // A struct's objects are classes (docs/node-authoring.md, gap 2): its pub fields, with the methods
  // and constructor of its impl blocks in the file.
  const structs = new Map<string, ScannedClass>();
  const impls: { name: string; module: string; methods: ScannedFunction[]; constructors: ScannedFunction[] }[] = [];

  // `struct Name { pub field: Type, … }` at `i` (after its visibility).
  const struct = (i: number, first: number, module: string, doc: DocComment): number => {
    const nameToken = tokens[i + 1];
    if (nameToken?.kind !== 'name' || !at(i + 2, '{')) return skipItem(i);
    const close = skipGroup(i + 2);
    const name = nameToken.text;
    const cls: ScannedClass = { name: module ? `${module}::${name}` : name, line: tokens[first].line, doc, type: mapRustType(name) ?? { id: `native:${name}` }, methods: [], properties: [] };
    let j = i + 3;
    while (j < close - 1) {
      let fieldDoc = tokens[j].doc;
      let fieldDeprecation: { message?: string } | undefined;
      while (at(j, '#') && at(j + 1, '[')) {
        fieldDoc = tokens[j].doc ?? fieldDoc;
        fieldDeprecation = deprecatedAttribute(text(j, skipGroup(j + 1))) ?? fieldDeprecation;
        j = skipGroup(j + 1);
      }
      const fieldFirst = j;
      if (fieldDeprecation) deprecatedLines.set(tokens[fieldFirst].line, fieldDeprecation);
      const pub = at(j, 'pub');
      if (pub) j = at(j + 1, '(') ? skipGroup(j + 1) : j + 1;
      let k = j;
      while (k < close - 1 && !at(k, ',')) k = at(k, '<') ? skipAngles(k) : at(k, '(') || at(k, '[') ? skipGroup(k) : k + 1;
      if (tokens[j]?.kind === 'name' && at(j + 1, ':')) {
        const fieldDocComment = parseDoc(fieldDoc);
        const field = tokens[j].text;
        if (!pub) {
          if (isMarked(fieldDocComment)) result.skipped.push({ name: `${name}.${field}`, line: tokens[fieldFirst].line, reason: "it isn't pub, so generated code can't use it", marked: true });
        } else {
          const type = mapRustType(text(j + 2, k));
          cls.properties.push({ name: field, line: tokens[fieldFirst].line, ...(type ? { type } : {}), readonly: false, doc: fieldDocComment });
        }
      }
      j = k + 1;
    }
    structs.set(name, cls);
    return close;
  };

  // `impl Name { … }` at `i`: its pub functions taking self are methods; those returning Self or
  // the type are constructors.
  const impl = (i: number, module: string): number => {
    if (at(i + 1, '<')) return skipItem(i);
    let j = i + 1;
    const nameToken = tokens[j];
    if (nameToken?.kind !== 'name' || !at(j + 1, '{')) return skipItem(i);
    j++;
    const close = skipGroup(j);
    const name = nameToken.text;
    const block = { name, module, methods: [] as ScannedFunction[], constructors: [] as ScannedFunction[] };
    let k = j + 1;
    while (k < close - 1) {
      let doc = tokens[k].doc;
      let deprecation: { message?: string } | undefined;
      while (at(k, '#') && at(k + 1, '[')) {
        doc = tokens[k].doc ?? doc;
        deprecation = deprecatedAttribute(text(k, skipGroup(k + 1))) ?? deprecation;
        k = skipGroup(k + 1);
      }
      const first = k;
      if (deprecation) deprecatedLines.set(tokens[first].line, deprecation);
      const pub = at(k, 'pub');
      if (pub) k = at(k + 1, '(') ? skipGroup(k + 1) : k + 1;
      const isAsync = at(k, 'async');
      if (isAsync) k++;
      if (!at(k, 'fn') || tokens[k + 1]?.kind !== 'name') {
        k = skipItem(k);
        continue;
      }
      const fnName = tokens[k + 1].text;
      let open = k + 2;
      const generic = at(open, '<');
      if (generic) open = skipAngles(open);
      const paramsClose = skipGroup(open);
      let r = paramsClose;
      let returnText = '';
      if (at(r, '->')) {
        r++;
        const from = r;
        while (r < close && !at(r, '{') && !at(r, ';') && !at(r, 'where')) r = at(r, '<') ? skipAngles(r) : at(r, '(') || at(r, '[') ? skipGroup(r) : r + 1;
        returnText = text(from, r);
      }
      const docComment = parseDoc(doc);
      const skip = (reason: string) => {
        if (isMarked(docComment)) result.skipped.push({ name: `${name}.${fnName}`, line: tokens[first].line, reason, marked: true });
      };
      // The receiver: &self, &mut self (a method), or none.
      let p = open + 1;
      if (at(p, '&')) p++;
      if (at(p, 'mut')) p++;
      const method = at(p, 'self');
      const afterSelf = method ? (at(p + 1, ',') ? p + 2 : p + 1) : open + 1;
      if (!pub) skip("it isn't pub, so generated code can't call it");
      else if (isAsync) skip("async functions can't be nodes yet");
      else if (generic) skip("generic functions can't be nodes yet");
      else if (method && at(open + 1, 'self')) skip('methods that take self by value would consume the object; take &self or &mut self');
      else {
        const params = parseParams(afterSelf, paramsClose - 1);
        if ('reason' in params) skip(params.reason);
        else if (method) {
          const returns = mapReturn(returnText);
          if ('reason' in returns) skip(returns.reason);
          else block.methods.push(withOutputs({ name: fnName, line: tokens[first].line, params, returns: returns.type, doc: docComment }, returnText));
        } else if (returnText === 'Self' || returnText === name) block.constructors.push({ name: fnName, line: tokens[first].line, params, returns: null, doc: docComment });
        else skip('associated functions without self have no object; make it a free function instead');
      }
      k = skipItem(paramsClose);
    }
    impls.push(block);
    return close;
  };

  const items = (i: number, end: number, module: string): void => {
    let attributeDoc: string[] | undefined;
    let testOnly = false;
    let deprecation: { message?: string } | undefined;
    while (i < end) {
      // Attributes: #[…]; a #[cfg(test)] item is left out, a #[deprecated] one marked.
      if (at(i, '#') && at(i + 1, '[')) {
        attributeDoc = tokens[i].doc ?? attributeDoc;
        deprecation = deprecatedAttribute(text(i, skipGroup(i + 1))) ?? deprecation;
        if (/^#\[\s*cfg\s*\(\s*test\s*\)\s*\]$/.test(text(i, skipGroup(i + 1)))) testOnly = true;
        i = skipGroup(i + 1);
        continue;
      }
      if (at(i, '#') && at(i + 1, '!')) {
        i = skipGroup(i + 2);
        continue;
      }
      const first = i;
      const doc = tokens[first].doc ?? attributeDoc;
      attributeDoc = undefined;
      if (deprecation) deprecatedLines.set(tokens[first].line, deprecation);
      deprecation = undefined;
      const skipTest = testOnly;
      testOnly = false;
      // Visibility: pub, pub(crate), pub(super), pub(in path).
      let visibility = '';
      if (at(i, 'pub')) {
        visibility = 'pub';
        i++;
        if (at(i, '(')) {
          visibility = text(first, skipGroup(i));
          i = skipGroup(i);
        }
      }
      if (at(i, 'mod') && tokens[i + 1]?.kind === 'name') {
        const name = tokens[i + 1].text;
        if (at(i + 2, '{')) {
          const close = skipGroup(i + 2);
          if (!skipTest) items(i + 3, close - 1, module ? `${module}::${name}` : name);
          i = close;
        } else i = skipItem(i);
        continue;
      }
      const qualifiers: string[] = [];
      while (['const', 'async', 'unsafe', 'extern'].includes(tokens[i]?.text ?? '') && tokens[i].kind === 'name' && !at(i + 1, '{')) {
        qualifiers.push(tokens[i].text);
        i++;
        if (qualifiers[qualifiers.length - 1] === 'extern' && tokens[i]?.kind === 'string') i++;
      }
      if (!qualifiers.length && at(i, 'struct') && visibility && !skipTest) {
        i = struct(i, first, module, parseDoc(doc));
        continue;
      }
      if (!qualifiers.length && at(i, 'impl') && !skipTest) {
        i = impl(i, module);
        continue;
      }
      if (!at(i, 'fn') || tokens[i + 1]?.kind !== 'name') {
        i = SKIPPED_ITEMS.has(tokens[i]?.text ?? '') || !qualifiers.length ? skipItem(first) : skipItem(i);
        continue;
      }
      const name = tokens[i + 1].text;
      let k = i + 2;
      const generic = at(k, '<');
      if (generic) k = skipAngles(k);
      if (!at(k, '(')) {
        i = skipItem(i);
        continue;
      }
      const close = skipGroup(k);
      let r = close;
      let returnText = '';
      if (at(r, '->')) {
        r++;
        const from = r;
        while (r < tokens.length && !at(r, '{') && !at(r, ';') && !at(r, 'where')) r = at(r, '<') ? skipAngles(r) : at(r, '(') || at(r, '[') ? skipGroup(r) : r + 1;
        returnText = text(from, r);
      }
      const itemEnd = skipItem(close);
      const docComment = parseDoc(doc);
      const skip = (reason: string) => result.skipped.push({ name, line: tokens[first].line, reason, marked: isMarked(docComment), ...(module ? { container: module } : {}) });
      if (skipTest) {
        // Test code isn't part of the program.
      } else if (visibility !== 'pub' && visibility !== 'pub(crate)') skip('it isn\'t pub or pub(crate), so generated code can\'t call it');
      else if (qualifiers.includes('async')) skip('async functions can\'t be nodes yet');
      else if (qualifiers.includes('unsafe')) skip('unsafe functions can\'t be nodes');
      else if (qualifiers.includes('extern')) skip('extern functions can\'t be nodes');
      else if (generic) skip('generic functions can\'t be nodes yet');
      else {
        const params = parseParams(k + 1, close - 1);
        const returns = mapReturn(returnText);
        if ('reason' in params) skip(params.reason);
        else if ('reason' in returns) skip(returns.reason);
        else result.functions.push(withOutputs({ name, line: tokens[first].line, params, returns: returns.type, doc: docComment, ...(module ? { container: module } : {}) }, returnText));
      }
      i = itemEnd;
    }
  };

  const parseParams = (start: number, end: number): ScannedParam[] | { reason: string } => {
    if (end <= start) return [];
    const pieces: [number, number][] = [];
    let from = start;
    let angles = 0;
    for (let j = start; j < end; j++) {
      if (at(j, '(') || at(j, '[') || at(j, '{')) {
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
      if (at(s, 'mut')) s++;
      if (tokens[s]?.kind !== 'name' || !at(s + 1, ':')) return { reason: 'self and pattern parameters can\'t be pins' };
      const mapped = mapParam(text(s + 2, b));
      if ('reason' in mapped) return mapped;
      params.push({ name: tokens[s].text, ...(mapped.type ? { type: mapped.type } : {}) });
    }
    return params;
  };

  items(0, tokens.length, '');
  // Each struct with its impl blocks' methods and constructor (a marked one, else `new`).
  for (const block of impls) {
    const cls = structs.get(block.name);
    if (!cls) continue;
    cls.methods.push(...block.methods);
    cls.init = block.constructors.find((c) => isMarked(c.doc)) ?? block.constructors.find((c) => c.name === 'new') ?? cls.init;
  }
  if (structs.size) result.classes = [...structs.values()];
  return markDeprecated(result, deprecatedLines);
}

// #[deprecated], #[deprecated = "message"] or #[deprecated(since = "…", note = "message")]
// (docs/node-authoring.md, gap 6).
function deprecatedAttribute(text: string): { message?: string } | undefined {
  const match = /^#\s*\[\s*deprecated\b([\s\S]*)\]$/.exec(text.trim());
  if (!match) return undefined;
  const note = /(?:\bnote\s*=\s*|^\s*=\s*)"([^"]*)"/.exec(match[1]);
  return note ? { message: note[1] } : {};
}

function parseDoc(lines: string[] | undefined): DocComment {
  if (!lines?.length) return NO_DOC;
  return parseDocText(lines.map((l) => l.replace(/^ ?/, '')));
}

// ---- Types -------------------------------------------------------------------------------------

const SIMPLE: Record<string, TypeRef> = {
  bool: { id: 'bool' },
  i64: { id: 'int' }, f64: { id: 'float' },
  String: { id: 'string' }, 'std::string::String': { id: 'string' }
};

// Several outputs (docs/node-authoring.md, gap 3): a tuple's elements, named by @outputs.
function withOutputs(fn: ScannedFunction, returnText: string): ScannedFunction {
  const t = normalize(returnText);
  if (!t.startsWith('(') || !t.endsWith(')')) return fn;
  const elements = splitTopCommas(t.slice(1, -1)).map((e) => e.trim()).filter(Boolean);
  const outputs = tupleOutputs(fn.doc, elements.map((e) => mapRustType(e)));
  return outputs ? { ...fn, returns: undefined, outputs, results: { kind: 'tuple', names: outputs.map((o) => o.name) } } : fn;
}

// Splits at commas outside <>, () and [].
function splitTopCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if ('<(['.includes(text[i])) depth++;
    else if ('>)]'.includes(text[i])) depth--;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

function mapReturn(text: string): { type: TypeRef | null | undefined } | { reason: string } {
  const t = normalize(text);
  if (t === '' || t === '()') return { type: null };
  if (t.startsWith('&')) return { reason: 'functions returning references can\'t be nodes yet' };
  if (t.startsWith('impl ')) return { reason: 'functions returning impl Trait can\'t be nodes' };
  return { type: mapRustType(t) };
}

// Parameters are owned values, as generated code passes them (i64, f64, bool, String, Vec<T>);
// references would need generated code to borrow, which it doesn't yet.
function mapParam(text: string): { type: TypeRef | undefined } | { reason: string } {
  const t = normalize(text);
  if (t.startsWith('&')) return { reason: `reference parameters can't be pins yet (take an owned value, such as String instead of &str)` };
  if (t.startsWith('impl ')) return { reason: 'impl Trait parameters can\'t be pins' };
  return { type: mapRustType(t) };
}

// A Rust type, as text, in canonical form. Only the types generated code uses for canonical ones
// map to them (f64 is float, i64 is int, Vec<T> is array); others are native.
export function mapRustType(text: string): TypeRef | undefined {
  const t = normalize(text);
  if (t in SIMPLE) return SIMPLE[t];
  const vec = /^(?:std::vec::)?Vec<(.*)>$/.exec(t);
  if (vec) {
    const element = mapRustType(vec[1]);
    if (!element || element.container || element.id.startsWith('native:')) return { id: `native:${t}` };
    return { id: element.id, container: 'array' };
  }
  return { id: `native:${t}` };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s*([<>,&:])\s*/g, '$1').replace(/,/g, ', ').replace(/&mut/g, '&mut ').trim();
}
