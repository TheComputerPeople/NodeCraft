// C# pack: generates a C# class per graph from Visual IR, and runs it through a small console
// project (docs/program-structure.md, "C# language pack").
import { IrBlock, IrCallee, IrCodeHelper, IrExpr, IrFunction, IrProgram, IrStatement, calleeSignature, exprType, userTypes, classInfo, programClassSpec, interfaceInfo } from '../compiler/ir';
import { ClassMemberNames, ClassMemberStyles, InheritedMembers, NameScope, claimClassMembers, dedent } from '../compiler/names';
import type { ClassInfo, InterfaceInfo } from '../objects';
import { CodeWriter } from '../compiler/writer';
import { scanCSharp } from '../importing/csharp-scanner';
import { CodeGenerator, GenerateOptions, GeneratedCode, LanguagePack } from '../language-pack';
import { EnumInfo, StructInfo, UserType, isUserTypeId } from '../user-types';
import { TypeRef, parseTypeId } from '../types';

const RESERVED = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal',
  'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for',
  'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null',
  'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte',
  'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
  // Not keywords, but a member with these names would hide what generated code uses.
  'System', 'Console', 'Math', 'Convert'
]);

// Helper methods emitted into the generated class on demand. They implement docs/semantics.md
// ("Values") exactly as Simulate does, so output matches the other targets.
const HELPER_NAMES = ['FormatValue', 'FormatNumber', 'ToNumber', 'ToBoolean', 'As'];
const HELPERS: Record<'format' | 'number' | 'boolean' | 'as', string[]> = {
  format: [
    'private static string FormatValue(object? value) => value switch',
    '{',
    '    null => "",',
    '    bool b => b ? "true" : "false",',
    '    string s => s,',
    '    double d => FormatNumber(d),',
    '    float f => FormatNumber(f),',
    '    int or long or short or byte or sbyte or uint or ulong or ushort or decimal => FormatNumber(Convert.ToDouble(value, CultureInfo.InvariantCulture)),',
    '    _ => ToJson(value)',
    '};',
    '',
    '// Containers print as JSON, numbers by the rules below: sets in ascending order (they have no',
    '// order of their own), dictionaries in the order their keys were added.',
    'private static string ToJson(object? value)',
    '{',
    '    switch (value)',
    '    {',
    '        case null:',
    '            return "null";',
    '        case bool b:',
    '            return b ? "true" : "false";',
    '        case string s:',
    '            return JsonString(s);',
    '        case double or float or int or long or short or byte or sbyte or uint or ulong or ushort or decimal:',
    '            double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);',
    '            return double.IsFinite(number) ? FormatNumber(number) : "null";',
    '        case System.Collections.IDictionary map:',
    '            var entries = new List<string>();',
    '            foreach (System.Collections.DictionaryEntry entry in map) entries.Add(JsonString(entry.Key is string key ? key : FormatValue(entry.Key)) + ":" + ToJson(entry.Value));',
    '            return "{" + string.Join(",", entries) + "}";',
    '        case System.Collections.IEnumerable items:',
    '            var list = new List<object?>();',
    '            foreach (var item in items) list.Add(item);',
    '            if (value.GetType().IsGenericType && value.GetType().GetGenericTypeDefinition() == typeof(HashSet<>)) list.Sort(Comparer<object?>.Default);',
    '            return "[" + string.Join(",", list.ConvertAll(ToJson)) + "]";',
    '        default:',
    '            return JsonString(value.ToString() ?? "");',
    '    }',
    '}',
    '',
    'private static string JsonString(string text)',
    '{',
    '    var json = new System.Text.StringBuilder("\\"");',
    '    foreach (char c in text)',
    '    {',
    '        switch (c)',
    '        {',
    '            case \'"\': json.Append("\\\""); break;',
    '            case \'\\\\\': json.Append("\\\\"); break;',
    '            case \'\\n\': json.Append("\\n"); break;',
    '            case \'\\r\': json.Append("\\r"); break;',
    '            case \'\\t\': json.Append("\\t"); break;',
    '            case \'\\b\': json.Append("\\b"); break;',
    '            case \'\\f\': json.Append("\\f"); break;',
    '            default:',
    '                if (c < 0x20) json.Append("\\\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));',
    '                else json.Append(c);',
    '                break;',
    '        }',
    '    }',
    '    return json.Append(\'"\').ToString();',
    '}',
    '',
    '// JavaScript\'s number-to-text rules, so every target language prints numbers the same way.',
    'private static string FormatNumber(double x)',
    '{',
    '    if (double.IsNaN(x)) return "NaN";',
    '    if (double.IsInfinity(x)) return x > 0 ? "Infinity" : "-Infinity";',
    '    if (x == 0) return "0";',
    '    string sign = x < 0 ? "-" : "";',
    '    string text = Math.Abs(x).ToString("R", CultureInfo.InvariantCulture);',
    '    int e = text.IndexOf(\'E\');',
    '    string mantissa = e < 0 ? text : text.Substring(0, e);',
    '    int exponent = e < 0 ? 0 : int.Parse(text.Substring(e + 1), CultureInfo.InvariantCulture);',
    '    int dot = mantissa.IndexOf(\'.\');',
    '    string whole = dot < 0 ? mantissa : mantissa.Substring(0, dot);',
    '    string all = whole + (dot < 0 ? "" : mantissa.Substring(dot + 1));',
    '    string digits = all.TrimStart(\'0\');',
    '    int point = whole.Length + exponent - (all.Length - digits.Length);',
    '    digits = digits.TrimEnd(\'0\');',
    '    if (digits.Length <= point && point <= 21) return sign + digits + new string(\'0\', point - digits.Length);',
    '    if (0 < point && point <= 21) return sign + digits.Substring(0, point) + "." + digits.Substring(point);',
    '    if (-6 < point && point <= 0) return sign + "0." + new string(\'0\', -point) + digits;',
    '    string rest = digits.Length > 1 ? "." + digits.Substring(1) : "";',
    '    return sign + digits[0] + rest + "e" + (point > 0 ? "+" : "-") + Math.Abs(point - 1);',
    '}'
  ],
  number: [
    'private static double ToNumber(object? value) => value switch',
    '{',
    '    null => 0,',
    '    bool b => b ? 1 : 0,',
    '    string s => s.Trim().Length == 0 ? 0 : double.TryParse(s.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double parsed) ? parsed : double.NaN,',
    '    double or float or int or long or short or byte or sbyte or uint or ulong or ushort or decimal => Convert.ToDouble(value, CultureInfo.InvariantCulture),',
    '    _ => double.NaN',
    '};'
  ],
  boolean: [
    'private static bool ToBoolean(object? value) => value switch',
    '{',
    '    null => false,',
    '    bool b => b,',
    '    string s => s.Length > 0,',
    '    double d => d != 0 && !double.IsNaN(d),',
    '    float f => f != 0 && !float.IsNaN(f),',
    '    int or long or short or byte or sbyte or uint or ulong or ushort or decimal => Convert.ToDouble(value, CultureInfo.InvariantCulture) != 0,',
    '    _ => true',
    '};'
  ],
  // A value of unknown type, used where a typed one is needed.
  as: [
    'private static T As<T>(object? value)',
    '{',
    '    if (value is T typed) return typed;',
    '    if (value is null) return default!;',
    '    return (T)Convert.ChangeType(value, typeof(T), CultureInfo.InvariantCulture);',
    '}'
  ]
};

const PRIMITIVES: Record<string, string> = { bool: 'bool', int: 'int', float: 'double', string: 'string', any: 'object', wildcard: 'object' };

// Types from project code (native) are passed on as `object`; the editor checks them by name.
function mapType(type: TypeRef): string {
  const { category, name } = parseTypeId(type.id);
  const element = PRIMITIVES[type.id] ?? (category === 'native' ? 'object' : name);
  const base = type.container === 'array' ? `List<${element}>`
    : type.container === 'set' ? `HashSet<${element}>`
    : type.container === 'map' ? `Dictionary<${element}, ${type.valueType ? mapType(type.valueType) : 'object'}>`
    : element;
  return type.nullable ? `${base}?` : base;
}

// The console project Run builds around a generated file: it calls the class's Start() by name.
export const RUN_PROJECT_FILE = 'BlueprintRun.csproj';

export function csharpRunProject(targetFramework: string, sources: string[]): Record<string, string> {
  const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return {
    [RUN_PROJECT_FILE]: [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <!-- Built by Blueprint Visual Scripting to run generated C#. Safe to delete. -->',
      '  <PropertyGroup>',
      '    <OutputType>Exe</OutputType>',
      `    <TargetFramework>${xml(targetFramework)}</TargetFramework>`,
      '    <Nullable>enable</Nullable>',
      '    <ImplicitUsings>disable</ImplicitUsings>',
      '    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>',
      '    <StartupObject>BlueprintRun.Runner</StartupObject>',
      '    <SatelliteResourceLanguages>en</SatelliteResourceLanguages>',
      '  </PropertyGroup>',
      '  <ItemGroup>',
      '    <Compile Include="BlueprintRun.cs" />',
      ...sources.map((s) => `    <Compile Include="${xml(s)}" />`),
      '  </ItemGroup>',
      '</Project>',
      ''
    ].join('\n'),
    'BlueprintRun.cs': [
      '// Runs a generated class\'s Start(), named by the first argument.',
      'namespace BlueprintRun;',
      '',
      'public static class Runner',
      '{',
      '    public static int Main(string[] args)',
      '    {',
      '        System.Console.OutputEncoding = System.Text.Encoding.UTF8;',
      '        System.Type? type = null;',
      '        foreach (var assembly in System.AppDomain.CurrentDomain.GetAssemblies()) type ??= assembly.GetType(args[0]);',
      '        if (type is null) { System.Console.Error.WriteLine("No class named " + args[0]); return 2; }',
      '        try',
      '        {',
      '            type.GetMethod("Start")!.Invoke(System.Activator.CreateInstance(type), null);',
      '            return 0;',
      '        }',
      '        catch (System.Reflection.TargetInvocationException error)',
      '        {',
      '            System.Console.Out.Flush();',
      '            System.Console.Error.WriteLine(error.InnerException);',
      '            return 1;',
      '        }',
      '    }',
      '}',
      ''
    ].join('\n')
  };
}

// A function library's static class and the names its functions are defined as (PascalCase,
// unique in the class). The library's own generated file and every file that calls it use these.
export function csharpLibraryExports(libraryName: string, functions: { id: string; name: string }[]): { names: Map<string, string>; container: string } {
  const container = new NameScope(RESERVED).claim(libraryName, 'pascal');
  const scope = new NameScope(RESERVED, [container, ...HELPER_NAMES]);
  return { names: new Map(functions.map((f) => [f.id, scope.claim(f.name, 'pascal')])), container };
}

// Element names of the tuple a function with several outputs returns.
function resultFields(outputs: { id: string; name: string }[]): Map<string, string> {
  const fields = new NameScope(RESERVED);
  return new Map(outputs.map((o) => [o.id, fields.claim(o.name, 'pascal')]));
}

// The format helpers with branches for the structs and enums a class prints: an enum prints its
// name (its [Description], else the member's name), a struct each field by name.
function formatHelper(enums: boolean, structs: boolean): string[] {
  const lines = [...HELPERS.format];
  const insert = (before: string, added: string[]): void => {
    lines.splice(lines.indexOf(before), 0, ...added);
  };
  if (enums) {
    insert('    _ => ToJson(value)', ['    Enum e => EnumName(e),']);
    insert('        case double or float or int or long or short or byte or sbyte or uint or ulong or ushort or decimal:', ['        case Enum e:', '            return JsonString(EnumName(e));']);
    lines.push(
      '',
      'private static string EnumName(Enum value)',
      '{',
      '    var names = value.GetType().GetField(value.ToString())?.GetCustomAttributes(typeof(System.ComponentModel.DescriptionAttribute), false);',
      '    return names is { Length: > 0 } ? ((System.ComponentModel.DescriptionAttribute)names[0]).Description : value.ToString();',
      '}'
    );
  }
  if (structs) {
    insert('            return JsonString(value.ToString() ?? "");', [
      '            if (value.GetType().GetMethod("BlueprintFields")?.Invoke(value, null) is (string Name, object? Value)[] fields)',
      '                return "{" + string.Join(",", Array.ConvertAll(fields, f => JsonString(f.Name) + ":" + ToJson(f.Value))) + "}";'
    ]);
  }
  return lines;
}

// Unreal's event dispatcher, emitted when the class declares one: bound events (delegates, equal
// for the same object and method) run in the order they were bound, each once.
const DISPATCHER_CLASS = [
  'public sealed class EventDispatcher<T> where T : Delegate',
  '{',
  '    private readonly List<T> handlers = new();',
  '',
  '    public void Bind(T handler)',
  '    {',
  '        if (!handlers.Contains(handler)) handlers.Add(handler);',
  '    }',
  '',
  '    public void Unbind(T handler) => handlers.Remove(handler);',
  '',
  '    public void Clear() => handlers.Clear();',
  '',
  '    // A copy, so events that bind or unbind while running don\'t disturb the loop.',
  '    public T[] Handlers => handlers.ToArray();',
  '}'
];

// Property names of a struct's fields and member names of an enum's values (PascalCase), the same
// in the type's own file and in every file that uses it.
export function csharpFieldNames(type: StructInfo): Map<string, string> {
  const scope = new NameScope(RESERVED, [new NameScope(RESERVED).claim(type.name, 'pascal'), 'BlueprintFields']);
  return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, 'pascal')]));
}

export function csharpEnumMembers(type: EnumInfo): Map<string, string> {
  const scope = new NameScope(RESERVED);
  return new Map(type.enumerators.map((e) => [e.id, scope.claim(e.name, 'pascal')]));
}

// How a class's public members are named (src/core/compiler/names.ts). A member can't share its
// class's name in C#, so each class's scope holds its own name.
const CLASS_STYLES: ClassMemberStyles = { functions: 'pascal', variables: 'keep', dispatchers: 'pascal' };

function classScope(className: string): NameScope {
  return new NameScope(RESERVED, ['Start', className, ...HELPER_NAMES, 'EventDispatcher']);
}

const csharpGenerator: CodeGenerator = {
  libraryExports: csharpLibraryExports,
  snippetLanguages: ['csharp'],
  importLanguages: ['csharp'],
  outputFileName: (graphFileName) => `${graphFileName}.cs`,
  generate: (program, options) => new CSharpEmitter(program, options).emit(),
  runner: {
    commands: () => [['dotnet']],
    env: { DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' },
    // The newest installed SDK's major version picks the target framework, so the runtime exists.
    probe: {
      args: ['--version'],
      parse: (stdout) => {
        const major = /^(\d+)\./.exec(stdout.trim())?.[1];
        return major ? { targetFramework: `net${major}.0` } : undefined;
      }
    },
    scaffold: (file, _className, context) => csharpRunProject(context.targetFramework ?? 'net8.0', [file.path, ...(context.sources ?? [])]),
    args: (_file, className, context) => ['run', '--project', `${context?.scaffoldDir}/${RUN_PROJECT_FILE}`, '--', className],
    missingToolMessage: 'The .NET SDK was not found. Install .NET 8 or later and make sure `dotnet` is on the PATH.'
  }
};

export const csharpPack: LanguagePack = {
  id: 'csharp',
  displayName: 'C#',
  generatedFileExtension: '.cs',
  workspaceMarkers: ['**/*.csproj', '**/*.sln', '**/*.slnx'],
  capabilities: { staticTyping: true, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true },
  mapType,
  generator: csharpGenerator,
  importer: { extensions: ['.cs'], scan: scanCSharp }
};

class CSharpEmitter {
  private readonly out = new CodeWriter('    ');
  private readonly names: NameScope;
  private readonly memberNames = new Map<string, string>();
  private readonly slotNames = new Map<string, string>();
  private readonly helperNames = new Map<string, string>();
  private readonly blockNames = new Map<string, string>();
  private readonly functionNames = new Map<string, string>();
  private readonly dispatcherNames = new Map<string, string>();
  // Parameter names of each function, keyed by function and input id.
  private readonly paramNames = new Map<string, string>();
  // Element names of a function's result tuple, when it has several outputs.
  private readonly outputFields = new Map<string, Map<string, string>>();
  private readonly className: string;
  private readonly helpersUsed = new Set<keyof typeof HELPERS>();
  // A function library: a static class of static methods.
  private readonly library: boolean;
  // The structs and enums the program uses (and the one it declares), by type id.
  private readonly types: Map<string, UserType>;
  // The public member names of each class the program uses, by type id; its own first.
  private readonly classNames = new Map<string, ClassMemberNames>();

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions) {
    this.library = !!program.library;
    this.className = new NameScope(RESERVED).claim(program.className, 'pascal');
    this.types = userTypes(program);
    if (program.declaration) this.types.set(program.declaration.type.id, program.declaration.type);
    // A member can't share its class's name in C#. A library's functions are claimed first,
    // exactly as csharpLibraryExports claims them.
    this.names = this.library ? new NameScope(RESERVED, [this.className, ...HELPER_NAMES, 'EventDispatcher']) : classScope(this.className);
    // Public members first, as every file that uses the class names them.
    const own = claimClassMembers(this.names, programClassSpec(program), CLASS_STYLES, this.inheritedMembers(program.classInfo));
    this.classNames.set(`object:${program.className}`, own);
    for (const f of program.functions) {
      this.functionNames.set(f.id, (f.event ? own.events : own.functions).get(f.id)!);
      this.outputFields.set(f.id, resultFields(f.outputs));
    }
    for (const [id, name] of own.variables) this.memberNames.set(id, name);
    for (const [id, name] of own.dispatchers) this.dispatcherNames.set(id, name);
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'keep', '_'));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'pascal'));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(h.name, 'pascal'));
  }

  emit(): GeneratedCode {
    const body = this.out;
    if (this.program.declaration) return this.emitDeclaration();
    body.indent();
    const members = this.program.members.filter((m) => !m.function);
    const slots = this.program.slots.filter((x) => !x.function);
    const dispatchers = this.program.dispatchers ?? [];
    for (const m of members) body.line(`${m.access ?? 'public'} ${this.typeName(m.type)} ${this.memberNames.get(m.id)} = ${this.coerce(m.initial, m.type)};`);
    for (const d of dispatchers) body.line(`public readonly EventDispatcher<${this.actionType(d.params)}> ${this.dispatcherNames.get(d.id)} = new();`);
    for (const x of slots) body.line(`private ${this.typeName(x.type)} ${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)};`);
    if (members.length || slots.length || dispatchers.length) body.line();
    // Every class can be inherited from, so its methods are virtual, and a subclass overrides them.
    // A subclass without Start nodes keeps its parent's Start, as Unreal keeps BeginPlay.
    const parent = this.program.classInfo?.parent;
    if (!this.library && (!parent || this.program.hasStart)) this.method(parent ? 'public override' : 'public virtual', 'Start', [], undefined, () => this.statements(this.program.start));
    for (const fn of this.program.functions) this.functionMethod(fn);
    // The interface functions the class gives no body: they do nothing and return defaults.
    for (const { type, stubs } of this.program.interfaces ?? []) {
      for (const fn of stubs) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => ({ name: scope.claim(p.name, 'camel'), type: p.type }));
        const outputs = fn.outputs.filter((p) => p.kind === 'data');
        const fields = resultFields(outputs);
        this.method('public virtual', this.interfaceNames(type).functions.get(fn.id)!, params, outputs.length > 1 ? this.interfaceResult(fn) : outputs[0]?.type, () => {
          if (outputs.length === 1) this.out.line(`return ${this.defaultFor(outputs[0].type)};`);
          else if (outputs.length) this.out.line(`return (${outputs.map((o) => `${fields.get(o.id)}: ${this.defaultFor(o.type)}`).join(', ')});`);
        });
      }
    }
    for (const block of this.program.blocks) this.method('private', this.blockNames.get(block.id)!, [], undefined, () => this.statements(block.body));
    for (const helper of this.program.helpers) this.helperMethod(helper);
    if (dispatchers.length) {
      body.line("// Unreal's event dispatcher: bound events run in the order they were bound, each event once.");
      for (const line of DISPATCHER_CLASS) body.line(line);
      body.line();
    }
    for (const helper of ['format', 'number', 'boolean', 'as'] as const) {
      if (!this.helpersUsed.has(helper)) continue;
      const kinds = [...this.types.values()].map((t) => t.kind);
      for (const line of helper === 'format' ? formatHelper(kinds.includes('enum'), kinds.includes('struct')) : HELPERS[helper]) body.line(line);
      body.line();
    }
    body.trimTrailingBlank();
    body.dedent();

    const header = new CodeWriter('    ');
    header.line(`// Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    header.line('// Do not edit: changes are overwritten when the graph is compiled.');
    header.line();
    header.line('#nullable enable');
    // A Branch on a constant (an unconnected condition) leaves one side unreachable.
    header.line('#pragma warning disable CS0162');
    // A function's node outputs are locals; one nobody reads is not worth a warning.
    header.line('#pragma warning disable CS0219');
    header.line('using System;');
    header.line('using System.Collections.Generic;');
    header.line('using System.Globalization;');
    header.line('using System.Linq;');
    header.line();
    if (this.options.namespace) {
      header.line(`namespace ${this.options.namespace};`);
      header.line();
    }
    const parentClass = this.program.classInfo?.parent;
    const bases = [...(parentClass ? [this.userTypeName(parentClass)] : []), ...(this.program.interfaces ?? []).map((i) => this.userTypeName(i.type.id))];
    header.line(`public ${this.library ? 'static ' : ''}class ${this.className}${bases.length ? ` : ${bases.join(', ')}` : ''}`);
    header.line('{');
    return this.finish(header, body);
  }

  // The file's header (comment, settings, usings and namespace), as every generated file starts.
  private header(): CodeWriter {
    const header = new CodeWriter('    ');
    header.line(`// Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    header.line('// Do not edit: changes are overwritten when the graph is compiled.');
    header.line();
    header.line('#nullable enable');
    header.line('using System;');
    header.line('using System.Collections.Generic;');
    header.line();
    if (this.options.namespace) {
      header.line(`namespace ${this.options.namespace};`);
      header.line();
    }
    return header;
  }

  // A structure (a record struct: a value type, copied on assignment as in Unreal) or an
  // enumeration (a C# enum; values whose name isn't the member's carry it as a [Description]).
  private emitDeclaration(): GeneratedCode {
    const header = this.header();
    const body = this.out;
    const declaration = this.program.declaration!;
    if (declaration.kind === 'interface') {
      const names = this.interfaceNames(declaration.type);
      header.line(`public interface ${this.className}`);
      header.line('{');
      body.indent();
      for (const fn of declaration.type.functions) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => `${this.typeName(p.type)} ${scope.claim(p.name, 'camel')}`).join(', ');
        body.line(`${this.interfaceResult(fn)} ${names.functions.get(fn.id)}(${params});`);
      }
      body.dedent();
      return this.finish(header, body);
    }
    if (declaration.kind === 'enum') {
      const members = csharpEnumMembers(declaration.type);
      header.line(`public enum ${this.className}`);
      header.line('{');
      body.indent();
      declaration.type.enumerators.forEach((e, i) => {
        const member = members.get(e.id)!;
        if (member !== e.name) body.line(`[System.ComponentModel.Description(${literal(e.name)})]`);
        body.line(`${member}${i < declaration.type.enumerators.length - 1 ? ',' : ''}`);
      });
      body.dedent();
      return this.finish(header, body);
    }
    const type = declaration.type;
    const fields = csharpFieldNames(type);
    header.line(`public readonly record struct ${this.className}(${type.fields.map((f) => `${this.typeName(f.type)} ${fields.get(f.id)}`).join(', ')})`);
    header.line('{');
    body.indent();
    body.line(`public ${this.className}() : this(${type.fields.map((f, i) => this.coerce(declaration.initial[i], f.type)).join(', ')}) { }`);
    body.line();
    body.line('// As Print shows it: each field by name, in order.');
    body.line(`public (string Name, object? Value)[] BlueprintFields() => new (string, object?)[] { ${type.fields.map((f) => `(${literal(f.name)}, ${fields.get(f.id)})`).join(', ')} };`);
    body.dedent();
    return this.finish(header, body);
  }

  private finish(header: CodeWriter, body: CodeWriter): GeneratedCode {
    const headerText = header.toString();
    const offset = headerText.split('\n').length - 1;
    const importedFiles = [...new Set(this.program.imports.map((i) => i.path).filter((path) => path))].sort();
    return {
      text: `${headerText}${body.toString()}}\n`,
      className: this.options.namespace ? `${this.options.namespace}.${this.className}` : this.className,
      nodeLines: body.nodeLines.map((n) => ({ ...n, line: n.line + offset })),
      ...(importedFiles.length ? { importedFiles } : {})
    };
  }

  // ---- Class members ------------------------------------------------------------------------

  // `returns` is a type, or the text of one (a function's result tuple).
  private method(access: string, name: string, params: { name: string; type?: TypeRef }[], returns: TypeRef | string | undefined, body: () => void): void {
    this.out.endNode();
    const list = params.map((p) => `${this.typeName(p.type)} ${p.name}`).join(', ');
    this.out.line(`${access}${this.library ? ' static' : ''} ${typeof returns === 'string' ? returns : returns ? this.typeName(returns) : 'void'} ${name}(${list})`);
    this.out.line('{');
    this.out.indent();
    body();
    this.out.dedent();
    this.out.line('}');
    this.out.line();
  }

  // A function graph as a method: its locals and its nodes' outputs are variables of each call.
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
    const fields = this.outputFields.get(fn.id)!;
    const returns = fn.outputs.length > 1 ? `(${fn.outputs.map((o) => `${this.typeName(o.type)} ${fields.get(o.id)}`).join(', ')})` : fn.outputs[0]?.type ?? (fn.outputs.length ? { id: 'any' } : undefined);
    if (fn.description) this.out.line(`/// <summary>${fn.description.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\s+/g, ' ')}</summary>`);
    // Private methods can't be virtual; the others can be overridden.
    const access = this.library ? 'public' : fn.access === 'private' ? 'private' : `${fn.access ?? 'public'} ${fn.overrides ? 'override' : 'virtual'}`;
    this.method(access, this.functionNames.get(fn.id)!, params, returns, () => {
      // A custom event keeps the inputs other flows read, as Unreal keeps an event's outputs.
      for (const store of fn.event?.stores ?? []) this.out.line(`${this.slotNames.get(store.slot)} = ${this.paramNames.get(`${fn.id}\u0000${store.param}`)};`);
      for (const m of locals) this.out.line(`${this.typeName(m.type)} ${this.memberNames.get(m.id)} = ${this.coerce(m.initial, m.type)};`);
      for (const x of slots) this.out.line(`${this.typeName(x.type)} ${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)};`);
      this.statements(fn.body);
      // Reaching the end without a Return Node returns the outputs' defaults.
      if (fn.outputs.length && fn.body[fn.body.length - 1]?.kind !== 'return') this.out.line(`return ${this.result(fn, fn.outputs.map((o) => this.defaultFor(o.type)))};`);
    });
  }

  private result(fn: IrFunction, values: string[]): string {
    return fn.outputs.length === 1 ? values[0] : `(${values.join(', ')})`;
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
    this.method('private', this.helperNames.get(helper.id)!, params, helper.returns, () => {
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
        out.line(`Console.WriteLine(${this.text(s.value)});`);
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
        out.line(`if (${this.expr(s.condition)})`);
        this.block(s.then);
        // An if in the else branch from the same node (a Switch's cases) reads as `else if`.
        let rest = s.else;
        while (rest.length === 1 && rest[0].kind === 'if' && sameSource(rest[0], s)) {
          const inner: Extract<IrStatement, { kind: 'if' }> = rest[0];
          out.line(`else if (${this.expr(inner.condition)})`);
          this.block(inner.then);
          rest = inner.else;
        }
        if (rest.length) {
          out.line('else');
          this.block(rest);
        }
        break;
      }
      case 'for': {
        const counter = this.slotNames.get(s.counter)!;
        const stop = s.stop ? ` && !${this.slotNames.get(s.stop)}` : '';
        out.line(`for (${counter} = ${this.coerce(s.first, INT)}; ${counter} <= ${this.coerce(s.last, INT)}${stop}; ${counter}++)`);
        this.block(s.body);
        break;
      }
      case 'while':
        out.line(`while (${this.expr(s.condition)})`);
        this.block(s.body);
        break;
      case 'forEach': {
        // The array is read before each pass, as Unreal's For Each Loop reads it.
        const index = this.slotNames.get(s.index)!;
        const element = this.program.slots.find((x) => x.id === s.element);
        const array = this.coerce(s.array, element?.type ? { ...element.type, container: 'array' } : undefined);
        const stop = s.stop ? ` && !${this.slotNames.get(s.stop)}` : '';
        out.line(`for (${index} = 0; ${index} < ${array}.Count${stop}; ${index}++)`);
        out.line('{');
        out.indent();
        out.line(`${this.slotNames.get(s.element)} = ${array}[${index}];`);
        this.statements(s.body);
        out.dedent();
        out.line('}');
        break;
      }
      case 'call': {
        const call = this.call(s.callee, s.args);
        if (s.results) {
          // A library function with several outputs returns a named tuple, deconstructed into the slots.
          out.line(`(${s.results.map((r) => this.slotNames.get(r.slot)).join(', ')}) = ${call};`);
          break;
        }
        if (!s.resultSlot) {
          out.line(`${call};`);
          break;
        }
        const slot = this.program.slots.find((x) => x.id === s.resultSlot);
        const returns = calleeSignature(s.callee, this.program)?.returns;
        out.line(`${this.slotNames.get(s.resultSlot)} = ${sameType(returns, slot?.type) ? call : this.cast(call, returns, slot?.type)};`);
        break;
      }
      case 'callBlock':
        out.line(`${this.blockNames.get(s.block)}();`);
        break;
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === s.function)!;
        const call = this.functionCall(fn, s.args);
        // One output is the return value; several come back as a tuple, deconstructed into the slots.
        if (!s.results.length) out.line(`${call};`);
        else if (fn.outputs.length === 1) out.line(`${this.slotNames.get(s.results[0].slot)} = ${call};`);
        else out.line(`(${fn.outputs.map((o) => this.slotNames.get(s.results.find((r) => r.output === o.id)?.slot ?? '') ?? '_').join(', ')}) = ${call};`);
        break;
      }
      case 'bindEvent':
        out.line(`${this.dispatcherRef(s)}.${s.bind ? 'Bind' : 'Unbind'}(${this.functionNames.get(s.event)});`);
        break;
      case 'unbindAll':
        out.line(`${this.dispatcherRef(s)}.Clear();`);
        break;
      case 'broadcast': {
        const other = s.target && s.type ? classInfo(this.program, s.type)?.dispatchers.find((d) => d.id === s.dispatcher)?.inputs.filter((p) => p.kind === 'data') : undefined;
        const params = other ?? this.program.dispatchers?.find((d) => d.id === s.dispatcher)?.params ?? [];
        out.line(`foreach (var handler in ${this.dispatcherRef(s)}.Handlers) handler(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')});`);
        break;
      }
      case 'cast': {
        const type = this.userTypeName(s.type);
        out.line(`if (${this.operand(s.value)} is ${type})`);
        out.line('{');
        out.indent();
        out.line(`${this.slotNames.get(s.slot)} = (${type})${this.operand(s.value)};`);
        this.statements(s.succeeded);
        out.dedent();
        out.line('}');
        if (s.failed.length) {
          out.line('else');
          this.block(s.failed);
        }
        break;
      }
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, s.type);
        const fn = iface?.functions.find((f) => f.id === s.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(s.target)}.${iface ? this.interfaceNames(iface).functions.get(s.function) : s.function}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        if (!s.results.length) out.line(`${call};`);
        else if (outputs.length === 1) out.line(`${this.slotNames.get(s.results[0].slot)} = ${call};`);
        else out.line(`(${s.results.map((r) => this.slotNames.get(r.slot)).join(', ')}) = ${call};`);
        break;
      }
      case 'parentCall': {
        if (s.start) {
          out.line('base.Start();');
          break;
        }
        const fn = this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === s.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `base.${this.parentFunctionName(s.function!)}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        if (!s.results.length) out.line(`${call};`);
        else if (outputs.length === 1) out.line(`${this.slotNames.get(s.results[0].slot)} = ${call};`);
        else out.line(`(${s.results.map((r) => this.slotNames.get(r.slot)).join(', ')}) = ${call};`);
        break;
      }
      case 'construct':
        out.line(`${this.slotNames.get(s.slot)} = new ${this.userTypeName(s.type)}();`);
        out.line(`${this.slotNames.get(s.slot)}.Start();`);
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
        else if (outputs.length === 1) out.line(`${this.slotNames.get(s.results[0].slot)} = ${call};`);
        else out.line(`(${s.results.map((r) => this.slotNames.get(r.slot)).join(', ')}) = ${call};`);
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

  private block(statements: IrStatement[]): void {
    this.out.line('{');
    this.out.indent();
    this.statements(statements);
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
        return this.memberNames.get(e.member)!;
      case 'output':
        return this.slotNames.get(e.slot)!;
      case 'add':
        return `${this.operand(e.left)} + ${this.operand(e.right)}`;
      case 'toNumber':
        if (isNumeric(this.typeOf(e.value))) return this.typeOf(e.value)?.id === 'int' ? `(double)${this.operand(e.value)}` : this.expr(e.value);
        this.helpersUsed.add('number');
        return `ToNumber(${this.expr(e.value)})`;
      case 'toText':
        return this.text(e.value);
      case 'toBoolean': {
        const type = this.typeOf(e.value);
        if (type?.id === 'bool' && !type.container && !type.nullable) return this.expr(e.value);
        this.helpersUsed.add('boolean');
        return `ToBoolean(${this.expr(e.value)})`;
      }
      case 'call': {
        const call = this.call(e.callee, e.args);
        if (!e.output) return call;
        const imported = this.program.imports.find((i) => i.id === e.callee.id);
        return `${call}.${resultFields(imported?.outputs ?? []).get(e.output)}`;
      }
      case 'binary': {
        // Both sides need one type in C#: the one either side has (an int counter, a string
        // selection), with the other side converted to it.
        const type = e.op === '&&' || e.op === '||' ? BOOL : this.typeOf(e.left) ?? this.typeOf(e.right);
        const side = (x: IrExpr) => (type ? this.cast(this.operand(x), this.typeOf(x), type, x.kind === 'literal') : this.operand(x));
        return `${side(e.left)} ${e.op} ${side(e.right)}`;
      }
      case 'not':
        return `!${this.operand(e.value)}`;
      case 'param':
        return this.paramNames.get(`${e.function}\u0000${e.id}`) ?? 'default';
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(fn, e.args);
        return fn.outputs.length === 1 ? call : `${call}.${this.outputFields.get(fn.id)!.get(e.output)}`;
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return 'default';
        return `new ${this.userTypeName(type.id)}(${type.fields.map((f, i) => this.coerce(e.fields[i], f.type)).join(', ')})`;
      }
      case 'structField': {
        const type = this.types.get(e.type);
        return `${this.operand(e.value)}.${type?.kind === 'struct' ? csharpFieldNames(type).get(e.field) : e.field}`;
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        return `${this.userTypeName(e.type)}.${type?.kind === 'enum' ? csharpEnumMembers(type).get(e.value) : e.value}`;
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
        const call = `base.${this.parentFunctionName(e.function)}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
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
        const type = this.typeName({ ...e.type, nullable: false });
        if (e.type.container === 'map') {
          const pairs: string[] = [];
          for (let i = 0; i + 1 < e.items.length; i += 2) pairs.push(`[${this.coerce(e.items[i], element)}] = ${this.coerce(e.items[i + 1], e.type.valueType)}`);
          return `new ${type} { ${pairs.join(', ')} }`.replace('{  }', '()');
        }
        return `new ${type} { ${e.items.map((item) => this.coerce(item, element)).join(', ')} }`.replace('{  }', '()');
      }
    }
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' ? `(${text})` : text;
  }

  private functionCall(fn: IrFunction, args: IrExpr[]): string {
    return `${this.functionNames.get(fn.id)}(${args.map((a, i) => this.coerce(a, fn.params[i]?.type)).join(', ')})`;
  }

  private call(callee: IrCallee, args: IrExpr[]): string {
    const signature = calleeSignature(callee, this.program);
    const list = args.map((a, i) => this.coerce(a, signature?.params[i]?.type)).join(', ');
    if (callee.kind === 'helper') return `${this.helperNames.get(callee.id)}(${list})`;
    const imported = this.program.imports.find((i) => i.id === callee.id)!;
    return `global::${imported.module ? `${imported.module}.` : ''}${imported.name}(${list})`;
  }

  // The value as text, per docs/semantics.md ("Values").
  private text(e: IrExpr): string {
    const type = this.typeOf(e);
    if (type && !type.container && !type.nullable) {
      if (type.id === 'string') return this.expr(e);
      if (type.id === 'bool') return `(${this.expr(e)} ? "true" : "false")`;
      if (isNumeric(type)) {
        this.helpersUsed.add('format');
        return `FormatNumber(${this.expr(e)})`;
      }
    }
    this.helpersUsed.add('format');
    return `FormatValue(${this.expr(e)})`;
  }

  // An expression for a slot, member or parameter of type `target`. A container default (JSON: an
  // array, or a map's [key, value] pairs) becomes the container.
  private coerce(e: IrExpr, target: TypeRef | undefined): string {
    if (e.kind === 'literal' && target?.container && Array.isArray(e.value)) {
      const type = this.typeName({ ...target, nullable: false });
      const element = (v: unknown, t: TypeRef | undefined) => this.cast(literal(v), literalTypeOf(v), t, true);
      if (target.container === 'map') {
        const pairs = e.value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2);
        return pairs.length ? `new ${type} { ${pairs.map(([k, v]) => `[${element(k, { id: target.id })}] = ${element(v, target.valueType)}`).join(', ')} }` : `new ${type}()`;
      }
      return e.value.length ? `new ${type} { ${e.value.map((v) => element(v, { id: target.id })).join(', ')} }` : `new ${type}()`;
    }
    return this.cast(this.expr(e), this.typeOf(e), target, e.kind === 'literal');
  }

  private cast(text: string, from: TypeRef | undefined, target: TypeRef | undefined, isLiteral = false): string {
    if (!target || target.id === 'any' || target.id === 'wildcard') return text;
    if (sameType(from, target)) return text;
    if (from && !from.container && !target.container) {
      // int widens to double implicitly; double to int truncates, as an explicit cast does.
      if (from.id === 'int' && target.id === 'float') return text;
      if (from.id === 'float' && target.id === 'int') return isLiteral && Number.isInteger(Number(text)) ? text : `(int)(${text})`;
      if (from.id === target.id) return text;
    }
    if (isLiteral && text === 'null') return target.nullable || this.defaultFor(target) === 'null' ? text : this.defaultFor(target);
    this.helpersUsed.add('as');
    return `As<${this.typeName(target)}>(${text})`;
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (type?.nullable) return 'null';
    if (type?.container) return `new ${this.typeName({ ...type, nullable: false })}()`;
    // A struct with its fields' defaults; an enum's first value.
    const user = type && this.types.get(type.id);
    if (user?.kind === 'struct') return `new ${this.userTypeName(user.id)}()`;
    if (user?.kind === 'enum' && user.enumerators[0]) return `${this.userTypeName(user.id)}.${csharpEnumMembers(user).get(user.enumerators[0].id)}`;
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

  // The delegate type of an event taking these parameters.
  private actionType(params: { type?: TypeRef }[]): string {
    return params.length ? `Action<${params.map((p) => this.typeName(p.type)).join(', ')}>` : 'Action';
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
    const names = claimClassMembers(classScope(new NameScope(RESERVED).claim(iface.name, 'pascal')), { functions: iface.functions, events: [], variables: [], dispatchers: [] }, CLASS_STYLES);
    this.classNames.set(iface.id, names);
    return names;
  }

  // An interface function's return type: none, its one output's, or a named tuple of its outputs.
  private interfaceResult(fn: ClassInfo['functions'][number]): string {
    const outputs = fn.outputs.filter((p) => p.kind === 'data');
    if (!outputs.length) return 'void';
    if (outputs.length === 1) return this.typeName(outputs[0].type);
    const fields = resultFields(outputs);
    return `(${outputs.map((o) => `${this.typeName(o.type)} ${fields.get(o.id)}`).join(', ')})`;
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
    const names = claimClassMembers(classScope(new NameScope(RESERVED).claim(info.name, 'pascal')), info, CLASS_STYLES, this.inheritedMembers(info));
    this.classNames.set(id, names);
    return names;
  }

  // An object member is reached through its object, which isn't null (else the run stops, as
  // Unreal stops on "Accessed None").
  private targetRef(e: IrExpr): string {
    return e.kind === 'self' ? 'this' : `${this.operand(e)}!`;
  }

  // A dispatcher of this object, or of the Target object.
  private dispatcherRef(s: { dispatcher: string; target?: IrExpr; type?: string }): string {
    if (s.target && s.type) return `${this.targetRef(s.target)}.${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}`;
    return this.dispatcherNames.get(s.dispatcher)!;
  }

  // The name a struct, enum or class goes by: its own in its file, else fully qualified.
  private userTypeName(id: string): string {
    if (this.program.declaration?.type.id === id || id === `object:${this.program.className}`) return this.className;
    const imported = this.program.imports.find((i) => i.id === id);
    return imported ? `global::${imported.module ? `${imported.module}.` : ''}${imported.name}` : 'object';
  }

  // C#'s spelling of a type, with structs and enums by their qualified names.
  private mapType(type: TypeRef): string {
    if (!isUserTypeId(type.id) && !(type.valueType && isUserTypeId(type.valueType.id))) return mapType(type);
    const element = isUserTypeId(type.id) ? this.userTypeName(type.id) : mapType({ id: type.id });
    const value = type.valueType ? this.mapType(type.valueType) : 'object';
    const base = type.container === 'array' ? `List<${element}>` : type.container === 'set' ? `HashSet<${element}>` : type.container === 'map' ? `Dictionary<${element}, ${value}>` : element;
    return type.nullable ? `${base}?` : base;
  }

  private typeName(type: TypeRef | undefined): string {
    const name = this.mapType(type ?? { id: 'any' });
    // Object-like types start out null, so they must admit it (containers start out empty; structs
    // and enums are values).
    const kind = type && this.types.get(type.id)?.kind;
    const startsNull = !type || (!type.container && !['bool', 'int', 'float', 'string'].includes(type.id) && kind !== 'struct' && kind !== 'enum');
    return startsNull && !name.endsWith('?') ? `${name}?` : name;
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

// A JSON value as a C# literal.
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'double.NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'double.PositiveInfinity' : 'double.NegativeInfinity';
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  return 'null';
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
