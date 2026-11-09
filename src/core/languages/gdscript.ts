// GDScript pack (docs/more-languages.md, "GDScript"): generates a Godot 4 script (one class per
// graph) from Visual IR. Scripts preload each other by relative path, and the support script
// (gdscript-runtime.ts) by its name: a copy goes next to every generated file. GDScript has no
// exceptions, so a failure is recorded (vg.fail) and generated code returns after any statement that
// may have failed.
import { IrBlock, IrCallee, IrCodeHelper, IrExpr, IrFunction, IrImport, IrProgram, IrStatement, canComplete, classInfo, exprType, interfaceInfo, programClassSpec, userTypes, broadcastParams, calleeSignature, targetCallParams } from '../compiler/ir';
import { relativeSpecifier } from '../compiler/module-paths';
import { ClassMemberNames, ClassMemberStyles, InheritedMembers, NameScope, claimClassMembers, dedent, toIdentifier } from '../compiler/names';
import type { ClassInfo, InterfaceInfo } from '../objects';
import { CodeWriter } from '../compiler/writer';
import { CodeDebugger, CodeGenerator, CodeRunner, GenerateOptions, GeneratedCode, LanguagePack, PinExpression, RunContext } from '../language-pack';
import { scanGdscript } from '../importing/gdscript-scanner';
import { OutputPlan, PlacementContext } from '../output-plan';
import { LANGUAGE_TERMS } from '../terms';
import { TypeRef, parseTypeId } from '../types';
import { EnumInfo, StructInfo, UserType } from '../user-types';
import { GDSCRIPT_RUNTIME_FILE, gdscriptRuntime } from './gdscript-runtime';

// GDScript's keywords, built-in functions and constants, and Object's methods: names must not hide them.
const RESERVED = new Set([
  'if', 'elif', 'else', 'for', 'while', 'match', 'when', 'break', 'continue', 'pass', 'return', 'class', 'class_name', 'extends', 'is', 'in',
  'as', 'self', 'super', 'signal', 'func', 'static', 'const', 'enum', 'var', 'breakpoint', 'preload', 'await', 'yield', 'assert', 'void',
  'PI', 'TAU', 'INF', 'NAN', 'true', 'false', 'null', 'and', 'or', 'not', 'vg', 'print', 'printerr', 'str', 'len', 'range', 'load',
  'typeof', 'int', 'float', 'bool', 'String', 'Array', 'Dictionary', 'Object', 'RefCounted', 'abs', 'absf', 'absi', 'min', 'max', 'mini',
  'maxi', 'minf', 'maxf', 'floor', 'floori', 'ceil', 'ceili', 'round', 'sqrt', 'pow', 'fmod', 'is_nan', 'is_inf', 'randf', 'randi_range',
  'clamp', 'clampf', 'sign', 'get', 'set', 'call', 'callv', 'connect', 'disconnect', 'emit_signal', 'free', 'notification', 'to_string',
  'get_class', 'is_class', 'has_method', 'get_script', 'set_script', 'get_meta', 'set_meta', 'new', 'start', '_init', 'vg_interfaces',
  'vg_fields', 'vg_kind', 'is_instance_of',
  // @GlobalScope's and GDScript's functions, which a method of the same name can't be called past.
  'acos', 'acosh', 'angle_difference', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'bezier_derivative', 'bezier_interpolate', 'bytes_to_var',
  'ceilf', 'clampi', 'cos', 'cosh', 'cubic_interpolate', 'db_to_linear', 'deg_to_rad', 'ease', 'error_string', 'exp', 'floorf', 'fposmod',
  'hash', 'instance_from_id', 'inverse_lerp', 'is_equal_approx', 'is_finite', 'is_instance_id_valid', 'is_instance_valid', 'is_same',
  'is_zero_approx', 'lerp', 'lerp_angle', 'lerpf', 'linear_to_db', 'log', 'move_toward', 'nearest_po2', 'pingpong', 'posmod', 'print_rich',
  'print_verbose', 'printraw', 'prints', 'printt', 'push_error', 'push_warning', 'rad_to_deg', 'rand_from_seed', 'randf_range', 'randfn',
  'randi', 'randomize', 'remap', 'rotate_toward', 'roundf', 'roundi', 'seed', 'signf', 'signi', 'sin', 'sinh', 'smoothstep', 'snapped',
  'snappedf', 'snappedi', 'step_decimals', 'str_to_var', 'tan', 'tanh', 'type_convert', 'type_string', 'var_to_bytes', 'var_to_str',
  'weakref', 'wrap', 'wrapf', 'wrapi', 'Color8', 'char', 'convert', 'dict_to_inst', 'get_stack', 'inst_to_dict', 'print_debug',
  'print_stack', 'type_exists'
]);

const PRIMITIVES: Record<string, string> = { bool: 'bool', int: 'int', float: 'float', string: 'String' };

const INT: TypeRef = { id: 'int' };

function mapType(type: TypeRef): string {
  if (type.container === 'array') return 'Array';
  if (type.container === 'map') return 'Dictionary';
  if (type.container === 'set') return 'VgSet';
  return PRIMITIVES[type.id] ?? parseTypeId(type.id).name;
}

// snake_case, as Godot names members: Godot's classes are all PascalCase, and a member can't take one's name.
const CLASS_STYLES: ClassMemberStyles = { functions: 'snake', variables: 'snake', dispatchers: 'snake', hiddenPrefix: '_' };

export function gdscriptFieldNames(type: StructInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, 'snake')]));
}

export function gdscriptEnumMembers(type: EnumInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.enumerators.map((e) => [e.id, scope.claim(e.name, 'snake').toUpperCase()]));
}

export function gdscriptExportNames(functions: { id: string; name: string }[]): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(functions.map((f) => [f.id, scope.claim(f.name, 'snake')]));
}

export function gdscriptOutputFileName(graphFileName: string): string {
  return `${toIdentifier(graphFileName.replace(/\.vgraph$/i, ''), 'snake')}_vgraph.gd`;
}

// A relative preload path from a folder to a workspace-relative file.
function preloadPath(fromDir: string, to: string): string {
  return relativeSpecifier(fromDir, to).replace(/^\.\//, '');
}

// Run's launcher, a SceneTree script: Start, then Main with the arguments, then the latent actions;
// with --test first, each test (a name and a method) on a new object, each run on its own.
function launcher(file: { path: string }, context: RunContext | undefined): string {
  return [
    '# Built by Blueprint Visual Scripting to run generated GDScript. Safe to delete.',
    'extends SceneTree',
    '',
    `const vg = preload("${GDSCRIPT_RUNTIME_FILE}")`,
    '',
    '',
    // Once the tree is the main loop (code may use Engine.get_main_loop()), the run starts, as a
    // coroutine, so the latent queue can let Godot's main loop run (async functions).
    'func _initialize() -> void:',
    '\t_run()',
    '',
    '',
    'func _run() -> void:',
    `\tvar type = load(${JSON.stringify(file.path.replace(/\\/g, '/'))})`,
    '\tvar args := OS.get_cmdline_user_args()',
    '\tif args.size() > 0 and args[0] == "--test":',
    '\t\tvar failures := 0',
    '\t\tvar i := 1',
    '\t\twhile i + 1 < args.size():',
    '\t\t\tvg.reset()',
    '\t\t\tvar object = type.new()',
    '\t\t\tobject.call(args[i + 1])',
    '\t\t\tawait vg.run_latent_actions(self)',
    '\t\t\tif vg.failed():',
    '\t\t\t\tfailures += 1',
    '\t\t\t\tprint("FAIL " + args[i] + ": " + vg.failure())',
    '\t\t\telse:',
    '\t\t\t\tprint("PASS " + args[i])',
    '\t\t\ti += 2',
    '\t\tprint("All tests passed." if failures == 0 else str(failures) + " test(s) failed.")',
    '\t\tquit(1 if failures else 0)',
    '\t\treturn',
    '\tvg.reset()',
    '\tvar object = type.new()',
    '\tobject.start()',
    ...(context?.mainMethod ? ['\tif not vg.failed():', `\t\tobject.${context.mainMethod}(Array(args))`] : []),
    '\tawait vg.run_latent_actions(self)',
    '\tif vg.failed():',
    '\t\tprinterr("Error: " + vg.failure())',
    '\t\tquit(1)',
    '\telse:',
    '\t\tquit(0)',
    ''
  ].join('\n');
}

// The Godot executable: `godot` or `godot4` on the PATH, else the GODOT environment variable (Godot's
// downloads are named by version, e.g. Godot_v4.7.2-stable_win64_console.exe), or the runCommands setting.
function godotCommands(): string[][] {
  const fromEnvironment = godotFromEnvironment();
  return [['godot'], ['godot4'], ...(fromEnvironment ? [[fromEnvironment]] : [])];
}

function godotFromEnvironment(): string | undefined {
  // Core code also builds for the webview, which has no Node types.
  return (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.GODOT;
}

// The project Godot runs in: the graph's own (so its res:// paths and autoloads work), else the
// scaffold's scratch project. The launcher stays in the scaffold folder either way.
const project = (context: RunContext | undefined) => context?.projectDir ?? context?.scaffoldDir ?? '.';

const gdscriptRunner: CodeRunner = {
  commands: godotCommands,
  // The scaffold holds the launcher, which loads the generated script by its path, and a scratch project.
  scaffold: (file, _className, context) => ({ 'project.godot': 'config_version=5\n', [GDSCRIPT_RUNTIME_FILE]: gdscriptRuntime(), 'run.gd': launcher(file, context) }),
  args: (_file, _className, context) => ['--headless', '--no-header', '--path', project(context), '--script', `${context?.scaffoldDir}/run.gd`, '--', ...(context?.args ?? [])],
  testArgs: (_file, _className, context) => ['--headless', '--no-header', '--path', project(context), '--script', `${context.scaffoldDir}/run.gd`, '--', '--test', ...context.tests.flatMap((t) => [t.name, t.method])],
  missingToolMessage: 'Godot 4 was not found. Put its console executable on the PATH as `godot`, set the GODOT environment variable to it, or set it in the blueprintVisualScripting.runCommands setting.'
};

// A graph outside a Godot project runs in a scratch one, but the debugger maps breakpoints to the
// project's res:// paths, so it needs the graph in a project.
export function gdscriptPlacement(context: PlacementContext): OutputPlan {
  if (!context.outputFile) return {};
  const parts = context.outputFile.split('/').slice(0, -1);
  for (let depth = parts.length; depth >= 0; depth--) {
    if (context.exists([...parts.slice(0, depth), 'project.godot'].join('/'))) return {};
  }
  return { diagnostics: [{ severity: 'warning', code: 'godot-outside-project', message: `${context.outputFile} isn't in a Godot project (no project.godot in its folder or above it). Run uses a scratch project, and Debug needs the graph in a Godot project.` }] };
}

// godot-tools launches Godot with its debugger (`--remote-debug`) in the graph's project, running
// Run's launcher.
const gdscriptDebugger: CodeDebugger = {
  type: 'godot',
  extension: { id: 'geequlim.godot-tools', name: 'godot-tools' },
  configuration: (_file, _className, context) => ({
    type: 'godot', request: 'launch', name: 'Debug Graph', project: project(context),
    editor_path: context.command?.[0] ?? godotFromEnvironment() ?? 'godot',
    additional_options: ['--headless', '--no-header', '--script', JSON.stringify(`${context.scaffoldDir}/run.gd`), '--', ...(context.args ?? []).map((a) => JSON.stringify(a))].join(' ')
  }),
  // Godot writes a whole float with a point (30.0); the graph shows 30.
  displayValue: (text) => (/^-?\d+\.0$/.test(text) ? text.slice(0, -2) : text)
};

const gdscriptGenerator: CodeGenerator = {
  libraryExports: (_name, functions) => ({ names: gdscriptExportNames(functions) }),
  snippetLanguages: ['gdscript'],
  importLanguages: ['gdscript'],
  outputFileName: gdscriptOutputFileName,
  placement: gdscriptPlacement,
  generate: (program, options) => new GdscriptEmitter(program, options).emit(),
  runner: gdscriptRunner,
  debugger: gdscriptDebugger
};

export const gdscriptPack: LanguagePack = {
  id: 'gdscript',
  displayName: 'GDScript',
  generatedFileExtension: '.gd',
  workspaceMarkers: ['**/project.godot'],
  // No exceptions: failures are recorded and checked (vg.fail).
  capabilities: { staticTyping: false, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: false, containers: ['array', 'set', 'map'], delegates: true },
  mapType,
  terms: LANGUAGE_TERMS.gdscript,
  requires: { version: '4.3', label: 'Godot 4.3', basis: 'tested' },
  generator: gdscriptGenerator,
  // Static functions marked ## @blueprint.
  importer: { extensions: ['.gd'], scan: scanGdscript }
};

class GdscriptEmitter {
  private tests: { name: string; method: string }[] = [];
  private readonly out = new CodeWriter('\t');
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
  // An import's const: its script's, for a project function or type.
  private readonly importNames = new Map<string, string>();
  private readonly scriptConsts = new Map<string, string>();
  private readonly types: Map<string, UserType>;
  private readonly classNames = new Map<string, ClassMemberNames>();
  // What a failed statement returns in the method being written.
  private failReturn = 'return';
  private temporaries = 0;

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions) {
    this.library = !!program.library;
    this.className = new NameScope(RESERVED).claim(program.className, 'pascal');
    this.types = userTypes(program);
    if (program.declaration) this.types.set(program.declaration.type.id, program.declaration.type);
    this.names = new NameScope(RESERVED);
    const own = claimClassMembers(this.names, programClassSpec(program), CLASS_STYLES, this.inheritedMembers(program.classInfo));
    this.classNames.set(`object:${program.className}`, own);
    for (const f of program.functions) this.functionNames.set(f.id, (f.event ? own.events : own.functions).get(f.id)!);
    for (const [id, name] of own.variables) this.memberNames.set(id, name);
    for (const [id, name] of own.dispatchers) this.dispatcherNames.set(id, name);
    for (const i of program.imports) {
      const script = this.importScript(i);
      if (!this.scriptConsts.has(script)) {
        const base = i.userType ? i.userType.name : (script.split('/').pop() ?? script).replace(/\.gd$/, '');
        // A leading underscore keeps it from Godot's class names (a script named Timer). A subclass
        // inherits its parent's constants and can't declare them again, so its own carry its name.
        this.scriptConsts.set(script, this.names.claim(base, 'pascal', program.classInfo?.parent ? `_${toIdentifier(program.className, 'pascal')}_` : '_'));
      }
      // A struct, enum or class is the script itself, as is a code class whose members a graph uses.
      this.importNames.set(i.id, i.userType || i.member ? this.scriptConsts.get(script)! : `${this.scriptConsts.get(script)}.${i.name}`);
    }
    const internal = program.ancestors?.length ? `_${toIdentifier(program.className, 'snake')}_` : '_';
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'snake', internal));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'snake', internal));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(h.name, 'snake', internal));
  }

  emit(): GeneratedCode {
    if (this.program.declaration) return this.emitDeclaration();
    const body = this.out;
    if (!this.library) {
      for (const m of this.program.members.filter((x) => !x.function)) body.line(`var ${this.memberNames.get(m.id)} = ${this.value(m.initial, m.type)}`);
      for (const d of this.program.dispatchers ?? []) body.line(`var ${this.dispatcherNames.get(d.id)} = vg.dispatcher()`);
      for (const x of this.program.slots.filter((s) => !s.function)) body.line(`var ${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)}`);
      body.line();
      const parent = this.program.classInfo?.parent;
      const interfaces = (this.program.interfaces ?? []).map((i) => this.userTypeName(i.type.id));
      if (!parent || interfaces.length) {
        // Cast To an interface asks the object which it implements (vg.implements).
        this.method('vg_interfaces', [], '-> Array', () => body.line(`return ${parent ? 'super.vg_interfaces() + ' : ''}[${interfaces.join(', ')}]`));
      }
      if (!parent || this.program.hasStart) this.method('start', [], '-> void', () => this.statements(this.program.start));
    }
    for (const fn of this.program.functions) this.functionMethod(fn);
    for (const { type, stubs } of this.program.interfaces ?? []) {
      for (const fn of stubs) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => `${scope.claim(p.name, 'snake')}${annotation(p.type)}`);
        const outputs = fn.outputs.filter((p) => p.kind === 'data');
        this.method(this.interfaceNames(type).functions.get(fn.id)!, params, '', () => {
          body.line(outputs.length === 0 ? 'pass' : `return ${outputs.length === 1 ? this.defaultFor(outputs[0].type) : `[${outputs.map((o) => this.defaultFor(o.type)).join(', ')}]`}`);
        });
      }
    }
    this.tests = (this.program.tests ?? []).map((t) => ({ name: t.name, method: this.names.claim(`test ${t.name}`, 'snake') }));
    this.program.tests?.forEach((t, i) => this.method(this.tests[i].method, [], '-> void', () => this.statements(t.body)));
    for (const block of this.program.blocks) this.method(this.blockNames.get(block.id)!, [], '-> void', () => this.statements(block.body), this.library);
    for (const helper of this.program.helpers) this.helperMethod(helper);
    body.trimTrailingBlank();
    return this.finish();
  }

  // A structure (its values made by new(), never changed: Set Members makes a new one), an
  // enumeration (constants that are the values' names) or an interface (a marker script).
  private emitDeclaration(): GeneratedCode {
    const body = this.out;
    const declaration = this.program.declaration!;
    if (declaration.kind === 'interface') {
      body.line(`const VG_INTERFACE = ${JSON.stringify(declaration.type.name)}`);
      return this.finish();
    }
    if (declaration.kind === 'enum') {
      const members = gdscriptEnumMembers(declaration.type);
      for (const e of declaration.type.enumerators) body.line(`const ${members.get(e.id)} = ${JSON.stringify(e.name)}`);
      return this.finish();
    }
    const type = declaration.type;
    const fields = gdscriptFieldNames(type);
    for (const f of type.fields) body.line(`var ${fields.get(f.id)}`);
    body.line();
    body.line();
    body.line(`func _init(${type.fields.map((f) => `p_${fields.get(f.id)} = null`).join(', ')}) -> void:`);
    body.indent();
    type.fields.forEach((f, i) => body.line(`${fields.get(f.id)} = ${this.value(declaration.initial[i], f.type)} if p_${fields.get(f.id)} == null else p_${fields.get(f.id)}`));
    if (!type.fields.length) body.line('pass');
    body.dedent();
    body.line();
    body.line();
    body.line('# As Print shows it: each field by name, in order.');
    body.line('func vg_fields() -> Array:');
    body.line(`\treturn [${type.fields.map((f) => `[${JSON.stringify(f.name)}, ${fields.get(f.id)}]`).join(', ')}]`);
    return this.finish();
  }

  private finish(): GeneratedCode {
    const header = new CodeWriter('\t');
    header.line(`# Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    header.line('# Do not edit: changes are overwritten when the graph is compiled.');
    const parent = this.program.classInfo?.parent;
    const parentImport = parent && this.program.imports.find((i) => i.id === parent);
    header.line(`extends ${parentImport ? JSON.stringify(this.preload(this.importScript(parentImport))) : 'RefCounted'}`);
    header.line();
    // A subclass has its parent's vg.
    if (!parentImport) header.line(`const vg = preload("${GDSCRIPT_RUNTIME_FILE}")`);
    for (const [script, name] of [...this.scriptConsts].sort(([, a], [, b]) => compare(a, b))) header.line(`const ${name} = preload(${JSON.stringify(this.preload(script))})`);
    header.line();
    header.line();
    const headerText = header.toString();
    const offset = headerText.split('\n').length - 1;
    const main = this.program.functions.find((f) => f.event?.entry === 'Main');
    const mainName = main && this.functionNames.get(main.id);
    return {
      text: headerText + this.out.toString(),
      companionFiles: [{ fileName: GDSCRIPT_RUNTIME_FILE, text: gdscriptRuntime() }],
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

  // An import's script, workspace-relative: a type's generated file, or a project script.
  private importScript(i: IrImport): string {
    return i.userType?.source?.generatedPath ?? i.path;
  }

  private preload(script: string): string {
    return preloadPath(this.options.outputDir ?? '', script);
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
    const names = claimClassMembers(new NameScope(RESERVED), { functions: iface.functions, events: [], variables: [], dispatchers: [] }, CLASS_STYLES);
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
    const names = claimClassMembers(new NameScope(RESERVED), info, CLASS_STYLES, this.inheritedMembers(info));
    this.classNames.set(id, names);
    return names;
  }

  // The script a struct, enum or class is: its own (get_script()), or its import's const.
  private userTypeName(id: string): string {
    if (this.program.declaration?.type.id === id || id === `object:${this.program.className}`) return 'get_script()';
    return this.importNames.get(id) ?? 'null';
  }

  // ---- Members --------------------------------------------------------------------------------

  private method(name: string, params: string[], returns: string, body: () => void, isStatic = this.library): void {
    this.out.endNode();
    this.out.line(`${isStatic ? 'static ' : ''}func ${name}(${params.join(', ')})${returns ? ` ${returns}` : ''}:`);
    const before = this.out.toString();
    this.out.indent();
    body();
    if (this.out.toString() === before) this.out.line('pass');
    this.out.dedent();
    this.out.line();
    this.out.line();
  }

  private functionMethod(fn: IrFunction): void {
    const scope = new NameScope(RESERVED);
    const params = fn.params.map((p) => {
      const name = scope.claim(p.name, 'snake');
      this.paramNames.set(`${fn.id}\u0000${p.id}`, name);
      return `${name}${annotation(p.type)}`;
    });
    const locals = this.program.members.filter((m) => m.function === fn.id);
    for (const m of locals) this.memberNames.set(m.id, scope.claim(m.name, 'snake'));
    const slots = this.program.slots.filter((x) => x.function === fn.id);
    for (const x of slots) this.slotNames.set(x.id, scope.claim(x.name, 'snake'));
    const defaults = fn.outputs.map((o) => this.defaultFor(o.type));
    const returns = fn.outputs.length > 1 ? '-> Array' : fn.outputs.length === 1 ? '' : '-> void';
    this.failReturn = fn.outputs.length === 0 ? 'return' : `return ${fn.outputs.length === 1 ? defaults[0] : `[${defaults.join(', ')}]`}`;
    this.method(this.functionNames.get(fn.id)!, params, returns, () => {
      if (fn.description) this.out.line(`# ${fn.description.replace(/\s+/g, ' ')}`);
      for (const store of fn.event?.stores ?? []) this.out.line(`${this.slotRef(store.slot)} = ${this.paramNames.get(`${fn.id}\u0000${store.param}`)}`);
      for (const m of locals) this.out.line(`var ${this.memberNames.get(m.id)} = ${this.value(m.initial, m.type)}`);
      for (const x of slots) this.out.line(`var ${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)}`);
      this.statements(fn.body);
      // Only where it can be reached: Godot rejects unreachable code (UNREACHABLE_CODE).
      if (fn.outputs.length && canComplete(fn.body)) this.out.line(this.failReturn);
    });
    this.failReturn = 'return';
  }

  // A code node's snippet as a static function with typed inputs, so an int given for a float input
  // becomes a float, as in Unreal. Values (members, slots, results) are otherwise Variants: a failed
  // snippet returns null.
  private helperMethod(helper: IrCodeHelper): void {
    const scope = new NameScope(RESERVED);
    const params = helper.params.map((p, i) => ({
      pinId: p.pinId,
      name: /^[A-Za-z_]\w*$/.test(p.pinId) && !RESERVED.has(p.pinId) ? scope.claim(p.pinId) : scope.claim(`pin${i}`),
      type: p.type
    }));
    const byPin = new Map(params.map((p) => [p.pinId, p.name]));
    const code = helper.code.replace(/\$\{([^}]+)\}/g, (_m, pin: string) => byPin.get(pin) ?? pin);
    this.method(this.helperNames.get(helper.id)!, params.map((p) => `${p.name}${annotation(p.type)}`), '', () => {
      for (const line of dedent(code)) this.out.line(line);
    }, true);
  }

  private slotRef(id: string): string {
    return this.slotNames.get(id)!;
  }

  private memberRef(id: string): string {
    return this.memberNames.get(id)!;
  }

  private dispatcherRef(s: { dispatcher: string; target?: IrExpr; type?: string }): string {
    if (s.target && s.type) return `${this.targetRef(s.target)}.${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}`;
    return this.dispatcherNames.get(s.dispatcher)!;
  }

  private targetRef(e: IrExpr): string {
    return e.kind === 'self' ? 'self' : this.operand(e);
  }

  // ---- Statements ---------------------------------------------------------------------------

  private statements(statements: IrStatement[]): void {
    for (const s of statements) {
      this.statement(s);
      // Not after a statement that always returns (a Branch whose sides both do): it can't be reached.
      if (mayFail(s) && canComplete([s])) this.out.line(`if vg.failed(): ${this.failReturn}`);
    }
  }

  private block(statements: IrStatement[]): void {
    const before = this.out.toString();
    this.out.indent();
    this.statements(statements);
    if (this.out.toString() === before) this.out.line('pass');
    this.out.dedent();
  }

  private results(results: { slot: string }[], call: string): void {
    if (results.length === 1) {
      this.out.line(`${this.slotRef(results[0].slot)} = ${call}`);
      return;
    }
    const temporary = `_results_${++this.temporaries}`;
    this.out.line(`var ${temporary} = ${call}`);
    results.forEach((r, i) => this.out.line(`${this.slotRef(r.slot)} = ${temporary}[${i}]`));
  }

  private statement(s: IrStatement): void {
    const { out } = this;
    if (s.kind === 'callBlock') out.endNode();
    else out.node(s.source, (text) => `# ${text}`);
    switch (s.kind) {
      case 'print':
        out.line(`vg.print_line(${this.text(s.value)})`);
        break;
      case 'assert':
        out.line(`if not (${this.expr(s.condition)}):`);
        out.line(`\tvg.fail(${this.expr(s.message)})`);
        out.line(`\t${this.failReturn}`);
        break;
      case 'store':
        out.line(`${this.slotRef(s.slot)} = ${this.value(s.value, this.program.slots.find((x) => x.id === s.slot)?.type)}`);
        break;
      case 'setMember':
        out.line(`${this.memberRef(s.member)} = ${this.value(s.value, this.program.members.find((m) => m.id === s.member)?.type)}`);
        break;
      case 'if': {
        out.line(`if ${this.expr(s.condition)}:`);
        this.block(s.then);
        let rest = s.else;
        while (rest.length === 1 && rest[0].kind === 'if' && sameSource(rest[0], s)) {
          const inner: Extract<IrStatement, { kind: 'if' }> = rest[0];
          out.line(`elif ${this.expr(inner.condition)}:`);
          this.block(inner.then);
          rest = inner.else;
        }
        if (rest.length) {
          out.line('else:');
          this.block(rest);
        }
        break;
      }
      case 'for': {
        const counter = this.slotRef(s.counter);
        out.line(`${counter} = ${this.value(s.first, INT)}`);
        out.line(`while ${counter} <= ${this.intOperand(s.last)}${s.stop ? ` and not ${this.slotRef(s.stop)}` : ''} and not vg.failed():`);
        out.indent();
        this.statements(s.body);
        out.line(`${counter} += 1`);
        out.dedent();
        break;
      }
      case 'forEach': {
        const index = this.slotRef(s.index);
        const array = this.operand(s.array);
        out.line(`${index} = 0`);
        out.line(`while ${index} < ${array}.size()${s.stop ? ` and not ${this.slotRef(s.stop)}` : ''} and not vg.failed():`);
        out.indent();
        out.line(`${this.slotRef(s.element)} = ${array}[${index}]`);
        this.statements(s.body);
        out.line(`${index} += 1`);
        out.dedent();
        break;
      }
      case 'while':
        out.line(`while (${this.expr(s.condition)}) and not vg.failed():`);
        this.block(s.body);
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
      case 'callFunction': {
        const call = this.functionCall(s.function, s.args);
        if (s.results.length) this.results(s.results, call);
        else out.line(call);
        break;
      }
      case 'bindEvent':
        out.line(`${this.dispatcherRef(s)}.${s.bind ? 'bind' : 'unbind'}(self, ${JSON.stringify(this.functionNames.get(s.event))})`);
        break;
      case 'unbindAll':
        out.line(`${this.dispatcherRef(s)}.clear()`);
        break;
      case 'broadcast':
        out.line(`${this.dispatcherRef(s)}.broadcast([${this.args(s.args, broadcastParams(this.program, s)).join(', ')}])`);
        break;
      case 'await': {
        // An async function (docs/node-authoring.md, gap 4): a coroutine, awaited by the runtime;
        // Completed runs with its value from the latent queue.
        const outer = this.failReturn;
        out.line(`vg.await_latent(func(): return await ${this.call(s.callee, s.args)}, func(value):`);
        out.indent();
        if (s.resultSlot) out.line(`${this.slotRef(s.resultSlot)} = value`);
        this.failReturn = 'return';
        this.statements(s.then);
        out.line('pass');
        this.failReturn = outer;
        out.dedent();
        out.line(')');
        break;
      }
      case 'delay': {
        // The action is a lambda: it reads the object's members, never the method's locals.
        const outer = this.failReturn;
        if (s.generation) {
          const generation = this.slotRef(s.generation);
          out.line(`${generation} += 1`);
          out.line(`var started_${generation.replace(/^_+/, '')} = ${generation}`);
          out.line(`vg.delay(${this.expr(s.duration)}, func():`);
          out.indent();
          out.line(`if started_${generation.replace(/^_+/, '')} != ${generation}: return`);
        } else {
          const pending = this.slotRef(s.pending!);
          out.line(`if not ${pending}:`);
          out.indent();
          out.line(`${pending} = true`);
          out.line(`vg.delay(${this.expr(s.duration)}, func():`);
          out.indent();
          out.line(`${pending} = false`);
        }
        this.failReturn = 'return';
        this.statements(s.then);
        out.line('pass');
        this.failReturn = outer;
        out.dedent();
        out.line(')');
        if (!s.generation) out.dedent();
        break;
      }
      case 'cast':
        out.line(`if ${this.isA(this.expr(s.value), s.type)}:`);
        out.indent();
        out.line(`${this.slotRef(s.slot)} = ${this.expr(s.value)}`);
        this.statements(s.succeeded);
        out.dedent();
        if (s.failed.length) {
          out.line('else:');
          this.block(s.failed);
        }
        break;
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, s.type);
        const call = `${this.targetRef(s.target)}.${iface ? this.interfaceNames(iface).functions.get(s.function) : s.function}(${this.args(s.args, targetCallParams(this.program, s)).join(', ')})`;
        if (s.results.length) this.results(s.results, call);
        else out.line(call);
        break;
      }
      case 'parentCall': {
        if (s.start) {
          out.line('super.start()');
          break;
        }
        const call = `super.${this.parentFunctionName(s.function!)}(${this.args(s.args, targetCallParams(this.program, s)).join(', ')})`;
        if (s.results.length) this.results(s.results, call);
        else out.line(call);
        break;
      }
      case 'construct':
        out.line(`${this.slotRef(s.slot)} = ${this.userTypeName(s.type)}.new()`);
        out.line(`${this.slotRef(s.slot)}.start()`);
        break;
      case 'setObjectVariable':
        out.line(`${this.targetRef(s.target)}.${this.membersOf(s.type)?.variables.get(s.variable)} = ${this.value(s.value, classInfo(this.program, s.type)?.variables.find((v) => v.id === s.variable)?.type)}`);
        break;
      case 'objectCall': {
        const names = this.membersOf(s.type);
        const name = s.function !== undefined ? names?.functions.get(s.function) : names?.events.get(s.event!);
        const call = `${this.targetRef(s.target)}.${name}(${this.args(s.args, targetCallParams(this.program, s)).join(', ')})`;
        if (s.results.length) this.results(s.results, call);
        else out.line(call);
        break;
      }
      case 'return': {
        const fn = this.program.functions.find((f) => f.id === s.source.graphId);
        const values = fn?.outputs.map((o, i) => (s.values[i] ? this.value(s.values[i], o.type) : this.defaultFor(o.type))) ?? [];
        out.line(!values.length ? 'return' : values.length === 1 ? `return ${values[0]}` : `return [${values.join(', ')}]`);
        break;
      }
    }
  }

  // Cast To: an object of the class, or of a class that implements the interface.
  private isA(value: string, type: string): string {
    return parseTypeId(type).category === 'interface' ? `vg.implements(${value}, ${this.userTypeName(type)})` : `is_instance_of(${value}, ${this.userTypeName(type)})`;
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
        return e.parts.map((part) => this.operand(part)).join(' + ');
      case 'toBoolean': {
        const type = this.typeOf(e.value);
        if (type?.id === 'bool' && !type.container) return this.expr(e.value);
        return `vg.to_boolean(${this.expr(e.value)})`;
      }
      case 'call': {
        const call = this.call(e.callee, e.args);
        if (!e.output) return call;
        const imported = this.program.imports.find((i) => i.id === e.callee.id);
        return `${call}[${imported?.outputs?.findIndex((o) => o.id === e.output) ?? 0}]`;
      }
      case 'binary': {
        const op = e.op === '&&' ? 'and' : e.op === '||' ? 'or' : e.op;
        return `${this.operand(e.left)} ${op} ${this.operand(e.right)}`;
      }
      case 'not':
        return `not ${this.operand(e.value)}`;
      case 'param':
        return this.paramNames.get(`${e.function}\u0000${e.id}`) ?? 'null';
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(e.function, e.args);
        return fn.outputs.length === 1 ? call : `${call}[${fn.outputs.findIndex((o) => o.id === e.output)}]`;
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return 'null';
        return `${this.userTypeName(type.id)}.new(${type.fields.map((f, i) => this.value(e.fields[i], f.type)).join(', ')})`;
      }
      case 'structField': {
        const type = this.types.get(e.type);
        return `${this.operand(e.value)}.${type?.kind === 'struct' ? gdscriptFieldNames(type).get(e.field) : e.field}`;
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        return `${this.userTypeName(e.type)}.${type?.kind === 'enum' ? gdscriptEnumMembers(type).get(e.value) : e.value}`;
      }
      case 'self':
        return 'self';
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, e.type);
        const outputs = iface?.functions.find((f) => f.id === e.function)?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}.${iface ? this.interfaceNames(iface).functions.get(e.function) : e.function}(${this.args(e.args, targetCallParams(this.program, e)).join(', ')})`;
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'parentCall': {
        const fn = this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === e.function);
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `super.${this.parentFunctionName(e.function)}(${this.args(e.args, targetCallParams(this.program, e)).join(', ')})`;
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'isValid':
        return `${this.operand(e.value)} != null`;
      case 'objectVariable':
        return `${this.targetRef(e.target)}.${this.membersOf(e.type)?.variables.get(e.variable)}`;
      case 'objectCall': {
        const fn = classInfo(this.program, e.type)?.functions.find((f) => f.id === e.function);
        const call = `${this.targetRef(e.target)}.${this.membersOf(e.type)?.functions.get(e.function)}(${this.args(e.args, targetCallParams(this.program, e)).join(', ')})`;
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'makeContainer': {
        if (e.type.container === 'map') {
          const pairs: string[] = [];
          for (let i = 0; i + 1 < e.items.length; i += 2) pairs.push(`${this.expr(e.items[i])}: ${this.expr(e.items[i + 1])}`);
          return `{${pairs.join(', ')}}`;
        }
        const items = `[${e.items.map((item, i) => this.value(item, e.type.container === 'map' && i % 2 ? e.type.valueType : { id: e.type.id })).join(', ')}]`;
        return e.type.container === 'set' ? `vg.set_of(${items})` : items;
      }
    }
  }

  private functionCall(id: string, args: IrExpr[]): string {
    return `${this.functionNames.get(id)!}(${this.args(args, this.program.functions.find((f) => f.id === id)?.params ?? []).join(', ')})`;
  }

  private call(callee: IrCallee, args: IrExpr[]): string {
    const params = calleeSignature(callee, this.program)?.params ?? [];
    const list = this.args(args, params).join(', ');
    if (callee.kind === 'helper') return `${this.helperNames.get(callee.id)}(${list})`;
    const member = this.program.imports.find((i) => i.id === callee.id)?.member;
    if (!member) return `${this.importNames.get(callee.id)}(${list})`;
    // A script class's member (docs/node-authoring.md, gap 2), on the Target pin's object.
    if (member.kind === 'construct') return `${this.importNames.get(callee.id)}.new(${list})`;
    const [target, ...rest] = args;
    const object = this.expr(target);
    const values = this.args(rest, params.slice(1)).join(', ');
    return member.kind === 'get' ? `${object}.${member.name}` : member.kind === 'set' ? `${object}.${member.name} = ${values}` : `${object}.${member.name}(${values})`;
  }

  // Arguments for parameters of these types, in order.
  private args(args: IrExpr[], params: { type?: TypeRef }[]): string[] {
    return args.map((a, i) => this.value(a, params[i]?.type));
  }

  // An int operand: a float is truncated first.
  private intOperand(e: IrExpr): string {
    const type = this.typeOf(e);
    return type?.id === 'float' && !type.container ? this.value(e, INT) : this.operand(e);
  }

  private value(e: IrExpr, type: TypeRef | undefined): string {
    // A float wired into an int is truncated toward zero (docs/semantics.md, "Values").
    const from = this.typeOf(e);
    if (type?.id === 'int' && !type.container && from?.id === 'float' && !from.container) {
      return e.kind === 'literal' && typeof e.value === 'number' ? String(Math.trunc(e.value)) : `int(${this.expr(e)})`;
    }
    if (e.kind !== 'literal' || !type?.container || !Array.isArray(e.value)) return this.expr(e);
    if (type.container === 'map') {
      const pairs = e.value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2);
      return `{${pairs.map(([k, v]) => `${literal(k)}: ${literal(v)}`).join(', ')}}`;
    }
    const items = `[${e.value.map(literal).join(', ')}]`;
    return type.container === 'set' ? `vg.set_of(${items})` : items;
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' || e.kind === 'not' || e.kind === 'concat' || e.kind === 'isValid' ? `(${text})` : text;
  }

  private text(e: IrExpr): string {
    const type = this.typeOf(e);
    if (type && !type.container && type.id === 'string') return this.expr(e);
    return `vg.format(${this.expr(e)})`;
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (type?.container === 'array') return '[]';
    if (type?.container === 'set') return 'vg.set_of([])';
    if (type?.container === 'map') return '{}';
    const user = type && this.types.get(type.id);
    if (user?.kind === 'struct') return `${this.userTypeName(user.id)}.new()`;
    if (user?.kind === 'enum' && user.enumerators[0]) return `${this.userTypeName(user.id)}.${gdscriptEnumMembers(user).get(user.enumerators[0].id)}`;
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
        return 'null';
    }
  }

  private typeOf(e: IrExpr): TypeRef | undefined {
    const type = exprType(e, this.program);
    return type?.id === 'any' ? undefined : type;
  }
}

// A parameter's static type, for primitives (": float"); other values are Variants.
function annotation(type: TypeRef | undefined): string {
  if (!type || type.container || type.nullable) return '';
  const name = PRIMITIVES[type.id];
  return name ? `: ${name}` : '';
}

// Whether running the statement can record a failure: it calls something, or it is an Assert.
function mayFail(s: IrStatement): boolean {
  switch (s.kind) {
    case 'call':
    case 'callFunction':
    case 'callBlock':
    case 'construct':
    case 'broadcast':
    case 'objectCall':
    case 'interfaceCall':
    case 'parentCall':
    case 'assert':
      return true;
    case 'if':
      return exprMayFail(s.condition) || s.then.some(mayFail) || s.else.some(mayFail);
    case 'for':
      return exprMayFail(s.first) || exprMayFail(s.last) || s.body.some(mayFail);
    case 'forEach':
      return exprMayFail(s.array) || s.body.some(mayFail);
    case 'while':
      return exprMayFail(s.condition) || s.body.some(mayFail);
    case 'cast':
      return exprMayFail(s.value) || s.succeeded.some(mayFail) || s.failed.some(mayFail);
    case 'print':
    case 'store':
    case 'setMember':
    case 'return':
      return exprMayFail(s.kind === 'return' ? { kind: 'concat', parts: s.values } : s.value);
    case 'setObjectVariable':
      return exprMayFail(s.target) || exprMayFail(s.value);
    default:
      return false;
  }
}

function exprMayFail(e: IrExpr): boolean {
  if (['call', 'callFunction', 'objectCall', 'interfaceCall', 'parentCall'].includes(e.kind)) return true;
  return Object.values(e).some((value) => (Array.isArray(value) ? value.some((v) => isExpr(v) && exprMayFail(v)) : isExpr(value) && exprMayFail(value)));
}

function isExpr(value: unknown): value is IrExpr {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string';
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : value !== value ? 'NAN' : value > 0 ? 'INF' : '-INF';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  return 'null';
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
