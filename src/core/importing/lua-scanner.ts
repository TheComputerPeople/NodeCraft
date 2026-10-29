// Reads a Lua module's functions for exposing them as nodes (docs/code-as-nodes.md, docs/more-languages.md
// "Lua"): the functions of the table the module returns (`function M.name(...)` or `M.name =
// function(...)`), documented with LuaLS-style `---` comments. `---@blueprint` marks one;
// `---@param name type` and `---@return type` give its pins' types. A table annotated `---@class` is a
// class (docs/node-authoring.md, gap 2): its `:` functions are methods, a `.new` function (or one
// returning the class) its constructor, and its `---@field`s whose text says @blueprint its properties.
// The module's table reaches it (`M.Counter = Counter`), or is it (`return Counter`).
import { TypeRef } from '../types';
import { DocComment, ModuleScan, ScannedClass, ScannedFunction, ScannedParam, SkippedFunction, isMarked, parseDocText, tupleOutputs } from './symbols';

export function scanLua(source: string): ModuleScan {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  // The module's table: the name its last top-level `return` gives.
  const returned = [...source.matchAll(/^return\s+([A-Za-z_]\w*)\s*$/gm)].pop()?.[1];
  const functions: ScannedFunction[] = [];
  const skipped: SkippedFunction[] = [];
  // Classes, by the local variable holding the table.
  const classes = new Map<string, ScannedClass & { reachable: boolean }>();
  lines.forEach((text, index) => {
    const annotation = /^---@class\s+([A-Za-z_][\w.]*)\s*(?::\s*([A-Za-z_][\w.]*))?/.exec(text);
    if (!annotation) return;
    let next = index + 1;
    while (next < lines.length && /^\s*---/.test(lines[next])) next++;
    const variable = /^(?:local\s+)?([A-Za-z_]\w*)\s*=/.exec(lines[next] ?? '')?.[1];
    if (!variable) return;
    const [, name, base] = annotation;
    const path = variable === returned ? '' : new RegExp(`^${returned}\\.([A-Za-z_]\\w*)\\s*=\\s*${variable}\\s*$`, 'm').exec(source)?.[1];
    const baseType = base ? mapLuaType(base) : null;
    const cls: ScannedClass & { reachable: boolean } = {
      name: path ?? name, title: name, line: index + 1, doc: docAbove(lines, index), type: mapLuaType(name) ?? { id: `native:${name}` },
      ...(baseType ? { base: baseType } : {}), methods: [], properties: [], reachable: path !== undefined
    };
    // Its fields: ---@field [public] name type [text]; @blueprint in the text marks one.
    for (let i = index + 1; i < next; i++) {
      const field = /^---@field\s+(?:(public|protected|private|package)\s+)?([A-Za-z_]\w*)\??\s+(\S+)\s*(.*)$/.exec(lines[i]);
      if (!field) continue;
      const [, access, fieldName, typeText, rest] = field;
      const marked = /@blueprint\b/.test(rest);
      const doc: DocComment = { description: rest.replace(/@blueprint\b.*$/, '').trim(), tags: marked ? [{ name: 'blueprint', text: /@blueprint\s*(.*)$/.exec(rest)![1] }] : [] };
      if (access && access !== 'public') {
        if (marked) skipped.push({ name: `${name}.${fieldName}`, line: i + 1, reason: "it isn't public", marked: true });
        continue;
      }
      const type = mapLuaType(typeText);
      cls.properties.push({ name: fieldName, line: i + 1, ...(type ? { type } : {}), readonly: false, doc });
    }
    classes.set(variable, cls);
  });
  lines.forEach((text, index) => {
    const declaration = /^(?:function\s+([A-Za-z_]\w*)([.:])([A-Za-z_]\w*)\s*\(([^)]*)\)|([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*function\s*\(([^)]*)\))/.exec(text);
    if (!declaration) return;
    const table = declaration[1] ?? declaration[5];
    const name = declaration[3] ?? declaration[6];
    const params = (declaration[4] ?? declaration[7]).split(',').map((p) => p.trim()).filter(Boolean);
    const doc = docAbove(lines, index);
    const line = index + 1;
    const skip = (reason: string) => skipped.push({ name, line, reason, marked: isMarked(doc) });
    const cls = classes.get(table);
    if (cls && (table !== returned || declaration[2] === ':' || name === 'new')) {
      const memberSkip = (reason: string) => skipped.push({ name: `${cls.title}.${name}`, line, reason, marked: isMarked(doc) });
      if (!cls.reachable) return memberSkip(`Its class ${cls.title} isn't in the table the module returns (${returned ?? 'none'}), so generated code can't reach it.`);
      if (params.includes('...')) return memberSkip('It takes any number of arguments (...).');
      const memberReturns = doc.tags.filter((t) => t.name === 'return');
      const memberOutputs = severalReturns(doc);
      if (memberReturns.length > 1 && !memberOutputs) return memberSkip(NAME_RETURNS);
      const types = new Map(doc.tags.filter((t) => t.name === 'param').map((t) => /^([A-Za-z_]\w*)\??\s+(\S+)/.exec(t.text)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2]]));
      const memberParams: ScannedParam[] = params.map((p) => {
        const type = types.has(p) ? mapLuaType(types.get(p)!) : null;
        return { name: p, ...(type ? { type } : {}) };
      });
      const returnText = memberReturns[0] ? /^(\S+)/.exec(memberReturns[0].text)?.[1] : undefined;
      const memberAsync = isAsync(doc);
      if (memberAsync && memberOutputs) return memberSkip(SEVERAL_ASYNC);
      if (declaration[2] === ':') cls.methods.push({ name, line, params: memberParams, returns: memberOutputs ? undefined : returnText ? mapLuaType(returnText) : null, doc, ...memberOutputs, ...(memberAsync ? { latent: true } : {}) });
      else if (name === 'new' || returnText === cls.title) cls.init = { name, line, params: memberParams, returns: null, doc };
      else memberSkip('Functions of a class without self have no object; make it a module function instead.');
      return;
    }
    if (table !== returned) return skip(returned ? `It belongs to ${table}, not the table the module returns (${returned}).` : "The module doesn't end with `return` of its table.");
    if (declaration[2] === ':') return skip('It takes self (a method): only module functions can be nodes.');
    if (params.includes('...')) return skip('It takes any number of arguments (...).');
    const returns = doc.tags.filter((t) => t.name === 'return');
    const outputs = severalReturns(doc);
    if (returns.length > 1 && !outputs) return skip(NAME_RETURNS);
    const paramTypes = new Map(doc.tags.filter((t) => t.name === 'param').map((t) => /^([A-Za-z_]\w*)\??\s+(\S+)/.exec(t.text)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2]]));
    const scanned: ScannedParam[] = params.map((p) => {
      const type = paramTypes.has(p) ? mapLuaType(paramTypes.get(p)!) : null;
      return { name: p, ...(type ? { type } : {}) };
    });
    const returnType = returns[0] ? /^(\S+)/.exec(returns[0].text)?.[1] : undefined;
    if (isAsync(doc) && outputs) return skip(SEVERAL_ASYNC);
    functions.push({ name, line, params: scanned, returns: outputs ? undefined : returnType ? mapLuaType(returnType) : null, doc, ...outputs, ...(isAsync(doc) ? { latent: true } : {}) });
  });
  const reachable = [...classes.values()].filter((c) => c.reachable).map(({ reachable: _, ...c }) => c);
  return { functions, skipped, ...(reachable.length ? { classes: reachable } : {}) };
}

// The `---` comment lines just above a declaration, as a doc comment. LuaLS's annotations
// (`---@param`) are its tags.
// LuaLS's ---@async: the function runs as a coroutine (docs/node-authoring.md, gap 4), a latent
// node whose value is what it returns.
function isAsync(doc: DocComment): boolean {
  return doc.tags.some((t) => t.name === 'async');
}

const SEVERAL_ASYNC = "It's async and returns several values; a latent node gives one.";

const NAME_RETURNS = 'It returns several values without names: name each (`---@return int sum`) or list them with @outputs.';

// Several values returned (docs/node-authoring.md, gap 3): a `---@return type name` each, named
// there or by @outputs.
function severalReturns(doc: DocComment): Pick<ScannedFunction, 'outputs' | 'results'> | undefined {
  const returns = doc.tags.filter((t) => t.name === 'return').map((t) => /^(\S+)(?:\s+([A-Za-z_]\w*))?/.exec(t.text));
  if (returns.length < 2 || returns.some((r) => !r)) return undefined;
  const outputs = tupleOutputs(doc, returns.map((r) => mapLuaType(r![1]) ?? undefined), returns.map((r) => r![2]));
  return outputs && { outputs, results: { kind: 'tuple', names: outputs.map((o) => o.name) } };
}

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
