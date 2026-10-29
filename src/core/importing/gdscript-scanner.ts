// Reads a GDScript file's functions for exposing them as nodes (docs/code-as-nodes.md, docs/more-languages.md
// "GDScript"): `static func`s, documented with Godot 4's `##` comments, `## @blueprint` marking one.
// Their typed parameters and return type give the pins' types. Generated code preloads the script by
// its path and calls them on it. A script with a class_name is also a class (docs/node-authoring.md,
// gap 2): its other functions are methods, `_init` its constructor and its variables properties.
import { TypeRef } from '../types';
import { DocComment, ModuleScan, ScannedClass, ScannedFunction, ScannedParam, SkippedFunction, isMarked, parseDocText } from './symbols';

// Whether the function declared at `index` awaits anywhere in its body (the lines indented under it).
function awaits(lines: string[], index: number): boolean {
  for (let i = index + 1; i < lines.length; i++) {
    const text = lines[i];
    if (text.trim() && !/^\s/.test(text)) return false;
    if (/(^|[^\w"'])await\b/.test(text.replace(/#.*$/, ''))) return true;
  }
  return false;
}

export function scanGdscript(source: string): ModuleScan {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const functions: ScannedFunction[] = [];
  const skipped: SkippedFunction[] = [];
  // The script as a class, when it has a class_name.
  const className = /^class_name\s+([A-Za-z_]\w*)/m.exec(lines.join('\n'))?.[1];
  const base = /^extends\s+([A-Za-z_]\w*)\s*$/m.exec(lines.join('\n'))?.[1];
  const baseType = base ? mapGdscriptType(base) : null;
  const cls: ScannedClass | undefined = className
    ? { name: className, line: 1, doc: docAbove(lines, lines.findIndex((l) => /^class_name\b/.test(l))), type: mapGdscriptType(className) ?? { id: `native:${className}` }, ...(baseType?.id.startsWith('native:') ? { base: baseType } : {}), methods: [], properties: [] }
    : undefined;
  lines.forEach((text, index) => {
    // A script variable (`var health: float = 100`, after any annotations such as @export).
    const variable = cls && /^(?:@\w+(?:\([^)]*\))?\s+)*var\s+([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*(?::?=.*)?$/.exec(text);
    if (variable && cls) {
      const [, name, typeText] = variable;
      const doc = docAbove(lines, index);
      if (name.startsWith('_')) {
        if (isMarked(doc)) skipped.push({ name, line: index + 1, reason: 'Its name starts with _ (private).', marked: true });
      } else {
        const type = typeText ? mapGdscriptType(typeText) : null;
        cls.properties.push({ name, line: index + 1, ...(type ? { type } : {}), readonly: false, doc });
      }
      return;
    }
    // Top-level functions only: inner classes' are indented.
    const declaration = /^(static\s+)?func\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([\w[\], ]+?))?\s*:/.exec(text);
    if (!declaration) return;
    const [, isStatic, name, paramText, returnText] = declaration;
    const doc = docAbove(lines, index);
    const line = index + 1;
    const skip = (reason: string) => skipped.push({ name, line, reason, marked: isMarked(doc) });
    if (!isStatic && !cls) return skip("It isn't static: generated code calls functions on the script, without an object. (Give the script a class_name for its methods to be nodes.)");
    if (name.startsWith('_') && !(cls && !isStatic && name === '_init')) return skip('Its name starts with _ (private).');
    const params: ScannedParam[] = splitParams(paramText).map((p) => {
      const [, paramName, typeText, defaultText] = /^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*(?::?=\s*(.+))?$/.exec(p) ?? [, p, undefined, undefined];
      const type = typeText ? mapGdscriptType(typeText) : undefined;
      const defaultValue = defaultText !== undefined ? literal(defaultText) : undefined;
      return { name: paramName ?? p, ...(type ? { type } : {}), ...(defaultValue !== undefined ? { defaultValue } : {}) };
    });
    const returns = returnText ? mapGdscriptType(returnText) : undefined;
    // A function that awaits is a coroutine (docs/node-authoring.md, gap 4): a latent node.
    const latent = awaits(lines, index) ? { latent: true } : {};
    if (cls && !isStatic && name === '_init') cls.init = { name, line, params, returns: null, doc };
    else if (cls && !isStatic) cls.methods.push({ name, line, params, returns, doc, ...latent });
    else functions.push({ name, line, params, returns, doc, ...latent });
  });
  return { functions, skipped, ...(cls ? { classes: [cls] } : {}) };
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
