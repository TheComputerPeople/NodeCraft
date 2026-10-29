// Reads a Ruby file's functions for exposing them as nodes (docs/code-as-nodes.md, docs/more-languages.md
// "Ruby"): functions callable without an object, documented with YARD comments, `@blueprint` marking
// one. Those are a module's or class's `def self.name`, a module's methods after `module_function`
// (or `extend self`), and top-level methods; `@param [Integer] points` and `@return [Float]` give the
// pins' types. Modules and classes are found by Ruby's usual indentation: each `end` lines up with
// the line it closes. A class's public instance methods, `initialize` and attributes (attr_accessor,
// attr_reader) are its members (docs/node-authoring.md, gap 2).
import { TypeRef } from '../types';
import { DocComment, ModuleScan, ScannedClass, ScannedFunction, ScannedParam, SkippedFunction, isMarked, parseDocText, tupleOutputs } from './symbols';

interface Scope {
  name: string;
  indent: number;
  // A module whose methods are module functions (module_function, extend self).
  moduleFunctions: boolean;
  kind: 'module' | 'class';
  // A class's members, and whether its methods are private or protected from here on.
  cls?: ScannedClass;
  hidden?: boolean;
}

export function scanRuby(source: string): ModuleScan {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const functions: ScannedFunction[] = [];
  const skipped: SkippedFunction[] = [];
  const scopes: Scope[] = [];
  const classes: ScannedClass[] = [];
  lines.forEach((text, index) => {
    const indent = /^\s*/.exec(text)![0].length;
    const opened = /^\s*(module|class)\s+([A-Z]\w*(?:::[A-Z]\w*)*)\s*(?:<\s*([A-Z]\w*(?:::[A-Z]\w*)*))?.*$/.exec(text);
    if (opened && !/^\s*class\s*<</.test(text)) {
      const kind = opened[1] as Scope['kind'];
      const name = [...scopes.map((s) => s.name), opened[2]].join('::');
      const simple = opened[2].split('::').pop()!;
      const cls: ScannedClass | undefined = kind === 'class'
        ? { name, line: index + 1, doc: docAbove(lines, index), type: mapRubyType(simple) ?? { id: `native:${simple}` }, ...(opened[3] ? { base: mapRubyType(opened[3].split('::').pop()!) ?? undefined } : {}), methods: [], properties: [] }
        : undefined;
      if (cls && !cls.base) delete cls.base;
      if (cls) classes.push(cls);
      scopes.push({ name: opened[2], indent, moduleFunctions: false, kind, ...(cls ? { cls } : {}) });
      return;
    }
    if (/^\s*end\b/.test(text) && scopes.length && scopes[scopes.length - 1].indent === indent) {
      scopes.pop();
      return;
    }
    if (/^\s*(module_function|extend\s+self)\s*$/.test(text) && scopes.length) scopes[scopes.length - 1].moduleFunctions = true;
    const current = scopes[scopes.length - 1];
    // `private` or `protected` alone: the class's later methods aren't public; `public` again: they are.
    if (current && /^\s*(private|protected|public)\s*$/.test(text)) {
      current.hidden = !/public/.test(text);
      return;
    }
    // Attributes: attr_accessor :count, :name (attr_reader: read-only; attr_writer: no Get, so left out).
    const attributes = /^\s*attr_(accessor|reader)\s+(.+)$/.exec(text);
    if (attributes && current?.cls) {
      const doc = docAbove(lines, index);
      const returns = doc.tags.find((t) => t.name === 'return');
      const typeText = returns ? /^\[([^\]]+)\]/.exec(returns.text)?.[1] : undefined;
      const type = typeText ? mapRubyType(typeText) : null;
      for (const symbol of attributes[2].split(',').map((a) => a.trim().replace(/^:/, ''))) {
        if (!/^[a-z_]\w*$/.test(symbol)) continue;
        if (current.hidden) {
          if (isMarked(doc)) skipped.push({ name: `${current.cls.name}#${symbol}`, line: index + 1, reason: "it isn't public", marked: true });
        } else current.cls.properties.push({ name: symbol, line: index + 1, ...(type ? { type } : {}), readonly: attributes[1] === 'reader', doc });
      }
      return;
    }
    const declaration = /^\s*(?:(?:private|protected|public)\s+)?def\s+(self\.)?([a-z_]\w*[?!]?)\s*(?:\(([^)]*)\)|\s+([^#;]*?))?\s*(?:=.*)?$/.exec(text);
    if (!declaration) return;
    const [, onSelf, name, parenthesized, bare] = declaration;
    const doc = docAbove(lines, index);
    const line = index + 1;
    const skip = (reason: string) => skipped.push({ name, line, reason, marked: isMarked(doc) });
    const scope = scopes[scopes.length - 1];
    const container = scopes.map((s) => s.name).join('::');
    // A class's instance method (or initialize, its constructor) is a member.
    const member = scope?.cls && !onSelf;
    if (member && (scope.hidden || /^\s*(private|protected)\s+def\b/.test(text))) return skip("it isn't public");
    if (scope && !onSelf && !member && !(scope.kind === 'module' && scope.moduleFunctions)) return skip("It's an instance method: generated code calls module methods (def self.name, module_function) and top-level methods.");
    if (/[?!]$/.test(name)) return skip('Its name ends with ? or !, which other languages\' nodes can\'t call.');
    const paramText = (parenthesized ?? bare ?? '').trim();
    const params = paramText ? paramText.split(',').map((p) => p.trim()) : [];
    if (params.some((p) => /^[*&]|:\s*|:$/.test(p))) return skip('It takes splat, keyword or block arguments.');
    const types = new Map(doc.tags.filter((t) => t.name === 'param').map((t) => /^(?:\[([^\]]+)\]\s+)?([a-z_]\w*)(?:\s+\[([^\]]+)\])?/.exec(t.text)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[2], m[1] ?? m[3]]));
    const scanned: ScannedParam[] = params.map((p) => {
      const [, paramName, defaultText] = /^([a-z_]\w*)\s*(?:=\s*(.+))?$/.exec(p) ?? [, p, undefined];
      const typeText = types.get(paramName ?? p);
      const type = typeText ? mapRubyType(typeText) : null;
      const defaultValue = defaultText !== undefined ? literal(defaultText) : undefined;
      return { name: paramName ?? p, ...(type ? { type } : {}), ...(defaultValue !== undefined ? { defaultValue } : {}) };
    });
    const returns = doc.tags.find((t) => t.name === 'return');
    const returnType = returns ? /^\[([^\]]+)\]/.exec(returns.text)?.[1] : undefined;
    // Several outputs (docs/node-authoring.md, gap 3): a fixed array (`@return [Array(Integer, Integer)]`)
    // named by @outputs.
    const tuple = returnType ? /^Array\((.*)\)$/.exec(returnType.trim()) : null;
    const outputs = tuple ? tupleOutputs(doc, tuple[1].split(',').map((t) => mapRubyType(t) ?? undefined)) : undefined;
    const several = outputs ? { outputs, results: { kind: 'tuple' as const, names: outputs.map((o) => o.name) } } : {};
    const scannedFunction: ScannedFunction = { name, line, params: scanned, returns: outputs ? undefined : returnType ? mapRubyType(returnType) : returns ? undefined : null, doc, ...several, ...(container ? { container } : {}) };
    if (member && name === 'initialize') scope.cls!.init = { ...scannedFunction, returns: null };
    else if (member) scope.cls!.methods.push({ name, line, params: scanned, returns: scannedFunction.returns, doc, ...several });
    else functions.push(scannedFunction);
  });
  return { functions, skipped, ...(classes.length ? { classes } : {}) };
}

// The `#` comment lines just above a declaration.
function docAbove(lines: string[], index: number): DocComment {
  const block: string[] = [];
  for (let i = index - 1; i >= 0 && /^\s*#/.test(lines[i]); i--) block.unshift(lines[i].replace(/^\s*#\s?/, ''));
  return parseDocText(block);
}

function literal(text: string): unknown {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^"([^"\\#]|\\.)*"$/.test(t) || /^'[^'\\]*'$/.test(t)) return t.slice(1, -1);
  return undefined;
}

// A YARD type as a canonical type: Integer, Float (and Numeric), String, Boolean, Array<T> and
// Hash{K => V}; plain Array and Hash hold any value, Object any value, nil and void nothing, and
// other classes are native.
export function mapRubyType(text: string): TypeRef | null {
  const t = text.trim();
  switch (t) {
    case 'nil':
    case 'void':
      return null;
    case 'Object':
    case 'BasicObject':
      return { id: 'any' };
    case 'Integer':
      return { id: 'int' };
    case 'Float':
    case 'Numeric':
      return { id: 'float' };
    case 'String':
    case 'Symbol':
      return { id: 'string' };
    case 'Boolean':
    case 'true, false':
    case 'TrueClass, FalseClass':
      return { id: 'bool' };
    case 'Array':
      return { id: 'any', container: 'array' };
    case 'Hash':
      return { id: 'any', container: 'map', valueType: { id: 'any' } };
    case 'Set':
      return { id: 'any', container: 'set' };
  }
  const list = /^(Array|Set)<\s*(\w+)\s*>$/.exec(t);
  if (list) {
    const element = mapRubyType(list[2]);
    return element && !element.container && !element.id.startsWith('native:') ? { id: element.id, container: list[1] === 'Set' ? 'set' : 'array' } : { id: `native:${t}` };
  }
  const map = /^Hash\{\s*(\w+)\s*=>\s*(\w+)\s*\}$/.exec(t);
  if (map) {
    const key = mapRubyType(map[1]);
    const value = mapRubyType(map[2]);
    if (key && value && !key.container && !value.container && !key.id.startsWith('native:') && !value.id.startsWith('native:')) return { id: key.id, container: 'map', valueType: value };
  }
  return { id: `native:${t}` };
}
