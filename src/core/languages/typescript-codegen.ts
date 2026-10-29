// Generates TypeScript, or JavaScript with JSDoc types, from Visual IR.
import { IrBlock, IrCallee, IrCodeHelper, IrExpr, IrFunction, IrImport, IrProgram, IrStatement, calleeSignature, classInfo, importKey, exprType, interfaceInfo, programClassSpec, userTypes } from '../compiler/ir';
import { relativeSpecifier, typescriptSpecifier } from '../compiler/module-paths';
import { ClassMemberNames, ClassMemberStyles, InheritedMembers, NameScope, claimClassMembers, dedent, toIdentifier } from '../compiler/names';
import type { ClassInfo, InterfaceInfo } from '../objects';
import { CodeWriter } from '../compiler/writer';
import { CodeDebugger, CodeGenerator, CodeRunner, GenerateOptions, GeneratedCode, PinExpression } from '../language-pack';
import { TypeRef } from '../types';
import { EnumInfo, StructInfo, UserType, isUserTypeId } from '../user-types';

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements',
  'interface', 'package', 'private', 'protected', 'public', 'await', 'async', 'as', 'any', 'boolean', 'constructor',
  'declare', 'get', 'module', 'require', 'number', 'set', 'string', 'symbol', 'type', 'from', 'of', 'unknown', 'never',
  'object', 'undefined', 'arguments', 'eval'
]);

// Formats a value the way docs/semantics.md says Print shows it. Only emitted when a value's type
// isn't known at compile time.
const FORMAT_HELPER = 'formatValue';
// Unreal's event dispatcher, emitted when the class declares one.
const DISPATCHER_CLASS = 'EventDispatcher';

export interface TypeScriptFlavor {
  typed: boolean;
  mapType(type: TypeRef): string;
}

// Generated TypeScript imports project modules the way the project's tsconfig.json expects
// (".js" or no extension; docs/code-as-nodes.md). Node.js only finds ".ts" files by their own
// name, so Run adds a resolve hook that tries the TypeScript file when the import isn't found.
const RESOLVE_TYPESCRIPT = [
  'const m = process.getBuiltinModule?.("node:module");',
  'if (m?.registerHooks) m.registerHooks({ resolve(specifier, context, next) {',
  '  try { return next(specifier, context); } catch (error) {',
  '    if (!/^\\.\\.?\\//.test(specifier)) throw error;',
  '    for (const candidate of [specifier.replace(/\\.([mc]?)js$/, ".$1ts"), specifier + ".ts", specifier + "/index.ts"]) {',
  '      if (candidate === specifier) continue;',
  '      try { return next(candidate, context); } catch {}',
  '    }',
  '    throw error;',
  '  }',
  '} });'
].join('\n');

const nodeRunner: CodeRunner = {
  commands: () => [['node']],
  // node --test, with the hook that resolves TypeScript imports.
  testArgs: (_file, _className, context) => ['--import', `data:text/javascript,${encodeURIComponent(RESOLVE_TYPESCRIPT)}`, '--test', context.testFile ?? ''],
  // Start, then Main with the arguments when the class has one.
  args: (file, className, context) => {
    const main = context?.mainMethod ? ` o.${context.mainMethod}(${JSON.stringify(context.args ?? [])});` : '';
    return ['-e', `${RESOLVE_TYPESCRIPT}\nimport(${JSON.stringify(file.url)}).then((m) => { const o = new m.${className}(); o.start();${main} })`];
  },
  missingToolMessage: 'Node.js was not found. Install Node.js 22.18 or later (it runs TypeScript directly) and make sure `node` is on the PATH.'
};

// Node's test runner, which generated test files use (a constant, so this file doesn't look like it
// imports it).
const TEST_MODULE = 'node:test';

// js-debug, built into VS Code, runs the same command as Run.
const nodeDebugger: CodeDebugger = {
  type: 'node',
  configuration: (file, className, context) => {
    const [executable, ...leading] = context.command?.length ? context.command : ['node'];
    return {
      type: 'node', request: 'launch', runtimeExecutable: executable, runtimeArgs: [...leading, ...nodeRunner.args(file, className, context)],
      cwd: context.cwd, console: 'internalConsole', outputCapture: 'std'
    };
  }
};

// The names a function library's functions are exported as (camelCase, unique in the module). The
// library's own generated file and every file that imports it use these.
export function typescriptExportNames(functions: { id: string; name: string }[]): Map<string, string> {
  const scope = new NameScope(RESERVED, [FORMAT_HELPER]);
  return new Map(functions.map((f) => [f.id, scope.claim(f.name, 'camel')]));
}

// Field names of the object a function with several outputs returns.
function resultFields(outputs: { id: string; name: string }[]): Map<string, string> {
  const fields = new NameScope(RESERVED);
  return new Map(outputs.map((o) => [o.id, fields.claim(o.name, 'camel')]));
}

// Property names of a struct's fields (camelCase) and member names of an enum's values
// (PascalCase), the same in the type's own file and in every file that uses it.
export function typescriptFieldNames(type: StructInfo): Map<string, string> {
  const scope = new NameScope(RESERVED, ['toJSON']);
  return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, 'camel')]));
}

export function typescriptEnumMembers(type: EnumInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.enumerators.map((e) => [e.id, scope.claim(e.name, 'pascal')]));
}

// How a class's public members are named (src/core/compiler/names.ts).
const CLASS_STYLES: ClassMemberStyles = { functions: 'camel', variables: 'keep', dispatchers: 'keep' };

export function typescriptGenerator(flavor: TypeScriptFlavor): CodeGenerator {
  return {
    libraryExports: (_name, functions) => ({ names: typescriptExportNames(functions) }),
    snippetLanguages: flavor.typed ? ['typescript', 'javascript'] : ['javascript'],
    importLanguages: flavor.typed ? ['typescript', 'javascript'] : ['javascript'],
    outputFileName: (graphFileName) => `${graphFileName}.${flavor.typed ? 'ts' : 'js'}`,
    testFileName: (graphFileName) => `${graphFileName}.test.${flavor.typed ? 'ts' : 'js'}`,
    generate: (program, options) => new TypeScriptEmitter(program, options, flavor).emit(),
    runner: nodeRunner,
    debugger: nodeDebugger
  };
}

class TypeScriptEmitter {
  private readonly out = new CodeWriter('  ');
  // One scope for the class's members; in a library, for the module's functions.
  private readonly names: NameScope;
  private readonly library: boolean;
  private readonly esm: boolean;
  private readonly memberNames = new Map<string, string>();
  private readonly slotNames = new Map<string, string>();
  private readonly helperNames = new Map<string, string>();
  private readonly blockNames = new Map<string, string>();
  // Local names of imported functions, aliased where they would clash.
  private readonly importNames = new Map<string, string>();
  private readonly functionNames = new Map<string, string>();
  private readonly dispatcherNames = new Map<string, string>();
  // Parameter names of each function, keyed by function and input id.
  private readonly paramNames = new Map<string, string>();
  // Field names of a function's result object, when it has several outputs.
  private readonly outputFields = new Map<string, Map<string, string>>();
  private readonly className: string;
  private needsFormat = false;
  // The structs and enums the program uses (and the one it declares), by type id.
  private readonly types: Map<string, UserType>;
  // The public member names of each class the program uses, by type id; its own first.
  private readonly classNames = new Map<string, ClassMemberNames>();

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions, private readonly flavor: TypeScriptFlavor) {
    this.library = !!program.library;
    this.esm = flavor.typed || options.moduleFormat !== 'commonjs';
    this.className = new NameScope(RESERVED).claim(program.className, 'pascal');
    this.types = userTypes(program);
    if (program.declaration) this.types.set(program.declaration.type.id, program.declaration.type);
    // A library's functions are claimed first, exactly as typescriptExportNames claims them.
    this.names = this.library ? new NameScope(RESERVED, [FORMAT_HELPER]) : new NameScope(RESERVED, ['start']);
    // Public members first, as every file that uses the class names them.
    const own = claimClassMembers(this.names, programClassSpec(program), CLASS_STYLES, this.inheritedMembers(program.classInfo));
    this.classNames.set(`object:${program.className}`, own);
    for (const f of program.functions) {
      this.functionNames.set(f.id, (f.event ? own.events : own.functions).get(f.id)!);
      this.outputFields.set(f.id, resultFields(f.outputs));
    }
    for (const [id, name] of own.variables) this.memberNames.set(id, name);
    for (const [id, name] of own.dispatchers) this.dispatcherNames.set(id, name);
    const moduleScope = this.library ? this.names : new NameScope(RESERVED, [this.className, FORMAT_HELPER, DISPATCHER_CLASS]);
    const locals = new Map<string, string>();
    for (const i of program.imports) {
      const local = locals.get(importKey(i)) ?? moduleScope.claim(i.name);
      locals.set(importKey(i), local);
      this.importNames.set(i.id, local);
    }
    // Member variables keep their names; internal fields are private (TypeScript) or underscored (JavaScript).
    // A subclass's internal fields and methods carry its name: its parent's private ones may share theirs.
    const base = flavor.typed || this.library ? '' : '_';
    const internal = program.ancestors?.length ? `${base}${toIdentifier(program.className, 'camel')}_` : base;
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'keep', internal));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'keep', internal));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(h.name, 'snake', internal));
  }

  emit(): GeneratedCode {
    const { out, flavor } = this;
    out.line(`// Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    out.line('// Do not edit: changes are overwritten when the graph is compiled.');
    out.line();
    const esm = this.esm;
    this.imports(esm);
    if (this.program.declaration) return this.emitDeclaration();
    if (this.library) return this.emitLibrary();
    const parent = this.program.classInfo?.parent;
    const interfaces = (this.program.interfaces ?? []).map((i) => this.userTypeName(i.type.id)!);
    const implementsClause = flavor.typed && interfaces.length ? ` implements ${interfaces.join(', ')}` : '';
    out.line(`${esm ? 'export ' : ''}class ${this.className}${parent ? ` extends ${this.userTypeName(parent)}` : ''}${implementsClause} {`);
    out.indent();
    // Each interface's tag, which its type guard looks for.
    for (const local of interfaces) out.line(flavor.typed ? `readonly [${this.interfaceTag(local)}] = true as const;` : `[${this.interfaceTag(local)}] = true;`);

    const members = this.program.members.filter((m) => !m.function);
    const slots = this.program.slots.filter((x) => !x.function);
    const dispatchers = this.program.dispatchers ?? [];
    for (const m of members) this.field(this.memberNames.get(m.id)!, m.type, this.coerce(m.initial, m.type), m.access ?? false);
    for (const d of dispatchers) {
      const name = this.dispatcherNames.get(d.id)!;
      if (flavor.typed) out.line(`readonly ${name} = new ${DISPATCHER_CLASS}<[${d.params.map((p) => this.typeName(p.type)).join(', ')}]>();`);
      else {
        out.line(`/** @type {${DISPATCHER_CLASS}<[${d.params.map((p) => this.mapType(p.type)).join(', ')}]>} */`);
        out.line(`${name} = new ${DISPATCHER_CLASS}();`);
      }
    }
    for (const x of slots) this.field(this.slotNames.get(x.id)!, x.type, this.defaultFor(x.type), true);
    if (members.length || slots.length || dispatchers.length) out.line();

    // A subclass without Start nodes keeps its parent's start, as Unreal keeps BeginPlay.
    if (!parent || this.program.hasStart) this.method('start', [], undefined, false, () => this.statements(this.program.start));
    for (const fn of this.program.functions) this.functionMethod(fn);
    this.interfaceStubs();
    // Test Case events: methods the test file calls, named after every other member.
    const tests = (this.program.tests ?? []).map((t) => ({ test: t, method: this.names.claim(`test ${t.name}`, 'camel') }));
    for (const { test, method } of tests) this.method(method, [], undefined, false, () => this.statements(test.body));
    for (const block of this.program.blocks) this.blockMethod(block);
    for (const helper of this.program.helpers) this.helperMethod(helper);
    out.trimTrailingBlank();

    out.dedent();
    out.line('}');
    if (!esm) {
      out.line();
      out.line(`module.exports = { ${this.className} };`);
      this.lateRequires();
    }
    if (dispatchers.length) this.dispatcherClass();
    if (this.needsFormat) this.formatHelper();
    const main = this.program.functions.find((f) => f.event?.entry === 'Main');
    return {
      text: out.toString(), className: this.className, nodeLines: out.nodeLines, codeBreaks: out.breaks, ...(main ? { mainMethod: this.functionNames.get(main.id) } : {}), ...this.pinExpressions(),
      ...(tests.length ? { tests: tests.map((t) => ({ name: t.test.name, method: t.method })), testFile: this.testFile(tests.map((t) => ({ name: t.test.name, method: t.method }))) } : {})
    };
  }

  // The tests, for node:test: each runs its method on a new object.
  private testFile(tests: { name: string; method: string }[]): string {
    const own = `${this.options.sourceFileName}.${this.flavor.typed ? 'ts' : 'js'}`;
    const specifier = this.flavor.typed ? typescriptSpecifier('', own, this.options.importExtension ?? 'ts') : `./${own}`;
    const lines = [
      `// Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`,
      '// Its Test Case events, run with node --test. Do not edit: changes are overwritten when the graph is compiled.',
      '',
      ...(this.esm
        ? [`import { test } from ${JSON.stringify(TEST_MODULE)};`, `import { ${this.className} } from ${JSON.stringify(specifier)};`]
        : [`const { test } = require(${JSON.stringify(TEST_MODULE)});`, `const { ${this.className} } = require(${JSON.stringify(specifier)});`])
    ];
    for (const t of tests) lines.push('', `test(${JSON.stringify(t.name)}, () => {`, `  new ${this.className}().${t.method}();`, '});');
    return lines.join('\n') + '\n';
  }

  // How the debugger reads each pin it can (docs/debugging.md, "Values").
  private pinExpressions(): { pinExpressions?: PinExpression[] } {
    const pins = (this.program.pinValues ?? []).map((p) => ({ graphId: p.graphId, nodeId: p.nodeId, pinId: p.pinId, expression: this.expr(p.value) }));
    return pins.length ? { pinExpressions: pins } : {};
  }

  // Unreal's event dispatcher: bound events run in the order they were bound, each event once. An
  // event is its object and method, so binding another object's event works too.
  private dispatcherClass(): void {
    const { out, flavor } = this;
    const lines = flavor.typed ? [
      `class ${DISPATCHER_CLASS}<Args extends unknown[]> {`,
      '  private bindings: [object, (...args: Args) => void][] = [];',
      '',
      '  bind(target: object, handler: (...args: Args) => void): void {',
      '    if (!this.bindings.some(([t, h]) => t === target && h === handler)) this.bindings.push([target, handler]);',
      '  }',
      '',
      '  unbind(target: object, handler: (...args: Args) => void): void {',
      '    this.bindings = this.bindings.filter(([t, h]) => t !== target || h !== handler);',
      '  }',
      '',
      '  clear(): void {',
      '    this.bindings = [];',
      '  }',
      '',
      '  broadcast(...args: Args): void {',
      '    for (const [target, handler] of [...this.bindings]) handler.apply(target, args);',
      '  }',
      '}'
    ] : [
      '/** @template {unknown[]} Args */',
      `class ${DISPATCHER_CLASS} {`,
      '  /** @type {[object, (...args: Args) => void][]} */',
      '  bindings = [];',
      '',
      '  /** @param {object} target @param {(...args: Args) => void} handler */',
      '  bind(target, handler) {',
      '    if (!this.bindings.some(([t, h]) => t === target && h === handler)) this.bindings.push([target, handler]);',
      '  }',
      '',
      '  /** @param {object} target @param {(...args: Args) => void} handler */',
      '  unbind(target, handler) {',
      '    this.bindings = this.bindings.filter(([t, h]) => t !== target || h !== handler);',
      '  }',
      '',
      '  clear() {',
      '    this.bindings = [];',
      '  }',
      '',
      '  /** @param {Args} args */',
      '  broadcast(...args) {',
      '    for (const [target, handler] of [...this.bindings]) handler.apply(target, args);',
      '  }',
      '}'
    ];
    out.line();
    out.line('// Unreal\'s event dispatcher: bound events run in the order they were bound, each event once.');
    for (const line of lines) out.line(line);
  }

  // CommonJS: classes this one uses are required after it is exported, so two classes that use each
  // other both load completely.
  private lateRequires(): void {
    const classes = sortImports(this.program.imports.filter((i) => i.userType?.kind === 'class' && i.id !== this.program.classInfo?.parent));
    if (!classes.length) return;
    this.out.line('// Classes are required last: they may use this one.');
    for (const i of classes) {
      const local = this.importNames.get(i.id)!;
      this.out.line(`const { ${local === i.name ? local : `${i.name}: ${local}`} } = require(${JSON.stringify(relativeSpecifier(this.options.outputDir ?? '', i.path))});`);
    }
  }


  // The class's ancestors' member names, nearest first (src/core/compiler/names.ts).
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
    // Interfaces the class and its ancestors implement: their functions keep the interface's names.
    const classes = [info, ...[...seen].map((id) => classInfo(this.program, id))];
    for (const id of new Set(classes.flatMap((c) => c?.interfaces ?? []))) {
      const iface = interfaceInfo(this.program, id);
      if (iface) chain.push({ names: this.interfaceNames(iface), functions: iface.functions });
    }
    return chain;
  }

  // An interface's function names, as its own file and every implementing class name them.
  private interfaceNames(iface: InterfaceInfo): ClassMemberNames {
    const cached = this.classNames.get(iface.id);
    if (cached) return cached;
    const names = claimClassMembers(new NameScope(RESERVED, ['start']), { functions: iface.functions, events: [], variables: [], dispatchers: [] }, CLASS_STYLES);
    this.classNames.set(iface.id, names);
    return names;
  }

  // An interface's run-time tag and type guard (TypeScript's interfaces are gone at run time).
  private interfaceTag(local: string): string {
    return `${local}Tag`;
  }

  private interfaceGuard(local: string): string {
    return `is${local}`;
  }

  // The generated name of the nearest ancestor's function called `name` (what Parent calls).
  private parentFunctionName(name: string): string | undefined {
    for (const ancestor of this.program.ancestors ?? []) {
      const fn = ancestor.functions.find((f) => f.name === name);
      if (fn) return this.membersOf(ancestor.id)?.functions.get(fn.id);
    }
    return undefined;
  }

  // The member names another class's generated file gives its public members.
  private membersOf(id: string): ClassMemberNames | undefined {
    const existing = this.classNames.get(id);
    if (existing) return existing;
    const info = classInfo(this.program, id);
    if (!info) return undefined;
    const names = claimClassMembers(new NameScope(RESERVED, ['start']), info, CLASS_STYLES, this.inheritedMembers(info));
    this.classNames.set(id, names);
    return names;
  }

  // An object member is reached through its object; TypeScript needs to hear it isn't null.
  private targetRef(e: IrExpr): string {
    if (e.kind === 'self') return 'this';
    return this.flavor.typed ? `${this.operand(e)}!` : this.operand(e);
  }

  // A function library: its functions as exported module functions, its helpers as module functions.
  private emitLibrary(): GeneratedCode {
    const { out } = this;
    for (const fn of this.program.functions) this.functionMethod(fn);
    for (const helper of this.program.helpers) this.helperMethod(helper);
    out.trimTrailingBlank();
    if (!this.esm) {
      out.line();
      out.line(`module.exports = { ${this.program.functions.map((f) => this.functionNames.get(f.id)).join(', ')} };`);
    }
    if (this.needsFormat) this.formatHelper();
    return { text: out.toString(), className: this.className, nodeLines: out.nodeLines, codeBreaks: out.breaks, ...this.pinExpressions() };
  }

  // A structure or enumeration: a class whose instances are never changed (Set Members makes a new
  // one), or an object of values that are their names. Both use only TypeScript that Node.js can
  // run by stripping types (no parameter properties, no `enum`).
  private emitDeclaration(): GeneratedCode {
    const { out, flavor } = this;
    const declaration = this.program.declaration!;
    const exported = this.esm ? 'export ' : '';
    if (declaration.kind === 'interface') {
      this.interfaceDeclaration(declaration.type);
      return { text: out.toString(), className: this.className, nodeLines: out.nodeLines, codeBreaks: out.breaks };
    }
    if (declaration.kind === 'enum') {
      const members = typescriptEnumMembers(declaration.type);
      const values = declaration.type.enumerators.map((e) => [members.get(e.id)!, JSON.stringify(e.name)] as const);
      if (flavor.typed) {
        out.line(`${exported}const ${this.className} = {`);
        values.forEach(([name, value], i) => out.line(`  ${name}: ${value}${i < values.length - 1 ? ',' : ''}`));
        out.line('} as const;');
        out.line(`${exported}type ${this.className} = (typeof ${this.className})[keyof typeof ${this.className}];`);
      } else {
        out.line(`${exported}const ${this.className} = Object.freeze({`);
        values.forEach(([name, value], i) => out.line(`  ${name}: ${value}${i < values.length - 1 ? ',' : ''}`));
        out.line('});');
      }
    } else {
      const type = declaration.type;
      const fields = typescriptFieldNames(type);
      const params = type.fields.map((f, i) => ({ name: fields.get(f.id)!, type: f.type, initial: this.coerce(declaration.initial[i], f.type) }));
      out.line(`${exported}class ${this.className} {`);
      out.indent();
      if (flavor.typed) {
        for (const p of params) out.line(`readonly ${p.name}: ${this.typeName(p.type)};`);
        out.line();
        out.line(`constructor(${params.map((p) => `${p.name}: ${this.typeName(p.type)} = ${p.initial}`).join(', ')}) {`);
        out.indent();
        for (const p of params) out.line(`this.${p.name} = ${p.name};`);
        out.dedent();
        out.line('}');
      } else {
        out.line('/**');
        for (const p of params) out.line(` * @param {${this.mapType(p.type)}} [${p.name}]`);
        out.line(' */');
        out.line(`constructor(${params.map((p) => `${p.name} = ${p.initial}`).join(', ')}) {`);
        out.indent();
        for (const p of params) out.line(`this.${p.name} = ${p.name};`);
        out.line('Object.freeze(this);');
        out.dedent();
        out.line('}');
      }
      out.line();
      out.line('// As Print shows it: each field by name, in order.');
      out.line(flavor.typed ? 'toJSON(): Record<string, unknown> {' : 'toJSON() {');
      out.line(`  return { ${type.fields.map((f) => `${JSON.stringify(f.name)}: this.${fields.get(f.id)}`).join(', ')} };`);
      out.line('}');
      out.dedent();
      out.line('}');
    }
    if (!this.esm) {
      out.line();
      out.line(`module.exports = { ${this.className} };`);
    }
    return { text: out.toString(), className: this.className, nodeLines: out.nodeLines, codeBreaks: out.breaks };
  }

  // An interface: its functions' signatures, and a tag classes that implement it carry, which its
  // type guard (what Cast To checks) looks for.
  private interfaceDeclaration(type: InterfaceInfo): void {
    const { out, flavor } = this;
    const exported = this.esm ? 'export ' : '';
    const tag = this.interfaceTag(this.className);
    const guard = this.interfaceGuard(this.className);
    const names = this.interfaceNames(type);
    out.line(flavor.typed ? `${exported}const ${tag}: unique symbol = Symbol.for(${JSON.stringify(`blueprint:${type.name}`)});` : `${exported}const ${tag} = Symbol.for(${JSON.stringify(`blueprint:${type.name}`)});`);
    out.line();
    if (flavor.typed) {
      out.line(`${exported}interface ${this.className} {`);
      out.line(`  readonly [${tag}]: true;`);
      for (const fn of type.functions) {
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => `${toIdentifier(p.name, 'camel')}: ${this.typeName(p.type)}`).join(', ');
        out.line(`  ${names.functions.get(fn.id)}(${params}): ${this.interfaceResult(fn)};`);
      }
      out.line('}');
      out.line();
    }
    out.line(`// Whether an object's class implements ${type.name} (Cast To ${type.name}).`);
    if (flavor.typed) {
      out.line(`${exported}function ${guard}(value: unknown): value is ${this.className} {`);
      out.line(`  return typeof value === "object" && value !== null && (value as { [${tag}]?: true })[${tag}] === true;`);
    } else {
      out.line('/** @param {unknown} value @returns {boolean} */');
      out.line(`${exported}function ${guard}(value) {`);
      out.line(`  return typeof value === "object" && value !== null && /** @type {Record<symbol, unknown>} */ (value)[${tag}] === true;`);
    }
    out.line('}');
    if (!this.esm) {
      out.line();
      out.line(`module.exports = { ${tag}, ${guard} };`);
    }
  }

  // An interface function's return type: none, its one output's, or an object of its outputs.
  private interfaceResult(fn: ClassInfo['functions'][number]): string {
    const outputs = fn.outputs.filter((p) => p.kind === 'data');
    if (!outputs.length) return 'void';
    if (outputs.length === 1) return this.typeName(outputs[0].type);
    const fields = resultFields(outputs);
    return `{ ${outputs.map((o) => `${fields.get(o.id)}: ${this.typeName(o.type)}`).join('; ')} }`;
  }

  // The name a struct or enum goes by in this file: its own, or its import's.
  private userTypeName(id: string): string | undefined {
    if (this.program.declaration?.type.id === id || id === `object:${this.program.className}`) return this.className;
    return this.importNames.get(id);
  }

  // A type's spelling: TypeScript's, or JSDoc's in JavaScript (where an enum value is its name).
  private mapType(type: TypeRef | undefined): string {
    if (!type) return this.flavor.mapType({ id: 'any' });
    const element = (id: string): string | undefined => {
      if (!isUserTypeId(id)) return undefined;
      if (!this.flavor.typed && this.types.get(id)?.kind === 'enum') return 'string';
      if (!this.flavor.typed && id.startsWith('interface:')) return 'any';
      return this.userTypeName(id) ?? 'unknown';
    };
    const own = element(type.id);
    const value = type.valueType && this.mapType(type.valueType);
    if (!own && !(type.valueType && isUserTypeId(type.valueType.id))) return this.flavor.mapType(type);
    const name = own ?? this.flavor.mapType({ id: type.id });
    return type.container === 'array' ? `${name}[]` : type.container === 'set' ? `Set<${name}>` : type.container === 'map' ? `Map<${name}, ${value}>` : name;
  }

  // A class member, or (in a library) a module function.
  private self(name: string): string {
    return this.library ? name : `this.${name}`;
  }

  // One import (or require) per module of project code the graph calls, sorted so that rearranging
  // the graph doesn't reorder them.
  private imports(esm: boolean): void {
    const byModule = new Map<string, IrImport[]>();
    for (const i of sortImports(this.program.imports)) {
      if (!esm && i.userType?.kind === 'class' && i.id !== this.program.classInfo?.parent) continue;
      const specifier = this.flavor.typed
        ? typescriptSpecifier(this.options.outputDir ?? '', i.path, this.options.importExtension ?? 'ts')
        : relativeSpecifier(this.options.outputDir ?? '', i.path);
      byModule.set(specifier, [...(byModule.get(specifier) ?? []), i]);
    }
    for (const [specifier, imports] of [...byModule].sort(([a], [b]) => compare(a, b))) {
      const alias = (name: string, as: string) => (name === as ? name : `${name}${esm ? ' as ' : ': '}${as}`);
      const names = [...new Set(imports.flatMap((i) => {
        const local = this.importNames.get(i.id)!;
        if (i.userType?.kind !== 'interface') return [alias(i.name, local)];
        // An interface: its tag and guard at run time.
        return [alias(this.interfaceTag(i.name), this.interfaceTag(local)), alias(this.interfaceGuard(i.name), this.interfaceGuard(local))];
      }))].join(', ');
      // An interface's type is imported as a type: Node.js strips it with the other types.
      const types = this.flavor.typed ? imports.filter((i) => i.userType?.kind === 'interface').map((i) => alias(i.name, this.importNames.get(i.id)!)) : [];
      if (types.length) this.out.line(`import type { ${types.join(', ')} } from ${JSON.stringify(specifier)};`);
      this.out.line(esm ? `import { ${names} } from ${JSON.stringify(specifier)};` : `const { ${names} } = require(${JSON.stringify(specifier)});`);
    }
    if (byModule.size) this.out.line();
  }

  // ---- Class members ------------------------------------------------------------------------

  // `internal`: private (true, or 'private'), protected, or public (false).
  private field(name: string, type: TypeRef | undefined, initial: string, internal: boolean | 'protected' | 'private'): void {
    if (this.flavor.typed) {
      this.out.line(`${modifier(internal)}${name}: ${this.typeName(type)} = ${initial};`);
    } else {
      this.out.line(`/** @type {${this.typeName(type)}} */`);
      this.out.line(`${name} = ${initial};`);
    }
  }

  // `returns` is a type, or the text of one (a function's result object).
  private method(name: string, params: { name: string; type?: TypeRef }[], returns: TypeRef | string | undefined, internal: boolean | 'protected' | 'private', body: () => void): void {
    const { out, flavor } = this;
    out.endNode();
    const returnText = typeof returns === 'string' ? returns : returns ? (flavor.typed ? this.typeName(returns) : this.mapType(returns)) : undefined;
    // In a library, methods are module functions; the library's own functions are exported.
    const keyword = this.library ? `${!internal && this.esm ? 'export ' : ''}function ` : '';
    if (flavor.typed) {
      const list = params.map((p) => `${p.name}: ${this.typeName(p.type)}`).join(', ');
      out.line(`${keyword}${this.library ? '' : modifier(internal)}${name}(${list}): ${returnText ?? 'void'} {`);
    } else {
      if (params.length || returnText) {
        out.line('/**');
        for (const p of params) out.line(` * @param {${this.mapType(p.type ?? { id: 'any' })}} ${p.name}`);
        if (returnText) out.line(` * @returns {${returnText}}`);
        out.line(' */');
      }
      out.line(`${keyword}${name}(${params.map((p) => p.name).join(', ')}) {`);
    }
    out.indent();
    body();
    out.dedent();
    out.line('}');
    out.line();
  }

  // A function graph as a method: its locals and its nodes' outputs are variables of each call.
  private functionMethod(fn: IrFunction): void {
    const scope = new NameScope(RESERVED, ['this']);
    const params = fn.params.map((p) => {
      const name = scope.claim(p.name, 'camel');
      this.paramNames.set(`${fn.id}\u0000${p.id}`, name);
      return { name, type: p.type };
    });
    const locals = this.program.members.filter((m) => m.function === fn.id);
    for (const m of locals) this.memberNames.set(m.id, scope.claim(m.name, 'camel'));
    const slots = this.program.slots.filter((x) => x.function === fn.id);
    for (const x of slots) this.slotNames.set(x.id, scope.claim(x.name));
    if (fn.description) this.out.line(`// ${fn.description.replace(/\s+/g, ' ')}`);
    this.method(this.functionNames.get(fn.id)!, params, this.resultType(fn), fn.access ?? false, () => {
      // A custom event keeps the inputs other flows read, as Unreal keeps an event's outputs.
      for (const store of fn.event?.stores ?? []) this.out.line(`${this.slotRef(store.slot)} = ${this.paramNames.get(`${fn.id}\u0000${store.param}`)};`);
      for (const m of locals) this.local(this.memberNames.get(m.id)!, m.type, this.coerce(m.initial, m.type));
      for (const x of slots) this.local(this.slotNames.get(x.id)!, x.type, this.defaultFor(x.type));
      this.statements(fn.body);
      // Reaching the end without a Return Node returns the outputs' defaults.
      if (fn.outputs.length && fn.body[fn.body.length - 1]?.kind !== 'return') this.out.line(`return ${this.result(fn, fn.outputs.map((o) => this.defaultFor(o.type)))};`);
    });
  }

  private local(name: string, type: TypeRef | undefined, initial: string): void {
    this.out.line(this.flavor.typed ? `let ${name}: ${this.typeName(type)} = ${initial};` : `let ${name} = ${initial};`);
  }

  // The interface functions the class gives no body: they do nothing and return defaults, as Unreal's
  // unimplemented interface functions do.
  private interfaceStubs(): void {
    for (const { type, stubs } of this.program.interfaces ?? []) {
      const names = this.interfaceNames(type);
      for (const fn of stubs) {
        const scope = new NameScope(RESERVED, ['this']);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => ({ name: scope.claim(p.name, 'camel'), type: p.type }));
        const outputs = fn.outputs.filter((p) => p.kind === 'data');
        this.method(names.functions.get(fn.id)!, params, outputs.length ? this.interfaceResult(fn) : undefined, false, () => {
          if (outputs.length === 1) this.out.line(`return ${this.defaultFor(outputs[0].type)};`);
          else if (outputs.length) this.out.line(`return { ${[...resultFields(outputs)].map(([id, field]) => `${field}: ${this.defaultFor(outputs.find((o) => o.id === id)?.type)}`).join(', ')} };`);
        });
      }
    }
  }

  // A function's return type: none, its one output's, or an object with a field per output.
  private resultType(fn: IrFunction): TypeRef | string | undefined {
    if (!fn.outputs.length) return undefined;
    if (fn.outputs.length === 1) return fn.outputs[0].type ?? { id: 'any' };
    const fields = this.outputFields.get(fn.id)!;
    const type = (t: TypeRef | undefined) => (this.flavor.typed ? this.typeName(t) : this.mapType(t ?? { id: 'any' }));
    return `{ ${fn.outputs.map((o) => `${fields.get(o.id)}: ${type(o.type)}`).join(this.flavor.typed ? '; ' : ', ')} }`;
  }

  // The value a function returns, from its outputs' values.
  private result(fn: IrFunction, values: string[]): string {
    if (fn.outputs.length === 1) return values[0];
    const fields = this.outputFields.get(fn.id)!;
    return `{ ${fn.outputs.map((o, i) => `${fields.get(o.id)}: ${values[i]}`).join(', ')} }`;
  }

  private slotRef(id: string): string {
    const name = this.slotNames.get(id)!;
    return this.program.slots.find((x) => x.id === id)?.function ? name : `this.${name}`;
  }

  private memberRef(id: string): string {
    const name = this.memberNames.get(id)!;
    return this.program.members.find((m) => m.id === id)?.function ? name : `this.${name}`;
  }

  private blockMethod(block: IrBlock): void {
    this.method(this.blockNames.get(block.id)!, [], undefined, true, () => this.statements(block.body));
  }

  // A code node's snippet as a method. Inputs whose ids are valid identifiers keep them, so the
  // snippet can use them by name; `${pinId}` works for every input.
  private helperMethod(helper: IrCodeHelper): void {
    const scope = new NameScope(RESERVED, ['this']);
    const params = helper.params.map((p, i) => ({
      pinId: p.pinId,
      name: /^[A-Za-z_$][\w$]*$/.test(p.pinId) && !RESERVED.has(p.pinId) ? scope.claim(p.pinId) : scope.claim(`pin${i}`),
      type: p.type
    }));
    const byPin = new Map(params.map((p) => [p.pinId, p.name]));
    const code = helper.code.replace(/\$\{([^}]+)\}/g, (_m, pin: string) => byPin.get(pin) ?? pin);
    this.method(this.helperNames.get(helper.id)!, params, helper.returns, true, () => {
      for (const line of dedent(code)) this.out.line(line);
    });
  }

  // ---- Statements ---------------------------------------------------------------------------

  private statements(statements: IrStatement[]): void {
    for (const s of statements) this.statement(s);
  }

  private statement(s: IrStatement): void {
    const { out } = this;
    if (s.kind === 'callBlock') out.endNode();
    else out.node(s.source, (text) => `// ${text}`);
    switch (s.kind) {
      case 'print':
        out.line(`console.log(${this.text(s.value)});`);
        break;
      case 'assert':
        out.line(`if (!(${this.expr(s.condition)})) throw new Error(${this.expr(s.message)});`);
        break;
      case 'store':
        out.line(`${this.slotRef(s.slot)} = ${this.expr(s.value)};`);
        break;
      case 'setMember': {
        const member = this.program.members.find((m) => m.id === s.member);
        out.line(`${this.memberRef(s.member)} = ${this.coerce(s.value, member?.type)};`);
        break;
      }
      case 'if': {
        out.line(`if (${this.expr(s.condition)}) {`);
        out.indent();
        this.statements(s.then);
        out.dedent();
        // An if in the else branch from the same node (a Switch's cases) reads as `else if`.
        let rest = s.else;
        while (rest.length === 1 && rest[0].kind === 'if' && sameSource(rest[0], s)) {
          const inner: Extract<IrStatement, { kind: 'if' }> = rest[0];
          out.line(`} else if (${this.expr(inner.condition)}) {`);
          out.indent();
          this.statements(inner.then);
          out.dedent();
          rest = inner.else;
        }
        if (rest.length) {
          out.line('} else {');
          out.indent();
          this.statements(rest);
          out.dedent();
        }
        out.line('}');
        break;
      }
      case 'for': {
        const counter = `${this.slotRef(s.counter)}`;
        const stop = s.stop ? ` && !${this.slotRef(s.stop)}` : '';
        out.line(`for (${counter} = ${this.coerce(s.first, INT)}; ${counter} <= ${this.coerce(s.last, INT)}${stop}; ${counter}++) {`);
        out.indent();
        this.statements(s.body);
        out.dedent();
        out.line('}');
        break;
      }
      case 'while':
        out.line(`while (${this.expr(s.condition)}) {`);
        out.indent();
        this.statements(s.body);
        out.dedent();
        out.line('}');
        break;
      case 'forEach': {
        // The array is read before each pass, as Unreal's For Each Loop reads it.
        const index = `${this.slotRef(s.index)}`;
        const element = this.program.slots.find((x) => x.id === s.element);
        const array = this.coerce(s.array, element?.type ? { ...element.type, container: 'array' } : undefined);
        const stop = s.stop ? ` && !${this.slotRef(s.stop)}` : '';
        out.line(`for (${index} = 0; ${index} < ${array}.length${stop}; ${index}++) {`);
        out.indent();
        out.line(`${this.slotRef(s.element)} = ${array}[${index}];`);
        this.statements(s.body);
        out.dedent();
        out.line('}');
        break;
      }
      case 'call': {
        const call = this.call(s.callee, s.args);
        if (s.results) {
          // A library function with several outputs returns an object; each field into its slot. A
          // project function's are its object's fields or its tuple's positions (docs/node-authoring.md, gap 3).
          const imported = this.program.imports.find((i) => i.id === s.callee.id);
          const code = imported?.results;
          const position = (output: string) => imported?.outputs?.findIndex((o) => o.id === output) ?? 0;
          if (code?.kind === 'tuple') {
            const targets: string[] = [];
            for (const r of s.results) targets[position(r.output)] = this.slotRef(r.slot);
            out.line(`[${Array.from({ length: code.names.length }, (_, i) => targets[i] ?? '').join(', ')}] = ${call};`);
          } else {
            const fields = code ? new Map((imported?.outputs ?? []).map((o, i) => [o.id, code.names[i]])) : resultFields(imported?.outputs ?? []);
            out.line(`({ ${s.results.map((r) => `${fields.get(r.output)}: ${this.slotRef(r.slot)}`).join(', ')} } = ${call});`);
          }
        } else out.line(s.resultSlot ? `${this.slotRef(s.resultSlot)} = ${call};` : `${call};`);
        break;
      }
      case 'callBlock':
        out.line(`this.${this.blockNames.get(s.block)}();`);
        break;
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === s.function)!;
        const call = this.functionCall(fn, s.args);
        if (!s.results.length) out.line(`${call};`);
        else if (fn.outputs.length === 1) out.line(`${this.slotRef(s.results[0].slot)} = ${call};`);
        else {
          // Each output into its slot: ({ health: this.slotA, alive: this.slotB } = this.f(...)).
          const fields = this.outputFields.get(fn.id)!;
          out.line(`({ ${s.results.map((r) => `${fields.get(r.output)}: ${this.slotRef(r.slot)}`).join(', ')} } = ${call});`);
        }
        break;
      }
      case 'delay': {
        // Node.js runs timers in the order they fall due, and waits for them before exiting.
        const ms = `${this.operand(s.duration)} * 1000`;
        if (s.generation) {
          // Retriggerable: only the latest start's countdown runs Completed.
          const generation = this.slotRef(s.generation);
          out.line(this.flavor.typed ? 'setTimeout((started: number) => {' : 'setTimeout((/** @type {number} */ started) => {');
          out.indent();
          out.line(`if (started !== ${generation}) return;`);
          this.statements(s.then);
          out.dedent();
          out.line(`}, ${ms}, ++${generation});`);
          break;
        }
        const pending = this.slotRef(s.pending!);
        out.line(`if (!${pending}) {`);
        out.indent();
        out.line(`${pending} = true;`);
        out.line('setTimeout(() => {');
        out.indent();
        out.line(`${pending} = false;`);
        this.statements(s.then);
        out.dedent();
        out.line(`}, ${ms});`);
        out.dedent();
        out.line('}');
        break;
      }
      case 'cast': {
        const local = this.userTypeName(s.type)!;
        const test = s.type.startsWith('interface:') ? `${this.interfaceGuard(local)}(${this.expr(s.value)})` : `${this.operand(s.value)} instanceof ${local}`;
        out.line(`if (${test}) {`);
        out.indent();
        out.line(`${this.slotRef(s.slot)} = ${this.flavor.typed ? `${this.operand(s.value)} as ${local}` : this.expr(s.value)};`);
        this.statements(s.succeeded);
        out.dedent();
        if (s.failed.length) {
          out.line('} else {');
          out.indent();
          this.statements(s.failed);
          out.dedent();
        }
        out.line('}');
        break;
      }
      case 'interfaceCall': {
        const fn = interfaceInfo(this.program, s.type)?.functions.find((f) => f.id === s.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const iface = interfaceInfo(this.program, s.type);
        const call = `${this.targetRef(s.target)}.${iface ? this.interfaceNames(iface).functions.get(s.function) : s.function}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        if (!s.results.length) out.line(`${call};`);
        else if (outputs.length === 1) out.line(`${this.slotRef(s.results[0].slot)} = ${call};`);
        else {
          const fields = resultFields(outputs);
          out.line(`({ ${s.results.map((r) => `${fields.get(r.output)}: ${this.slotRef(r.slot)}`).join(', ')} } = ${call});`);
        }
        break;
      }
      case 'parentCall': {
        if (s.start) {
          out.line('super.start();');
          break;
        }
        const fn = this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === s.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `super.${this.parentFunctionName(s.function!)}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        if (!s.results.length) out.line(`${call};`);
        else if (outputs.length === 1) out.line(`${this.slotRef(s.results[0].slot)} = ${call};`);
        else {
          const fields = resultFields(outputs);
          out.line(`({ ${s.results.map((r) => `${fields.get(r.output)}: ${this.slotRef(r.slot)}`).join(', ')} } = ${call});`);
        }
        break;
      }
      case 'construct':
        out.line(`${this.slotRef(s.slot)} = new ${this.userTypeName(s.type)}();`);
        out.line(`${this.slotRef(s.slot)}.start();`);
        break;
      case 'setObjectVariable':
        out.line(`${this.targetRef(s.target)}.${this.membersOf(s.type)?.variables.get(s.variable)} = ${this.coerce(s.value, classInfo(this.program, s.type)?.variables.find((v) => v.id === s.variable)?.type)};`);
        break;
      case 'objectCall': {
        const info = classInfo(this.program, s.type);
        const names = this.membersOf(s.type);
        const fn = s.function !== undefined ? info?.functions.find((f) => f.id === s.function) : undefined;
        const params = (fn ? fn.inputs : info?.events.find((e) => e.id === s.event)?.inputs ?? []).filter((p) => p.kind === 'data');
        const name = s.function !== undefined ? names?.functions.get(s.function) : names?.events.get(s.event!);
        const call = `${this.targetRef(s.target)}.${name}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        if (!s.results.length) out.line(`${call};`);
        else if (outputs.length === 1) out.line(`${this.slotRef(s.results[0].slot)} = ${call};`);
        else {
          const fields = resultFields(outputs);
          out.line(`({ ${s.results.map((r) => `${fields.get(r.output)}: ${this.slotRef(r.slot)}`).join(', ')} } = ${call});`);
        }
        break;
      }
      case 'bindEvent':
      case 'unbindAll': {
        const dispatcher = s.target && s.type ? `${this.targetRef(s.target)}.${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}` : `this.${this.dispatcherNames.get(s.dispatcher)}`;
        if (s.kind === 'unbindAll') out.line(`${dispatcher}.clear();`);
        else out.line(`${dispatcher}.${s.bind ? 'bind' : 'unbind'}(this, this.${this.functionNames.get(s.event)});`);
        break;
      }
      case 'broadcast': {
        const other = s.target && s.type ? classInfo(this.program, s.type)?.dispatchers.find((d) => d.id === s.dispatcher)?.inputs.filter((p) => p.kind === 'data') : undefined;
        const params = other ?? this.program.dispatchers?.find((d) => d.id === s.dispatcher)?.params ?? [];
        const dispatcher = s.target && s.type ? `${this.targetRef(s.target)}.${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}` : `this.${this.dispatcherNames.get(s.dispatcher)}`;
        out.line(`${dispatcher}.broadcast(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')});`);
        break;
      }
      case 'return': {
        const fn = this.program.functions.find((f) => f.id === s.source.graphId);
        if (!fn || !fn.outputs.length) out.line('return;');
        else out.line(`return ${this.result(fn, fn.outputs.map((o, i) => this.coerce(s.values[i] ?? { kind: 'default', type: o.type }, o.type)))};`);
        break;
      }
    }
  }

  // ---- Expressions --------------------------------------------------------------------------

  private expr(e: IrExpr): string {
    switch (e.kind) {
      case 'literal':
        return JSON.stringify(e.value) ?? 'null';
      case 'default':
        return this.defaultFor(e.type);
      case 'member':
        return `${this.memberRef(e.member)}`;
      case 'output':
        return `${this.slotRef(e.slot)}`;
      case 'add':
        return `${this.operand(e.left)} + ${this.operand(e.right)}`;
      case 'toNumber':
        return isNumeric(this.typeOf(e.value)) ? this.expr(e.value) : `Number(${this.expr(e.value)} ?? 0)`;
      case 'toText':
        return this.text(e.value);
      case 'concat':
        return e.parts.map((part) => this.expr(part)).join(' + ');
      case 'toBoolean':
        return this.typeOf(e.value)?.id === 'bool' && !this.typeOf(e.value)?.container ? this.expr(e.value) : `Boolean(${this.expr(e.value)})`;
      case 'call': {
        const call = this.call(e.callee, e.args);
        if (!e.output) return call;
        const imported = this.program.imports.find((i) => i.id === e.callee.id);
        return `${call}.${resultFields(imported?.outputs ?? []).get(e.output)}`;
      }
      case 'binary': {
        const op = e.op === '==' ? '===' : e.op === '!=' ? '!==' : e.op;
        return `${this.operand(e.left)} ${op} ${this.operand(e.right)}`;
      }
      case 'not':
        return `!${this.operand(e.value)}`;
      case 'param':
        return this.paramNames.get(`${e.function}\u0000${e.id}`) ?? 'undefined';
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(fn, e.args);
        return fn.outputs.length === 1 ? call : `${call}.${this.outputFields.get(fn.id)!.get(e.output)}`;
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return 'null';
        return `new ${this.userTypeName(type.id)}(${type.fields.map((f, i) => this.coerce(e.fields[i], f.type)).join(', ')})`;
      }
      case 'structField': {
        const type = this.types.get(e.type);
        return `${this.operand(e.value)}.${type?.kind === 'struct' ? typescriptFieldNames(type).get(e.field) : e.field}`;
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        return `${this.userTypeName(e.type)}.${type?.kind === 'enum' ? typescriptEnumMembers(type).get(e.value) : e.value}`;
      }
      case 'self':
        return 'this';
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, e.type);
        const fn = iface?.functions.find((f) => f.id === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}.${iface ? this.interfaceNames(iface).functions.get(e.function) : e.function}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return e.output ? `${call}.${resultFields(fn?.outputs.filter((p) => p.kind === 'data') ?? []).get(e.output)}` : call;
      }
      case 'parentCall': {
        const fn = this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const call = `super.${this.parentFunctionName(e.function)}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return e.output ? `${call}.${resultFields(fn?.outputs.filter((p) => p.kind === 'data') ?? []).get(e.output)}` : call;
      }
      case 'isValid':
        return `${this.operand(e.value)} != null`;
      case 'objectVariable':
        return `${this.targetRef(e.target)}.${this.membersOf(e.type)?.variables.get(e.variable)}`;
      case 'objectCall': {
        const fn = classInfo(this.program, e.type)?.functions.find((f) => f.id === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}.${this.membersOf(e.type)?.functions.get(e.function)}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return e.output ? `${call}.${resultFields(fn?.outputs.filter((p) => p.kind === 'data') ?? []).get(e.output)}` : call;
      }
      case 'makeContainer': {
        const element = { id: e.type.id };
        if (e.type.container === 'map') {
          const pairs: string[] = [];
          for (let i = 0; i + 1 < e.items.length; i += 2) pairs.push(`[${this.coerce(e.items[i], element)}, ${this.coerce(e.items[i + 1], e.type.valueType)}]`);
          return `new Map${this.flavor.typed ? this.containerTypeArgs(e.type) : ''}(${pairs.length ? `[${pairs.join(', ')}]` : ''})`;
        }
        const items = e.items.map((item) => this.coerce(item, element));
        if (e.type.container === 'set') return `new Set${this.flavor.typed ? this.containerTypeArgs(e.type) : ''}(${items.length ? `[${items.join(', ')}]` : ''})`;
        return this.flavor.typed && !items.length ? `[] as ${this.typeName(e.type)}` : `[${items.join(', ')}]`;
      }
    }
  }

  private functionCall(fn: IrFunction, args: IrExpr[]): string {
    return `${this.self(this.functionNames.get(fn.id)!)}(${args.map((a, i) => this.coerce(a, fn.params[i]?.type)).join(', ')})`;
  }

  private call(callee: IrCallee, args: IrExpr[]): string {
    const params = calleeSignature(callee, this.program)?.params ?? [];
    const list = args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ');
    if (callee.kind === 'helper') return `${this.self(this.helperNames.get(callee.id)!)}(${list})`;
    const local = this.importNames.get(callee.id)!;
    const member = this.program.imports.find((i) => i.id === callee.id)?.member;
    if (!member) return `${local}(${list})`;
    // A code class's member (docs/node-authoring.md, gap 2), on the Target pin's object.
    if (member.kind === 'construct') return `new ${local}(${list})`;
    const [target, ...rest] = args;
    const values = rest.map((a, i) => this.coerce(a, params[i + 1]?.type)).join(', ');
    const object = this.targetRef(target);
    return member.kind === 'get' ? `${object}.${member.name}` : member.kind === 'set' ? `${object}.${member.name} = ${values}` : `${object}.${member.name}(${values})`;
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' ? `(${text})` : text;
  }

  // The value as text, per docs/semantics.md. Strings, numbers and booleans need no helper.
  private text(e: IrExpr): string {
    const type = this.typeOf(e);
    if (type && !type.container && type.id === 'string') return this.expr(e);
    if (type && !type.container && (isNumeric(type) || type.id === 'bool')) return `String(${this.expr(e)})`;
    this.needsFormat = true;
    return `${FORMAT_HELPER}(${this.expr(e)})`;
  }

  // TypeScript needs a cast when a value of unknown type flows into a typed slot.
  private coerce(e: IrExpr, target: TypeRef | undefined): string {
    // A container default (JSON: an array, or a map's [key, value] pairs) becomes the container.
    if (e.kind === 'literal' && target?.container && Array.isArray(e.value)) return this.containerLiteral(e.value, target);
    const text = this.expr(e);
    if (!this.flavor.typed || !target || target.id === 'any') return text;
    return this.typeOf(e) ? text : `(${text} as ${this.typeName(target)})`;
  }

  private containerLiteral(value: unknown[], type: TypeRef): string {
    const json = (v: unknown) => JSON.stringify(v) ?? 'null';
    if (type.container === 'array') return this.flavor.typed && !value.length ? `[] as ${this.typeName(type)}` : `[${value.map(json).join(', ')}]`;
    const generic = this.flavor.typed ? this.containerTypeArgs(type) : '';
    if (type.container === 'set') return `new Set${generic}(${value.length ? `[${value.map(json).join(', ')}]` : ''})`;
    const pairs = value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2);
    return `new Map${generic}(${pairs.length ? `[${pairs.map(([k, v]) => `[${json(k)}, ${json(v)}]`).join(', ')}]` : ''})`;
  }

  // `<number>` for a set of numbers, `<string, number>` for a map of strings to numbers.
  private containerTypeArgs(type: TypeRef): string {
    const element = this.mapType({ id: type.id });
    return type.container === 'map' ? `<${element}, ${this.mapType(type.valueType ?? { id: 'any' })}>` : `<${element}>`;
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (type?.container === 'array') return '[]';
    if (type?.container === 'set') return 'new Set()';
    if (type?.container === 'map') return 'new Map()';
    // A struct with its fields' defaults; an enum's first value.
    const user = type && this.types.get(type.id);
    if (user?.kind === 'struct') return `new ${this.userTypeName(user.id)}()`;
    if (user?.kind === 'enum' && user.enumerators[0]) return `${this.userTypeName(user.id)}.${typescriptEnumMembers(user).get(user.enumerators[0].id)}`;
    switch (type?.id) {
      case 'bool':
        return 'false';
      case 'int':
      case 'float':
        return '0';
      case 'string':
        return '""';
      default:
        return 'null';
    }
  }

  private typeName(type: TypeRef | undefined): string {
    const name = this.mapType(type ?? { id: 'any' });
    // Object-like types start out null, so they must admit it.
    const defaultsToNull = this.defaultFor(type) === 'null' && name !== 'unknown';
    return defaultsToNull && !name.endsWith('| null') ? `${name} | null` : name;
  }

  private typeOf(e: IrExpr): TypeRef | undefined {
    const type = exprType(e, this.program);
    return type?.id === 'any' ? undefined : type;
  }

  private formatHelper(): void {
    const { out, flavor } = this;
    out.line();
    if (flavor.typed) {
      out.line(`function ${FORMAT_HELPER}(value: unknown): string {`);
    } else {
      out.line('/** @param {unknown} value @returns {string} */');
      out.line(`function ${FORMAT_HELPER}(value) {`);
    }
    out.indent();
    out.line(`if (value === null || value === undefined) return "";`);
    out.line(`if (typeof value === "string") return value;`);
    out.line(`if (typeof value === "number" || typeof value === "boolean") return String(value);`);
    // Containers print as JSON: sets in ascending order (they have no order of their own), maps as
    // objects in the order their keys were added.
    out.line(`return JSON.stringify(value, (_key, v) => v instanceof Set ? [...v].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : v instanceof Map ? Object.fromEntries(v) : v) ?? "";`);
    out.dedent();
    out.line('}');
  }
}

const INT: TypeRef = { id: 'int' };

// TypeScript's access keyword for a member: private (true, or 'private'), protected, or none.
function modifier(internal: boolean | 'protected' | 'private'): string {
  return internal === true || internal === 'private' ? 'private ' : internal === 'protected' ? 'protected ' : '';
}

function sameSource(a: IrStatement, b: IrStatement): boolean {
  return a.kind !== 'callBlock' && b.kind !== 'callBlock' && a.source.graphId === b.source.graphId && a.source.nodeId === b.source.nodeId;
}

function isNumeric(type: TypeRef | undefined): boolean {
  return !!type && !type.container && (type.id === 'int' || type.id === 'float');
}

function sortImports(imports: IrImport[]): IrImport[] {
  return [...imports].sort((a, b) => compare(a.name, b.name));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
