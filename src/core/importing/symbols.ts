// Functions read from project code, and how they become nodes (docs/code-as-nodes.md). Each language
// pack's scanner produces a ModuleScan; exposeFunctions turns it into node definitions.
import { CodeMember, CodeResults, FunctionImplementation, NodeDefinition, PinDefinition } from '../model';
import { CODE_CLASS_PREFIX, CodeClassInfo, CodeOverridable, CodeSpelling } from '../objects';
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
  // Taken by shared reference (Rust's &str, &[T]): generated code passes a borrow.
  borrowed?: boolean;
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
  // An async function (docs/node-authoring.md, gap 4): `returns` is the value it gives when it
  // finishes, and its node is latent.
  latent?: boolean;
  // Deprecated by the language's own marker ([Obsolete], #[deprecated], @Deprecated…), which the
  // scanner reads; a @deprecated tag says so too (docs/node-authoring.md, gap 6).
  deprecated?: { message?: string };
  // A class's method (docs/code-classes-as-parents.md): abstract (no body; a subclass gives one),
  // sealed (the language won't let a subclass override it: not virtual in C# and C++, final in Java
  // and PHP), or protected (a subclass may override it, but it's no node with a Target pin).
  abstract?: boolean;
  sealed?: boolean;
  protected?: boolean;
  // A class's method or constructor as the code writes its types (C++, Java): an override has to
  // repeat them, where the graph's own types would be other ones (an int, not a long).
  spelling?: CodeSpelling;
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
  // Its only constructor is private: generated code can't call it, so it gets no Construct node.
  // (A protected one is `init`, marked protected: a subclass calls it.)
  constructorHidden?: boolean;
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
  // As a function's.
  deprecated?: { message?: string };
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
  // C++: the header declares functions a C file implements, without extern "C" of its own
  // (cppHeaderLinkage), so generated C++ includes it in extern "C".
  linkage?: 'c';
}

export interface ExposedFunctions {
  definitions: NodeDefinition[];
  // The classes graph classes may extend (docs/code-classes-as-parents.md): registered with the
  // nodes, but not nodes themselves.
  classes: NodeDefinition[];
  // Functions that were meant to be nodes but can't be: marked ones, or all of them with exposeAll.
  skipped: SkippedFunction[];
  // Each node type's declaration line (1-based), for Go to Definition. Not part of the definitions,
  // which graph files store: a moved line would change them.
  lines: Map<string, number>;
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
  const lines = new Map<string, number>();
  const definitions = [
    ...scan.functions.filter((fn) => isMarked(fn.doc) || (options.exposeAll && !fn.name.startsWith('_'))).map((fn) => {
      const def = definitionFor(fn, options);
      lines.set(def.type, fn.line);
      return def;
    }),
    // Class members only when marked: exposing every member would flood the palette.
    ...(scan.classes ?? []).flatMap((cls) => classDefinitions(cls, options, lines))
  ];
  const classes = (scan.classes ?? []).flatMap((cls) => {
    const definition = codeClassDefinition(cls, options);
    if (definition) lines.set(definition.type, cls.line);
    return definition ? [definition] : [];
  });
  // With exposeAll, an unmarked function its language keeps private (not exported, not public, not
  // in the module's table) was never meant to be a node, so it isn't reported.
  const skipped = scan.skipped.filter((s) => s.marked || (options.exposeAll && !s.name.startsWith('_') && !PRIVATE_REASON.test(s.reason)));
  return { definitions, classes, skipped, lines };
}

const PRIVATE_REASON = /\bisn't (exported|pub\b|public|static\b)|\(private\)|not the table the module returns|doesn't end with `return`|belong to their file/i;

function definitionFor(fn: ScannedFunction, options: ExposeOptions, defaultCategory = `Project / ${fileStem(options.path)}`): NodeDefinition {
  const tag = (name: string): string | undefined => fn.doc.tags.find((t) => t.name === name)?.text.trim();
  // Several outputs: the function runs where execution reaches it, once, however many are read. A
  // latent one runs there too, and its exec output, Completed, runs when it finishes.
  const pure = /^pure\b/i.test(tag(MARKER) ?? '') && !fn.outputs && !fn.latent;
  const category = tag('category');
  const metadata = tagMetadata(fn.doc, fn.deprecated);
  // Unreal's ExpandBoolAsExecs: a bool result becomes True and False exec outputs. ExpandEnumAsExecs:
  // a result of a type the code names may be a graph enum, which adoptUserTypes finds.
  const wantsExecs = tag('execs') !== undefined && !!fn.returns && !fn.returns.container && !fn.outputs && !fn.latent;
  const execs = wantsExecs && fn.returns!.id === 'bool';
  const enumExecs = wantsExecs && fn.returns!.id.startsWith('native:');
  const exec = (direction: 'input' | 'output'): PinDefinition[] => pure && !execs
    ? []
    : direction === 'output' && execs ? [{ id: 'true', name: 'True', kind: 'exec', direction }, { id: 'false', name: 'False', kind: 'exec', direction }]
    : direction === 'output' && fn.latent ? [{ id: 'completed', name: 'Completed', kind: 'exec', direction }] : [{ id: direction === 'input' ? 'execIn' : 'execOut', name: '', kind: 'exec', direction }];
  const inputs: PinDefinition[] = fn.params.map((p) => ({
    id: p.name, name: metadata.pinNames.get(p.name) ?? words(p.name), kind: 'data', direction: 'input',
    ...(p.type ? { type: p.type } : {}),
    ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}),
    ...(metadata.advanced.has(p.name) ? { advanced: true } : {})
  }));
  const outputName = (id: string) => metadata.pinNames.get(id) ?? (id === 'returnValue' ? 'Return Value' : words(id));
  const outputs: PinDefinition[] = execs ? [] : fn.outputs
    ? fn.outputs.map((o) => ({ id: o.name, name: outputName(o.name), kind: 'data', direction: 'output', ...(o.type ? { type: o.type } : {}) }))
    : fn.returns === null ? [] : [{ id: 'returnValue', name: outputName('returnValue'), kind: 'data', direction: 'output', ...(fn.returns ? { type: fn.returns } : {}) }];
  return {
    type: functionNodeType(options.language, options.path, fn.container ? `${fn.container}.${fn.name}` : fn.name),
    version: 1,
    displayName: tag('displayName') || words(fn.name),
    // Unreal nests categories with "|"; the palette shows them as "A / B".
    category: category ? category.split('|').map((c) => c.trim()).filter(Boolean).join(' / ') : defaultCategory,
    ...(fn.doc.description ? { description: fn.doc.description } : {}),
    inputs: [...exec('input'), ...inputs],
    outputs: [...exec('output'), ...outputs],
    implementation: {
      kind: 'function', language: options.language, path: options.path, name: fn.name, ...(moduleOf(fn, options) ? { module: moduleOf(fn, options) } : {}),
      ...(fn.results ? { results: fn.results } : {}), ...(execs ? { execs: 'bool' as const } : enumExecs ? { execs: 'enum' as const } : {}),
      ...(fn.params.some((p) => p.borrowed) ? { borrowed: fn.params.filter((p) => p.borrowed).map((p) => p.name) } : {}),
      ...(options.linkage ? { linkage: options.linkage } : {})
    },
    ...metadata.node,
    ...(fn.latent ? { latent: true } : {})
  };
}

// Unreal's metadata from documentation tags (docs/node-authoring.md, gap 6): @keywords,
// @compactTitle, @deprecated (or the language's own marker, `deprecated`, or Go's "Deprecated:"
// paragraph), @advanced pins and @pinName pin Name.
function tagMetadata(doc: DocComment, deprecated: { message?: string } | undefined): { node: Pick<NodeDefinition, 'keywords' | 'compactTitle' | 'deprecated'>; advanced: Set<string>; pinNames: Map<string, string> } {
  const tag = (name: string): string | undefined => doc.tags.find((t) => t.name === name)?.text.trim();
  const keywords = tag('keywords')?.split(/[\s,]+/).filter(Boolean);
  const compactTitle = tag('compactTitle');
  // A marker without a message (@Deprecated) takes the documentation's (Javadoc's @deprecated).
  const tagged = deprecationOf(doc);
  const marked = deprecated?.message ? deprecated : tagged ?? deprecated;
  const pinNames = new Map(doc.tags.filter((t) => t.name === 'pinName').map((t) => /^(\S+)\s+(.+)$/.exec(t.text.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2].trim()]));
  return {
    node: { ...(keywords?.length ? { keywords } : {}), ...(compactTitle ? { compactTitle } : {}), ...(marked ? { deprecated: marked } : {}) },
    advanced: new Set(doc.tags.filter((t) => t.name === 'advanced').flatMap((t) => t.text.split(/[\s,]+/)).filter(Boolean)),
    pinNames
  };
}

// Generic functions (docs/node-authoring.md, gap 10): a function's type parameters are wildcard
// pins, which take the type of the first wire connected, as Unreal's wildcard nodes do; generated
// code leaves the language to infer them. A scanner renames the type parameters in its type texts
// to these names, which every type mapper reads as wildcards (containers of them too). There are
// two wildcards, so a function may have two type parameters.
const WILDCARD_NAMES: Record<string, string> = { VgWildcard: 'wildcard', VgWildcardValue: 'wildcard:value' };

export function wildcardType(name: string): TypeRef | undefined {
  const id = WILDCARD_NAMES[name];
  return id ? { id } : undefined;
}

// The type parameter names of a declaration's `<…>` or `[…]` text (bounds and defaults dropped).
export function typeParameterNames(text: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let from = 0;
  const take = (part: string) => {
    const name = /^\s*(?:const\s+|in\s+|out\s+)?([A-Za-z_$][\w$]*)/.exec(part)?.[1];
    if (name) names.push(name);
  };
  for (let i = 0; i < text.length; i++) {
    if ('<([{'.includes(text[i])) depth++;
    else if ('>)]}'.includes(text[i])) depth--;
    else if (text[i] === ',' && depth === 0) {
      take(text.slice(from, i));
      from = i + 1;
    }
  }
  take(text.slice(from));
  return names;
}

export const TOO_MANY_TYPE_PARAMETERS = "functions with more than two type parameters can't be nodes";

// Renames the type parameters in a type's text to the wildcard names.
export function substituteTypeParameters(text: string, parameters: readonly string[]): string {
  const names = Object.keys(WILDCARD_NAMES);
  return parameters.reduce((t, p, i) => (i < names.length ? t.replace(new RegExp(`(?<![\\w$])${p.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'), names[i]) : t), text);
}

// Marks what's declared at each line deprecated: the scanners read their language's own markers
// ([Obsolete], [[deprecated]], #[deprecated], @Deprecated, @deprecated(...)) by line.
export function markDeprecated(scan: ModuleScan, lines: Map<number, { message?: string }>): ModuleScan {
  if (!lines.size) return scan;
  const mark = <T extends { line: number; deprecated?: { message?: string } }>(item: T): T => (lines.has(item.line) ? { ...item, deprecated: lines.get(item.line) } : item);
  return {
    ...scan,
    functions: scan.functions.map(mark),
    ...(scan.classes ? { classes: scan.classes.map((c) => ({ ...c, methods: c.methods.map(mark), properties: c.properties.map(mark), ...(c.init ? { init: mark(c.init) } : {}) })) } : {})
  };
}

// A @deprecated tag (JSDoc, PHPDoc, YARD, LuaLS, Godot, Javadoc), or Go's "Deprecated:" paragraph.
export function deprecationOf(doc: DocComment): { message?: string } | undefined {
  const tag = doc.tags.find((t) => t.name === 'deprecated');
  if (tag) return tag.text.trim() ? { message: tag.text.trim() } : {};
  const paragraph = /(?:^|\n\s*\n)Deprecated:\s*([\s\S]*?)(?:\n\s*\n|$)/.exec(doc.description);
  if (paragraph) return paragraph[1].trim() ? { message: paragraph[1].replace(/\s+/g, ' ').trim() } : {};
  return undefined;
}

// The nodes of a class's marked members: Construct from its constructor, a node per method with a
// Target pin, and Get and Set for each property.
function classDefinitions(cls: ScannedClass, options: ExposeOptions, lines: Map<string, number>): NodeDefinition[] {
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
  if (!cls.abstract && !init?.protected && !(cls.constructorHidden && !init) && (init ? isMarked(init.doc) : isMarked(cls.doc))) {
    const base = definitionFor({ ...(init ?? { line: cls.line, params: [], doc: cls.doc }), name: simple, returns: cls.type }, options, `Project / ${simple}`);
    definitions.push({
      ...base, type: type('new'), displayName: `Construct ${simple}`,
      // A constructor runs where execution reaches it, as Construct does for graph classes.
      inputs: [EXEC_IN, ...base.inputs.filter((p) => p.kind === 'data')], outputs: [EXEC_OUT, ...base.outputs.filter((p) => p.kind === 'data')],
      // Its name in the code, for languages whose constructors are functions (Rust's `new`).
      implementation: implementation('construct', init?.name)
    });
    lines.set(type('new'), init?.line ?? cls.line);
  }
  // A protected method is a subclass's to override, not a node with a Target pin.
  for (const method of cls.methods.filter((m) => isMarked(m.doc) && !m.protected)) {
    const base = definitionFor(method, options, `Project / ${simple}`);
    const exec = base.inputs.filter((p) => p.kind === 'exec');
    const own = base.implementation as FunctionImplementation;
    definitions.push({ ...base, type: type(method.name), inputs: [...exec, target, ...base.inputs.filter((p) => p.kind === 'data')], implementation: { ...implementation('method', method.name), ...(own.results ? { results: own.results } : {}), ...(own.execs ? { execs: own.execs } : {}) } });
    lines.set(type(method.name), method.line);
  }
  for (const property of cls.properties.filter((p) => isMarked(p.doc))) {
    const tag = (name: string): string | undefined => property.doc.tags.find((t) => t.name === name)?.text.trim();
    const title = tag('displayName') || words(property.name);
    const category = tag('category');
    const { keywords, deprecated } = tagMetadata(property.doc, property.deprecated).node;
    const shared = {
      version: 1,
      category: category ? category.split('|').map((c) => c.trim()).filter(Boolean).join(' / ') : `Project / ${simple}`,
      ...(property.doc.description ? { description: property.doc.description } : {}),
      ...(keywords ? { keywords } : {}), ...(deprecated ? { deprecated } : {})
    };
    const pin = (id: string, direction: PinDefinition['direction']): PinDefinition => ({ id, name: title, kind: 'data', direction, ...(property.type ? { type: property.type } : {}) });
    definitions.push({ ...shared, type: type(`get:${property.name}`), displayName: `Get ${title}`, inputs: [target], outputs: [pin('returnValue', 'output')], implementation: implementation('get', property.name) });
    lines.set(type(`get:${property.name}`), property.line);
    lines.set(type(`set:${property.name}`), property.line);
    // Unreal's BlueprintReadOnly: "@blueprint readonly", or a property the code can't write.
    if (!property.readonly && !/^readonly\b/i.test(tag(MARKER) ?? '')) {
      definitions.push({ ...shared, type: type(`set:${property.name}`), displayName: `Set ${title}`, inputs: [EXEC_IN, target, pin('value', 'input')], outputs: [EXEC_OUT], implementation: implementation('set', property.name) });
    }
  }
  return definitions;
}

// A class graph classes may extend (docs/code-classes-as-parents.md, decision 1): one marked
// `@blueprint` (Unreal's Blueprintable), or with marked members. Its definition carries what Class
// Settings, Override and Construct need: its constructor's parameters and the methods a subclass may
// override (marked `@blueprint overridable`, or abstract, and not sealed by the language).
function codeClassDefinition(cls: ScannedClass, options: ExposeOptions): NodeDefinition | undefined {
  const simple = cls.title ?? cls.name.split(/::|\.|\\/).pop()!;
  const marked = isMarked(cls.doc) || (cls.init && isMarked(cls.init.doc)) || cls.methods.some((m) => isMarked(m.doc)) || cls.properties.some((p) => isMarked(p.doc));
  if (!marked) return undefined;
  const dataPins = (pins: PinDefinition[]) => pins.filter((p) => p.kind === 'data');
  const overridable: CodeOverridable[] = cls.methods
    .filter((m) => !m.sealed && (m.abstract || /^overridable\b/i.test(m.doc.tags.find((t) => t.name === MARKER)?.text.trim() ?? '')))
    .map((m) => {
      const def = definitionFor(m, options);
      return {
        name: m.name, inputs: dataPins(def.inputs), outputs: dataPins(def.outputs),
        ...(m.abstract ? { abstract: true } : {}), ...(m.protected ? { protected: true } : {}), ...(m.latent ? { latent: true } : {}), ...(m.spelling ? { spelling: m.spelling } : {})
      };
    });
  const id = codeClassId(options.language, options.path, cls.name);
  const info: CodeClassInfo = {
    kind: 'code-class', id, type: cls.type.id, ...(cls.base ? { base: cls.base.id } : {}),
    name: cls.name, title: simple, language: options.language, path: options.path, ...(options.module ? { module: options.module } : {}),
    ...(cls.abstract ? { abstract: true } : {}),
    // (None, when the class declares no constructor: PHP calls parent::__construct only when there's one.)
    ...(cls.init ? { init: dataPins(definitionFor(cls.init, options).inputs), initName: cls.init.name, ...(cls.init.spelling ? { initSpelling: cls.init.spelling.params } : {}), ...(cls.init.protected ? { initProtected: true } : {}) } : {}),
    overridable,
    members: [...new Set([...cls.methods.map((m) => m.name), ...cls.properties.map((p) => p.name)])]
  };
  return {
    type: id, version: 1, displayName: simple, category: 'Project / Classes',
    ...(cls.doc.description ? { description: cls.doc.description } : {}),
    inputs: [], outputs: [], implementation: { kind: 'code-class', type: info }
  };
}

// What a graph class's `parent` names for a class from the code.
export function codeClassId(language: string, path: string, name: string): string {
  return `${CODE_CLASS_PREFIX}${language}:${path}#${name}`;
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
