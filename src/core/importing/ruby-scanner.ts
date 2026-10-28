// Reads a Ruby file's functions for exposing them as nodes (docs/code-as-nodes.md, docs/more-languages.md
// "Ruby"): functions callable without an object, documented with YARD comments, `@blueprint` marking
// one. Those are a module's or class's `def self.name`, a module's methods after `module_function`
// (or `extend self`), and top-level methods; `@param [Integer] points` and `@return [Float]` give the
// pins' types. Modules and classes are found by Ruby's usual indentation: each `end` lines up with
// the line it closes.
import { TypeRef } from '../types';
import { DocComment, ModuleScan, ScannedFunction, ScannedParam, SkippedFunction, isMarked, parseDocText } from './symbols';

interface Scope {
  name: string;
  indent: number;
  // A module whose methods are module functions (module_function, extend self).
  moduleFunctions: boolean;
  kind: 'module' | 'class';
}

export function scanRuby(source: string): ModuleScan {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const functions: ScannedFunction[] = [];
  const skipped: SkippedFunction[] = [];
  const scopes: Scope[] = [];
  lines.forEach((text, index) => {
    const indent = /^\s*/.exec(text)![0].length;
    const opened = /^\s*(module|class)\s+([A-Z]\w*(?:::[A-Z]\w*)*)\s*(?:<.*)?$/.exec(text);
    if (opened) {
      scopes.push({ name: opened[2], indent, moduleFunctions: false, kind: opened[1] as Scope['kind'] });
      return;
    }
    if (/^\s*end\b/.test(text) && scopes.length && scopes[scopes.length - 1].indent === indent) {
      scopes.pop();
      return;
    }
    if (/^\s*(module_function|extend\s+self)\s*$/.test(text) && scopes.length) scopes[scopes.length - 1].moduleFunctions = true;
    const declaration = /^\s*def\s+(self\.)?([a-z_]\w*[?!]?)\s*(?:\(([^)]*)\)|\s+([^#;]*?))?\s*(?:=.*)?$/.exec(text);
    if (!declaration) return;
    const [, onSelf, name, parenthesized, bare] = declaration;
    const doc = docAbove(lines, index);
    const line = index + 1;
    const skip = (reason: string) => skipped.push({ name, line, reason, marked: isMarked(doc) });
    const scope = scopes[scopes.length - 1];
    const container = scopes.map((s) => s.name).join('::');
    if (scope && !onSelf && !(scope.kind === 'module' && scope.moduleFunctions)) return skip("It's an instance method: generated code calls module methods (def self.name, module_function) and top-level methods.");
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
    functions.push({ name, line, params: scanned, returns: returnType ? mapRubyType(returnType) : returns ? undefined : null, doc, ...(container ? { container } : {}) });
  });
  return { functions, skipped };
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
