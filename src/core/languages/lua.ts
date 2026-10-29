// Lua pack (docs/more-languages.md, "Lua"): generates a Lua 5.4 module (one class per graph) from
// Visual IR. Containers, formatting, classes, dispatchers and the latent queue come from the support
// module (lua-runtime.ts), which generated code requires as "vgraph_runtime".
import { IrBlock, IrCallee, IrCodeHelper, IrExpr, IrFunction, IrImport, IrProgram, IrStatement, classInfo, exprType, interfaceInfo, programClassSpec, userTypes } from '../compiler/ir';
import { ClassMemberNames, ClassMemberStyles, InheritedMembers, NameScope, claimClassMembers, dedent, toIdentifier } from '../compiler/names';
import type { ClassInfo, InterfaceInfo } from '../objects';
import { CodeWriter } from '../compiler/writer';
import { CodeDebugger, CodeGenerator, CodeRunner, GenerateOptions, GeneratedCode, LanguagePack, PinExpression, RunContext } from '../language-pack';
import { scanLua } from '../importing/lua-scanner';
import { OutputPlan, PlacementContext } from '../output-plan';
import { TypeRef, parseTypeId } from '../types';
import { EnumInfo, StructInfo, UserType } from '../user-types';
import { LUA_RUNTIME_FILE, LUA_RUNTIME_MODULE, luaRuntime } from './lua-runtime';

// Snippet helpers and imports a module keeps as locals; beyond it, helpers go in one table, under
// Lua's limit of 200 locals in a chunk.
const MAX_HELPER_LOCALS = 150;

// Lua's keywords, and the globals generated code uses, which names must not hide.
const RESERVED = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat',
  'return', 'then', 'true', 'until', 'while', 'self', 'vg', 'require', 'print', 'error', 'string', 'table', 'math', 'utf8', 'os', 'io',
  'type', 'select', 'setmetatable', 'getmetatable', 'pairs', 'ipairs', 'tostring', 'tonumber', 'pcall', 'xpcall', 'rawget', 'rawset',
  'next', 'package', 'new', '__init', '__index', '_ENV', '_G'
]);

function mapType(type: TypeRef): string {
  const { name } = parseTypeId(type.id);
  if (type.container === 'array') return 'array';
  if (type.container === 'set') return 'set';
  if (type.container === 'map') return 'map';
  return ({ bool: 'boolean', int: 'integer', float: 'number', string: 'string' } as Record<string, string>)[type.id] ?? name;
}

// How a class's public members are named (src/core/compiler/names.ts).
const CLASS_STYLES: ClassMemberStyles = { functions: 'snake', variables: 'keep', dispatchers: 'keep', hiddenPrefix: '_' };

// Field keys of a struct and member names of an enum's values, the same in the type's own module and
// in every module that uses it.
export function luaFieldNames(type: StructInfo): Map<string, string> {
  const scope = new NameScope(RESERVED, ['__vg_name', '__vg_fields']);
  return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, 'snake')]));
}

export function luaEnumMembers(type: EnumInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.enumerators.map((e) => [e.id, scope.claim(e.name, 'snake').toUpperCase()]));
}

// The names a function library's functions are defined as (snake_case, unique in its module).
export function luaExportNames(functions: { id: string; name: string }[]): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(functions.map((f) => [f.id, scope.claim(f.name, 'snake')]));
}

export function luaOutputFileName(graphFileName: string): string {
  return `${toIdentifier(graphFileName.replace(/\.vgraph$/i, ''), 'snake')}_vgraph.lua`;
}

// The module name `require` loads a workspace-relative Lua file by, from the workspace folder.
export function luaModuleName(path: string): string {
  return path.replace(/\.lua$/i, '').split('/').filter((s) => s && s !== '.').join('.');
}

// Run's launcher: Start, then Main with the arguments, then the latent actions; with --test first,
// each test (a name and a method) on a new object. Errors print with "Error:" and exit with 1.
function launcher(file: { path: string }, context: RunContext | undefined): string {
  const roots = [...(context?.importRoots ?? []), dirname(file.path)];
  const module = moduleFrom(file.path, context?.importRoots ?? []);
  const searchPath = [context?.scaffoldDir ?? '.', ...roots].map((dir) => `${dir.replace(/\\/g, '/')}/?.lua`).join(';');
  return [
    '-- Built by Blueprint Visual Scripting to run generated Lua. Safe to delete.',
    `package.path = ${luaString(searchPath)} .. ";" .. package.path`,
    `local vg = require(${luaString(LUA_RUNTIME_MODULE)})`,
    `local Class = require(${luaString(module)})`,
    'local args = { ... }',
    'if args[1] == "--test" then',
    '  local failed = 0',
    '  for i = 2, #args - 1, 2 do',
    '    local ok, message = xpcall(function()',
    '      local object = Class.new()',
    '      object[args[i + 1]](object)',
    '      vg.run_latent_actions()',
    '    end, vg.message)',
    '    if ok then',
    '      print("PASS " .. args[i])',
    '    else',
    '      failed = failed + 1',
    '      print("FAIL " .. args[i] .. ": " .. message)',
    '    end',
    '  end',
    '  if failed == 0 then',
    '    print("All tests passed.")',
    '    os.exit(0)',
    '  end',
    '  print(failed .. " test(s) failed.")',
    '  os.exit(1)',
    'end',
    'local ok, message = xpcall(function()',
    '  local object = Class.new()',
    '  object:start()',
    ...(context?.mainMethod ? [`  object:${context.mainMethod}(vg.array(table.unpack(args)))`] : []),
    '  vg.run_latent_actions()',
    'end, vg.message)',
    'if not ok then',
    '  io.stdout:flush()',
    '  io.stderr:write("Error: " .. message .. "\\n")',
    '  os.exit(1)',
    'end',
    ''
  ].join('\n');
}

// The module name of the generated file: its path from the first import root that holds it.
function moduleFrom(filePath: string, roots: string[]): string {
  const file = filePath.replace(/\\/g, '/');
  for (const root of roots) {
    const prefix = `${root.replace(/\\/g, '/').replace(/\/$/, '')}/`;
    if (file.toLowerCase().startsWith(prefix.toLowerCase())) return luaModuleName(file.slice(prefix.length));
  }
  return luaModuleName(file.split('/').pop() ?? file);
}

function dirname(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '');
}

const luaRunner: CodeRunner = {
  commands: () => [['lua'], ['lua5.4'], ['lua54']],
  scaffold: (file, _className, context) => ({ [LUA_RUNTIME_FILE]: luaRuntime(), 'run.lua': launcher(file, context) }),
  args: (_file, _className, context) => [`${context?.scaffoldDir}/run.lua`, ...(context?.args ?? [])],
  testArgs: (_file, _className, context) => [`${context.scaffoldDir}/run.lua`, '--test', ...context.tests.flatMap((t) => [t.name, t.method])],
  missingToolMessage: 'Lua 5.4 was not found. Install Lua 5.4 and make sure `lua` is on the PATH.'
};

// Generated modules require the support module, and each other, by their path from the workspace
// folder, so the extension keeps one copy of it there while the workspace has Lua graphs.
export function luaPlacement(context: PlacementContext): OutputPlan {
  const ours = context.readFile(LUA_RUNTIME_FILE)?.startsWith('-- Support code for Lua generated by Blueprint Visual Scripting') ?? false;
  if (!context.generatedFiles.length) return ours ? { ownedFiles: [{ path: LUA_RUNTIME_FILE, text: '' }] } : {};
  return { ownedFiles: [{ path: LUA_RUNTIME_FILE, text: luaRuntime() }] };
}

// Lua Debug (actboy168.lua-debug) runs Run's launcher under its own Lua 5.4, or the runCommands
// setting's.
const luaDebugger: CodeDebugger = {
  type: 'lua',
  extension: { id: 'actboy168.lua-debug', name: 'Lua Debug' },
  configuration: (_file, _className, context) => ({
    type: 'lua', request: 'launch', name: 'Debug Graph', program: `${context.scaffoldDir}/run.lua`, arg: context.args ?? [], cwd: context.cwd,
    luaVersion: 'lua54', stopOnEntry: false, console: 'internalConsole',
    ...(context.command?.length === 1 ? { luaexe: context.command[0] } : {})
  }),
  // Lua Debug writes a float with a point (30.0); the graph shows 30.
  displayValue: (text) => (/^-?\d+\.0$/.test(text) ? text.slice(0, -2) : text)
};

const luaGenerator: CodeGenerator = {
  libraryExports: (_name, functions) => ({ names: luaExportNames(functions) }),
  snippetLanguages: ['lua'],
  importLanguages: ['lua'],
  outputFileName: luaOutputFileName,
  moduleName: (generatedFileName) => luaModuleName(generatedFileName),
  placement: luaPlacement,
  generate: (program, options) => new LuaEmitter(program, options).emit(),
  runner: luaRunner,
  debugger: luaDebugger
};

export const luaPack: LanguagePack = {
  id: 'lua',
  displayName: 'Lua',
  generatedFileExtension: '.lua',
  workspaceMarkers: ['**/.luarc.json', '**/*.rockspec', '**/.luacheckrc'],
  capabilities: { staticTyping: false, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true, containers: ['array', 'set', 'map'], delegates: true },
  mapType,
  generator: luaGenerator,
  // Module functions marked ---@blueprint (LuaLS annotations give their types).
  importer: { extensions: ['.lua'], scan: scanLua }
};

class LuaEmitter {
  private tests: { name: string; method: string }[] = [];
  private readonly out = new CodeWriter('  ');
  // The class's members (or a library's functions), as fields of its table.
  private readonly names: NameScope;
  // Locals of the module: the support module, imports, helpers.
  private readonly moduleScope: NameScope;
  private readonly library: boolean;
  private readonly className: string;
  private readonly memberNames = new Map<string, string>();
  private readonly slotNames = new Map<string, string>();
  private readonly helperNames = new Map<string, string>();
  private readonly blockNames = new Map<string, string>();
  private readonly functionNames = new Map<string, string>();
  private readonly dispatcherNames = new Map<string, string>();
  private readonly paramNames = new Map<string, string>();
  // An import's local (its module's, for a project function; the type's, for a struct or class).
  private readonly importNames = new Map<string, string>();
  private readonly moduleLocals = new Map<string, string>();
  // A module with many snippet helpers keeps them in one table, its name here: Lua allows 200 locals
  // in a chunk.
  private readonly helperTable: string | undefined;
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
    this.moduleScope = new NameScope(RESERVED, [this.className, 'M']);
    for (const i of program.imports) {
      const module = this.importModule(i);
      if (i.userType) {
        this.importNames.set(i.id, this.moduleScope.claim(i.userType.name, 'pascal'));
        continue;
      }
      if (!this.moduleLocals.has(module)) this.moduleLocals.set(module, this.moduleScope.claim(module.split('.').pop() ?? module, 'snake'));
      // A class's members: the module's table itself when the module returns the class (no name).
      this.importNames.set(i.id, i.name ? `${this.moduleLocals.get(module)}.${i.name}` : this.moduleLocals.get(module)!);
    }
    const internal = program.ancestors?.length ? `_${toIdentifier(program.className, 'snake')}_` : '_';
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'keep', internal));
    for (const b of program.blocks) this.blockNames.set(b.id, this.library ? this.moduleScope.claim(b.name, 'snake') : this.names.claim(b.name, 'snake', internal));
    this.helperTable = program.helpers.length + this.moduleLocals.size > MAX_HELPER_LOCALS ? this.moduleScope.claim('vg_helpers', 'snake') : undefined;
    const helperScope = new NameScope(RESERVED);
    for (const h of program.helpers) {
      this.helperNames.set(h.id, this.helperTable ? `${this.helperTable}.${helperScope.claim(h.name, 'snake')}` : this.moduleScope.claim(h.name, 'snake'));
    }
  }

  emit(): GeneratedCode {
    if (this.program.declaration) return this.emitDeclaration();
    const body = this.out;
    if (this.library) {
      // A library: functions of its module table; shared blocks are its locals, declared first.
      const blocks = [...this.blockNames.values()];
      if (blocks.length) body.line(`local ${blocks.join(', ')}`);
      for (const fn of this.program.functions) this.functionMethod(fn);
      for (const block of this.program.blocks) this.blockMethod(block);
      body.trimTrailingBlank();
      return this.finish('M');
    }
    const parent = this.program.classInfo?.parent;
    for (const { type } of this.program.interfaces ?? []) body.line(`${this.className}.__vg_interfaces[${this.userTypeName(type.id)}] = true`);
    if (this.program.interfaces?.length) body.line();
    const fields = [
      ...this.program.members.filter((m) => !m.function).map((m) => ({ name: this.memberNames.get(m.id)!, initial: this.value(m.initial, m.type) })),
      ...(this.program.dispatchers ?? []).map((d) => ({ name: this.dispatcherNames.get(d.id)!, initial: 'vg.dispatcher()' })),
      ...this.program.slots.filter((x) => !x.function).map((x) => ({ name: this.slotNames.get(x.id)!, initial: this.defaultFor(x.type) }))
    ];
    // new() makes an object; __init sets its fields, its parent's first.
    body.line(`function ${this.className}.new()`);
    body.line(`  local self = setmetatable({}, ${this.className})`);
    body.line('  self:__init()');
    body.line('  return self');
    body.line('end');
    body.line();
    this.method('__init', [], () => {
      if (parent) body.line(`${this.userTypeName(parent)}.__init(self)`);
      for (const f of fields) body.line(`self.${f.name} = ${f.initial}`);
    });
    // A subclass without Start nodes keeps its parent's start, as Unreal keeps BeginPlay.
    if (!parent || this.program.hasStart) this.method('start', [], () => this.statements(this.program.start));
    for (const fn of this.program.functions) this.functionMethod(fn);
    for (const { type, stubs } of this.program.interfaces ?? []) {
      for (const fn of stubs) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => scope.claim(p.name, 'snake'));
        const outputs = fn.outputs.filter((p) => p.kind === 'data');
        this.method(this.interfaceNames(type).functions.get(fn.id)!, params, () => {
          if (outputs.length) body.line(`return ${outputs.map((o) => this.defaultFor(o.type)).join(', ')}`);
        });
      }
    }
    this.tests = (this.program.tests ?? []).map((t) => ({ name: t.name, method: this.names.claim(`test ${t.name}`, 'snake') }));
    this.program.tests?.forEach((t, i) => this.method(this.tests[i].method, [], () => this.statements(t.body)));
    for (const block of this.program.blocks) this.blockMethod(block);
    body.trimTrailingBlank();
    return this.finish(this.className);
  }

  // A structure (values made by new(), never changed: Set Members makes a new one), an enumeration
  // (a table of its values, which are their names) or an interface.
  private emitDeclaration(): GeneratedCode {
    const body = this.out;
    const declaration = this.program.declaration!;
    if (declaration.kind === 'interface') {
      body.line(`local ${this.className} = vg.interface(${luaString(declaration.type.name)})`);
      return this.finish(this.className, false);
    }
    if (declaration.kind === 'enum') {
      const members = luaEnumMembers(declaration.type);
      body.line(`local ${this.className} = {`);
      declaration.type.enumerators.forEach((e, i) => body.line(`  ${members.get(e.id)} = ${luaString(e.name)}${i < declaration.type.enumerators.length - 1 ? ',' : ''}`));
      body.line('}');
      return this.finish(this.className, false);
    }
    const type = declaration.type;
    const keys = luaFieldNames(type);
    body.line(`local ${this.className} = vg.struct(${luaString(type.name)}, { ${type.fields.map((f) => `{ ${luaString(f.name)}, ${luaString(keys.get(f.id)!)} }`).join(', ')} })`);
    body.line();
    const params = type.fields.map((f) => keys.get(f.id)!);
    body.line(`function ${this.className}.new(${params.join(', ')})`);
    body.indent();
    type.fields.forEach((f, i) => body.line(`if ${params[i]} == nil then ${params[i]} = ${this.value(declaration.initial[i], f.type)} end`));
    body.line(`return setmetatable({ ${params.map((p) => `${p} = ${p}`).join(', ')} }, ${this.className})`);
    body.dedent();
    body.line('end');
    return this.finish(this.className, false);
  }

  // The module around the body: header, the module table (recorded as loaded first, so two modules
  // that require each other both load), requires and helpers, then the body.
  private finish(table: string, isClass = !this.library && !this.program.declaration): GeneratedCode {
    const header = new CodeWriter('  ');
    header.line(`-- Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    header.line('-- Do not edit: changes are overwritten when the graph is compiled.');
    header.line();
    header.line(`local vg = require(${luaString(LUA_RUNTIME_MODULE)})`);
    const parent = this.program.classInfo?.parent;
    if (this.program.declaration?.kind === 'struct' || this.program.declaration?.kind === 'enum') {
      // Types are defined below; nothing to record first.
    } else if (this.library) {
      header.line('local M = {}');
    } else {
      header.line(`local ${this.className} = vg.class(${luaString(this.program.className)})`);
    }
    if (isClass || this.library) header.line(`if ... then package.loaded[...] = ${table} end`);
    const requires = new Map<string, string>();
    for (const i of this.program.imports) requires.set(this.importModule(i), i.userType ? this.importNames.get(i.id)! : this.moduleLocals.get(this.importModule(i))!);
    const sorted = [...requires].sort(([, a], [, b]) => compare(a, b));
    if (sorted.length) {
      header.line();
      for (const [module, local] of sorted) header.line(`local ${local} = require(${luaString(module)})`);
    }
    // The parent's functions are this class's too, unless it has its own.
    if (parent) header.line(`setmetatable(${this.className}, { __index = ${this.userTypeName(parent)} })`);
    if (this.program.helpers.length) {
      header.line();
      if (this.helperTable) header.line(`local ${this.helperTable} = {}`);
      for (const helper of this.program.helpers) this.helperFunction(header, helper);
      header.trimTrailingBlank();
    }
    header.line();
    const headerText = header.toString();
    const offset = headerText.split('\n').length - 1;
    const main = this.program.functions.find((f) => f.event?.entry === 'Main');
    const mainName = main && this.functionNames.get(main.id);
    return {
      text: `${headerText}${this.out.toString()}\nreturn ${table}\n`,
      className: this.className,
      nodeLines: this.out.nodeLines.map((n) => ({ ...n, line: n.line + offset })),
      codeBreaks: this.out.breaks.map((line) => line + offset),
      // Modules are required by their path from the workspace folder.
      importRoots: [''],
      ...(mainName ? { mainMethod: mainName } : {}),
      ...this.pinExpressions(),
      ...(this.tests.length ? { tests: this.tests } : {})
    };
  }

  private pinExpressions(): { pinExpressions?: PinExpression[] } {
    const pins = (this.program.pinValues ?? []).map((p) => ({ graphId: p.graphId, nodeId: p.nodeId, pinId: p.pinId, expression: this.expr(p.value) }));
    return pins.length ? { pinExpressions: pins } : {};
  }

  // The module `require` loads an import from: a type's generated file, or a project module.
  private importModule(i: IrImport): string {
    const source = i.userType?.source;
    if (source) return source.module ?? luaModuleName(source.generatedPath);
    return i.module ?? luaModuleName(i.path);
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

  private parentFunctionName(name: string): string | undefined {
    for (const ancestor of this.program.ancestors ?? []) {
      const fn = ancestor.functions.find((f) => f.name === name);
      if (fn) return this.membersOf(ancestor.id)?.functions.get(fn.id);
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

  // A method of the class (`Class:name`), or a function of a library's module (`M.name`).
  private method(name: string, params: string[], body: () => void): void {
    this.out.endNode();
    this.out.line(`function ${this.library ? 'M.' : `${this.className}:`}${name}(${params.join(', ')})`);
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
    for (const x of slots) this.slotNames.set(x.id, scope.claim(x.name));
    this.method(this.functionNames.get(fn.id)!, params, () => {
      if (fn.description) this.out.line(`-- ${fn.description.replace(/\s+/g, ' ')}`);
      for (const store of fn.event?.stores ?? []) this.out.line(`${this.slotRef(store.slot)} = ${this.paramNames.get(`${fn.id}\u0000${store.param}`)}`);
      for (const m of locals) this.out.line(`local ${this.memberNames.get(m.id)} = ${this.value(m.initial, m.type)}`);
      for (const x of slots) this.out.line(`local ${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)}`);
      this.statements(fn.body);
      // Reaching the end without a Return Node returns the outputs' defaults.
      if (fn.outputs.length && fn.body[fn.body.length - 1]?.kind !== 'return') this.out.line(`return ${fn.outputs.map((o) => this.defaultFor(o.type)).join(', ')}`);
    });
  }

  private blockMethod(block: IrBlock): void {
    const name = this.blockNames.get(block.id)!;
    if (!this.library) {
      this.method(name, [], () => this.statements(block.body));
      return;
    }
    this.out.endNode();
    this.out.line(`${name} = function()`);
    this.out.indent();
    this.statements(block.body);
    this.out.dedent();
    this.out.line('end');
    this.out.line();
  }

  // A code node's snippet as a local function; inputs that are valid names keep their ids.
  private helperFunction(out: CodeWriter, helper: IrCodeHelper): void {
    const scope = new NameScope(RESERVED);
    const params = helper.params.map((p, i) => ({
      pinId: p.pinId,
      name: /^[A-Za-z_]\w*$/.test(p.pinId) && !RESERVED.has(p.pinId) ? scope.claim(p.pinId) : scope.claim(`pin${i}`)
    }));
    const byPin = new Map(params.map((p) => [p.pinId, p.name]));
    const code = helper.code.replace(/\$\{([^}]+)\}/g, (_m, pin: string) => byPin.get(pin) ?? pin);
    out.line(`${this.helperTable ? '' : 'local '}function ${this.helperNames.get(helper.id)}(${params.map((p) => p.name).join(', ')})`);
    out.indent();
    for (const line of dedent(code)) out.line(line);
    out.dedent();
    out.line('end');
    out.line();
  }

  private slotRef(id: string): string {
    const name = this.slotNames.get(id)!;
    return this.program.slots.find((x) => x.id === id)?.function ? name : `self.${name}`;
  }

  private memberRef(id: string): string {
    const name = this.memberNames.get(id)!;
    return this.program.members.find((m) => m.id === id)?.function ? name : `self.${name}`;
  }

  private dispatcherRef(s: { dispatcher: string; target?: IrExpr; type?: string }): string {
    if (s.target && s.type) return `${this.targetRef(s.target)}.${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}`;
    return `self.${this.dispatcherNames.get(s.dispatcher)}`;
  }

  private targetRef(e: IrExpr): string {
    return e.kind === 'self' ? 'self' : this.operand(e);
  }

  // ---- Statements ---------------------------------------------------------------------------

  private statements(statements: IrStatement[]): void {
    statements.forEach((s, i) => this.statement(s, i === statements.length - 1));
  }

  // Lua's `return` must end its block, so one with statements after it is wrapped in do ... end.
  private statement(s: IrStatement, last: boolean): void {
    const { out } = this;
    if (s.kind === 'callBlock') out.endNode();
    else out.node(s.source, (text) => `-- ${text}`);
    const line = (text: string) => out.line(text.startsWith('(') ? `;${text}` : text);
    switch (s.kind) {
      case 'print':
        line(`print(${this.text(s.value)})`);
        break;
      case 'assert':
        line(`if not (${this.expr(s.condition)}) then error(${this.expr(s.message)}, 0) end`);
        break;
      case 'store':
        line(`${this.slotRef(s.slot)} = ${this.expr(s.value)}`);
        break;
      case 'setMember':
        line(`${this.memberRef(s.member)} = ${this.value(s.value, this.program.members.find((m) => m.id === s.member)?.type)}`);
        break;
      case 'if': {
        line(`if ${this.expr(s.condition)} then`);
        this.block(s.then);
        let rest = s.else;
        while (rest.length === 1 && rest[0].kind === 'if' && sameSource(rest[0], s)) {
          const inner: Extract<IrStatement, { kind: 'if' }> = rest[0];
          out.line(`elseif ${this.expr(inner.condition)} then`);
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
        // Last Index is read before each pass, as Unreal reads it.
        const counter = this.slotRef(s.counter);
        out.line(`${counter} = ${this.expr(s.first)}`);
        out.line(`while ${counter} <= ${this.operand(s.last)}${s.stop ? ` and not ${this.slotRef(s.stop)}` : ''} do`);
        out.indent();
        this.statements(s.body);
        out.line(`${counter} = ${counter} + 1`);
        out.dedent();
        out.line('end');
        break;
      }
      case 'forEach': {
        const index = this.slotRef(s.index);
        const array = this.operand(s.array);
        out.line(`${index} = 0`);
        out.line(`while ${index} < ${array}.n${s.stop ? ` and not ${this.slotRef(s.stop)}` : ''} do`);
        out.indent();
        out.line(`${this.slotRef(s.element)} = ${array}[${index} + 1]`);
        this.statements(s.body);
        out.line(`${index} = ${index} + 1`);
        out.dedent();
        out.line('end');
        break;
      }
      case 'while':
        line(`while ${this.expr(s.condition)} do`);
        this.block(s.body);
        out.line('end');
        break;
      case 'call': {
        const call = this.call(s.callee, s.args);
        if (s.results) line(`${s.results.map((r) => this.slotRef(r.slot)).join(', ')} = ${call}`);
        else line(s.resultSlot ? `${this.slotRef(s.resultSlot)} = ${call}` : call);
        break;
      }
      case 'callBlock':
        line(this.library ? `${this.blockNames.get(s.block)}()` : `self:${this.blockNames.get(s.block)}()`);
        break;
      case 'callFunction': {
        const call = this.functionCall(s.function, s.args);
        line(s.results.length ? `${s.results.map((r) => this.slotRef(r.slot)).join(', ')} = ${call}` : call);
        break;
      }
      case 'bindEvent':
        line(`${this.dispatcherRef(s)}:${s.bind ? 'bind' : 'unbind'}(self, ${this.className}.${this.functionNames.get(s.event)})`);
        break;
      case 'unbindAll':
        line(`${this.dispatcherRef(s)}:clear()`);
        break;
      case 'broadcast':
        line(`${this.dispatcherRef(s)}:broadcast(${s.args.map((a) => this.expr(a)).join(', ')})`);
        break;
      case 'await': {
        // An async function (docs/node-authoring.md, gap 4): a coroutine the latent queue resumes;
        // Completed runs with what it returns.
        line(`vg.await_latent(function() return ${this.call(s.callee, s.args)} end, function(value)`);
        out.indent();
        if (s.resultSlot) line(`${this.slotRef(s.resultSlot)} = value`);
        this.statements(s.then);
        out.dedent();
        line('end)');
        break;
      }
      case 'delay': {
        if (s.generation) {
          // Retriggerable: only the latest start's countdown runs Completed.
          const generation = this.slotRef(s.generation);
          out.line(`${generation} = ${generation} + 1`);
          out.line('do');
          out.indent();
          out.line(`local started = ${generation}`);
          out.line(`vg.delay(${this.expr(s.duration)}, function()`);
          out.indent();
          out.line(`if started ~= ${generation} then return end`);
          this.statements(s.then);
          out.dedent();
          out.line('end)');
          out.dedent();
          out.line('end');
        } else {
          const pending = this.slotRef(s.pending!);
          out.line(`if not ${pending} then`);
          out.indent();
          out.line(`${pending} = true`);
          out.line(`vg.delay(${this.expr(s.duration)}, function()`);
          out.indent();
          out.line(`${pending} = false`);
          this.statements(s.then);
          out.dedent();
          out.line('end)');
          out.dedent();
          out.line('end');
        }
        break;
      }
      case 'cast':
        line(`if vg.is_a(${this.expr(s.value)}, ${this.userTypeName(s.type)}) then`);
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
        const call = `${this.targetRef(s.target)}:${iface ? this.interfaceNames(iface).functions.get(s.function) : s.function}(${s.args.map((a) => this.expr(a)).join(', ')})`;
        line(s.results.length ? `${s.results.map((r) => this.slotRef(r.slot)).join(', ')} = ${call}` : call);
        break;
      }
      case 'parentCall': {
        const parent = this.userTypeName(this.program.classInfo!.parent!);
        if (s.start) {
          line(`${parent}.start(self)`);
          break;
        }
        const call = `${parent}.${this.parentFunctionName(s.function!)}(${['self', ...s.args.map((a) => this.expr(a))].join(', ')})`;
        line(s.results.length ? `${s.results.map((r) => this.slotRef(r.slot)).join(', ')} = ${call}` : call);
        break;
      }
      case 'construct':
        line(`${this.slotRef(s.slot)} = ${this.userTypeName(s.type)}.new()`);
        line(`${this.slotRef(s.slot)}:start()`);
        break;
      case 'setObjectVariable':
        line(`${this.targetRef(s.target)}.${this.membersOf(s.type)?.variables.get(s.variable)} = ${this.value(s.value, classInfo(this.program, s.type)?.variables.find((v) => v.id === s.variable)?.type)}`);
        break;
      case 'objectCall': {
        const names = this.membersOf(s.type);
        const name = s.function !== undefined ? names?.functions.get(s.function) : names?.events.get(s.event!);
        const call = `${this.targetRef(s.target)}:${name}(${s.args.map((a) => this.expr(a)).join(', ')})`;
        line(s.results.length ? `${s.results.map((r) => this.slotRef(r.slot)).join(', ')} = ${call}` : call);
        break;
      }
      case 'return': {
        const fn = this.program.functions.find((f) => f.id === s.source.graphId);
        const values = fn?.outputs.length ? ` ${fn.outputs.map((o, i) => (s.values[i] ? this.value(s.values[i], o.type) : this.defaultFor(o.type))).join(', ')}` : '';
        line(last ? `return${values}` : `do return${values} end`);
        break;
      }
    }
  }

  private block(statements: IrStatement[]): void {
    this.out.indent();
    this.statements(statements);
    this.out.dedent();
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
        return `vg.to_number(${this.expr(e.value)})`;
      case 'toText':
        return this.text(e.value);
      case 'concat':
        return e.parts.map((part) => this.operand(part)).join(' .. ');
      case 'toBoolean': {
        const type = this.typeOf(e.value);
        if (type?.id === 'bool' && !type.container) return this.expr(e.value);
        return `vg.to_boolean(${this.expr(e.value)})`;
      }
      case 'call': {
        const call = this.call(e.callee, e.args);
        if (!e.output) return call;
        const imported = this.program.imports.find((i) => i.id === e.callee.id);
        return nth(call, (imported?.outputs?.findIndex((o) => o.id === e.output) ?? 0) + 1);
      }
      case 'binary': {
        const op = e.op === '&&' ? 'and' : e.op === '||' ? 'or' : e.op === '!=' ? '~=' : e.op;
        return `${this.operand(e.left)} ${op} ${this.operand(e.right)}`;
      }
      case 'not':
        return `not ${this.operand(e.value)}`;
      case 'param':
        return this.paramNames.get(`${e.function}\u0000${e.id}`) ?? 'nil';
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(e.function, e.args);
        return fn.outputs.length === 1 ? call : nth(call, fn.outputs.findIndex((o) => o.id === e.output) + 1);
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return 'nil';
        return `${this.userTypeName(type.id)}.new(${type.fields.map((f, i) => this.value(e.fields[i], f.type)).join(', ')})`;
      }
      case 'structField': {
        const type = this.types.get(e.type);
        return `${this.operand(e.value)}.${type?.kind === 'struct' ? luaFieldNames(type).get(e.field) : e.field}`;
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        return `${this.userTypeName(e.type)}.${type?.kind === 'enum' ? luaEnumMembers(type).get(e.value) : e.value}`;
      }
      case 'self':
        return 'self';
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, e.type);
        const outputs = iface?.functions.find((f) => f.id === e.function)?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}:${iface ? this.interfaceNames(iface).functions.get(e.function) : e.function}(${e.args.map((a) => this.expr(a)).join(', ')})`;
        return e.output && outputs.length > 1 ? nth(call, outputs.findIndex((o) => o.id === e.output) + 1) : call;
      }
      case 'parentCall': {
        const fn = this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === e.function);
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const parent = this.userTypeName(this.program.classInfo!.parent!);
        const call = `${parent}.${this.parentFunctionName(e.function)}(${['self', ...e.args.map((a) => this.expr(a))].join(', ')})`;
        return e.output && outputs.length > 1 ? nth(call, outputs.findIndex((o) => o.id === e.output) + 1) : call;
      }
      case 'isValid':
        return `${this.operand(e.value)} ~= nil`;
      case 'objectVariable':
        return `${this.targetRef(e.target)}.${this.membersOf(e.type)?.variables.get(e.variable)}`;
      case 'objectCall': {
        const fn = classInfo(this.program, e.type)?.functions.find((f) => f.id === e.function);
        const call = `${this.targetRef(e.target)}:${this.membersOf(e.type)?.functions.get(e.function)}(${e.args.map((a) => this.expr(a)).join(', ')})`;
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        return e.output && outputs.length > 1 ? nth(call, outputs.findIndex((o) => o.id === e.output) + 1) : call;
      }
      case 'makeContainer':
        return `vg.${e.type.container === 'map' ? 'map' : e.type.container === 'set' ? 'set' : 'array'}(${e.items.map((item) => this.expr(item)).join(', ')})`;
    }
  }

  private functionCall(id: string, args: IrExpr[]): string {
    const name = this.functionNames.get(id)!;
    const list = args.map((a) => this.expr(a)).join(', ');
    return this.library ? `M.${name}(${list})` : `self:${name}(${list})`;
  }

  private call(callee: IrCallee, args: IrExpr[]): string {
    const list = args.map((a) => this.expr(a)).join(', ');
    if (callee.kind === 'helper') return `${this.helperNames.get(callee.id)}(${list})`;
    const member = this.program.imports.find((i) => i.id === callee.id)?.member;
    if (!member) return `${this.importNames.get(callee.id)}(${list})`;
    // A class's member (docs/node-authoring.md, gap 2): methods are called with `:`, passing the object.
    if (member.kind === 'construct') return `${this.importNames.get(callee.id)}.${member.name ?? 'new'}(${list})`;
    const [target, ...rest] = args;
    const object = this.expr(target);
    const values = rest.map((a) => this.expr(a)).join(', ');
    return member.kind === 'get' ? `${object}.${member.name}` : member.kind === 'set' ? `${object}.${member.name} = ${values}` : `${object}:${member.name}(${values})`;
  }

  // An expression for a member or slot of `type`: a container default (JSON: an array, or a map's
  // [key, value] pairs) becomes the container.
  private value(e: IrExpr, type: TypeRef | undefined): string {
    if (e.kind !== 'literal' || !type?.container || !Array.isArray(e.value)) return this.expr(e);
    if (type.container === 'map') {
      const pairs = e.value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2);
      return `vg.map(${pairs.map(([k, v]) => `${literal(k)}, ${literal(v)}`).join(', ')})`;
    }
    return `vg.${type.container === 'set' ? 'set' : 'array'}(${e.value.map(literal).join(', ')})`;
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' || e.kind === 'not' || e.kind === 'concat' ? `(${text})` : text;
  }

  // The value as text, per docs/semantics.md. Only strings print as they are.
  private text(e: IrExpr): string {
    const type = this.typeOf(e);
    if (type && !type.container && type.id === 'string') return this.expr(e);
    return `vg.format(${this.expr(e)})`;
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (type?.container === 'array') return 'vg.array()';
    if (type?.container === 'set') return 'vg.set()';
    if (type?.container === 'map') return 'vg.map()';
    const user = type && this.types.get(type.id);
    if (user?.kind === 'struct') return `${this.userTypeName(user.id)}.new()`;
    if (user?.kind === 'enum' && user.enumerators[0]) return `${this.userTypeName(user.id)}.${luaEnumMembers(user).get(user.enumerators[0].id)}`;
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

// The nth value a call returns (Lua returns several outputs as several values).
function nth(call: string, n: number): string {
  return n <= 1 ? `(${call})` : `(select(${n}, ${call}))`;
}

// A JSON value as a Lua literal.
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : value !== value ? '(0 / 0)' : value > 0 ? 'math.huge' : '-math.huge';
  if (typeof value === 'string') return luaString(value);
  if (Array.isArray(value)) return `vg.array(${value.map(literal).join(', ')})`;
  return 'nil';
}

// A Lua string literal: UTF-8 as it is, control characters escaped.
export function luaString(text: string): string {
  return `"${text.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => (c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\${c.charCodeAt(0).toString().padStart(3, '0')}`))}"`;
}

function sameSource(a: IrStatement, b: IrStatement): boolean {
  return a.kind !== 'callBlock' && b.kind !== 'callBlock' && a.source.graphId === b.source.graphId && a.source.nodeId === b.source.nodeId;
}

function isNumeric(type: TypeRef | undefined): boolean {
  return !!type && !type.container && (type.id === 'int' || type.id === 'float');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
