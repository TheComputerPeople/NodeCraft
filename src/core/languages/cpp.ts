// C++ pack (docs/language-breadth.md, "C++"): a header and a source file per graph, generated from
// Visual IR, and run through a small scaffold built with the first C++20 compiler found.
import { IrCallee, IrCodeHelper, IrExpr, IrFunction, IrImport, IrProgram, IrStatement, calleeSignature, classInfo, exprType, interfaceInfo, programClassSpec, userTypes } from '../compiler/ir';
import { ClassMemberNames, ClassMemberStyles, InheritedMembers, NameScope, claimClassMembers, dedent } from '../compiler/names';
import { CodeWriter } from '../compiler/writer';
import { relativeSpecifier } from '../compiler/module-paths';
import { CodeGenerator, CodeRunner, GenerateOptions, GeneratedCode, LanguagePack, PinExpression, RunContext } from '../language-pack';
import { OutputPlan, PlacementContext } from '../output-plan';
import type { ClassInfo, InterfaceInfo } from '../objects';
import { LANGUAGE_TERMS } from '../terms';
import { TypeRef, parseTypeId } from '../types';
import { EnumInfo, StructInfo, UserType, isUserTypeId } from '../user-types';
import { scanCpp } from '../importing/cpp-scanner';
import { CPP_RUNTIME, CPP_RUNTIME_GUARD, CPP_RUNTIME_INCLUDES } from './cpp-runtime';

const RESERVED = new Set([
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool', 'break', 'case', 'catch', 'char', 'char8_t', 'char16_t',
  'char32_t', 'class', 'compl', 'concept', 'const', 'consteval', 'constexpr', 'constinit', 'const_cast', 'continue', 'co_await', 'co_return',
  'co_yield', 'decltype', 'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float',
  'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'not_eq', 'nullptr', 'operator', 'or',
  'or_eq', 'private', 'protected', 'public', 'register', 'reinterpret_cast', 'requires', 'return', 'short', 'signed', 'sizeof', 'static',
  'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local', 'throw', 'true', 'try', 'typedef', 'typeid',
  'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'wchar_t', 'while', 'xor', 'xor_eq', 'override', 'final',
  // Not keywords, but names generated code relies on.
  'std', 'vgraph', 'main', 'NAN'
]);

const PRIMITIVES: Record<string, string> = { bool: 'bool', int: 'long long', float: 'double', string: 'std::string', any: 'std::any', wildcard: 'std::any' };

// The language's spelling of a type, without the program's context (user types by their names).
function mapType(type: TypeRef): string {
  const { category, name } = parseTypeId(type.id);
  const element = PRIMITIVES[type.id] ?? (category === 'native' || category === 'delegate' ? 'std::any' : category === 'object' || category === 'interface' ? `std::shared_ptr<${name}>` : name);
  if (type.container === 'array') return `std::vector<${element}>`;
  if (type.container === 'set') return `std::set<${element}>`;
  if (type.container === 'map') return `vgraph::Map<${element}, ${type.valueType ? mapType(type.valueType) : 'std::any'}>`;
  return element;
}

const CLASS_STYLES: ClassMemberStyles = { functions: 'camel', variables: 'keep', dispatchers: 'keep' };

function classScope(className: string): NameScope {
  return new NameScope(RESERVED, ['start', className]);
}

export function cppHeaderName(graphFileName: string): string {
  return `${graphFileName}.h`;
}

// A function library's namespace and the names of its functions (camelCase, unique in it). The
// library's own generated file and every file that calls it use these.
export function cppLibraryExports(libraryName: string, functions: { id: string; name: string }[]): { names: Map<string, string>; container: string } {
  const container = new NameScope(RESERVED).claim(libraryName, 'pascal');
  const scope = new NameScope(RESERVED, [container]);
  return { names: new Map(functions.map((f) => [f.id, scope.claim(f.name, 'camel')])), container };
}

// Field names of a struct (camelCase, so a field may share a type's name) and member names of an
// enum (PascalCase), the same in the type's own file and in every file that uses it.
export function cppFieldNames(type: StructInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, 'camel')]));
}

export function cppEnumMembers(type: EnumInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.enumerators.map((e) => [e.id, scope.claim(e.name, 'pascal')]));
}

// The scaffold Run builds: a main that constructs the class and calls start, then Main with the
// arguments, then the latent actions; or, with --test, each test on a new object.
export function cppMainSource(header: string, className: string, mainMethod: string | undefined): string {
  return [
    '// Built by Blueprint Visual Scripting to run a generated class. Safe to delete.',
    `#include "${header.replace(/\\/g, '/')}"`,
    '',
    'static int runTests(int argc, char** argv) {',
    '    int failed = 0;',
    '    for (int i = 2; i + 1 < argc; i += 2) {',
    '        try {',
    `            auto object = std::make_shared<${className}>();`,
    '            object->run_test(argv[i + 1]);',
    '        } catch (const std::exception& error) {',
    '            failed++;',
    '            std::cout << "FAIL " << argv[i] << ": " << error.what() << std::endl;',
    '            continue;',
    '        }',
    '        std::cout << "PASS " << argv[i] << std::endl;',
    '    }',
    '    std::cout << (failed == 0 ? std::string("All tests passed.") : std::to_string(failed) + " test(s) failed.") << std::endl;',
    '    return failed == 0 ? 0 : 1;',
    '}',
    '',
    'int main(int argc, char** argv) {',
    '    if (argc > 1 && std::string(argv[1]) == "--test") return runTests(argc, argv);',
    '    try {',
    `        auto object = std::make_shared<${className}>();`,
    '        object->start();',
    ...(mainMethod ? [`        object->${mainMethod}(std::vector<std::string>(argv + 1, argv + argc));`] : []),
    '        vgraph::run_latent_actions();',
    '    } catch (const std::exception& error) {',
    '        std::cout.flush();',
    '        std::cerr << error.what() << std::endl;',
    '        return 1;',
    '    }',
    '    return 0;',
    '}',
    ''
  ].join('\n');
}

function executable(context: RunContext | undefined): string {
  return `${context?.scaffoldDir}/run${context?.platform === 'win32' ? '.exe' : ''}`;
}

const cppRunner: CodeRunner = {
  commands: () => [['g++'], ['clang++']],
  scaffold: (file, className, context) => ({ 'main.cpp': cppMainSource(file.path.replace(/\.cpp$/, '.h'), className, context.mainMethod) }),
  build: (file, _className, context) => ['-std=c++20', '-g', '-O0', '-o', executable(context), `${context.scaffoldDir}/main.cpp`, file.path, ...(context.sources ?? [])],
  executable: (_file, _className, context) => executable(context),
  args: (_file, _className, context) => context?.args ?? [],
  testArgs: (_file, _className, context) => ['--test', ...context.tests.flatMap((t) => [t.name, t.method])],
  missingToolMessage: 'No C++ compiler was found. Install g++ or clang++ (with C++20) and make sure it is on the PATH.'
};

export const CMAKE_BLOCK = { begin: '# vgraph:begin (managed by Blueprint Visual Scripting)', end: '# vgraph:end' };

// Registers generated C++ with the project's build (docs/output-placement.md, "C and C++"). With
// CMake: an owned vgraph.cmake lists the generated sources, and a fenced block in CMakeLists.txt
// (added once, with consent) includes it and adds them to the first target. A project that globs
// its sources needs nothing; other build systems get the list to add by hand.
export function cppPlacement(context: PlacementContext): OutputPlan {
  const files = context.generatedFiles;
  const cmake = context.readFile('CMakeLists.txt');
  if (cmake === undefined) {
    const other = ['meson.build', 'Makefile'].find((f) => context.exists(f));
    if (!other || !files.length) return {};
    return { diagnostics: [{ severity: 'warning', code: 'build-registration', message: `Add the generated C++ files to ${other}'s sources: ${files.join(', ')}.` }] };
  }
  const code = cmake.replace(/#.*$/gm, '');
  if (/file\s*\(\s*GLOB(_RECURSE)?\b[^)]*\.(cpp|cc|cxx)/i.test(code)) return {};
  if (!files.length && !context.exists('vgraph.cmake')) return {};
  const list = [
    '# Generated by Blueprint Visual Scripting: the C++ files generated from graphs.',
    '# Do not edit: it is rewritten when graphs are compiled.',
    'set(VGRAPH_SOURCES',
    ...files.map((f) => `    \${CMAKE_CURRENT_LIST_DIR}/${f}`),
    ')',
    ''
  ].join('\n');
  const target = /add_(?:executable|library)\s*\(\s*([A-Za-z0-9_.+-]+)/.exec(code)?.[1];
  if (!target) {
    return {
      ownedFiles: [{ path: 'vgraph.cmake', text: list }],
      diagnostics: [{ severity: 'warning', code: 'build-registration', message: 'CMakeLists.txt has no add_executable or add_library, so the generated C++ files can\'t be added to a target: include vgraph.cmake and add ${VGRAPH_SOURCES} to yours.' }]
    };
  }
  return {
    ownedFiles: [{ path: 'vgraph.cmake', text: list }],
    hooks: [{
      id: 'cmake-include:CMakeLists.txt',
      file: 'CMakeLists.txt',
      description: `Add the C++ files generated from graphs to the ${target} target in CMakeLists.txt`,
      block: { ...CMAKE_BLOCK, text: [`include(\${CMAKE_CURRENT_LIST_DIR}/vgraph.cmake)`, `target_sources(${target} PRIVATE \${VGRAPH_SOURCES})`, `target_compile_features(${target} PRIVATE cxx_std_20)`].join('\n') }
    }]
  };
}

const cppGenerator: CodeGenerator = {
  libraryExports: cppLibraryExports,
  placement: cppPlacement,
  snippetLanguages: ['cpp'],
  importLanguages: ['cpp'],
  outputFileName: (graphFileName) => `${graphFileName}.cpp`,
  companionFileNames: (graphFileName) => [cppHeaderName(graphFileName)],
  generate: (program, options) => new CppEmitter(program, options).emit(),
  runner: cppRunner,
  // The C/C++ extension's debugger, with gdb (lldb on macOS), runs the scaffold Run builds.
  debugger: {
    type: 'cppdbg',
    extension: { id: 'ms-vscode.cpptools', name: 'C/C++' },
    build: (file, className, context) => cppRunner.build!(file, className, context),
    configuration: (_file, _className, context) => ({
      type: 'cppdbg', request: 'launch', program: executable(context), args: context.args ?? [], cwd: context.cwd, stopAtEntry: false, externalConsole: false,
      ...(context.platform === 'darwin' ? { MIMode: 'lldb' } : { MIMode: 'gdb', miDebuggerPath: 'gdb' }),
      setupCommands: [{ description: 'Pretty-print standard types', text: '-enable-pretty-printing', ignoreFailures: true }]
    })
  }
};

export const cppPack: LanguagePack = {
  id: 'cpp',
  displayName: 'C++',
  generatedFileExtension: '.cpp',
  workspaceMarkers: ['**/CMakeLists.txt', '**/*.vcxproj', '**/meson.build'],
  capabilities: { staticTyping: true, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true, containers: ['array', 'set', 'map'], delegates: true },
  mapType,
  terms: LANGUAGE_TERMS.cpp,
  generator: cppGenerator,
  // Functions marked @blueprint in headers: generated code includes the header to call them.
  importer: { extensions: ['.h', '.hpp', '.hh', '.hxx'], scan: scanCpp }
};

interface MethodSpec {
  // In the class (header): `virtual double twice(double n)`.
  declaration: string;
  access: 'public' | 'protected' | 'private';
}

class CppEmitter {
  // The source file (definitions), with node lines; the header (declarations) is assembled in emit.
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
  private readonly className: string;
  private readonly library: boolean;
  private readonly types: Map<string, UserType>;
  private readonly classNames = new Map<string, ClassMemberNames>();
  private readonly methods: MethodSpec[] = [];
  private tests: { name: string; method: string }[] = [];
  private casts = 0;
  private temps = 0;

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions) {
    this.library = !!program.library;
    this.className = new NameScope(RESERVED).claim(program.className, 'pascal');
    this.types = userTypes(program);
    if (program.declaration) this.types.set(program.declaration.type.id, program.declaration.type);
    if (this.library) {
      const exports = cppLibraryExports(program.className, program.functions.map((f) => ({ id: f.id, name: f.name })));
      this.names = new NameScope(RESERVED, [this.className, ...exports.names.values()]);
      for (const f of program.functions) this.functionNames.set(f.id, exports.names.get(f.id)!);
    } else {
      this.names = classScope(this.className);
      const own = claimClassMembers(this.names, programClassSpec(program), CLASS_STYLES, this.inheritedMembers(program.classInfo));
      this.classNames.set(`object:${program.className}`, own);
      for (const f of program.functions) this.functionNames.set(f.id, (f.event ? own.events : own.functions).get(f.id)!);
      for (const [id, name] of own.variables) this.memberNames.set(id, name);
      for (const [id, name] of own.dispatchers) this.dispatcherNames.set(id, name);
    }
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'keep', '_'));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'camel'));
    for (const h of program.helpers) this.helperNames.set(h.id, this.fileScope.claim(h.name, 'camel'));
  }

  emit(): GeneratedCode {
    if (this.program.declaration) return this.emitDeclaration();
    const out = this.out;
    out.line(`// Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    out.line('// Do not edit: changes are overwritten when the graph is compiled.');
    out.line();
    out.line(`#include "${cppHeaderName(this.options.sourceFileName)}"`);
    for (const header of this.sourceIncludes()) out.line(`#include "${header}"`);
    out.line();
    if (this.program.helpers.length) {
      out.line('namespace {');
      out.line();
      for (const helper of this.program.helpers) this.helperFunction(helper);
      out.line('}  // namespace');
      out.line();
    }
    if (this.library) {
      out.line(`namespace ${this.className} {`);
      out.line();
      for (const fn of this.program.functions) this.functionMethod(fn);
      out.trimTrailingBlank();
      out.line(`}  // namespace ${this.className}`);
      return this.finish(this.libraryHeader());
    }
    const parent = this.program.classInfo?.parent;
    if (!parent || this.program.hasStart) this.method(parent ? 'void start() override' : 'virtual void start()', 'void', 'start', [], 'public', () => this.statements(this.program.start));
    for (const fn of this.program.functions) this.functionMethod(fn);
    // The interface functions the class gives no body: they do nothing and return defaults.
    for (const { type, stubs } of this.program.interfaces ?? []) {
      for (const fn of stubs) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => ({ name: scope.claim(p.name, 'camel'), type: p.type }));
        const outputs = fn.outputs.filter((p) => p.kind === 'data');
        const returns = this.resultType(outputs.map((o) => o.type));
        const name = this.interfaceNames(type).functions.get(fn.id)!;
        this.method(`${returns} ${name}(${this.paramList(params)}) override`, returns, name, params, 'public', () => {
          if (outputs.length) this.out.line(`return ${this.resultValue(outputs.map((o) => this.defaultFor(o.type)))};`);
        });
      }
    }
    // Test Case events: methods Run Tests calls, named after every other member.
    this.tests = (this.program.tests ?? []).map((t) => ({ name: t.name, method: this.names.claim(`test ${t.name}`, 'camel') }));
    this.program.tests?.forEach((t, i) => this.method(`void ${this.tests[i].method}()`, 'void', this.tests[i].method, [], 'public', () => this.statements(t.body)));
    // run_test: a test by its method's name, for Run's scaffold (C++ has no reflection).
    this.method('void run_test(std::string name)', 'void', 'run_test', [{ name: 'name', type: { id: 'string' } }], 'public', () => {
      for (const test of this.tests) this.out.line(`if (name == ${literal(test.method)}) { ${test.method}(); vgraph::run_latent_actions(); return; }`);
      this.out.line('throw std::runtime_error("No test named " + name);');
    });
    for (const block of this.program.blocks) this.method(`void ${this.blockNames.get(block.id)}()`, 'void', this.blockNames.get(block.id)!, [], 'private', () => this.statements(block.body));
    out.trimTrailingBlank();
    return this.finish(this.classHeader());
  }

  // ---- Files ----------------------------------------------------------------------------------

  private finish(header: string): GeneratedCode {
    const main = this.program.functions.find((f) => f.event?.entry === 'Main');
    return {
      text: this.out.toString(),
      companionFiles: [{ fileName: cppHeaderName(this.options.sourceFileName), text: header }],
      className: this.className,
      nodeLines: this.out.nodeLines,
      // Other graphs' generated files and the project's headers it uses (Run compiles them too).
      ...(this.program.imports.some((i) => i.path) ? { importedFiles: [...new Set(this.program.imports.map((i) => i.path).filter(Boolean))].sort() } : {}),
      codeBreaks: this.out.breaks,
      ...(main ? { mainMethod: this.functionNames.get(main.id) } : {}),
      ...this.pinExpressions(),
      ...(this.tests.length ? { tests: this.tests } : {})
    };
  }

  private pinExpressions(): { pinExpressions?: PinExpression[] } {
    const pins = (this.program.pinValues ?? []).map((p) => ({ graphId: p.graphId, nodeId: p.nodeId, pinId: p.pinId, expression: this.expr(p.value) }));
    return pins.length ? { pinExpressions: pins } : {};
  }

  // The start of every header: what it is, the include guard, the standard headers and the support
  // code, then the headers of the types it uses by value or derives from.
  private headerStart(includes: string[]): string[] {
    return [
      `// Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`,
      '// Do not edit: changes are overwritten when the graph is compiled.',
      '#pragma once',
      '',
      ...CPP_RUNTIME_INCLUDES.map((h) => `#include ${h}`),
      '',
      `#ifndef ${CPP_RUNTIME_GUARD}`,
      `#define ${CPP_RUNTIME_GUARD}`,
      CPP_RUNTIME,
      `#endif  // ${CPP_RUNTIME_GUARD}`,
      '',
      ...includes.map((h) => `#include "${h}"`),
      ...(includes.length ? [''] : [])
    ];
  }

  private classHeader(): string {
    const lines = this.headerStart(this.headerIncludes());
    // Other classes are referred to by shared pointer, so a declaration is enough.
    const parent = this.program.classInfo?.parent;
    const declared = this.program.imports.filter((i) => i.userType?.kind === 'class' && i.id !== parent).map((i) => i.name);
    for (const name of [...new Set(declared)]) lines.push(`class ${name};`);
    if (declared.length) lines.push('');
    const bases = [parent ? `public ${this.userTypeName(parent)}` : 'public vgraph::Object', ...(this.program.interfaces ?? []).map((i) => `public ${this.userTypeName(i.type.id)}`)];
    lines.push(`class ${this.className} : ${bases.join(', ')} {`);
    const sections: Record<'public' | 'protected' | 'private', string[]> = { public: [], protected: [], private: [] };
    for (const m of this.program.members.filter((x) => !x.function)) sections[m.access ?? 'public'].push(`${this.typeName(m.type)} ${this.memberNames.get(m.id)} = ${this.coerce(m.initial, m.type)};`);
    for (const d of this.program.dispatchers ?? []) sections.public.push(`vgraph::Dispatcher<${d.params.map((p) => this.typeName(p.type)).join(', ')}> ${this.dispatcherNames.get(d.id)};`);
    sections.public.push(`virtual ~${this.className}() = default;`);
    for (const m of this.methods) sections[m.access].push(`${m.declaration};`);
    for (const x of this.program.slots.filter((s) => !s.function)) sections.private.push(`${this.typeName(x.type)} ${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)};`);
    for (const access of ['public', 'protected', 'private'] as const) {
      if (!sections[access].length) continue;
      lines.push(`${access}:`);
      for (const line of sections[access]) lines.push(`    ${line}`);
    }
    lines.push('};', '');
    return lines.join('\n');
  }

  private libraryHeader(): string {
    const lines = this.headerStart(this.headerIncludes());
    lines.push(`namespace ${this.className} {`);
    for (const m of this.methods) lines.push(`${m.declaration};`);
    lines.push(`}  // namespace ${this.className}`, '');
    return lines.join('\n');
  }

  // A struct (a value, copied on assignment as in Unreal), an enum or an interface (an abstract
  // class), with how its values print.
  private emitDeclaration(): GeneratedCode {
    const declaration = this.program.declaration!;
    const lines = this.headerStart(this.headerIncludes());
    const name = this.className;
    if (declaration.kind === 'interface') {
      const names = this.interfaceNames(declaration.type);
      lines.push(`class ${name} {`, 'public:', `    virtual ~${name}() = default;`);
      for (const fn of declaration.type.functions) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => ({ name: scope.claim(p.name, 'camel'), type: p.type }));
        lines.push(`    virtual ${this.resultType(fn.outputs.filter((p) => p.kind === 'data').map((o) => o.type))} ${names.functions.get(fn.id)}(${this.paramList(params)}) = 0;`);
      }
      lines.push('};', '');
    } else if (declaration.kind === 'enum') {
      const members = cppEnumMembers(declaration.type);
      lines.push(`enum class ${name} { ${declaration.type.enumerators.map((e) => members.get(e.id)).join(', ')} };`, '');
      lines.push(`inline std::string vgraph_format(${name} value) {`, '    switch (value) {');
      for (const e of declaration.type.enumerators) lines.push(`        case ${name}::${members.get(e.id)}: return ${literal(e.name)};`);
      lines.push('    }', '    return "";', '}', `inline std::string vgraph_json(${name} value) { return vgraph::json_string(vgraph_format(value)); }`, '');
    } else {
      const type = declaration.type;
      const fields = cppFieldNames(type);
      lines.push(`struct ${name} {`);
      type.fields.forEach((f, i) => lines.push(`    ${this.typeName(f.type)} ${fields.get(f.id)} = ${this.coerce(declaration.initial[i], f.type)};`));
      lines.push(`    bool operator==(const ${name}&) const = default;`, '};', '');
      // As Print shows it: each field by name, in order.
      const parts = type.fields.map((f, i) => `${i ? '"," + ' : ''}vgraph::json_string(${literal(f.name)}) + ":" + vgraph_json(value.${fields.get(f.id)})`);
      lines.push(`inline std::string vgraph_json(const ${name}& value) { return "{" + ${parts.length ? parts.join(' + ') : '""'} + "}"; }`);
      lines.push(`inline std::string vgraph_format(const ${name}& value) { return vgraph_json(value); }`, '');
    }
    this.out.line(`// Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    this.out.line('// Do not edit: changes are overwritten when the graph is compiled.');
    this.out.line(`#include "${cppHeaderName(this.options.sourceFileName)}"`);
    return this.finish(lines.join('\n'));
  }

  // Headers of the user types the header needs whole: structs, enums and interfaces it holds or
  // implements, and the parent class.
  private headerIncludes(): string[] {
    const parent = this.program.classInfo?.parent;
    return this.includesOf(this.program.imports.filter((i) => i.userType && (i.userType.kind !== 'class' || i.id === parent)));
  }

  // The source includes every other generated header it uses (classes it constructs or calls,
  // libraries), and the project's headers it calls into.
  private sourceIncludes(): string[] {
    const header = new Set(this.headerIncludes());
    return this.includesOf(this.program.imports).filter((h) => !header.has(h));
  }

  private includesOf(imports: IrImport[]): string[] {
    const headers = imports.filter((i) => i.path).map((i) => {
      const generated = /\.vgraph\.cpp$/.test(i.path) ? i.path.replace(/\.cpp$/, '.h') : i.path;
      return relativeSpecifier(this.options.outputDir ?? '', generated).replace(/^\.\//, '');
    });
    return [...new Set(headers)].sort();
  }

  // ---- Methods ------------------------------------------------------------------------------

  // A member function: declared in the header (`declaration`), defined in the source.
  private method(declaration: string, returns: string, name: string, params: { name: string; type?: TypeRef }[], access: MethodSpec['access'], body: () => void): void {
    this.methods.push({ declaration, access });
    this.out.endNode();
    const qualified = this.library ? name : `${this.className}::${name}`;
    this.out.line(`${returns} ${qualified}(${this.paramList(params)}) {`);
    this.out.indent();
    body();
    this.out.dedent();
    this.out.line('}');
    this.out.line();
  }

  private paramList(params: { name: string; type?: TypeRef }[]): string {
    return params.map((p) => `${this.typeName(p.type)} ${p.name}`).join(', ');
  }

  // A function graph as a member function (a free function in a library): its locals and its
  // nodes' outputs are variables of each call.
  private functionMethod(fn: IrFunction): void {
    const scope = new NameScope(RESERVED);
    const params = fn.params.map((p) => {
      const name = scope.claim(p.name, 'camel');
      this.paramNames.set(`${fn.id}\u0000${p.id}`, name);
      return { name, type: p.type };
    });
    const locals = this.program.members.filter((m) => m.function === fn.id);
    for (const m of locals) this.memberNames.set(m.id, scope.claim(m.name, 'camel'));
    const slots = this.program.slots.filter((x) => x.function === fn.id);
    for (const x of slots) this.slotNames.set(x.id, scope.claim(x.name, 'keep', '_'));
    const returns = this.resultType(fn.outputs.map((o) => o.type));
    const name = this.functionNames.get(fn.id)!;
    const access = this.library ? 'public' : fn.access ?? 'public';
    // Private functions can't be overridden; the others can.
    const qualifier = this.library || access === 'private' ? '' : fn.overrides ? '' : 'virtual ';
    const declaration = `${qualifier}${returns} ${name}(${this.paramList(params)})${!this.library && fn.overrides ? ' override' : ''}`;
    if (fn.description) this.out.line(`// ${fn.description.replace(/\s+/g, ' ')}`);
    this.method(declaration, returns, name, params, access, () => {
      // A custom event keeps the inputs other flows read, as Unreal keeps an event's outputs.
      for (const store of fn.event?.stores ?? []) this.out.line(`${this.slotNames.get(store.slot)} = ${this.paramNames.get(`${fn.id}\u0000${store.param}`)};`);
      for (const m of locals) this.out.line(`${this.typeName(m.type)} ${this.memberNames.get(m.id)} = ${this.coerce(m.initial, m.type)};`);
      for (const x of slots) this.out.line(`${this.typeName(x.type)} ${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)};`);
      this.statements(fn.body);
      // Reaching the end without a Return Node returns the outputs' defaults.
      if (fn.outputs.length && fn.body[fn.body.length - 1]?.kind !== 'return') this.out.line(`return ${this.resultValue(fn.outputs.map((o) => this.defaultFor(o.type)))};`);
    });
  }

  private resultType(types: (TypeRef | undefined)[]): string {
    if (!types.length) return 'void';
    if (types.length === 1) return this.typeName(types[0]);
    return `std::tuple<${types.map((t) => this.typeName(t)).join(', ')}>`;
  }

  private resultValue(values: string[]): string {
    return values.length === 1 ? values[0] : `std::make_tuple(${values.join(', ')})`;
  }

  // A code node's snippet as a free function; containers are passed by reference, as Unreal's
  // array functions change the array they are given.
  private helperFunction(helper: IrCodeHelper): void {
    const scope = new NameScope(RESERVED);
    const params = helper.params.map((p, i) => ({
      pinId: p.pinId,
      name: /^[A-Za-z_]\w*$/.test(p.pinId) && !RESERVED.has(p.pinId) ? scope.claim(p.pinId) : scope.claim(`pin${i}`),
      type: p.type
    }));
    const byPin = new Map(params.map((p) => [p.pinId, p.name]));
    const code = helper.code.replace(/\$\{([^}]+)\}/g, (_m, pin: string) => byPin.get(pin) ?? pin);
    const paramText = params.map((p) => `${p.type?.container ? 'auto&&' : this.typeName(p.type)} ${p.name}`).join(', ');
    const returns = !helper.returns ? 'void' : helper.returns.id === 'any' || helper.returns.id.startsWith('wildcard') ? 'auto' : this.typeName(helper.returns);
    this.out.endNode();
    this.out.line(`${returns} ${this.helperNames.get(helper.id)}(${paramText}) {`);
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

  private statement(s: IrStatement): void {
    const { out } = this;
    if (s.kind === 'callBlock') out.endNode();
    else out.node(s.source, (text) => `// ${text}`);
    switch (s.kind) {
      case 'print':
        out.line(`std::cout << ${this.text(s.value)} << '\\n';`);
        break;
      case 'assert':
        out.line(`if (!(${this.expr(s.condition)})) throw std::runtime_error(${this.expr(s.message)});`);
        break;
      case 'store': {
        const slot = this.program.slots.find((x) => x.id === s.slot);
        out.line(`${this.slotNames.get(s.slot)} = ${this.coerce(s.value, slot?.type)};`);
        break;
      }
      case 'setMember': {
        const member = this.program.members.find((m) => m.id === s.member);
        out.line(`${this.memberNames.get(s.member)} = ${this.coerce(s.value, member?.type)};`);
        break;
      }
      case 'if': {
        out.line(`if (${this.expr(s.condition)}) {`);
        this.block(s.then);
        let rest = s.else;
        while (rest.length === 1 && rest[0].kind === 'if' && sameSource(rest[0], s)) {
          const inner: Extract<IrStatement, { kind: 'if' }> = rest[0];
          out.line(`} else if (${this.expr(inner.condition)}) {`);
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
        const counter = this.slotNames.get(s.counter)!;
        const stop = s.stop ? ` && !${this.slotNames.get(s.stop)}` : '';
        out.line(`for (${counter} = ${this.coerce(s.first, INT)}; ${counter} <= ${this.coerce(s.last, INT)}${stop}; ${counter}++) {`);
        this.block(s.body);
        out.line('}');
        break;
      }
      case 'while':
        out.line(`while (${this.expr(s.condition)}) {`);
        this.block(s.body);
        out.line('}');
        break;
      case 'forEach': {
        // The array is read before each pass, as Unreal's For Each Loop reads it.
        const index = this.slotNames.get(s.index)!;
        const element = this.program.slots.find((x) => x.id === s.element);
        const array = this.coerce(s.array, element?.type ? { ...element.type, container: 'array' } : undefined);
        const stop = s.stop ? ` && !${this.slotNames.get(s.stop)}` : '';
        out.line(`for (${index} = 0; ${index} < static_cast<long long>((${array}).size())${stop}; ${index}++) {`);
        out.indent();
        out.line(`${this.slotNames.get(s.element)} = (${array})[${index}];`);
        this.statements(s.body);
        out.dedent();
        out.line('}');
        break;
      }
      case 'call': {
        const call = this.call(s.callee, s.args);
        const code = s.results ? this.program.imports.find((i) => i.id === s.callee.id) : undefined;
        if (s.results && code?.results?.kind === 'out') {
          // A project function's out parameters (docs/node-authoring.md, gap 3): variables of the
          // code's own types, passed by reference, then each into its output's slot.
          const results = code.results;
          const n = ++this.temps;
          const temps = results.names.map((_, i) => `vg_out${n}_${i}`);
          out.line('{');
          out.indent();
          temps.forEach((t, i) => out.line(`${results.types?.[i] ?? 'std::any'} ${t}{};`));
          const withOuts = this.call(s.callee, s.args, temps);
          if (results.returnValue) out.line(`auto vg_return = ${withOuts};`);
          else out.line(`${withOuts};`);
          const values = [...(results.returnValue ? ['vg_return'] : []), ...temps];
          for (const r of s.results) out.line(`${this.slotNames.get(r.slot)} = ${values[code.outputs!.findIndex((o) => o.id === r.output)]};`);
          out.dedent();
          out.line('}');
          break;
        }
        if (s.results) {
          out.line(`std::tie(${s.results.map((r) => this.slotNames.get(r.slot)).join(', ')}) = ${call};`);
          break;
        }
        if (!s.resultSlot) {
          out.line(`${call};`);
          break;
        }
        const slot = this.program.slots.find((x) => x.id === s.resultSlot);
        const returns = calleeSignature(s.callee, this.program)?.returns;
        out.line(`${this.slotNames.get(s.resultSlot)} = ${this.cast(call, returns, slot?.type)};`);
        break;
      }
      case 'callBlock':
        out.line(`${this.blockNames.get(s.block)}();`);
        break;
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === s.function)!;
        const call = this.functionCall(fn, s.args);
        if (!s.results.length) out.line(`${call};`);
        else if (fn.outputs.length === 1) out.line(`${this.slotNames.get(s.results[0].slot)} = ${call};`);
        else out.line(`std::tie(${fn.outputs.map((o) => this.slotNames.get(s.results.find((r) => r.output === o.id)?.slot ?? '') ?? 'std::ignore').join(', ')}) = ${call};`);
        break;
      }
      case 'bindEvent': {
        const fn = this.program.functions.find((f) => f.id === s.event);
        const params = (fn?.params ?? []).map((p, i) => ({ name: `a${i}`, type: p.type }));
        const handler = `[this](${this.paramList(params)}) { ${this.functionNames.get(s.event)}(${params.map((p) => p.name).join(', ')}); }`;
        if (s.bind) out.line(`${this.dispatcherRef(s)}.bind(this, ${literal(s.event)}, ${handler});`);
        else out.line(`${this.dispatcherRef(s)}.unbind(this, ${literal(s.event)});`);
        break;
      }
      case 'unbindAll':
        out.line(`${this.dispatcherRef(s)}.clear();`);
        break;
      case 'broadcast': {
        const other = s.target && s.type ? classInfo(this.program, s.type)?.dispatchers.find((d) => d.id === s.dispatcher)?.inputs.filter((p) => p.kind === 'data') : undefined;
        const params = other ?? this.program.dispatchers?.find((d) => d.id === s.dispatcher)?.params ?? [];
        out.line(`${this.dispatcherRef(s)}.broadcast(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')});`);
        break;
      }
      case 'await': {
        // An async function (docs/node-authoring.md, gap 4): Completed runs with the future's value
        // when it's ready, from the latent queue.
        out.line(`vgraph::await_latent(${this.call(s.callee, s.args)}, [=, this](${s.resultSlot ? 'auto value' : ''}) {`);
        out.indent();
        if (s.resultSlot) out.line(`${this.slotNames.get(s.resultSlot)} = value;`);
        this.statements(s.then);
        out.dedent();
        out.line('});');
        break;
      }
      case 'delay': {
        if (s.generation) {
          // Retriggerable: only the latest start's countdown runs Completed.
          const generation = this.slotNames.get(s.generation)!;
          const started = `${generation}_started`;
          out.line('{');
          out.indent();
          out.line(`auto ${started} = ++${generation};`);
          out.line(`vgraph::delay(${this.coerce(s.duration, FLOAT)}, [=, this]() {`);
          out.indent();
          out.line(`if (${started} != ${generation}) return;`);
          this.statements(s.then);
          out.dedent();
          out.line('});');
          out.dedent();
          out.line('}');
          break;
        }
        const pending = this.slotNames.get(s.pending!)!;
        out.line(`if (!${pending}) {`);
        out.indent();
        out.line(`${pending} = true;`);
        out.line(`vgraph::delay(${this.coerce(s.duration, FLOAT)}, [=, this]() {`);
        out.indent();
        out.line(`${pending} = false;`);
        this.statements(s.then);
        out.dedent();
        out.line('});');
        out.dedent();
        out.line('}');
        break;
      }
      case 'cast': {
        const type = this.userTypeName(s.type);
        const cast = `cast${++this.casts}`;
        out.line(`if (auto ${cast} = std::dynamic_pointer_cast<${type}>(${this.expr(s.value)})) {`);
        out.indent();
        out.line(`${this.slotNames.get(s.slot)} = ${cast};`);
        this.statements(s.succeeded);
        out.dedent();
        if (s.failed.length) {
          out.line('} else {');
          this.block(s.failed);
        }
        out.line('}');
        break;
      }
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, s.type);
        const fn = iface?.functions.find((f) => f.id === s.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(s.target)}.${iface ? this.interfaceNames(iface).functions.get(s.function) : s.function}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        this.results(call, s.results, outputs.length);
        break;
      }
      case 'parentCall': {
        const parent = this.program.classInfo?.parent;
        if (s.start) {
          out.line(`${parent ? this.userTypeName(parent) : 'vgraph::Object'}::start();`);
          break;
        }
        const fn = this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === s.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${parent ? this.userTypeName(parent) : ''}::${this.parentFunctionName(s.function!)}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        this.results(call, s.results, outputs.length);
        break;
      }
      case 'construct': {
        const slot = this.slotNames.get(s.slot)!;
        out.line(`${slot} = std::make_shared<${this.userTypeName(s.type)}>();`);
        out.line(`${slot}->start();`);
        break;
      }
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
        this.results(call, s.results, fn?.outputs.filter((p) => p.kind === 'data').length ?? 0);
        break;
      }
      case 'return': {
        const fn = this.program.functions.find((f) => f.id === s.source.graphId);
        if (!fn || !fn.outputs.length) out.line('return;');
        else out.line(`return ${this.resultValue(fn.outputs.map((o, i) => this.coerce(s.values[i] ?? { kind: 'default', type: o.type }, o.type)))};`);
        break;
      }
    }
  }

  // A call whose outputs go to slots: one is the return value, several come back as a tuple.
  private results(call: string, results: { output: string; slot: string }[], outputs: number): void {
    if (!results.length) this.out.line(`${call};`);
    else if (outputs === 1) this.out.line(`${this.slotNames.get(results[0].slot)} = ${call};`);
    else this.out.line(`std::tie(${results.map((r) => this.slotNames.get(r.slot)).join(', ')}) = ${call};`);
  }

  // ---- Expressions --------------------------------------------------------------------------

  private expr(e: IrExpr): string {
    switch (e.kind) {
      case 'literal':
        return literal(e.value);
      case 'default':
        return this.defaultFor(e.type);
      case 'member':
        return this.memberNames.get(e.member)!;
      case 'output':
        return this.slotNames.get(e.slot)!;
      case 'add':
        return `${this.operand(e.left)} + ${this.operand(e.right)}`;
      case 'toNumber': {
        const type = this.typeOf(e.value);
        if (isNumeric(type)) return type?.id === 'int' ? `static_cast<double>(${this.expr(e.value)})` : this.expr(e.value);
        return `vgraph::to_number(${this.expr(e.value)})`;
      }
      case 'toText':
        return this.text(e.value);
      case 'concat':
        return e.parts.map((part) => this.operand(part)).join(' + ');
      case 'toBoolean': {
        const type = this.typeOf(e.value);
        if (type?.id === 'bool' && !type.container) return this.expr(e.value);
        return `vgraph::to_boolean(${this.expr(e.value)})`;
      }
      case 'call': {
        const call = this.call(e.callee, e.args);
        if (!e.output) return call;
        const imported = this.program.imports.find((i) => i.id === e.callee.id);
        return `std::get<${(imported?.outputs ?? []).findIndex((o) => o.id === e.output)}>(${call})`;
      }
      case 'binary': {
        const type = e.op === '&&' || e.op === '||' ? BOOL : this.typeOf(e.left) ?? this.typeOf(e.right);
        const side = (x: IrExpr) => (type ? this.cast(this.operand(x), this.typeOf(x), type, x.kind === 'literal') : this.operand(x));
        return `${side(e.left)} ${e.op} ${side(e.right)}`;
      }
      case 'not':
        return `!${this.operand(e.value)}`;
      case 'param':
        return this.paramNames.get(`${e.function}\u0000${e.id}`) ?? 'std::any()';
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(fn, e.args);
        return fn.outputs.length === 1 ? call : `std::get<${fn.outputs.findIndex((o) => o.id === e.output)}>(${call})`;
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return 'std::any()';
        return `${this.userTypeName(type.id)}{${type.fields.map((f, i) => this.coerce(e.fields[i], f.type)).join(', ')}}`;
      }
      case 'structField': {
        const type = this.types.get(e.type);
        return `${this.operand(e.value)}.${type?.kind === 'struct' ? cppFieldNames(type).get(e.field) : e.field}`;
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        return `${this.userTypeName(e.type)}::${type?.kind === 'enum' ? cppEnumMembers(type).get(e.value) : e.value}`;
      }
      case 'self':
        return `std::static_pointer_cast<${this.className}>(shared_from_this())`;
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, e.type);
        const fn = iface?.functions.find((f) => f.id === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}.${iface ? this.interfaceNames(iface).functions.get(e.function) : e.function}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return e.output ? `std::get<${(fn?.outputs.filter((p) => p.kind === 'data') ?? []).findIndex((o) => o.id === e.output)}>(${call})` : call;
      }
      case 'parentCall': {
        const fn = this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const parent = this.program.classInfo?.parent;
        const call = `${parent ? this.userTypeName(parent) : ''}::${this.parentFunctionName(e.function)}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return e.output ? `std::get<${(fn?.outputs.filter((p) => p.kind === 'data') ?? []).findIndex((o) => o.id === e.output)}>(${call})` : call;
      }
      case 'isValid':
        return `vgraph::is_valid(${this.expr(e.value)})`;
      case 'objectVariable':
        return `${this.targetRef(e.target)}.${this.membersOf(e.type)?.variables.get(e.variable)}`;
      case 'objectCall': {
        const fn = classInfo(this.program, e.type)?.functions.find((f) => f.id === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}.${this.membersOf(e.type)?.functions.get(e.function)}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return e.output ? `std::get<${(fn?.outputs.filter((p) => p.kind === 'data') ?? []).findIndex((o) => o.id === e.output)}>(${call})` : call;
      }
      case 'makeContainer': {
        const element = { id: e.type.id };
        const type = this.typeName(e.type);
        if (e.type.container === 'map') {
          const pairs: string[] = [];
          for (let i = 0; i + 1 < e.items.length; i += 2) pairs.push(`{${this.coerce(e.items[i], element)}, ${this.coerce(e.items[i + 1], e.type.valueType)}}`);
          return `${type}{${pairs.join(', ')}}`;
        }
        return `${type}{${e.items.map((item) => this.coerce(item, element)).join(', ')}}`;
      }
    }
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' || e.kind === 'concat' ? `(${text})` : text;
  }

  private functionCall(fn: IrFunction, args: IrExpr[]): string {
    return `${this.functionNames.get(fn.id)}(${args.map((a, i) => this.coerce(a, fn.params[i]?.type)).join(', ')})`;
  }

  // `extra` arguments follow the inputs (out parameters).
  private call(callee: IrCallee, args: IrExpr[], extra: string[] = []): string {
    const signature = calleeSignature(callee, this.program);
    const list = [...args.map((a, i) => (signature?.params[i]?.type?.container ? this.expr(a) : this.coerce(a, signature?.params[i]?.type))), ...extra].join(', ');
    if (callee.kind === 'helper') return `${this.helperNames.get(callee.id)}(${list})`;
    const imported = this.program.imports.find((i) => i.id === callee.id)!;
    const qualified = (i: { name: string; module?: string }) => `${i.module ? `${i.module}::` : ''}${i.name}`;
    const member = imported.member;
    if (!member) return `${qualified(imported)}(${list})`;
    // A code class's member (docs/node-authoring.md, gap 2): its objects travel in a std::any, as
    // their class and each class it extends (vgraph::code_new, vgraph::code_object).
    if (member.kind === 'construct') return `vgraph::code_new<${[imported, ...(imported.bases ?? [])].map(qualified).join(', ')}>(${list})`;
    const [target, ...rest] = args;
    const object = `vgraph::code_object<${qualified(imported)}>(${this.expr(target)})`;
    const values = [...rest.map((a, i) => this.coerce(a, signature?.params[i + 1]?.type)), ...extra].join(', ');
    return member.kind === 'get' ? `${object}.${member.name}` : member.kind === 'set' ? `${object}.${member.name} = ${values}` : `${object}.${member.name}(${values})`;
  }

  // The value as text, per docs/semantics.md ("Values").
  private text(e: IrExpr): string {
    const type = this.typeOf(e);
    if (type?.id === 'string' && !type.container) return this.operand(e);
    return `vgraph_format(${this.expr(e)})`;
  }

  // An expression for a slot, member or parameter of type `target`. A container default (JSON: an
  // array, or a map's [key, value] pairs) becomes the container.
  private coerce(e: IrExpr, target: TypeRef | undefined): string {
    if (e.kind === 'literal' && target?.container && Array.isArray(e.value)) {
      const type = this.typeName(target);
      const element = (v: unknown, t: TypeRef | undefined) => this.cast(literal(v), literalTypeOf(v), t, true);
      if (target.container === 'map') {
        const pairs = e.value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2);
        return `${type}{${pairs.map(([k, v]) => `{${element(k, { id: target.id })}, ${element(v, target.valueType)}}`).join(', ')}}`;
      }
      return `${type}{${e.value.map((v) => element(v, { id: target.id })).join(', ')}}`;
    }
    return this.cast(this.expr(e), this.typeOf(e), target, e.kind === 'literal');
  }

  private cast(text: string, from: TypeRef | undefined, target: TypeRef | undefined, isLiteral = false): string {
    if (!target || target.id === 'any' || target.id.startsWith('wildcard')) return text;
    if (sameType(from, target)) return text;
    if (from && !from.container && !target.container) {
      if (from.id === 'int' && target.id === 'float') return isLiteral ? `${text}.0` : `static_cast<double>(${text})`;
      if (from.id === 'float' && target.id === 'int') return isLiteral && /^-?\d+$/.test(text) ? text : `static_cast<long long>(${text})`;
      if (from.id === target.id) return text;
    }
    if (isLiteral && text === 'nullptr') return this.defaultFor(target);
    if (from && from.container === target.container && sameType({ ...from, nullable: undefined }, { ...target, nullable: undefined })) return text;
    return `vgraph::as<${this.typeName(target)}>(${text})`;
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (!type) return 'std::any()';
    if (type.container) return `${this.typeName(type)}{}`;
    const user = this.types.get(type.id);
    if (user?.kind === 'struct') return `${this.userTypeName(user.id)}{}`;
    if (user?.kind === 'enum' && user.enumerators[0]) return `${this.userTypeName(user.id)}::${cppEnumMembers(user).get(user.enumerators[0].id)}`;
    switch (type.id) {
      case 'bool':
        return 'false';
      case 'int':
        return '0';
      case 'float':
        return '0.0';
      case 'string':
        return 'std::string()';
      default:
        return type.id.startsWith('object:') || type.id.startsWith('interface:') ? 'nullptr' : 'std::any()';
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
    const names = claimClassMembers(classScope(new NameScope(RESERVED).claim(iface.name, 'pascal')), { functions: iface.functions, events: [], variables: [], dispatchers: [] }, CLASS_STYLES);
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
    const names = claimClassMembers(classScope(new NameScope(RESERVED).claim(info.name, 'pascal')), info, CLASS_STYLES, this.inheritedMembers(info));
    this.classNames.set(id, names);
    return names;
  }

  // An object member is reached through its object, which isn't None.
  private targetRef(e: IrExpr): string {
    return e.kind === 'self' ? '(*this)' : `vgraph::deref(${this.expr(e)})`;
  }

  private dispatcherRef(s: { dispatcher: string; target?: IrExpr; type?: string }): string {
    if (s.target && s.type) return `${this.targetRef(s.target)}.${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}`;
    return this.dispatcherNames.get(s.dispatcher)!;
  }

  // The name a struct, enum, interface or class goes by, from the global namespace: a member may
  // have its type's name (a Stats variable called Stats), which hides the type inside the class.
  private userTypeName(id: string): string {
    if (this.program.declaration?.type.id === id || id === `object:${this.program.className}`) return `::${this.className}`;
    const imported = this.program.imports.find((i) => i.id === id);
    return imported ? `::${imported.name}` : 'std::any';
  }

  private mapType(type: TypeRef): string {
    if (!isUserTypeId(type.id) && !(type.valueType && isUserTypeId(type.valueType.id))) return mapType(type);
    const userElement = (t: TypeRef) => {
      if (!isUserTypeId(t.id)) return mapType({ id: t.id });
      const name = this.userTypeName(t.id);
      return t.id.startsWith('object:') || t.id.startsWith('interface:') ? `std::shared_ptr<${name}>` : name;
    };
    const element = userElement(type);
    const value = type.valueType ? this.mapType(type.valueType) : 'std::any';
    if (type.container === 'array') return `std::vector<${element}>`;
    if (type.container === 'set') return `std::set<${element}>`;
    if (type.container === 'map') return `vgraph::Map<${element}, ${value}>`;
    return element;
  }

  private typeName(type: TypeRef | undefined): string {
    return this.mapType(type ?? { id: 'any' });
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

// A JSON value as a C++ literal. Text is a std::string, so it never decays to a pointer (which
// would print as a boolean).
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'nullptr';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NAN';
    if (!Number.isFinite(value)) return value > 0 ? 'INFINITY' : '-INFINITY';
    return String(value);
  }
  if (typeof value === 'string') return `std::string(${cppString(value)})`;
  return 'nullptr';
}

// A C++ string literal in UTF-8. Control characters are hex escapes, closed off so a following hex
// digit isn't taken into the escape.
function cppString(text: string): string {
  let body = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') body += '\\\\';
    else if (ch === '"') body += '\\"';
    else if (ch === '\n') body += '\\n';
    else if (ch === '\r') body += '\\r';
    else if (ch === '\t') body += '\\t';
    else if (code < 0x20) body += `\\x${code.toString(16).padStart(2, '0')}""`;
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
