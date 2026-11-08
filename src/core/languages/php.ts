// PHP pack (docs/more-languages.md, "PHP"): generates a PHP 8 file (one class per graph) from Visual
// IR. Files require each other with require_once; the support file (php-runtime.ts) is a companion
// next to every generated file. Containers are the support file's VgList, VgMap and VgSet, shared by
// reference, since PHP copies its arrays on assignment.
import { IrBlock, IrCallee, IrCodeHelper, IrExpr, IrFunction, IrImport, IrProgram, IrStatement, classInfo, exprType, interfaceInfo, programClassSpec, userTypes, broadcastParams, calleeSignature, targetCallParams } from '../compiler/ir';
import { relativeSpecifier } from '../compiler/module-paths';
import { ClassMemberNames, ClassMemberStyles, InheritedMembers, NameScope, claimClassMembers, dedent, toIdentifier } from '../compiler/names';
import type { ClassInfo, InterfaceInfo } from '../objects';
import { CodeWriter } from '../compiler/writer';
import { CodeDebugger, CodeGenerator, CodeRunner, GenerateOptions, GeneratedCode, LanguagePack, PinExpression, RunContext } from '../language-pack';
import { scanPhp } from '../importing/php-scanner';
import { LANGUAGE_TERMS } from '../terms';
import { TypeRef, parseTypeId } from '../types';
import { EnumInfo, StructInfo, UserType } from '../user-types';
import { PHP_RUNTIME_FILE, phpRuntime } from './php-runtime';

// Names a class can't take: PHP's reserved words and common built-in classes (in the global
// namespace, a generated class would clash with them).
const RESERVED_CLASSES = new Set([
  'self', 'parent', 'static', 'list', 'array', 'string', 'int', 'float', 'bool', 'object', 'mixed', 'void', 'null', 'false', 'true',
  'iterable', 'callable', 'never', 'enum', 'match', 'fn', 'class', 'interface', 'trait', 'namespace', 'new', 'function', 'Exception',
  'Error', 'Closure', 'Generator', 'Iterator', 'ArrayObject', 'ArrayIterator', 'Traversable', 'Countable', 'Stringable', 'stdClass',
  'DateTime', 'Directory', 'Throwable', 'Attribute', 'WeakMap', 'Fiber', 'Vg', 'VgList', 'VgMap', 'VgSet', 'VgDispatcher'
]);
// Variables, methods and properties can take PHP's keywords; these are the ones generated code uses.
const RESERVED = new Set(['this', 'GLOBALS', '_SERVER', '_GET', '_POST', 'argv', 'argc', '__construct', '__destruct', 'vgFields']);

const INT: TypeRef = { id: 'int' };

function mapType(type: TypeRef): string {
  if (type.container === 'array') return 'VgList';
  if (type.container === 'set') return 'VgSet';
  if (type.container === 'map') return 'VgMap';
  return ({ bool: 'bool', int: 'int', float: 'float', string: 'string' } as Record<string, string>)[type.id] ?? parseTypeId(type.id).name;
}

// PHP's own style: camelCase methods and properties.
const CLASS_STYLES: ClassMemberStyles = { functions: 'camel', variables: 'camel', dispatchers: 'camel', hiddenPrefix: '_' };

export function phpFieldNames(type: StructInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, 'camel')]));
}

export function phpEnumMembers(type: EnumInfo): Map<string, string> {
  const scope = new NameScope(new Set(['class']));
  return new Map(type.enumerators.map((e) => [e.id, scope.claim(e.name, 'snake').toUpperCase()]));
}

export function phpExportNames(functions: { id: string; name: string }[]): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(functions.map((f) => [f.id, scope.claim(f.name, 'camel')]));
}

export function phpOutputFileName(graphFileName: string): string {
  return graphFileName.replace(/\.vgraph$/i, '.vgraph.php');
}

function phpClassName(name: string): string {
  return new NameScope(RESERVED_CLASSES).claim(name, 'pascal');
}

// Run's launcher: Start, then Main with the arguments, then the latent actions; with --test first,
// each test (a name and a method) on a new object. Warnings stop the run as errors do (they would
// otherwise print to the output), and errors print with "Error:" and exit with 1.
function launcher(file: { path: string }, className: string, context: RunContext | undefined): string {
  return [
    '<?php',
    '// Built by Blueprint Visual Scripting to run generated PHP. Safe to delete.',
    "ini_set('display_errors', 'stderr');",
    'set_error_handler(function (int $severity, string $message): bool {',
    '    throw new \\ErrorException($message, 0, $severity);',
    '});',
    `require_once ${phpString(file.path.replace(/\\/g, '/'))};`,
    '',
    '$args = array_slice($argv, 1);',
    "if (($args[0] ?? null) === '--test') {",
    '    $failures = 0;',
    '    for ($i = 1; $i + 1 < count($args); $i += 2) {',
    '        \\Vgraph\\Vg::reset();',
    '        try {',
    `            (new \\${className}())->{$args[$i + 1]}();`,
    '            \\Vgraph\\Vg::runLatentActions();',
    '            echo "PASS {$args[$i]}\\n";',
    '        } catch (\\Throwable $e) {',
    '            $failures++;',
    '            echo "FAIL {$args[$i]}: {$e->getMessage()}\\n";',
    '        }',
    '    }',
    '    echo $failures === 0 ? "All tests passed.\\n" : "$failures test(s) failed.\\n";',
    '    exit($failures === 0 ? 0 : 1);',
    '}',
    '',
    'try {',
    `    $object = new \\${className}();`,
    '    $object->start();',
    ...(context?.mainMethod ? [`    $object->${context.mainMethod}(new \\Vgraph\\VgList($args));`] : []),
    '    \\Vgraph\\Vg::runLatentActions();',
    '} catch (\\Throwable $e) {',
    '    fwrite(STDERR, "Error: {$e->getMessage()}\\n");',
    '    exit(1);',
    '}',
    ''
  ].join('\n');
}

const phpRunner: CodeRunner = {
  commands: () => [['php']],
  scaffold: (file, className, context) => ({ 'run.php': launcher(file, className, context) }),
  args: (_file, _className, context) => [`${context?.scaffoldDir}/run.php`, ...(context?.args ?? [])],
  testArgs: (_file, _className, context) => [`${context.scaffoldDir}/run.php`, '--test', ...context.tests.flatMap((t) => [t.name, t.method])],
  missingToolMessage: 'PHP was not found. Install PHP 8.3 or later, enable mbstring in php.ini, and make sure `php` is on the PATH.'
};

// Xdebug through the PHP Debug extension, running Run's launcher; PHP needs Xdebug loaded (php.ini's
// zend_extension=xdebug). Xdebug is switched to debug mode for the run, on a free port, as PHP Debug's
// own launch of the current file does (it doesn't for a configured launch).
const phpDebugger: CodeDebugger = {
  type: 'php',
  extension: { id: 'xdebug.php-debug', name: 'PHP Debug' },
  configuration: (_file, _className, context) => ({
    type: 'php', request: 'launch', name: 'Debug Graph', program: `${context.scaffoldDir}/run.php`, args: context.args ?? [], cwd: context.cwd, stopOnEntry: false,
    port: 0, env: { XDEBUG_MODE: 'debug,develop', XDEBUG_CONFIG: 'client_port=${port}' },
    runtimeArgs: [...(context.command?.slice(1) ?? []), '-dxdebug.start_with_request=yes'],
    ...(context.command?.length ? { runtimeExecutable: context.command[0] } : {})
  }),
  // Xdebug writes a whole float with a point (30.0); the graph shows 30.
  displayValue: (text) => (/^-?\d+\.0$/.test(text) ? text.slice(0, -2) : text)
};

const phpGenerator: CodeGenerator = {
  libraryExports: (name, functions) => ({ names: phpExportNames(functions), container: phpClassName(name) }),
  snippetLanguages: ['php'],
  importLanguages: ['php'],
  outputFileName: phpOutputFileName,
  // Graph files in one folder share its namespace.
  moduleName: (_generatedFileName, options) => options.namespace,
  generate: (program, options) => new PhpEmitter(program, options).emit(),
  runner: phpRunner,
  debugger: phpDebugger
};

export const phpPack: LanguagePack = {
  id: 'php',
  displayName: 'PHP',
  generatedFileExtension: '.php',
  workspaceMarkers: ['**/composer.json'],
  capabilities: { staticTyping: false, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true, containers: ['array', 'set', 'map'], delegates: true },
  mapType,
  terms: LANGUAGE_TERMS.php,
  requires: { version: '8.1', label: 'PHP 8.1', basis: 'needs', why: 'Fibers and enums' },
  generator: phpGenerator,
  // Functions and public static methods marked @blueprint in docblocks.
  importer: { extensions: ['.php'], scan: scanPhp }
};

class PhpEmitter {
  private tests: { name: string; method: string }[] = [];
  private temps = 0;
  private readonly out = new CodeWriter('    ');
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
  // An import's class: a type's, or the class a project function is a static method of; a top-level
  // project function is called by its name.
  private readonly importNames = new Map<string, string>();
  private readonly types: Map<string, UserType>;
  private readonly classNames = new Map<string, ClassMemberNames>();

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions) {
    this.library = !!program.library;
    this.className = phpClassName(program.className);
    this.types = userTypes(program);
    if (program.declaration) this.types.set(program.declaration.type.id, program.declaration.type);
    this.names = this.library ? new NameScope(RESERVED) : new NameScope(RESERVED, ['start']);
    const own = claimClassMembers(this.names, programClassSpec(program), CLASS_STYLES, this.inheritedMembers(program.classInfo));
    this.classNames.set(`object:${program.className}`, own);
    for (const f of program.functions) this.functionNames.set(f.id, (f.event ? own.events : own.functions).get(f.id)!);
    for (const [id, name] of own.variables) this.memberNames.set(id, name);
    for (const [id, name] of own.dispatchers) this.dispatcherNames.set(id, name);
    for (const i of program.imports) {
      if (i.userType) this.importNames.set(i.id, this.typeReference(i.userType));
      // A library's or project's static method by its class's qualified name (written with dots by
      // graph libraries, as C# names them); a function by its namespace (ending with \) and name.
      else if (i.module?.endsWith('\\')) this.importNames.set(i.id, `\\${i.module}${i.name}`);
      else this.importNames.set(i.id, i.module ? `\\${i.module.replace(/\./g, '\\')}::${i.name}` : `\\${i.name}`);
    }
    const internal = program.ancestors?.length ? `_${toIdentifier(program.className, 'camel')}_` : '_';
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'camel', internal));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'camel', internal));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(h.name, 'camel', internal));
  }

  // A struct, enum or class by its fully qualified name: its namespace (the module of its generated
  // file, as placement gives it) or this file's.
  private typeReference(type: UserType): string {
    const namespace = type.source?.module ?? this.options.namespace;
    return `\\${namespace ? `${namespace}\\` : ''}${phpClassName(type.name)}`;
  }

  emit(): GeneratedCode {
    if (this.program.declaration) return this.emitDeclaration();
    const body = this.out;
    if (this.library) {
      body.line(`final class ${this.className}`);
      body.line('{');
      body.indent();
      for (const fn of this.program.functions) this.functionMethod(fn);
      for (const block of this.program.blocks) this.method(this.blockNames.get(block.id)!, [], () => this.statements(block.body), 'private');
      for (const helper of this.program.helpers) this.helperMethod(helper);
      body.trimTrailingBlank();
      body.dedent();
      body.line('}');
      return this.finish();
    }
    const parent = this.program.classInfo?.parent;
    const interfaces = (this.program.interfaces ?? []).map((i) => this.userTypeName(i.type.id));
    body.line(`class ${this.className}${parent ? ` extends ${this.userTypeName(parent)}` : ''}${interfaces.length ? ` implements ${interfaces.join(', ')}` : ''}`);
    body.line('{');
    body.indent();
    const members = this.program.members.filter((m) => !m.function);
    const slots = this.program.slots.filter((s) => !s.function);
    for (const m of members) body.line(`public $${this.memberNames.get(m.id)};`);
    for (const d of this.program.dispatchers ?? []) body.line(`public $${this.dispatcherNames.get(d.id)};`);
    for (const x of slots) body.line(`public $${this.slotNames.get(x.id)};`);
    if (members.length || slots.length || this.program.dispatchers?.length) body.line();
    // Property defaults must be constants in PHP, so the constructor sets them.
    this.method('__construct', [], () => {
      if (parent) body.line('parent::__construct();');
      for (const m of members) body.line(`$this->${this.memberNames.get(m.id)} = ${this.value(m.initial, m.type)};`);
      for (const d of this.program.dispatchers ?? []) body.line(`$this->${this.dispatcherNames.get(d.id)} = new VgDispatcher();`);
      for (const x of slots) body.line(`$this->${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)};`);
    });
    if (!parent || this.program.hasStart) this.method('start', [], () => this.statements(this.program.start));
    for (const fn of this.program.functions) this.functionMethod(fn);
    for (const { type, stubs } of this.program.interfaces ?? []) {
      for (const fn of stubs) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => `$${scope.claim(p.name, 'camel')}`);
        const outputs = fn.outputs.filter((p) => p.kind === 'data');
        this.method(this.interfaceNames(type).functions.get(fn.id)!, params, () => {
          if (outputs.length) body.line(`return ${outputs.length === 1 ? this.defaultFor(outputs[0].type) : `[${outputs.map((o) => this.defaultFor(o.type)).join(', ')}]`};`);
        });
      }
    }
    this.tests = (this.program.tests ?? []).map((t) => ({ name: t.name, method: this.names.claim(`test ${t.name}`, 'camel') }));
    this.program.tests?.forEach((t, i) => this.method(this.tests[i].method, [], () => this.statements(t.body)));
    for (const block of this.program.blocks) this.method(this.blockNames.get(block.id)!, [], () => this.statements(block.body), 'private');
    for (const helper of this.program.helpers) this.helperMethod(helper);
    body.trimTrailingBlank();
    body.dedent();
    body.line('}');
    return this.finish();
  }

  // A structure (values made by new, never changed: Set Members makes a new one), an enumeration (a
  // class of constants that are the values' names) or an interface.
  private emitDeclaration(): GeneratedCode {
    const body = this.out;
    const declaration = this.program.declaration!;
    if (declaration.kind === 'interface') {
      const names = this.interfaceNames(declaration.type);
      body.line(`interface ${this.className}`);
      body.line('{');
      for (const fn of declaration.type.functions) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => `$${scope.claim(p.name, 'camel')}`);
        body.line(`    public function ${names.functions.get(fn.id)}(${params.join(', ')});`);
      }
      body.line('}');
      return this.finish();
    }
    if (declaration.kind === 'enum') {
      const members = phpEnumMembers(declaration.type);
      body.line(`final class ${this.className}`);
      body.line('{');
      for (const e of declaration.type.enumerators) body.line(`    public const ${members.get(e.id)} = ${phpString(e.name)};`);
      body.line('}');
      return this.finish();
    }
    const type = declaration.type;
    const fields = phpFieldNames(type);
    body.line(`final class ${this.className}`);
    body.line('{');
    body.indent();
    for (const f of type.fields) body.line(`public $${fields.get(f.id)};`);
    body.line();
    body.line(`public function __construct(${type.fields.map((f) => `$${fields.get(f.id)} = null`).join(', ')})`);
    body.line('{');
    type.fields.forEach((f, i) => body.line(`    $this->${fields.get(f.id)} = $${fields.get(f.id)} ?? ${this.value(declaration.initial[i], f.type)};`));
    body.line('}');
    body.line();
    body.line('// As Print shows it: each field by name, in order.');
    body.line('public function vgFields(): array');
    body.line('{');
    body.line(`    return [${type.fields.map((f) => `[${phpString(f.name)}, $this->${fields.get(f.id)}]`).join(', ')}];`);
    body.line('}');
    body.dedent();
    body.line('}');
    return this.finish();
  }

  private finish(): GeneratedCode {
    const header = new CodeWriter('    ');
    header.line('<?php');
    header.line(`// Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    header.line('// Do not edit: changes are overwritten when the graph is compiled.');
    if (this.options.namespace) {
      header.line();
      header.line(`namespace ${this.options.namespace};`);
    }
    header.line();
    header.line('use Vgraph\\{Vg, VgDispatcher, VgList, VgMap, VgSet};');
    header.line();
    header.line(`require_once __DIR__ . ${phpString(`/${PHP_RUNTIME_FILE}`)};`);
    const files = [...new Set(this.program.imports.map((i) => relativeSpecifier(this.options.outputDir ?? '', i.userType?.source?.generatedPath ?? i.path).replace(/^\.\//, '')))].sort();
    for (const file of files) header.line(`require_once __DIR__ . ${phpString(`/${file}`)};`);
    header.line();
    const headerText = header.toString();
    const offset = headerText.split('\n').length - 1;
    const main = this.program.functions.find((f) => f.event?.entry === 'Main');
    const mainName = main && this.functionNames.get(main.id);
    return {
      text: headerText + this.out.toString(),
      companionFiles: [{ fileName: PHP_RUNTIME_FILE, text: phpRuntime() }],
      // Run constructs the class by its fully qualified name.
      className: `${this.options.namespace ? `${this.options.namespace}\\` : ''}${this.className}`,
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
    return this.importNames.get(id) ?? 'null';
  }

  // ---- Members --------------------------------------------------------------------------------

  private method(name: string, params: string[], body: () => void, visibility: 'public' | 'private' = 'public', isStatic = this.library): void {
    this.out.endNode();
    this.out.line(`${visibility}${isStatic ? ' static' : ''} function ${name}(${params.join(', ')})`);
    this.out.line('{');
    this.out.indent();
    body();
    this.out.dedent();
    this.out.line('}');
    this.out.line();
  }

  private functionMethod(fn: IrFunction): void {
    const scope = new NameScope(RESERVED);
    const params = fn.params.map((p) => {
      const name = scope.claim(p.name, 'camel');
      this.paramNames.set(`${fn.id}\u0000${p.id}`, name);
      return `$${name}`;
    });
    const locals = this.program.members.filter((m) => m.function === fn.id);
    for (const m of locals) this.memberNames.set(m.id, scope.claim(m.name, 'camel'));
    const slots = this.program.slots.filter((x) => x.function === fn.id);
    for (const x of slots) this.slotNames.set(x.id, scope.claim(x.name, 'camel'));
    this.method(this.functionNames.get(fn.id)!, params, () => {
      if (fn.description) this.out.line(`// ${fn.description.replace(/\s+/g, ' ')}`);
      for (const store of fn.event?.stores ?? []) this.out.line(`${this.slotRef(store.slot)} = $${this.paramNames.get(`${fn.id}\u0000${store.param}`)};`);
      for (const m of locals) this.out.line(`$${this.memberNames.get(m.id)} = ${this.value(m.initial, m.type)};`);
      for (const x of slots) this.out.line(`$${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)};`);
      this.statements(fn.body);
      if (fn.outputs.length && fn.body[fn.body.length - 1]?.kind !== 'return') this.out.line(`return ${this.returned(fn, [])};`);
    });
  }

  private returned(fn: IrFunction, values: IrExpr[]): string {
    const items = fn.outputs.map((o, i) => (values[i] ? this.value(values[i], o.type) : this.defaultFor(o.type)));
    return items.length === 1 ? items[0] : `[${items.join(', ')}]`;
  }

  // A code node's snippet as a private static method of the class; its inputs keep their ids.
  private helperMethod(helper: IrCodeHelper): void {
    const scope = new NameScope(RESERVED);
    const params = helper.params.map((p, i) => ({ pinId: p.pinId, name: /^[A-Za-z_]\w*$/.test(p.pinId) && !RESERVED.has(p.pinId) ? scope.claim(p.pinId) : scope.claim(`pin${i}`) }));
    const byPin = new Map(params.map((p) => [p.pinId, p.name]));
    const code = helper.code.replace(/\$\{([^}]+)\}/g, (_m, pin: string) => byPin.get(pin) ?? pin);
    this.method(this.helperNames.get(helper.id)!, params.map((p) => `$${p.name}`), () => {
      for (const line of dedent(code)) this.out.line(line);
    }, 'private', true);
  }

  private slotRef(id: string): string {
    const name = this.slotNames.get(id)!;
    return this.program.slots.find((x) => x.id === id)?.function ? `$${name}` : `$this->${name}`;
  }

  private memberRef(id: string): string {
    const name = this.memberNames.get(id)!;
    return this.program.members.find((m) => m.id === id)?.function ? `$${name}` : `$this->${name}`;
  }

  private dispatcherRef(s: { dispatcher: string; target?: IrExpr; type?: string }): string {
    if (s.target && s.type) return `${this.targetRef(s.target)}->${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}`;
    return `$this->${this.dispatcherNames.get(s.dispatcher)}`;
  }

  private targetRef(e: IrExpr): string {
    return e.kind === 'self' ? '$this' : this.operand(e);
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
    this.out.line(results.length === 1 ? `${this.slotRef(results[0].slot)} = ${call};` : `[${results.map((r) => this.slotRef(r.slot)).join(', ')}] = ${call};`);
  }

  private statement(s: IrStatement): void {
    const { out } = this;
    if (s.kind === 'callBlock') out.endNode();
    else out.node(s.source, (text) => `// ${text}`);
    switch (s.kind) {
      case 'print':
        out.line(`echo ${this.text(s.value)}, "\\n";`);
        break;
      case 'assert':
        out.line(`if (!(${this.expr(s.condition)})) {`);
        out.line(`    throw new \\RuntimeException(${this.expr(s.message)});`);
        out.line('}');
        break;
      case 'store':
        out.line(`${this.slotRef(s.slot)} = ${this.value(s.value, this.program.slots.find((x) => x.id === s.slot)?.type)};`);
        break;
      case 'setMember':
        out.line(`${this.memberRef(s.member)} = ${this.value(s.value, this.program.members.find((m) => m.id === s.member)?.type)};`);
        break;
      case 'if': {
        out.line(`if (${this.expr(s.condition)}) {`);
        this.block(s.then);
        let rest = s.else;
        while (rest.length === 1 && rest[0].kind === 'if' && sameSource(rest[0], s)) {
          const inner: Extract<IrStatement, { kind: 'if' }> = rest[0];
          out.line(`} elseif (${this.expr(inner.condition)}) {`);
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
        const counter = this.slotRef(s.counter);
        out.line(`${counter} = ${this.value(s.first, INT)};`);
        out.line(`while (${counter} <= ${this.intOperand(s.last)}${s.stop ? ` && !${this.slotRef(s.stop)}` : ''}) {`);
        out.indent();
        this.statements(s.body);
        out.line(`${counter}++;`);
        out.dedent();
        out.line('}');
        break;
      }
      case 'forEach': {
        const index = this.slotRef(s.index);
        const array = this.operand(s.array);
        out.line(`${index} = 0;`);
        out.line(`while (${index} < count(${array}->items)${s.stop ? ` && !${this.slotRef(s.stop)}` : ''}) {`);
        out.indent();
        out.line(`${this.slotRef(s.element)} = ${array}->items[${index}];`);
        this.statements(s.body);
        out.line(`${index}++;`);
        out.dedent();
        out.line('}');
        break;
      }
      case 'while':
        out.line(`while (${this.expr(s.condition)}) {`);
        this.block(s.body);
        out.line('}');
        break;
      case 'call': {
        const imported = s.results ? this.program.imports.find((i) => i.id === s.callee.id) : undefined;
        const code = imported?.results;
        if (s.results && code?.kind === 'out') {
          // A project function's parameters by reference (docs/node-authoring.md, gap 3): into new
          // variables, then each into its output's slot.
          const n = ++this.temps;
          const temps = code.names.map((_, i) => `$vgOut${n}_${i}`);
          // Each starts as its type's default: a typed parameter by reference checks what it's given.
          const outTypes = imported!.outputs!.slice(code.returnValue ? 1 : 0).map((o) => o.type);
          temps.forEach((t, i) => out.line(`${t} = ${outTypes[i] && !outTypes[i]!.container ? this.defaultFor(outTypes[i]) : 'null'};`));
          const withOuts = this.call(s.callee, s.args, temps);
          const values = [...(code.returnValue ? [`$vgReturn${n}`] : []), ...temps];
          out.line(code.returnValue ? `${values[0]} = ${withOuts};` : `${withOuts};`);
          for (const r of s.results) out.line(`${this.slotRef(r.slot)} = ${values[imported!.outputs!.findIndex((o) => o.id === r.output)]};`);
          break;
        }
        const call = this.call(s.callee, s.args);
        if (s.results && code?.kind === 'fields') {
          // An array shape's keys, each into its output's slot.
          const keys = new Map((imported!.outputs ?? []).map((o, i) => [o.id, code.names[i]]));
          out.line(`[${s.results.map((r) => `'${keys.get(r.output)}' => ${this.slotRef(r.slot)}`).join(', ')}] = ${call};`);
        } else if (s.results) this.results(s.results, call);
        else out.line(s.resultSlot ? `${this.slotRef(s.resultSlot)} = ${call};` : `${call};`);
        break;
      }
      case 'callBlock':
        out.line(`${this.library ? 'self::' : '$this->'}${this.blockNames.get(s.block)}();`);
        break;
      case 'callFunction': {
        const call = this.functionCall(s.function, s.args);
        if (s.results.length) this.results(s.results, call);
        else out.line(`${call};`);
        break;
      }
      case 'bindEvent':
        out.line(`${this.dispatcherRef(s)}->${s.bind ? 'bind' : 'unbind'}($this, ${phpString(this.functionNames.get(s.event)!)});`);
        break;
      case 'unbindAll':
        out.line(`${this.dispatcherRef(s)}->clear();`);
        break;
      case 'broadcast':
        out.line(`${this.dispatcherRef(s)}->broadcast(${this.args(s.args, broadcastParams(this.program, s)).join(', ')});`);
        break;
      case 'await': {
        // An async function (docs/node-authoring.md, gap 4): its Fiber, resumed by the latent queue;
        // Completed runs with what it returns.
        out.line(`Vg::awaitLatent(${this.call(s.callee, s.args)}, function ($value) {`);
        out.indent();
        if (s.resultSlot) out.line(`${this.slotRef(s.resultSlot)} = $value;`);
        this.statements(s.then);
        out.dedent();
        out.line('});');
        break;
      }
      case 'delay': {
        // The action is a closure: it reads the object's members ($this), never the method's locals.
        if (s.generation) {
          const generation = this.slotRef(s.generation);
          const started = `$started${generation.replace(/^\$this->_*/, '').replace(/^./, (c) => c.toUpperCase())}`;
          out.line(`${generation}++;`);
          out.line(`${started} = ${generation};`);
          out.line(`Vg::delay(${this.expr(s.duration)}, function () use (${started}) {`);
          out.indent();
          out.line(`if (${started} !== ${generation}) {`);
          out.line('    return;');
          out.line('}');
        } else {
          const pending = this.slotRef(s.pending!);
          out.line(`if (!${pending}) {`);
          out.indent();
          out.line(`${pending} = true;`);
          out.line(`Vg::delay(${this.expr(s.duration)}, function () {`);
          out.indent();
          out.line(`${pending} = false;`);
        }
        this.statements(s.then);
        out.dedent();
        out.line('});');
        if (!s.generation) {
          out.dedent();
          out.line('}');
        }
        break;
      }
      case 'cast':
        out.line(`if (${this.operand(s.value)} instanceof ${this.userTypeName(s.type)}) {`);
        out.indent();
        out.line(`${this.slotRef(s.slot)} = ${this.expr(s.value)};`);
        this.statements(s.succeeded);
        out.dedent();
        if (s.failed.length) {
          out.line('} else {');
          this.block(s.failed);
        }
        out.line('}');
        break;
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, s.type);
        const call = `${this.targetRef(s.target)}->${iface ? this.interfaceNames(iface).functions.get(s.function) : s.function}(${this.args(s.args, targetCallParams(this.program, s)).join(', ')})`;
        if (s.results.length) this.results(s.results, call);
        else out.line(`${call};`);
        break;
      }
      case 'parentCall': {
        const call = s.start ? 'parent::start()' : `parent::${this.parentFunctionName(s.function!)}(${this.args(s.args, targetCallParams(this.program, s)).join(', ')})`;
        if (s.results.length) this.results(s.results, call);
        else out.line(`${call};`);
        break;
      }
      case 'construct':
        out.line(`${this.slotRef(s.slot)} = new ${this.userTypeName(s.type)}();`);
        out.line(`${this.slotRef(s.slot)}->start();`);
        break;
      case 'setObjectVariable':
        out.line(`${this.targetRef(s.target)}->${this.membersOf(s.type)?.variables.get(s.variable)} = ${this.value(s.value, classInfo(this.program, s.type)?.variables.find((v) => v.id === s.variable)?.type)};`);
        break;
      case 'objectCall': {
        const names = this.membersOf(s.type);
        const name = s.function !== undefined ? names?.functions.get(s.function) : names?.events.get(s.event!);
        const call = `${this.targetRef(s.target)}->${name}(${this.args(s.args, targetCallParams(this.program, s)).join(', ')})`;
        if (s.results.length) this.results(s.results, call);
        else out.line(`${call};`);
        break;
      }
      case 'return': {
        const fn = this.program.functions.find((f) => f.id === s.source.graphId);
        out.line(fn?.outputs.length ? `return ${this.returned(fn, s.values)};` : 'return;');
        break;
      }
    }
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
        return `Vg::toNumber(${this.expr(e.value)})`;
      case 'toText':
        return this.text(e.value);
      case 'concat':
        return e.parts.map((part) => this.operand(part)).join(' . ');
      case 'toBoolean': {
        const type = this.typeOf(e.value);
        if (type?.id === 'bool' && !type.container) return this.expr(e.value);
        return `Vg::toBoolean(${this.expr(e.value)})`;
      }
      case 'call': {
        const call = this.call(e.callee, e.args);
        if (!e.output) return call;
        const imported = this.program.imports.find((i) => i.id === e.callee.id);
        return `${call}[${imported?.outputs?.findIndex((o) => o.id === e.output) ?? 0}]`;
      }
      case 'binary': {
        // == and != compare as the semantics do: 1 equals 1.0, nothing else converts.
        if (e.op === '==' || e.op === '!=') return `${e.op === '!=' ? '!' : ''}Vg::equal(${this.expr(e.left)}, ${this.expr(e.right)})`;
        return `${this.operand(e.left)} ${e.op} ${this.operand(e.right)}`;
      }
      case 'not':
        return `!${this.operand(e.value)}`;
      case 'param':
        return `$${this.paramNames.get(`${e.function}\u0000${e.id}`) ?? 'null'}`;
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(e.function, e.args);
        return fn.outputs.length === 1 ? call : `${call}[${fn.outputs.findIndex((o) => o.id === e.output)}]`;
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return 'null';
        return `new ${this.userTypeName(type.id)}(${type.fields.map((f, i) => this.value(e.fields[i], f.type)).join(', ')})`;
      }
      case 'structField': {
        const type = this.types.get(e.type);
        return `${this.operand(e.value)}->${type?.kind === 'struct' ? phpFieldNames(type).get(e.field) : e.field}`;
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        return `${this.userTypeName(e.type)}::${type?.kind === 'enum' ? phpEnumMembers(type).get(e.value) : e.value}`;
      }
      case 'self':
        return '$this';
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, e.type);
        const outputs = iface?.functions.find((f) => f.id === e.function)?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}->${iface ? this.interfaceNames(iface).functions.get(e.function) : e.function}(${this.args(e.args, targetCallParams(this.program, e)).join(', ')})`;
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'parentCall': {
        const fn = this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === e.function);
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `parent::${this.parentFunctionName(e.function)}(${this.args(e.args, targetCallParams(this.program, e)).join(', ')})`;
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'isValid':
        return `${this.operand(e.value)} !== null`;
      case 'objectVariable':
        return `${this.targetRef(e.target)}->${this.membersOf(e.type)?.variables.get(e.variable)}`;
      case 'objectCall': {
        const fn = classInfo(this.program, e.type)?.functions.find((f) => f.id === e.function);
        const call = `${this.targetRef(e.target)}->${this.membersOf(e.type)?.functions.get(e.function)}(${this.args(e.args, targetCallParams(this.program, e)).join(', ')})`;
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'makeContainer': {
        const items = `[${e.items.map((item, i) => this.value(item, e.type.container === 'map' && i % 2 ? e.type.valueType : { id: e.type.id })).join(', ')}]`;
        return `new ${e.type.container === 'map' ? 'VgMap' : e.type.container === 'set' ? 'VgSet' : 'VgList'}(${items})`;
      }
    }
  }

  private functionCall(id: string, args: IrExpr[]): string {
    return `${this.library ? 'self::' : '$this->'}${this.functionNames.get(id)!}(${this.args(args, this.program.functions.find((f) => f.id === id)?.params ?? []).join(', ')})`;
  }

  // `extra` arguments follow the inputs (parameters by reference).
  private call(callee: IrCallee, args: IrExpr[], extra: string[] = []): string {
    const params = calleeSignature(callee, this.program)?.params ?? [];
    const list = [...this.args(args, params), ...extra].join(', ');
    if (callee.kind === 'helper') return `self::${this.helperNames.get(callee.id)}(${list})`;
    const member = this.program.imports.find((i) => i.id === callee.id)?.member;
    if (!member) return `${this.importNames.get(callee.id)}(${list})`;
    // A class's member (docs/node-authoring.md, gap 2), on the Target pin's object.
    if (member.kind === 'construct') return `new ${this.importNames.get(callee.id)}(${list})`;
    const [target, ...rest] = args;
    const object = `(${this.expr(target)})`;
    const values = [...this.args(rest, params.slice(1)), ...extra].join(', ');
    return member.kind === 'get' ? `${object}->${member.name}` : member.kind === 'set' ? `${object}->${member.name} = ${values}` : `${object}->${member.name}(${values})`;
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
      return e.kind === 'literal' && typeof e.value === 'number' ? String(Math.trunc(e.value)) : `(int) ${this.operand(e)}`;
    }
    if (e.kind !== 'literal' || !type?.container || !Array.isArray(e.value)) return this.expr(e);
    if (type.container === 'map') {
      const pairs = e.value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2);
      return `new VgMap([${pairs.map(([k, v]) => `${literal(k)}, ${literal(v)}`).join(', ')}])`;
    }
    return `new ${type.container === 'set' ? 'VgSet' : 'VgList'}([${e.value.map(literal).join(', ')}])`;
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' || e.kind === 'not' || e.kind === 'concat' || e.kind === 'isValid' ? `(${text})` : text;
  }

  private text(e: IrExpr): string {
    const type = this.typeOf(e);
    if (type && !type.container && type.id === 'string') return this.expr(e);
    return `Vg::format(${this.expr(e)})`;
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (type?.container === 'array') return 'new VgList()';
    if (type?.container === 'set') return 'new VgSet()';
    if (type?.container === 'map') return 'new VgMap()';
    const user = type && this.types.get(type.id);
    if (user?.kind === 'struct') return `new ${this.userTypeName(user.id)}()`;
    if (user?.kind === 'enum' && user.enumerators[0]) return `${this.userTypeName(user.id)}::${phpEnumMembers(user).get(user.enumerators[0].id)}`;
    switch (type?.id) {
      case 'bool':
        return 'false';
      case 'int':
        return '0';
      case 'float':
        return '0.0';
      case 'string':
        return "''";
      default:
        return 'null';
    }
  }

  private typeOf(e: IrExpr): TypeRef | undefined {
    const type = exprType(e, this.program);
    return type?.id === 'any' ? undefined : type;
  }
}

// A JSON value as a PHP literal.
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value !== value ? 'NAN' : value > 0 ? 'INF' : '-INF';
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return phpString(value);
  if (Array.isArray(value)) return `new VgList([${value.map(literal).join(', ')}])`;
  return 'null';
}

// A single-quoted PHP string (no interpolation), with newlines and control characters as escapes in
// a double-quoted part.
export function phpString(text: string): string {
  if (!/[\u0000-\u001f\u007f]/.test(text)) return `'${text.replace(/[\\']/g, (c) => `\\${c}`)}'`;
  return `"${text.replace(/[\\"$\u0000-\u001f\u007f]/g, (c) => (c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '$' ? '\\$' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`))}"`;
}

function sameSource(a: IrStatement, b: IrStatement): boolean {
  return a.kind !== 'callBlock' && b.kind !== 'callBlock' && a.source.graphId === b.source.graphId && a.source.nodeId === b.source.nodeId;
}

function isNumeric(type: TypeRef | undefined): boolean {
  return !!type && !type.container && (type.id === 'int' || type.id === 'float');
}
