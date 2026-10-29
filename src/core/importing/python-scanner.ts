// Reads the top-level functions of a Python module: names, parameters, type hints, defaults and
// docstrings (docs/code-as-nodes.md, "How declarations are read"). It works on logical lines, so it
// needs no Python interpreter.
import { TypeRef } from '../types';
import { DocComment, ModuleScan, NO_DOC, ScannedClass, ScannedFunction, ScannedParam, ScannedProperty, TOO_MANY_TYPE_PARAMETERS, isMarked, parseDocText, substituteTypeParameters, tupleOutputs, typeParameterNames, wildcardType } from './symbols';

interface LogicalLine {
  // Columns of leading whitespace (a tab counts as one).
  indent: number;
  // 1-based line where it starts.
  line: number;
  // The source text, with continuation lines joined and comments removed.
  text: string;
  // The same text with every string literal's contents removed, for finding keywords.
  code: string;
}

// ---- Logical lines -------------------------------------------------------------------------------

export function logicalLines(source: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let i = 0;
  let line = 1;
  while (i < source.length) {
    // Indentation of a new logical line.
    let indent = 0;
    while (source[i] === ' ' || source[i] === '\t') {
      indent++;
      i++;
    }
    const startLine = line;
    let text = '';
    let code = '';
    let depth = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\n' || (ch === '\r' && source[i + 1] === '\n')) {
        const width = ch === '\r' ? 2 : 1;
        if (depth > 0) {
          text += ' ';
          code += ' ';
          i += width;
          line++;
          continue;
        }
        i += width;
        line++;
        break;
      }
      if (ch === '\\' && (source[i + 1] === '\n' || source[i + 1] === '\r')) {
        i += source[i + 1] === '\r' ? 3 : 2;
        line++;
        text += ' ';
        code += ' ';
        continue;
      }
      if (ch === '#') {
        while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
        continue;
      }
      const literal = stringAt(source, i);
      if (literal) {
        const value = source.slice(i, literal.end);
        for (const c of value) if (c === '\n') line++;
        text += value;
        code += `${literal.prefix}${literal.quote}${literal.quote}`;
        i = literal.end;
        continue;
      }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      text += ch;
      code += ch;
      i++;
    }
    if (text.trim()) lines.push({ indent, line: startLine, text: text.trim(), code: code.trim() });
  }
  return lines;
}

// A string literal starting at `i` (with an optional prefix such as r, b or f), if there is one.
function stringAt(source: string, i: number): { end: number; prefix: string; quote: string } | undefined {
  const prefixMatch = /^[rRbBuUfF]{0,2}(?=['"])/.exec(source.slice(i, i + 3));
  if (!prefixMatch) return undefined;
  // A prefix must start a word: "br" in "abr'x'" is not one.
  if (prefixMatch[0] && /[\w]/.test(source[i - 1] ?? '')) return undefined;
  const prefix = prefixMatch[0];
  let j = i + prefix.length;
  const q = source[j];
  const triple = source.startsWith(q.repeat(3), j);
  const quote = triple ? q.repeat(3) : q;
  j += quote.length;
  while (j < source.length) {
    // A backslash keeps the next character in the string, raw strings included.
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source.startsWith(quote, j)) return { end: j + quote.length, prefix, quote };
    if (!triple && source[j] === '\n') return { end: j, prefix, quote };
    j++;
  }
  return { end: source.length, prefix, quote };
}

// ---- Functions -------------------------------------------------------------------------------------

export function scanPython(source: string): ModuleScan {
  const lines = logicalLines(source);
  const result: ModuleScan = { functions: [], skipped: [] };
  // Module-level TypeVars (T = TypeVar("T")): a function whose types use them is generic.
  const typeVars = new Set(lines.filter((l) => l.indent === 0).map((l) => /^([A-Za-z_]\w*)\s*=\s*(?:typing\.|typing_extensions\.)?TypeVar\(/.exec(l.code)?.[1]).filter((n): n is string => !!n));
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indent !== 0) continue;
    if (/^class\s/.test(lines[i].code)) {
      const cls = scanClass(lines, i, result, typeVars);
      if (cls) (result.classes ??= []).push(cls);
      continue;
    }
    const def = scanDef(lines, i, false, typeVars);
    if (!def) continue;
    if ('reason' in def.result) result.skipped.push({ name: def.name, line: def.line, reason: def.result.reason, marked: isMarked(def.doc) });
    else result.functions.push(def.result);
  }
  // A function returning a NamedTuple of the module gives its fields as outputs.
  const namedTuples = new Map((result.classes ?? []).filter((c) => c.base?.id === 'native:NamedTuple').map((c) => [c.type.id, c.properties]));
  const withFields = (fn: ScannedFunction): ScannedFunction => {
    const fields = fn.returns ? namedTuples.get(fn.returns.id) : undefined;
    if (!fields || fields.length < 2) return fn;
    const outputs = fields.map((f) => ({ name: f.name, ...(f.type ? { type: f.type } : {}) }));
    return { ...fn, returns: undefined, outputs, results: { kind: 'fields', names: outputs.map((o) => o.name) } };
  };
  result.functions = result.functions.map(withFields);
  for (const cls of result.classes ?? []) cls.methods = cls.methods.map(withFields);
  return result;
}

// The `def` at lines[i]: the function, or why it can't be a node. A method's first parameter
// (self) isn't a pin.
function scanDef(lines: LogicalLine[], i: number, method: boolean, typeVars: ReadonlySet<string> = new Set()): { name: string; line: number; doc: DocComment; result: ScannedFunction | { reason: string } } | undefined {
  const header = lines[i];
  const match = /^(async\s+)?def\s+([A-Za-z_]\w*)\s*(\[)?/.exec(header.text);
  if (!match) return undefined;
  // The body: the following lines indented under the header (or the rest of a one-line def).
  const body: LogicalLine[] = [];
  for (let j = i + 1; j < lines.length && lines[j].indent > header.indent; j++) body.push(lines[j]);
  const name = match[2];
  const line = header.line;
  const doc = body.length ? docstring(body[0]) : NO_DOC;
  const skip = (reason: string) => ({ name, line, doc, result: { reason } });
  // Type parameters (PEP 695's [T], or module TypeVars it uses) are wildcard pins
  // (docs/node-authoring.md, gap 10).
  const close = match[3] ? matching(header.text, match[0].length - 1) : -1;
  if (match[3] && close < 0) return skip('its parameters couldn\'t be read');
  const own = match[3] ? typeParameterNames(header.text.slice(match[0].length, close)) : [];
  const header695 = parseHeader(header.text, match[3] ? close + 1 : match[0].length);
  const used = header695 ? [...typeVars].filter((v) => new RegExp(`(?<![\\w])${v}(?![\\w])`).test(`${header695.params} ${header695.returns ?? ''}`)) : [];
  const typeParameters = [...own, ...used.filter((v) => !own.includes(v))];
  if (typeParameters.length > 2) return skip(TOO_MANY_TYPE_PARAMETERS);
  const parsed = header695 && { ...header695, params: substituteTypeParameters(header695.params, typeParameters), ...(header695.returns !== undefined ? { returns: substituteTypeParameters(header695.returns, typeParameters) } : {}) };
  if (!parsed) return skip('its parameters couldn\'t be read');
  const inline = parsed.rest ? [{ indent: header.indent + 1, line, text: parsed.rest, code: parsed.rest }] : [];
  const statements = [...inline, ...body];
  const params = parseParams(method ? splitTop(parsed.params, ',').slice(1).join(',') : parsed.params);
  // Async (docs/node-authoring.md, gap 4): an `async def`, or a def returning an Awaitable or
  // Coroutine, is a latent node whose value is what it gives when awaited.
  const awaitable = parsed.returns !== undefined ? /^(?:Awaitable|Coroutine)\[(.*)\]$/.exec(normalize(parsed.returns)) : null;
  const latent = !!match[1] || !!awaitable;
  const returnText = awaitable ? splitTop(awaitable[1], ',').pop()!.trim() : parsed.returns;
  const returns = returnText !== undefined ? mapReturn(returnText) : { type: returnsValue(statements) ? undefined : null };
  if ('reason' in params) return skip(params.reason);
  if ('reason' in returns) return skip(returns.reason);
  if (yields(statements)) return skip('generator functions can\'t be nodes');
  // PEP 702's @deprecated("message") (warnings or typing_extensions; docs/node-authoring.md, gap 6).
  const decorators: string[] = [];
  for (let d = i - 1; d >= 0 && lines[d].indent === header.indent && lines[d].text.startsWith('@'); d--) decorators.push(lines[d].text);
  const marker = decorators.map((d) => /^@(?:\w+\.)*deprecated\b\s*(?:\(\s*[rRbBuU]?(["'])(.*?)\1)?/.exec(d)).find(Boolean);
  const deprecated = marker ? { deprecated: marker[2] ? { message: marker[2] } : {} } : {};
  if (latent) return { name, line, doc, result: { name, line, params, returns: returns.type, doc, latent, ...deprecated } };
  // Several outputs (docs/node-authoring.md, gap 3): a tuple, named by @outputs.
  const tuple = parsed.returns !== undefined ? /^(?:tuple|Tuple)\[(.*)\]$/.exec(normalize(parsed.returns)) : null;
  const outputs = tuple ? tupleOutputs(doc, splitTop(tuple[1], ',').map((t) => mapPythonType(t))) : undefined;
  if (outputs) return { name, line, doc, result: { name, line, params, returns: undefined, doc, outputs, results: { kind: 'tuple', names: outputs.map((o) => o.name) }, ...deprecated } };
  return { name, line, doc, result: { name, line, params, returns: returns.type, doc, ...deprecated } };
}

// A class (docs/node-authoring.md, gap 2): its __init__, public methods, properties (@property,
// writable with a setter) and annotated attributes, each documented by the string after it.
function scanClass(lines: LogicalLine[], i: number, result: ModuleScan, typeVars: ReadonlySet<string> = new Set()): ScannedClass | undefined {
  const header = lines[i];
  const match = /^class\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*(?:\((.*)\))?\s*:/.exec(header.text);
  if (!match) return undefined;
  const name = match[1];
  const bases = splitTop(match[2] ?? '', ',').map((b) => b.trim()).filter((b) => b && !b.includes('='));
  const end = lines.findIndex((l, j) => j > i && l.indent === 0);
  const body = lines.slice(i + 1, end < 0 ? lines.length : end);
  if (!body.length) return undefined;
  const indent = body[0].indent;
  const base = bases.map((b) => mapPythonType(b)).find((t) => t?.id.startsWith('native:') && !/^native:(ABC|Generic|Protocol)\b/.test(t.id));
  const cls: ScannedClass = {
    name, line: header.line, doc: docstring(body[0]), type: mapPythonType(name) ?? { id: `native:${name}` },
    ...(base ? { base } : {}), ...(bases.includes('ABC') || /metaclass\s*=\s*ABCMeta/.test(match[2] ?? '') ? { abstract: true } : {}),
    methods: [], properties: []
  };
  const getters = new Map<string, ScannedProperty>();
  const setters = new Set<string>();
  for (let k = 0; k < body.length; k++) {
    const member = body[k];
    if (member.indent !== indent) continue;
    const skip = (memberName: string, reason: string, doc: DocComment): void => {
      if (isMarked(doc)) result.skipped.push({ name: `${name}.${memberName}`, line: member.line, reason, marked: true });
    };
    // An annotated attribute (`health: int = 100`), documented by a string on the next line.
    const attribute = /^([A-Za-z_]\w*)\s*:\s*([^=]+?)\s*(=.*)?$/.exec(member.text);
    if (attribute && !/^(def|class|async)\b/.test(member.code)) {
      const next = body[k + 1];
      const doc = next && next.indent === indent ? docstring(next) : NO_DOC;
      const attributeName = attribute[1];
      if (attributeName.startsWith('_')) skip(attributeName, "it isn't public", doc);
      else if (/^ClassVar\b/.test(attribute[2].trim())) skip(attributeName, "class variables have no object; they can't be nodes yet", doc);
      else {
        const type = mapPythonType(attribute[2]);
        cls.properties.push({ name: attributeName, line: member.line, ...(type ? { type } : {}), readonly: false, doc });
      }
      continue;
    }
    const def = scanDef(body, k, true, typeVars);
    if (!def) continue;
    const decorators: string[] = [];
    for (let d = k - 1; d >= 0 && body[d].indent === indent && body[d].text.startsWith('@'); d--) decorators.push(body[d].text);
    const memberName = def.name;
    if (decorators.some((d) => /^@(staticmethod|classmethod)\b/.test(d))) skip(memberName, 'static methods of a class have no object; make it a module function instead', def.doc);
    else if (memberName.startsWith('_') && memberName !== '__init__') skip(memberName, "it isn't public", def.doc);
    else if (decorators.some((d) => new RegExp(`^@${memberName}\\.setter\\b`).test(d))) setters.add(memberName);
    else if ('reason' in def.result) skip(memberName, def.result.reason, def.doc);
    else if (decorators.some((d) => /^@(property|functools\.cached_property|cached_property)\b/.test(d))) {
      getters.set(memberName, { name: memberName, line: def.line, ...(def.result.returns ? { type: def.result.returns } : {}), readonly: true, doc: def.doc, ...(def.result.deprecated ? { deprecated: def.result.deprecated } : {}) });
    } else if (memberName === '__init__') cls.init = { ...def.result, returns: null };
    else cls.methods.push(def.result);
  }
  for (const [getter, property] of getters) cls.properties.push({ ...property, readonly: !setters.has(getter) });
  return cls;
}

// `def name(params) -> returns: rest`, from just after the name.
function parseHeader(text: string, from: number): { params: string; returns?: string; rest: string } | undefined {
  let i = from;
  while (text[i] === ' ') i++;
  if (text[i] !== '(') return undefined;
  const close = matching(text, i);
  if (close < 0) return undefined;
  const params = text.slice(i + 1, close);
  const after = text.slice(close + 1);
  const colon = topLevelIndex(after, ':');
  if (colon < 0) return undefined;
  const between = after.slice(0, colon).trim();
  const rest = after.slice(colon + 1).trim();
  if (!between) return { params, rest };
  if (!between.startsWith('->')) return undefined;
  return { params, returns: between.slice(2).trim(), rest };
}

function parseParams(text: string): ScannedParam[] | { reason: string } {
  const params: ScannedParam[] = [];
  let keywordOnly = false;
  for (const raw of splitTop(text, ',')) {
    const part = raw.trim();
    if (!part || part === '/') continue;
    if (part === '*') {
      keywordOnly = true;
      continue;
    }
    if (part.startsWith('**') || part.startsWith('*')) return { reason: 'variadic parameters (*args, **kwargs) can\'t be pins' };
    const eq = topLevelIndex(part, '=');
    const declaration = (eq < 0 ? part : part.slice(0, eq)).trim();
    const defaultText = eq < 0 ? undefined : part.slice(eq + 1).trim();
    const colon = declaration.indexOf(':');
    const name = (colon < 0 ? declaration : declaration.slice(0, colon)).trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) return { reason: 'its parameters couldn\'t be read' };
    // Keyword-only parameters with defaults keep their defaults; without one, a call would fail.
    if (keywordOnly) {
      if (defaultText === undefined) return { reason: 'keyword-only parameters without defaults can\'t be pins yet' };
      continue;
    }
    const type = colon < 0 ? undefined : mapPythonType(declaration.slice(colon + 1));
    const param: ScannedParam = { name, ...(type ? { type } : {}) };
    if (defaultText !== undefined) {
      const value = literalValue(defaultText);
      if (value !== undefined) param.defaultValue = value;
    }
    params.push(param);
  }
  return params;
}

// The docstring: a body whose first statement is a string literal.
function docstring(first: LogicalLine): DocComment {
  const literal = stringAt(first.text, 0);
  if (!literal || literal.end !== first.text.length || /[bBfF]/.test(literal.prefix)) return NO_DOC;
  const body = first.text.slice(literal.prefix.length + literal.quote.length, literal.end - literal.quote.length);
  return parseDocText(cleandoc(/[rR]/.test(literal.prefix) ? body : unescape(body)));
}

// inspect.cleandoc: trims the first line and removes the common indentation of the rest.
function cleandoc(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const rest = lines.slice(1);
  const indents = rest.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length);
  const margin = indents.length ? Math.min(...indents) : 0;
  const cleaned = [lines[0].trim(), ...rest.map((l) => l.slice(margin))];
  while (cleaned.length && !cleaned[0].trim()) cleaned.shift();
  while (cleaned.length && !cleaned[cleaned.length - 1].trim()) cleaned.pop();
  return cleaned;
}

// Statements of the function itself: nested functions and classes are left out.
function ownStatements(statements: LogicalLine[]): LogicalLine[] {
  const own: LogicalLine[] = [];
  let nested: number | undefined;
  for (const s of statements) {
    if (nested !== undefined && s.indent > nested) continue;
    nested = undefined;
    if (/^(async\s+def|def|class)\b/.test(s.code)) nested = s.indent;
    else own.push(s);
  }
  return own;
}

function returnsValue(statements: LogicalLine[]): boolean {
  return ownStatements(statements).some((s) => /(^|[:;]\s*)return\s+[^\s;]/.test(s.code));
}

function yields(statements: LogicalLine[]): boolean {
  return ownStatements(statements).some((s) => /\byield\b/.test(s.code.replace(/lambda[^:]*:.*$/, '')));
}

// ---- Types -------------------------------------------------------------------------------------

const SIMPLE: Record<string, TypeRef | undefined> = {
  int: { id: 'int' },
  float: { id: 'float' },
  str: { id: 'string' },
  bool: { id: 'bool' },
  Any: undefined,
  object: undefined
};

function mapReturn(text: string): { type: TypeRef | null | undefined } | { reason: string } {
  const t = normalize(text);
  if (t === 'None' || t === 'NoReturn' || t === 'Never') return { type: null };
  if (/^(Awaitable|Coroutine|Generator|Iterator|Iterable|AsyncGenerator|AsyncIterator)\b/.test(t)) {
    return { reason: /^(Awaitable|Coroutine)/.test(t) ? 'it gives an awaitable when awaited' : 'generator functions can\'t be nodes' };
  }
  if (/^TypeGuard\[|^TypeIs\[/.test(t)) return { type: { id: 'bool' } };
  return { type: mapPythonType(t) };
}

// A Python type hint, as text, in canonical form (docs/code-as-nodes.md, "What becomes a node").
export function mapPythonType(text: string): TypeRef | undefined {
  let t = normalize(text);
  const wildcard = wildcardType(t);
  if (wildcard) return wildcard;
  // Forward references are strings.
  if (/^(['"]).*\1$/.test(t)) t = normalize(t.slice(1, -1));
  const union = splitTop(t, '|').map((m) => m.trim());
  if (union.length > 1) return unionOf(union, t);
  const generic = /^([\w.]+)\[(.*)\]$/.exec(t);
  if (generic) {
    const name = generic[1];
    const args = splitTop(generic[2], ',').map((a) => a.trim());
    switch (name) {
      case 'Optional':
        return args.length === 1 ? unionOf([args[0], 'None'], t) : native(t);
      case 'Union':
        return unionOf(args, t);
      case 'Literal':
        if (args.every((a) => /^(['"]).*\1$/.test(a))) return { id: 'string' };
        if (args.every((a) => /^-?\d+$/.test(a))) return { id: 'int' };
        return native(t);
      case 'list':
      case 'List':
      case 'Sequence':
      case 'MutableSequence':
        return args.length === 1 ? container('array', args[0], t) : native(t);
      case 'set':
      case 'Set':
      case 'MutableSet':
        return args.length === 1 ? container('set', args[0], t) : native(t);
      case 'dict':
      case 'Dict':
      case 'Mapping':
      case 'MutableMapping': {
        if (args.length !== 2) return native(t);
        const key = mapPythonType(args[0]);
        const value = mapPythonType(args[1]);
        if (!key || key.container || key.nullable || key.id.startsWith('native:') || (value && (value.container || value.id.startsWith('native:')))) return native(t);
        return { id: key.id, container: 'map', valueType: value ?? { id: 'any' } };
      }
    }
    return native(t);
  }
  if (t in SIMPLE) return SIMPLE[t];
  if (t === 'list' || t === 'List') return { id: 'any', container: 'array' };
  if (t === 'set' || t === 'Set') return { id: 'any', container: 'set' };
  if (t === 'dict' || t === 'Dict') return { id: 'any', container: 'map', valueType: { id: 'any' } };
  return native(t);
}

// `T | None` is a nullable T; a union of string or int literals is that type; anything else is native.
function unionOf(members: string[], whole: string): TypeRef {
  const rest = members.filter((m) => m !== 'None');
  if (rest.length === members.length - 1 && rest.length === 1) {
    const inner = mapPythonType(rest[0]);
    if (!inner) return { id: 'any' };
    if (!inner.nullable && !inner.id.startsWith('native:')) return { ...inner, nullable: true };
  }
  return native(whole);
}

function container(kind: 'array' | 'set', elementText: string, whole: string): TypeRef {
  const element = mapPythonType(elementText);
  if (!element) return { id: 'any', container: kind };
  if (element.container || element.nullable || element.id.startsWith('native:')) return native(whole);
  return { id: element.id, container: kind };
}

function native(text: string): TypeRef {
  return { id: `native:${text}` };
}

// One spelling per hint: without "typing." prefixes, single spaces, none inside [...].
function normalize(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\b(typing|t|collections\.abc)\./g, '')
    .replace(/\s*([[\]])\s*/g, '$1')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*\|\s*/g, ' | ')
    .trim();
}

// ---- Text helpers ------------------------------------------------------------------------------

// Index of the bracket that closes the one at `open`, skipping strings.
function matching(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const literal = stringAt(text, i);
    if (literal) {
      i = literal.end - 1;
      continue;
    }
    if ('([{'.includes(text[i])) depth++;
    else if (')]}'.includes(text[i]) && --depth === 0) return i;
  }
  return -1;
}

// Index of `ch` outside brackets and strings, or -1.
function topLevelIndex(text: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const literal = stringAt(text, i);
    if (literal) {
      i = literal.end - 1;
      continue;
    }
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    // "==", "<=", ">=", "!=" and "->" are not the "=" or ":" being looked for.
    else if (c === ch && depth === 0 && !(ch === '=' && (text[i + 1] === '=' || '<>!='.includes(text[i - 1] ?? '')))) return i;
  }
  return -1;
}

function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const literal = stringAt(text, i);
    if (literal) {
      i = literal.end - 1;
      continue;
    }
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.filter((p) => p.trim());
}

// A literal default value (number, string, True, False or None), or undefined for anything else.
function literalValue(text: string): unknown {
  const t = text.trim();
  if (t === 'True') return true;
  if (t === 'False') return false;
  if (t === 'None') return null;
  if (/^-?(\d[\d_]*\.?[\d_]*([eE][+-]?\d+)?|\.\d[\d_]*([eE][+-]?\d+)?)$/.test(t)) {
    const n = Number(t.replace(/_/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  const literal = stringAt(t, 0);
  if (literal && literal.end === t.length && !/[bBfF]/.test(literal.prefix)) {
    const body = t.slice(literal.prefix.length + literal.quote.length, -literal.quote.length);
    return /[rR]/.test(literal.prefix) ? body : unescape(body);
  }
  return undefined;
}

function unescape(body: string): string {
  return body.replace(/\\(\n|N\{[^}]*\}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (_m, esc: string) => {
    switch (esc[0]) {
      case '\n': return '';
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case 'a': return '\x07';
      case 'u':
      case 'U':
        return String.fromCodePoint(parseInt(esc.slice(1), 16));
      case 'x':
        return String.fromCharCode(parseInt(esc.slice(1), 16));
      case 'N':
        return `\\${esc}`;
      default:
        return /[0-7]/.test(esc[0]) ? String.fromCharCode(parseInt(esc, 8)) : ['\\', "'", '"'].includes(esc) ? esc : `\\${esc}`;
    }
  });
}
