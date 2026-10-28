// Reads a GDScript file's functions for exposing them as nodes (docs/code-as-nodes.md, docs/more-languages.md
// "GDScript"): `static func`s, documented with Godot 4's `##` comments, `## @blueprint` marking one.
// Their typed parameters and return type give the pins' types. Generated code preloads the script by
// its path and calls them on it, so only static functions can be nodes.
import { TypeRef } from '../types';
import { DocComment, ModuleScan, ScannedFunction, ScannedParam, SkippedFunction, isMarked, parseDocText } from './symbols';

export function scanGdscript(source: string): ModuleScan {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const functions: ScannedFunction[] = [];
  const skipped: SkippedFunction[] = [];
  lines.forEach((text, index) => {
    // Top-level functions only: inner classes' are indented.
    const declaration = /^(static\s+)?func\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([\w[\], ]+?))?\s*:/.exec(text);
    if (!declaration) return;
    const [, isStatic, name, paramText, returnText] = declaration;
    const doc = docAbove(lines, index);
    const line = index + 1;
    const skip = (reason: string) => skipped.push({ name, line, reason, marked: isMarked(doc) });
    if (!isStatic) return skip("It isn't static: generated code calls functions on the script, without an object.");
    if (name.startsWith('_')) return skip('Its name starts with _ (private).');
    const params: ScannedParam[] = splitParams(paramText).map((p) => {
      const [, paramName, typeText, defaultText] = /^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*(?::?=\s*(.+))?$/.exec(p) ?? [, p, undefined, undefined];
      const type = typeText ? mapGdscriptType(typeText) : undefined;
      const defaultValue = defaultText !== undefined ? literal(defaultText) : undefined;
      return { name: paramName ?? p, ...(type ? { type } : {}), ...(defaultValue !== undefined ? { defaultValue } : {}) };
    });
    functions.push({ name, line, params, returns: returnText ? mapGdscriptType(returnText) : undefined, doc });
  });
  return { functions, skipped };
}

// The `##` comment lines just above a declaration (annotations such as @warning_ignore between them
// and it are skipped).
function docAbove(lines: string[], index: number): DocComment {
  let i = index - 1;
  while (i >= 0 && /^\s*@\w+/.test(lines[i])) i--;
  const block: string[] = [];
  for (; i >= 0 && /^\s*##/.test(lines[i]); i--) block.unshift(lines[i].replace(/^\s*##\s?/, ''));
  return parseDocText(block);
}

// Parameters split at top-level commas (a typed array's or dictionary's brackets hold commas too).
function splitParams(text: string): string[] {
  const params: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of text) {
    if (c === '[' || c === '(' || c === '{') depth++;
    if (c === ']' || c === ')' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      params.push(current.trim());
      current = '';
    } else current += c;
  }
  if (current.trim()) params.push(current.trim());
  return params;
}

function literal(text: string): unknown {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^"([^"\\]|\\.)*"$/.test(t)) return JSON.parse(t);
  return undefined;
}

// A GDScript type as a canonical type: int, float, bool, String, typed arrays (Array[int]) and
// dictionaries (Dictionary[String, int]); untyped Array and Dictionary hold any value, Variant is any
// value, void nothing, and other classes are native.
export function mapGdscriptType(text: string): TypeRef | null {
  const t = text.trim();
  switch (t) {
    case 'void':
      return null;
    case 'Variant':
      return { id: 'any' };
    case 'int':
      return { id: 'int' };
    case 'float':
      return { id: 'float' };
    case 'bool':
      return { id: 'bool' };
    case 'String':
    case 'StringName':
      return { id: 'string' };
    case 'Array':
      return { id: 'any', container: 'array' };
    case 'Dictionary':
      return { id: 'any', container: 'map', valueType: { id: 'any' } };
  }
  const array = /^Array\[\s*(\w+)\s*\]$/.exec(t);
  if (array) {
    const element = mapGdscriptType(array[1]);
    return element && !element.container && !element.id.startsWith('native:') ? { id: element.id, container: 'array' } : { id: `native:${t}` };
  }
  const map = /^Dictionary\[\s*(\w+)\s*,\s*(\w+)\s*\]$/.exec(t);
  if (map) {
    const key = mapGdscriptType(map[1]);
    const value = mapGdscriptType(map[2]);
    if (key && value && !key.container && !value.container && !key.id.startsWith('native:') && !value.id.startsWith('native:')) return { id: key.id, container: 'map', valueType: value };
  }
  return { id: `native:${t}` };
}
