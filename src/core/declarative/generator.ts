// Generates code from Visual IR through a declarative pack's templates (docs/language-breadth.md,
// "Declarative packs"). The emitter decides everything the IR leaves open the same way for every
// pack (names, which conversions are needed, where each node's code starts); the templates only
// spell it. A construct without a template is reported as `unsupported` on its node.
import { CompileDiagnostic } from '../compiler/diagnostics';
import { IrCallee, IrExpr, IrFunction, IrProgram, IrStatement, SourceRef, exprType, userTypes } from '../compiler/ir';
import { NameScope, NameStyle, dedent, toIdentifier } from '../compiler/names';
import { relativeSpecifier } from '../compiler/module-paths';
import { GenerateOptions, GeneratedCode, PinExpression } from '../language-pack';
import { TypeRef, parseTypeId } from '../types';
import { EnumInfo, StructInfo, UserType } from '../user-types';
import { CheckedDefinition } from './definition';
import { Template, TemplateValue, parseTemplate, renderTemplate } from './template';

// Marks where a node's code starts, and where code that belongs to no node starts, until the
// finished text is scanned for them.
const NODE_MARK = (index: number) => `\u0001N${index}\u0001`;
const BREAK_MARK = '\u0001B\u0001';
const MARKS = /\u0001N(\d+)\u0001|\u0001B\u0001/g;

// Defaults for templates a pack may leave out.
const DEFAULTS: Record<string, string> = {
  'literal.int': '{{text}}',
  'literal.float': '{{text}}',
  'literal.bool': '{{text}}',
  'literal.string': '{{quoted}}',
  add: '{{left}} + {{right}}',
  binary: '{{left}} {{op}} {{right}}',
  not: '!{{value}}',
  call: '{{name}}({{#each args ", "}}{{this}}{{/each}})',
  import: '{{name}}({{#each args ", "}}{{this}}{{/each}})',
  callFunction: '{{name}}({{#each args ", "}}{{this}}{{/each}})',
  callBlock: '{{name}}()',
  field: '{{name}}',
  structField: '{{value}}.{{field}}'
};

// The generated file's name for a graph file (the definition's `fileName`).
export function declarativeFileName(definition: CheckedDefinition['definition'], graphFileName: string): string {
  const name = graphFileName.replace(/\.vgraph$/i, '');
  return renderTemplate(parseTemplate(definition.fileName), { name, snake: toIdentifier(name, 'snake'), camel: toIdentifier(name, 'camel'), pascal: toIdentifier(name, 'pascal') });
}

// The names a function library's functions are exported as: claimed first, in order, as the
// library's own generated file claims them.
export function declarativeLibraryExports(checked: CheckedDefinition, functions: { id: string; name: string }[]): { names: Map<string, string> } {
  const scope = new NameScope(new Set(checked.definition.naming.reserved));
  return { names: new Map(functions.map((f) => [f.id, scope.claim(f.name, checked.definition.naming.function ?? 'snake')])) };
}

export class DeclarativeEmitter {
  private readonly diagnostics: CompileDiagnostic[] = [];
  private readonly sources: SourceRef[] = [];
  private readonly reserved: Set<string>;
  private readonly names: NameScope;
  private readonly className: string;
  private readonly startName: string;
  private readonly memberNames = new Map<string, string>();
  private readonly slotNames = new Map<string, string>();
  private readonly functionNames = new Map<string, string>();
  private readonly blockNames = new Map<string, string>();
  private readonly helperNames = new Map<string, string>();
  private readonly paramNames = new Map<string, string>();
  private readonly types: Map<string, UserType>;
  private readonly cache = new Map<string, Template>();
  private readonly signatures: TemplateValue[] = [];
  private currentSource: SourceRef | undefined;
  // The function graph being written, whose outputs Return Nodes give.
  private currentFunction: IrFunction | undefined;
  // Reading pins for the debugger: what can't be written is left out rather than reported.
  private quiet: { failed: boolean } | undefined;

  constructor(private readonly checked: CheckedDefinition, private readonly program: IrProgram, private readonly options: GenerateOptions) {
    const { naming } = checked.definition;
    this.reserved = new Set(naming.reserved);
    this.types = userTypes(program);
    if (program.declaration && program.declaration.kind !== 'interface') this.types.set(program.declaration.type.id, program.declaration.type);
    this.className = new NameScope(this.reserved).claim(program.className, this.style('type'));
    // A library's functions are claimed first, exactly as declarativeLibraryExports claims them.
    this.names = new NameScope(this.reserved);
    if (program.library) {
      const exports = declarativeLibraryExports(checked, program.functions);
      for (const [id, name] of exports.names) this.functionNames.set(id, name);
      exports.names.forEach((name) => this.names.take(name));
      this.startName = '';
    } else {
      this.startName = this.names.claim('start', this.style('function'));
      for (const f of program.functions) this.functionNames.set(f.id, this.names.claim(f.name, this.style('function')));
    }
    for (const m of program.members) if (!m.function) this.memberNames.set(m.id, this.names.claim(m.name, this.style('variable')));
    for (const x of program.slots) if (!x.function) this.slotNames.set(x.id, this.names.claim(x.name, this.style('variable')));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, this.style('function')));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(h.name, this.style('function')));
  }

  emit(): GeneratedCode & { diagnostics: CompileDiagnostic[] } {
    if (this.program.declaration) return this.finish(this.declaration(), []);
    const functions: string[] = [];
    let start = '';
    if (!this.program.library) start = this.func({ name: this.startName, params: [], outputs: [], body: this.statements(this.program.start), flags: { start: true } });
    for (const fn of this.program.functions) functions.push(this.functionGraph(fn));
    const testScope = this.names;
    const tests = (this.program.tests ?? []).map((t) => ({ name: t.name, method: testScope.claim(`test ${t.name}`, this.style('function')), quoted: JSON.stringify(t.name), body: t.body }));
    const testFunctions = tests.map((t) => this.func({ name: t.method, params: [], outputs: [], body: this.statements(t.body), flags: { test: true } }));
    const blocks = this.program.blocks.map((b) => this.func({ name: this.blockNames.get(b.id)!, params: [], outputs: [], body: this.statements(b.body), flags: { block: true } }));
    const helpers = this.program.helpers.map((h) => this.helperFunction(h));
    const main = this.program.functions.find((f) => f.event?.entry === 'Main');
    const mainMethod = main ? this.functionNames.get(main.id) : undefined;
    const context = {
      start,
      functions,
      tests: tests.map(({ name, method, quoted }) => ({ name, method, quoted })),
      testFunctions,
      blocks,
      helpers,
      all: [start, ...functions, ...testFunctions, ...blocks, ...helpers].filter(Boolean),
      signatures: this.signatures,
      fields: [
        ...this.program.members.filter((m) => !m.function).map((m) => ({ name: this.memberNames.get(m.id)!, type: this.typeName(m.type), value: this.value(m.initial, m.type) })),
        ...this.program.slots.filter((x) => !x.function).map((x) => ({ name: this.slotNames.get(x.id)!, type: this.typeName(x.type), value: this.defaultFor(x.type) }))
      ],
      mainMethod: mainMethod ?? '',
      hasMain: !!mainMethod,
      hasTests: tests.length > 0,
      imports: this.importsList()
    };
    const file = this.render('file', context) ?? '';
    return this.finish(file, tests.map(({ name, method }) => ({ name, method })), mainMethod);
  }

  // ---- The file --------------------------------------------------------------------------------

  private finish(text: string, tests: { name: string; method: string }[], mainMethod?: string): GeneratedCode & { diagnostics: CompileDiagnostic[] } {
    // Support code the text uses, and the support code that uses, in the definition's order.
    const helpers = Object.entries(this.checked.definition.helpers ?? {});
    const used = new Set<string>();
    const scan = (code: string) => {
      for (const [name] of helpers) if (!used.has(name) && new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`).test(code)) {
        used.add(name);
        scan(this.checked.definition.helpers![name]);
      }
    };
    scan(text.replace(MARKS, ''));
    const support = helpers.filter(([name]) => used.has(name)).map(([, code]) => code.replace(/\n+$/, '')).join('\n\n');
    text = text.replace(/\u0001S\u0001/, () => support);
    const nodeLines: GeneratedCode['nodeLines'] = [];
    const breaks: number[] = [];
    const lines = text.split('\n').map((line, i) => line.replace(MARKS, (_m, index: string | undefined) => {
      if (index === undefined) breaks.push(i + 1);
      else nodeLines.push({ graphId: this.sources[Number(index)].graphId, nodeId: this.sources[Number(index)].nodeId, line: i + 1 });
      return '';
    }));
    const pinExpressions = this.pinExpressions();
    return {
      text: lines.join('\n').replace(/\n*$/, '\n'),
      className: this.className,
      nodeLines,
      codeBreaks: breaks,
      ...(mainMethod ? { mainMethod } : {}),
      ...(pinExpressions.length ? { pinExpressions } : {}),
      ...(tests.length ? { tests } : {}),
      diagnostics: this.diagnostics
    };
  }

  // The files the code imports, each with the names it uses from it.
  private importsList(): TemplateValue[] {
    const files = new Map<string, { path: string; relative: string; module: string; names: string[] }>();
    for (const i of this.program.imports) {
      const path = i.userType && i.userType.kind !== 'class' && i.userType.kind !== 'interface' ? i.userType.source?.generatedPath : i.path;
      if (!path) continue;
      const file = files.get(path) ?? { path, relative: relativeSpecifier(this.options.outputDir ?? '', path), module: i.module ?? '', names: [] };
      if (!i.userType && !file.names.includes(i.name)) file.names.push(i.name);
      files.set(path, file);
    }
    return [...files.values()];
  }

  // A structure or enumeration document.
  private declaration(): string {
    const declaration = this.program.declaration!;
    if (declaration.kind === 'interface') {
      this.unsupported('interfaces', 'interfaceFile');
      return '';
    }
    if (declaration.kind === 'struct') {
      const fields = this.fieldNames(declaration.type);
      return this.render('structFile', {
        name: this.userTypeName(declaration.type.id),
        fields: declaration.type.fields.map((f, i) => ({ name: fields.get(f.id)!, type: this.typeName(f.type), value: this.value(declaration.initial[i], f.type) }))
      }) ?? '';
    }
    const members = this.enumerators(declaration.type);
    return this.render('enumFile', {
      name: this.userTypeName(declaration.type.id),
      enumerators: declaration.type.enumerators.map((e, i) => ({ name: members.get(e.id)!, text: e.name, quoted: JSON.stringify(e.name), index: i }))
    }) ?? '';
  }

  // ---- Functions -------------------------------------------------------------------------------

  private func(spec: { name: string; params: { name: string; type?: TypeRef }[]; outputs: { name: string; type?: TypeRef }[]; body: string; description?: string; flags: Record<string, boolean> }): string {
    const outputs = spec.outputs.map((o) => ({ name: o.name, type: this.typeName(o.type) }));
    const signature = {
      name: spec.name,
      params: spec.params.map((p) => ({ name: p.name, type: this.typeName(p.type) })),
      outputs,
      returnType: outputs.length === 1 ? outputs[0].type : '',
      void: outputs.length === 0,
      single: outputs.length === 1,
      multiple: outputs.length > 1,
      ...spec.flags
    };
    this.signatures.push(signature);
    const text = this.render('function', { ...signature, body: spec.body, description: spec.description?.replace(/\s+/g, ' ') ?? '' }) ?? '';
    return BREAK_MARK + text.replace(/\n+$/, '');
  }

  private functionGraph(fn: IrFunction): string {
    const scope = new NameScope(this.reserved, this.allFileNames());
    const params = fn.params.map((p) => {
      const name = scope.claim(p.name, this.style('parameter'));
      this.paramNames.set(`${fn.id}\u0000${p.id}`, name);
      return { name, type: p.type };
    });
    const locals = this.program.members.filter((m) => m.function === fn.id);
    for (const m of locals) this.memberNames.set(m.id, scope.claim(m.name, this.style('variable')));
    const slots = this.program.slots.filter((x) => x.function === fn.id);
    for (const x of slots) this.slotNames.set(x.id, scope.claim(x.name, this.style('variable')));
    const outputs = fn.outputs.map((o) => ({ name: scope.claim(o.name, this.style('variable')), type: o.type }));
    if (outputs.length > 1 && !this.has('callResults')) {
      this.currentSource = fn.body.find((s) => s.kind !== 'callBlock')?.source as SourceRef | undefined;
      this.unsupported('functions with several outputs', 'callResults');
    }
    const body: string[] = [];
    for (const m of locals) body.push(this.declare(this.memberNames.get(m.id)!, m.type, this.value(m.initial, m.type)));
    for (const x of slots) body.push(this.declare(this.slotNames.get(x.id)!, x.type, this.defaultFor(x.type)));
    // A custom event keeps the inputs other flows read, as Unreal keeps an event's outputs.
    for (const store of fn.event?.stores ?? []) body.push(this.assign(this.storage('slot', store.slot), this.paramNames.get(`${fn.id}\u0000${store.param}`)!));
    this.currentFunction = fn;
    const statements = this.statements(fn.body);
    this.currentFunction = undefined;
    if (statements) body.push(statements);
    // Reaching the end without a Return Node returns the outputs' defaults.
    if (fn.outputs.length && fn.body[fn.body.length - 1]?.kind !== 'return') {
      const values = fn.outputs.map((o) => this.defaultFor(o.type));
      body.push(this.use(['return'], { value: values[0], values, count: values.length, multiple: values.length > 1 }));
    }
    return this.func({
      name: this.functionNames.get(fn.id)!, params, outputs, body: body.filter(Boolean).join('\n'), description: fn.description,
      flags: { function: !fn.event, event: !!fn.event, main: fn.event?.entry === 'Main' }
    });
  }

  // A code node's snippet as a function of its inputs; inputs that are valid identifiers keep their
  // ids, which the snippet uses, even where they hide a name of the file.
  private helperFunction(helper: IrProgram['helpers'][number]): string {
    const scope = new NameScope(this.reserved);
    const params = helper.params.map((p, i) => ({
      pinId: p.pinId,
      name: /^[A-Za-z_]\w*$/.test(p.pinId) && !this.reserved.has(p.pinId) ? scope.claim(p.pinId) : scope.claim(`pin${i}`),
      type: p.type
    }));
    const byPin = new Map(params.map((p) => [p.pinId, p.name]));
    const code = helper.code.replace(/\$\{([^}]+)\}/g, (_m, pin: string) => byPin.get(pin) ?? pin);
    return this.func({ name: this.helperNames.get(helper.id)!, params, outputs: helper.returns ? [{ name: 'result', type: helper.returns }] : [], body: dedent(code).join('\n'), flags: { helper: true } });
  }

  private allFileNames(): string[] {
    return [this.className, this.startName, ...this.functionNames.values(), ...this.memberNames.values(), ...this.slotNames.values(), ...this.blockNames.values(), ...this.helperNames.values()].filter(Boolean);
  }

  // ---- Statements ------------------------------------------------------------------------------

  // Each node's code starts with a comment naming it (the `comment` template), unless the statement
  // before came from the same node.
  private statements(list: IrStatement[], inherited?: string): string {
    const parts: string[] = [];
    let previous = inherited;
    for (const s of list) {
      const key = s.kind === 'callBlock' ? undefined : `${s.source.graphId}\u0000${s.source.nodeId}`;
      if (s.kind !== 'callBlock') this.currentSource = s.source;
      let code = this.statement(s, key).replace(/\n+$/, '');
      if (!code) continue;
      if (key && key !== previous && s.kind !== 'callBlock') {
        const index = this.sources.push(s.source) - 1;
        const comment = this.render('comment', { text: `${s.source.title} (${s.source.nodeId})` }, false);
        code = `${comment ? `${comment.replace(/\n+$/, '')}\n` : ''}${NODE_MARK(index)}${code}`;
      }
      previous = key;
      parts.push(code);
    }
    return parts.join('\n');
  }

  private statement(s: IrStatement, key: string | undefined): string {
    switch (s.kind) {
      case 'print':
        return this.use(['print'], { value: this.expr(s.value), text: this.text(s.value), type: typeKey(this.typeOf(s.value)) });
      case 'assert':
        return this.use(['assert'], { condition: this.expr(s.condition), message: this.text(s.message) });
      case 'store':
        return this.assign(this.storage('slot', s.slot), this.value(s.value, this.program.slots.find((x) => x.id === s.slot)?.type));
      case 'setMember':
        return this.assign(this.storage('member', s.member), this.value(s.value, this.program.members.find((m) => m.id === s.member)?.type));
      case 'if':
        return this.use(['if'], { condition: this.expr(s.condition), then: this.statements(s.then, key), else: this.statements(s.else, key) });
      case 'while':
        return this.use(['while'], { condition: this.expr(s.condition), body: this.statements(s.body, key) });
      case 'for':
        return this.use(['for'], {
          counter: this.storage('slot', s.counter), first: this.expr(s.first), last: this.expr(s.last),
          stop: s.stop ? this.storage('slot', s.stop) : '', body: this.statements(s.body, key)
        });
      case 'forEach':
        return this.use(['forEach'], {
          array: this.expr(s.array), index: this.storage('slot', s.index), element: this.storage('slot', s.element),
          stop: s.stop ? this.storage('slot', s.stop) : '', body: this.statements(s.body, key)
        });
      case 'call': {
        const call = this.call(s.callee, s.args);
        if (s.results) {
          const imported = this.program.imports.find((i) => i.id === s.callee.id);
          return this.use(['callResults'], { call, results: s.results.map((r) => ({ target: this.storage('slot', r.slot), index: imported?.outputs?.findIndex((o) => o.id === r.output) ?? 0 })) });
        }
        return s.resultSlot ? this.assign(this.storage('slot', s.resultSlot), call) : this.use(['statement'], { expression: call });
      }
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === s.function)!;
        const call = this.functionCall(fn, s.args);
        if (!s.results.length) return this.use(['statement'], { expression: call });
        if (fn.outputs.length === 1) return this.assign(this.storage('slot', s.results[0].slot), call);
        return this.use(['callResults'], { call, results: s.results.map((r) => ({ target: this.storage('slot', r.slot), index: fn.outputs.findIndex((o) => o.id === r.output) })) });
      }
      case 'return': {
        const values = s.values.map((v, i) => this.value(v, this.currentFunction?.outputs[i]?.type));
        return this.use(['return'], { value: values[0] ?? '', values, count: values.length, multiple: values.length > 1 });
      }
      case 'callBlock':
        return this.use(['statement'], { expression: this.use(['callBlock'], { name: this.blockNames.get(s.block)! }) });
      default:
        this.unsupported(STATEMENT_FEATURES[s.kind] ?? s.kind, s.kind);
        return '';
    }
  }

  private assign(target: string, value: string): string {
    return this.use(['assign'], { target, value });
  }

  private declare(name: string, type: TypeRef | undefined, value: string): string {
    return this.use(['declare'], { name, type: this.typeName(type), value });
  }

  // A slot or member: a field (the `field` template), or a local variable of the function.
  private storage(kind: 'slot' | 'member', id: string): string {
    const local = kind === 'slot' ? this.program.slots.find((x) => x.id === id)?.function : this.program.members.find((m) => m.id === id)?.function;
    const name = (kind === 'slot' ? this.slotNames : this.memberNames).get(id) ?? id;
    return local ? name : this.use(['field'], { name });
  }

  // ---- Expressions -----------------------------------------------------------------------------

  private expr(e: IrExpr): string {
    switch (e.kind) {
      case 'literal':
        return this.literal(e.value);
      case 'default':
        return this.defaultFor(e.type);
      case 'member':
        return this.storage('member', e.member);
      case 'output':
        return this.storage('slot', e.slot);
      case 'param':
        return this.paramNames.get(`${e.function}\u0000${e.id}`) ?? this.unsupported('this input', 'param');
      case 'add':
        return this.use(['add'], { left: this.operand(e.left), right: this.operand(e.right) });
      case 'toNumber': {
        const key = typeKey(this.typeOf(e.value));
        if (key === 'float' || (key === 'int' && !this.has('toNumber.int'))) return this.expr(e.value);
        return this.use([`toNumber.${key}`, 'toNumber'], { value: this.expr(e.value) });
      }
      case 'toBoolean': {
        const key = typeKey(this.typeOf(e.value));
        if (key === 'bool') return this.expr(e.value);
        return this.use([`toBoolean.${key}`, 'toBoolean'], { value: this.expr(e.value) });
      }
      case 'toText':
        return this.text(e.value);
      case 'concat': {
        const parts = e.parts.map((p) => this.expr(p));
        return this.use(['concat'], { parts, count: parts.length });
      }
      case 'call': {
        const call = this.call(e.callee, e.args);
        if (!e.output) return call;
        const imported = this.program.imports.find((i) => i.id === e.callee.id);
        return this.use(['callOutput'], { call, index: imported?.outputs?.findIndex((o) => o.id === e.output) ?? 0 });
      }
      case 'binary': {
        const key = typeKey(this.typeOf(e.left));
        const op = this.checked.definition.operators?.[e.op] ?? e.op;
        return this.use([`binary.${e.op}.${key}`, `binary.${e.op}`, 'binary'], { left: this.operand(e.left), right: this.operand(e.right), op });
      }
      case 'not':
        return this.use(['not'], { value: this.operand(e.value) });
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(fn, e.args);
        return fn.outputs.length === 1 ? call : this.use(['callOutput'], { call, index: fn.outputs.findIndex((o) => o.id === e.output) });
      }
      case 'makeContainer': {
        const container = e.type.container ?? 'array';
        const items = e.items.map((item) => this.expr(item));
        const pairs = [];
        for (let i = 0; i + 1 < items.length; i += 2) pairs.push({ key: items[i], value: items[i + 1] });
        return this.use([`makeContainer.${container}`], { items, pairs, count: container === 'map' ? pairs.length : items.length, ...this.containerTypes(e.type) });
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return this.unsupported('this structure', 'makeStruct');
        const fields = this.fieldNames(type);
        return this.use(['makeStruct'], { type: this.userTypeName(type.id), fields: type.fields.map((f, i) => ({ name: fields.get(f.id)!, value: this.value(e.fields[i], f.type) })) });
      }
      case 'structField': {
        const type = this.types.get(e.type);
        const field = type?.kind === 'struct' ? this.fieldNames(type).get(e.field) ?? e.field : e.field;
        return this.use(['structField'], { value: this.operand(e.value), field, type: this.userTypeName(e.type) });
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        const enumerator = type?.kind === 'enum' ? type.enumerators.find((x) => x.id === e.value) : undefined;
        return this.use(['enumValue'], { type: this.userTypeName(e.type), value: type?.kind === 'enum' ? this.enumerators(type).get(e.value) ?? e.value : e.value, text: enumerator?.name ?? e.value, index: type?.kind === 'enum' ? type.enumerators.indexOf(enumerator!) : 0 });
      }
      default:
        return this.unsupported(EXPRESSION_FEATURES[e.kind] ?? e.kind, e.kind);
    }
  }

  // An operand of an operator: in parentheses unless it's a single term.
  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' || e.kind === 'not' || (e.kind === 'literal' && typeof e.value === 'number' && e.value < 0) ? `(${text})` : text;
  }

  private call(callee: IrCallee, args: IrExpr[]): string {
    if (callee.kind === 'helper') {
      const helper = this.program.helpers.find((h) => h.id === callee.id)!;
      return this.use(['call'], { name: this.helperNames.get(callee.id)!, args: args.map((a, i) => this.value(a, helper.params[i]?.type)) });
    }
    const imported = this.program.imports.find((i) => i.id === callee.id)!;
    return this.use(['import'], { name: imported.name, module: imported.module ?? '', path: imported.path, args: args.map((a, i) => this.value(a, imported.params[i]?.type)) });
  }

  private functionCall(fn: IrFunction, args: IrExpr[]): string {
    return this.use(['callFunction'], { name: this.functionNames.get(fn.id)!, args: args.map((a, i) => this.value(a, fn.params[i]?.type)) });
  }

  // The value as text (docs/semantics.md, "Values"): text as it is, anything else through the
  // `toText` template for its type.
  private text(e: IrExpr): string {
    const key = typeKey(this.typeOf(e));
    if (key === 'string' && !this.has('toText.string')) return this.expr(e);
    return this.use([`toText.${key}`, 'toText'], { value: this.expr(e) });
  }

  // An expression for a value of `type`: a number where a float is wanted is written as one, and a
  // container default (JSON: an array, or a map's [key, value] pairs) becomes the container.
  private value(e: IrExpr | undefined, type: TypeRef | undefined): string {
    if (!e) return this.defaultFor(type);
    if (e.kind !== 'literal') return this.expr(e);
    if (typeof e.value === 'number' && type?.id === 'float' && !type.container) return this.literal(e.value, true);
    if (type?.container && Array.isArray(e.value)) {
      const element = { id: type.id };
      if (type.container === 'map') {
        const pairs = e.value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2).map(([k, v]) => ({ key: this.value({ kind: 'literal', value: k }, element), value: this.value({ kind: 'literal', value: v }, type.valueType) }));
        return this.use(['makeContainer.map'], { items: pairs.flatMap((p) => [p.key, p.value]), pairs, count: pairs.length, ...this.containerTypes(type) });
      }
      const items = e.value.map((v) => this.value({ kind: 'literal', value: v }, element));
      return this.use([`makeContainer.${type.container}`], { items, pairs: [], count: items.length, ...this.containerTypes(type) });
    }
    return this.expr(e);
  }

  private literal(value: unknown, float = false): string {
    if (typeof value === 'boolean') return this.use(['literal.bool'], { value, text: String(value) });
    if (typeof value === 'number') {
      const integral = Number.isInteger(value) && !float;
      const text = Number.isFinite(value) ? (float && Number.isInteger(value) ? `${value}.0` : String(value)) : String(value);
      return this.use([integral ? 'literal.int' : 'literal.float'], { value, text });
    }
    if (typeof value === 'string') return this.use(['literal.string'], { value, quoted: JSON.stringify(value), escaped: JSON.stringify(value).slice(1, -1) });
    return this.use(['literal.null'], {});
  }

  private defaultFor(type: TypeRef | undefined): string {
    const defaults = this.checked.definition.types.defaults;
    const key = typeKey(type);
    const source = defaults[key];
    if (source === undefined) return this.unsupported(`${describeType(type)} values`, `types.defaults.${key}`);
    const user = type && this.types.get(type.id);
    const first = user?.kind === 'enum' && user.enumerators[0] ? this.enumerators(user).get(user.enumerators[0].id) : '';
    return this.renderSource(`types.defaults.${key}`, source, { ...this.containerTypes(type), name: user ? this.userTypeName(user.id) : '', first: first ?? '' });
  }

  private typeName(type: TypeRef | undefined): string {
    const map = this.checked.definition.types.map;
    const key = typeKey(type);
    const source = map[key];
    if (source === undefined) return this.unsupported(`${describeType(type)} values`, `types.map.${key}`);
    const user = type && !type.container ? this.types.get(type.id) : undefined;
    return this.renderSource(`types.map.${key}`, source, { ...this.containerTypes(type), name: user ? this.userTypeName(user.id) : type ? this.userTypeName(type.id) : '' });
  }

  private containerTypes(type: TypeRef | undefined): Record<string, string> {
    if (!type?.container) return {};
    const element = { id: type.id };
    return { T: this.typeName(element), K: this.typeName(element), V: this.typeName(type.valueType) };
  }

  private userTypeName(id: string): string {
    return toIdentifier(parseTypeId(id).name, this.style('type'));
  }

  private fieldNames(type: StructInfo): Map<string, string> {
    const scope = new NameScope(this.reserved);
    return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, this.style('variable'))]));
  }

  private enumerators(type: EnumInfo): Map<string, string> {
    const scope = new NameScope(this.reserved);
    return new Map(type.enumerators.map((e) => [e.id, scope.claim(e.name, this.style('enumerator'))]));
  }

  private typeOf(e: IrExpr): TypeRef | undefined {
    const type = exprType(e, this.program);
    return type?.id === 'any' ? undefined : type;
  }

  // ---- Debugging -------------------------------------------------------------------------------

  // How the debugger reads each pin it can: its storage, as the code reads it.
  private pinExpressions(): PinExpression[] {
    const pins: PinExpression[] = [];
    for (const p of this.program.pinValues ?? []) {
      this.quiet = { failed: false };
      const expression = this.expr(p.value);
      if (!this.quiet.failed) pins.push({ graphId: p.graphId, nodeId: p.nodeId, pinId: p.pinId, expression });
    }
    this.quiet = undefined;
    return pins;
  }

  // ---- Templates -------------------------------------------------------------------------------

  private has(name: string): boolean {
    return this.checked.templates.has(name);
  }

  // The first of the templates the pack has (or a default), rendered; else `unsupported`.
  private use(names: string[], context: Record<string, TemplateValue>): string {
    for (const name of names) {
      const text = this.render(name, context, false);
      if (text !== undefined) return text;
    }
    return this.unsupported(TEMPLATE_FEATURES[names[names.length - 1].split('.')[0]] ?? names[0], names[0]);
  }

  private render(name: string, context: Record<string, TemplateValue>, required = true): string | undefined {
    const template = this.checked.templates.get(name) ?? (DEFAULTS[name] !== undefined ? this.parsed(name, DEFAULTS[name]) : undefined);
    if (!template) {
      if (required) this.unsupported(TEMPLATE_FEATURES[name] ?? name, name);
      return undefined;
    }
    return renderTemplate(template, { ...this.globals(), ...context });
  }

  private renderSource(key: string, source: string, context: Record<string, TemplateValue>): string {
    return renderTemplate(this.parsed(key, source), { ...this.globals(), ...context });
  }

  private parsed(key: string, source: string): Template {
    let template = this.cache.get(key);
    if (!template) {
      template = parseTemplate(source);
      this.cache.set(key, template);
    }
    return template;
  }

  private globals(): Record<string, TemplateValue> {
    return { className: this.className, startName: this.startName, library: !!this.program.library, sourceFileName: this.options.sourceFileName, support: '\u0001S\u0001' };
  }

  private style(kind: 'type' | 'function' | 'variable' | 'parameter' | 'enumerator'): NameStyle {
    return this.checked.definition.naming[kind] ?? (kind === 'type' || kind === 'enumerator' ? 'pascal' : 'snake');
  }

  // Reports what the pack can't express, on the node being written; returns a placeholder.
  private unsupported(what: string, template: string): string {
    if (this.quiet) {
      this.quiet.failed = true;
      return '';
    }
    const source = this.currentSource;
    const message = `${this.checked.definition.displayName} can't express ${what} yet (its pack has no "${template}" template).`;
    if (!this.diagnostics.some((d) => d.message === message && d.nodeId === source?.nodeId && d.graphId === source?.graphId)) {
      this.diagnostics.push({ severity: 'error', code: 'unsupported', message, ...(source ? { graphId: source.graphId, nodeId: source.nodeId } : {}) });
    }
    return '';
  }
}

// What a construct is, as `unsupported` diagnostics name it.
const STATEMENT_FEATURES: Partial<Record<IrStatement['kind'], string>> = {
  bindEvent: 'event dispatchers', unbindAll: 'event dispatchers', broadcast: 'event dispatchers', construct: 'object references',
  setObjectVariable: 'object references', delay: 'latent actions such as Delay', cast: 'Cast To', interfaceCall: 'interfaces',
  parentCall: 'inheritance', objectCall: 'object references'
};

const EXPRESSION_FEATURES: Partial<Record<IrExpr['kind'], string>> = {
  self: 'object references', isValid: 'object references', objectVariable: 'object references', objectCall: 'object references',
  parentCall: 'inheritance', interfaceCall: 'interfaces'
};

const TEMPLATE_FEATURES: Record<string, string> = {
  print: 'Print', assert: 'Assert', assign: 'storing values', declare: 'local variables', if: 'Branch', while: 'While Loop', for: 'For Loop',
  forEach: 'For Each Loop', statement: 'calls', return: 'Return Node', callResults: 'functions with several outputs', callOutput: 'functions with several outputs',
  concat: 'joining text', toText: 'values as text', toNumber: 'values as numbers', toBoolean: 'values as booleans', makeContainer: 'containers',
  makeStruct: 'structures', enumValue: 'enumerations', structFile: 'structures', enumFile: 'enumerations', 'literal.null': 'empty values', file: 'files', function: 'functions'
};

// A type's key in the definition's tables: a container, a user type's category, or the type's id.
export function typeKey(type: TypeRef | undefined): string {
  if (!type) return 'any';
  if (type.container) return type.container;
  const { category } = parseTypeId(type.id);
  if (category === 'primitive') return type.id;
  if (category === 'any' || category === 'wildcard' || category === 'unknown') return 'any';
  return category;
}

function describeType(type: TypeRef | undefined): string {
  const key = typeKey(type);
  return key === 'any' ? 'untyped' : key;
}

