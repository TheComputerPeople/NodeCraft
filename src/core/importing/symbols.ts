// Functions read from project code, and how they become nodes (docs/code-as-nodes.md). Each language
// pack's scanner produces a ModuleScan; exposeFunctions turns it into node definitions.
import { CodeMember, CodeResults, FunctionImplementation, NodeDefinition, PinDefinition } from '../model';
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
  // The qualified class a static method belongs to (C#): generated code calls Container.name.
  container?: string;
  // Several outputs (docs/node-authoring.md, gap 3), in place of the return value: each named and
  // typed, and how the code gives them.
  outputs?: { name: string; type?: TypeRef }[];
  results?: CodeResults;
}

// A function that can't become a node, and why.
export interface SkippedFunction {
  name: string;
  line: number;
  reason: string;
  // Marked @blueprint, so its author expects a node.
  marked: boolean;
  container?: string;
}

// A class read from project code: its members marked @blueprint become nodes, as Unreal's
// BlueprintCallable member functions and BlueprintReadWrite properties are (docs/node-authoring.md,
// gap 2).
export interface ScannedClass {
  // The name other modules import it by (C#: with its namespace; Lua: its path in the module's
  // table, empty when the module returns the class itself).
  name: string;
  // Its name in the palette, when that isn't the last part of `name`.
  title?: string;
  line: number;
  doc: DocComment;
  // The type its objects have on pins ("native:Player"), and the type of the class it extends.
  type: TypeRef;
  base?: TypeRef;
  // Its declared constructor. A class without one is constructed with no arguments, and the
  // class's own marker exposes that.
  init?: ScannedFunction;
  // An abstract class can't be constructed.
  abstract?: boolean;
  methods: ScannedFunction[];
  properties: ScannedProperty[];
}

export interface ScannedProperty {
  name: string;
  line: number;
  // Absent: any value (no annotation).
  type?: TypeRef;
  // Read-only in the code (readonly, a getter without a setter, …): no Set node.
  readonly: boolean;
  doc: DocComment;
}

export interface ModuleScan {
  functions: ScannedFunction[];
  skipped: SkippedFunction[];
  classes?: ScannedClass[];
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
  const definitions = [
    ...scan.functions.filter((fn) => isMarked(fn.doc) || (options.exposeAll && !fn.name.startsWith('_'))).map((fn) => definitionFor(fn, options)),
    // Class members only when marked: exposing every member would flood the palette.
    ...(scan.classes ?? []).flatMap((cls) => classDefinitions(cls, options))
  ];
  const skipped = scan.skipped.filter((s) => s.marked || (options.exposeAll && !s.name.startsWith('_')));
  return { definitions, skipped };
}

function definitionFor(fn: ScannedFunction, options: ExposeOptions, defaultCategory = `Project / ${fileStem(options.path)}`): NodeDefinition {
  const tag = (name: string): string | undefined => fn.doc.tags.find((t) => t.name === name)?.text.trim();
  // Several outputs: the function runs where execution reaches it, once, however many are read.
  const pure = /^pure\b/i.test(tag(MARKER) ?? '') && !fn.outputs;
  const category = tag('category');
  const keywords = tag('keywords')?.split(/[\s,]+/).filter(Boolean);
  const exec = (direction: 'input' | 'output'): PinDefinition[] => pure ? [] : [{ id: direction === 'input' ? 'execIn' : 'execOut', name: '', kind: 'exec', direction }];
  const inputs: PinDefinition[] = fn.params.map((p) => ({
    id: p.name, name: words(p.name), kind: 'data', direction: 'input',
    ...(p.type ? { type: p.type } : {}),
    ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {})
  }));
  const outputs: PinDefinition[] = fn.outputs
    ? fn.outputs.map((o) => ({ id: o.name, name: o.name === 'returnValue' ? 'Return Value' : words(o.name), kind: 'data', direction: 'output', ...(o.type ? { type: o.type } : {}) }))
    : fn.returns === null ? [] : [{ id: 'returnValue', name: 'Return Value', kind: 'data', direction: 'output', ...(fn.returns ? { type: fn.returns } : {}) }];
  return {
    type: functionNodeType(options.language, options.path, fn.container ? `${fn.container}.${fn.name}` : fn.name),
    version: 1,
    displayName: tag('displayName') || words(fn.name),
    // Unreal nests categories with "|"; the palette shows them as "A / B".
    category: category ? category.split('|').map((c) => c.trim()).filter(Boolean).join(' / ') : defaultCategory,
    ...(fn.doc.description ? { description: fn.doc.description } : {}),
    inputs: [...exec('input'), ...inputs],
    outputs: [...exec('output'), ...outputs],
    implementation: { kind: 'function', language: options.language, path: options.path, name: fn.name, ...(moduleOf(fn, options) ? { module: moduleOf(fn, options) } : {}), ...(fn.results ? { results: fn.results } : {}) },
    ...(keywords?.length ? { keywords } : {})
  };
}

// The nodes of a class's marked members: Construct from its constructor, a node per method with a
// Target pin, and Get and Set for each property.
function classDefinitions(cls: ScannedClass, options: ExposeOptions): NodeDefinition[] {
  // Without its namespace or module ("Game.Player", "game::Player").
  const simple = cls.title ?? cls.name.split(/::|\.|\\/).pop()!;
  const member = (kind: CodeMember['kind'], name?: string): CodeMember => ({ kind, ...(name ? { name } : {}), type: cls.type.id, ...(cls.base ? { base: cls.base.id } : {}) });
  const target: PinDefinition = { id: 'target', name: 'Target', kind: 'data', direction: 'input', type: cls.type };
  const implementation = (kind: CodeMember['kind'], name?: string): FunctionImplementation => ({
    kind: 'function', language: options.language, path: options.path, name: cls.name, ...(options.module ? { module: options.module } : {}), member: member(kind, name)
  });
  const type = (suffix: string) => functionNodeType(options.language, options.path, `${cls.name}:${suffix}`);
  const definitions: NodeDefinition[] = [];
  const init = cls.init;
  if (!cls.abstract && (init ? isMarked(init.doc) : isMarked(cls.doc))) {
    const base = definitionFor({ ...(init ?? { line: cls.line, params: [], doc: cls.doc }), name: simple, returns: cls.type }, options, `Project / ${simple}`);
    definitions.push({
      ...base, type: type('new'), displayName: `Construct ${simple}`,
      // A constructor runs where execution reaches it, as Construct does for graph classes.
      inputs: [EXEC_IN, ...base.inputs.filter((p) => p.kind === 'data')], outputs: [EXEC_OUT, ...base.outputs.filter((p) => p.kind === 'data')],
      // Its name in the code, for languages whose constructors are functions (Rust's `new`).
      implementation: implementation('construct', init?.name)
    });
  }
  for (const method of cls.methods.filter((m) => isMarked(m.doc))) {
    const base = definitionFor(method, options, `Project / ${simple}`);
    const exec = base.inputs.filter((p) => p.kind === 'exec');
    definitions.push({ ...base, type: type(method.name), inputs: [...exec, target, ...base.inputs.filter((p) => p.kind === 'data')], implementation: implementation('method', method.name) });
  }
  for (const property of cls.properties.filter((p) => isMarked(p.doc))) {
    const tag = (name: string): string | undefined => property.doc.tags.find((t) => t.name === name)?.text.trim();
    const title = tag('displayName') || words(property.name);
    const category = tag('category');
    const shared = {
      version: 1,
      category: category ? category.split('|').map((c) => c.trim()).filter(Boolean).join(' / ') : `Project / ${simple}`,
      ...(property.doc.description ? { description: property.doc.description } : {})
    };
    const pin = (id: string, direction: PinDefinition['direction']): PinDefinition => ({ id, name: title, kind: 'data', direction, ...(property.type ? { type: property.type } : {}) });
    definitions.push({ ...shared, type: type(`get:${property.name}`), displayName: `Get ${title}`, inputs: [target], outputs: [pin('returnValue', 'output')], implementation: implementation('get', property.name) });
    // Unreal's BlueprintReadOnly: "@blueprint readonly", or a property the code can't write.
    if (!property.readonly && !/^readonly\b/i.test(tag(MARKER) ?? '')) {
      definitions.push({ ...shared, type: type(`set:${property.name}`), displayName: `Set ${title}`, inputs: [EXEC_IN, target, pin('value', 'input')], outputs: [EXEC_OUT], implementation: implementation('set', property.name) });
    }
  }
  return definitions;
}

const EXEC_IN: PinDefinition = { id: 'execIn', name: '', kind: 'exec', direction: 'input' };
const EXEC_OUT: PinDefinition = { id: 'execOut', name: '', kind: 'exec', direction: 'output' };

// What generated code calls the function through. A C# method's container is its class (with its
// namespace); a Rust function's is the inline modules inside its file's module.
function moduleOf(fn: ScannedFunction, options: ExposeOptions): string | undefined {
  if (options.language === 'rust') return [options.module, fn.container].filter(Boolean).join('::') || undefined;
  return fn.container ?? options.module;
}

// A tuple's outputs: named in the code (`names`, when every one is), else by the `@outputs a b` tag;
// undefined when there aren't as many names as types.
export function tupleOutputs(doc: DocComment, types: (TypeRef | undefined)[], names?: (string | undefined)[]): { name: string; type?: TypeRef }[] | undefined {
  const tagged = doc.tags.find((t) => t.name === 'outputs')?.text.split(/[\s,]+/).filter(Boolean);
  const chosen = names?.every(Boolean) ? (names as string[]) : tagged;
  if (!chosen || chosen.length !== types.length || types.length < 2) return undefined;
  return chosen.map((name, i) => ({ name, ...(types[i] ? { type: types[i] } : {}) }));
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
