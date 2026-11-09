// Rust pack (docs/language-breadth.md, "Rust"): a module per graph, generated from Visual IR, run
// through a small Cargo project. Objects are Rc<Self> whose fields are each a RefCell, read and
// written through vgraph::get and vgraph::set so no borrow outlives a call: an object can be called
// back (a dispatcher's handler, an event) while one of its methods runs.
import { IrCallee, IrCodeHelper, IrExpr, IrFunction, IrProgram, IrStatement, calleeSignature, classInfo, exprType, programClassSpec, userTypes, canComplete } from '../compiler/ir';
import { ClassMemberNames, ClassMemberStyles, NameScope, claimClassMembers, dedent, toIdentifier } from '../compiler/names';
import { CodeWriter } from '../compiler/writer';
import { CodeGenerator, CodeRunner, GenerateOptions, GeneratedCode, LanguagePack, PinExpression, RunContext } from '../language-pack';
import { OutputPlan, PlacementContext } from '../output-plan';
import type { ClassInfo } from '../objects';
import { LANGUAGE_TERMS } from '../terms';
import { TypeRef, parseTypeId } from '../types';
import { EnumInfo, StructInfo, UserType, isUserTypeId } from '../user-types';
import { scanRust } from '../importing/rust-scanner';
import { RUST_ALLOWED_LINTS, RUST_RUNTIME, RUST_RUNTIME_MODULE } from './rust-runtime';

const RESERVED = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in',
  'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type',
  'unsafe', 'use', 'where', 'while', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual',
  'yield', 'try', 'union',
  // Names generated code relies on.
  'std', 'vgraph', 'me', 'new', 'this', 'Rc', 'Weak', 'RefCell', 'String', 'Vec', 'Option', 'Some', 'None', 'Box'
]);

const PRIMITIVES: Record<string, string> = { bool: 'bool', int: 'i64', float: 'f64', string: 'String', any: 'vgraph::Value', wildcard: 'vgraph::Value' };

function mapType(type: TypeRef): string {
  const { category, name } = parseTypeId(type.id);
  const element = PRIMITIVES[type.id] ?? (category === 'object' ? `Option<Rc<${name}>>` : category === 'interface' ? `Option<Rc<dyn ${name}>>` : category === 'struct' || category === 'enum' ? name : 'vgraph::Value');
  if (type.container === 'array') return `Vec<${element}>`;
  if (type.container === 'set') return `vgraph::Set<${element}>`;
  if (type.container === 'map') return `vgraph::Map<${element}, ${type.valueType ? mapType(type.valueType) : 'vgraph::Value'}>`;
  return element;
}

const CLASS_STYLES: ClassMemberStyles = { functions: 'snake', variables: 'snake', dispatchers: 'snake' };

function classScope(): NameScope {
  return new NameScope(RESERVED, ['start', 'run_test']);
}

export function rustOutputFileName(graphFileName: string): string {
  return `${toIdentifier(graphFileName.replace(/\.vgraph$/i, ''), 'snake')}_vgraph.rs`;
}

export function rustLibraryExports(_libraryName: string, functions: { id: string; name: string }[]): { names: Map<string, string> } {
  const scope = new NameScope(RESERVED);
  return { names: new Map(functions.map((f) => [f.id, scope.claim(f.name, 'snake')])) };
}

export function rustFieldNames(type: StructInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, 'snake')]));
}

export function rustEnumMembers(type: EnumInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.enumerators.map((e) => [e.id, scope.claim(e.name, 'pascal')]));
}

// The project crate's modules, declared in an inline module whose path is the crate's src folder
// (so each loads, with its own submodules, as in the crate) and used at the root, so
// `crate::game::combat` resolves in the scaffold as in the project. Code a graph calls in another
// crate of the workspace (`corpus_core::text`) is the scaffold's own, by that crate's name.
function projectModules(crate: { src: string; modules: string[]; name?: string } | undefined): string[] {
  if (!crate?.modules.length) return [];
  return [
    // (Not when a module has the crate's name, which then needs no alias to resolve.)
    ...(crate.name && crate.name !== 'blueprint_run' && !crate.modules.includes(crate.name) ? [`extern crate self as ${crate.name};`] : []),
    `#[path = "${crate.src.replace(/\\/g, '/')}"]`,
    'mod vgraph_project {',
    ...crate.modules.map((m) => `    pub mod ${m};`),
    '}',
    `pub use vgraph_project::{${crate.modules.join(', ')}};`
  ];
}

// The Cargo project Run builds around generated modules.
export function rustRunProject(modules: { name: string; path: string }[], entry: { module: string; className: string; mainMethod?: string }, crate?: { src: string; modules: string[]; name?: string }): Record<string, string> {
  const slash = (p: string) => p.replace(/\\/g, '/');
  return {
    'Cargo.toml': ['# Built by Blueprint Visual Scripting to run generated Rust. Safe to delete.', '[package]', 'name = "blueprint_run"', 'version = "0.1.0"', 'edition = "2021"', '', '[[bin]]', 'name = "blueprint_run"', 'path = "main.rs"', '', '[workspace]', ''].join('\n'),
    [`${RUST_RUNTIME_MODULE}.rs`]: RUST_RUNTIME,
    'main.rs': [
      '// Runs a generated class: start, then Main with the arguments, then the latent actions; with',
      '// --test first, each test (given as name and method) on a new object.',
      '#![allow(unused)]',
      `mod ${RUST_RUNTIME_MODULE};`,
      ...modules.map((m) => `#[path = "${slash(m.path)}"]\nmod ${m.name};`),
      ...projectModules(crate),
      '',
      'fn main() {',
      '    let args: Vec<String> = std::env::args().skip(1).collect();',
      '    if args.first().map(|a| a.as_str()) == Some("--test") {',
      '        std::panic::set_hook(Box::new(|_| {}));',
      '        let mut failed = 0;',
      '        let mut i = 1;',
      '        while i + 1 < args.len() {',
      `            let object = ${entry.module}::${entry.className}::new();`,
      '            let method = args[i + 1].clone();',
      '            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| object.run_test(&method))) {',
      '                Ok(()) => println!("PASS {}", args[i]),',
      '                Err(error) => {',
      '                    failed += 1;',
      `                    println!("FAIL {}: {}", args[i], ${RUST_RUNTIME_MODULE}::panic_message(&error));`,
      '                }',
      '            }',
      '            i += 2;',
      '        }',
      '        println!("{}", if failed == 0 { "All tests passed.".to_string() } else { format!("{} test(s) failed.", failed) });',
      '        std::process::exit(if failed == 0 { 0 } else { 1 });',
      '    }',
      `    let object = ${entry.module}::${entry.className}::new();`,
      '    object.start();',
      ...(entry.mainMethod ? [`    object.${entry.mainMethod}(args);`] : []),
      `    ${RUST_RUNTIME_MODULE}::run_latent_actions();`,
      '}',
      ''
    ].join('\n')
  };
}

const moduleOf = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(/\.rs$/, '');

// The program Run's Cargo project builds, in its target folder.
function rustExecutable(context: RunContext | undefined): string {
  return `${context?.scaffoldDir}/target/debug/blueprint_run${context?.platform === 'win32' ? '.exe' : ''}`;
}

const rustRunner: CodeRunner = {
  commands: () => [['cargo']],
  env: { CARGO_TERM_COLOR: 'never' },
  scaffold: (file, className, context) => rustRunProject(
    [file.path, ...(context.sources ?? [])].map((p) => ({ name: moduleOf(p), path: p })),
    { module: moduleOf(file.path), className, mainMethod: context.mainMethod },
    context.crate
  ),
  args: (_file, _className, context) => ['run', '--quiet', '--manifest-path', `${context?.scaffoldDir}/Cargo.toml`, '--', ...(context?.args ?? [])],
  testArgs: (_file, _className, context) => ['run', '--quiet', '--manifest-path', `${context.scaffoldDir}/Cargo.toml`, '--', '--test', ...context.tests.flatMap((t) => [t.name, t.method])],
  missingToolMessage: 'Cargo was not found. Install Rust (rustup.rs) and make sure `cargo` is on the PATH.'
};

export const RUST_BLOCK = { begin: '// vgraph:begin (managed by Blueprint Visual Scripting)', end: '// vgraph:end' };

// Declares generated modules at the crate root (docs/output-placement.md, "Rust"): the extension owns
// src/vgraph_runtime.rs, and a fenced block in lib.rs (or main.rs) declares it and each generated
// file by its path, so generated code's `crate::name_vgraph::` paths resolve as they do under Run.
export function rustPlacement(context: PlacementContext): OutputPlan {
  const crateOf = (file: string): string | undefined => {
    const parts = file.split('/');
    for (let n = parts.length - 1; n >= 0; n--) {
      const dir = parts.slice(0, n).join('/');
      if (context.exists(dir ? `${dir}/Cargo.toml` : 'Cargo.toml')) return dir;
    }
    return undefined;
  };
  const crates = new Map<string, string[]>();
  const outside: string[] = [];
  for (const file of context.generatedFiles) {
    const crate = crateOf(file);
    if (crate === undefined) outside.push(file);
    else crates.set(crate, [...(crates.get(crate) ?? []), file]);
  }
  // A crate whose last graph went away keeps its runtime and a block emptied of modules, so no
  // declaration names a deleted file. Such crates are found at the root and among the workspace's
  // listed members.
  const manifest = context.readFile('Cargo.toml');
  if (manifest !== undefined) {
    const members = /^\s*members\s*=\s*\[([^\]]*)\]/m.exec(manifest)?.[1] ?? '';
    for (const crate of ['', ...[...members.matchAll(/"([^"*?]+)"/g)].map((m) => m[1].replace(/\/+$/, ''))]) {
      if (!crates.has(crate) && context.exists(join(crate, `src/${RUST_RUNTIME_MODULE}.rs`))) crates.set(crate, []);
    }
  }
  const plan: Required<OutputPlan> = { ownedFiles: [], hooks: [], diagnostics: [] };
  if (context.outputFile && outside.includes(context.outputFile)) {
    plan.diagnostics.push({ severity: 'warning', code: 'build-registration', message: `${context.outputFile} isn't in a Cargo crate, so it can't be added to one: move the graph into a crate's folder.` });
  }
  for (const [crate, files] of crates) {
    const root = ['src/lib.rs', 'src/main.rs'].map((f) => join(crate, f)).find((f) => context.exists(f));
    if (!root) {
      plan.diagnostics.push({ severity: 'warning', code: 'build-registration', message: `${join(crate, 'Cargo.toml')}'s crate has no src/lib.rs or src/main.rs, so the generated modules can't be declared: add \`#[path = "…"] pub mod name_vgraph;\` for each to the crate root.` });
      continue;
    }
    const src = join(crate, 'src');
    // rustfmt (`cargo fmt --check`) leaves each module alone, and keeps the declarations as they
    // are: sorted by name, as it would sort them.
    const declarations = new Map<string, string>([[RUST_RUNTIME_MODULE, `#[rustfmt::skip]\npub mod ${RUST_RUNTIME_MODULE};`]]);
    const declared = new Map<string, string>();
    for (const file of files) {
      const module = file.split('/').pop()!.replace(/\.rs$/, '');
      // Each module is declared at the crate root, so two graphs of one name in a crate clash.
      const first = declared.get(module);
      if (first !== undefined) {
        if (context.outputFile === file || context.outputFile === first) {
          plan.diagnostics.push({ severity: 'warning', code: 'build-registration', message: `${first} and ${file} are both module ${module} at the crate root, where generated modules are declared, so only the first is: rename one of the graphs.` });
        }
        continue;
      }
      declared.set(module, file);
      const local = relativePath(src, file);
      declarations.set(module, `${local === `${module}.rs` ? '' : `#[path = "${local}"]\n`}#[rustfmt::skip]\npub mod ${module};`);
    }
    const lines = [...declarations].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, text]) => text);
    plan.ownedFiles.push({ path: join(src, `${RUST_RUNTIME_MODULE}.rs`), text: RUST_RUNTIME });
    plan.hooks.push({
      id: `rust-mod:${root}`,
      file: root,
      description: `Declare the Rust modules generated from graphs in ${root}, so Cargo builds them`,
      // A new block goes after the root's last `mod x;` or `use …;` line, else at the end.
      block: { ...RUST_BLOCK, text: lines.join('\n'), anchor: { after: String.raw`^(pub(\([^)]*\))?\s+)?(mod|use)\s[^{]*;\s*$` } }
    });
  }
  return plan;
}

const join = (dir: string, file: string): string => (dir ? `${dir}/${file}` : file);

// `to` relative to the folder `from`, both relative to the workspace folder with "/" separators.
function relativePath(from: string, to: string): string {
  const a = from.split('/').filter(Boolean);
  const b = to.split('/');
  let common = 0;
  while (common < a.length && common < b.length - 1 && a[common] === b[common]) common++;
  return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/');
}

const rustGenerator: CodeGenerator = {
  libraryExports: rustLibraryExports,
  snippetLanguages: ['rust'],
  importLanguages: ['rust'],
  outputFileName: rustOutputFileName,
  moduleName: (generatedFileName) => generatedFileName.replace(/\.rs$/, ''),
  placement: rustPlacement,
  generate: (program, options) => new RustEmitter(program, options).emit(),
  runner: rustRunner,
  // CodeLLDB runs the program Run's Cargo project builds; on Windows (the MSVC toolchain), the
  // C/C++ extension's Visual Studio debugger does.
  debugger: {
    type: 'lldb',
    extension: { id: 'vadimcn.vscode-lldb', name: 'CodeLLDB' },
    platforms: { win32: { type: 'cppvsdbg', extension: { id: 'ms-vscode.cpptools', name: 'C/C++' } } },
    build: (_file, _className, context) => ['build', '--quiet', '--manifest-path', `${context.scaffoldDir}/Cargo.toml`],
    configuration: (_file, _className, context) => context.platform === 'win32'
      ? { type: 'cppvsdbg', request: 'launch', program: rustExecutable(context), args: context.args ?? [], cwd: context.cwd, stopAtEntry: false, console: 'internalConsole' }
      : { type: 'lldb', request: 'launch', program: rustExecutable(context), args: context.args ?? [], cwd: context.cwd, sourceLanguages: ['rust'], expressions: 'native' }
  }
};

export const rustPack: LanguagePack = {
  id: 'rust',
  displayName: 'Rust',
  generatedFileExtension: '.rs',
  workspaceMarkers: ['**/Cargo.toml'],
  // No inheritance; interfaces (traits) arrive later.
  capabilities: { staticTyping: true, classes: true, inheritance: false, interfaces: false, generics: true, async: true, exceptions: false, containers: ['array', 'set', 'map'], delegates: true },
  mapType,
  terms: LANGUAGE_TERMS.rust,
  requires: { version: '2018', label: 'edition 2018', basis: 'needs' },
  generator: rustGenerator,
  // pub functions marked /// @blueprint, called through their module in the crate.
  importer: { extensions: ['.rs'], scan: scanRust }
};

class RustEmitter {
  private readonly out = new CodeWriter('    ');
  private readonly names: NameScope;
  private readonly fileScope = new NameScope(RESERVED);
  private readonly memberNames = new Map<string, string>();
  private readonly slotNames = new Map<string, string>();
  private readonly helperNames = new Map<string, string>();
  private readonly blockNames = new Map<string, string>();
  private readonly functionNames = new Map<string, string>();
  private readonly dispatcherNames = new Map<string, string>();
  private readonly paramNames = new Map<string, string>();
  // Members, slots and parameters that are variables of the method being written, not fields.
  private readonly locals = new Set<string>();
  private readonly className: string;
  private readonly library: boolean;
  private readonly types: Map<string, UserType>;
  private readonly classNames = new Map<string, ClassMemberNames>();
  private tests: { name: string; method: string }[] = [];
  // The object's methods are called on `self`, and on `this` inside a latent action's closure.
  private receiver = 'self';
  private currentParams: string[] = [];
  private temps = 0;

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions) {
    this.library = !!program.library;
    this.className = new NameScope(RESERVED).claim(program.className, 'pascal');
    this.types = userTypes(program);
    if (program.declaration) this.types.set(program.declaration.type.id, program.declaration.type);
    if (this.library) {
      const exports = rustLibraryExports(program.className, program.functions.map((f) => ({ id: f.id, name: f.name })));
      this.names = new NameScope(RESERVED, [...exports.names.values()]);
      for (const f of program.functions) this.functionNames.set(f.id, exports.names.get(f.id)!);
    } else {
      this.names = classScope();
      const own = claimClassMembers(this.names, programClassSpec(program), CLASS_STYLES);
      this.classNames.set(`object:${program.className}`, own);
      for (const f of program.functions) this.functionNames.set(f.id, (f.event ? own.events : own.functions).get(f.id)!);
      for (const [id, name] of own.variables) this.memberNames.set(id, name);
      for (const [id, name] of own.dispatchers) this.dispatcherNames.set(id, name);
    }
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'keep', '_'));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'snake'));
    for (const h of program.helpers) this.helperNames.set(h.id, this.fileScope.claim(h.name, 'snake'));
  }

  emit(): GeneratedCode {
    const out = this.out;
    out.line(`// Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    // rustfmt (and so `cargo fmt --check`) leaves a file marked @generated alone.
    out.line('// Do not edit (@generated): changes are overwritten when the graph is compiled.');
    out.line(`#![allow(${RUST_ALLOWED_LINTS})]`);
    out.line();
    out.line('use std::cell::RefCell;');
    out.line('use std::rc::{Rc, Weak};');
    out.line(`use crate::${RUST_RUNTIME_MODULE} as vgraph;`);
    out.line(`use crate::${RUST_RUNTIME_MODULE}::Format;`);
    out.line();
    if (this.program.declaration) return this.emitDeclaration();
    if (this.library) {
      for (const fn of this.program.functions) this.functionMethod(fn, true);
      this.helpers();
      out.trimTrailingBlank();
      return this.finish();
    }
    const fields: string[] = [];
    const initial: string[] = [];
    for (const m of this.program.members.filter((x) => !x.function)) {
      fields.push(`pub ${this.memberNames.get(m.id)}: RefCell<${this.typeName(m.type)}>,`);
      initial.push(`${this.memberNames.get(m.id)}: RefCell::new(${this.coerce(m.initial, m.type)}),`);
    }
    for (const d of this.program.dispatchers ?? []) {
      fields.push(`pub ${this.dispatcherNames.get(d.id)}: vgraph::Dispatcher<${this.tupleType(d.params.map((p) => p.type))}>,`);
      initial.push(`${this.dispatcherNames.get(d.id)}: Default::default(),`);
    }
    for (const x of this.program.slots.filter((s) => !s.function)) {
      fields.push(`${this.slotNames.get(x.id)}: RefCell<${this.typeName(x.type)}>,`);
      initial.push(`${this.slotNames.get(x.id)}: RefCell::new(${this.defaultFor(x.type)}),`);
    }
    out.line(`pub struct ${this.className} {`);
    out.indent();
    out.line(`me: Weak<${this.className}>,`);
    for (const f of fields) out.line(f);
    out.dedent();
    out.line('}');
    out.line();
    out.line(`impl ${this.className} {`);
    out.indent();
    out.line(`pub fn new() -> Rc<${this.className}> {`);
    out.indent();
    out.line(`Rc::new_cyclic(|me| ${this.className} {`);
    out.indent();
    out.line('me: me.clone(),');
    for (const line of initial) out.line(line);
    out.dedent();
    out.line('})');
    out.dedent();
    out.line('}');
    out.line();
    out.line('// The object itself, shared (Self as a value, and what latent actions and bound events hold).');
    out.line(`fn me(&self) -> Rc<${this.className}> {`);
    out.line('    self.me.upgrade().expect("the object is gone")');
    out.line('}');
    out.line();
    this.method('pub fn start(&self)', () => this.statements(this.program.start), []);
    for (const fn of this.program.functions) this.functionMethod(fn, false);
    this.tests = (this.program.tests ?? []).map((t) => ({ name: t.name, method: this.names.claim(`test ${t.name}`, 'snake') }));
    this.program.tests?.forEach((t, i) => this.method(`pub fn ${this.tests[i].method}(&self)`, () => this.statements(t.body), []));
    this.method('pub fn run_test(&self, name: &str)', () => {
      for (const test of this.tests) this.out.line(`if name == ${JSON.stringify(test.method)} { self.${test.method}(); vgraph::run_latent_actions(); return; }`);
      this.out.line('panic!("No test named {}", name);');
    }, []);
    for (const block of this.program.blocks) this.method(`fn ${this.blockNames.get(block.id)}(&self)`, () => this.statements(block.body), []);
    out.trimTrailingBlank();
    out.dedent();
    out.line('}');
    out.line();
    this.helpers();
    out.trimTrailingBlank();
    return this.finish();
  }

  private finish(): GeneratedCode {
    const main = this.program.functions.find((f) => f.event?.entry === 'Main');
    return {
      text: this.out.toString(),
      className: this.className,
      nodeLines: this.out.nodeLines,
      codeBreaks: this.out.breaks,
      ...(this.program.imports.some((i) => i.path) ? { importedFiles: [...new Set(this.program.imports.map((i) => i.path).filter(Boolean))].sort() } : {}),
      ...(main ? { mainMethod: this.functionNames.get(main.id) } : {}),
      ...this.pinExpressions(),
      ...(this.tests.length ? { tests: this.tests } : {})
    };
  }

  private pinExpressions(): { pinExpressions?: PinExpression[] } {
    const pins = (this.program.pinValues ?? []).flatMap((p) => {
      const expression = this.debugExpr(p.value);
      return expression ? [{ graphId: p.graphId, nodeId: p.nodeId, pinId: p.pinId, expression }] : [];
    });
    return pins.length ? { pinExpressions: pins } : {};
  }

  // A pin's value as a debugger reads it in a paused method: a field through its RefCell
  // (`self->score.value.value`), a local or parameter by name, a literal as is. Undefined when the
  // debugger can't read it without running code.
  private debugExpr(e: IrExpr): string | undefined {
    switch (e.kind) {
      case 'literal':
        return typeof e.value === 'string' ? JSON.stringify(e.value) : literal(e.value);
      case 'member':
      case 'output': {
        const kind = e.kind === 'member' ? 'member' : 'slot';
        const id = e.kind === 'member' ? e.member : e.slot;
        const name = kind === 'slot' ? this.slotNames.get(id) : this.memberNames.get(id);
        if (!name) return undefined;
        return this.locals.has(`${kind}:${id}`) ? name : `self->${name}.value.value`;
      }
      case 'param':
        return this.paramNames.get(`${e.function}\u0000${e.id}`);
      case 'self':
        return 'self';
      case 'structField': {
        const value = this.debugExpr(e.value);
        const type = this.types.get(e.type);
        return value && `${value}.${type?.kind === 'struct' ? rustFieldNames(type).get(e.field) : e.field}`;
      }
      default:
        return undefined;
    }
  }

  // A struct (a value, copied on assignment as in Unreal), an enum, or an interface (a trait).
  private emitDeclaration(): GeneratedCode {
    const out = this.out;
    const declaration = this.program.declaration!;
    const name = this.className;
    if (declaration.kind === 'interface') {
      out.line(`pub trait ${name} {}`);
      return this.finish();
    }
    if (declaration.kind === 'enum') {
      const members = rustEnumMembers(declaration.type);
      out.line('#[derive(Clone, Copy, Debug, PartialEq, PartialOrd, Default)]');
      out.line(`pub enum ${name} {`);
      declaration.type.enumerators.forEach((e, i) => out.line(`    ${i === 0 ? '#[default] ' : ''}${members.get(e.id)},`));
      out.line('}');
      out.line();
      out.line(`impl vgraph::Format for ${name} {`);
      out.line('    fn text(&self) -> String {');
      out.line('        match self {');
      for (const e of declaration.type.enumerators) out.line(`            ${name}::${members.get(e.id)} => ${rustString(e.name)}.to_string(),`);
      out.line('        }');
      out.line('    }');
      out.line('    fn json(&self) -> String { vgraph::json_string(&self.text()) }');
      out.line('}');
      return this.finish();
    }
    const type = declaration.type;
    const fields = rustFieldNames(type);
    out.line('#[derive(Clone, Debug, PartialEq, PartialOrd)]');
    out.line(`pub struct ${name} {`);
    for (const f of type.fields) out.line(`    pub ${fields.get(f.id)}: ${this.typeName(f.type)},`);
    out.line('}');
    out.line();
    out.line(`impl Default for ${name} {`);
    out.line(`    fn default() -> Self {`);
    out.line(`        ${name} { ${type.fields.map((f, i) => `${fields.get(f.id)}: ${this.coerce(declaration.initial[i], f.type)}`).join(', ')} }`);
    out.line('    }');
    out.line('}');
    out.line();
    // As Print shows it: each field by name, in order.
    out.line(`impl vgraph::Format for ${name} {`);
    out.line('    fn text(&self) -> String { self.json() }');
    out.line('    fn json(&self) -> String {');
    out.line(`        let fields: Vec<String> = vec![${type.fields.map((f) => `format!("{}:{}", vgraph::json_string(${rustString(f.name)}), self.${fields.get(f.id)}.json())`).join(', ')}];`);
    out.line('        format!("{{{}}}", fields.join(","))');
    out.line('    }');
    out.line('}');
    return this.finish();
  }

  // ---- Methods ------------------------------------------------------------------------------

  private method(signature: string, body: () => void, params: string[]): void {
    this.out.endNode();
    this.out.line(`${signature} {`);
    this.out.indent();
    const previous = this.currentParams;
    this.currentParams = params;
    body();
    this.currentParams = previous;
    this.out.dedent();
    this.out.line('}');
    this.out.line();
  }

  // A function graph as a method (a free function in a library): its locals and its nodes' outputs
  // are variables of each call.
  private functionMethod(fn: IrFunction, free: boolean): void {
    const scope = new NameScope(RESERVED);
    const params = fn.params.map((p) => {
      const name = scope.claim(p.name, 'snake');
      this.paramNames.set(`${fn.id}\u0000${p.id}`, name);
      this.locals.add(`param:${fn.id}\u0000${p.id}`);
      return { name, type: p.type };
    });
    const locals = this.program.members.filter((m) => m.function === fn.id);
    for (const m of locals) {
      this.memberNames.set(m.id, scope.claim(m.name, 'snake'));
      this.locals.add(`member:${m.id}`);
    }
    const slots = this.program.slots.filter((x) => x.function === fn.id);
    for (const x of slots) {
      this.slotNames.set(x.id, scope.claim(x.name, 'keep', '_'));
      this.locals.add(`slot:${x.id}`);
    }
    const returns = fn.outputs.length ? ` -> ${this.tupleOrType(fn.outputs.map((o) => o.type))}` : '';
    const name = this.functionNames.get(fn.id)!;
    const list = params.map((p) => `mut ${p.name}: ${this.typeName(p.type)}`).join(', ');
    const access = this.library || fn.access !== 'private' ? 'pub ' : '';
    if (fn.description) this.out.line(`/// ${fn.description.replace(/\s+/g, ' ')}`);
    this.method(`${access}fn ${name}(${free ? '' : '&self'}${!free && list ? ', ' : ''}${list})${returns}`, () => {
      for (const store of fn.event?.stores ?? []) this.out.line(`vgraph::set(&self.${this.slotNames.get(store.slot)}, ${this.paramNames.get(`${fn.id}\u0000${store.param}`)}.clone());`);
      for (const m of locals) this.out.line(`let mut ${this.memberNames.get(m.id)}: ${this.typeName(m.type)} = ${this.coerce(m.initial, m.type)};`);
      for (const x of slots) this.out.line(`let mut ${this.slotNames.get(x.id)}: ${this.typeName(x.type)} = ${this.defaultFor(x.type)};`);
      this.statements(fn.body);
      // Only where it can be reached (a Branch whose sides both return can't complete).
      if (fn.outputs.length && canComplete(fn.body)) this.out.line(`return ${this.tuple(fn.outputs.map((o) => this.defaultFor(o.type)))};`);
    }, params.map((p) => p.name));
  }

  // Code nodes' snippets as free functions; containers come by mutable reference, so a node changes
  // the container it was given, as in the other languages.
  private helpers(): void {
    for (const helper of this.program.helpers) this.helperFunction(helper);
  }

  private helperFunction(helper: IrCodeHelper): void {
    const scope = new NameScope(RESERVED);
    const params = helper.params.map((p, i) => ({
      pinId: p.pinId,
      name: /^[A-Za-z_]\w*$/.test(p.pinId) && !RESERVED.has(p.pinId) ? scope.claim(p.pinId) : scope.claim(`pin${i}`),
      type: p.type
    }));
    const byPin = new Map(params.map((p) => [p.pinId, p.name]));
    const code = helper.code.replace(/\$\{([^}]+)\}/g, (_m, pin: string) => byPin.get(pin) ?? pin);
    const list = params.map((p) => `${p.type?.container ? '' : 'mut '}${p.name}: ${p.type?.container ? `&mut ${this.typeName(p.type)}` : this.typeName(p.type)}`).join(', ');
    this.out.endNode();
    this.out.line(`fn ${this.helperNames.get(helper.id)}(${list})${helper.returns ? ` -> ${this.typeName(helper.returns)}` : ''} {`);
    this.out.indent();
    for (const line of dedent(code)) this.out.line(line);
    this.out.dedent();
    this.out.line('}');
    this.out.line();
  }

  // ---- Statements ---------------------------------------------------------------------------

  private statements(statements: IrStatement[]): void {
    for (const s of statements) this.statement(s);
  }

  private block(statements: IrStatement[]): void {
    this.out.indent();
    this.statements(statements);
    this.out.dedent();
  }

  // Writes a slot or member: a field through vgraph::set, a local by assignment.
  private assign(kind: 'slot' | 'member', id: string, value: string): string {
    const name = kind === 'slot' ? this.slotNames.get(id)! : this.memberNames.get(id)!;
    return this.locals.has(`${kind}:${id}`) ? `${name} = ${value};` : `vgraph::set(&${this.receiver}.${name}, ${value});`;
  }

  private read(kind: 'slot' | 'member', id: string): string {
    const name = kind === 'slot' ? this.slotNames.get(id)! : this.memberNames.get(id)!;
    return this.locals.has(`${kind}:${id}`) ? `${name}.clone()` : `vgraph::get(&${this.receiver}.${name})`;
  }

  private statement(s: IrStatement): void {
    const { out } = this;
    if (s.kind === 'callBlock') out.endNode();
    else out.node(s.source, (text) => `// ${text}`);
    switch (s.kind) {
      case 'print':
        out.line(`println!("{}", ${this.text(s.value)});`);
        break;
      case 'assert':
        out.line(`if !(${this.expr(s.condition)}) { panic!("{}", ${this.expr(s.message)}); }`);
        break;
      case 'store': {
        const slot = this.program.slots.find((x) => x.id === s.slot);
        out.line(this.assign('slot', s.slot, this.coerce(s.value, slot?.type)));
        break;
      }
      case 'setMember': {
        const member = this.program.members.find((m) => m.id === s.member);
        out.line(this.assign('member', s.member, this.coerce(s.value, member?.type)));
        break;
      }
      case 'if': {
        out.line(`if ${this.expr(s.condition)} {`);
        this.block(s.then);
        let rest = s.else;
        while (rest.length === 1 && rest[0].kind === 'if' && sameSource(rest[0], s)) {
          const inner: Extract<IrStatement, { kind: 'if' }> = rest[0];
          out.line(`} else if ${this.expr(inner.condition)} {`);
          this.block(inner.then);
          rest = inner.else;
        }
        if (rest.length) {
          out.line('} else {');
          this.block(rest);
        }
        out.line('}');
        break;
      }
      case 'for': {
        const stop = s.stop ? ` && !${this.read('slot', s.stop)}` : '';
        out.line(this.assign('slot', s.counter, this.coerce(s.first, INT)));
        out.line(`while ${this.read('slot', s.counter)} <= ${this.coerce(s.last, INT)}${stop} {`);
        this.block(s.body);
        out.line(`    ${this.assign('slot', s.counter, `${this.read('slot', s.counter)} + 1`)}`);
        out.line('}');
        break;
      }
      case 'while':
        out.line(`while ${this.expr(s.condition)} {`);
        this.block(s.body);
        out.line('}');
        break;
      case 'forEach': {
        // The array is read before each pass, as Unreal's For Each Loop reads it.
        const element = this.program.slots.find((x) => x.id === s.element);
        const array = this.coerce(s.array, element?.type ? { ...element.type, container: 'array' } : undefined);
        const index = this.read('slot', s.index);
        const stop = s.stop ? ` && !${this.read('slot', s.stop)}` : '';
        out.line(this.assign('slot', s.index, '0'));
        out.line(`while ${index} < (${array}).len() as i64${stop} {`);
        out.indent();
        out.line(this.assign('slot', s.element, `(${array})[${index} as usize].clone()`));
        this.statements(s.body);
        out.line(this.assign('slot', s.index, `${index} + 1`));
        out.dedent();
        out.line('}');
        break;
      }
      case 'call': {
        const call = this.call(s.callee, s.args);
        if (s.results) {
          this.destructure(call, s.results.map((r) => r.slot));
          break;
        }
        if (!s.resultSlot) {
          out.line(`${call};`);
          break;
        }
        const slot = this.program.slots.find((x) => x.id === s.resultSlot);
        out.line(this.assign('slot', s.resultSlot, this.cast(call, calleeSignature(s.callee, this.program)?.returns, slot?.type)));
        break;
      }
      case 'callBlock':
        out.line(`${this.receiver}.${this.blockNames.get(s.block)}();`);
        break;
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === s.function)!;
        const call = this.functionCall(fn, s.args);
        if (!s.results.length) out.line(`${call};`);
        else if (fn.outputs.length === 1) out.line(this.assign('slot', s.results[0].slot, call));
        else this.destructure(call, fn.outputs.map((o) => s.results.find((r) => r.output === o.id)?.slot));
        break;
      }
      case 'bindEvent': {
        const fn = this.program.functions.find((f) => f.id === s.event);
        const params = fn?.params ?? [];
        const args = params.map((_, i) => `args.${i}`).join(', ');
        if (s.bind) {
          out.line('{');
          out.indent();
          out.line(`let me = Rc::downgrade(&${this.receiver}.me());`);
          out.line(`${this.dispatcherRef(s)}.bind(Rc::as_ptr(&${this.receiver}.me()) as usize, ${JSON.stringify(s.event)}, Rc::new(move |args: ${this.tupleType(params.map((p) => p.type))}| {`);
          out.line(`    if let Some(this) = me.upgrade() { this.${this.functionNames.get(s.event)}(${args}); }`);
          out.line('}));');
          out.dedent();
          out.line('}');
        } else out.line(`${this.dispatcherRef(s)}.unbind(Rc::as_ptr(&${this.receiver}.me()) as usize, ${JSON.stringify(s.event)});`);
        break;
      }
      case 'unbindAll':
        out.line(`${this.dispatcherRef(s)}.clear();`);
        break;
      case 'broadcast': {
        const other = s.target && s.type ? classInfo(this.program, s.type)?.dispatchers.find((d) => d.id === s.dispatcher)?.inputs.filter((p) => p.kind === 'data') : undefined;
        const params = other ?? this.program.dispatchers?.find((d) => d.id === s.dispatcher)?.params ?? [];
        out.line(`${this.dispatcherRef(s)}.broadcast(${this.tuple(s.args.map((a, i) => this.coerce(a, params[i]?.type)), true)});`);
        break;
      }
      case 'await': {
        // An async function (docs/node-authoring.md, gap 4): Completed runs with its future's value
        // when the latent queue's executor finds it finished.
        const call = this.call(s.callee, s.args);
        out.line('{');
        out.indent();
        // The closure keeps its own copies of the event's inputs.
        for (const p of this.currentParams) out.line(`let ${p} = ${p}.clone();`);
        out.line(`let this = ${this.receiver}.me();`);
        out.line(`vgraph::await_latent(${call}, Box::new(move |value| {`);
        out.indent();
        const receiver = this.receiver;
        this.receiver = 'this';
        if (s.resultSlot) out.line(this.assign('slot', s.resultSlot, 'value'));
        else out.line('let _ = value;');
        this.statements(s.then);
        this.receiver = receiver;
        out.dedent();
        out.line('}));');
        out.dedent();
        out.line('}');
        break;
      }
      case 'delay': {
        const seconds = this.coerce(s.duration, FLOAT);
        out.line('{');
        out.indent();
        // The closure keeps its own copies of the event's inputs.
        for (const p of this.currentParams) out.line(`let ${p} = ${p}.clone();`);
        if (s.generation) {
          // Retriggerable: only the latest start's countdown runs Completed.
          const generation = this.slotNames.get(s.generation)!;
          out.line(`let started = vgraph::get(&${this.receiver}.${generation}) + 1;`);
          out.line(`vgraph::set(&${this.receiver}.${generation}, started);`);
          out.line(`let this = ${this.receiver}.me();`);
          out.line(`vgraph::delay(${seconds}, Box::new(move || {`);
          out.indent();
          out.line(`if started != vgraph::get(&this.${generation}) { return; }`);
        } else {
          // Delay: started again while counting down, it does nothing.
          const pending = this.slotNames.get(s.pending!)!;
          out.line(`let this = ${this.receiver}.me();`);
          out.line(`if !vgraph::get(&this.${pending}) {`);
          out.indent();
          out.line(`vgraph::set(&this.${pending}, true);`);
          out.line(`vgraph::delay(${seconds}, Box::new(move || {`);
          out.indent();
          out.line(`vgraph::set(&this.${pending}, false);`);
        }
        const receiver = this.receiver;
        this.receiver = 'this';
        this.statements(s.then);
        this.receiver = receiver;
        out.dedent();
        out.line('}));');
        if (!s.generation) {
          out.dedent();
          out.line('}');
        }
        out.dedent();
        out.line('}');
        break;
      }
      case 'construct': {
        const type = this.userTypeName(s.type);
        out.line(this.assign('slot', s.slot, `Some(${type}::new())`));
        out.line(`vgraph::deref(${this.read('slot', s.slot)}).start();`);
        break;
      }
      case 'setObjectVariable':
        out.line(`vgraph::set(&${this.targetRef(s.target)}.${this.membersOf(s.type)?.variables.get(s.variable)}, ${this.coerce(s.value, classInfo(this.program, s.type)?.variables.find((v) => v.id === s.variable)?.type)});`);
        break;
      case 'objectCall': {
        const info = classInfo(this.program, s.type);
        const names = this.membersOf(s.type);
        const fn = s.function !== undefined ? info?.functions.find((f) => f.id === s.function) : undefined;
        const params = (fn ? fn.inputs : info?.events.find((e) => e.id === s.event)?.inputs ?? []).filter((p) => p.kind === 'data');
        const name = s.function !== undefined ? names?.functions.get(s.function) : names?.events.get(s.event!);
        const call = `${this.targetRef(s.target)}.${name}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        const outputs = fn?.outputs.filter((p) => p.kind === 'data').length ?? 0;
        if (!s.results.length) out.line(`${call};`);
        else if (outputs === 1) out.line(this.assign('slot', s.results[0].slot, call));
        else this.destructure(call, s.results.map((r) => r.slot));
        break;
      }
      case 'return': {
        const fn = this.program.functions.find((f) => f.id === s.source.graphId);
        if (!fn || !fn.outputs.length) out.line('return;');
        else out.line(`return ${this.tuple(fn.outputs.map((o, i) => this.coerce(s.values[i] ?? { kind: 'default', type: o.type }, o.type)))};`);
        break;
      }
      case 'cast':
      case 'interfaceCall':
      case 'parentCall':
        // Rust has neither inheritance nor (yet) interfaces: the compiler reports these as unsupported.
        out.line('unreachable!("unsupported in Rust");');
        break;
    }
  }

  // A call returning several outputs, each into its slot.
  private destructure(call: string, slots: (string | undefined)[]): void {
    const temp = `results${++this.temps}`;
    this.out.line('{');
    this.out.indent();
    this.out.line(`let ${temp} = ${call};`);
    slots.forEach((slot, i) => {
      if (slot) this.out.line(this.assign('slot', slot, `${temp}.${i}`));
    });
    this.out.dedent();
    this.out.line('}');
  }

  // ---- Expressions --------------------------------------------------------------------------

  private expr(e: IrExpr): string {
    switch (e.kind) {
      case 'literal':
        return literal(e.value);
      case 'default':
        return this.defaultFor(e.type);
      case 'member':
        return this.read('member', e.member);
      case 'output':
        return this.read('slot', e.slot);
      case 'add':
        return `${this.operand(e.left)} + ${this.operand(e.right)}`;
      case 'toNumber': {
        const type = this.typeOf(e.value);
        if (isNumeric(type)) return type?.id === 'int' ? `(${this.expr(e.value)} as f64)` : this.expr(e.value);
        return `vgraph::to_number(&(${this.expr(e.value)}))`;
      }
      case 'toText':
        return this.text(e.value);
      case 'concat':
        return `format!("${e.parts.map(() => '{}').join('')}", ${e.parts.map((p) => this.expr(p)).join(', ')})`;
      case 'toBoolean': {
        const type = this.typeOf(e.value);
        if (type?.id === 'bool' && !type.container) return this.expr(e.value);
        return `vgraph::to_boolean(&(${this.expr(e.value)}))`;
      }
      case 'call': {
        const call = this.call(e.callee, e.args);
        if (!e.output) return call;
        const imported = this.program.imports.find((i) => i.id === e.callee.id);
        return `(${call}).${(imported?.outputs ?? []).findIndex((o) => o.id === e.output)}`;
      }
      case 'binary': {
        const type = e.op === '&&' || e.op === '||' ? BOOL : this.binaryType(e.left, e.right);
        const side = (x: IrExpr) => (type ? this.cast(this.operand(x), this.typeOf(x), type, x.kind === 'literal') : this.operand(x));
        if ((e.op === '==' || e.op === '!=') && type && (type.id.startsWith('object:') || type.id.startsWith('interface:')) && !type.container) {
          return `${e.op === '!=' ? '!' : ''}vgraph::same(&${side(e.left)}, &${side(e.right)})`;
        }
        return `${side(e.left)} ${e.op} ${side(e.right)}`;
      }
      case 'not':
        return `!${this.operand(e.value)}`;
      case 'param': {
        const name = this.paramNames.get(`${e.function}\u0000${e.id}`);
        return name ? `${name}.clone()` : 'vgraph::Value::None';
      }
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(fn, e.args);
        return fn.outputs.length === 1 ? call : `(${call}).${fn.outputs.findIndex((o) => o.id === e.output)}`;
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return 'vgraph::Value::None';
        const fields = rustFieldNames(type);
        return `${this.userTypeName(type.id)} { ${type.fields.map((f, i) => `${fields.get(f.id)}: ${this.coerce(e.fields[i], f.type)}`).join(', ')} }`;
      }
      case 'structField': {
        const type = this.types.get(e.type);
        return `${this.operand(e.value)}.${type?.kind === 'struct' ? rustFieldNames(type).get(e.field) : e.field}`;
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        return `${this.userTypeName(e.type)}::${type?.kind === 'enum' ? rustEnumMembers(type).get(e.value) : e.value}`;
      }
      case 'self':
        return `Some(${this.receiver}.me())`;
      case 'isValid': {
        const type = this.typeOf(e.value);
        return type && (type.id.startsWith('object:') || type.id.startsWith('interface:')) ? `vgraph::is_valid(&${this.operand(e.value)})` : `(${this.expr(e.value)} != vgraph::Value::None)`;
      }
      case 'objectVariable':
        return `vgraph::get(&${this.targetRef(e.target)}.${this.membersOf(e.type)?.variables.get(e.variable)})`;
      case 'objectCall': {
        const fn = classInfo(this.program, e.type)?.functions.find((f) => f.id === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}.${this.membersOf(e.type)?.functions.get(e.function)}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return e.output ? `(${call}).${(fn?.outputs.filter((p) => p.kind === 'data') ?? []).findIndex((o) => o.id === e.output)}` : call;
      }
      case 'makeContainer': {
        const element = { id: e.type.id };
        if (e.type.container === 'map') {
          const pairs: string[] = [];
          for (let i = 0; i + 1 < e.items.length; i += 2) pairs.push(`(${this.coerce(e.items[i], element)}, ${this.coerce(e.items[i + 1], e.type.valueType)})`);
          return `vgraph::Map::from(vec![${pairs.join(', ')}])`;
        }
        return this.list(e.type, e.items.map((item) => this.coerce(item, element)));
      }
      case 'interfaceCall':
      case 'parentCall':
        return 'unreachable!("unsupported in Rust")';
    }
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' || e.kind === 'not' ? `(${text})` : text;
  }

  // Both sides of a comparison in one type: a float if either side is a number with a fraction.
  private binaryType(left: IrExpr, right: IrExpr): TypeRef | undefined {
    const a = this.typeOf(left);
    const b = this.typeOf(right);
    if (isNumeric(a) && isNumeric(b) && (a!.id === 'float' || b!.id === 'float')) return FLOAT;
    return a ?? b;
  }

  private functionCall(fn: IrFunction, args: IrExpr[]): string {
    const list = args.map((a, i) => this.coerce(a, fn.params[i]?.type)).join(', ');
    return this.library ? `${this.functionNames.get(fn.id)}(${list})` : `${this.receiver}.${this.functionNames.get(fn.id)}(${list})`;
  }

  // A code node or project function call. The other arguments are read first, then a container
  // argument is borrowed for the call alone (a field's for as long as the call runs).
  private call(callee: IrCallee, args: IrExpr[]): string {
    const signature = calleeSignature(callee, this.program);
    const name = callee.kind === 'helper' ? this.helperNames.get(callee.id)! : this.importName(callee.id);
    const imported = callee.kind === 'import' ? this.program.imports.find((i) => i.id === callee.id) : undefined;
    const lets: string[] = [];
    const list = args.map((a, i) => {
      const type = signature?.params[i]?.type;
      if (callee.kind === 'helper' && type?.container) {
        if (a.kind === 'member' || a.kind === 'output') {
          const kind = a.kind === 'member' ? 'member' : 'slot';
          const id = a.kind === 'member' ? a.member : a.slot;
          const fieldName = kind === 'slot' ? this.slotNames.get(id)! : this.memberNames.get(id)!;
          return this.locals.has(`${kind}:${id}`) ? `&mut ${fieldName}` : `&mut *${this.receiver}.${fieldName}.borrow_mut()`;
        }
        const temp = `container${++this.temps}`;
        lets.push(`let mut ${temp} = ${this.coerce(a, type)};`);
        return `&mut ${temp}`;
      }
      const temp = `arg${++this.temps}`;
      lets.push(`let ${temp} = ${this.coerce(a, type)};`);
      // A parameter taken by shared reference (&str, &[T]) gets a borrow, which derefs to it.
      return imported?.params[i]?.borrowed ? `&${temp}` : temp;
    });
    const member = imported?.member;
    if (!member) return `{ ${lets.join(' ')} ${name}(${list.join(', ')}) }`;
    // A code class's member (docs/node-authoring.md, gap 2): its objects travel as values holding
    // the object (vgraph::code_new), borrowed for each use (vgraph::code_object).
    if (member.kind === 'construct') return `{ ${lets.join(' ')} vgraph::code_new(${name}::${member.name ?? 'new'}(${list.join(', ')})) }`;
    const [target, ...rest] = list;
    const object = `vgraph::code_object::<${name}>(&${target})`;
    if (member.kind === 'get') return `{ ${lets.join(' ')} let value = ${object}.borrow().${member.name}.clone(); value }`;
    if (member.kind === 'set') return `{ ${lets.join(' ')} ${object}.borrow_mut().${member.name} = ${rest[0]}; }`;
    return `{ ${lets.join(' ')} let result = ${object}.borrow_mut().${member.name}(${rest.join(', ')}); result }`;
  }

  // A function from the project's code or a library graph, through its module in the crate.
  private importName(id: string): string {
    const imported = this.program.imports.find((i) => i.id === id)!;
    return `${this.modulePath(imported.module ?? '')}::${imported.name}`;
  }

  // The value as text, per docs/semantics.md ("Values").
  private text(e: IrExpr): string {
    const type = this.typeOf(e);
    if (type?.id === 'string' && !type.container) return this.expr(e);
    return `vgraph::text(&(${this.expr(e)}))`;
  }

  private coerce(e: IrExpr, target: TypeRef | undefined): string {
    if (e.kind === 'literal' && target?.container && Array.isArray(e.value)) {
      const element = (v: unknown, t: TypeRef | undefined) => this.cast(literal(v), literalTypeOf(v), t, true);
      if (target.container === 'map') {
        const pairs = e.value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2);
        return `vgraph::Map::from(vec![${pairs.map(([k, v]) => `(${element(k, { id: target.id })}, ${element(v, target.valueType)})`).join(', ')}])`;
      }
      return this.list(target, e.value.map((v) => element(v, { id: target.id })));
    }
    return this.cast(this.expr(e), this.typeOf(e), target, e.kind === 'literal');
  }

  // An array or set of these items; an empty one names its type.
  private list(type: TypeRef, items: string[]): string {
    const element = this.typeName({ id: type.id });
    if (type.container === 'set') return items.length ? `vgraph::Set::from(vec![${items.join(', ')}])` : `vgraph::Set::<${element}>::new()`;
    return items.length ? `vec![${items.join(', ')}]` : `Vec::<${element}>::new()`;
  }

  private cast(text: string, from: TypeRef | undefined, target: TypeRef | undefined, isLiteral = false): string {
    if (!target) return text;
    const anyTarget = target.id === 'any' || target.id.startsWith('wildcard') || parseTypeId(target.id).category === 'native';
    if (anyTarget && !target.container) {
      if (!from || from.id === 'any' || from.container) return text;
      return `vgraph::Value::from(${text})`;
    }
    if (sameType(from, target)) return text;
    if (from && !from.container && !target.container) {
      if (from.id === 'int' && target.id === 'float') return isLiteral && /^-?\d+$/.test(text) ? `${text}.0` : `(${text} as f64)`;
      if (from.id === 'float' && target.id === 'int') return isLiteral && /^-?\d+$/.test(text) ? text : `(${text} as i64)`;
      if (from.id === target.id) return text;
    }
    if (isLiteral && text === 'None') return this.defaultFor(target);
    if (!from && !target.container) return `vgraph::from_value::<${this.typeName(target)}>(${text})`;
    return text;
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (!type) return 'vgraph::Value::None';
    if (type.container === 'array') return 'Vec::new()';
    if (type.container === 'set') return 'vgraph::Set::new()';
    if (type.container === 'map') return 'vgraph::Map::new()';
    const user = this.types.get(type.id);
    if (user?.kind === 'struct' || user?.kind === 'enum') return `${this.userTypeName(user.id)}::default()`;
    switch (type.id) {
      case 'bool':
        return 'false';
      case 'int':
        return '0';
      case 'float':
        return '0.0';
      case 'string':
        return 'String::new()';
      default:
        return type.id.startsWith('object:') || type.id.startsWith('interface:') ? 'None' : 'vgraph::Value::None';
    }
  }

  private membersOf(id: string): ClassMemberNames | undefined {
    const existing = this.classNames.get(id);
    if (existing) return existing;
    const info: ClassInfo | undefined = classInfo(this.program, id);
    if (!info) return undefined;
    const names = claimClassMembers(classScope(), info, CLASS_STYLES);
    this.classNames.set(id, names);
    return names;
  }

  // An object member is reached through its object, which isn't None.
  private targetRef(e: IrExpr): string {
    return e.kind === 'self' ? this.receiver : `vgraph::deref(${this.expr(e)})`;
  }

  private dispatcherRef(s: { dispatcher: string; target?: IrExpr; type?: string }): string {
    if (s.target && s.type) return `${this.targetRef(s.target)}.${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}`;
    return `${this.receiver}.${this.dispatcherNames.get(s.dispatcher)}`;
  }

  // A struct, enum or class: its own name in its file, else its module's.
  private userTypeName(id: string): string {
    if (this.program.declaration?.type.id === id || id === `object:${this.program.className}`) return this.className;
    const imported = this.program.imports.find((i) => i.id === id);
    if (!imported) return 'vgraph::Value';
    return imported.module ? `${this.modulePath(imported.module)}::${imported.name}` : imported.name;
  }

  // A module of the project's code or of another graph: in the generated file's own crate through
  // `crate::`, in another crate of the workspace by its name (GenerateOptions.crate, which names
  // modules with their crate). Without a crate, modules are of this one.
  private modulePath(module: string): string {
    const own = this.options.crate;
    if (!own) return module ? `crate::${module}` : 'crate';
    if (module === own) return 'crate';
    return module.startsWith(`${own}::`) ? `crate::${module.slice(own.length + 2)}` : module;
  }

  private mapType(type: TypeRef): string {
    if (!isUserTypeId(type.id) && !(type.valueType && isUserTypeId(type.valueType.id))) return mapType(type);
    const userElement = (t: TypeRef) => {
      if (!isUserTypeId(t.id)) return mapType({ id: t.id });
      const name = this.userTypeName(t.id);
      return t.id.startsWith('object:') ? `Option<Rc<${name}>>` : t.id.startsWith('interface:') ? `Option<Rc<dyn ${name}>>` : name;
    };
    const element = userElement(type);
    const value = type.valueType ? this.mapType(type.valueType) : 'vgraph::Value';
    if (type.container === 'array') return `Vec<${element}>`;
    if (type.container === 'set') return `vgraph::Set<${element}>`;
    if (type.container === 'map') return `vgraph::Map<${element}, ${value}>`;
    return element;
  }

  private typeName(type: TypeRef | undefined): string {
    return this.mapType(type ?? { id: 'any' });
  }

  // Several values: a tuple (with a trailing comma for one, when `always`).
  private tuple(values: string[], always = false): string {
    if (values.length === 1 && !always) return values[0];
    return `(${values.join(', ')}${values.length === 1 ? ',' : ''})`;
  }

  private tupleType(types: (TypeRef | undefined)[]): string {
    return `(${types.map((t) => this.typeName(t)).join(', ')}${types.length === 1 ? ',' : ''})`;
  }

  private tupleOrType(types: (TypeRef | undefined)[]): string {
    return types.length === 1 ? this.typeName(types[0]) : `(${types.map((t) => this.typeName(t)).join(', ')})`;
  }

  private typeOf(e: IrExpr): TypeRef | undefined {
    const type = exprType(e, this.program);
    return type?.id === 'any' ? undefined : type;
  }
}

function literalTypeOf(value: unknown): TypeRef | undefined {
  if (typeof value === 'number') return { id: Number.isInteger(value) ? 'int' : 'float' };
  if (typeof value === 'string') return { id: 'string' };
  if (typeof value === 'boolean') return { id: 'bool' };
  return undefined;
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'f64::NAN';
    if (!Number.isFinite(value)) return value > 0 ? 'f64::INFINITY' : 'f64::NEG_INFINITY';
    return String(value);
  }
  if (typeof value === 'string') return `String::from(${rustString(value)})`;
  return 'None';
}

// A Rust string literal.
function rustString(text: string): string {
  let body = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') body += '\\\\';
    else if (ch === '"') body += '\\"';
    else if (ch === '\n') body += '\\n';
    else if (ch === '\r') body += '\\r';
    else if (ch === '\t') body += '\\t';
    else if (code < 0x20) body += `\\u{${code.toString(16)}}`;
    else body += ch;
  }
  return `"${body}"`;
}

const INT: TypeRef = { id: 'int' };
const FLOAT: TypeRef = { id: 'float' };
const BOOL: TypeRef = { id: 'bool' };

function sameSource(a: IrStatement, b: IrStatement): boolean {
  return a.kind !== 'callBlock' && b.kind !== 'callBlock' && a.source.graphId === b.source.graphId && a.source.nodeId === b.source.nodeId;
}

function isNumeric(type: TypeRef | undefined): boolean {
  return !!type && !type.container && (type.id === 'int' || type.id === 'float');
}

function sameType(a: TypeRef | undefined, b: TypeRef | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

