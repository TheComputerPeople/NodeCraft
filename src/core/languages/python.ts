// Python pack: generates a typed Python 3 module (one class per graph) from Visual IR.
import { IrBlock, IrCodeHelper, IrExpr, IrProgram, IrStatement, exprType } from '../compiler/ir';
import { NameScope, dedent, toIdentifier } from '../compiler/names';
import { CodeWriter } from '../compiler/writer';
import { CodeGenerator, GenerateOptions, GeneratedCode, LanguagePack } from '../language-pack';
import { TypeRef, parseTypeId } from '../types';

const RESERVED = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'type', 'self', 'print', 'object', 'super'
]);

const PRIMITIVES: Record<string, string> = { bool: 'bool', int: 'int', float: 'float', string: 'str', any: 'Any', wildcard: 'Any' };

function mapType(type: TypeRef): string {
  const element = PRIMITIVES[type.id] ?? parseTypeId(type.id).name;
  const base = type.container === 'array' ? `list[${element}]`
    : type.container === 'set' ? `set[${element}]`
    : type.container === 'map' ? `dict[${element}, ${type.valueType ? mapType(type.valueType) : 'Any'}]`
    : element;
  return type.nullable ? `${base} | None` : base;
}

// Helper functions emitted into generated modules on demand. They implement docs/semantics.md
// ("Values") exactly as Simulate does, so output matches the other targets.
const HELPERS: Record<'format' | 'number' | 'boolean', string[]> = {
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
    '    return json.dumps(value, separators=(",", ":"))',
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

const pythonGenerator: CodeGenerator = {
  snippetLanguages: ['python'],
  outputFileName: (graphFileName) => `${toIdentifier(graphFileName.replace(/\.vgraph$/i, ''), 'snake')}_vgraph.py`,
  generate: (program, options) => new PythonEmitter(program, options).emit(),
  runner: {
    commands: (platform) => (platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]),
    args: (file, className) => [
      '-c',
      `import importlib.util as u; s = u.spec_from_file_location("vgraph_module", ${JSON.stringify(file.path)}); m = u.module_from_spec(s); s.loader.exec_module(m); m.${className}().start()`
    ],
    missingToolMessage: 'Python 3 was not found. Install Python 3.8 or later and make sure it is on the PATH.'
  }
};

export const pythonPack: LanguagePack = {
  id: 'python',
  displayName: 'Python',
  generatedFileExtension: '.py',
  workspaceMarkers: ['**/pyproject.toml', '**/setup.py', '**/setup.cfg', '**/requirements.txt', '**/Pipfile'],
  capabilities: { staticTyping: false, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true },
  mapType,
  generator: pythonGenerator
};

class PythonEmitter {
  private readonly out = new CodeWriter('    ');
  private readonly names = new NameScope(RESERVED, ['start']);
  private readonly memberNames = new Map<string, string>();
  private readonly slotNames = new Map<string, string>();
  private readonly helperNames = new Map<string, string>();
  private readonly blockNames = new Map<string, string>();
  private readonly className: string;
  private readonly helpersUsed = new Set<keyof typeof HELPERS>();
  private usesAny = false;

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions) {
    this.className = new NameScope(RESERVED).claim(program.className, 'pascal');
    for (const m of program.members) this.memberNames.set(m.id, this.names.claim(m.name));
    for (const s of program.slots) this.slotNames.set(s.id, this.names.claim(s.name, 'keep', '_'));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'snake', '_'));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(h.name, 'snake', '_'));
  }

  emit(): GeneratedCode {
    // The class body is written first so the imports reflect what it uses.
    const body = this.out;
    body.line(`class ${this.className}:`);
    body.indent();
    const fields = [
      ...this.program.members.map((m) => ({ name: this.memberNames.get(m.id)!, type: m.type, initial: this.expr(m.initial) })),
      ...this.program.slots.map((s) => ({ name: this.slotNames.get(s.id)!, type: s.type, initial: this.defaultFor(s.type) }))
    ];
    if (fields.length) {
      this.method('__init__', [], undefined, () => {
        for (const f of fields) body.line(`self.${f.name}: ${this.typeName(f.type)} = ${f.initial}`);
      });
    }
    this.method('start', [], undefined, () => this.statements(this.program.start));
    for (const block of this.program.blocks) this.blockMethod(block);
    for (const helper of this.program.helpers) this.helperMethod(helper);
    body.trimTrailingBlank();
    body.dedent();

    const header = new CodeWriter('    ');
    header.line(`# Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    header.line('# Do not edit: changes are overwritten when the graph is compiled.');
    header.line();
    header.line('from __future__ import annotations');
    header.line();
    const imports = [...(this.helpersUsed.has('format') ? ['import json'] : []), ...(this.usesAny || this.helpersUsed.size ? ['from typing import Any'] : [])];
    if (imports.length) {
      imports.forEach((i) => header.line(i));
      header.line();
    }
    header.line();

    const footer: string[] = [];
    for (const helper of ['format', 'number', 'boolean'] as const) {
      if (this.helpersUsed.has(helper)) footer.push('', '', ...HELPERS[helper]);
    }
    footer.push('', '', 'if __name__ == "__main__":', `    ${this.className}().start()`);

    const headerText = header.toString();
    const offset = headerText.split('\n').length - 1;
    return {
      text: headerText + body.toString() + footer.join('\n') + '\n',
      className: this.className,
      nodeLines: body.nodeLines.map((n) => ({ ...n, line: n.line + offset }))
    };
  }

  // ---- Class members ------------------------------------------------------------------------

  private method(name: string, params: { name: string; type?: TypeRef }[], returns: TypeRef | undefined, body: () => void): void {
    const list = ['self', ...params.map((p) => `${p.name}: ${this.typeName(p.type)}`)].join(', ');
    this.out.line(`def ${name}(${list}) -> ${returns ? this.typeName(returns) : 'None'}:`);
    this.block(body);
    this.out.line();
  }

  // Writes an indented block, adding `pass` if it turned out empty.
  private block(body: () => void): void {
    const before = this.out.toString();
    this.out.indent();
    body();
    if (this.out.toString() === before) this.out.line('pass');
    this.out.dedent();
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
    if (s.kind !== 'callBlock') out.node(s.source, (text) => `# ${text}`);
    switch (s.kind) {
      case 'print':
        out.line(`print(${this.text(s.value)})`);
        break;
      case 'store':
        out.line(`self.${this.slotNames.get(s.slot)} = ${this.expr(s.value)}`);
        break;
      case 'setMember':
        out.line(`self.${this.memberNames.get(s.member)} = ${this.expr(s.value)}`);
        break;
      case 'if':
        out.line(`if ${this.expr(s.condition)}:`);
        this.block(() => this.statements(s.then));
        if (s.else.length) {
          out.line('else:');
          this.block(() => this.statements(s.else));
        }
        break;
      case 'callCode': {
        const call = `self.${this.helperNames.get(s.helper)}(${s.args.map((a) => this.expr(a)).join(', ')})`;
        out.line(s.resultSlot ? `self.${this.slotNames.get(s.resultSlot)} = ${call}` : call);
        break;
      }
      case 'callBlock':
        out.line(`self.${this.blockNames.get(s.block)}()`);
        break;
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
        return `self.${this.memberNames.get(e.member)}`;
      case 'output':
        return `self.${this.slotNames.get(e.slot)}`;
      case 'add':
        return `${this.operand(e.left)} + ${this.operand(e.right)}`;
      case 'toNumber':
        if (isNumeric(this.typeOf(e.value))) return this.expr(e.value);
        this.helpersUsed.add('number');
        return `_to_number(${this.expr(e.value)})`;
      case 'toBoolean': {
        const type = this.typeOf(e.value);
        if (type?.id === 'bool' && !type.container) return this.expr(e.value);
        this.helpersUsed.add('boolean');
        return `_to_boolean(${this.expr(e.value)})`;
      }
    }
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' ? `(${text})` : text;
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
    const name = mapType(type ?? { id: 'any' });
    if (name.includes('Any')) this.usesAny = true;
    // Object-like types start out None, so they must admit it.
    return this.defaultFor(type) === 'None' && name !== 'Any' && !name.endsWith('| None') ? `${name} | None` : name;
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
  if (typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${literal(v)}`).join(', ')}}`;
  return 'None';
}

function isNumeric(type: TypeRef | undefined): boolean {
  return !!type && !type.container && (type.id === 'int' || type.id === 'float');
}
