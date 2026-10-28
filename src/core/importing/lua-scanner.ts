// Reads a Lua module's functions for exposing them as nodes (docs/code-as-nodes.md, docs/more-languages.md
// "Lua"): the functions of the table the module returns (`function M.name(...)` or `M.name =
// function(...)`), documented with LuaLS-style `---` comments. `---@blueprint` marks one;
// `---@param name type` and `---@return type` give its pins' types.
import { TypeRef } from '../types';
import { DocComment, ModuleScan, ScannedFunction, ScannedParam, SkippedFunction, isMarked, parseDocText } from './symbols';

export function scanLua(source: string): ModuleScan {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  // The module's table: the name its last top-level `return` gives.
  const returned = [...source.matchAll(/^return\s+([A-Za-z_]\w*)\s*$/gm)].pop()?.[1];
  const functions: ScannedFunction[] = [];
  const skipped: SkippedFunction[] = [];
  lines.forEach((text, index) => {
    const declaration = /^(?:function\s+([A-Za-z_]\w*)([.:])([A-Za-z_]\w*)\s*\(([^)]*)\)|([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*function\s*\(([^)]*)\))/.exec(text);
    if (!declaration) return;
    const table = declaration[1] ?? declaration[5];
    const name = declaration[3] ?? declaration[6];
    const params = (declaration[4] ?? declaration[7]).split(',').map((p) => p.trim()).filter(Boolean);
    const doc = docAbove(lines, index);
    const line = index + 1;
    const skip = (reason: string) => skipped.push({ name, line, reason, marked: isMarked(doc) });
    if (table !== returned) return skip(returned ? `It belongs to ${table}, not the table the module returns (${returned}).` : "The module doesn't end with `return` of its table.");
    if (declaration[2] === ':') return skip('It takes self (a method): only module functions can be nodes.');
    if (params.includes('...')) return skip('It takes any number of arguments (...).');
    const returns = doc.tags.filter((t) => t.name === 'return');
    if (returns.length > 1) return skip('It returns several values.');
    const paramTypes = new Map(doc.tags.filter((t) => t.name === 'param').map((t) => /^([A-Za-z_]\w*)\??\s+(\S+)/.exec(t.text)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2]]));
    const scanned: ScannedParam[] = params.map((p) => {
      const type = paramTypes.has(p) ? mapLuaType(paramTypes.get(p)!) : null;
      return { name: p, ...(type ? { type } : {}) };
    });
    const returnType = returns[0] ? /^(\S+)/.exec(returns[0].text)?.[1] : undefined;
    functions.push({ name, line, params: scanned, returns: returnType ? mapLuaType(returnType) : null, doc });
  });
  return { functions, skipped };
}

// The `---` comment lines just above a declaration, as a doc comment. LuaLS's annotations
// (`---@param`) are its tags.
function docAbove(lines: string[], index: number): DocComment {
  const block: string[] = [];
  for (let i = index - 1; i >= 0 && /^\s*---/.test(lines[i]); i--) block.unshift(lines[i].replace(/^\s*---\s?/, ''));
  return parseDocText(block);
}

// A LuaLS type as a canonical type: integer, number, string and boolean, arrays (`T[]`) and maps
// (`table<K, V>`); `any` is any value, `nil` nothing, and anything else is native.
export function mapLuaType(text: string): TypeRef | null {
  const t = text.replace(/\?$/, '');
  switch (t) {
    case 'nil':
    case 'void':
      return null;
    case 'any':
    case 'unknown':
      return { id: 'any' };
    case 'integer':
      return { id: 'int' };
    case 'number':
      return { id: 'float' };
    case 'string':
      return { id: 'string' };
    case 'boolean':
      return { id: 'bool' };
  }
  const array = /^(\w+)\[\]$/.exec(t);
  if (array) {
    const element = mapLuaType(array[1]);
    return element && !element.id.startsWith('native:') ? { id: element.id, container: 'array' } : { id: `native:${t}` };
  }
  const map = /^table<\s*(\w+)\s*,\s*(\w+)\s*>$/.exec(t);
  if (map) {
    const key = mapLuaType(map[1]);
    const value = mapLuaType(map[2]);
    if (key && value && !key.id.startsWith('native:') && !value.id.startsWith('native:')) return { id: key.id, container: 'map', valueType: value };
  }
  return { id: `native:${t}` };
}
