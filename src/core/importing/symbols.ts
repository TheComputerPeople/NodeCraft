// Functions read from project code, and how they become nodes (docs/code-as-nodes.md). Each language
// pack's scanner produces a ModuleScan; exposeFunctions turns it into node definitions.
import { NodeDefinition, PinDefinition } from '../model';
import { TypeRef } from '../types';

export interface DocComment {
  // The text before the first tag.
  description: string;
  tags: { name: string; text: string }[];
}

export interface ScannedParam {
  name: string;
  // Absent: any value (no annotation).
  type?: TypeRef;
  // A literal default value, when the parameter has one.
  defaultValue?: unknown;
}

export interface ScannedFunction {
  // The name other modules import it by.
  name: string;
  // 1-based line of the declaration.
  line: number;
  params: ScannedParam[];
  // The return type; null when the function returns nothing, undefined when the type is unknown.
  returns: TypeRef | null | undefined;
  doc: DocComment;
}

// A function that can't become a node, and why.
export interface SkippedFunction {
  name: string;
  line: number;
  reason: string;
  // Marked @blueprint, so its author expects a node.
  marked: boolean;
}

export interface ModuleScan {
  functions: ScannedFunction[];
  skipped: SkippedFunction[];
}

export interface ExposeOptions {
  // The module's language ("typescript", "javascript" or "python").
  language: string;
  // The module's path relative to the workspace folder, with "/" separators.
  path: string;
  // Python: the module's import name.
  module?: string;
  // Expose every function, not only those marked @blueprint (blueprintVisualScripting.exposeAllFunctions).
  exposeAll: boolean;
}

export interface ExposedFunctions {
  definitions: NodeDefinition[];
  // Functions that were meant to be nodes but can't be: marked ones, or all of them with exposeAll.
  skipped: SkippedFunction[];
}

// The marker tag, as in UFUNCTION(BlueprintCallable); "@blueprint pure" is BlueprintPure.
export const MARKER = 'blueprint';

export function isMarked(doc: DocComment): boolean {
  return doc.tags.some((t) => t.name === MARKER);
}

export function functionNodeType(language: string, path: string, name: string): string {
  return `fn:${language}:${path}#${name}`;
}

export function exposeFunctions(scan: ModuleScan, options: ExposeOptions): ExposedFunctions {
  // With exposeAll, names starting with "_" stay private unless marked.
  const definitions = scan.functions
    .filter((fn) => isMarked(fn.doc) || (options.exposeAll && !fn.name.startsWith('_')))
    .map((fn) => definitionFor(fn, options));
  const skipped = scan.skipped.filter((s) => s.marked || (options.exposeAll && !s.name.startsWith('_')));
  return { definitions, skipped };
}

function definitionFor(fn: ScannedFunction, options: ExposeOptions): NodeDefinition {
  const tag = (name: string): string | undefined => fn.doc.tags.find((t) => t.name === name)?.text.trim();
  const pure = /^pure\b/i.test(tag(MARKER) ?? '');
  const category = tag('category');
  const keywords = tag('keywords')?.split(/[\s,]+/).filter(Boolean);
  const exec = (direction: 'input' | 'output'): PinDefinition[] => pure ? [] : [{ id: direction === 'input' ? 'execIn' : 'execOut', name: '', kind: 'exec', direction }];
  const inputs: PinDefinition[] = fn.params.map((p) => ({
    id: p.name, name: words(p.name), kind: 'data', direction: 'input',
    ...(p.type ? { type: p.type } : {}),
    ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {})
  }));
  const outputs: PinDefinition[] = fn.returns === null ? [] : [{
    id: 'returnValue', name: 'Return Value', kind: 'data', direction: 'output', ...(fn.returns ? { type: fn.returns } : {})
  }];
  return {
    type: functionNodeType(options.language, options.path, fn.name),
    version: 1,
    displayName: tag('displayName') || words(fn.name),
    // Unreal nests categories with "|"; the palette shows them as "A / B".
    category: category ? category.split('|').map((c) => c.trim()).filter(Boolean).join(' / ') : `Project / ${fileStem(options.path)}`,
    ...(fn.doc.description ? { description: fn.doc.description } : {}),
    inputs: [...exec('input'), ...inputs],
    outputs: [...exec('output'), ...outputs],
    implementation: { kind: 'function', language: options.language, path: options.path, name: fn.name, ...(options.module ? { module: options.module } : {}) },
    ...(keywords?.length ? { keywords } : {})
  };
}

// A name in words, as Unreal displays function and parameter names: "applyDamage",
// "apply_damage" and "ApplyDamage" all become "Apply Damage"; "loadHTTPPage" becomes "Load HTTP Page".
export function words(name: string): string {
  const parts = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [name];
  return parts.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function fileStem(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.indexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

// Splits documentation text (JSDoc without its comment markers, or a Python docstring) into the
// description and its @tags. A tag's text runs until the next tag.
export function parseDocText(lines: string[]): DocComment {
  const description: string[] = [];
  const tags: DocComment['tags'] = [];
  for (const line of lines) {
    const tag = /^\s*@(\w+)\s*(.*)$/.exec(line);
    if (tag) tags.push({ name: tag[1], text: tag[2] });
    else if (tags.length) tags[tags.length - 1].text += line.trim() ? ` ${line.trim()}` : '';
    else description.push(line.trim());
  }
  return { description: description.join('\n').replace(/\n{3,}/g, '\n\n').trim(), tags: tags.map((t) => ({ name: t.name, text: t.text.trim() })) };
}

export const NO_DOC: DocComment = { description: '', tags: [] };
