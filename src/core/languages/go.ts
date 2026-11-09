// Go pack (docs/language-breadth.md, "Go"): a struct with methods per graph, generated from Visual
// IR, in its folder's package. The package's support code is one file (go-runtime.ts). Run builds a
// scratch module that maps the generated files into a package of its own (`go build -overlay`).
import { IrCallee, IrCodeHelper, IrExpr, IrFunction, IrImport, IrProgram, IrStatement, calleeSignature, classInfo, exprType, interfaceInfo, programClassSpec, userTypes } from '../compiler/ir';
import { ClassMemberNames, ClassMemberStyles, NameScope, claimClassMembers, dedent, toIdentifier } from '../compiler/names';
import { CodeWriter } from '../compiler/writer';
import { CodeGenerator, GenerateOptions, GeneratedCode, LanguagePack, PinExpression, RunContext } from '../language-pack';
import { OutputPlan, PlacementContext } from '../output-plan';
import type { InterfaceInfo } from '../objects';
import { LANGUAGE_TERMS } from '../terms';
import { TypeRef, parseTypeId } from '../types';
import { EnumInfo, StructInfo, UserType, isUserTypeId } from '../user-types';
import { GO_RUNTIME_FILE, goRuntime } from './go-runtime';

const RESERVED = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import',
  'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
  // Predeclared identifiers, and names generated code relies on.
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64',
  'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'true', 'false', 'iota', 'nil', 'append', 'cap', 'clear',
  'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max', 'min', 'new', 'panic', 'print', 'println', 'real', 'recover',
  'self', 'base64', 'math', 'rand', 'url', 'strings', 'strconv', 'regexp', 'utf8', 'os', 'fmt', 'sort', 'slices', 'time', 'unicode', 'cast', 'ok', 'args', 'started',
  'md5', 'sha1', 'sha256', 'hex'
]);

const PRIMITIVES: Record<string, string> = { bool: 'bool', int: 'int', float: 'float64', string: 'string', any: 'any', wildcard: 'any' };

// Types from project code (native) are passed on as `any`.
function mapType(type: TypeRef): string {
  const { category, name } = parseTypeId(type.id);
  const element = PRIMITIVES[type.id] ?? (category === 'native' ? 'any' : category === 'object' ? `*${name}` : name);
  if (type.container === 'array') return `*[]${element}`;
  if (type.container === 'set') return `*VgSet[${element}]`;
  if (type.container === 'map') return `*VgMap[${element}, ${type.valueType ? mapType(type.valueType) : 'any'}]`;
  return element;
}

export function goOutputFileName(graphFileName: string): string {
  return `${toIdentifier(graphFileName.replace(/\.vgraph$/i, ''), 'snake')}_vgraph.go`;
}

// The package a generated file is in when nothing says otherwise: its folder's name.
export function goPackageName(options: GenerateOptions): string {
  if (options.namespace) return options.namespace;
  const folder = (options.outputDir ?? '').split('/').filter(Boolean).pop() ?? '';
  const name = toIdentifier(folder, 'snake').replace(/_/g, '').toLowerCase();
  return name && !RESERVED.has(name) && name !== 'main' ? name : 'graphs';
}

// The scratch module Run builds: the generated file and the package's other files (sources) are
// mapped into ./vg by an overlay, next to the support code; main.go runs Start, Main and the
// latent actions, or (with --test) each test.
export function goRunModule(file: { path: string }, className: string, context: RunContext): Record<string, string> {
  const [pkg, type] = className.includes('.') ? [className.slice(0, className.lastIndexOf('.')), className.slice(className.lastIndexOf('.') + 1)] : ['graphs', className];
  const separator = context.platform === 'win32' ? '\\' : '/';
  const base = (p: string) => p.split(/[\\/]/).pop()!;
  const replace: Record<string, string> = {};
  for (const source of [file.path, ...(context.sources ?? [])]) replace[[context.scaffoldDir, 'vg', base(source)].join(separator)] = source;
  const module = context.goModule;
  return {
    'go.mod': [
      '// Built by Blueprint Visual Scripting to run generated Go. Safe to delete.',
      'module blueprint_run',
      '',
      'go 1.22',
      ...(module ? ['', `require ${module.path} v0.0.0`, '', `replace ${module.path} => ${JSON.stringify(module.dir.replace(/\\/g, '/'))}`] : []),
      ''
    ].join('\n'),
    'overlay.json': JSON.stringify({ Replace: replace }, null, 2),
    [`vg/${GO_RUNTIME_FILE}`]: goRuntime(pkg),
    'main.go': [
      '// Runs a generated class: Start, then Main with the arguments, then the latent actions; with',
      '// --test first, each test (given as name and method) on a new object.',
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\t"os"',
      '',
      '\tvg "blueprint_run/vg"',
      ')',
      '',
      'func main() {',
      '\targs := os.Args[1:]',
      '\tif len(args) > 0 && args[0] == "--test" {',
      '\t\tfailed := 0',
      '\t\tfor i := 1; i+1 < len(args); i += 2 {',
      '\t\t\tif message, ok := runTest(args[i+1]); ok {',
      '\t\t\t\tfmt.Println("PASS " + args[i])',
      '\t\t\t} else {',
      '\t\t\t\tfailed++',
      '\t\t\t\tfmt.Println("FAIL " + args[i] + ": " + message)',
      '\t\t\t}',
      '\t\t}',
      '\t\tif failed == 0 {',
      '\t\t\tfmt.Println("All tests passed.")',
      '\t\t\treturn',
      '\t\t}',
      '\t\tfmt.Printf("%d test(s) failed.\\n", failed)',
      '\t\tos.Exit(1)',
      '\t}',
      '\tdefer func() {',
      '\t\tif r := recover(); r != nil {',
      '\t\t\tvg.VgReport(r)',
      '\t\t}',
      '\t}()',
      `\tobject := vg.New${type}()`,
      '\tobject.Start()',
      ...(context.mainMethod ? [`\tobject.${context.mainMethod}(&args)`] : []),
      '\tvg.VgRunLatentActions()',
      '}',
      '',
      'func runTest(method string) (message string, ok bool) {',
      '\tdefer func() {',
      '\t\tif r := recover(); r != nil {',
      '\t\t\tmessage, ok = vg.VgPanicMessage(r), false',
      '\t\t}',
      '\t}()',
      `\tvg.New${type}().VgRunTest(method)`,
      '\tvg.VgRunLatentActions()',
      '\treturn "", true',
      '}',
      ''
    ].join('\n')
  };
}

const executable = (context: RunContext | undefined) => `${context?.scaffoldDir}/run${context?.platform === 'win32' ? '.exe' : ''}`;
const goBuild = (debug: boolean) => (_file: { path: string }, _className: string, context: RunContext) => [
  '-C', context.scaffoldDir ?? '.', 'build', ...(debug ? ['-gcflags=all=-N -l'] : []), '-overlay', 'overlay.json', '-o', `run${context.platform === 'win32' ? '.exe' : ''}`, '.'
];

export function goLibraryExports(_libraryName: string, functions: { id: string; name: string }[]): { names: Map<string, string> } {
  const scope = new NameScope(RESERVED);
  return { names: new Map(functions.map((f) => [f.id, scope.claim(f.name, 'pascal')])) };
}

// Field names of a struct and constant names of an enum's values (exported), the same in the type's
// own file and in every file that uses it.
export function goFieldNames(type: StructInfo): Map<string, string> {
  const scope = new NameScope(RESERVED, ['VgFields']);
  return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, 'pascal')]));
}

export function goEnumMembers(type: EnumInfo): Map<string, string> {
  const owner = new NameScope(RESERVED).claim(type.name, 'pascal');
  const scope = new NameScope(RESERVED);
  return new Map(type.enumerators.map((e) => [e.id, `${owner}${scope.claim(e.name, 'pascal')}`]));
}

// Public members are exported (capitalized), so other packages can use them.
const CLASS_STYLES: ClassMemberStyles = { functions: 'pascal', variables: 'pascal', dispatchers: 'pascal' };

function classScope(): NameScope {
  return new NameScope(RESERVED, ['Start', 'VgRunTest']);
}

// The support code each package folder with generated files needs (docs/language-breadth.md, "Go"):
// one owned vgraph_runtime.go, in the package the generated files declare.
export function goPlacement(context: PlacementContext): OutputPlan {
  const folders = new Map<string, string[]>();
  for (const file of context.generatedFiles) {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    folders.set(dir, [...(folders.get(dir) ?? []), file]);
  }
  const ownedFiles: NonNullable<OutputPlan['ownedFiles']> = [];
  for (const [dir, files] of folders) {
    const pkg = files.map((f) => /^package\s+(\w+)/m.exec(context.readFile(f) ?? '')?.[1]).find(Boolean);
    if (pkg) ownedFiles.push({ path: dir ? `${dir}/${GO_RUNTIME_FILE}` : GO_RUNTIME_FILE, text: goRuntime(pkg) });
  }
  return ownedFiles.length ? { ownedFiles } : {};
}

const goGenerator: CodeGenerator = {
  libraryExports: goLibraryExports,
  snippetLanguages: ['go'],
  importLanguages: ['go'],
  outputFileName: goOutputFileName,
  moduleName: (_generatedFileName, options) => options.namespace,
  placement: goPlacement,
  generate: (program, options) => new GoEmitter(program, options).emit(),
  runner: {
    commands: () => [['go']],
    // Nothing is downloaded: no toolchain switch, and the project's module comes from its folder.
    env: { GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod', GOWORK: 'off' },
    scaffold: goRunModule,
    build: goBuild(false),
    executable: (_file, _className, context) => executable(context),
    args: (_file, _className, context) => context?.args ?? [],
    testArgs: (_file, _className, context) => ['--test', ...context.tests.flatMap((t) => [t.name, t.method])],
    missingToolMessage: 'Go was not found. Install Go (go.dev) and make sure `go` is on the PATH.'
  },
  // Delve, through the Go extension, runs the program Run builds, built without optimizations.
  debugger: {
    type: 'go',
    extension: { id: 'golang.go', name: 'Go' },
    build: goBuild(true),
    // The program was built from the scratch module's view of the files (`vg/`, written with "/"):
    // Delve maps the generated file's folder, as VS Code writes it, to that and back.
    configuration: (file, _className, context) => ({
      type: 'go', request: 'launch', mode: 'exec', debugAdapter: 'dlv-dap', program: executable(context), args: context.args ?? [], cwd: context.cwd,
      substitutePath: [{ from: file.path.replace(/[\\/][^\\/]*$/, ''), to: `${context.scaffoldDir}/vg`.replace(/\\/g, '/') }]
    })
  }
};

export const goPack: LanguagePack = {
  id: 'go',
  displayName: 'Go',
  generatedFileExtension: '.go',
  workspaceMarkers: ['**/go.mod'],
  // No inheritance: embedding has no virtual calls, as Rust has none.
  capabilities: { staticTyping: true, classes: true, inheritance: false, interfaces: true, generics: true, async: true, exceptions: false, containers: ['array', 'set', 'map'], delegates: true },
  mapType,
  terms: LANGUAGE_TERMS.go,
  requires: { version: '1.21', label: 'Go 1.21', basis: 'needs', why: 'the slices package, min and max' },
  generator: goGenerator,
  // Functions marked // @blueprint, found through gopls (Tier 2).
  importer: { extensions: ['.go'], languageServer: { comments: ['//'], parameters: 'name type', returns: 'after', ignore: ['func'], objectsByPointer: true, severalResults: { error: 'error' }, exportedNames: 'capitalized', asyncChannels: true } }
};

class GoEmitter {
  private tests: { name: string; method: string }[] = [];
  private temps = 0;
  private readonly out = new CodeWriter('\t');
  private readonly names: NameScope;
  private readonly memberNames = new Map<string, string>();
  private readonly slotNames = new Map<string, string>();
  private readonly helperNames = new Map<string, string>();
  private readonly blockNames = new Map<string, string>();
  private readonly functionNames = new Map<string, string>();
  private readonly dispatcherNames = new Map<string, string>();
  private readonly paramNames = new Map<string, string>();
  private readonly className: string;
  private readonly packageName: string;
  private readonly library: boolean;
  private readonly types: Map<string, UserType>;
  private readonly classNames = new Map<string, ClassMemberNames>();
  // Packages other than this one that the code uses, by import path, with the name it uses.
  private readonly imports = new Map<string, string>();
  private currentFunction: IrFunction | undefined;

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions) {
    this.library = !!program.library;
    this.className = new NameScope(RESERVED).claim(program.className, 'pascal');
    this.packageName = goPackageName(options);
    this.types = userTypes(program);
    if (program.declaration) this.types.set(program.declaration.type.id, program.declaration.type);
    if (this.library) {
      const exports = goLibraryExports(program.className, program.functions);
      this.names = new NameScope(RESERVED, [...exports.names.values()]);
      for (const [id, name] of exports.names) this.functionNames.set(id, name);
    } else {
      this.names = classScope();
      const own = claimClassMembers(this.names, programClassSpec(program), CLASS_STYLES);
      this.classNames.set(`object:${program.className}`, own);
      for (const f of program.functions) this.functionNames.set(f.id, (f.event ? own.events : own.functions).get(f.id)!);
      for (const [id, name] of own.variables) this.memberNames.set(id, name);
      for (const [id, name] of own.dispatchers) this.dispatcherNames.set(id, name);
    }
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'keep', '_'));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'camel'));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(`${this.library ? this.className : ''} ${h.name}`, 'camel'));
  }

  emit(): GeneratedCode {
    if (this.program.declaration) return this.emitDeclaration();
    const out = this.out;
    if (!this.library) {
      const members = this.program.members.filter((m) => !m.function);
      const slots = this.program.slots.filter((x) => !x.function);
      const dispatchers = this.program.dispatchers ?? [];
      out.line(`type ${this.className} struct {`);
      out.indent();
      for (const m of members) out.line(`${this.memberNames.get(m.id)} ${this.typeName(m.type)}`);
      for (const d of dispatchers) out.line(`${this.dispatcherNames.get(d.id)} VgDispatcher`);
      for (const x of slots) out.line(`${this.slotNames.get(x.id)} ${this.typeName(x.type)}`);
      out.dedent();
      out.line('}');
      out.line();
      out.line(`func New${this.className}() *${this.className} {`);
      out.indent();
      out.line(`self := &${this.className}{}`);
      for (const m of members) out.line(`self.${this.memberNames.get(m.id)} = ${this.coerce(m.initial, m.type)}`);
      for (const x of slots) {
        const value = this.defaultFor(x.type);
        if (value !== this.zero(x.type)) out.line(`self.${this.slotNames.get(x.id)} = ${value}`);
      }
      out.line('return self');
      out.dedent();
      out.line('}');
      out.line();
      this.method('Start', [], [], () => this.statements(this.program.start));
    }
    for (const fn of this.program.functions) this.functionMethod(fn);
    // The interface functions the class gives no body: they do nothing and return defaults.
    for (const { type, stubs } of this.program.interfaces ?? []) {
      for (const fn of stubs) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => ({ name: scope.claim(p.name, 'camel'), type: p.type }));
        const outputs = fn.outputs.filter((p) => p.kind === 'data');
        this.method(this.interfaceNames(type).functions.get(fn.id)!, params, outputs.map((o) => o.type), () => {
          if (outputs.length) this.out.line(`return ${outputs.map((o) => this.defaultFor(o.type)).join(', ')}`);
        });
      }
    }
    this.tests = (this.program.tests ?? []).map((t) => ({ name: t.name, method: this.names.claim(`test ${t.name}`, 'pascal') }));
    this.program.tests?.forEach((t, i) => this.method(this.tests[i].method, [], [], () => this.statements(t.body)));
    if (!this.library) {
      // Tests by method name, for Run Tests.
      this.method('VgRunTest', [{ name: 'method', type: { id: 'string' } }], [], () => {
        this.out.line('switch method {');
        for (const t of this.tests) {
          this.out.line(`case ${JSON.stringify(t.method)}:`);
          this.out.line(`\tself.${t.method}()`);
        }
        this.out.line('default:');
        this.out.line('\tVgFail("No test named " + method)');
        this.out.line('}');
      });
    }
    for (const block of this.program.blocks) this.method(this.blockNames.get(block.id)!, [], [], () => this.statements(block.body));
    for (const helper of this.program.helpers) this.helperMethod(helper);
    out.trimTrailingBlank();
    return this.finish();
  }

  // A structure (a Go struct: a value, copied on assignment as in Unreal), an enumeration (named
  // int constants that print their names) or an interface.
  private emitDeclaration(): GeneratedCode {
    const out = this.out;
    const declaration = this.program.declaration!;
    if (declaration.kind === 'interface') {
      const names = this.interfaceNames(declaration.type);
      out.line(`type ${this.className} interface {`);
      out.indent();
      for (const fn of declaration.type.functions) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => `${scope.claim(p.name, 'camel')} ${this.typeName(p.type)}`).join(', ');
        out.line(`${names.functions.get(fn.id)}(${params})${this.results(fn.outputs.filter((p) => p.kind === 'data').map((o) => o.type))}`);
      }
      out.dedent();
      out.line('}');
    } else if (declaration.kind === 'enum') {
      const members = goEnumMembers(declaration.type);
      out.line(`type ${this.className} int`);
      out.line();
      out.line('const (');
      out.indent();
      declaration.type.enumerators.forEach((e, i) => out.line(`${members.get(e.id)}${i === 0 ? ` ${this.className} = iota` : ''}`));
      out.dedent();
      out.line(')');
      out.line();
      out.line('// As Print shows it: the value\'s name.');
      out.line(`func (value ${this.className}) String() string {`);
      out.indent();
      out.line('switch value {');
      for (const e of declaration.type.enumerators) {
        out.line(`case ${members.get(e.id)}:`);
        out.line(`\treturn ${JSON.stringify(e.name)}`);
      }
      out.line('}');
      out.line('return ""');
      out.dedent();
      out.line('}');
    } else {
      const type = declaration.type;
      const fields = goFieldNames(type);
      out.line(`type ${this.className} struct {`);
      out.indent();
      for (const f of type.fields) out.line(`${fields.get(f.id)} ${this.typeName(f.type)}`);
      out.dedent();
      out.line('}');
      out.line();
      out.line('// The struct with its fields\' default values.');
      out.line(`func New${this.className}() ${this.className} {`);
      out.line(`\treturn ${this.className}{${type.fields.map((f, i) => `${fields.get(f.id)}: ${this.coerce(declaration.initial[i], f.type)}`).join(', ')}}`);
      out.line('}');
      out.line();
      out.line('// As Print shows it: each field by name, in order.');
      out.line(`func (value ${this.className}) VgFields() []VgField {`);
      out.line(`\treturn []VgField{${type.fields.map((f) => `{${JSON.stringify(f.name)}, value.${fields.get(f.id)}}`).join(', ')}}`);
      out.line('}');
    }
    return this.finish();
  }

  private finish(): GeneratedCode {
    const body = this.out.toString();
    const header = new CodeWriter('\t');
    // Go's marker of a generated file, which gopls, staticcheck's style checks and code review honor.
    header.line(`// Code generated by Blueprint Visual Scripting from ${this.options.sourceFileName}. DO NOT EDIT.`);
    header.line('// Changes are overwritten when the graph is compiled.');
    header.line();
    header.line(`package ${this.packageName}`);
    header.line();
    // Go refuses imports a file doesn't use: only the ones the code names.
    const code = body.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/gm, '');
    const standard = ['crypto/md5', 'crypto/sha1', 'crypto/sha256', 'encoding/base64', 'encoding/hex', 'math', 'math/rand', 'net/url', 'os', 'regexp', 'slices', 'sort', 'strconv', 'strings', 'time', 'unicode/utf8'].filter((path) => new RegExp(`(^|[^\\w.])${path.split('/').pop()}\\.`, 'm').test(code));
    const imports = [...standard.map((p) => `"${p}"`), ...[...this.imports].sort().map(([path, name]) => `${name} "${path}"`)];
    if (imports.length) {
      header.line('import (');
      for (const i of imports) header.line(`\t${i}`);
      header.line(')');
      header.line();
    }
    const headerText = header.toString();
    const offset = headerText.split('\n').length - 1;
    const importedFiles = [...new Set(this.program.imports.map((i) => i.path).filter((path) => path))].sort();
    const main = this.program.functions.find((f) => f.event?.entry === 'Main');
    return {
      text: headerText + body,
      className: `${this.packageName}.${this.className}`,
      nodeLines: this.out.nodeLines.map((n) => ({ ...n, line: n.line + offset })),
      codeBreaks: this.out.breaks.map((line) => line + offset),
      ...(importedFiles.length ? { importedFiles } : {}),
      ...(main ? { mainMethod: this.functionNames.get(main.id) } : {}),
      ...this.pinExpressions(),
      ...(this.tests.length ? { tests: this.tests } : {})
    };
  }

  private pinExpressions(): { pinExpressions?: PinExpression[] } {
    const pins = (this.program.pinValues ?? []).map((p) => ({ graphId: p.graphId, nodeId: p.nodeId, pinId: p.pinId, expression: this.expr(p.value) }));
    return pins.length ? { pinExpressions: pins } : {};
  }

  // ---- Members -----------------------------------------------------------------------------------

  private method(name: string, params: { name: string; type?: TypeRef }[], returns: (TypeRef | undefined)[], body: () => void): void {
    this.out.endNode();
    const list = params.map((p) => `${p.name} ${this.typeName(p.type)}`).join(', ');
    this.out.line(`func ${this.library ? '' : `(self *${this.className}) `}${name}(${list})${this.results(returns)} {`);
    this.out.indent();
    body();
    this.out.dedent();
    this.out.line('}');
    this.out.line();
  }

  private results(types: (TypeRef | undefined)[]): string {
    if (!types.length) return '';
    return types.length === 1 ? ` ${this.typeName(types[0])}` : ` (${types.map((t) => this.typeName(t)).join(', ')})`;
  }

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
    for (const x of slots) this.slotNames.set(x.id, scope.claim(x.name, 'camel'));
    if (fn.description) this.out.line(`// ${fn.description.replace(/\s+/g, ' ')}`);
    this.method(this.functionNames.get(fn.id)!, params, fn.outputs.map((o) => o.type), () => {
      for (const store of fn.event?.stores ?? []) this.out.line(`self.${this.slotNames.get(store.slot)} = ${this.paramNames.get(`${fn.id}\u0000${store.param}`)}`);
      const names: string[] = [];
      for (const m of locals) {
        names.push(this.memberNames.get(m.id)!);
        this.out.line(`var ${this.memberNames.get(m.id)} ${this.typeName(m.type)} = ${this.coerce(m.initial, m.type)}`);
      }
      for (const x of slots) {
        names.push(this.slotNames.get(x.id)!);
        this.out.line(`var ${this.slotNames.get(x.id)} ${this.typeName(x.type)} = ${this.defaultFor(x.type)}`);
      }
      // Every node's output is a variable; Go refuses variables nothing reads.
      if (names.length) this.out.line(`${names.map(() => '_').join(', ')} = ${names.join(', ')}`);
      this.currentFunction = fn;
      this.statements(fn.body);
      this.currentFunction = undefined;
      if (fn.outputs.length && canComplete(fn.body)) this.out.line(`return ${fn.outputs.map((o) => this.defaultFor(o.type)).join(', ')}`);
    });
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
    this.method(this.helperNames.get(helper.id)!, params, helper.returns ? [helper.returns] : [], () => {
      for (const line of dedent(code)) this.out.line(line.replace(/^ {4}/g, '\t'));
    });
  }

  // ---- Statements --------------------------------------------------------------------------------

  private statements(statements: IrStatement[]): void {
    for (const s of statements) this.statement(s);
  }

  private statement(s: IrStatement): void {
    const { out } = this;
    if (s.kind === 'callBlock') out.endNode();
    else out.node(s.source, (text) => `// ${text}`);
    switch (s.kind) {
      case 'print':
        out.line(`VgPrint(${this.text(s.value)})`);
        break;
      case 'assert':
        out.line(`if !(${this.expr(s.condition)}) {`);
        out.line(`\tVgFail(${this.text(s.message)})`);
        out.line('}');
        break;
      case 'store':
        out.line(`${this.slotRef(s.slot)} = ${this.coerce(s.value, this.program.slots.find((x) => x.id === s.slot)?.type)}`);
        break;
      case 'setMember':
        out.line(`${this.memberRef(s.member)} = ${this.coerce(s.value, this.program.members.find((m) => m.id === s.member)?.type)}`);
        break;
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
        const counter = this.slotRef(s.counter);
        const stop = s.stop ? ` && !${this.slotRef(s.stop)}` : '';
        out.line(`for ${counter} = ${this.coerce(s.first, INT)}; ${counter} <= ${this.coerce(s.last, INT)}${stop}; ${counter}++ {`);
        this.block(s.body);
        out.line('}');
        break;
      }
      case 'while':
        out.line(`for ${this.expr(s.condition)} {`);
        this.block(s.body);
        out.line('}');
        break;
      case 'forEach': {
        // The array is read before each pass, as Unreal's For Each Loop reads it.
        const index = this.slotRef(s.index);
        const element = this.program.slots.find((x) => x.id === s.element);
        const array = this.coerce(s.array, element?.type ? { ...element.type, container: 'array' } : undefined);
        const stop = s.stop ? ` && !${this.slotRef(s.stop)}` : '';
        out.line(`for ${index} = 0; ${index} < len(${deref(array)})${stop}; ${index}++ {`);
        out.indent();
        out.line(`${this.slotRef(s.element)} = (${deref(array)})[${index}]`);
        this.statements(s.body);
        out.dedent();
        out.line('}');
        break;
      }
      case 'call': {
        const call = this.call(s.callee, s.args);
        if (s.results) {
          const imported = this.program.imports.find((i) => i.id === s.callee.id);
          if (imported?.results?.error) {
            // A project function's last `error` result (docs/node-authoring.md, gap 3): the run
            // stops with it when it isn't nil.
            const err = `vgErr${++this.temps}`;
            const targets = imported.outputs?.length ? `${this.targets(imported.outputs, s.results)}, ` : '';
            out.line(`var ${err} error`);
            out.line(`${targets}${err} = ${call}`);
            out.line(`if ${err} != nil {`);
            out.line(`\tVgFail(${err}.Error())`);
            out.line('}');
            break;
          }
          out.line(`${this.targets(imported?.outputs ?? [], s.results)} = ${call}`);
          break;
        }
        if (!s.resultSlot) {
          out.line(call);
          break;
        }
        const slot = this.program.slots.find((x) => x.id === s.resultSlot);
        const returns = calleeSignature(s.callee, this.program)?.returns;
        out.line(`${this.slotRef(s.resultSlot)} = ${sameType(returns, slot?.type) ? call : this.cast(call, returns, slot?.type)}`);
        break;
      }
      case 'callBlock':
        out.line(`${this.self()}${this.blockNames.get(s.block)}()`);
        break;
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === s.function)!;
        const call = this.functionCall(fn, s.args);
        out.line(s.results.length ? `${this.targets(fn.outputs, s.results)} = ${call}` : call);
        break;
      }
      case 'bindEvent': {
        const event = this.functionNames.get(s.event)!;
        if (s.bind) out.line(`${this.dispatcherRef(s)}.Bind(self, ${JSON.stringify(event)}, ${this.handler(s.event)})`);
        else out.line(`${this.dispatcherRef(s)}.Unbind(self, ${JSON.stringify(event)})`);
        break;
      }
      case 'unbindAll':
        out.line(`${this.dispatcherRef(s)}.Clear()`);
        break;
      case 'broadcast': {
        const other = s.target && s.type ? classInfo(this.program, s.type)?.dispatchers.find((d) => d.id === s.dispatcher)?.inputs.filter((p) => p.kind === 'data') : undefined;
        const params = other ?? this.program.dispatchers?.find((d) => d.id === s.dispatcher)?.params ?? [];
        out.line(`${this.dispatcherRef(s)}.Broadcast(${s.args.map((a, i) => this.coerce(a, params[i]?.type, true)).join(', ')})`);
        break;
      }
      case 'await': {
        // An async function (docs/node-authoring.md, gap 4): Completed runs with the first value
        // its channel gives, from the latent queue.
        out.line(`VgAwait(${this.call(s.callee, s.args)}, func(value any) {`);
        out.indent();
        if (s.resultSlot) {
          const slot = this.program.slots.find((x) => x.id === s.resultSlot);
          out.line(`${this.slotRef(s.resultSlot)} = VgAs[${this.typeName(slot?.type)}](value)`);
        } else out.line('_ = value');
        this.statements(s.then);
        out.dedent();
        out.line('})');
        break;
      }
      case 'delay': {
        if (s.generation) {
          // Retriggerable: only the latest start's countdown runs Completed.
          const generation = this.slotRef(s.generation);
          const started = `${this.slotNames.get(s.generation)}Started`;
          out.line(`${generation}++`);
          out.line(`${started} := ${generation}`);
          out.line(`VgDelay(${this.expr(s.duration)}, func() {`);
          out.indent();
          out.line(`if ${started} != ${generation} {`);
          out.line('\treturn');
          out.line('}');
          this.statements(s.then);
          out.dedent();
          out.line('})');
          break;
        }
        const pending = this.slotRef(s.pending!);
        out.line(`if !${pending} {`);
        out.indent();
        out.line(`${pending} = true`);
        out.line(`VgDelay(${this.expr(s.duration)}, func() {`);
        out.indent();
        out.line(`${pending} = false`);
        this.statements(s.then);
        out.dedent();
        out.line('})');
        out.dedent();
        out.line('}');
        break;
      }
      case 'cast': {
        // Only interfaces: Go has no subclasses to cast to.
        out.line(`if cast, ok := any(${this.expr(s.value)}).(${this.userTypeName(s.type)}); ok {`);
        out.indent();
        out.line(`${this.slotRef(s.slot)} = cast`);
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
        const call = `${this.expr(s.target)}.${iface ? this.interfaceNames(iface).functions.get(s.function) : s.function}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        out.line(s.results.length ? `${this.targets(outputs, s.results)} = ${call}` : call);
        break;
      }
      case 'parentCall':
        // Not reached: Go has no inheritance (its capabilities say so).
        break;
      case 'construct':
        out.line(`${this.slotRef(s.slot)} = ${this.constructorOf(s.type)}()`);
        out.line(`${this.slotRef(s.slot)}.Start()`);
        break;
      case 'setObjectVariable':
        out.line(`${this.expr(s.target)}.${this.membersOf(s.type)?.variables.get(s.variable)} = ${this.coerce(s.value, classInfo(this.program, s.type)?.variables.find((v) => v.id === s.variable)?.type)}`);
        break;
      case 'objectCall': {
        const info = classInfo(this.program, s.type);
        const names = this.membersOf(s.type);
        const fn = s.function !== undefined ? info?.functions.find((f) => f.id === s.function) : undefined;
        const params = (fn ? fn.inputs : info?.events.find((e) => e.id === s.event)?.inputs ?? []).filter((p) => p.kind === 'data');
        const name = s.function !== undefined ? names?.functions.get(s.function) : names?.events.get(s.event!);
        const call = `${this.expr(s.target)}.${name}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        out.line(s.results.length ? `${this.targets(outputs, s.results)} = ${call}` : call);
        break;
      }
      case 'return': {
        const fn = this.currentFunction;
        if (!fn || !fn.outputs.length) out.line('return');
        else out.line(`return ${fn.outputs.map((o, i) => this.coerce(s.values[i] ?? { kind: 'default', type: o.type }, o.type)).join(', ')}`);
        break;
      }
    }
  }

  // The left side of assigning a call's outputs: each output's slot, or _ for those not used.
  private targets(outputs: { id: string }[], results: { output: string; slot: string }[]): string {
    if (outputs.length <= 1) return results[0] ? this.slotRef(results[0].slot) : '_';
    return outputs.map((o) => {
      const result = results.find((r) => r.output === o.id);
      return result ? this.slotRef(result.slot) : '_';
    }).join(', ');
  }

  // A bound event: a handler taking the dispatcher's arguments, each as its parameter's type.
  private handler(eventId: string): string {
    const fn = this.program.functions.find((f) => f.id === eventId);
    const args = (fn?.params ?? []).map((p, i) => `VgAs[${this.typeName(p.type)}](args[${i}])`);
    return `func(args []any) { self.${this.functionNames.get(eventId)}(${args.join(', ')}) }`;
  }

  private block(statements: IrStatement[]): void {
    this.out.indent();
    this.statements(statements);
    this.out.dedent();
  }

  private slotRef(id: string): string {
    const name = this.slotNames.get(id)!;
    return this.program.slots.find((x) => x.id === id)?.function ? name : `self.${name}`;
  }

  private memberRef(id: string): string {
    const name = this.memberNames.get(id)!;
    return this.program.members.find((m) => m.id === id)?.function ? name : `self.${name}`;
  }

  // Methods are called on self, except a library's functions.
  private self(): string {
    return this.library ? '' : 'self.';
  }

  // ---- Expressions -------------------------------------------------------------------------------

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
        // Go adds constants exactly (0.1 + 0.2 is 0.3); a number from VgFloat is a float64, added as
        // at run time.
        return `${this.number(e.left)} + ${this.number(e.right)}`;
      case 'toNumber': {
        const type = this.typeOf(e.value);
        if (isNumeric(type)) return type?.id === 'int' ? `float64(${this.expr(e.value)})` : this.expr(e.value);
        return `VgToNumber(${this.expr(e.value)})`;
      }
      case 'toText':
        return this.text(e.value);
      case 'concat':
        return e.parts.map((part) => this.operand(part)).join(' + ');
      case 'toBoolean': {
        const type = this.typeOf(e.value);
        if (type?.id === 'bool' && !type.container) return this.expr(e.value);
        return `VgToBoolean(${this.expr(e.value)})`;
      }
      case 'call': {
        const call = this.call(e.callee, e.args);
        if (!e.output) return call;
        const imported = this.program.imports.find((i) => i.id === e.callee.id);
        return this.output(call, imported?.outputs ?? [], e.output);
      }
      case 'binary': {
        const type = e.op === '&&' || e.op === '||' ? BOOL : this.typeOf(e.left) ?? this.typeOf(e.right);
        const side = (x: IrExpr) => (type ? this.cast(this.operand(x), this.typeOf(x), type, x.kind === 'literal') : this.operand(x));
        return `${side(e.left)} ${e.op} ${side(e.right)}`;
      }
      case 'not':
        return `!${this.operand(e.value)}`;
      case 'param':
        return this.paramNames.get(`${e.function}\u0000${e.id}`) ?? 'nil';
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(fn, e.args);
        return fn.outputs.length === 1 ? call : this.output(call, fn.outputs, e.output);
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return 'nil';
        const fields = goFieldNames(type);
        return `${this.userTypeName(type.id)}{${type.fields.map((f, i) => `${fields.get(f.id)}: ${this.coerce(e.fields[i], f.type)}`).join(', ')}}`;
      }
      case 'structField': {
        const type = this.types.get(e.type);
        return `${this.operand(e.value)}.${type?.kind === 'struct' ? goFieldNames(type).get(e.field) : e.field}`;
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        return `${this.qualifier(e.type)}${type?.kind === 'enum' ? goEnumMembers(type).get(e.value) : e.value}`;
      }
      case 'self':
        return 'self';
      case 'isValid':
        return `${this.operand(e.value)} != nil`;
      case 'objectVariable':
        return `${this.expr(e.target)}.${this.membersOf(e.type)?.variables.get(e.variable)}`;
      case 'objectCall': {
        const fn = classInfo(this.program, e.type)?.functions.find((f) => f.id === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.expr(e.target)}.${this.membersOf(e.type)?.functions.get(e.function)}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return this.output(call, fn?.outputs.filter((p) => p.kind === 'data') ?? [], e.output);
      }
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, e.type);
        const fn = iface?.functions.find((f) => f.id === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.expr(e.target)}.${iface ? this.interfaceNames(iface).functions.get(e.function) : e.function}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return this.output(call, fn?.outputs.filter((p) => p.kind === 'data') ?? [], e.output);
      }
      case 'parentCall':
        return 'nil';
      case 'makeContainer': {
        const element = { id: e.type.id };
        if (e.type.container === 'map') {
          return `NewVgMap[${this.typeName(element)}, ${this.typeName(e.type.valueType)}](${e.items.map((item, i) => this.coerce(item, i % 2 === 0 ? element : e.type.valueType, true)).join(', ')})`;
        }
        const items = e.items.map((item) => this.coerce(item, element));
        if (e.type.container === 'set') return `NewVgSet[${this.typeName(element)}](${items.join(', ')})`;
        return `&[]${this.typeName(element)}{${items.join(', ')}}`;
      }
    }
  }

  // One output of a call with several: an immediately called function that returns it.
  private output(call: string, outputs: { id: string; type?: TypeRef }[], output: string | undefined): string {
    if (outputs.length <= 1) return call;
    const index = Math.max(0, outputs.findIndex((o) => o.id === output));
    return `func() ${this.typeName(outputs[index]?.type)} { ${outputs.map((_, i) => (i === index ? 'value' : '_')).join(', ')} := ${call}; return value }()`;
  }

  private number(e: IrExpr): string {
    const value = e.kind === 'toNumber' ? e.value : e;
    return value.kind === 'literal' && typeof value.value === 'number' && Number.isFinite(value.value) ? `VgFloat(${literal(value.value)})` : this.operand(e);
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' || e.kind === 'not' ? `(${text})` : text;
  }

  private functionCall(fn: IrFunction, args: IrExpr[]): string {
    return `${this.self()}${this.functionNames.get(fn.id)}(${args.map((a, i) => this.coerce(a, fn.params[i]?.type)).join(', ')})`;
  }

  private call(callee: IrCallee, args: IrExpr[]): string {
    const signature = calleeSignature(callee, this.program);
    const list = args.map((a, i) => this.coerce(a, signature?.params[i]?.type)).join(', ');
    if (callee.kind === 'helper') return `${this.self()}${this.helperNames.get(callee.id)}(${list})`;
    const imported = this.program.imports.find((i) => i.id === callee.id)!;
    const member = imported.member;
    if (!member || member.kind === 'construct') return `${this.importQualifier(imported)}${imported.name}(${list})`;
    // A struct's method or field (docs/node-authoring.md, gap 2): its objects travel as `any`, so the
    // Target is asserted to the struct's pointer.
    const [target, ...rest] = args;
    const object = `any(${this.expr(target)}).(*${this.importQualifier(imported)}${imported.name})`;
    const values = rest.map((a, i) => this.coerce(a, signature?.params[i + 1]?.type)).join(', ');
    return member.kind === 'get' ? `${object}.${member.name}` : member.kind === 'set' ? `${object}.${member.name} = ${values}` : `${object}.${member.name}(${values})`;
  }

  // A function of another package is called through its import; of this one, directly.
  private importQualifier(imported: IrImport): string {
    const path = imported.module;
    if (!path || path === this.options.packagePath || path === this.options.namespace || path === this.packageName) return '';
    const name = path.split('/').pop()!.replace(/[^\w]/g, '_');
    this.imports.set(path, name);
    return `${name}.`;
  }

  // The value as text, per docs/semantics.md ("Values").
  private text(e: IrExpr): string {
    const type = this.typeOf(e);
    if (type && !type.container) {
      if (type.id === 'string') return this.expr(e);
      if (type.id === 'int') return `VgFormatNumber(float64(${this.expr(e)}))`;
      if (type.id === 'float') return `VgFormatNumber(${this.expr(e)})`;
    }
    return `VgFormat(${this.expr(e)})`;
  }

  // An expression for a slot, member or parameter of type `target`. A container default (JSON: an
  // array, or a map's [key, value] pairs) becomes the container. `untyped`: it goes where any value
  // does (a dispatcher's arguments, a map's items), so a number is given its type.
  private coerce(e: IrExpr, target: TypeRef | undefined, untyped = false): string {
    if (e.kind === 'literal' && target?.container && Array.isArray(e.value)) {
      const element = { id: target.id };
      const item = (v: unknown, t: TypeRef | undefined, loose: boolean) => this.coerce({ kind: 'literal', value: v }, t, loose);
      if (target.container === 'map') {
        const pairs = e.value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2);
        return `NewVgMap[${this.typeName(element)}, ${this.typeName(target.valueType)}](${pairs.flatMap(([k, v]) => [item(k, element, true), item(v, target.valueType, true)]).join(', ')})`;
      }
      const items = e.value.map((v) => item(v, element, false));
      return target.container === 'set' ? `NewVgSet[${this.typeName(element)}](${items.join(', ')})` : `&[]${this.typeName(element)}{${items.join(', ')}}`;
    }
    const text = this.cast(this.expr(e), this.typeOf(e), target, e.kind === 'literal');
    // An untyped constant in an `any` slot takes its default type (int for 2): give it the right one.
    if (untyped && e.kind === 'literal' && typeof e.value === 'number' && target && !target.container && (target.id === 'float' || target.id === 'int')) return `${target.id === 'float' ? 'float64' : 'int'}(${text})`;
    return text;
  }

  private cast(text: string, from: TypeRef | undefined, target: TypeRef | undefined, isLiteral = false): string {
    if (!target || target.id === 'any' || target.id === 'wildcard') return text;
    if (sameType(from, target)) return text;
    if (from && !from.container && !target.container) {
      // Untyped constants take the target's type; other numbers convert explicitly.
      if (from.id === 'int' && target.id === 'float') return isLiteral ? text : `float64(${text})`;
      if (from.id === 'float' && target.id === 'int') return isLiteral ? String(Math.trunc(Number(text))) : `int(${text})`;
      if (from.id === target.id) return text;
    }
    if (isLiteral && text === 'nil') return this.defaultFor(target);
    return `VgAs[${this.typeName(target)}](${text})`;
  }

  // A type's zero value, as Go gives a field.
  private zero(type: TypeRef | undefined): string {
    if (!type || type.container) return 'nil';
    switch (type.id) {
      case 'bool':
        return 'false';
      case 'int':
        return '0';
      case 'float':
        return '0.0';
      case 'string':
        return '""';
    }
    return this.types.get(type.id) ? '' : 'nil';
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (type?.container === 'array') return `&[]${this.typeName({ id: type.id })}{}`;
    if (type?.container === 'set') return `NewVgSet[${this.typeName({ id: type.id })}]()`;
    if (type?.container === 'map') return `NewVgMap[${this.typeName({ id: type.id })}, ${this.typeName(type.valueType)}]()`;
    const user = type && this.types.get(type.id);
    if (user?.kind === 'struct') return `${this.qualifier(user.id)}New${new NameScope(RESERVED).claim(user.name, 'pascal')}()`;
    if (user?.kind === 'enum' && user.enumerators[0]) return `${this.qualifier(user.id)}${goEnumMembers(user).get(user.enumerators[0].id)}`;
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

  private interfaceNames(iface: InterfaceInfo): ClassMemberNames {
    const cached = this.classNames.get(iface.id);
    if (cached) return cached;
    const names = claimClassMembers(classScope(), { functions: iface.functions, events: [], variables: [], dispatchers: [] }, CLASS_STYLES);
    this.classNames.set(iface.id, names);
    return names;
  }

  private membersOf(id: string): ClassMemberNames | undefined {
    const existing = this.classNames.get(id);
    if (existing) return existing;
    const info = classInfo(this.program, id);
    if (!info) return undefined;
    const names = claimClassMembers(classScope(), info, CLASS_STYLES);
    this.classNames.set(id, names);
    return names;
  }

  private dispatcherRef(s: { dispatcher: string; target?: IrExpr; type?: string }): string {
    if (s.target && s.type) return `${this.expr(s.target)}.${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}`;
    return `self.${this.dispatcherNames.get(s.dispatcher)}`;
  }

  // A user type of another package is used through its import.
  private qualifier(id: string): string {
    if (this.program.declaration?.type.id === id || id === `object:${this.program.className}`) return '';
    const imported = this.program.imports.find((i) => i.id === id);
    return imported ? this.importQualifier(imported) : '';
  }

  private userTypeName(id: string): string {
    const { name } = parseTypeId(id);
    return `${this.qualifier(id)}${new NameScope(RESERVED).claim(name, 'pascal')}`;
  }

  private constructorOf(id: string): string {
    const { name } = parseTypeId(id);
    return `${this.qualifier(id)}New${new NameScope(RESERVED).claim(name, 'pascal')}`;
  }

  private mapType(type: TypeRef): string {
    if (!isUserTypeId(type.id) && !(type.valueType && isUserTypeId(type.valueType.id))) return mapType(type);
    const elementOf = (t: TypeRef): string => {
      if (!isUserTypeId(t.id)) return mapType({ id: t.id });
      const { category } = parseTypeId(t.id);
      return category === 'object' ? `*${this.userTypeName(t.id)}` : this.userTypeName(t.id);
    };
    const element = elementOf(type);
    if (type.container === 'array') return `*[]${element}`;
    if (type.container === 'set') return `*VgSet[${element}]`;
    if (type.container === 'map') return `*VgMap[${element}, ${type.valueType ? this.mapType(type.valueType) : 'any'}]`;
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

function canComplete(statements: IrStatement[]): boolean {
  const last = statements[statements.length - 1];
  if (!last) return true;
  if (last.kind === 'return') return false;
  if (last.kind === 'if') return canComplete(last.then) || canComplete(last.else);
  return true;
}

// The slice a pointer to one points to: a literal's address is the literal itself (staticcheck's
// SA4001 rejects `*&[]int{...}`).
function deref(pointer: string): string {
  return /^&\[\][\w.*]+\{.*\}$/s.test(pointer) ? pointer.slice(1) : `*${pointer}`;
}

// A JSON value as a Go literal (an untyped constant where it can be).
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'math.NaN()';
    if (!Number.isFinite(value)) return `math.Inf(${value > 0 ? 1 : -1})`;
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  return 'nil';
}

const INT: TypeRef = { id: 'int' };
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
