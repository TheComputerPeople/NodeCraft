// Reads the exported functions of a TypeScript or JavaScript module: names, parameters, types,
// defaults and JSDoc (docs/code-as-nodes.md, "How declarations are read"). It parses only top-level
// declarations and skips everything else by matching brackets, so it needs no compiler.
import { TypeRef } from '../types';
import { CodeResults } from '../model';
import { DocComment, ModuleScan, NO_DOC, ScannedClass, ScannedFunction, ScannedParam, ScannedProperty, SkippedFunction, isMarked, parseDocText, tupleOutputs } from './symbols';

type TokenKind = 'name' | 'number' | 'string' | 'template' | 'regex' | 'punct';

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  // Offsets in the source.
  start: number;
  end: number;
  // The JSDoc comment directly before this token, if any.
  doc?: string;
}

// ---- Tokens ------------------------------------------------------------------------------------

// Words after which a "/" starts a regular expression rather than a division.
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
// Multi-character punctuation that matters here. ">" and "<" stay single so generics nest.
const PUNCTUATION = ['...', '=>', '?.', '??'];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  // Open "{" and template "${" brackets, so a "}" can resume a template string.
  const braces: ('brace' | 'template')[] = [];
  let i = 0;
  let line = 1;
  let doc: string | undefined;
  // Called with `i` just after the token's text.
  const push = (kind: TokenKind, text: string, startLine: number): void => {
    tokens.push({ kind, text, line: startLine, start: i - text.length, end: i, ...(doc !== undefined ? { doc } : {}) });
    doc = undefined;
  };
  const count = (text: string): void => {
    for (const ch of text) if (ch === '\n') line++;
  };
  // Reads template characters from `i` (just after "`" or a closing "}", which is at `start`) to the
  // end of the string or the next "${".
  const templateChunk = (start: number, startLine: number): void => {
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        i++;
        count(source.slice(start, i));
        push('template', source.slice(start, i), startLine);
        return;
      } else if (ch === '$' && source[i + 1] === '{') {
        i += 2;
        count(source.slice(start, i));
        braces.push('template');
        push('template', source.slice(start, i), startLine);
        return;
      } else i++;
    }
    count(source.slice(start));
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') {
      line++;
      i++;
    } else if (/\s/.test(ch)) {
      i++;
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      const text = source.slice(i, stop);
      if (text.startsWith('/**') && text !== '/**/') doc = text;
      count(text);
      i = stop;
    } else if (ch === '"' || ch === "'") {
      const start = i++;
      while (i < source.length && source[i] !== ch && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      i++;
      push('string', source.slice(start, i), line);
    } else if (ch === '`') {
      i++;
      templateChunk(i - 1, line);
    } else if (/[A-Za-z_$À-￿]/.test(ch)) {
      const start = i;
      while (i < source.length && /[\w$À-￿]/.test(source[i])) i++;
      push('name', source.slice(start, i), line);
    } else if (/\d/.test(ch) || (ch === '.' && /\d/.test(source[i + 1] ?? ''))) {
      const start = i;
      while (i < source.length && /[\w.]/.test(source[i])) i++;
      push('number', source.slice(start, i), line);
    } else if (ch === '/' && regexAllowed(tokens[tokens.length - 1])) {
      const start = i++;
      let inClass = false;
      while (i < source.length && source[i] !== '\n') {
        const c = source[i];
        if (c === '\\') i++;
        else if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        i++;
      }
      i++;
      while (i < source.length && /\w/.test(source[i])) i++;
      push('regex', source.slice(start, i), line);
    } else if (ch === '}' && braces[braces.length - 1] === 'template') {
      braces.pop();
      i++;
      templateChunk(i - 1, line);
    } else {
      const multi = PUNCTUATION.find((p) => source.startsWith(p, i));
      const text = multi ?? ch;
      if (text === '{') braces.push('brace');
      else if (text === '}') braces.pop();
      i += text.length;
      push('punct', text, line);
    }
  }
  return tokens;
}

function regexAllowed(previous: Token | undefined): boolean {
  if (!previous) return true;
  if (previous.kind === 'name') return REGEX_AFTER_WORDS.has(previous.text);
  if (previous.kind === 'punct') return ![')', ']', '}'].includes(previous.text);
  return false;
}

// ---- Declarations -------------------------------------------------------------------------------

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

interface LocalFunction {
  name: string;
  line: number;
  doc?: string;
  // Declared with TypeScript overloads.
  overloaded?: boolean;
  // Parsed signature, or why the function can't be a node.
  signature: Signature | { reason: string };
}

interface Signature {
  params: ScannedParam[];
  returns: TypeRef | null | undefined;
  jsdoc: DocComment;
  // Several outputs (docs/node-authoring.md, gap 3).
  outputs?: { name: string; type?: TypeRef }[];
  results?: CodeResults;
  // Async (gap 4): `returns` is what its Promise gives.
  latent?: boolean;
}

// Modifiers before a class member's name.
const MEMBER_MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'readonly', 'abstract', 'override', 'declare', 'async', 'accessor', 'get', 'set']);

// A class as declared, before we know whether it's exported.
interface LocalClass {
  scan: ScannedClass;
  // Its marked members that can't be nodes, and why.
  skipped: SkippedFunction[];
}

class DeclarationParser {
  private readonly locals = new Map<string, LocalFunction>();
  private readonly classes = new Map<string, LocalClass>();
  // Exported name → local function name, from export lists and module.exports.
  private readonly exportedLocals = new Map<string, string>();
  private readonly result: ModuleScan = { functions: [], skipped: [] };

  constructor(private readonly tokens: Token[], private readonly source: string, private readonly javascript: boolean) {}

  run(): ModuleScan {
    let i = 0;
    while (i < this.tokens.length) i = this.statement(i);
    const exportedNames = new Set(this.exportedLocals.values());
    for (const [exported, local] of this.exportedLocals) {
      const fn = this.locals.get(local);
      if (fn && exported !== 'default') this.add({ ...fn, name: exported });
      const cls = this.classes.get(local);
      if (cls && exported !== 'default') {
        (this.result.classes ??= []).push({ ...cls.scan, name: exported });
        this.result.skipped.push(...cls.skipped);
      }
    }
    // A class that isn't exported can't be imported: its marked members say so.
    for (const [name, cls] of this.classes) {
      if (exportedNames.has(name)) continue;
      const members: { name: string; line: number; doc: DocComment }[] = [...(cls.scan.init ? [cls.scan.init] : []), ...cls.scan.methods, ...cls.scan.properties];
      for (const m of members.filter((member) => isMarked(member.doc))) {
        this.result.skipped.push({ name: `${name}.${m.name}`, line: m.line, reason: `its class ${name} isn't exported, so generated code can't import it`, marked: true });
      }
    }
    // A marked function that isn't exported can't be imported by generated code.
    for (const fn of this.locals.values()) {
      if (exportedNames.has(fn.name) || fn.name.startsWith('exports.')) continue;
      const doc = 'reason' in fn.signature ? parseJsDoc(fn.doc) : fn.signature.jsdoc;
      if (isMarked(doc)) this.result.skipped.push({ name: fn.name, line: fn.line, reason: "it isn't exported, so generated code can't import it", marked: true });
    }
    return this.result;
  }

  private at(i: number, text: string): boolean {
    return this.tokens[i]?.text === text && this.tokens[i].kind !== 'string';
  }

  // Parses one top-level statement starting at `i`; returns where the next one starts.
  private statement(i: number): number {
    const t = this.tokens[i];
    if (t.kind === 'punct' && OPEN[t.text]) return this.skipGroup(i);
    if (t.kind !== 'name') return i + 1;
    const doc = t.doc;

    if (t.text === 'export') {
      if (this.at(i + 1, 'default')) return this.skipStatement(i, 'default exports');
      if (this.at(i + 1, '{')) return this.exportList(i + 1);
      const declared = this.declaration(i + 1, doc, true);
      return declared ?? i + 1;
    }
    if (t.text === 'function' || t.text === 'async' || t.text === 'const' || t.text === 'let' || t.text === 'var' || t.text === 'class' || t.text === 'abstract') {
      return this.declaration(i, doc, false) ?? i + 1;
    }
    if (this.javascript && (t.text === 'module' || t.text === 'exports')) return this.commonJsExport(i, doc);
    return i + 1;
  }

  // `function f(...)`, `async function f(...)` or `const f = (...) =>` / `= function (...)`.
  private declaration(i: number, statementDoc: string | undefined, exported: boolean): number | undefined {
    const doc = statementDoc ?? this.tokens[i]?.doc;
    if (this.at(i, 'declare')) return this.skipStatement(i, '');
    if (this.at(i, 'class') || (this.at(i, 'abstract') && this.at(i + 1, 'class'))) return this.classDeclaration(i, doc, exported);
    const isAsync = this.at(i, 'async');
    const k = isAsync ? i + 1 : i;
    if (this.at(k, 'function')) {
      const generator = this.at(k + 1, '*');
      const nameIndex = generator ? k + 2 : k + 1;
      const nameToken = this.tokens[nameIndex];
      if (nameToken?.kind !== 'name') return undefined;
      const parsed = this.signature(nameIndex + 1, doc, false, isAsync);
      const name = nameToken.text;
      // TypeScript overloads: signatures without a body, then the implementation. The first
      // declaration carries the documentation.
      const previous = this.locals.get(name);
      if (parsed.overload || previous?.overloaded) {
        this.locals.set(name, { name, line: previous?.line ?? this.tokens[i].line, doc: previous?.doc ?? doc, overloaded: true, signature: { reason: 'overloaded functions can\'t be nodes yet' } });
      } else {
        this.locals.set(name, {
          name, line: this.tokens[i].line, doc,
          signature: generator ? { reason: 'generator functions can\'t be nodes' } : parsed.signature
        });
      }
      if (exported) this.exportedLocals.set(name, name);
      return parsed.end;
    }
    if (this.at(i, 'const') || this.at(i, 'let') || this.at(i, 'var')) {
      const nameToken = this.tokens[i + 1];
      if (nameToken?.kind !== 'name') return undefined;
      let j = i + 2;
      // An annotated variable (const f: Handler = ...) has a type we don't read.
      if (this.at(j, ':')) return undefined;
      if (!this.at(j, '=')) return undefined;
      j++;
      const valueAsync = this.at(j, 'async');
      if (valueAsync) j++;
      let parsed: { signature: Signature | { reason: string }; end: number } | undefined;
      if (this.at(j, 'function')) {
        const generator = this.at(j + 1, '*');
        let p = generator ? j + 2 : j + 1;
        if (this.tokens[p]?.kind === 'name') p++;
        const s = this.signature(p, doc, false, valueAsync);
        parsed = { signature: generator ? { reason: 'generator functions can\'t be nodes' } : s.signature, end: s.end };
      } else if (this.at(j, '(') || this.at(j, '<')) {
        const s = this.signature(j, doc, true, valueAsync);
        if (!s.arrow) return undefined;
        parsed = s;
      } else if (this.tokens[j]?.kind === 'name' && this.at(j + 1, '=>')) {
        // x => ... : one untyped parameter.
        const jsdoc = parseJsDoc(doc);
        const declared = jsdocReturns(jsdoc);
        parsed = declared && 'reason' in declared
          ? { signature: declared, end: j + 2 }
          : { signature: { params: [{ name: this.tokens[j].text, ...jsdocParam(jsdoc, this.tokens[j].text) }], returns: declared ? declared.type : undefined, jsdoc, ...(valueAsync ? { latent: true } : {}) }, end: j + 2 };
      } else return undefined;
      const fn: LocalFunction = { name: nameToken.text, line: this.tokens[i].line, doc, signature: parsed.signature };
      this.locals.set(fn.name, fn);
      if (exported) this.exportedLocals.set(fn.name, fn.name);
      return parsed.end;
    }
    return undefined;
  }

  // `class Name extends Base { members }` (docs/node-authoring.md, gap 2): its public constructor,
  // instance methods and properties, for their markers to make nodes of.
  private classDeclaration(i: number, doc: string | undefined, exported: boolean): number {
    const abstract = this.at(i, 'abstract');
    const k = abstract ? i + 1 : i;
    const nameToken = this.tokens[k + 1];
    if (nameToken?.kind !== 'name') return k + 1;
    let j = k + 2;
    if (this.at(j, '<')) j = this.skipAngles(j);
    let base: TypeRef | undefined;
    if (this.at(j, 'extends')) {
      const end = this.skipType(j + 1);
      base = mapTypeText(this.text(j + 1, end).replace(/<[\s\S]*$/, ''));
      j = end;
    }
    while (j < this.tokens.length && !this.at(j, '{')) j++;
    const close = this.skipGroup(j);
    const name = nameToken.text;
    const scan: ScannedClass = {
      name, line: this.tokens[i].line, doc: parseJsDoc(doc), type: mapTypeText(name) ?? { id: `native:${name}` },
      ...(base && base.id.startsWith('native:') ? { base } : {}), ...(abstract ? { abstract } : {}), methods: [], properties: []
    };
    const cls: LocalClass = { scan, skipped: [] };
    this.classBody(j + 1, close - 1, cls);
    this.classes.set(name, cls);
    if (exported) this.exportedLocals.set(name, name);
    return close;
  }

  // The members of a class body, from `start` to the closing brace at `end`.
  private classBody(start: number, end: number, cls: LocalClass): void {
    const getters = new Map<string, ScannedProperty>();
    const setters = new Set<string>();
    let m = start;
    while (m < end) {
      if (this.at(m, ';')) {
        m++;
        continue;
      }
      const first = this.tokens[m];
      const jsdoc = parseJsDoc(first.doc);
      const modifiers = new Set<string>();
      let p = m;
      // `get()` is a method named get, not an accessor: a modifier is followed by the member's name.
      while (this.tokens[p]?.kind === 'name' && MEMBER_MODIFIERS.has(this.tokens[p].text) && !['(', '=', ':', ';', '?', '!', '<', '}'].includes(this.tokens[p + 1]?.text ?? '')) {
        modifiers.add(this.tokens[p].text);
        p++;
      }
      const generator = this.at(p, '*');
      if (generator) p++;
      const hidden = modifiers.has('private') || modifiers.has('protected') || this.at(p, '#');
      if (this.at(p, '#')) p++;
      const nameToken = this.tokens[p];
      if (!nameToken || nameToken.kind !== 'name' || p >= end) {
        // An index signature, a computed name or a static block: skipped.
        m = this.at(p, '{') ? this.skipGroup(p) : this.skipMember(p + 1, end);
        continue;
      }
      const name = nameToken.text;
      const line = first.line;
      const skip = (reason: string): void => {
        if (isMarked(jsdoc)) cls.skipped.push({ name: `${cls.scan.name}.${name}`, line, reason, marked: true });
      };
      if (this.at(p + 1, '(') || this.at(p + 1, '<')) {
        const parsed = this.signature(p + 1, first.doc, false, modifiers.has('async'));
        m = Math.max(parsed.end, p + 2);
        // An overload or abstract method has no body; the implementation (if any) follows.
        if (parsed.overload) continue;
        const signature = parsed.signature;
        if (hidden) skip("it isn't public");
        else if (modifiers.has('static')) skip('static methods of a class have no object; make it a module function instead');
        else if (generator) skip("generator functions can't be nodes");
        else if ('reason' in signature) skip(signature.reason || "its parameters couldn't be read");
        else if (modifiers.has('get')) getters.set(name, { name, line, ...(signature.returns ? { type: signature.returns } : {}), readonly: true, doc: jsdoc });
        else if (modifiers.has('set')) setters.add(name);
        else if (name === 'constructor') cls.scan.init = { name, line, params: signature.params, returns: null, doc: jsdoc };
        else cls.scan.methods.push({ name, line, params: signature.params, returns: signature.returns, doc: jsdoc, ...(signature.outputs && signature.results ? { outputs: signature.outputs, results: signature.results } : {}), ...(signature.latent ? { latent: true } : {}) });
        continue;
      }
      // A field: `name?: Type = value;`.
      let q = p + 1;
      if (this.at(q, '?') || this.at(q, '!')) q++;
      let type: TypeRef | undefined;
      if (this.at(q, ':')) {
        const typeEnd = this.skipType(q + 1);
        type = mapTypeText(this.text(q + 1, typeEnd));
        q = typeEnd;
      } else {
        const tag = jsdoc.tags.find((t) => t.name === 'type');
        const match = tag && /^\{(.+?)\}/.exec(tag.text);
        type = match ? mapJsDocType(match[1]) : undefined;
      }
      m = this.skipMember(q, end);
      if (hidden) skip("it isn't public");
      else if (modifiers.has('static')) skip("static fields of a class have no object; they can't be nodes yet");
      else cls.scan.properties.push({ name, line, ...(type ? { type } : {}), readonly: modifiers.has('readonly'), doc: jsdoc });
    }
    // Accessors: a getter is a property, writable when it has a setter too.
    for (const [name, getter] of getters) cls.scan.properties.push({ ...getter, readonly: !setters.has(name) });
  }

  // From `i`, past the rest of a class member: an initializer, to its ";" or the end of its line.
  private skipMember(i: number, end: number): number {
    const continues = ['=', '.', '?.', '+', '-', '*', '/', '|', '&', '?', ':', '??', '||', '&&', ','];
    let j = i;
    while (j < end) {
      const t = this.tokens[j];
      if (t.text === ';' && t.kind === 'punct') return j + 1;
      // Without semicolons, a member ends where a new line starts another.
      if (j > i && t.line > this.tokens[j - 1].line && !continues.includes(this.tokens[j - 1].text) && !['.', '?.', ')', ']'].includes(t.text)) return j;
      if (t.kind === 'punct' && OPEN[t.text]) {
        j = this.skipGroup(j);
        continue;
      }
      j++;
    }
    return end;
  }

  // Reads `<T>(params): Type {body}` or `(params): Type =>`, starting at `<` or `(`.
  // `isAsync`: declared `async`, so it returns a Promise whatever its annotation says.
  private signature(i: number, doc: string | undefined, arrow = false, isAsync = false): { signature: Signature | { reason: string }; end: number; overload?: boolean; arrow?: boolean } {
    const jsdoc = parseJsDoc(doc);
    let generic = false;
    if (this.at(i, '<')) {
      generic = true;
      i = this.skipAngles(i);
    }
    if (!this.at(i, '(')) return { signature: { reason: 'its parameters couldn\'t be read' }, end: i };
    const close = this.skipGroup(i) - 1;
    const params = this.params(i + 1, close, jsdoc);
    let j = close + 1;
    let returnText: string | undefined;
    if (this.at(j, ':')) {
      const end = this.skipType(j + 1);
      returnText = this.text(j + 1, end);
      j = end;
    }
    const isArrow = this.at(j, '=>');
    if (arrow && !isArrow) return { signature: { reason: '' }, end: j };
    // A declaration without a body is a TypeScript overload signature.
    if (!isArrow && !this.at(j, '{')) return { signature: { reason: '' }, end: this.at(j, ';') ? j + 1 : j, overload: true };
    const end = this.bodyEnd(j, isArrow);
    if (generic) return { signature: { reason: 'generic functions can\'t be nodes yet' }, end, arrow: isArrow };
    // The declared return type (annotation, else @returns), else whether the body returns a value.
    if ('reason' in params) return { signature: params, end, arrow: isArrow };
    // Async (docs/node-authoring.md, gap 4): a latent node, whose value is what the Promise gives.
    const declaredText = returnText ?? jsdocReturnText(jsdoc);
    const promise = declaredText !== undefined ? /^Promise\s*(?:<([\s\S]*)>)?$/.exec(normalize(declaredText)) : null;
    if (isAsync || promise) {
      const inner = promise?.[1] !== undefined ? mapReturnText(promise[1]) : promise ? { type: undefined } : undefined;
      if (inner && 'reason' in inner) return { signature: inner, end, arrow: isArrow };
      const returns = inner ? inner.type : this.returnsValue(j, isArrow) ? undefined : null;
      return { signature: { params, returns, jsdoc, latent: true }, end, arrow: isArrow };
    }
    // Several outputs: an object type's fields, or a tuple's positions.
    const several = severalOutputs(returnText ?? jsdocReturnText(jsdoc), jsdoc);
    if (several) return { signature: { params, returns: undefined, jsdoc, ...several }, end, arrow: isArrow };
    const declared = returnText !== undefined ? mapReturnText(returnText) : jsdocReturns(jsdoc);
    if (declared && 'reason' in declared) return { signature: declared, end, arrow: isArrow };
    const returns = declared ? declared.type : this.returnsValue(j, isArrow) ? undefined : null;
    return { signature: { params, returns, jsdoc }, end, arrow: isArrow };
  }

  private params(start: number, end: number, jsdoc: DocComment): ScannedParam[] | { reason: string } {
    const params: ScannedParam[] = [];
    for (const [all, to] of this.splitCommas(start, end)) {
      if (all >= to) continue;
      // A constructor's parameter property (`public health: number`): the modifiers aren't the name.
      let from = all;
      while (from + 1 < to && ['public', 'private', 'protected', 'readonly', 'override'].includes(this.tokens[from].text) && this.tokens[from + 1].kind === 'name') from++;
      const first = this.tokens[from];
      if (first.text === '...') return { reason: 'rest parameters can\'t be pins' };
      if (first.text === '{' || first.text === '[') return { reason: 'destructured parameters can\'t be pins' };
      if (first.kind !== 'name') return { reason: 'its parameters couldn\'t be read' };
      if (first.text === 'this') continue;
      let k = from + 1;
      if (this.at(k, '?')) k++;
      let type: TypeRef | undefined;
      if (this.at(k, ':')) {
        const typeEnd = this.findDefault(k + 1, to);
        const mapped = mapTypeText(this.text(k + 1, typeEnd));
        type = mapped;
        k = typeEnd;
      } else {
        type = jsdocParam(jsdoc, first.text).type;
      }
      const param: ScannedParam = { name: first.text, ...(type ? { type } : {}) };
      if (this.at(k, '=')) {
        const value = literalValue(this.tokens.slice(k + 1, to));
        if (value !== undefined) param.defaultValue = value;
      }
      params.push(param);
    }
    return params;
  }

  // `export { a, b as c }` (without `from`): exported names of local functions.
  private exportList(i: number): number {
    const end = this.skipGroup(i);
    if (this.at(end, 'from')) return end + 2;
    for (const [from, to] of this.splitCommas(i + 1, end - 1)) {
      const local = this.tokens[from]?.text;
      if (!local || this.tokens[from].kind !== 'name') continue;
      const exported = this.at(from + 1, 'as') ? this.tokens[from + 2]?.text : local;
      if (exported && to > from) this.exportedLocals.set(exported, local);
    }
    return end;
  }

  // CommonJS: `module.exports = { a, b: c }`, `module.exports.a = ...` and `exports.a = ...`.
  private commonJsExport(i: number, doc: string | undefined): number {
    let j = i;
    if (this.at(j, 'module') && this.at(j + 1, '.') && this.at(j + 2, 'exports')) j += 3;
    else if (this.at(j, 'exports')) j += 1;
    else return i + 1;
    if (this.at(j, '=') && this.at(j + 1, '{')) {
      const end = this.skipGroup(j + 1);
      for (const [from, to] of this.splitCommas(j + 2, end - 1)) {
        const key = this.tokens[from];
        if (key?.kind !== 'name') continue;
        if (to === from + 1) this.exportedLocals.set(key.text, key.text);
        else if (this.at(from + 1, ':') && to === from + 3 && this.tokens[from + 2].kind === 'name') this.exportedLocals.set(key.text, this.tokens[from + 2].text);
      }
      return end;
    }
    if (this.at(j, '.') && this.tokens[j + 1]?.kind === 'name' && this.at(j + 2, '=')) {
      const name = this.tokens[j + 1].text;
      // Parse the value as if it were `const name = ...`.
      const at = { line: this.tokens[i].line, start: this.tokens[i].start, end: this.tokens[i].start };
      const fake: Token[] = [{ kind: 'name', text: 'const', ...at, ...(doc ? { doc } : {}) }, { kind: 'name', text: name, ...at }];
      const parser = new DeclarationParser([...fake, ...this.tokens.slice(j + 2)], this.source, this.javascript);
      const end = parser.declaration(0, doc, true);
      const fn = parser.locals.get(name);
      if (fn && end !== undefined) {
        this.locals.set(`exports.${name}`, fn);
        this.exportedLocals.set(name, `exports.${name}`);
        return j + 2 + (end - 2);
      }
      return j + 2;
    }
    return i + 1;
  }

  private add(fn: LocalFunction): void {
    const jsdoc = 'reason' in fn.signature ? parseJsDoc(fn.doc) : fn.signature.jsdoc;
    if ('reason' in fn.signature) {
      if (fn.signature.reason) this.result.skipped.push({ name: fn.name, line: fn.line, reason: fn.signature.reason, marked: isMarked(jsdoc) });
      return;
    }
    const { outputs, results } = fn.signature;
    const scanned: ScannedFunction = { name: fn.name, line: fn.line, params: fn.signature.params, returns: fn.signature.returns, doc: jsdoc, ...(outputs && results ? { outputs, results } : {}), ...(fn.signature.latent ? { latent: true } : {}) };
    this.result.functions.push(scanned);
  }

  // ---- Token helpers ------------------------------------------------------------------------

  // From an opening bracket, the index after its matching close.
  private skipGroup(i: number): number {
    const stack: string[] = [];
    for (let j = i; j < this.tokens.length; j++) {
      const t = this.tokens[j];
      if (t.kind !== 'punct') continue;
      if (OPEN[t.text]) stack.push(OPEN[t.text]);
      else if (t.text === stack[stack.length - 1]) {
        stack.pop();
        if (!stack.length) return j + 1;
      }
    }
    return this.tokens.length;
  }

  private skipAngles(i: number): number {
    let depth = 0;
    for (let j = i; j < this.tokens.length; j++) {
      const t = this.tokens[j];
      if (t.kind === 'punct' && OPEN[t.text]) {
        j = this.skipGroup(j) - 1;
        continue;
      }
      if (t.text === '<') depth++;
      else if (t.text === '>' && --depth === 0) return j + 1;
    }
    return this.tokens.length;
  }

  // A type starting at `i`: ends before a "{" body, "=>", "=", ";" or "," at depth zero. An object
  // type at the start ("{ a: number }") is part of the type.
  private skipType(i: number): number {
    let j = i;
    let expectOperand = true;
    while (j < this.tokens.length) {
      const t = this.tokens[j];
      if (t.kind === 'punct') {
        if (t.text === '{' || t.text === '(' || t.text === '[') {
          if (t.text === '{' && !expectOperand) return j;
          j = this.skipGroup(j);
          // A parenthesized function type continues with "=> Result".
          if (t.text === '(' && this.at(j, '=>')) {
            j++;
            expectOperand = true;
            continue;
          }
          expectOperand = false;
          continue;
        }
        if (t.text === '<') {
          j = this.skipAngles(j);
          expectOperand = false;
          continue;
        }
        if (t.text === '|' || t.text === '&' || t.text === '.') {
          j++;
          expectOperand = true;
          continue;
        }
        return j;
      }
      if (!expectOperand && t.kind === 'name' && !['is', 'extends', 'keyof', 'typeof', 'readonly', 'asserts', 'infer'].includes(t.text)) return j;
      if (t.kind === 'name' && ['keyof', 'typeof', 'readonly', 'asserts', 'infer'].includes(t.text)) {
        j++;
        expectOperand = true;
        continue;
      }
      if (t.kind === 'name' && t.text === 'is') {
        j++;
        expectOperand = true;
        continue;
      }
      j++;
      expectOperand = false;
    }
    return j;
  }

  // Where a parameter's default value starts ("="), or `end`.
  private findDefault(i: number, end: number): number {
    const typeEnd = this.skipType(i);
    return Math.min(typeEnd, end);
  }

  // Ranges of tokens between commas at depth zero, including "<...>" in types.
  private splitCommas(start: number, end: number): [number, number][] {
    const ranges: [number, number][] = [];
    let from = start;
    let angles = 0;
    for (let j = start; j < end; j++) {
      const t = this.tokens[j];
      if (t.kind === 'punct' && OPEN[t.text]) {
        j = this.skipGroup(j) - 1;
        continue;
      }
      if (t.text === '<' && t.kind === 'punct') angles++;
      else if (t.text === '>' && t.kind === 'punct' && angles > 0) angles--;
      else if (t.text === ',' && t.kind === 'punct' && angles === 0) {
        ranges.push([from, j]);
        from = j + 1;
      }
    }
    ranges.push([from, end]);
    return ranges;
  }

  // Where a function's body ends: after its "{...}", or (arrow expression bodies) right after "=>",
  // leaving the expression to the statement loop.
  private bodyEnd(j: number, arrow: boolean): number {
    if (arrow) return this.at(j + 1, '{') ? this.skipGroup(j + 1) : j + 1;
    return this.at(j, '{') ? this.skipGroup(j) : j;
  }

  // Whether a body without a return annotation returns a value: an expression-bodied arrow does;
  // a block does if it has `return <value>` outside nested functions and classes.
  private returnsValue(j: number, arrow: boolean): boolean {
    const open = arrow ? j + 1 : j;
    if (arrow && !this.at(open, '{')) return true;
    if (!this.at(open, '{')) return false;
    const end = this.skipGroup(open) - 1;
    for (let k = open + 1; k < end; k++) {
      const t = this.tokens[k];
      if (t.kind === 'name' && (t.text === 'function' || t.text === 'class')) {
        while (k < end && !this.at(k, '{')) k++;
        k = this.skipGroup(k) - 1;
      } else if (t.text === '=>' && this.at(k + 1, '{')) {
        k = this.skipGroup(k + 1) - 1;
      } else if (t.kind === 'name' && t.text === 'return') {
        const next = this.tokens[k + 1];
        if (next && next.line === t.line && next.text !== ';' && next.text !== '}') return true;
      }
    }
    return false;
  }

  private skipStatement(i: number, _what: string): number {
    for (let j = i + 1; j < this.tokens.length; j++) {
      const t = this.tokens[j];
      if (t.kind === 'punct' && OPEN[t.text]) {
        const end = this.skipGroup(j);
        if (t.text === '{') return end;
        j = end - 1;
      } else if (t.text === ';') return j + 1;
    }
    return this.tokens.length;
  }

  // The source text of tokens start..end-1.
  private text(start: number, end: number): string {
    if (end <= start) return '';
    return this.source.slice(this.tokens[start].start, this.tokens[end - 1].end);
  }
}


export function scanTypeScript(source: string, javascript = false): ModuleScan {
  return new DeclarationParser(tokenize(source), source, javascript).run();
}

// ---- JSDoc ---------------------------------------------------------------------------------------

function parseJsDoc(comment: string | undefined): DocComment {
  if (!comment) return NO_DOC;
  const body = comment.replace(/^\/\*\*/, '').replace(/\*\/$/, '');
  return parseDocText(body.split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, '')));
}

// A parameter's type from `@param {type} name` (JavaScript).
function jsdocParam(doc: DocComment, name: string): { type?: TypeRef } {
  for (const tag of doc.tags) {
    if (tag.name !== 'param' && tag.name !== 'arg' && tag.name !== 'argument') continue;
    const match = /^\{(.+?)\}\s*\[?([\w$]+)/.exec(tag.text);
    if (match && match[2] === name) {
      const type = mapJsDocType(match[1]);
      return type ? { type } : {};
    }
  }
  return {};
}

// The type text of `@returns {type}` (JavaScript), braces balanced: `{{ a: number }}` is an object.
function jsdocReturnText(doc: DocComment): string | undefined {
  const tag = doc.tags.find((t) => t.name === 'returns' || t.name === 'return');
  if (!tag?.text.startsWith('{')) return undefined;
  let depth = 0;
  for (let i = 0; i < tag.text.length; i++) {
    if (tag.text[i] === '{') depth++;
    else if (tag.text[i] === '}' && --depth === 0) return tag.text.slice(1, i).trim();
  }
  return undefined;
}

// Several outputs from a return type (docs/node-authoring.md, gap 3): an object type's fields
// (`{ total: number; count: number }`), or a tuple's positions, named by its labels
// (`[total: number, count: number]`) or by the `@outputs` tag.
function severalOutputs(text: string | undefined, doc: DocComment): { outputs: { name: string; type?: TypeRef }[]; results: CodeResults } | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  if (t.startsWith('{') && t.endsWith('}')) {
    const members = splitTop(t.slice(1, -1).replace(/;/g, ','), ',').map((m) => m.trim()).filter(Boolean);
    const fields = members.map((m) => /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([\s\S]+)$/.exec(m));
    if (fields.length < 2 || fields.some((f) => !f)) return undefined;
    const outputs = fields.map((f) => ({ name: f![1], ...(mapTypeText(f![2]) ? { type: mapTypeText(f![2]) } : {}) }));
    return { outputs, results: { kind: 'fields', names: outputs.map((o) => o.name) } };
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    const elements = splitTop(t.slice(1, -1), ',').map((e) => e.trim()).filter(Boolean);
    const labeled = elements.map((e) => /^([A-Za-z_$][\w$]*)\??\s*:\s*([\s\S]+)$/.exec(e));
    const outputs = tupleOutputs(doc, labeled.map((l, i) => mapTypeText(l ? l[2] : elements[i])), labeled.map((l) => l?.[1]));
    return outputs && { outputs, results: { kind: 'tuple', names: outputs.map((o) => o.name) } };
  }
  return undefined;
}

// The return type from `@returns {type}` (JavaScript), if documented.
function jsdocReturns(doc: DocComment): { type: TypeRef | null | undefined } | { reason: string } | undefined {
  const tag = doc.tags.find((t) => t.name === 'returns' || t.name === 'return');
  const match = tag && /^\{(.+?)\}/.exec(tag.text);
  return match ? mapReturnText(match[1].replace(/^\?(.*)$/, '$1 | null')) : undefined;
}

function mapJsDocType(text: string): TypeRef | undefined {
  const t = text.trim();
  if (t === '*') return undefined;
  if (t.startsWith('?')) {
    const inner = mapTypeText(t.slice(1));
    return inner && !inner.nullable ? { ...inner, nullable: true } : { id: `native:${t}` };
  }
  return mapTypeText(t.replace(/=$/, ''));
}

// ---- Types -------------------------------------------------------------------------------------

const SIMPLE: Record<string, TypeRef | undefined> = {
  number: { id: 'float' },
  string: { id: 'string' },
  boolean: { id: 'bool' },
  any: undefined,
  unknown: undefined,
  object: undefined
};

// A return annotation: no value (void), a type, or a reason the function can't be a node.
function mapReturnText(text: string): { type: TypeRef | null | undefined } | { reason: string } {
  const t = normalize(text);
  if (t === 'void' || t === 'undefined' || t === 'never') return { type: null };
  if (/^Promise\s*</.test(t) || t === 'Promise') return { reason: 'it returns a Promise of a Promise' };
  if (/^(asserts\s+)?\w+\s+is\s+/.test(t)) return { type: { id: 'bool' } };
  return { type: mapTypeText(t) };
}

// A TypeScript type, as text, in canonical form (docs/code-as-nodes.md, "What becomes a node").
// Only types the generated code can pass on exactly map to canonical types; others are native.
export function mapTypeText(text: string): TypeRef | undefined {
  const t = normalize(text);
  const members = splitTop(t, '|');
  if (members.length > 1) {
    const rest = members.filter((m) => m !== 'null');
    if (rest.length === members.length - 1 && rest.length) {
      const inner = mapTypeText(rest.join(' | '));
      // `T | null` is a nullable T; anything fancier stays native.
      if (inner && !inner.nullable && !inner.id.startsWith('native:')) return { ...inner, nullable: true };
      return native(t);
    }
    if (members.every((m) => /^(['"]).*\1$/.test(m))) return { id: 'string' };
    if (members.every((m) => /^-?\d/.test(m))) return { id: 'float' };
    if (members.length === 2 && members.includes('true') && members.includes('false')) return { id: 'bool' };
    return native(t);
  }
  if (t.startsWith('(') && t.endsWith(')') && matchingParen(t) === t.length - 1) return mapTypeText(t.slice(1, -1));
  if (t in SIMPLE) return SIMPLE[t];
  if (/^(['"]).*\1$/.test(t)) return { id: 'string' };
  if (/^-?\d/.test(t)) return { id: 'float' };
  if (t === 'true' || t === 'false') return { id: 'bool' };
  const readonlyArray = /^readonly\s+(.+)\[\]$/.exec(t);
  if (readonlyArray) return container('array', readonlyArray[1], t);
  if (t.endsWith('[]')) return container('array', t.slice(0, -2), t);
  const generic = /^([\w$.]+)\s*<(.*)>$/.exec(t);
  if (generic) {
    const args = splitTop(generic[2], ',');
    switch (generic[1]) {
      case 'Array':
      case 'ReadonlyArray':
        return args.length === 1 ? container('array', args[0], t) : native(t);
      case 'Set':
      case 'ReadonlySet':
        return args.length === 1 ? container('set', args[0], t) : native(t);
      case 'Map':
      case 'ReadonlyMap':
      case 'Record': {
        if (args.length !== 2) return native(t);
        const key = mapTypeText(args[0]);
        const value = mapTypeText(args[1]);
        if (!key || key.container || key.nullable || key.id.startsWith('native:') || (value && (value.container || value.id.startsWith('native:')))) return native(t);
        // Record<K, V> is a plain object, not a Map: it stays native so code gets what it expects.
        if (generic[1] === 'Record') return native(t);
        return { id: key.id, container: 'map', valueType: value ?? { id: 'any' } };
      }
    }
  }
  return native(t);
}

function container(kind: 'array' | 'set', elementText: string, whole: string): TypeRef {
  const element = mapTypeText(elementText);
  if (!element) return { id: 'any', container: kind };
  if (element.container || element.nullable || element.id.startsWith('native:')) return native(whole);
  return { id: element.id, container: kind };
}

function native(text: string): TypeRef {
  return { id: `native:${text}` };
}

// One spelling per type: single spaces, none inside <...> and [...], and spaced | and &.
function normalize(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*(<|(?<!=)>|\[|\])\s*/g, '$1')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s*&\s*/g, ' & ')
    .trim()
    .replace(/^\| /, '');
}

// Splits on `separator` outside brackets and quotes.
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if ('<([{'.includes(ch)) depth++;
    else if ('>)]}'.includes(ch)) depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(text.slice(from).trim());
  return parts.filter((p) => p !== '');
}

function matchingParen(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

// ---- Values ------------------------------------------------------------------------------------

// A literal default value (number, string, boolean or null), or undefined for anything else.
function literalValue(tokens: Token[]): unknown {
  if (tokens.length === 2 && tokens[0].text === '-' && tokens[1].kind === 'number') {
    const n = parseNumber(tokens[1].text);
    return n === undefined ? undefined : -n;
  }
  if (tokens.length !== 1) return undefined;
  const t = tokens[0];
  if (t.kind === 'number') return parseNumber(t.text);
  if (t.kind === 'string') return unquote(t.text);
  if (t.kind === 'template' && t.text.endsWith('`') && !t.text.includes('${')) return unquote(t.text);
  if (t.kind === 'name') return t.text === 'true' ? true : t.text === 'false' ? false : t.text === 'null' ? null : undefined;
  return undefined;
}

function parseNumber(text: string): number | undefined {
  const n = Number(text.replace(/_/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function unquote(text: string): string {
  const body = text.slice(1, -1);
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, esc: string) => {
    switch (esc[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case 'u': return String.fromCodePoint(parseInt(esc.replace(/[u{}]/g, ''), 16));
      case 'x': return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return esc;
    }
  });
}
