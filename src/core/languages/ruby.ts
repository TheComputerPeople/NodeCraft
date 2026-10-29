// Ruby pack (docs/more-languages.md, "Ruby"): generates a Ruby file (one class per graph) from Visual
// IR. Files require each other with require_relative, and the support file (ruby-runtime.ts) is a
// companion: a copy goes next to every generated file.
import { IrBlock, IrCallee, IrCodeHelper, IrExpr, IrFunction, IrImport, IrProgram, IrStatement, classInfo, exprType, interfaceInfo, programClassSpec, userTypes } from '../compiler/ir';
import { relativeSpecifier } from '../compiler/module-paths';
import { ClassMemberNames, ClassMemberStyles, InheritedMembers, NameScope, claimClassMembers, dedent, toIdentifier } from '../compiler/names';
import type { ClassInfo, InterfaceInfo } from '../objects';
import { CodeWriter } from '../compiler/writer';
import { CodeDebugger, CodeGenerator, CodeRunner, GenerateOptions, GeneratedCode, LanguagePack, PinExpression, RunContext } from '../language-pack';
import { scanRuby } from '../importing/ruby-scanner';
import { LANGUAGE_TERMS } from '../terms';
import { TypeRef, parseTypeId } from '../types';
import { EnumInfo, StructInfo, UserType } from '../user-types';
import { RUBY_RUNTIME_FILE, rubyRuntime } from './ruby-runtime';

// Ruby's keywords, and Kernel's methods generated names must not hide.
const RESERVED = new Set([
  'BEGIN', 'END', 'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined', 'do', 'else', 'elsif', 'end', 'ensure', 'false',
  'for', 'if', 'in', 'module', 'next', 'nil', 'not', 'or', 'redo', 'rescue', 'retry', 'return', 'self', 'super', 'then', 'true', 'undef',
  'unless', 'until', 'when', 'while', 'yield', '__method__', '__FILE__', '__LINE__', '__ENCODING__', 'puts', 'print', 'p', 'require',
  'require_relative', 'raise', 'loop', 'lambda', 'proc', 'format', 'sleep', 'rand', 'exit', 'warn', 'send', 'method', 'methods', 'class',
  'object_id', 'hash', 'freeze', 'dup', 'clone', 'display', 'initialize', 'new', 'instance_variable_get', 'instance_variable_set',
  'respond_to', 'is_a', 'nil', 'vg_fields', 'then', 'tap', 'catch', 'throw', 'binding', 'caller', 'gets', 'open', 'system', 'spawn',
  'test', 'select', 'trap', 'fork', 'exec', 'abort', 'at_exit', 'autoload', 'eval', 'load', 'block_given', 'iterator', 'srand', 'sprintf',
  'printf', 'putc', 'readline', 'readlines', 'Integer', 'Float', 'String', 'Array', 'Hash', 'Rational', 'Complex'
]);

function mapType(type: TypeRef): string {
  if (type.container === 'array') return 'Array';
  if (type.container === 'set') return 'Set';
  if (type.container === 'map') return 'Hash';
  return ({ bool: 'Boolean', int: 'Integer', float: 'Float', string: 'String' } as Record<string, string>)[type.id] ?? parseTypeId(type.id).name;
}

// Methods and variables are snake_case: a name starting with a capital is a constant in Ruby.
const CLASS_STYLES: ClassMemberStyles = { functions: 'snake', variables: 'snake', dispatchers: 'snake', hiddenPrefix: '_' };

export function rubyFieldNames(type: StructInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, 'snake')]));
}

export function rubyEnumMembers(type: EnumInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.enumerators.map((e) => [e.id, scope.claim(e.name, 'snake').toUpperCase()]));
}

export function rubyExportNames(functions: { id: string; name: string }[]): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(functions.map((f) => [f.id, scope.claim(f.name, 'snake')]));
}

export function rubyOutputFileName(graphFileName: string): string {
  return `${toIdentifier(graphFileName.replace(/\.vgraph$/i, ''), 'snake')}_vgraph.rb`;
}

// A require_relative path from a folder to a workspace-relative file, without its extension.
function requirePath(fromDir: string, to: string): string {
  return relativeSpecifier(fromDir, to).replace(/^\.\//, '').replace(/\.rb$/i, '');
}

// Run's launcher: Start, then Main with the arguments, then the latent actions; with --test first,
// each test (a name and a method) on a new object. Errors print with "Error:" and exit with 1.
function launcher(file: { path: string }, className: string, context: RunContext | undefined): string {
  return [
    '# Built by Blueprint Visual Scripting to run generated Ruby. Safe to delete.',
    '$stdout.sync = true',
    `require ${rubyString(file.path.replace(/\\/g, '/'))}`,
    '',
    'if ARGV.first == "--test"',
    '  failures = 0',
    '  ARGV.drop(1).each_slice(2) do |name, method|',
    '    Vg.reset',
    '    begin',
    `      ${className}.new.send(method)`,
    '      Vg.run_latent_actions',
    '      puts "PASS #{name}"',
    '    rescue StandardError, SystemStackError => e',
    '      failures += 1',
    '      puts "FAIL #{name}: #{e.message}"',
    '    end',
    '  end',
    '  puts(failures.zero? ? "All tests passed." : "#{failures} test(s) failed.")',
    '  exit(failures.zero? ? 0 : 1)',
    'end',
    '',
    'begin',
    `  object = ${className}.new`,
    '  object.start',
    ...(context?.mainMethod ? [`  object.${context.mainMethod}(ARGV.dup)`] : []),
    '  Vg.run_latent_actions',
    'rescue StandardError, SystemStackError => e',
    '  warn "Error: #{e.message}"',
    '  exit 1',
    'end',
    ''
  ].join('\n');
}

const rubyRunner: CodeRunner = {
  commands: () => [['ruby']],
  scaffold: (file, className, context) => ({ 'run.rb': launcher(file, className, context) }),
  args: (_file, _className, context) => [`${context?.scaffoldDir}/run.rb`, ...(context?.args ?? [])],
  testArgs: (_file, _className, context) => [`${context.scaffoldDir}/run.rb`, '--test', ...context.tests.flatMap((t) => [t.name, t.method])],
  missingToolMessage: 'Ruby was not found. Install Ruby 3.3 or later and make sure `ruby` is on the PATH.'
};

// rdbg (the debug gem) through the VSCode rdbg Ruby Debugger, running Run's launcher.
const rubyDebugger: CodeDebugger = {
  type: 'rdbg',
  extension: { id: 'KoichiSasada.vscode-rdbg', name: 'VSCode rdbg Ruby Debugger' },
  configuration: (_file, _className, context) => ({
    type: 'rdbg', request: 'launch', name: 'Debug Graph', script: `${context.scaffoldDir}/run.rb`, args: context.args ?? [], cwd: context.cwd,
    askParameters: false, useBundler: false,
    ...(context.command?.length ? { command: context.command.join(' ') } : {})
  }),
  // rdbg writes a whole Float with a point (30.0); the graph shows 30.
  displayValue: (text) => (/^-?\d+\.0$/.test(text) ? text.slice(0, -2) : text),
  // In rdbg's DAP mode a step from a method's last line (finish, next or step) runs on to the end.
  stepsLeaveFunctions: false
};

const rubyGenerator: CodeGenerator = {
  libraryExports: (_name, functions) => ({ names: rubyExportNames(functions) }),
  snippetLanguages: ['ruby'],
  importLanguages: ['ruby'],
  outputFileName: rubyOutputFileName,
  generate: (program, options) => new RubyEmitter(program, options).emit(),
  runner: rubyRunner,
  debugger: rubyDebugger
};

export const rubyPack: LanguagePack = {
  id: 'ruby',
  displayName: 'Ruby',
  generatedFileExtension: '.rb',
  workspaceMarkers: ['**/Gemfile', '**/*.gemspec'],
  capabilities: { staticTyping: false, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true, containers: ['array', 'set', 'map'], delegates: true },
  mapType,
  terms: LANGUAGE_TERMS.ruby,
  generator: rubyGenerator,
  // Module methods and top-level methods marked @blueprint in YARD comments.
  importer: { extensions: ['.rb'], scan: scanRuby }
};

class RubyEmitter {
  private tests: { name: string; method: string }[] = [];
  private readonly out = new CodeWriter('  ');
  private readonly names: NameScope;
  private readonly library: boolean;
  private readonly className: string;
  private readonly memberNames = new Map<string, string>();
  private readonly slotNames = new Map<string, string>();
  private readonly helperNames = new Map<string, string>();
  private readonly blockNames = new Map<string, string>();
  private readonly functionNames = new Map<string, string>();
  private readonly dispatcherNames = new Map<string, string>();
  private readonly paramNames = new Map<string, string>();
  // An import's constant: its type's, or a project module's; a project function is called on it.
  private readonly importNames = new Map<string, string>();
  private readonly types: Map<string, UserType>;
  private readonly classNames = new Map<string, ClassMemberNames>();

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions) {
    this.library = !!program.library;
    this.className = new NameScope(RESERVED).claim(program.className, 'pascal');
    this.types = userTypes(program);
    if (program.declaration) this.types.set(program.declaration.type.id, program.declaration.type);
    this.names = this.library ? new NameScope(RESERVED) : new NameScope(RESERVED, ['start']);
    const own = claimClassMembers(this.names, programClassSpec(program), CLASS_STYLES, this.inheritedMembers(program.classInfo));
    this.classNames.set(`object:${program.className}`, own);
    for (const f of program.functions) this.functionNames.set(f.id, (f.event ? own.events : own.functions).get(f.id)!);
    for (const [id, name] of own.variables) this.memberNames.set(id, name);
    for (const [id, name] of own.dispatchers) this.dispatcherNames.set(id, name);
    for (const i of program.imports) {
      // A struct, enum or class is its constant; a project function is called on its module or
      // class (the scanner's container), or alone when it's a top-level method.
      if (i.userType) this.importNames.set(i.id, new NameScope(RESERVED).claim(i.userType.name, 'pascal'));
      else this.importNames.set(i.id, i.module ? `${i.module}.${i.name}` : i.name);
    }
    const internal = program.ancestors?.length ? `_${toIdentifier(program.className, 'snake')}_` : '_';
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'snake', internal));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'snake', internal));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(h.name, 'snake', internal));
  }

  emit(): GeneratedCode {
    if (this.program.declaration) return this.emitDeclaration();
    const body = this.out;
    if (this.library) {
      body.line(`module ${this.className}`);
      body.indent();
      body.line('module_function');
      body.line();
      for (const fn of this.program.functions) this.functionMethod(fn);
      for (const block of this.program.blocks) this.method(this.blockNames.get(block.id)!, [], () => this.statements(block.body));
      for (const helper of this.program.helpers) this.helperMethod(helper);
      body.trimTrailingBlank();
      body.dedent();
      body.line('end');
      return this.finish();
    }
    const parent = this.program.classInfo?.parent;
    body.line(`class ${this.className}${parent ? ` < ${this.userTypeName(parent)}` : ''}`);
    body.indent();
    for (const { type } of this.program.interfaces ?? []) body.line(`include ${this.userTypeName(type.id)}`);
    // Other objects (and subclasses, for protected ones) read and set variables, and use
    // dispatchers, through accessors.
    const accessors = [
      ...this.program.members.filter((m) => !m.function).map((m) => this.memberNames.get(m.id)!),
      ...(this.program.dispatchers ?? []).map((d) => this.dispatcherNames.get(d.id)!)
    ];
    if (accessors.length) body.line(`attr_accessor ${accessors.map((a) => `:${a}`).join(', ')}`);
    if (accessors.length || this.program.interfaces?.length) body.line();
    this.method('initialize', [], () => {
      if (parent) body.line('super()');
      for (const m of this.program.members.filter((x) => !x.function)) body.line(`@${this.memberNames.get(m.id)} = ${this.value(m.initial, m.type)}`);
      for (const d of this.program.dispatchers ?? []) body.line(`@${this.dispatcherNames.get(d.id)} = Vg::Dispatcher.new`);
      for (const x of this.program.slots.filter((s) => !s.function)) body.line(`@${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)}`);
    });
    if (!parent || this.program.hasStart) this.method('start', [], () => this.statements(this.program.start));
    for (const fn of this.program.functions) this.functionMethod(fn);
    for (const { type, stubs } of this.program.interfaces ?? []) {
      for (const fn of stubs) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => scope.claim(p.name, 'snake'));
        const outputs = fn.outputs.filter((p) => p.kind === 'data');
        this.method(this.interfaceNames(type).functions.get(fn.id)!, params, () => {
          if (outputs.length) body.line(outputs.length === 1 ? this.defaultFor(outputs[0].type) : `[${outputs.map((o) => this.defaultFor(o.type)).join(', ')}]`);
        });
      }
    }
    this.tests = (this.program.tests ?? []).map((t) => ({ name: t.name, method: this.names.claim(`test ${t.name}`, 'snake') }));
    this.program.tests?.forEach((t, i) => this.method(this.tests[i].method, [], () => this.statements(t.body)));
    for (const block of this.program.blocks) this.method(this.blockNames.get(block.id)!, [], () => this.statements(block.body));
    for (const helper of this.program.helpers) this.helperMethod(helper);
    body.trimTrailingBlank();
    body.dedent();
    body.line('end');
    return this.finish();
  }

  // A structure (values made by new, never changed: Set Members makes a new one), an enumeration (a
  // module of constants that are the values' names) or an interface (a module classes include).
  private emitDeclaration(): GeneratedCode {
    const body = this.out;
    const declaration = this.program.declaration!;
    if (declaration.kind === 'interface') {
      body.line(`# An interface: classes that implement ${declaration.type.name} include it.`);
      body.line(`module ${this.className}`);
      body.line('end');
      return this.finish();
    }
    if (declaration.kind === 'enum') {
      const members = rubyEnumMembers(declaration.type);
      body.line(`module ${this.className}`);
      for (const e of declaration.type.enumerators) body.line(`  ${members.get(e.id)} = ${rubyString(e.name)}`);
      body.line('end');
      return this.finish();
    }
    const type = declaration.type;
    const fields = rubyFieldNames(type);
    body.line(`class ${this.className}`);
    body.indent();
    if (type.fields.length) body.line(`attr_reader ${type.fields.map((f) => `:${fields.get(f.id)}`).join(', ')}`);
    body.line();
    body.line(`def initialize(${type.fields.map((f) => `${fields.get(f.id)} = nil`).join(', ')})`);
    type.fields.forEach((f, i) => body.line(`  @${fields.get(f.id)} = ${fields.get(f.id)}.nil? ? ${this.value(declaration.initial[i], f.type)} : ${fields.get(f.id)}`));
    body.line('end');
    body.line();
    body.line('# As Print shows it: each field by name, in order.');
    body.line('def vg_fields');
    body.line(`  [${type.fields.map((f) => `[${rubyString(f.name)}, @${fields.get(f.id)}]`).join(', ')}]`);
    body.line('end');
    body.dedent();
    body.line('end');
    return this.finish();
  }

  private finish(): GeneratedCode {
    const header = new CodeWriter('  ');
    header.line(`# Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    header.line('# Do not edit: changes are overwritten when the graph is compiled.');
    header.line();
    header.line(`require_relative ${rubyString(RUBY_RUNTIME_FILE.replace(/\.rb$/, ''))}`);
    const files = [...new Set(this.program.imports.map((i) => requirePath(this.options.outputDir ?? '', i.userType?.source?.generatedPath ?? i.path)))].sort();
    for (const file of files) header.line(`require_relative ${rubyString(file)}`);
    header.line();
    const headerText = header.toString();
    const offset = headerText.split('\n').length - 1;
    const main = this.program.functions.find((f) => f.event?.entry === 'Main');
    const mainName = main && this.functionNames.get(main.id);
    return {
      text: headerText + this.out.toString(),
      companionFiles: [{ fileName: RUBY_RUNTIME_FILE, text: rubyRuntime() }],
      className: this.className,
      nodeLines: this.out.nodeLines.map((n) => ({ ...n, line: n.line + offset })),
      codeBreaks: this.out.breaks.map((line) => line + offset),
      ...(mainName ? { mainMethod: mainName } : {}),
      ...this.pinExpressions(),
      ...(this.tests.length ? { tests: this.tests } : {})
    };
  }

  private pinExpressions(): { pinExpressions?: PinExpression[] } {
    const pins = (this.program.pinValues ?? []).map((p) => ({ graphId: p.graphId, nodeId: p.nodeId, pinId: p.pinId, expression: this.expr(p.value) }));
    return pins.length ? { pinExpressions: pins } : {};
  }

  // ---- Names --------------------------------------------------------------------------------

  private inheritedMembers(info: ClassInfo | undefined): InheritedMembers[] {
    const chain: InheritedMembers[] = [];
    const seen = new Set<string>();
    for (let parent = info?.parent; parent && !seen.has(parent);) {
      seen.add(parent);
      const ancestor = classInfo(this.program, parent);
      const names = ancestor && this.membersOf(parent);
      if (!ancestor || !names) break;
      chain.push({ names, functions: ancestor.functions });
      parent = ancestor.parent;
    }
    const classes = [info, ...[...seen].map((id) => classInfo(this.program, id))];
    for (const id of new Set(classes.flatMap((c) => c?.interfaces ?? []))) {
      const iface = interfaceInfo(this.program, id);
      if (iface) chain.push({ names: this.interfaceNames(iface), functions: iface.functions });
    }
    return chain;
  }

  private interfaceNames(iface: InterfaceInfo): ClassMemberNames {
    const cached = this.classNames.get(iface.id);
    if (cached) return cached;
    const names = claimClassMembers(new NameScope(RESERVED, ['start']), { functions: iface.functions, events: [], variables: [], dispatchers: [] }, CLASS_STYLES);
    this.classNames.set(iface.id, names);
    return names;
  }

  // The nearest ancestor that has the function called `name`, and its method's name.
  private parentFunction(name: string): { owner: string; method: string } | undefined {
    for (const ancestor of this.program.ancestors ?? []) {
      const fn = ancestor.functions.find((f) => f.name === name);
      const method = fn && this.membersOf(ancestor.id)?.functions.get(fn.id);
      if (method) return { owner: this.userTypeName(this.program.classInfo!.parent!), method };
    }
    return undefined;
  }

  private membersOf(id: string): ClassMemberNames | undefined {
    const existing = this.classNames.get(id);
    if (existing) return existing;
    const info = classInfo(this.program, id);
    if (!info) return undefined;
    const names = claimClassMembers(new NameScope(RESERVED, ['start']), info, CLASS_STYLES, this.inheritedMembers(info));
    this.classNames.set(id, names);
    return names;
  }

  private userTypeName(id: string): string {
    if (this.program.declaration?.type.id === id || id === `object:${this.program.className}`) return this.className;
    return this.importNames.get(id) ?? 'nil';
  }

  // ---- Members --------------------------------------------------------------------------------

  private method(name: string, params: string[], body: () => void): void {
    this.out.endNode();
    this.out.line(`def ${name}${params.length ? `(${params.join(', ')})` : ''}`);
    this.out.indent();
    body();
    this.out.dedent();
    this.out.line('end');
    this.out.line();
  }

  private functionMethod(fn: IrFunction): void {
    const scope = new NameScope(RESERVED);
    const params = fn.params.map((p) => {
      const name = scope.claim(p.name, 'snake');
      this.paramNames.set(`${fn.id}\u0000${p.id}`, name);
      return name;
    });
    const locals = this.program.members.filter((m) => m.function === fn.id);
    for (const m of locals) this.memberNames.set(m.id, scope.claim(m.name, 'snake'));
    const slots = this.program.slots.filter((x) => x.function === fn.id);
    for (const x of slots) this.slotNames.set(x.id, scope.claim(x.name, 'snake'));
    this.method(this.functionNames.get(fn.id)!, params, () => {
      if (fn.description) this.out.line(`# ${fn.description.replace(/\s+/g, ' ')}`);
      for (const store of fn.event?.stores ?? []) this.out.line(`${this.slotRef(store.slot)} = ${this.paramNames.get(`${fn.id}\u0000${store.param}`)}`);
      for (const m of locals) this.out.line(`${this.memberNames.get(m.id)} = ${this.value(m.initial, m.type)}`);
      for (const x of slots) this.out.line(`${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)}`);
      this.statements(fn.body);
      if (fn.outputs.length && fn.body[fn.body.length - 1]?.kind !== 'return') this.out.line(`return ${this.returned(fn, [])}`);
    });
  }

  // A function's outputs as it returns them: one value, or an array of several.
  private returned(fn: IrFunction, values: IrExpr[]): string {
    const items = fn.outputs.map((o, i) => (values[i] ? this.value(values[i], o.type) : this.defaultFor(o.type)));
    return items.length === 1 ? items[0] : `[${items.join(', ')}]`;
  }

  // A code node's snippet as a method; inputs that are valid names keep their ids.
  private helperMethod(helper: IrCodeHelper): void {
    const scope = new NameScope(RESERVED);
    const params = helper.params.map((p, i) => ({
      pinId: p.pinId,
      name: /^[a-z_]\w*$/.test(p.pinId) && !RESERVED.has(p.pinId) ? scope.claim(p.pinId) : scope.claim(`pin${i}`)
    }));
    const byPin = new Map(params.map((p) => [p.pinId, p.name]));
    const code = helper.code.replace(/\$\{([^}]+)\}/g, (_m, pin: string) => byPin.get(pin) ?? pin);
    this.method(this.helperNames.get(helper.id)!, params.map((p) => p.name), () => {
      for (const line of dedent(code)) this.out.line(line);
    });
  }

  private slotRef(id: string): string {
    const name = this.slotNames.get(id)!;
    return this.program.slots.find((x) => x.id === id)?.function ? name : `@${name}`;
  }

  private memberRef(id: string): string {
    const name = this.memberNames.get(id)!;
    return this.program.members.find((m) => m.id === id)?.function ? name : `@${name}`;
  }

  private dispatcherRef(s: { dispatcher: string; target?: IrExpr; type?: string }): string {
    if (s.target && s.type) return `${this.targetRef(s.target)}.${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}`;
    return `@${this.dispatcherNames.get(s.dispatcher)}`;
  }

  private targetRef(e: IrExpr): string {
    return e.kind === 'self' ? 'self' : this.operand(e);
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

  private results(results: { slot: string }[], call: string): void {
    this.out.line(`${results.map((r) => this.slotRef(r.slot)).join(', ')} = ${call}`);
  }

  private statement(s: IrStatement): void {
    const { out } = this;
    if (s.kind === 'callBlock') out.endNode();
    else out.node(s.source, (text) => `# ${text}`);
    switch (s.kind) {
      case 'print':
        out.line(`puts ${this.text(s.value)}`);
        break;
      case 'assert':
        out.line(`raise ${this.expr(s.message)} unless ${this.operand(s.condition)}`);
        break;
      case 'store':
        out.line(`${this.slotRef(s.slot)} = ${this.expr(s.value)}`);
        break;
      case 'setMember':
        out.line(`${this.memberRef(s.member)} = ${this.value(s.value, this.program.members.find((m) => m.id === s.member)?.type)}`);
        break;
      case 'if': {
        out.line(`if ${this.expr(s.condition)}`);
        this.block(s.then);
        let rest = s.else;
        while (rest.length === 1 && rest[0].kind === 'if' && sameSource(rest[0], s)) {
          const inner: Extract<IrStatement, { kind: 'if' }> = rest[0];
          out.line(`elsif ${this.expr(inner.condition)}`);
          this.block(inner.then);
          rest = inner.else;
        }
        if (rest.length) {
          out.line('else');
          this.block(rest);
        }
        out.line('end');
        break;
      }
      case 'for': {
        const counter = this.slotRef(s.counter);
        out.line(`${counter} = ${this.expr(s.first)}`);
        out.line(`while ${counter} <= ${this.operand(s.last)}${s.stop ? ` && !${this.slotRef(s.stop)}` : ''}`);
        out.indent();
        this.statements(s.body);
        out.line(`${counter} += 1`);
        out.dedent();
        out.line('end');
        break;
      }
      case 'forEach': {
        const index = this.slotRef(s.index);
        const array = this.operand(s.array);
        out.line(`${index} = 0`);
        out.line(`while ${index} < ${array}.length${s.stop ? ` && !${this.slotRef(s.stop)}` : ''}`);
        out.indent();
        out.line(`${this.slotRef(s.element)} = ${array}[${index}]`);
        this.statements(s.body);
        out.line(`${index} += 1`);
        out.dedent();
        out.line('end');
        break;
      }
      case 'while':
        out.line(`while ${this.expr(s.condition)}`);
        this.block(s.body);
        out.line('end');
        break;
      case 'call': {
        const call = this.call(s.callee, s.args);
        if (s.results) this.results(s.results, call);
        else out.line(s.resultSlot ? `${this.slotRef(s.resultSlot)} = ${call}` : call);
        break;
      }
      case 'callBlock':
        out.line(`${this.blockNames.get(s.block)}()`);
        break;
      case 'await':
        // An async method (docs/node-authoring.md, gap 4): its Thread, watched by the latent queue;
        // Completed runs with the thread's value.
        out.line(`Vg.await_latent(${this.call(s.callee, s.args)}) do |vg_value|`);
        out.indent();
        if (s.resultSlot) out.line(`${this.slotRef(s.resultSlot)} = vg_value`);
        this.statements(s.then);
        out.dedent();
        out.line('end');
        break;
      case 'callFunction': {
        const call = this.functionCall(s.function, s.args);
        if (s.results.length) this.results(s.results, call);
        else out.line(call);
        break;
      }
      case 'bindEvent':
        out.line(`${this.dispatcherRef(s)}.${s.bind ? 'bind' : 'unbind'}(self, :${this.functionNames.get(s.event)})`);
        break;
      case 'unbindAll':
        out.line(`${this.dispatcherRef(s)}.clear`);
        break;
      case 'broadcast':
        out.line(`${this.dispatcherRef(s)}.broadcast(${s.args.map((a) => this.expr(a)).join(', ')})`);
        break;
      case 'delay': {
        // The action is a block: `next` leaves it (`return` would leave the method).
        if (s.generation) {
          const generation = this.slotRef(s.generation);
          out.line(`${generation} += 1`);
          // Blocks share the method's variables, so each Delay keeps its own.
          const started = `started_${generation.replace(/^@_*/, '')}`;
          out.line(`${started} = ${generation}`);
          out.line(`Vg.delay(${this.expr(s.duration)}) do`);
          out.indent();
          out.line(`next if ${started} != ${generation}`);
        } else {
          const pending = this.slotRef(s.pending!);
          out.line(`unless ${pending}`);
          out.indent();
          out.line(`${pending} = true`);
          out.line(`Vg.delay(${this.expr(s.duration)}) do`);
          out.indent();
          out.line(`${pending} = false`);
        }
        this.statements(s.then);
        out.dedent();
        out.line('end');
        if (!s.generation) {
          out.dedent();
          out.line('end');
        }
        break;
      }
      case 'cast':
        out.line(`if ${this.operand(s.value)}.is_a?(${this.userTypeName(s.type)})`);
        out.indent();
        out.line(`${this.slotRef(s.slot)} = ${this.expr(s.value)}`);
        this.statements(s.succeeded);
        out.dedent();
        if (s.failed.length) {
          out.line('else');
          this.block(s.failed);
        }
        out.line('end');
        break;
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, s.type);
        const call = `${this.targetRef(s.target)}.${iface ? this.interfaceNames(iface).functions.get(s.function) : s.function}(${s.args.map((a) => this.expr(a)).join(', ')})`;
        if (s.results.length) this.results(s.results, call);
        else out.line(call);
        break;
      }
      case 'parentCall': {
        const parent = this.userTypeName(this.program.classInfo!.parent!);
        const call = s.start ? `${parent}.instance_method(:start).bind_call(self)` : this.parentCall(s.function!, s.args);
        if (s.results.length) this.results(s.results, call);
        else out.line(call);
        break;
      }
      case 'construct':
        out.line(`${this.slotRef(s.slot)} = ${this.userTypeName(s.type)}.new`);
        out.line(`${this.slotRef(s.slot)}.start`);
        break;
      case 'setObjectVariable':
        out.line(`${this.targetRef(s.target)}.${this.membersOf(s.type)?.variables.get(s.variable)} = ${this.value(s.value, classInfo(this.program, s.type)?.variables.find((v) => v.id === s.variable)?.type)}`);
        break;
      case 'objectCall': {
        const names = this.membersOf(s.type);
        const name = s.function !== undefined ? names?.functions.get(s.function) : names?.events.get(s.event!);
        const call = `${this.targetRef(s.target)}.${name}(${s.args.map((a) => this.expr(a)).join(', ')})`;
        if (s.results.length) this.results(s.results, call);
        else out.line(call);
        break;
      }
      case 'return': {
        const fn = this.program.functions.find((f) => f.id === s.source.graphId);
        out.line(fn?.outputs.length ? `return ${this.returned(fn, s.values)}` : 'return');
        break;
      }
    }
  }

  // The parent class's version of a function: Ruby's super only reaches the method of the same name.
  private parentCall(name: string, args: IrExpr[]): string {
    const target = this.parentFunction(name);
    return `${target?.owner ?? 'super'}.instance_method(:${target?.method ?? name}).bind_call(${['self', ...args.map((a) => this.expr(a))].join(', ')})`;
  }

  // ---- Expressions --------------------------------------------------------------------------

  private expr(e: IrExpr): string {
    switch (e.kind) {
      case 'literal':
        return literal(e.value);
      case 'default':
        return this.defaultFor(e.type);
      case 'member':
        return this.memberRef(e.member);
      case 'output':
        return this.slotRef(e.slot);
      case 'add':
        return `${this.operand(e.left)} + ${this.operand(e.right)}`;
      case 'toNumber':
        if (isNumeric(this.typeOf(e.value))) return this.expr(e.value);
        return `Vg.to_number(${this.expr(e.value)})`;
      case 'toText':
        return this.text(e.value);
      case 'concat':
        return e.parts.map((part) => this.operand(part)).join(' + ');
      case 'toBoolean': {
        const type = this.typeOf(e.value);
        if (type?.id === 'bool' && !type.container) return this.expr(e.value);
        return `Vg.to_boolean(${this.expr(e.value)})`;
      }
      case 'call': {
        const call = this.call(e.callee, e.args);
        if (!e.output) return call;
        const imported = this.program.imports.find((i) => i.id === e.callee.id);
        return `${call}[${imported?.outputs?.findIndex((o) => o.id === e.output) ?? 0}]`;
      }
      case 'binary':
        return `${this.operand(e.left)} ${e.op} ${this.operand(e.right)}`;
      case 'not':
        return `!${this.operand(e.value)}`;
      case 'param':
        return this.paramNames.get(`${e.function}\u0000${e.id}`) ?? 'nil';
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(e.function, e.args);
        return fn.outputs.length === 1 ? call : `${call}[${fn.outputs.findIndex((o) => o.id === e.output)}]`;
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return 'nil';
        return `${this.userTypeName(type.id)}.new(${type.fields.map((f, i) => this.value(e.fields[i], f.type)).join(', ')})`;
      }
      case 'structField': {
        const type = this.types.get(e.type);
        return `${this.operand(e.value)}.${type?.kind === 'struct' ? rubyFieldNames(type).get(e.field) : e.field}`;
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        return `${this.userTypeName(e.type)}::${type?.kind === 'enum' ? rubyEnumMembers(type).get(e.value) : e.value}`;
      }
      case 'self':
        return 'self';
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, e.type);
        const outputs = iface?.functions.find((f) => f.id === e.function)?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}.${iface ? this.interfaceNames(iface).functions.get(e.function) : e.function}(${e.args.map((a) => this.expr(a)).join(', ')})`;
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'parentCall': {
        const fn = this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === e.function);
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = this.parentCall(e.function, e.args);
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'isValid':
        return `!${this.operand(e.value)}.nil?`;
      case 'objectVariable':
        return `${this.targetRef(e.target)}.${this.membersOf(e.type)?.variables.get(e.variable)}`;
      case 'objectCall': {
        const fn = classInfo(this.program, e.type)?.functions.find((f) => f.id === e.function);
        const call = `${this.targetRef(e.target)}.${this.membersOf(e.type)?.functions.get(e.function)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'makeContainer': {
        if (e.type.container === 'map') {
          const pairs: string[] = [];
          for (let i = 0; i + 1 < e.items.length; i += 2) pairs.push(`${this.expr(e.items[i])} => ${this.expr(e.items[i + 1])}`);
          return `{${pairs.join(', ')}}`;
        }
        const items = `[${e.items.map((item) => this.expr(item)).join(', ')}]`;
        return e.type.container === 'set' ? `Set.new(${items})` : items;
      }
    }
  }

  private functionCall(id: string, args: IrExpr[]): string {
    return `${this.functionNames.get(id)!}(${args.map((a) => this.expr(a)).join(', ')})`;
  }

  private call(callee: IrCallee, args: IrExpr[]): string {
    const list = args.map((a) => this.expr(a)).join(', ');
    if (callee.kind === 'helper') return `${this.helperNames.get(callee.id)}(${list})`;
    const member = this.program.imports.find((i) => i.id === callee.id)?.member;
    if (!member) return `${this.importNames.get(callee.id)}(${list})`;
    // A class's member (docs/node-authoring.md, gap 2), on the Target pin's object.
    if (member.kind === 'construct') return `${this.importNames.get(callee.id)}.new(${list})`;
    const [target, ...rest] = args;
    const object = `(${this.expr(target)})`;
    const values = rest.map((a) => this.expr(a)).join(', ');
    return member.kind === 'get' ? `${object}.${member.name}` : member.kind === 'set' ? `${object}.${member.name} = ${values}` : `${object}.${member.name}(${values})`;
  }

  private value(e: IrExpr, type: TypeRef | undefined): string {
    if (e.kind !== 'literal' || !type?.container || !Array.isArray(e.value)) return this.expr(e);
    if (type.container === 'map') {
      const pairs = e.value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2);
      return `{${pairs.map(([k, v]) => `${literal(k)} => ${literal(v)}`).join(', ')}}`;
    }
    const items = `[${e.value.map(literal).join(', ')}]`;
    return type.container === 'set' ? `Set.new(${items})` : items;
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' || e.kind === 'not' || e.kind === 'concat' || e.kind === 'isValid' ? `(${text})` : text;
  }

  private text(e: IrExpr): string {
    const type = this.typeOf(e);
    if (type && !type.container && type.id === 'string') return this.expr(e);
    return `Vg.format(${this.expr(e)})`;
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (type?.container === 'array') return '[]';
    if (type?.container === 'set') return 'Set.new';
    if (type?.container === 'map') return '{}';
    const user = type && this.types.get(type.id);
    if (user?.kind === 'struct') return `${this.userTypeName(user.id)}.new`;
    if (user?.kind === 'enum' && user.enumerators[0]) return `${this.userTypeName(user.id)}::${rubyEnumMembers(user).get(user.enumerators[0].id)}`;
    switch (type?.id) {
      case 'bool':
        return 'false';
      case 'int':
        return '0';
      case 'float':
        return '0.0';
      case 'string':
        return '""';
      default:
        return 'nil';
    }
  }

  private typeOf(e: IrExpr): TypeRef | undefined {
    const type = exprType(e, this.program);
    return type?.id === 'any' ? undefined : type;
  }
}

// A JSON value as a Ruby literal.
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : value !== value ? 'Float::NAN' : value > 0 ? 'Float::INFINITY' : '-Float::INFINITY';
  if (typeof value === 'string') return rubyString(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  return 'nil';
}

// A double-quoted Ruby string: JSON's escapes, and # escaped so nothing is interpolated.
export function rubyString(text: string): string {
  return JSON.stringify(text).replace(/#/g, '\\#');
}

function sameSource(a: IrStatement, b: IrStatement): boolean {
  return a.kind !== 'callBlock' && b.kind !== 'callBlock' && a.source.graphId === b.source.graphId && a.source.nodeId === b.source.nodeId;
}

function isNumeric(type: TypeRef | undefined): boolean {
  return !!type && !type.container && (type.id === 'int' || type.id === 'float');
}
