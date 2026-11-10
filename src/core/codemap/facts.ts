// What one source file declares and imports (docs/codebase-map.md, Part 2), from tree-sitter queries.
// The queries are plain text here; the parsing worker runs them and sends back each match's
// captures as plain data, which factsFromMatches reads per language. Free of tree-sitter itself, as
// src/core imports no packages.
import { GrammarId } from '../parsing/grammars';

// One captured node: its capture name, node type, range, and (for names and import statements) its
// text. Definitions send no text: only their range.
export interface Capture {
  name: string;
  type: string;
  // 0-based rows and byte offsets.
  startRow: number;
  endRow: number;
  startIndex: number;
  endIndex: number;
  text?: string;
}

export interface QueryMatch {
  captures: Capture[];
}

export type DeclarationKind = 'class' | 'interface' | 'struct' | 'enum' | 'trait' | 'type' | 'namespace' | 'function' | 'method' | 'constructor';

export interface Declaration {
  kind: DeclarationKind;
  name: string;
  // The enclosing declarations' names, outermost first (a method's class, a class's namespace).
  container: string[];
  // 1-based lines.
  line: number;
  endLine: number;
}

export interface ImportFact {
  // As written: "./b", "os.path", "a/b.h", "crate::a::b", "App\\Models\\User", "res://c.gd".
  source: string;
  // module: the language's own module system; include: a C or C++ header ("..." form);
  // system: a <...> header; mod: Rust's `mod name;`; file: a path (require_relative, PHP include,
  // GDScript preload).
  kind: 'module' | 'include' | 'system' | 'mod' | 'file';
  // Python's `from . import a, b`: the names imported, which may be modules themselves.
  names?: string[];
  // Python's leading dots (1 for "."), for relative imports.
  level?: number;
  // Rust's `#[path = "..."]` on a `mod name;`: the file, relative to the declaring module's folder.
  path?: string;
  line: number;
}

export type EntryKind = 'main' | 'script' | 'test' | 'engine';

export interface EntryFact {
  kind: EntryKind;
  // The function it is (absent for a script's top level).
  name?: string;
  line: number;
}

export interface FileFacts {
  grammar: GrammarId;
  // The package or namespace the file declares (Java, C#, Go, PHP), or its class_name (GDScript).
  package?: string;
  declarations: Declaration[];
  imports: ImportFact[];
  entries: EntryFact[];
  // Syntax errors in the file (the rest is still read: tree-sitter recovers).
  errors: number;
}

// Captures whose text the worker sends; others send their range only.
export function capturesText(name: string): boolean {
  return name === 'name' || name === 'source' || name === 'import' || name === 'package' || name === 'receiver' || name === 'test.name';
}

// The longest text a capture sends (an import statement, a name).
export const MAX_CAPTURE_TEXT = 1000;

const TS_COMMON = `
(class_declaration name: (_) @name) @definition.class
(function_declaration name: (_) @name) @definition.function
(generator_function_declaration name: (_) @name) @definition.function
(method_definition name: (_) @name) @definition.method
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function
(import_statement source: (string (string_fragment) @source)) @import
(export_statement source: (string (string_fragment) @source)) @import
(call_expression function: (identifier) @_require (#eq? @_require "require") arguments: (arguments . (string (string_fragment) @source))) @import
(call_expression function: (import) arguments: (arguments . (string (string_fragment) @source))) @import
(expression_statement (call_expression function: (identifier) @_test (#match? @_test "^(test|it|describe)$") arguments: (arguments . (string (string_fragment) @test.name)))) @entry.test
`;

const TS_ONLY = `
(abstract_class_declaration name: (_) @name) @definition.class
(interface_declaration name: (_) @name) @definition.interface
(enum_declaration name: (_) @name) @definition.enum
(type_alias_declaration name: (_) @name) @definition.type
(internal_module name: (_) @name) @definition.namespace
(abstract_method_signature name: (_) @name) @definition.method
`;

const C_COMMON = `
(function_definition declarator: [
  (function_declarator declarator: (_) @name)
  (pointer_declarator declarator: (function_declarator declarator: (_) @name))
  (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (_) @name)))
]) @definition.function
(struct_specifier name: (type_identifier) @name body: (_)) @definition.struct
(union_specifier name: (type_identifier) @name body: (_)) @definition.struct
(enum_specifier name: (type_identifier) @name body: (_)) @definition.enum
(preproc_include path: (string_literal (string_content) @source)) @import.include
(preproc_include path: (system_lib_string) @source) @import.system
`;

export const QUERIES: Record<GrammarId, string> = {
  typescript: TS_COMMON + TS_ONLY,
  tsx: TS_COMMON + TS_ONLY,
  javascript: TS_COMMON,
  python: `
(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function
(import_statement) @import
(import_from_statement) @import
(if_statement condition: (comparison_operator (identifier) @_name (string (string_content) @_main)) (#eq? @_name "__name__") (#eq? @_main "__main__")) @entry.script
`,
  c_sharp: `
(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(struct_declaration name: (identifier) @name) @definition.struct
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor
(local_function_statement name: (identifier) @name) @definition.function
(namespace_declaration name: (_) @name) @definition.namespace
(file_scoped_namespace_declaration name: (_) @package)
(using_directive) @import
(global_statement) @entry.script
(method_declaration (attribute_list (attribute name: (_) @_attr (#match? @_attr "^(Test|Fact|Theory|TestMethod|TestCase)$"))) name: (identifier) @test.name) @entry.test
`,
  c: C_COMMON,
  cpp: `${C_COMMON}
(function_definition declarator: (reference_declarator (function_declarator declarator: (_) @name))) @definition.function
(class_specifier name: (type_identifier) @name body: (_)) @definition.class
(namespace_definition name: (_) @name) @definition.namespace
`,
  rust: `
(struct_item name: (type_identifier) @name) @definition.struct
(union_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(function_item name: (identifier) @name) @definition.function
(impl_item type: [(type_identifier) @name (generic_type type: (type_identifier) @name) (scoped_type_identifier name: (type_identifier) @name)]) @definition.type
(mod_item name: (identifier) @name body: (_)) @definition.namespace
(mod_item name: (identifier) @source !body) @import.mod
(attribute_item (attribute (identifier) @_path (#eq? @_path "path") value: (string_literal (string_content) @source))) @import.path
(use_declaration) @import
((attribute_item (attribute (identifier) @_test (#match? @_test "^(test|tokio::test)$"))) . (function_item name: (identifier) @test.name)) @entry.test
`,
  java: `
(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor
(package_declaration (_) @package)
(import_declaration) @import
(method_declaration (modifiers [(marker_annotation name: (identifier) @_test) (annotation name: (identifier) @_test)] (#match? @_test "^(Test|ParameterizedTest)$")) name: (identifier) @test.name) @entry.test
`,
  go: `
(package_clause (package_identifier) @package)
(function_declaration name: (identifier) @name) @definition.function
(method_declaration receiver: (parameter_list (parameter_declaration type: [(type_identifier) @receiver (pointer_type (type_identifier) @receiver) (generic_type type: (type_identifier) @receiver) (pointer_type (generic_type type: (type_identifier) @receiver))])) name: (field_identifier) @name) @definition.method
(type_spec name: (type_identifier) @name type: (struct_type)) @definition.struct
(type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface
(import_spec path: (interpreted_string_literal (interpreted_string_literal_content) @source)) @import
`,
  lua: `
(function_declaration name: (_) @name) @definition.function
(assignment_statement (variable_list name: (_) @name) (expression_list value: (function_definition))) @definition.function
(function_call name: (identifier) @_require (#eq? @_require "require") arguments: (arguments . (string content: (string_content) @source))) @import
`,
  gdscript: `
(class_name_statement (name) @package)
(class_definition name: (name) @name) @definition.class
(function_definition name: (name) @name) @definition.function
(constructor_definition) @definition.constructor
(enum_definition name: (name) @name) @definition.enum
(extends_statement (string) @source) @import.file
(call (identifier) @_load (#match? @_load "^(preload|load)$") (arguments . (string) @source)) @import.file
`,
  ruby: `
(class name: (_) @name) @definition.class
(module name: (_) @name) @definition.namespace
(method name: (_) @name) @definition.method
(singleton_method name: (_) @name) @definition.method
(call method: (identifier) @_require (#match? @_require "^(require|load)$") arguments: (argument_list . (string (string_content) @source))) @import
(call method: (identifier) @_require (#eq? @_require "require_relative") arguments: (argument_list . (string (string_content) @source))) @import.file
`,
  php: `
(namespace_definition name: (namespace_name) @package)
(class_declaration name: (name) @name) @definition.class
(interface_declaration name: (name) @name) @definition.interface
(trait_declaration name: (name) @name) @definition.trait
(enum_declaration name: (name) @name) @definition.enum
(function_definition name: (name) @name) @definition.function
(method_declaration name: (name) @name) @definition.method
(namespace_use_declaration) @import
${['include_expression', 'include_once_expression', 'require_expression', 'require_once_expression'].map((form) =>
    `(${form} [(string (string_content) @source) (encapsed_string (string_content) @source) (binary_expression right: [(string (string_content) @source) (encapsed_string (string_content) @source)])]) @import.file`).join('\n')}
(method_declaration (attribute_list (attribute_group (attribute (name) @_test (#eq? @_test "Test")))) name: (name) @test.name) @entry.test
`
};

// Kinds a definition capture names ("definition.class" is a class).
const DEFINITION_KINDS = new Set<string>(['class', 'interface', 'struct', 'enum', 'trait', 'type', 'namespace', 'function', 'method', 'constructor']);

// Functions that are a program's entry point by name, per grammar (C#'s Main is a method).
const MAIN_NAMES: Partial<Record<GrammarId, RegExp>> = {
  c: /^main$/, cpp: /^main$/, rust: /^main$/, go: /^main$/, java: /^main$/, c_sharp: /^Main$/, python: /^main$/
};

// Godot calls these on a node; the engine is their caller.
const GODOT_CALLBACKS = /^_(ready|process|physics_process|input|unhandled_input|unhandled_key_input|enter_tree|exit_tree|notification|draw|gui_input)$/;

export function factsFromMatches(grammar: GrammarId, matches: QueryMatch[], errors: number): FileFacts {
  const facts: FileFacts = { grammar, declarations: [], imports: [], entries: [], errors };
  const definitions: { kind: DeclarationKind; name: string; start: number; end: number; line: number; endLine: number; receiver?: string }[] = [];
  const pathAttributes: { line: number; path: string }[] = [];
  for (const match of matches) {
    const byName = (name: string) => match.captures.find((c) => c.name === name);
    const definition = match.captures.find((c) => c.name.startsWith('definition.'));
    if (definition) {
      const kind = definition.name.slice('definition.'.length);
      const name = byName('name')?.text ?? (kind === 'constructor' ? '_init' : undefined);
      if (DEFINITION_KINDS.has(kind) && name) {
        definitions.push({ kind: kind as DeclarationKind, name: cleanName(grammar, name), start: definition.startIndex, end: definition.endIndex, line: definition.startRow + 1, endLine: definition.endRow + 1, receiver: byName('receiver')?.text });
      }
      continue;
    }
    const pkg = byName('package');
    if (pkg?.text) facts.package ??= pkg.text.replace(/\s+/g, '');
    const entry = match.captures.find((c) => c.name.startsWith('entry.'));
    if (entry) {
      facts.entries.push({ kind: entry.name.slice('entry.'.length) as EntryKind, name: byName('test.name')?.text, line: entry.startRow + 1 });
      continue;
    }
    const statement = match.captures.find((c) => c.name.startsWith('import'));
    if (statement?.name === 'import.path') {
      if (byName('source')?.text) pathAttributes.push({ line: statement.startRow + 1, path: byName('source')!.text! });
    } else if (statement) {
      facts.imports.push(...importsOf(grammar, statement, byName('source')));
    }
  }
  // Rust's #[path] belongs to the `mod` declared after it (other attributes may come between).
  for (const attribute of pathAttributes) {
    const mod = facts.imports.filter((i) => i.kind === 'mod' && i.line > attribute.line && i.line <= attribute.line + 4).sort((a, b) => a.line - b.line)[0];
    if (mod) mod.path = attribute.path;
  }
  // Nesting from the definitions' ranges: each one's container is the definitions around it.
  definitions.sort((a, b) => a.start - b.start || b.end - a.end);
  const open: typeof definitions = [];
  for (const d of definitions) {
    while (open.length && open[open.length - 1].end <= d.start) open.pop();
    // Rust's impl blocks and Go's receivers name the type a method belongs to.
    const container = [...open.map((o) => o.name), ...(d.receiver ? [d.receiver] : [])];
    const inType = open.some((o) => o.kind !== 'namespace' && o.kind !== 'function' && o.kind !== 'method') || !!d.receiver;
    let kind = d.kind;
    if (kind === 'function' && inType) kind = 'method';
    // A C++ method defined outside its class: `A::f`.
    let name = d.name;
    if ((grammar === 'cpp' || grammar === 'c') && name.includes('::')) {
      const parts = name.split('::');
      name = parts.pop()!;
      container.push(...parts);
      if (kind === 'function') kind = 'method';
    }
    // Lua's `function M.f()` and `function M:f()` belong to the table M.
    if (grammar === 'lua' && /[.:]/.test(name)) {
      const parts = name.split(/[.:]/);
      name = parts.pop()!;
      container.push(...parts);
    }
    // impl blocks stand for their type: their methods go in it, the block itself isn't listed.
    if (!(grammar === 'rust' && d.kind === 'type')) {
      facts.declarations.push({ kind, name, container, line: d.line, endLine: d.endLine });
    }
    open.push(d);
  }
  // Entry points named by their function: main, Godot's callbacks.
  const main = MAIN_NAMES[grammar];
  for (const d of facts.declarations) {
    const free = d.container.length === 0;
    if (main?.test(d.name) && (d.kind === 'function' || d.kind === 'method') && (grammar === 'java' || grammar === 'c_sharp' ? true : free)) {
      // Go's main is the entry point only in package main; Python's main() only when the file runs it.
      if (grammar === 'go' && facts.package !== 'main') continue;
      if (grammar === 'python' && !facts.entries.some((e) => e.kind === 'script')) continue;
      facts.entries.push({ kind: 'main', name: d.name, line: d.line });
    }
    if (grammar === 'gdscript' && free && GODOT_CALLBACKS.test(d.name)) facts.entries.push({ kind: 'engine', name: d.name, line: d.line });
    if (grammar === 'go' && free && d.kind === 'function' && /^(Test|Benchmark|Example|Fuzz)[A-Z_0-9]/.test(d.name)) facts.entries.push({ kind: 'test', name: d.name, line: d.line });
    if (grammar === 'python' && /^test_?/.test(d.name) && (d.kind === 'function' || d.kind === 'method')) facts.entries.push({ kind: 'test', name: d.name, line: d.line });
  }
  // A C# file's top-level statements are one entry point, not one per statement.
  const scripts = facts.entries.filter((e) => e.kind === 'script');
  if (scripts.length > 1) facts.entries = facts.entries.filter((e) => e.kind !== 'script' || e === scripts[0]);
  facts.entries.sort((a, b) => a.line - b.line);
  return facts;
}

function cleanName(grammar: GrammarId, name: string): string {
  const trimmed = name.replace(/\s+/g, '');
  // C++ templates' arguments and destructors' tildes stay; generic parameters elsewhere go.
  return grammar === 'cpp' ? trimmed : trimmed.replace(/<.*$/, '');
}

function unquote(text: string): string {
  return text.replace(/^["'<]|["'>]$/g, '');
}

function importsOf(grammar: GrammarId, statement: Capture, source: Capture | undefined): ImportFact[] {
  const line = statement.startRow + 1;
  const kind = statement.name === 'import' ? 'module' : statement.name.slice('import.'.length) as ImportFact['kind'];
  const text = statement.text ?? '';
  switch (grammar) {
    case 'python':
      return pythonImports(text, line);
    case 'c_sharp': {
      // using N.M; using A = N.M; using static N.M; (global using too). Aliases of a type keep the type's namespace.
      const m = /using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/.exec(text);
      return m ? [{ source: m[1], kind: 'module', line }] : [];
    }
    case 'java': {
      const m = /import\s+(static\s+)?([\w.]+)(\.\*)?\s*;/.exec(text.replace(/\s+/g, ' ').replace(/\s*\.\s*/g, '.'));
      if (!m) return [];
      // A static import names a member: the module is its class.
      const path = m[1] && !m[3] ? m[2].replace(/\.[^.]+$/, '') : m[2];
      return [{ source: m[3] ? `${path}.*` : path, kind: 'module', line }];
    }
    case 'rust':
      if (kind === 'mod') return source?.text ? [{ source: source.text, kind: 'mod', line }] : [];
      return rustUsePaths(text.replace(/^\s*(pub(\([^)]*\))?\s+)?use\s+/, '').replace(/;\s*$/, '')).map((path) => ({ source: path, kind: 'module', line }));
    case 'php':
      if (kind === 'file') return source?.text ? [{ source: source.text, kind: 'file', line }] : [];
      return phpUses(text).map((path) => ({ source: path, kind: 'module', line }));
    case 'gdscript':
      return source?.text ? [{ source: unquote(source.text), kind: 'file', line }] : [];
    default:
      return source?.text ? [{ source: unquote(source.text), kind, line }] : [];
  }
}

// import a.b, c as d / from .x import y, z as w / from . import (a, b)
function pythonImports(text: string, line: number): ImportFact[] {
  const flat = text.replace(/\\\n/g, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const from = /^from (\.*)([\w.]*) import (.+)$/.exec(flat);
  if (from) {
    const names = from[3].split(',').map((n) => n.trim().split(' as ')[0].trim()).filter((n) => n && n !== '*');
    return [{ source: from[2], kind: 'module', names, level: from[1].length || undefined, line }];
  }
  const plain = /^import (.+)$/.exec(flat);
  return plain ? plain[1].split(',').map((n) => ({ source: n.trim().split(' as ')[0].trim(), kind: 'module' as const, line })).filter((i) => i.source) : [];
}

// a::b::{c, d::e, f as g, self} → a::b::c, a::b::d::e, a::b::f, a::b
export function rustUsePaths(tree: string): string[] {
  const text = tree.replace(/\s+/g, '');
  const brace = text.indexOf('{');
  if (brace < 0) return [text.replace(/as\w+$/, '').replace(/::\*$/, '')].filter(Boolean);
  const prefix = text.slice(0, brace).replace(/::$/, '');
  const inner = text.slice(brace + 1, text.lastIndexOf('}'));
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts.filter(Boolean).flatMap((part) => (part === 'self' ? [prefix] : rustUsePaths(part).map((p) => (prefix ? `${prefix}::${p}` : p))));
}

// use A\B; use A\B as C; use function A\f; use A\{B, C\D}; → A\B, A\C\D, ...
export function phpUses(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ').replace(/^\s*use\s+(function\s+|const\s+)?/, '').replace(/;\s*$/, '').trim();
  const brace = flat.indexOf('{');
  const clean = (s: string) => s.trim().replace(/^(function|const)\s+/, '').split(/\s+as\s+/)[0].trim().replace(/^\\/, '');
  if (brace < 0) return flat.split(',').map(clean).filter(Boolean);
  const prefix = flat.slice(0, brace).trim().replace(/\\$/, '').replace(/^\\/, '');
  return flat.slice(brace + 1, flat.lastIndexOf('}')).split(',').map(clean).filter(Boolean).map((name) => `${prefix}\\${name}`);
}
