// Generates TypeScript, or JavaScript with JSDoc types, from Visual IR.
import { IrBlock, IrCallee, IrCodeHelper, IrExpr, IrFunction, IrImport, IrProgram, IrStatement, calleeSignature, exprType } from '../compiler/ir';
import { relativeSpecifier, typescriptSpecifier } from '../compiler/module-paths';
import { NameScope, dedent } from '../compiler/names';
import { CodeWriter } from '../compiler/writer';
import { CodeGenerator, CodeRunner, GenerateOptions, GeneratedCode } from '../language-pack';
import { TypeRef } from '../types';

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
  args: (file, className) => ['-e', `${RESOLVE_TYPESCRIPT}\nimport(${JSON.stringify(file.url)}).then((m) => new m.${className}().start())`],
  missingToolMessage: 'Node.js was not found. Install Node.js 22.18 or later (it runs TypeScript directly) and make sure `node` is on the PATH.'
};

export function typescriptGenerator(flavor: TypeScriptFlavor): CodeGenerator {
  return {
    snippetLanguages: flavor.typed ? ['typescript', 'javascript'] : ['javascript'],
    importLanguages: flavor.typed ? ['typescript', 'javascript'] : ['javascript'],
    outputFileName: (graphFileName) => `${graphFileName}.${flavor.typed ? 'ts' : 'js'}`,
    generate: (program, options) => new TypeScriptEmitter(program, options, flavor).emit(),
    runner: nodeRunner
  };
}

class TypeScriptEmitter {
  private readonly out = new CodeWriter('  ');
  private readonly names = new NameScope(RESERVED, ['start']);
  private readonly memberNames = new Map<string, string>();
  private readonly slotNames = new Map<string, string>();
  private readonly helperNames = new Map<string, string>();
  private readonly blockNames = new Map<string, string>();
  // Local names of imported functions, aliased where they would clash.
  private readonly importNames = new Map<string, string>();
  private readonly functionNames = new Map<string, string>();
  // Parameter names of each function, keyed by function and input id.
  private readonly paramNames = new Map<string, string>();
  // Field names of a function's result object, when it has several outputs.
  private readonly outputFields = new Map<string, Map<string, string>>();
  private readonly className: string;
  private needsFormat = false;

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions, private readonly flavor: TypeScriptFlavor) {
    this.className = new NameScope(RESERVED).claim(program.className, 'pascal');
    const moduleScope = new NameScope(RESERVED, [this.className, FORMAT_HELPER]);
    for (const i of program.imports) this.importNames.set(i.id, moduleScope.claim(i.name));
    // Member variables keep their names; internal fields are private (TypeScript) or underscored (JavaScript).
    const internal = flavor.typed ? '' : '_';
    for (const m of program.members) if (!m.function) this.memberNames.set(m.id, this.names.claim(m.name));
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'keep', internal));
    for (const f of program.functions) {
      this.functionNames.set(f.id, this.names.claim(f.name, 'camel'));
      const fields = new NameScope(RESERVED);
      this.outputFields.set(f.id, new Map(f.outputs.map((o) => [o.id, fields.claim(o.name, 'camel')])));
    }
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'keep', internal));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(h.name, 'snake', internal));
  }

  emit(): GeneratedCode {
    const { out, flavor } = this;
    out.line(`// Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    out.line('// Do not edit: changes are overwritten when the graph is compiled.');
    out.line();
    const esm = flavor.typed || this.options.moduleFormat !== 'commonjs';
    this.imports(esm);
    out.line(`${esm ? 'export ' : ''}class ${this.className} {`);
    out.indent();

    const members = this.program.members.filter((m) => !m.function);
    const slots = this.program.slots.filter((x) => !x.function);
    for (const m of members) this.field(this.memberNames.get(m.id)!, m.type, this.coerce(m.initial, m.type), false);
    for (const x of slots) this.field(this.slotNames.get(x.id)!, x.type, this.defaultFor(x.type), true);
    if (members.length || slots.length) out.line();

    this.method('start', [], undefined, false, () => this.statements(this.program.start));
    for (const fn of this.program.functions) this.functionMethod(fn);
    for (const block of this.program.blocks) this.blockMethod(block);
    for (const helper of this.program.helpers) this.helperMethod(helper);
    out.trimTrailingBlank();

    out.dedent();
    out.line('}');
    if (!esm) {
      out.line();
      out.line(`module.exports = { ${this.className} };`);
    }
    if (this.needsFormat) this.formatHelper();
    return { text: out.toString(), className: this.className, nodeLines: out.nodeLines };
  }

  // One import (or require) per module of project code the graph calls, sorted so that rearranging
  // the graph doesn't reorder them.
  private imports(esm: boolean): void {
    const byModule = new Map<string, IrImport[]>();
    for (const i of sortImports(this.program.imports)) {
      const specifier = this.flavor.typed
        ? typescriptSpecifier(this.options.outputDir ?? '', i.path, this.options.importExtension ?? 'ts')
        : relativeSpecifier(this.options.outputDir ?? '', i.path);
      byModule.set(specifier, [...(byModule.get(specifier) ?? []), i]);
    }
    for (const [specifier, imports] of [...byModule].sort(([a], [b]) => compare(a, b))) {
      const names = imports.map((i) => {
        const local = this.importNames.get(i.id)!;
        return local === i.name ? local : `${i.name}${esm ? ' as ' : ': '}${local}`;
      }).join(', ');
      this.out.line(esm ? `import { ${names} } from ${JSON.stringify(specifier)};` : `const { ${names} } = require(${JSON.stringify(specifier)});`);
    }
    if (byModule.size) this.out.line();
  }

  // ---- Class members ------------------------------------------------------------------------

  private field(name: string, type: TypeRef | undefined, initial: string, internal: boolean): void {
    if (this.flavor.typed) {
      this.out.line(`${internal ? 'private ' : ''}${name}: ${this.typeName(type)} = ${initial};`);
    } else {
      this.out.line(`/** @type {${this.flavor.mapType(type ?? { id: 'any' })}} */`);
      this.out.line(`${name} = ${initial};`);
    }
  }

  // `returns` is a type, or the text of one (a function's result object).
  private method(name: string, params: { name: string; type?: TypeRef }[], returns: TypeRef | string | undefined, internal: boolean, body: () => void): void {
    const { out, flavor } = this;
    out.endNode();
    const returnText = typeof returns === 'string' ? returns : returns ? (flavor.typed ? this.typeName(returns) : flavor.mapType(returns)) : undefined;
    if (flavor.typed) {
      const list = params.map((p) => `${p.name}: ${this.typeName(p.type)}`).join(', ');
      out.line(`${internal ? 'private ' : ''}${name}(${list}): ${returnText ?? 'void'} {`);
    } else {
      if (params.length || returnText) {
        out.line('/**');
        for (const p of params) out.line(` * @param {${flavor.mapType(p.type ?? { id: 'any' })}} ${p.name}`);
        if (returnText) out.line(` * @returns {${returnText}}`);
        out.line(' */');
      }
      out.line(`${name}(${params.map((p) => p.name).join(', ')}) {`);
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
    this.method(this.functionNames.get(fn.id)!, params, this.resultType(fn), false, () => {
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

  // A function's return type: none, its one output's, or an object with a field per output.
  private resultType(fn: IrFunction): TypeRef | string | undefined {
    if (!fn.outputs.length) return undefined;
    if (fn.outputs.length === 1) return fn.outputs[0].type ?? { id: 'any' };
    const fields = this.outputFields.get(fn.id)!;
    const type = (t: TypeRef | undefined) => (this.flavor.typed ? this.typeName(t) : this.flavor.mapType(t ?? { id: 'any' }));
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
        out.line(s.resultSlot ? `${this.slotRef(s.resultSlot)} = ${call};` : `${call};`);
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
      case 'toBoolean':
        return this.typeOf(e.value)?.id === 'bool' && !this.typeOf(e.value)?.container ? this.expr(e.value) : `Boolean(${this.expr(e.value)})`;
      case 'call':
        return this.call(e.callee, e.args);
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
    return `this.${this.functionNames.get(fn.id)}(${args.map((a, i) => this.coerce(a, fn.params[i]?.type)).join(', ')})`;
  }

  private call(callee: IrCallee, args: IrExpr[]): string {
    const params = calleeSignature(callee, this.program)?.params ?? [];
    const list = args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ');
    return callee.kind === 'helper' ? `this.${this.helperNames.get(callee.id)}(${list})` : `${this.importNames.get(callee.id)}(${list})`;
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
    const element = this.flavor.mapType({ id: type.id });
    return type.container === 'map' ? `<${element}, ${this.flavor.mapType(type.valueType ?? { id: 'any' })}>` : `<${element}>`;
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (type?.container === 'array') return '[]';
    if (type?.container === 'set') return 'new Set()';
    if (type?.container === 'map') return 'new Map()';
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
    const name = this.flavor.mapType(type ?? { id: 'any' });
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
