// Python pack: generates a typed Python 3 module (one class per graph) from Visual IR.
import { IrBlock, IrCallee, IrCodeHelper, IrExpr, IrFunction, IrImport, IrProgram, IrStatement, broadcastParams, canComplete, classInfo, codeParentInfo, exprType, importKey, interfaceInfo, isCodeClassId, programClassSpec, userTypes, targetCallParams } from '../compiler/ir';
import { pythonImportRoot, pythonModuleName } from '../compiler/module-paths';
import { scanPython } from '../importing/python-scanner';
import { ClassMemberNames, ClassMemberStyles, InheritedMembers, NameScope, claimClassMembers, codeInheritedMembers, commentLine, dedent, toIdentifier } from '../compiler/names';
import type { ClassInfo, InterfaceInfo } from '../objects';
import { CodeWriter } from '../compiler/writer';
import { CodeDebugger, CodeGenerator, CodeRunner, GenerateOptions, GeneratedCode, LanguagePack, PinExpression } from '../language-pack';
import { LANGUAGE_TERMS } from '../terms';
import { TypeRef, parseTypeId } from '../types';
import { EnumInfo, StructInfo, UserType, isUserTypeId } from '../user-types';

const RESERVED = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'type', 'self', 'print', 'object', 'super'
]);

const PRIMITIVES: Record<string, string> = { bool: 'bool', int: 'int', float: 'float', string: 'str', any: 'Any', wildcard: 'Any' };

// Types from project code (native) aren't imported into generated files: the editor checks them by
// name, and the generated code passes them on as `Any`.
const INT: TypeRef = { id: 'int' };

function mapType(type: TypeRef): string {
  const { category, name } = parseTypeId(type.id);
  const element = PRIMITIVES[type.id] ?? (category === 'native' ? 'Any' : name);
  const base = type.container === 'array' ? `list[${element}]`
    : type.container === 'set' ? `set[${element}]`
    : type.container === 'map' ? `dict[${element}, ${type.valueType ? mapType(type.valueType) : 'Any'}]`
    : element;
  return type.nullable ? `${base} | None` : base;
}

// Helper functions emitted into generated modules on demand. They implement docs/semantics.md
// ("Values") exactly as Simulate does, so output matches the other targets.
const HELPERS: Record<'format' | 'number' | 'boolean' | 'latent' | 'delay' | 'await', string[]> = {
  latent: [
    'def _latent_queue() -> Any:',
    '    # Latent actions of every class run from one queue, in the order they fall due, once start()',
    '    # has returned: run_latent_actions() runs them. Async functions run meanwhile on an asyncio',
    '    # event loop, and each one\'s Completed joins the queue when it finishes.',
    '    import asyncio',
    '    import functools',
    '    import heapq',
    '    import sys',
    '    import time',
    '    import types',
    '    queue: Any = sys.modules.get("_blueprint_latent")',
    '    if queue is None:',
    '        queue = types.ModuleType("_blueprint_latent")',
    '        queue.pending = []',
    '        queue.order = 0',
    '        queue.waiting = []',
    '',
    '        async def drive() -> None:',
    '            running = 0',
    '            finished = asyncio.Event()',
    '',
    '            def done(task: Any, then: Any) -> None:',
    '                nonlocal running',
    '                running -= 1',
    '                queue.order += 1',
    '                # Its value (or its error) is taken when Completed runs.',
    '                heapq.heappush(queue.pending, (time.monotonic(), queue.order, lambda: then(task.result()), ()))',
    '                finished.set()',
    '',
    '            while queue.pending or queue.waiting or running:',
    '                while queue.waiting:',
    '                    awaitable, then = queue.waiting.pop(0)',
    '                    running += 1',
    '                    asyncio.ensure_future(awaitable).add_done_callback(functools.partial(done, then=then))',
    '                if queue.pending and queue.pending[0][0] <= time.monotonic():',
    '                    _, _, then, then_args = heapq.heappop(queue.pending)',
    '                    then(*then_args)',
    '                    continue',
    '                finished.clear()',
    '                try:',
    '                    await asyncio.wait_for(finished.wait(), queue.pending[0][0] - time.monotonic() if queue.pending else None)',
    '                except asyncio.TimeoutError:',
    '                    pass',
    '',
    '        def run() -> None:',
    '            if queue.pending or queue.waiting:',
    '                asyncio.run(drive())',
    '',
    '        queue.run = run',
    '        sys.modules["_blueprint_latent"] = queue',
    '    return queue',
    '',
    '',
    '# Runs the latent actions waiting (Delay, async functions) until none is left: the project\'s code',
    '# calls it after start() when it runs this class itself.',
    'def run_latent_actions() -> None:',
    '    _latent_queue().run()'
  ],
  // Only with a Delay, as `await` (an unused one fails Pyright's reportUnusedFunction).
  delay: [
    'def _delay(seconds: float, action: Any, *args: Any) -> None:',
    '    import heapq',
    '    import time',
    '    queue = _latent_queue()',
    '    queue.order += 1',
    '    heapq.heappush(queue.pending, (time.monotonic() + max(0.0, seconds), queue.order, action, args))'
  ],
  // Only with an async function (a module defining it unused fails Pyright's reportUnusedFunction).
  await: [
    '# An async function\'s awaitable: `then` runs with its value when it finishes.',
    'def _await_latent(awaitable: Any, then: Any) -> None:',
    '    _latent_queue().waiting.append((awaitable, then))'
  ],
  format: [
    'def _format_value(value: Any) -> str:',
    '    if value is None:',
    '        return ""',
    '    if isinstance(value, bool):',
    '        return "true" if value else "false"',
    '    if isinstance(value, (int, float)):',
    '        return _format_number(float(value))',
    '    if isinstance(value, str):',
    '        return value',
    '    return _to_json(value)',
    '',
    '',
    '# Containers print as JSON, numbers by the rules above: sets in ascending order (they have no',
    '# order of their own), dicts in the order their keys were added.',
    'def _to_json(value: Any) -> str:',
    '    if value is None:',
    '        return "null"',
    '    if isinstance(value, bool):',
    '        return "true" if value else "false"',
    '    if isinstance(value, (int, float)):',
    '        number = float(value)',
    '        return _format_number(number) if number == number and number not in (float("inf"), float("-inf")) else "null"',
    '    if isinstance(value, str):',
    '        return json.dumps(value, ensure_ascii=False)',
    '    if isinstance(value, (set, frozenset)):',
    '        return "[" + ",".join(_to_json(item) for item in sorted(cast("set[Any]", value))) + "]"',
    '    if isinstance(value, dict):',
    // Cast to known types for Pyright's strict mode (isinstance leaves them unknown), and to types
    // other than isinstance's, which mypy would call a redundant cast.
    '        return "{" + ",".join(json.dumps(_key_text(k), ensure_ascii=False) + ":" + _to_json(v) for k, v in cast("dict[object, object]", value).items()) + "}"',
    '    if isinstance(value, (list, tuple)):',
    '        return "[" + ",".join(_to_json(item) for item in cast("list[Any]", value)) + "]"',
    '    return json.dumps(str(value), ensure_ascii=False)',
    '',
    '',
    'def _key_text(key: Any) -> str:',
    '    if isinstance(key, str):',
    '        return key',
    '    return _format_value(key)',
    '',
    '',
    'def _format_number(x: float) -> str:',
    '    # JavaScript\'s number-to-text rules, so every target language prints numbers the same way.',
    '    if x != x:',
    '        return "NaN"',
    '    if x in (float("inf"), float("-inf")):',
    '        return "Infinity" if x > 0 else "-Infinity"',
    '    if x == 0:',
    '        return "0"',
    '    sign = "-" if x < 0 else ""',
    '    mantissa, _, exponent = repr(abs(x)).partition("e")',
    '    whole, _, fraction = mantissa.partition(".")',
    '    digits = (whole + fraction).lstrip("0")',
    '    point = len(whole) + int(exponent or 0) - (len(whole + fraction) - len(digits))',
    '    digits = digits.rstrip("0")',
    '    if len(digits) <= point <= 21:',
    '        return sign + digits + "0" * (point - len(digits))',
    '    if 0 < point <= 21:',
    '        return sign + digits[:point] + "." + digits[point:]',
    '    if -6 < point <= 0:',
    '        return sign + "0." + "0" * -point + digits',
    '    rest = "." + digits[1:] if len(digits) > 1 else ""',
    '    return f"{sign}{digits[0]}{rest}e{\'+\' if point > 0 else \'-\'}{abs(point - 1)}"'
  ],
  number: [
    'def _to_number(value: Any) -> float:',
    '    if value is None:',
    '        return 0.0',
    '    if isinstance(value, (bool, int, float)):',
    '        return float(value)',
    '    if isinstance(value, str):',
    '        text = value.strip()',
    '        if not text:',
    '            return 0.0',
    '        try:',
    '            return float(text)',
    '        except ValueError:',
    '            return float("nan")',
    '    return float("nan")'
  ],
  boolean: [
    'def _to_boolean(value: Any) -> bool:',
    '    if isinstance(value, float) and value != value:',
    '        return False',
    '    if isinstance(value, (list, dict, set, tuple)):',
    '        return True',
    '    return bool(value)'
  ]
};

// Generated Python without its comments and one-line string literals, where names of types also
// appear (a node's title in its comment), to find the names the code itself uses.
function pythonCodeOnly(code: string): string {
  return code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""').replace(/#[^\n]*/g, '');
}

// The format helper with branches for the structs and enums a module prints: an enum prints its
// value (its name), a struct each field by name.
function formatHelper(enums: boolean, structs: boolean): string[] {
  const lines = [...HELPERS.format];
  const insert = (before: string, added: string[]): void => {
    const at = lines.indexOf(before);
    lines.splice(at, 0, ...added);
  };
  if (enums) {
    insert('    return _to_json(value)', ['    if isinstance(value, Enum):', '        return str(value.value)']);
    insert('    return json.dumps(str(value), ensure_ascii=False)', ['    if isinstance(value, Enum):', '        return json.dumps(value.value, ensure_ascii=False)']);
  }
  if (structs) {
    insert('    return json.dumps(str(value), ensure_ascii=False)', [
      '    if hasattr(value, "_blueprint_fields"):',
      '        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + _to_json(v) for k, v in value._blueprint_fields()) + "}"'
    ]);
  }
  return lines;
}

// Attribute names of a struct's fields (snake_case) and member names of an enum's values
// (UPPER_CASE), the same in the type's own module and in every module that uses it.
export function pythonFieldNames(type: StructInfo): Map<string, string> {
  const scope = new NameScope(RESERVED, ['field', 'dataclass', '_blueprint_fields']);
  return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, 'snake')]));
}

export function pythonEnumMembers(type: EnumInfo): Map<string, string> {
  const scope = new NameScope(RESERVED, ['name', 'value']);
  return new Map(type.enumerators.map((e) => [e.id, scope.claim(e.name, 'snake').toUpperCase()]));
}

// Unreal's event dispatcher, emitted when the class declares one: bound events (bound methods,
// which compare equal for the same object and method) run in the order they were bound, each once.
const DISPATCHER_CLASS = [
  'class _EventDispatcher:',
  '    def __init__(self) -> None:',
  '        self._handlers: list[Any] = []',
  '',
  '    def bind(self, handler: Any) -> None:',
  '        if handler not in self._handlers:',
  '            self._handlers.append(handler)',
  '',
  '    def unbind(self, handler: Any) -> None:',
  '        if handler in self._handlers:',
  '            self._handlers.remove(handler)',
  '',
  '    def clear(self) -> None:',
  '        self._handlers.clear()',
  '',
  '    def broadcast(self, *args: Any) -> None:',
  '        for handler in list(self._handlers):',
  '            handler(*args)'
];

// How a class's public members are named (src/core/compiler/names.ts).
const CLASS_STYLES: ClassMemberStyles = { functions: 'snake', variables: 'keep', dispatchers: 'keep', hiddenPrefix: '_' };

// Names fixed in every generated module, which functions must not take.
const MODULE_NAMES = ['_EventDispatcher', 'annotations', 'json', 'Any', '_format_value', '_format_number', '_to_number', '_to_boolean', '_to_json', '_key_text', '_delay', 'run_latent_actions', '_latent_queue', '_await_latent'];

// The names a function library's functions are defined as (snake_case, unique in the module). The
// library's own generated module and every module that imports it use these.
export function pythonExportNames(functions: { id: string; name: string }[]): Map<string, string> {
  const scope = new NameScope(RESERVED, MODULE_NAMES);
  return new Map(functions.map((f) => [f.id, scope.claim(f.name, 'snake')]));
}

// Run's command line, for the Python extension's debugger (debugpy runs `code` as `python -c`).
const pythonRunner: CodeRunner = {
  commands: (platform) => (platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]),
  // Puts the import roots of project modules on sys.path, as running the project would.
  args: (file, className, context) => [
    '-c',
    [
      ...(context?.importRoots?.length ? [`import sys; sys.path[:0] = ${JSON.stringify(context.importRoots)}`] : []),
      `import importlib.util as u; s = u.spec_from_file_location("vgraph_module", ${JSON.stringify(file.path)}); m = u.module_from_spec(s); s.loader.exec_module(m); o = m.${className}(); o.start()`,
      // Then Main with the arguments, when the class has one.
      ...(context?.mainMethod ? [`o.${context.mainMethod}(${JSON.stringify(context.args ?? [])})`] : []),
      // Latent actions (Delay) run once start() has returned.
      'import sys; q = sys.modules.get("_blueprint_latent"); q and q.run()'
    ].join('; ')
  ],
  // unittest runs the test file from its folder.
  testArgs: (_file, _className, context) => ['-m', 'unittest', '-v', (context.testFile ?? '').split(/[\\/]/).pop() ?? ''],
  missingToolMessage: 'Python 3 was not found. Install Python 3.8 or later and make sure it is on the PATH.'
};

// The Python extension's debugger runs the same code as Run, with the interpreter the Python
// extension selected (or the runCommands setting's).
const pythonDebugger: CodeDebugger = {
  type: 'debugpy',
  extension: { id: 'ms-python.debugpy', name: 'Python Debugger' },
  configuration: (file, className, context) => ({
    type: 'debugpy', request: 'launch', code: pythonRunner.args(file, className, context)[1], cwd: context.cwd, console: 'internalConsole', justMyCode: true,
    ...(context.command?.length === 1 ? { python: context.command[0] } : {})
  })
};

export function pythonOutputFileName(graphFileName: string): string {
  return `${toIdentifier(graphFileName.replace(/\.vgraph$/i, ''), 'snake')}_vgraph.py`;
}

const pythonGenerator: CodeGenerator = {
  libraryExports: (_name, functions) => ({ names: pythonExportNames(functions) }),
  snippetLanguages: ['python'],
  importLanguages: ['python'],
  codeParents: true,
  outputFileName: pythonOutputFileName,
  testFileName: (graphFileName) => `test_${pythonOutputFileName(graphFileName)}`,
  moduleName: (generatedFileName) => generatedFileName.replace(/\.py$/, ''),
  generate: (program, options) => new PythonEmitter(program, options).emit(),
  runner: pythonRunner,
  debugger: pythonDebugger
};

export const pythonPack: LanguagePack = {
  id: 'python',
  displayName: 'Python',
  generatedFileExtension: '.py',
  workspaceMarkers: ['**/pyproject.toml', '**/setup.py', '**/setup.cfg', '**/requirements.txt', '**/Pipfile'],
  capabilities: { staticTyping: false, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true, containers: ['array', 'set', 'map'], delegates: true },
  mapType,
  terms: LANGUAGE_TERMS.python,
  requires: { version: '3.8', label: 'Python 3.8', basis: 'needs' },
  generator: pythonGenerator,
  importer: { extensions: ['.py'], scan: scanPython }
};

class PythonEmitter {
  // The class's tests and their methods (claimed in emit).
  private tests: { name: string; method: string }[] = [];
  private latents = 0;
  private readonly out = new CodeWriter('    ');
  // One scope for the class's members; in a library, for the module's functions.
  private readonly names: NameScope;
  private readonly library: boolean;
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
  private readonly className: string;
  private readonly helpersUsed = new Set<keyof typeof HELPERS>();
  private usesAny = false;
  // The structs and enums the program uses (and the one it declares), by type id.
  private readonly types: Map<string, UserType>;
  // Standard-library imports the body needs beyond the usual ones, e.g. "from enum import Enum".
  private readonly extraImports = new Set<string>();
  // The public member names of each class the program uses, by type id; its own first.
  private readonly classNames = new Map<string, ClassMemberNames>();

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions) {
    this.library = !!program.library;
    this.className = new NameScope(RESERVED).claim(program.className, 'pascal');
    this.types = userTypes(program);
    if (program.declaration) this.types.set(program.declaration.type.id, program.declaration.type);
    // A library's functions are claimed first, exactly as pythonExportNames claims them.
    this.names = this.library ? new NameScope(RESERVED, MODULE_NAMES) : new NameScope(RESERVED, ['start']);
    // Public members first, as every module that uses the class names them.
    const own = claimClassMembers(this.names, programClassSpec(program), CLASS_STYLES, this.inheritedMembers(program.classInfo));
    this.classNames.set(`object:${program.className}`, own);
    // An override event takes the code's name for its method, which the code parent's names hold.
    for (const f of program.functions) this.functionNames.set(f.id, f.event && f.code ? f.code : (f.event ? own.events : own.functions).get(f.id)!);
    for (const [id, name] of own.variables) this.memberNames.set(id, name);
    for (const [id, name] of own.dispatchers) this.dispatcherNames.set(id, name);
    const moduleScope = this.library ? this.names : new NameScope(RESERVED, [this.className, ...MODULE_NAMES]);
    const locals = new Map<string, string>();
    for (const i of program.imports) {
      const local = locals.get(importKey(i)) ?? moduleScope.claim(i.name);
      locals.set(importKey(i), local);
      this.importNames.set(i.id, local);
    }
    // A subclass's internal attributes and methods carry its name: its parent's may share theirs.
    const internal = program.classInfo?.parent ? `_${toIdentifier(program.className, 'snake')}_` : '_';
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'keep', internal));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'snake', internal));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(h.name, 'snake', internal));
  }

  emit(): GeneratedCode {
    // The class body is written first so the imports reflect what it uses.
    const body = this.out;
    if (this.program.declaration) return this.emitDeclaration();
    if (this.library) {
      // A library: module-level functions.
      for (const fn of this.program.functions) this.functionMethod(fn);
      for (const helper of this.program.helpers) this.helperMethod(helper);
      body.trimTrailingBlank();
      return this.finish(false);
    }
    const parent = this.program.classInfo?.parent;
    const bases = [...(parent ? [this.userTypeName(parent)] : []), ...(this.program.interfaces ?? []).map((i) => this.userTypeName(i.type.id))];
    body.line(`class ${this.className}${bases.length ? `(${bases.join(', ')})` : ''}:`);
    body.indent();
    const fields = [
      ...this.program.members.filter((m) => !m.function).map((m) => ({ name: this.memberNames.get(m.id)!, type: m.type, initial: this.value(m.initial, m.type) })),
      ...(this.program.dispatchers ?? []).map((d) => ({ name: this.dispatcherNames.get(d.id)!, type: 'dispatcher' as const, initial: '_EventDispatcher()' })),
      ...this.program.slots.filter((x) => !x.function).map((x) => ({ name: this.slotNames.get(x.id)!, type: x.type, initial: this.defaultFor(x.type) }))
    ];
    if (fields.length) {
      // A class from the code's constructor takes arguments: this one takes them on.
      const scope = new NameScope(RESERVED);
      const init = (codeParentInfo(this.program)?.init ?? []).map((p) => ({ name: scope.claim(p.id, 'keep'), type: p.type }));
      this.method('__init__', init, undefined, () => {
        if (parent) body.line(`super().__init__(${init.map((p) => p.name).join(', ')})`);
        for (const f of fields) body.line(`self.${f.name}: ${f.type === 'dispatcher' ? '_EventDispatcher' : this.typeName(f.type)} = ${f.initial}`);
      });
    }
    // A subclass without Start nodes keeps its parent's start, as Unreal keeps BeginPlay.
    // (A class from the code has no start.)
    if (!parent || isCodeClassId(parent) || this.program.hasStart) this.method('start', [], undefined, () => this.statements(this.program.start));
    for (const fn of this.program.functions) this.functionMethod(fn);
    // The interface functions the class gives no body: they do nothing and return defaults.
    for (const { type, stubs } of this.program.interfaces ?? []) {
      for (const fn of stubs) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => ({ name: scope.claim(p.name, 'snake'), type: p.type }));
        const outputs = fn.outputs.filter((p) => p.kind === 'data');
        const returns = !outputs.length ? undefined : outputs.length === 1 ? outputs[0].type : `tuple[${outputs.map((o) => this.typeName(o.type)).join(', ')}]`;
        this.method(this.interfaceNames(type).functions.get(fn.id)!, params, returns, () => {
          body.line(outputs.length ? `return ${outputs.map((o) => this.defaultFor(o.type)).join(', ')}` : 'pass');
        });
      }
    }
    // Test Case events: methods the test file calls, named after every other member.
    this.tests = (this.program.tests ?? []).map((t) => ({ name: t.name, method: this.names.claim(`test ${t.name}`, 'snake') }));
    this.program.tests?.forEach((t, i) => this.method(this.tests[i].method, [], undefined, () => this.statements(t.body)));
    for (const block of this.program.blocks) this.blockMethod(block);
    for (const helper of this.program.helpers) this.helperMethod(helper);
    body.trimTrailingBlank();
    body.dedent();
    // A class that can't be made without arguments (its code parent's constructor takes them) or
    // at all (it's abstract) isn't run as a script.
    return this.finish(!this.program.abstract && !codeParentInfo(this.program)?.init?.length);
  }

  // A structure (a frozen dataclass: its values are never changed, Set Members makes a new one) or
  // an enumeration (an Enum whose values are their names).
  private emitDeclaration(): GeneratedCode {
    const body = this.out;
    const declaration = this.program.declaration!;
    if (declaration.kind === 'interface') {
      // A class that implements the interface inherits from it, so Cast To is isinstance.
      const names = this.interfaceNames(declaration.type);
      body.line(`class ${this.className}:`);
      body.line(`    """An interface: classes that implement ${declaration.type.name} inherit from it."""`);
      for (const fn of declaration.type.functions) {
        const params = ['self', ...fn.inputs.filter((p) => p.kind === 'data').map((p) => `${toIdentifier(p.name, 'snake')}: ${this.typeName(p.type)}`)].join(', ');
        const outputs = fn.outputs.filter((p) => p.kind === 'data');
        const returns = !outputs.length ? 'None' : outputs.length === 1 ? this.typeName(outputs[0].type) : `tuple[${outputs.map((o) => this.typeName(o.type)).join(', ')}]`;
        body.line();
        body.line(`    def ${names.functions.get(fn.id)}(${params}) -> ${returns}:`);
        body.line('        ...');
      }
      return this.finish(false);
    }
    if (declaration.kind === 'enum') {
      this.extraImports.add('from enum import Enum');
      const members = pythonEnumMembers(declaration.type);
      body.line(`class ${this.className}(Enum):`);
      for (const e of declaration.type.enumerators) body.line(`    ${members.get(e.id)} = ${literal(e.name)}`);
      return this.finish(false);
    }
    const type = declaration.type;
    const fields = pythonFieldNames(type);
    this.extraImports.add('from dataclasses import dataclass');
    body.line('@dataclass(frozen=True)');
    body.line(`class ${this.className}:`);
    type.fields.forEach((f, i) => {
      const initial = this.value(declaration.initial[i], f.type);
      // Containers and structs are built for each value, not shared.
      const shared = !f.type.container && this.types.get(f.type.id)?.kind !== 'struct';
      if (!shared) this.extraImports.add('from dataclasses import dataclass, field');
      body.line(`    ${fields.get(f.id)}: ${this.typeName(f.type)} = ${shared ? initial : `field(default_factory=lambda: ${initial})`}`);
    });
    this.usesAny = true;
    body.line();
    body.line('    # As Print shows it: each field by name, in order.');
    body.line('    def _blueprint_fields(self) -> list[tuple[str, Any]]:');
    body.line(`        return [${type.fields.map((f) => `(${literal(f.name)}, self.${fields.get(f.id)})`).join(', ')}]`);
    return this.finish(false);
  }

  // A dispatcher of this object, or of the Target object.
  private dispatcherRef(s: { dispatcher: string; target?: IrExpr; type?: string }): string {
    if (s.target && s.type) return `${this.targetRef(s.target)}.${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}`;
    return `self.${this.dispatcherNames.get(s.dispatcher)}`;
  }


  // The class's ancestors' member names, nearest first (src/core/compiler/names.ts).
  private inheritedMembers(info: ClassInfo | undefined): InheritedMembers[] {
    const chain: InheritedMembers[] = [];
    const seen = new Set<string>();
    for (let parent = info?.parent; parent && !seen.has(parent);) {
      seen.add(parent);
      // A class from the code ends the chain: its members keep the code's names.
      const code = isCodeClassId(parent) ? this.program.codeClasses?.find((c) => c.id === parent) : undefined;
      if (code) chain.push(codeInheritedMembers(code));
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

  // An interface's function names, as its own module and every implementing class name them.
  private interfaceNames(iface: InterfaceInfo): ClassMemberNames {
    const cached = this.classNames.get(iface.id);
    if (cached) return cached;
    const names = claimClassMembers(new NameScope(RESERVED, ['start']), { functions: iface.functions, events: [], variables: [], dispatchers: [] }, CLASS_STYLES);
    this.classNames.set(iface.id, names);
    return names;
  }

  // The generated name of the nearest ancestor's function called `name` (what Parent calls).
  private parentFunctionName(name: string): string | undefined {
    for (const ancestor of this.program.ancestors ?? []) {
      const fn = ancestor.functions.find((f) => f.name === name);
      if (fn) return this.membersOf(ancestor.id)?.functions.get(fn.id);
    }
    return undefined;
  }

  // The member names another class's generated module gives its public members.
  private membersOf(id: string): ClassMemberNames | undefined {
    const existing = this.classNames.get(id);
    if (existing) return existing;
    const info = classInfo(this.program, id);
    if (!info) return undefined;
    const names = claimClassMembers(new NameScope(RESERVED, ['start']), info, CLASS_STYLES, this.inheritedMembers(info));
    this.classNames.set(id, names);
    return names;
  }

  private targetRef(e: IrExpr): string {
    return e.kind === 'self' ? 'self' : this.operand(e);
  }

  // The name a struct, enum or class goes by in this module: its own, or its import's.
  private userTypeName(id: string): string {
    if (this.program.declaration?.type.id === id || id === `object:${this.program.className}`) return this.className;
    return this.importNames.get(id) ?? 'Any';
  }

  // The module around the body written so far: header and imports (now that the body has shown
  // what it uses), then the helpers and, for a class, the run-as-script footer.
  private finish(runnable: boolean): GeneratedCode {
    const body = this.out;
    const header = new CodeWriter('    ');
    header.line(`# Generated by NodeCraft from ${this.options.sourceFileName}.`);
    header.line('# Do not edit: changes are overwritten when the graph is compiled.');
    // The project's style linters skip generated code (docs/project-integration.md, part 3): Ruff
    // and flake8, then Pylint. Its type checkers don't.
    header.line('# flake8: noqa');
    header.line('# pylint: skip-file');
    header.line();
    header.line('from __future__ import annotations');
    header.line();
    // The dispatcher class's handlers are typed Any.
    if (this.program.dispatchers?.length) this.usesAny = true;
    const printsEnums = this.helpersUsed.has('format') && [...this.types.values()].some((t) => t.kind === 'enum');
    if (printsEnums) this.extraImports.add('from enum import Enum');
    const dataclassImport = this.extraImports.has('from dataclasses import dataclass, field') ? 'from dataclasses import dataclass, field' : this.extraImports.has('from dataclasses import dataclass') ? 'from dataclasses import dataclass' : undefined;
    const imports = [
      ...(this.helpersUsed.has('format') ? ['import json'] : []),
      ...(dataclassImport ? [dataclassImport] : []),
      ...(this.extraImports.has('from enum import Enum') ? ['from enum import Enum'] : []),
      ...(this.usesAny || this.helpersUsed.size ? [this.helpersUsed.has('format') ? 'from typing import Any, cast' : 'from typing import Any'] : [])
    ];
    if (imports.length) {
      imports.forEach((i) => header.line(i));
      header.line();
    }
    // Project code, one import per module (docs/code-as-nodes.md, "Generated imports").
    // Only what the code uses: a class imports every type its parent's members use, and projects'
    // checkers reject the ones it doesn't (Pyright's reportUnusedImport, Ruff's F401).
    const code = pythonCodeOnly(body.toString());
    const fromImports = (imports: IrImport[]): string[] => {
      const byModule = new Map<string, string[]>();
      for (const i of [...imports].sort((a, b) => compare(a.name, b.name))) {
        if (!i.path && !i.module) continue;
        const module = i.module ?? pythonModuleName(i.path);
        const local = this.importNames.get(i.id)!;
        if (!new RegExp(`(?<![\\w.])${local}(?!\\w)`).test(code)) continue;
        byModule.set(module, [...(byModule.get(module) ?? []), local === i.name ? local : `${i.name} as ${local}`]);
      }
      return [...byModule].sort(([a], [b]) => compare(a, b)).map(([module, names]) => `from ${module} import ${[...new Set(names)].join(', ')}`);
    };
    const parentClass = this.program.classInfo?.parent;
    const early = fromImports(this.program.imports.filter((i) => i.userType?.kind !== 'class' || i.id === parentClass));
    // Other classes are imported at the end: two classes that use each other then both load.
    const late = fromImports(this.program.imports.filter((i) => i.userType?.kind === 'class' && i.id !== parentClass));
    if (early.length) {
      for (const line of early) header.line(line);
      header.line();
    }
    header.line();

    const footer: string[] = [];
    for (const helper of ['format', 'number', 'boolean', 'latent', 'delay', 'await'] as const) {
      if (!this.helpersUsed.has(helper)) continue;
      const kinds = [...this.types.values()].map((t) => t.kind);
      footer.push('', '', ...(helper === 'format' ? formatHelper(kinds.includes('enum'), kinds.includes('struct')) : HELPERS[helper]));
    }
    if (this.program.dispatchers?.length) {
      footer.push('', '', "# Unreal's event dispatcher: bound events run in the order they were bound, each event once.", ...DISPATCHER_CLASS);
    }
    if (late.length) footer.push('', '', '# Classes are imported last: they may use this one.', ...late);
    const main = this.program.functions.find((f) => f.event?.entry === 'Main');
    const mainName = main && this.functionNames.get(main.id);
    if (runnable) {
      footer.push('', '', 'if __name__ == "__main__":', ...(mainName ? ['    import sys', '', `    app = ${this.className}()`, '    app.start()', `    app.${mainName}(sys.argv[1:])`] : [`    ${this.className}().start()`]), ...(this.helpersUsed.has('latent') ? ['    run_latent_actions()'] : []));
    }

    const roots = [...new Set(this.program.imports.map((i) => pythonImportRoot(i.path, i.module ?? pythonModuleName(i.path))))].sort();
    const headerText = header.toString();
    const offset = headerText.split('\n').length - 1;
    return {
      text: headerText + body.toString() + footer.join('\n') + '\n',
      className: this.className,
      nodeLines: body.nodeLines.map((n) => ({ ...n, line: n.line + offset })),
      codeBreaks: body.breaks.map((line) => line + offset),
      ...(roots.length ? { importRoots: roots } : {}),
      ...(mainName ? { mainMethod: mainName } : {}),
      ...this.pinExpressions(),
      ...(this.tests.length ? { tests: this.tests, testFile: this.testFile(roots) } : {})
    };
  }

  // The tests, for unittest: each runs its method on a new object, then the latent actions it started.
  private testFile(roots: string[]): string {
    const own = pythonOutputFileName(this.options.sourceFileName).replace(/\.py$/, '');
    // In a package, by its full name, from the folder above its top package: type checkers resolve
    // that, not a module found through the folder put on sys.path.
    const qualified = this.options.module && this.options.module.endsWith(`.${own}`) ? this.options.module : undefined;
    const module = qualified ?? own;
    const packages = qualified ? qualified.split('.').length - 1 : 0;
    const depth = (this.options.outputDir ?? '').split('/').filter((s) => s).length;
    const fromRoot = (root: string) => JSON.stringify([...Array(depth).fill('..'), ...root.split('/').filter((s) => s)].join('/') || '.');
    if (qualified) roots = [...new Set([(this.options.outputDir ?? '').split('/').filter((s) => s).slice(0, -packages).join('/'), ...roots])];
    const lines = [
      `# Generated by NodeCraft from ${this.options.sourceFileName}.`,
      '# Its Test Case events, run with python -m unittest. Do not edit: changes are overwritten when the graph is compiled.',
      '# flake8: noqa',
      '# pylint: skip-file',
      'import os',
      'import sys',
      'import unittest',
      '',
      '_here = os.path.dirname(os.path.abspath(__file__))',
      `sys.path[:0] = [_here${roots.map((r) => `, os.path.normpath(os.path.join(_here, ${fromRoot(r)}))`).join('')}]`,
      `from ${module} import ${this.className}  # noqa: E402`,
      '',
      '',
      `class ${this.className}Tests(unittest.TestCase):`
    ];
    this.tests.forEach((t, i) => {
      if (i) lines.push('');
      lines.push(`    def ${t.method}(self) -> None:`, `        ${JSON.stringify(t.name)}`, `        ${this.className}().${t.method}()`, '        queue = sys.modules.get("_blueprint_latent")', '        if queue is not None:', '            queue.run()');
    });
    lines.push('', '', 'if __name__ == "__main__":', '    unittest.main()');
    return lines.join('\n') + '\n';
  }

  // How the debugger reads each pin it can (docs/debugging.md, "Values").
  private pinExpressions(): { pinExpressions?: PinExpression[] } {
    const pins = (this.program.pinValues ?? []).map((p) => ({ graphId: p.graphId, nodeId: p.nodeId, pinId: p.pinId, expression: this.expr(p.value) }));
    return pins.length ? { pinExpressions: pins } : {};
  }

  // ---- Class members ------------------------------------------------------------------------

  // `returns` is a type, or the text of one (a function's tuple of outputs).
  private method(name: string, params: { name: string; type?: TypeRef }[], returns: TypeRef | string | undefined, body: () => void): void {
    this.out.endNode();
    const list = [...(this.library ? [] : ['self']), ...params.map((p) => `${p.name}: ${this.typeName(p.type)}`)].join(', ');
    this.out.line(`def ${name}(${list}) -> ${typeof returns === 'string' ? returns : returns ? this.typeName(returns) : 'None'}:`);
    this.block(body);
    this.out.line();
    // Module-level functions are two lines apart, as PEP 8 has them.
    if (this.library) this.out.line();
  }

  // Writes an indented block, adding `pass` if it turned out empty.
  private block(body: () => void): void {
    const before = this.out.toString();
    this.out.indent();
    body();
    if (this.out.toString() === before) this.out.line('pass');
    this.out.dedent();
  }

  // A function graph as a method: its locals and its nodes' outputs are variables of each call.
  private functionMethod(fn: IrFunction): void {
    const scope = new NameScope(RESERVED);
    const params = fn.params.map((p) => {
      // A method of the code's keeps its parameters' names.
      const name = scope.claim(p.name, fn.code ? 'keep' : 'snake');
      this.paramNames.set(`${fn.id}\u0000${p.id}`, name);
      return { name, type: p.type };
    });
    const locals = this.program.members.filter((m) => m.function === fn.id);
    for (const m of locals) this.memberNames.set(m.id, scope.claim(m.name, 'snake'));
    const slots = this.program.slots.filter((x) => x.function === fn.id);
    for (const x of slots) this.slotNames.set(x.id, scope.claim(x.name));
    const returns = fn.outputs.length > 1 ? `tuple[${fn.outputs.map((o) => this.typeName(o.type)).join(', ')}]` : fn.outputs[0]?.type ?? (fn.outputs.length ? { id: 'any' } : undefined);
    this.method(this.functionNames.get(fn.id)!, params, returns, () => {
      if (fn.description) this.out.line(`# ${commentLine(fn.description)}`);
      // A custom event keeps the inputs other flows read, as Unreal keeps an event's outputs.
      for (const store of fn.event?.stores ?? []) this.out.line(`${this.slotRef(store.slot)} = ${this.paramNames.get(`${fn.id}\u0000${store.param}`)}`);
      for (const m of locals) this.out.line(`${this.memberNames.get(m.id)}: ${this.typeName(m.type)} = ${this.value(m.initial, m.type)}`);
      for (const x of slots) this.out.line(`${this.slotNames.get(x.id)}: ${this.typeName(x.type)} = ${this.defaultFor(x.type)}`);
      this.statements(fn.body);
      // Reaching the end without a Return Node returns the outputs' defaults.
      if (fn.outputs.length && canComplete(fn.body)) this.out.line(`return ${fn.outputs.map((o) => this.defaultFor(o.type)).join(', ')}`);
    });
  }

  private slotRef(id: string): string {
    const name = this.slotNames.get(id)!;
    return this.program.slots.find((x) => x.id === id)?.function ? name : `self.${name}`;
  }

  private memberRef(id: string): string {
    const name = this.memberNames.get(id)!;
    return this.program.members.find((m) => m.id === id)?.function ? name : `self.${name}`;
  }

  private blockMethod(block: IrBlock): void {
    this.method(this.blockNames.get(block.id)!, [], undefined, () => this.statements(block.body));
  }

  // A code node's snippet as a method; inputs that are valid identifiers keep their ids.
  private helperMethod(helper: IrCodeHelper): void {
    const scope = new NameScope(RESERVED);
    const params = helper.params.map((p, i) => ({
      pinId: p.pinId,
      name: /^[A-Za-z_]\w*$/.test(p.pinId) && !RESERVED.has(p.pinId) ? scope.claim(p.pinId) : scope.claim(`pin${i}`),
      type: p.type
    }));
    const byPin = new Map(params.map((p) => [p.pinId, p.name]));
    const code = helper.code.replace(/\$\{([^}]+)\}/g, (_m, pin: string) => byPin.get(pin) ?? pin);
    this.method(this.helperNames.get(helper.id)!, params, helper.returns, () => {
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
    else out.node(s.source, (text) => `# ${text}`);
    switch (s.kind) {
      case 'print':
        out.line(`print(${this.text(s.value)})`);
        break;
      case 'assert':
        out.line(`if not (${this.expr(s.condition)}):`);
        out.line(`    raise AssertionError(${this.expr(s.message)})`);
        break;
      case 'store':
        out.line(`${this.slotRef(s.slot)} = ${this.value(s.value, this.program.slots.find((x) => x.id === s.slot)?.type)}`);
        break;
      case 'setMember': {
        const member = this.program.members.find((m) => m.id === s.member);
        out.line(`${this.memberRef(s.member)} = ${this.value(s.value, member?.type)}`);
        break;
      }
      case 'if': {
        out.line(`if ${this.expr(s.condition)}:`);
        this.block(() => this.statements(s.then));
        // An if in the else branch from the same node (a Switch's cases) reads as `elif`.
        let rest = s.else;
        while (rest.length === 1 && rest[0].kind === 'if' && sameSource(rest[0], s)) {
          const inner: Extract<IrStatement, { kind: 'if' }> = rest[0];
          out.line(`elif ${this.expr(inner.condition)}:`);
          this.block(() => this.statements(inner.then));
          rest = inner.else;
        }
        if (rest.length) {
          out.line('else:');
          this.block(() => this.statements(rest));
        }
        break;
      }
      case 'for': {
        // Python's range() would read Last Index once; Unreal reads it before each pass.
        const counter = `${this.slotRef(s.counter)}`;
        const stop = s.stop ? ` and not ${this.slotRef(s.stop)}` : '';
        out.line(`${counter} = ${this.value(s.first, INT)}`);
        out.line(`while ${counter} <= ${this.value(s.last, INT)}${stop}:`);
        this.block(() => {
          this.statements(s.body);
          out.line(`${counter} += 1`);
        });
        break;
      }
      case 'forEach': {
        // The array is read before each pass, as Unreal's For Each Loop reads it.
        const index = `${this.slotRef(s.index)}`;
        const stop = s.stop ? ` and not ${this.slotRef(s.stop)}` : '';
        const array = this.expr(s.array);
        out.line(`${index} = 0`);
        out.line(`while ${index} < len(${array})${stop}:`);
        this.block(() => {
          out.line(`${this.slotRef(s.element)} = ${array}[${index}]`);
          this.statements(s.body);
          out.line(`${index} += 1`);
        });
        break;
      }
      case 'while':
        out.line(`while ${this.expr(s.condition)}:`);
        this.block(() => this.statements(s.body));
        break;
      case 'call': {
        const call = this.call(s.callee, s.args);
        // A library function with several outputs returns a tuple, unpacked into the slots.
        if (s.results) out.line(`${s.results.map((r) => this.slotRef(r.slot)).join(', ')} = ${call}`);
        else out.line(s.resultSlot ? `${this.slotRef(s.resultSlot)} = ${call}` : call);
        break;
      }
      case 'callBlock':
        out.line(`self.${this.blockNames.get(s.block)}()`);
        break;
      case 'callFunction': {
        const call = this.functionCall(s.function, s.args);
        // One output is the return value; several come back as a tuple, unpacked into the slots.
        out.line(s.results.length ? `${s.results.map((r) => this.slotRef(r.slot)).join(', ')} = ${call}` : call);
        break;
      }
      case 'bindEvent':
        out.line(`${this.dispatcherRef(s)}.${s.bind ? 'bind' : 'unbind'}(self.${this.functionNames.get(s.event)})`);
        break;
      case 'unbindAll':
        out.line(`${this.dispatcherRef(s)}.clear()`);
        break;
      case 'broadcast':
        out.line(`${this.dispatcherRef(s)}.broadcast(${this.args(s.args, broadcastParams(this.program, s))})`);
        break;
      case 'await': {
        // An async function (docs/node-authoring.md, gap 4): Completed runs with its value when it
        // finishes, from the latent queue.
        this.helpersUsed.add('latent');
        this.helpersUsed.add('await');
        this.usesAny = true;
        const callback = `_completed_${++this.latents}`;
        out.line(`def ${callback}(value: Any) -> None:`);
        out.indent();
        if (s.resultSlot) out.line(`${this.slotRef(s.resultSlot)} = value`);
        else if (!s.then.length) out.line('pass');
        this.statements(s.then);
        out.dedent();
        out.line();
        out.line(`_await_latent(${this.call(s.callee, s.args)}, ${callback})`);
        break;
      }
      case 'delay': {
        this.helpersUsed.add('latent');
        this.helpersUsed.add('delay');
        this.usesAny = true;
        const callback = `_after_${this.slotNames.get((s.pending ?? s.generation)!)!.replace(/^_+/, '')}`;
        const generation = s.generation && this.slotRef(s.generation);
        if (!generation) {
          out.line(`if not ${this.slotRef(s.pending!)}:`);
          out.indent();
          out.line(`${this.slotRef(s.pending!)} = True`);
          out.line();
        } else {
          // Retriggerable: only the latest start's countdown runs Completed.
          out.line(`${generation} += 1`);
          out.line();
        }
        out.line(`def ${callback}(${generation ? 'started: int' : ''}) -> None:`);
        out.indent();
        if (generation) {
          out.line(`if started != ${generation}:`);
          out.line('    return');
        } else out.line(`${this.slotRef(s.pending!)} = False`);
        this.statements(s.then);
        out.dedent();
        out.line();
        out.line(`_delay(${this.expr(s.duration)}, ${callback}${generation ? `, ${generation}` : ''})`);
        if (!generation) out.dedent();
        break;
      }
      case 'cast':
        out.line(`if isinstance(${this.expr(s.value)}, ${this.userTypeName(s.type)}):`);
        out.indent();
        out.line(`${this.slotRef(s.slot)} = ${this.expr(s.value)}`);
        this.statements(s.succeeded);
        out.dedent();
        if (s.failed.length) {
          out.line('else:');
          out.indent();
          this.statements(s.failed);
          out.dedent();
        }
        break;
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, s.type);
        const call = `${this.targetRef(s.target)}.${iface ? this.interfaceNames(iface).functions.get(s.function) : s.function}(${this.args(s.args, targetCallParams(this.program, s))})`;
        out.line(s.results.length ? `${s.results.map((r) => this.slotRef(r.slot)).join(', ')} = ${call}` : call);
        break;
      }
      case 'parentCall': {
        if (s.start) {
          out.line('super().start()');
          break;
        }
        // A graph ancestor's function, or the code parent's method (its name as the code has it).
        const call = `super().${s.code ? s.function : this.parentFunctionName(s.function!)}(${this.args(s.args, targetCallParams(this.program, s))})`;
        out.line(s.results.length ? `${s.results.map((r) => this.slotRef(r.slot)).join(', ')} = ${call}` : call);
        break;
      }
      case 'construct': {
        // The code parent's constructor takes its arguments (docs/code-classes-as-parents.md).
        const init = codeParentInfo(this.program, s.type)?.init ?? [];
        out.line(`${this.slotRef(s.slot)} = ${this.userTypeName(s.type)}(${this.args(s.args ?? [], init)})`);
        out.line(`${this.slotRef(s.slot)}.start()`);
        break;
      }
      case 'setObjectVariable':
        out.line(`${this.targetRef(s.target)}.${this.membersOf(s.type)?.variables.get(s.variable)} = ${this.value(s.value, classInfo(this.program, s.type)?.variables.find((v) => v.id === s.variable)?.type)}`);
        break;
      case 'objectCall': {
        const names = this.membersOf(s.type);
        const name = s.function !== undefined ? names?.functions.get(s.function) : names?.events.get(s.event!);
        const call = `${this.targetRef(s.target)}.${name}(${this.args(s.args, targetCallParams(this.program, s))})`;
        out.line(s.results.length ? `${s.results.map((r) => this.slotRef(r.slot)).join(', ')} = ${call}` : call);
        break;
      }
      case 'return': {
        const fn = this.program.functions.find((f) => f.id === s.source.graphId);
        out.line(fn?.outputs.length ? `return ${fn.outputs.map((o, i) => (s.values[i] ? this.value(s.values[i], o.type) : this.defaultFor(o.type))).join(', ')}` : 'return');
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
        return `${this.memberRef(e.member)}`;
      case 'output':
        return `${this.slotRef(e.slot)}`;
      case 'add':
        return `${this.operand(e.left)} + ${this.operand(e.right)}`;
      case 'toNumber':
        if (isNumeric(this.typeOf(e.value))) return this.expr(e.value);
        this.helpersUsed.add('number');
        return `_to_number(${this.expr(e.value)})`;
      case 'toText':
        return this.text(e.value);
      case 'concat':
        return e.parts.map((part) => this.expr(part)).join(' + ');
      case 'toBoolean': {
        const type = this.typeOf(e.value);
        if (type?.id === 'bool' && !type.container) return this.expr(e.value);
        this.helpersUsed.add('boolean');
        return `_to_boolean(${this.expr(e.value)})`;
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
        return this.paramNames.get(`${e.function}\u0000${e.id}`) ?? 'None';
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(e.function, e.args);
        return fn.outputs.length === 1 ? call : `${call}[${fn.outputs.findIndex((o) => o.id === e.output)}]`;
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return 'None';
        return `${this.userTypeName(type.id)}(${type.fields.map((f, i) => this.value(e.fields[i], f.type)).join(', ')})`;
      }
      case 'structField': {
        const type = this.types.get(e.type);
        return `${this.operand(e.value)}.${type?.kind === 'struct' ? pythonFieldNames(type).get(e.field) : e.field}`;
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        return `${this.userTypeName(e.type)}.${type?.kind === 'enum' ? pythonEnumMembers(type).get(e.value) : e.value}`;
      }
      case 'self':
        return 'self';
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, e.type);
        const outputs = iface?.functions.find((f) => f.id === e.function)?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}.${iface ? this.interfaceNames(iface).functions.get(e.function) : e.function}(${this.args(e.args, targetCallParams(this.program, e))})`;
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'parentCall': {
        const fn = e.code ? codeParentInfo(this.program)?.overridable.find((m) => m.name === e.function) : this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === e.function);
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `super().${e.code ? e.function : this.parentFunctionName(e.function)}(${this.args(e.args, targetCallParams(this.program, e))})`;
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'isValid':
        return `${this.operand(e.value)} is not None`;
      case 'objectVariable':
        return `${this.targetRef(e.target)}.${this.membersOf(e.type)?.variables.get(e.variable)}`;
      case 'objectCall': {
        const fn = classInfo(this.program, e.type)?.functions.find((f) => f.id === e.function);
        const call = `${this.targetRef(e.target)}.${this.membersOf(e.type)?.functions.get(e.function)}(${this.args(e.args, targetCallParams(this.program, e))})`;
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        return e.output && outputs.length > 1 ? `${call}[${outputs.findIndex((o) => o.id === e.output)}]` : call;
      }
      case 'makeContainer': {
        if (e.type.container === 'map') {
          const pairs: string[] = [];
          for (let i = 0; i + 1 < e.items.length; i += 2) pairs.push(`${this.value(e.items[i], { id: e.type.id })}: ${this.value(e.items[i + 1], e.type.valueType)}`);
          return `{${pairs.join(', ')}}`;
        }
        const items = e.items.map((item) => this.value(item, { id: e.type.id }));
        if (e.type.container === 'set') return items.length ? `{${items.join(', ')}}` : 'set()';
        return `[${items.join(', ')}]`;
      }
    }
  }

  // Arguments for parameters of these types, in order.
  private args(args: IrExpr[], params: { type?: TypeRef }[]): string {
    return args.map((a, i) => this.value(a, params[i]?.type)).join(', ');
  }

  private functionCall(id: string, args: IrExpr[]): string {
    const params = this.program.functions.find((f) => f.id === id)?.params;
    return `${this.self(this.functionNames.get(id)!)}(${args.map((a, i) => this.value(a, params?.[i]?.type)).join(', ')})`;
  }

  private call(callee: IrCallee, args: IrExpr[]): string {
    const params = callee.kind === 'helper' ? this.program.helpers.find((h) => h.id === callee.id)?.params : this.program.imports.find((i) => i.id === callee.id)?.params;
    const list = args.map((a, i) => this.value(a, params?.[i]?.type)).join(', ');
    if (callee.kind === 'helper') return `${this.self(this.helperNames.get(callee.id)!)}(${list})`;
    const local = this.importNames.get(callee.id)!;
    const member = this.program.imports.find((i) => i.id === callee.id)?.member;
    if (!member || member.kind === 'construct') return `${local}(${list})`;
    // A code class's member (docs/node-authoring.md, gap 2), on the Target pin's object.
    const [target, ...rest] = args;
    const object = this.targetRef(target);
    const values = rest.map((a, i) => this.value(a, params?.[i + 1]?.type)).join(', ');
    return member.kind === 'get' ? `${object}.${member.name}` : member.kind === 'set' ? `${object}.${member.name} = ${values}` : `${object}.${member.name}(${values})`;
  }

  // A method of the class, or (in a library) a module function.
  private self(name: string): string {
    return this.library ? name : `self.${name}`;
  }

  // An expression for a member or slot of `type`: a container default (JSON: an array, or a map's
  // [key, value] pairs) becomes the container.
  private value(e: IrExpr, type: TypeRef | undefined): string {
    // A float wired into an int is truncated toward zero, as in C# and Java: Python's ints and
    // floats are different types (a float can't index a list), and type checkers hold them apart.
    const from = this.typeOf(e);
    if (type?.id === 'int' && !type.container && from?.id === 'float' && !from.container) {
      return e.kind === 'literal' && typeof e.value === 'number' ? String(Math.trunc(e.value)) : `int(${this.expr(e)})`;
    }
    if (e.kind !== 'literal' || !type?.container || !Array.isArray(e.value)) return this.expr(e);
    if (type.container === 'set') return e.value.length ? `{${e.value.map(literal).join(', ')}}` : 'set()';
    if (type.container === 'map') {
      const pairs = e.value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2);
      return `{${pairs.map(([k, v]) => `${literal(k)}: ${literal(v)}`).join(', ')}}`;
    }
    return literal(e.value);
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' || e.kind === 'not' ? `(${text})` : text;
  }

  // The value as text, per docs/semantics.md. Only strings print as they are in Python.
  private text(e: IrExpr): string {
    const type = this.typeOf(e);
    if (type && !type.container && type.id === 'string') return this.expr(e);
    this.helpersUsed.add('format');
    return `_format_value(${this.expr(e)})`;
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (type?.container === 'array') return '[]';
    if (type?.container === 'set') return 'set()';
    if (type?.container === 'map') return '{}';
    // A struct with its fields' defaults; an enum's first value.
    const user = type && this.types.get(type.id);
    if (user?.kind === 'struct') return `${this.userTypeName(user.id)}()`;
    if (user?.kind === 'enum' && user.enumerators[0]) return `${this.userTypeName(user.id)}.${pythonEnumMembers(user).get(user.enumerators[0].id)}`;
    switch (type?.id) {
      case 'bool':
        return 'False';
      case 'int':
      case 'float':
        return '0';
      case 'string':
        return '""';
      default:
        return 'None';
    }
  }

  private typeName(type: TypeRef | undefined): string {
    const name = this.mapType(type ?? { id: 'any' });
    if (name.includes('Any')) this.usesAny = true;
    // Object-like types start out None, so they must admit it.
    return this.defaultFor(type) === 'None' && name !== 'Any' && !name.endsWith('| None') ? `${name} | None` : name;
  }

  // Python's spelling of a type, with structs and enums by the names this module knows them by.
  private mapType(type: TypeRef): string {
    if (!isUserTypeId(type.id) && !(type.valueType && isUserTypeId(type.valueType.id))) return mapType(type);
    const element = isUserTypeId(type.id) ? this.userTypeName(type.id) : mapType({ id: type.id });
    const value = type.valueType ? this.mapType(type.valueType) : 'Any';
    return type.container === 'array' ? `list[${element}]` : type.container === 'set' ? `set[${element}]` : type.container === 'map' ? `dict[${element}, ${value}]` : element;
  }

  private typeOf(e: IrExpr): TypeRef | undefined {
    const type = exprType(e, this.program);
    return type?.id === 'any' ? undefined : type;
  }
}

// A JSON value as a Python literal.
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  // (JSON has no NaN or infinities, so a graph file can't hold one; were one computed, it would be
  // written as Python's, not JSON.stringify's null.)
  if (typeof value === 'number' && !Number.isFinite(value)) return Number.isNaN(value) ? 'float("nan")' : `${value < 0 ? '-' : ''}float("inf")`;
  if (typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${literal(v)}`).join(', ')}}`;
  return 'None';
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
