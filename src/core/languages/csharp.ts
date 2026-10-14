// C# pack: generates a C# class per graph from Visual IR, and runs it through a small console
// project (docs/program-structure.md, "C# language pack").
import { IrBlock, IrCallee, IrCodeHelper, IrExpr, IrProgram, IrStatement, calleeSignature, exprType } from '../compiler/ir';
import { NameScope, dedent } from '../compiler/names';
import { CodeWriter } from '../compiler/writer';
import { scanCSharp } from '../importing/csharp-scanner';
import { CodeGenerator, GenerateOptions, GeneratedCode, LanguagePack } from '../language-pack';
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
    '    _ => System.Text.Json.JsonSerializer.Serialize(value, new System.Text.Json.JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping })',
    '};',
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

const csharpGenerator: CodeGenerator = {
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
  private readonly className: string;
  private readonly helpersUsed = new Set<keyof typeof HELPERS>();

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions) {
    this.className = new NameScope(RESERVED).claim(program.className, 'pascal');
    // A member can't share its class's name in C#.
    this.names = new NameScope(RESERVED, ['Start', this.className, ...HELPER_NAMES]);
    for (const m of program.members) this.memberNames.set(m.id, this.names.claim(m.name));
    for (const s of program.slots) this.slotNames.set(s.id, this.names.claim(s.name, 'keep', '_'));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'pascal'));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(h.name, 'pascal'));
  }

  emit(): GeneratedCode {
    const body = this.out;
    body.indent();
    for (const m of this.program.members) body.line(`public ${this.typeName(m.type)} ${this.memberNames.get(m.id)} = ${this.coerce(m.initial, m.type)};`);
    for (const s of this.program.slots) body.line(`private ${this.typeName(s.type)} ${this.slotNames.get(s.id)} = ${this.defaultFor(s.type)};`);
    if (this.program.members.length || this.program.slots.length) body.line();
    this.method('public', 'Start', [], undefined, () => this.statements(this.program.start));
    for (const block of this.program.blocks) this.method('private', this.blockNames.get(block.id)!, [], undefined, () => this.statements(block.body));
    for (const helper of this.program.helpers) this.helperMethod(helper);
    for (const helper of ['format', 'number', 'boolean', 'as'] as const) {
      if (!this.helpersUsed.has(helper)) continue;
      for (const line of HELPERS[helper]) body.line(line);
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
    header.line('using System;');
    header.line('using System.Collections.Generic;');
    header.line('using System.Globalization;');
    header.line();
    if (this.options.namespace) {
      header.line(`namespace ${this.options.namespace};`);
      header.line();
    }
    header.line(`public class ${this.className}`);
    header.line('{');
    const headerText = header.toString();
    const offset = headerText.split('\n').length - 1;
    const importedFiles = [...new Set(this.program.imports.map((i) => i.path))].sort();
    return {
      text: `${headerText}${body.toString()}}\n`,
      className: this.options.namespace ? `${this.options.namespace}.${this.className}` : this.className,
      nodeLines: body.nodeLines.map((n) => ({ ...n, line: n.line + offset })),
      ...(importedFiles.length ? { importedFiles } : {})
    };
  }

  // ---- Class members ------------------------------------------------------------------------

  private method(access: string, name: string, params: { name: string; type?: TypeRef }[], returns: TypeRef | undefined, body: () => void): void {
    this.out.endNode();
    const list = params.map((p) => `${this.typeName(p.type)} ${p.name}`).join(', ');
    this.out.line(`${access} ${returns ? this.typeName(returns) : 'void'} ${name}(${list})`);
    this.out.line('{');
    this.out.indent();
    body();
    this.out.dedent();
    this.out.line('}');
    this.out.line();
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
      case 'call': {
        const call = this.call(s.callee, s.args);
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
      case 'call':
        return this.call(e.callee, e.args);
      case 'binary': {
        // Both sides need one type in C#: the one either side has (an int counter, a string
        // selection), with the other side converted to it.
        const type = e.op === '&&' || e.op === '||' ? BOOL : this.typeOf(e.left) ?? this.typeOf(e.right);
        const side = (x: IrExpr) => (type ? this.cast(this.operand(x), this.typeOf(x), type, x.kind === 'literal') : this.operand(x));
        return `${side(e.left)} ${e.op} ${side(e.right)}`;
      }
      case 'not':
        return `!${this.operand(e.value)}`;
    }
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' ? `(${text})` : text;
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

  // An expression for a slot, member or parameter of type `target`.
  private coerce(e: IrExpr, target: TypeRef | undefined): string {
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
    const name = mapType(type ?? { id: 'any' });
    // Object-like types start out null, so they must admit it.
    return this.defaultFor(type) === 'null' && !name.endsWith('?') ? `${name}?` : name;
  }

  private typeOf(e: IrExpr): TypeRef | undefined {
    const type = exprType(e, this.program);
    return type?.id === 'any' ? undefined : type;
  }
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
